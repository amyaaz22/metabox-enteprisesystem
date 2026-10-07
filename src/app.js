// Request handler shared by the local server (src/server.js) and the Vercel
// function (api/index.js).
//   POST /webhooks/zoho-pos       Zoho POS workflow webhook (sale or credit note)
//   POST /epson/sdp               Epson Server Direct Print polling
//   GET  /receipts                sales received, timings, receipt previews (admin key)
//   GET  /receipts/:saleKey       the receipt as it prints                  (admin key)
//   GET  /jobs                    print jobs and their state                (admin key)
//   POST /jobs/:id/reprint        put a job back in the printer queue       (admin key)
//   POST /agent/next              print agent: take the next job for a printer (admin key)
//   POST /agent/done              print agent: report printed / failed       (admin key)
//   GET  /agent/fiscal-print-agent.ps1  download the Windows print agent
//   GET  /selftest                end-to-end check of this deployment       (admin key)
//   GET  /health

import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { createQueue } from './queue.js';
import { createPipeline } from './pipeline.js';
import { handleSdp } from './epsonSdp.js';
import { PayloadError } from './zoho.js';
import { money } from './receipt.js';
import { runSelftest } from './selftest.js';
import { readFileSync } from 'node:fs';
import { renderEscpos } from './render/escpos.js';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new PayloadError('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Zoho webhooks can post raw JSON or a form with the entity as a JSON string
// (e.g. JSONString=...). Accept both.
export function parseZohoBody(raw, contentType = '') {
  if (contentType.includes('application/json')) return JSON.parse(raw);
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  for (const k of ['JSONString', 'payload', 'invoice', 'creditnote']) {
    if (form.has(k)) return JSON.parse(form.get(k));
  }
  if (keys.length === 1 && form.get(keys[0]).trim().startsWith('{')) return JSON.parse(form.get(keys[0]));
  return Object.fromEntries(form);
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const secs = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);

async function receiptsPage(pipeline, queue, key) {
  const sales = (await pipeline.listSales()).slice(0, 100);
  const jobs = new Map((await queue.list()).map((j) => [j.id, j]));
  const rows = sales.map((s) => {
    const job = jobs.get(s.jobId);
    const printed = job?.doneAt && s.receivedAt ? secs(job.doneAt - s.receivedAt) : '–';
    return `<tr>
      <td><a href="/receipts/${encodeURIComponent(s.saleKey)}?key=${encodeURIComponent(key)}">${esc(s.number)}</a></td>
      <td>${esc(s.type)}</td>
      <td class="n">${s.totalCents != null ? `${esc(s.currency)} ${money(s.totalCents)}` : ''}</td>
      <td class="${s.fiscal?.status === 'FISCALIZED' ? 'ok' : 'warn'}">${esc(s.fiscal?.status || s.state)}</td>
      <td>${esc(s.printerId)}</td>
      <td>${esc(job?.state || '')}${job?.detail ? ` (${esc(job.detail)})` : ''}</td>
      <td class="n">${secs(s.zohoToServiceMs)}</td>
      <td class="n">${secs(s.processMs)}</td>
      <td class="n">${printed}</td>
      <td>${s.receivedAt ? esc(new Date(s.receivedAt).toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' })) : ''}</td>
    </tr>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fiscal receipts</title><meta http-equiv="refresh" content="10">
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; color: #111; background: #fff; }
  table { border-collapse: collapse; width: 100%; } th, td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; white-space: nowrap; }
  th { font-weight: 600; background: #f5f5f5; } .n { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: #0a7a2f; } .warn { color: #b45309; font-weight: 600; } .wrap { overflow-x: auto; } p { color: #555; }
</style></head><body>
<h1>Fiscal receipts</h1>
<p>Latest 100 sales received from Zoho POS. Refreshes every 10 s. "Zoho → service" is the webhook delay (±1 s); "Printed" is from webhook arrival to the printer confirming.</p>
<div class="wrap"><table>
<tr><th>Number</th><th>Type</th><th class="n">Total</th><th>MRA</th><th>Printer</th><th>Print job</th><th class="n">Zoho → service</th><th class="n">Processing</th><th class="n">Printed</th><th>Received</th></tr>
${rows.join('\n') || '<tr><td colspan="10">No sales yet.</td></tr>'}
</table></div></body></html>`;
}

export function createHandler({ cfg = config, fiscal, store, log = console.log }) {
  const queue = createQueue(store);
  const pipeline = createPipeline({ fiscal, queue, store, cfg });

  const handler = async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');
    const adminKey = req.headers['x-admin-key'] || url.searchParams.get('key');
    const isAdmin = () => same(adminKey, cfg.adminKey);

    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, fiscalMode: cfg.fiscalMode });

      if (req.method === 'POST' && url.pathname === '/webhooks/zoho-pos') {
        if (!same(req.headers[cfg.webhookSecretHeader], cfg.webhookSecret)) return send(401, { error: 'bad secret' });
        const payload = parseZohoBody(await readBody(req), req.headers['content-type']);
        const r = await pipeline.handle(payload);
        log(`webhook: ${r.number} ${r.duplicate ? 'duplicate, ignored' : `${r.fiscal.status} -> ${r.printerId} job ${r.jobId} (${r.processMs}ms, zoho delay ${r.zohoToServiceMs}ms)`}`);
        return send(200, { number: r.number, fiscal: r.fiscal?.status, jobId: r.jobId, duplicate: Boolean(r.duplicate) });
      }

      if (req.method === 'POST' && url.pathname === '/epson/sdp') {
        const out = await handleSdp(new URLSearchParams(await readBody(req)), queue, log);
        return send(out.status, out.body, out.type);
      }

      if (req.method === 'GET' && url.pathname === '/agent/fiscal-print-agent.ps1') {
        const script = readFileSync(new URL('../agent/fiscal-print-agent.ps1', import.meta.url), 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="fiscal-print-agent.ps1"' });
        return res.end(script);
      }

      if (req.method === 'POST' && url.pathname.startsWith('/agent/')) {
        if (!isAdmin()) return send(401, { error: 'bad admin key' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (url.pathname === '/agent/next') {
          if (!body.printer) return send(400, { error: 'printer required' });
          const job = await queue.next(String(body.printer));
          if (!job) return send(200, { job: null });
          log(`agent: sent job ${job.id} (${job.number}) to ${body.printer}`);
          // Jobs queued before ESC/POS output existed are rebuilt from the sale.
          const data = job.escpos || renderEscpos((await pipeline.getSale(job.saleKey))?.rows || []).toString('base64');
          return send(200, { job: { id: job.id, number: job.number, data } });
        }
        if (url.pathname === '/agent/done') {
          const job = await queue.complete(String(body.jobId), Boolean(body.ok), String(body.detail || ''));
          log(`agent: job ${body.jobId} ${body.ok ? 'printed' : `failed (${body.detail})`}`);
          return job ? send(200, { id: job.id, state: job.state }) : send(404, { error: 'no such job' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/selftest') {
        if (!isAdmin()) return send(401, { error: 'bad admin key' });
        const proto = req.headers['x-forwarded-proto'] || 'http';
        return send(200, await runSelftest(`${proto}://${req.headers.host}`, cfg));
      }

      if (url.pathname.startsWith('/receipts') || url.pathname.startsWith('/jobs')) {
        if (!isAdmin()) return send(401, { error: 'bad admin key' });
        if (req.method === 'GET' && url.pathname === '/receipts') {
          return send(200, await receiptsPage(pipeline, queue, adminKey), 'text/html; charset=utf-8');
        }
        const r = /^\/receipts\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && r) {
          const html = await pipeline.getReceiptHtml(decodeURIComponent(r[1]));
          return html ? send(200, html, 'text/html; charset=utf-8') : send(404, { error: 'no such receipt' });
        }
        if (req.method === 'GET' && url.pathname === '/jobs') {
          return send(200, (await queue.list()).map(({ epos, ...j }) => j));
        }
        const m = /^\/jobs\/([^/]+)\/reprint$/.exec(url.pathname);
        if (req.method === 'POST' && m) {
          const job = await queue.requeue(m[1]);
          return job ? send(200, { id: job.id, state: job.state }) : send(404, { error: 'no such job' });
        }
      }

      return send(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof PayloadError || err instanceof SyntaxError) {
        log(`rejected payload: ${err.message}`);
        return send(400, { error: err.message });
      }
      log(`error: ${err.stack}`);
      return send(500, { error: 'internal error' });
    }
  };

  return { handler, pipeline, queue };
}
