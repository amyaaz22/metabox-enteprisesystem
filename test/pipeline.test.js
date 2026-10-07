import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSale, PayloadError } from '../src/zoho.js';
import { createFiscalClient, FISCALIZED, NOT_FISCALIZED } from '../src/fiscal.js';
import { createQueue } from '../src/queue.js';
import { createMemoryStore } from '../src/store.js';
import { createPipeline } from '../src/pipeline.js';
import { buildReceipt, money } from '../src/receipt.js';
import { renderText, WIDTH } from '../src/render/text.js';
import { renderEpos } from '../src/render/epos.js';
import { handleSdp } from '../src/epsonSdp.js';
import { parseZohoBody } from '../src/app.js';
import { config } from '../src/config.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/raw.json', import.meta.url), 'utf8'));

test('normalizes the Zoho POS payload, including JSON-string fields', () => {
  const sale = normalizeSale(raw);
  assert.equal(sale.type, 'INV');
  assert.equal(sale.number, 'SI-11');
  assert.equal(sale.lines.length, 5);
  assert.equal(sale.subTotalCents, 57100);
  assert.equal(sale.taxTotalCents, 8565);
  assert.equal(sale.totalCents, 65665);
  assert.equal(sale.pricesIncludeTax, false);
  assert.equal(sale.locationId, '1496042000000095116');
  const eclair = sale.lines.find((l) => l.sku === 'PAST-TRT-002');
  assert.deepEqual([eclair.quantity, eclair.unitPriceCents, eclair.discountCents, eclair.lineTotalCents], [5, 7500, 9900, 27600]);
  assert.deepEqual(sale.taxSummary, [{ name: 'Standard Rate (15%)', percent: 15, taxableCents: 57100, taxCents: 8565 }]);
});

test('rejects a payload whose totals do not add up', () => {
  assert.throws(() => normalizeSale({ ...raw, total: '700.00' }), PayloadError);
  assert.throws(() => normalizeSale({ ...raw, tax_total: '80.00' }), PayloadError);
  assert.throws(() => normalizeSale({ ...raw, line_items: '[]' }), PayloadError);
});

test('reads a credit note payload', () => {
  const { invoice_id, invoice_number, ...rest } = raw;
  const sale = normalizeSale({ ...rest, creditnote_id: '99', creditnote_number: 'CN-1', reference_number: 'SI-11' });
  assert.equal(sale.type, 'CRN');
  const text = renderText(buildReceipt(sale, { status: NOT_FISCALIZED }, config.seller));
  assert.match(text, /CREDIT NOTE/);
  assert.match(text, /Original invoice:\s+SI-11/);
});

test('fiscalized receipt carries QR and IRN; failed one carries the NYF label', async () => {
  const sale = normalizeSale(raw);
  const ok = await createFiscalClient({ mode: 'mock' }).fiscalize(sale);
  assert.equal(ok.status, FISCALIZED);
  const okRows = buildReceipt(sale, ok, config.seller);
  assert.ok(okRows.some((r) => r.kind === 'qr' && r.data === ok.qrData));
  assert.match(renderText(okRows), new RegExp(`IRN: ${ok.irn}`));
  assert.doesNotMatch(renderText(okRows), /NOT YET FISCALIZED/);

  const bad = await createFiscalClient({ mode: 'mock', fail: true }).fiscalize(sale);
  const badRows = buildReceipt(sale, bad, config.seller);
  assert.ok(!badRows.some((r) => r.kind === 'qr'));
  assert.match(renderText(badRows), /NOT YET FISCALIZED/);
});

