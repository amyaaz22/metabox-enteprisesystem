// Turns a Zoho POS workflow webhook payload into the sale shape the rest of
// the pipeline uses. Zoho sends nested objects (line_items, addresses) as
// JSON-encoded strings and numbers as strings, so both get decoded here.
// Amounts are kept in integer cents to avoid float drift in totals.

export class PayloadError extends Error {}

const toCents = (v) => Math.round(Number(v || 0) * 100);

function parseNested(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new PayloadError(`Could not decode nested JSON field: ${value.slice(0, 40)}`);
  }
}

export function normalizeSale(payload) {
  const isCreditNote = Boolean(payload.creditnote_id);
  const id = isCreditNote ? payload.creditnote_id : payload.invoice_id;
  const number = isCreditNote ? payload.creditnote_number : payload.invoice_number;
  if (!id || !number) throw new PayloadError('Payload has no invoice_id/invoice_number or creditnote_id/creditnote_number');

  const rawLines = parseNested(payload.line_items, []);
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new PayloadError('Payload has no line items');

  const lines = rawLines
    .slice()
    .sort((a, b) => (a.item_order ?? 0) - (b.item_order ?? 0))
    .map((l) => ({
      itemId: String(l.item_id),
      sku: l.sku || '',
      name: l.name,
      description: l.description || '',
      quantity: Number(l.quantity),
      unit: l.unit || '',
      unitPriceCents: toCents(l.rate),
      discountCents: toCents(l.discount_amount),
      lineTotalCents: toCents(l.item_total),
      taxes: (l.line_item_taxes || []).map((t) => ({
        name: t.tax_name,
        percent: Number(t.tax_percentage),
        amountCents: toCents(t.tax_amount),
      })),
      locationId: l.location_id ? String(l.location_id) : '',
      locationName: l.location_name || '',
    }));

  const billing = parseNested(payload.billing_address, {});
  const sale = {
    type: isCreditNote ? 'CRN' : 'INV',
    zohoId: String(id),
    number,
    referenceNumber: payload.reference_number || '',
    date: payload.date,
    createdTime: payload.created_time,
    currency: payload.currency_code || 'MUR',
    status: payload.status,
    customer: {
      id: payload.customer_id ? String(payload.customer_id) : '',
      name: payload.customer_name || 'Walk-in Customer',
      address: [billing.address, billing.street2, billing.city].filter(Boolean).join(', '),
      // Buyer BRN/VAT: needed for B2B receipts. Zoho POS doesn't send them by
      // default; expected as customer custom fields once the client sets them up.
      brn: findCustomField(payload, 'brn'),
      vatNumber: findCustomField(payload, 'vat'),
    },
    lines,
    subTotalCents: toCents(payload.sub_total),
    taxTotalCents: toCents(payload.tax_total),
    shippingCents: toCents(payload.shipping_charge),
    adjustmentCents: toCents(payload.adjustment),
    totalCents: toCents(payload.total),
    notes: payload.notes || '',
    locationId: lines.find((l) => l.locationId)?.locationId || '',
    locationName: lines.find((l) => l.locationName)?.locationName || '',
  };

  sale.taxSummary = summarizeTaxes(lines);
  sale.pricesIncludeTax = checkTotals(sale);
  return sale;
}

function findCustomField(payload, needle) {
  const fields = parseNested(payload.custom_fields, []);
  const hit = Array.isArray(fields)
    ? fields.find((f) => String(f.label || f.api_name || '').toLowerCase().includes(needle))
    : null;
  return hit ? String(hit.value ?? '') : '';
}

function summarizeTaxes(lines) {
  const byRate = new Map();
  for (const line of lines) {
    for (const t of line.taxes) {
      const row = byRate.get(t.percent) || { name: t.name, percent: t.percent, taxableCents: 0, taxCents: 0 };
      row.taxableCents += line.lineTotalCents;
      row.taxCents += t.amountCents;
      byRate.set(t.percent, row);
    }
  }
  return [...byRate.values()].sort((a, b) => b.percent - a.percent);
}

// Refuses a sale whose parts don't add up: printing a receipt whose totals
// disagree with what MRA receives is worse than printing nothing.
// Returns whether line prices include tax.
function checkTotals(sale) {
  const linesSum = sale.lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const taxSum = sale.lines.reduce((s, l) => s + l.taxes.reduce((t, x) => t + x.amountCents, 0), 0);
  const tolerance = sale.lines.length; // one cent of rounding per line
  const near = (a, b) => Math.abs(a - b) <= tolerance;

  if (!near(linesSum, sale.subTotalCents)) {
    throw new PayloadError(`Line totals ${linesSum} do not match sub_total ${sale.subTotalCents}`);
  }
  if (!near(taxSum, sale.taxTotalCents)) {
    throw new PayloadError(`Line taxes ${taxSum} do not match tax_total ${sale.taxTotalCents}`);
  }
  const extras = sale.shippingCents + sale.adjustmentCents;
  if (near(sale.subTotalCents + sale.taxTotalCents + extras, sale.totalCents)) return false;
  if (near(sale.subTotalCents + extras, sale.totalCents)) return true;
  throw new PayloadError(`sub_total + tax_total do not reach total ${sale.totalCents}`);
}
