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
