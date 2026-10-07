// One sale in, one print job out: normalize -> fiscalize -> build receipt ->
// queue for the till's printer. Zoho may deliver the same webhook more than
// once, so each sale is claimed in the store before anything else happens.

import { config } from './config.js';
import { normalizeSale } from './zoho.js';
import { buildReceipt } from './receipt.js';
import { renderEpos } from './render/epos.js';
import { renderHtml } from './render/html.js';
import { renderEscpos } from './render/escpos.js';
import { NOT_FISCALIZED } from './fiscal.js';
import { readJson } from './store.js';

// Zoho sends "2026-10-07T12:23:54+0400"; Date.parse wants "+04:00".
const parseZohoTime = (s) => Date.parse(String(s || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) || null;

export function createPipeline({ fiscal, queue, store, cfg = config, now = Date.now }) {
  const saleKey = (key) => `sales/${key}.json`;

  function printerFor(sale) {
    return cfg.printerByLocation[sale.locationId] || cfg.defaultPrinter;
  }

  async function handle(payload) {
    const receivedAt = now();
    const sale = normalizeSale(payload);
    const key = `${sale.type}-${sale.zohoId}`;

    if (!(await store.create(saleKey(key), JSON.stringify({ saleKey: key, number: sale.number, state: 'processing' })))) {
      return { ...(await readJson(store, saleKey(key))), duplicate: true };
    }

    try {
      const fiscalResult = await fiscal.fiscalize(sale);
      const rows = buildReceipt(sale, fiscalResult, cfg.seller);
      const printerId = printerFor(sale);
      const job = await queue.enqueue(printerId, {
        saleKey: key,
        number: sale.number,
        epos: renderEpos(rows),
        escpos: renderEscpos(rows).toString('base64'),
      });
      await store.write(`receipts/${key}.html`, await renderHtml(rows, `${sale.number} receipt`));

      const zohoCreatedAt = parseZohoTime(sale.createdTime);
      const record = {
        saleKey: key,
        number: sale.number,
        type: sale.type,
        state: 'queued',
        fiscal: fiscalResult,
        needsRetry: fiscalResult.status === NOT_FISCALIZED,
        printerId,
        jobId: job.id,
        totalCents: sale.totalCents,
        currency: sale.currency,
        zohoCreatedAt,
        receivedAt,
        // Zoho's created_time has 1-second resolution, so this is +-1s.
        zohoToServiceMs: zohoCreatedAt ? receivedAt - zohoCreatedAt : null,
        processMs: now() - receivedAt,
        rows,
      };
      await store.write(saleKey(key), JSON.stringify(record));
      return record;
    } catch (err) {
      await store.remove(saleKey(key)); // let Zoho's retry try again
      throw err;
    }
  }

  async function listSales() {
    const keys = await store.list('sales/');
    const sales = await Promise.all(keys.map((k) => readJson(store, k)));
    return sales.filter(Boolean).sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  }

  const getSale = (key) => readJson(store, saleKey(key));
  const getReceiptHtml = (key) => store.read(`receipts/${key}.html`);

  return { handle, listSales, getSale, getReceiptHtml };
}
