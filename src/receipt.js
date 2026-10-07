// Builds the receipt as a printer-neutral list of rows. Each renderer
// (text preview, Epson ePOS XML, HTML preview) turns the same rows into its
// own format, so all outputs always show identical content.
//
// Row kinds:
//   { kind: 'center', text, bold?, big? }   centred line
//   { kind: 'text', text, bold? }           left-aligned line
//   { kind: 'pair', left, right, bold? }    left text, right-aligned amount
//   { kind: 'rule' }                        dashed separator
//   { kind: 'qr', data }                    QR code
//   { kind: 'feed' }                        blank line

import { FISCALIZED } from './fiscal.js';

export const money = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
};

const qty = (q) => (Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, ''));

function formatDateTime(iso) {
  // Zoho sends local time with offset (e.g. 2026-10-07T12:23:54+0400); print it as sent.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : iso || '';
}

export function buildReceipt(sale, fiscal, seller) {
  const rows = [];
  const title = sale.type === 'CRN' ? 'CREDIT NOTE' : 'VAT INVOICE';

  rows.push({ kind: 'center', text: seller.name, bold: true, big: true });
  if (seller.address) rows.push({ kind: 'center', text: seller.address });
  if (seller.phone) rows.push({ kind: 'center', text: `Tel: ${seller.phone}` });
  rows.push({ kind: 'center', text: `BRN: ${seller.brn}   VAT No: ${seller.vatNumber}` });
  rows.push({ kind: 'rule' });
  rows.push({ kind: 'center', text: title, bold: true });
  rows.push({ kind: 'pair', left: `${sale.type === 'CRN' ? 'Credit note' : 'Invoice'} No:`, right: sale.number });
  if (sale.referenceNumber) rows.push({ kind: 'pair', left: 'Original invoice:', right: sale.referenceNumber });
  rows.push({ kind: 'pair', left: 'Date:', right: formatDateTime(sale.createdTime) || sale.date });
  if (sale.locationName) rows.push({ kind: 'pair', left: 'Outlet:', right: sale.locationName });
  rows.push({ kind: 'pair', left: 'Customer:', right: sale.customer.name });
  if (sale.customer.brn) rows.push({ kind: 'pair', left: 'Customer BRN:', right: sale.customer.brn });
  if (sale.customer.vatNumber) rows.push({ kind: 'pair', left: 'Customer VAT No:', right: sale.customer.vatNumber });
  rows.push({ kind: 'rule' });

  for (const line of sale.lines) {
    rows.push({ kind: 'text', text: line.name });
    const gross = Math.round(line.quantity * line.unitPriceCents);
    const vat = line.taxes.map((t) => `${t.percent}%`).join('+') || '0%';
    rows.push({ kind: 'pair', left: `  ${qty(line.quantity)} x ${money(line.unitPriceCents)}  VAT ${vat}`, right: money(gross) });
    if (line.discountCents) rows.push({ kind: 'pair', left: '  Discount', right: money(-line.discountCents) });
  }
  rows.push({ kind: 'rule' });

  const exclLabel = sale.pricesIncludeTax ? 'Subtotal (incl. VAT)' : 'Subtotal (excl. VAT)';
  rows.push({ kind: 'pair', left: exclLabel, right: money(sale.subTotalCents) });
  for (const t of sale.taxSummary) {
    rows.push({ kind: 'pair', left: `VAT ${t.percent}% on ${money(t.taxableCents)}`, right: money(t.taxCents) });
  }
  if (sale.shippingCents) rows.push({ kind: 'pair', left: 'Delivery', right: money(sale.shippingCents) });
  if (sale.adjustmentCents) rows.push({ kind: 'pair', left: 'Adjustment', right: money(sale.adjustmentCents) });
  rows.push({ kind: 'pair', left: `TOTAL ${sale.currency}`, right: money(sale.totalCents), bold: true });
  rows.push({ kind: 'rule' });

  if (fiscal.status === FISCALIZED) {
    rows.push({ kind: 'center', text: 'MRA e-Invoice', bold: true });
    rows.push({ kind: 'qr', data: fiscal.qrData });
    rows.push({ kind: 'center', text: `IRN: ${fiscal.irn}` });
  } else {
    rows.push({ kind: 'center', text: 'NOT YET FISCALIZED', bold: true, big: true });
    rows.push({ kind: 'center', text: 'This receipt will be fiscalized with MRA' });
    rows.push({ kind: 'center', text: `Ref: ${sale.number}` });
  }

  if (sale.notes) {
    rows.push({ kind: 'feed' });
    rows.push({ kind: 'center', text: sale.notes });
  }
  rows.push({ kind: 'feed' });
  return rows;
}
