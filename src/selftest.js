// End-to-end check of a running deployment, started from a browser:
// sends the sample sale to this service's own public webhook URL, then plays
// the printer (poll, then report printed) and returns what happened with timings.

import sample from './sample-sale.json' with { type: 'json' };

const ZONE_OFFSET = '+0400'; // Mauritius, the format Zoho POS sends

function mauritiusNow() {
  const t = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 19);
  return `${t}${ZONE_OFFSET}`;
}

export async function runSelftest(origin, cfg) {
  const id = `SELFTEST${Date.now()}`;
  const lines = JSON.parse(sample.line_items).map((l) => ({ ...l, location_id: 'SELFTEST', location_name: 'Selftest' }));
  const payload = { ...sample, invoice_id: id, invoice_number: `SI-TEST-${id.slice(-6)}`, created_time: mauritiusNow(), line_items: JSON.stringify(lines) };
  const printerId = cfg.printerByLocation.SELFTEST;
  const steps = [];
  const step = async (name, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, ms: Date.now() - t, detail });
      return detail;
    } catch (err) {
      steps.push({ step: name, ok: false, ms: Date.now() - t, detail: err.message });
      throw err;
    }
  };
  const post = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', body, headers });
  const webhookHeaders = { 'content-type': 'application/json', [cfg.webhookSecretHeader]: cfg.webhookSecret };

  try {
    await step('webhook rejects a missing secret', async () => {
      const r = await post('/webhooks/zoho-pos', JSON.stringify(payload), { 'content-type': 'application/json' });
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
      return 401;
    });
    const hook = await step('webhook: sale received, fiscalized, queued', async () => {
      const r = await post('/webhooks/zoho-pos', JSON.stringify(payload), webhookHeaders);
      const body = await r.json();
      if (r.status !== 200 || !body.jobId) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
      return body;
    });
    await step('same webhook again is ignored (no double print)', async () => {
      const body = await (await post('/webhooks/zoho-pos', JSON.stringify(payload), webhookHeaders)).json();
      if (!body.duplicate) throw new Error(`not flagged duplicate: ${JSON.stringify(body)}`);
      return body;
    });
    const xml = await step('printer polls and receives the receipt', async () => {
      const text = await (await post('/epson/sdp', new URLSearchParams({ ConnectionType: 'GetRequest', ID: printerId, Name: 'selftest' }))).text();
      if (!text.includes(`<printjobid>${hook.jobId}</printjobid>`)) throw new Error(`job not delivered (${text.length} bytes)`);
      return { bytes: text.length, hasQr: text.includes('qrcode_model_2') };
    });
    await step('printer polls again and gets nothing', async () => {
      const text = await (await post('/epson/sdp', new URLSearchParams({ ConnectionType: 'GetRequest', ID: printerId }))).text();
      if (text) throw new Error('job was handed out twice');
      return 'empty';
    });
    await step('printer reports printed', async () => {
      const ack = `<PrintResponseInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><printjobid>${hook.jobId}</printjobid></Parameter><PrintResponse><response success="true" code="" status="251658262"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
      const r = await post('/epson/sdp', new URLSearchParams({ ConnectionType: 'SetResponse', ID: printerId, ResponseFile: ack }));
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return 200;
    });
    return { ok: true, number: payload.invoice_number, saleKey: `INV-${id}`, fiscal: hook.fiscal, qrOnReceipt: xml.hasQr, totalMs: steps.reduce((s, x) => s + x.ms, 0), steps };
  } catch {
    return { ok: false, number: payload.invoice_number, steps };
  }
}
