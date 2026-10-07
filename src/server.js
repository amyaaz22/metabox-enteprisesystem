// HTTP entry point.
//   POST /webhooks/zoho-pos   Zoho POS workflow webhook (sale or credit note)
//   POST /epson/sdp           Epson Server Direct Print polling
//   GET  /jobs                print jobs and their state        (secret header)
//   POST /jobs/:id/reprint    put a job back in the printer queue (secret header)
//   GET  /health

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createFiscalClient } from './fiscal.js';
import { createQueue } from './queue.js';
import { createPipeline } from './pipeline.js';
import { handleSdp } from './epsonSdp.js';
import { PayloadError } from './zoho.js';

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

const secretOk = (req, cfg) => {
  const got = Buffer.from(String(req.headers[cfg.webhookSecretHeader] || ''));
  const want = Buffer.from(cfg.webhookSecret);
  return got.length === want.length && timingSafeEqual(got, want);
};

export function createServer({ cfg = config, fiscal = createFiscalClient(), queue = createQueue(), log = console.log } = {}) {
  const pipeline = createPipeline({ fiscal, queue, cfg });

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });

      if (req.method === 'POST' && url.pathname === '/webhooks/zoho-pos') {
        if (!secretOk(req, cfg)) return send(401, { error: 'bad secret' });
        const payload = parseZohoBody(await readBody(req), req.headers['content-type']);
        const r = await pipeline.handle(payload);
        log(`webhook: ${r.number} ${r.duplicate ? 'duplicate, ignored' : `${r.fiscal.status} -> ${r.printerId} job ${r.jobId} (${r.fiscalizeMs}ms)`}`);
        return send(200, { number: r.number, fiscal: r.fiscal.status, jobId: r.jobId, duplicate: Boolean(r.duplicate) });
      }

      if (req.method === 'POST' && url.pathname === '/epson/sdp') {
        const out = handleSdp(new URLSearchParams(await readBody(req)), queue, log);
        return send(out.status, out.body, out.type);
      }

      if (url.pathname.startsWith('/jobs')) {
        if (!secretOk(req, cfg)) return send(401, { error: 'bad secret' });
        if (req.method === 'GET' && url.pathname === '/jobs') {
          return send(200, queue.list().map(({ epos, ...j }) => j));
        }
        const m = /^\/jobs\/([^/]+)\/reprint$/.exec(url.pathname);
        if (req.method === 'POST' && m) {
          const job = queue.requeue(m[1]);
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
  });

  return { server, pipeline, queue };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createServer();
  server.listen(config.port, () => console.log(`fiscal print service on :${config.port} (fiscal mode: ${config.fiscalMode})`));
}