test('receipt fits an 80mm printer and shows MRA core fields', () => {
  const sale = normalizeSale(raw);
  const text = renderText(buildReceipt(sale, { status: NOT_FISCALIZED }, config.seller));
  for (const line of text.split('\n')) assert.ok(line.length <= WIDTH, `too wide: "${line}"`);
  for (const needle of ['BRN:', 'VAT No:', 'Invoice No:', 'SI-11', '07/10/2026 12:23', 'Chocolate Eclair', '-99.00', 'VAT 15% on 571.00', '85.65', '656.65']) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('Epson XML escapes item names and includes the QR symbol', async () => {
  const sale = normalizeSale(raw);
  const ok = await createFiscalClient({ mode: 'mock' }).fiscalize(sale);
  const xml = renderEpos(buildReceipt(sale, ok, config.seller));
  assert.match(xml, /Chicken &amp; Mushroom Quiche/);
  assert.match(xml, /<symbol type="qrcode_model_2"[^>]*>https:\/\/mock-mra\.example\/verify\?irn=/);
  assert.match(xml, /<cut type="feed"\/>/);
});

test('duplicate webhook prints once; printer gets each job once', async () => {
  const store = createMemoryStore();
  const queue = createQueue(store);
  const pipeline = createPipeline({ fiscal: createFiscalClient({ mode: 'mock' }), queue, store, now: () => Date.parse('2026-10-07T12:23:57+04:00') });
  const first = await pipeline.handle(raw);
  const again = await pipeline.handle(raw);
  assert.equal(again.duplicate, true);
  assert.equal(again.jobId, first.jobId);
  assert.equal((await queue.list()).length, 1);
  assert.equal(first.printerId, 'HEAD-OFFICE-TILL-1');
  assert.equal(first.zohoToServiceMs, 3000, 'webhook delay measured from Zoho created_time');
  assert.match(await pipeline.getReceiptHtml(first.saleKey), /SI-11/);

  const poll = new URLSearchParams({ ConnectionType: 'GetRequest', ID: 'HEAD-OFFICE-TILL-1' });
  const got = await handleSdp(poll, queue);
  assert.match(got.body, new RegExp(`<printjobid>${first.jobId}</printjobid>`));
  assert.equal((await handleSdp(poll, queue)).body, '', 'second poll must not resend');
  assert.equal((await handleSdp(new URLSearchParams({ ConnectionType: 'GetRequest', ID: 'OTHER' }), queue)).body, '');

  const ack = `<PrintResponseInfo><ePOSPrint><Parameter><printjobid>${first.jobId}</printjobid></Parameter><PrintResponse><response success="false" code="EPTR_COVER_OPEN"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
  await handleSdp(new URLSearchParams({ ConnectionType: 'SetResponse', ID: 'HEAD-OFFICE-TILL-1', ResponseFile: ack }), queue);
  assert.equal((await queue.get(first.jobId)).state, 'failed');
  assert.equal((await queue.get(first.jobId)).detail, 'EPTR_COVER_OPEN');
  await queue.requeue(first.jobId);
  assert.match((await handleSdp(poll, queue)).body, new RegExp(first.jobId), 'reprint goes back to the printer');
});

test('a failure after claiming the sale releases it so a Zoho retry can succeed', async () => {
  const store = createMemoryStore();
  const queue = createQueue(store);
  let calls = 0;
  const flaky = { async fiscalize(sale) { if (++calls === 1) throw new Error('boom'); return createFiscalClient({ mode: 'mock' }).fiscalize(sale); } };
  const pipeline = createPipeline({ fiscal: flaky, queue, store });
  await assert.rejects(pipeline.handle(raw), /boom/);
  const retry = await pipeline.handle(raw);
  assert.equal(retry.duplicate, undefined);
  assert.equal(retry.fiscal.status, FISCALIZED);
});

test('accepts Zoho webhook bodies as JSON or form-encoded', () => {
  const json = JSON.stringify(raw);
  assert.equal(parseZohoBody(json, 'application/json').invoice_number, 'SI-11');
  assert.equal(parseZohoBody(new URLSearchParams({ JSONString: json }).toString(), 'application/x-www-form-urlencoded').invoice_number, 'SI-11');
});

test('money formatting', () => {
  assert.equal(money(65665), '656.65');
  assert.equal(money(-9900), '-99.00');
  assert.equal(money(123456789), '1,234,567.89');
});
