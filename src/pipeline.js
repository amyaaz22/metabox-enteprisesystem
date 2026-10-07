// One sale in, one print job out: normalize -> fiscalize -> build receipt ->
// queue for the till's printer. Zoho may deliver the same webhook more than
// once, so each sale is processed only once per Zoho ID.

import { config } from './config.js';
import { normalizeSale } from './zoho.js';
import { buildReceipt } from './receipt.js';
import { renderEpos } from './render/epos.js';
import { NOT_FISCALIZED } from './fiscal.js';

export function createPipeline({ fiscal, queue, cfg = config }) {
  const processed = new Map(); // `${type}:${zohoId}` -> result

  function printerFor(sale) {
    return cfg.printerByLocation[sale.locationId] || cfg.defaultPrinter;
  }

  async function handle(payload) {
    const sale = normalizeSale(payload);
    const key = `${sale.type}:${sale.zohoId}`;
    if (processed.has(key)) return { ...processed.get(key), duplicate: true };

    const started = Date.now();
    const fiscalResult = await fiscal.fiscalize(sale);
    const rows = buildReceipt(sale, fiscalResult, cfg.seller);
    const printerId = printerFor(sale);
    const job = queue.enqueue(printerId, { saleKey: key, number: sale.number, epos: renderEpos(rows) });

    const result = {
      saleKey: key,
      number: sale.number,
      fiscal: fiscalResult,
      printerId,
      jobId: job.id,
      fiscalizeMs: Date.now() - started,
      needsRetry: fiscalResult.status === NOT_FISCALIZED,
      sale,
      rows,
    };
    processed.set(key, result);
    return result;
  }

  // Sales printed as Not Yet Fiscalized, waiting for a retry.
  const pendingFiscalization = () => [...processed.values()].filter((r) => r.needsRetry);

  const find = (number) => [...processed.values()].find((r) => r.number === number);

  return { handle, pendingFiscalization, find };
}
