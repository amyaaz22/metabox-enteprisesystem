// Desk test for Option A, no Zoho account or printer needed:
// sample Zoho POS payload -> webhook -> mock fiscalization -> print queue ->
// simulated Epson printer polling Server Direct Print.
// Runs it twice: once fiscalized, once with the e-invoicing service down.
// Writes the receipt as text, HTML and Epson XML to out/.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from '../src/server.js';
import { createFiscalClient } from '../src/fiscal.js';
import { config } from '../src/config.js';
import { renderText } from '../src/render/text.js';
import { renderHtml } from '../src/render/html.js';

const raw = JSON.parse(await readFile(new URL('../test/fixtures/raw.json', import.meta.url), 'utf8'));
await mkdir('out', { recursive: true });

async function scenario(label, payload, fail) {
  const { server, pipeline } = createServer({ fiscal: createFiscalClient({ mode: 'mock', fail }), log: (m) => console.log(`  ${m}`) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n== ${label} ==`);

  const t0 = Date.now();
  const hook = await fetch(`${base}/webhooks/zoho-pos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [config.webhookSecretHeader]: config.webhookSecret },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

  // Simulated printer: poll, "print", report success.
  const poll = new URLSearchParams({ ConnectionType: 'GetRequest', ID: config.defaultPrinter, Name: 'TM-m30III' });
  const xml = await fetch(`${base}/epson/sdp`, { method: 'POST', body: poll }).then((r) => r.text());
  const jobId = /<printjobid>([^<]+)</.exec(xml)?.[1];
  const ack = `<PrintResponseInfo Version="2.00"><ePOSPrint><Parameter><devid>local_printer</devid><printjobid>${jobId}</printjobid></Parameter><PrintResponse><response success="true" code="" status="251658262" battery="0"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
  await fetch(`${base}/epson/sdp`, { method: 'POST', body: new URLSearchParams({ ConnectionType: 'SetResponse', ID: config.defaultPrinter, ResponseFile: ack }) });
  const elapsed = Date.now() - t0;

  const result = await pipeline.getSale(`INV-${payload.invoice_id}`);
  const name = `out/${hook.number}-${fail ? 'not-fiscalized' : 'fiscalized'}`;
  await writeFile(`${name}.txt`, renderText(result.rows));
  await writeFile(`${name}.html`, await renderHtml(result.rows, `${hook.number} receipt`));
  await writeFile(`${name}.epson.xml`, xml);
  server.close();

  console.log(`  webhook response: ${JSON.stringify(hook)}`);
  console.log(`  sale -> printed in ${elapsed}ms (mock fiscalization)`);
  console.log(`  wrote ${name}.{txt,html,epson.xml}\n`);
  console.log(renderText(result.rows));
}

await scenario('Fiscalized sale', raw, false);
await scenario('E-invoicing service down', { ...raw, invoice_id: '1496042000000111999', invoice_number: 'SI-12' }, true);
