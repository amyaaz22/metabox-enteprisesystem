import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/server.js';
import { createFiscalClient } from '../src/fiscal.js';
import { config } from '../src/config.js';

const raw = readFileSync(new URL('./fixtures/raw.json', import.meta.url), 'utf8');

test('webhook endpoint checks the secret and rejects bad payloads', async () => {
  const { server } = createServer({ fiscal: createFiscalClient({ mode: 'mock' }), log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/webhooks/zoho-pos`;
  const headers = { 'content-type': 'application/json', [config.webhookSecretHeader]: config.webhookSecret };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"invoice_id":"1"}' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'not json' })).status, 400);
    const ok = await fetch(url, { method: 'POST', headers, body: raw });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).fiscal, 'FISCALIZED');
    const base = url.replace('/webhooks/zoho-pos', '');
    assert.equal((await fetch(`${base}/receipts`)).status, 401);
    const page = await fetch(`${base}/receipts?key=${config.adminKey}`).then((r) => r.text());
    assert.match(page, /SI-11/);
    assert.match(page, /FISCALIZED/);
    const receipt = await fetch(`${base}/receipts/INV-1496042000000111585?key=${config.adminKey}`).then((r) => r.text());
    assert.match(receipt, /MRA e-Invoice/);
  } finally {
    server.close();
  }
});

test('selftest runs the whole flow against the running server', async () => {
  const { server } = createServer({ fiscal: createFiscalClient({ mode: 'mock' }), log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/selftest`)).status, 401);
    const report = await fetch(`${base}/selftest?key=${config.adminKey}`).then((r) => r.json());
    assert.equal(report.ok, true, JSON.stringify(report.steps));
    assert.equal(report.fiscal, 'FISCALIZED');
    assert.equal(report.qrOnReceipt, true);
    assert.equal(report.steps.length, 6);
  } finally {
    server.close();
  }
});

test('print agent takes ESC/POS jobs once and reports back', async () => {
  const { server } = createServer({ fiscal: createFiscalClient({ mode: 'mock' }), log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { 'content-type': 'application/json', 'x-admin-key': config.adminKey };
  const post = (path, body, headers = admin) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    await fetch(`${base}/webhooks/zoho-pos`, { method: 'POST', headers: { 'content-type': 'application/json', [config.webhookSecretHeader]: config.webhookSecret }, body: raw });
    assert.equal((await post('/agent/next', { printer: 'HEAD-OFFICE-TILL-1' }, { 'content-type': 'application/json' })).status, 401);
    const { job } = await (await post('/agent/next', { printer: 'HEAD-OFFICE-TILL-1' })).json();
    const bytes = Buffer.from(job.data, 'base64');
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'starts with ESC @');
    assert.ok(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'contains a QR command');
    assert.ok(bytes.toString('latin1').includes('Chicken & Mushroom Quiche'));
    assert.equal((await (await post('/agent/next', { printer: 'HEAD-OFFICE-TILL-1' })).json()).job, null);
    assert.equal((await (await post('/agent/done', { jobId: job.id, ok: true })).json()).state, 'printed');
    const script = await fetch(`${base}/agent/fiscal-print-agent.ps1`).then((r) => r.text());
    assert.match(script, /RawPrinter/);
  } finally {
    server.close();
  }
});
