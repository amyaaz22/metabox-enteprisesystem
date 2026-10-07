// Client for the e-invoicing service that submits invoices to MRA.
// fiscalize() never throws: if the service is down, slow or rejects the
// invoice, the receipt must still print, carrying the "Not Yet Fiscalized"
// label, and the invoice is retried later.

import { createHash } from 'node:crypto';
import { config } from './config.js';

export const FISCALIZED = 'FISCALIZED';
export const NOT_FISCALIZED = 'NOT_FISCALIZED';

export function createFiscalClient(opts = {}) {
  const mode = opts.mode || config.fiscalMode;
  if (mode === 'mock') return mockClient(opts);
  if (mode === 'http') return httpClient(opts);
  throw new Error(`Unknown fiscal mode: ${mode}`);
}

// Stands in for the real service in the desk test. `fail: true` simulates an
// outage so the Not Yet Fiscalized path can be checked.
function mockClient({ fail = false } = {}) {
  return {
    async fiscalize(sale) {
      if (fail) return { status: NOT_FISCALIZED, reason: 'Mock: e-invoicing service unavailable' };
      const irn = createHash('sha256').update(`${sale.type}:${sale.zohoId}`).digest('hex').slice(0, 32).toUpperCase();
      return {
        status: FISCALIZED,
        irn,
        qrData: `https://mock-mra.example/verify?irn=${irn}`,
        fiscalizedAt: new Date().toISOString(),
      };
    },
  };
}

// TODO: map to the real e-invoicing API once its spec is shared. Assumed
// contract: POST {base}/fiscalize -> { status, irn, qrCode }.
function httpClient({ baseUrl = config.fiscalBaseUrl, apiKey = config.fiscalApiKey, timeoutMs = config.fiscalTimeoutMs } = {}) {
  return {
    async fiscalize(sale) {
      try {
        const res = await fetch(`${baseUrl}/fiscalize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(sale),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { status: NOT_FISCALIZED, reason: `E-invoicing service returned HTTP ${res.status}` };
        const body = await res.json();
        if (!body.irn || !body.qrCode) return { status: NOT_FISCALIZED, reason: body.message || 'No IRN/QR in response' };
        return { status: FISCALIZED, irn: body.irn, qrData: body.qrCode, fiscalizedAt: body.fiscalizedAt || new Date().toISOString() };
      } catch (err) {
        return { status: NOT_FISCALIZED, reason: err.name === 'TimeoutError' ? `Timed out after ${timeoutMs}ms` : err.message };
      }
    },
  };
}
