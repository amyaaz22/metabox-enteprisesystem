// HTML preview of the printed receipt, used for the desk test and for
// showing the client/MRA the layout before any printer is involved.

import QRCode from 'qrcode';
import { rowLines, WIDTH } from './text.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function renderHtml(rows, title = 'Receipt preview') {
  const body = [];
  for (const row of rows) {
    if (row.kind === 'qr') {
      const svg = await QRCode.toString(row.data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      body.push(`<div class="qr">${svg}</div>`);
      continue;
    }
    const cls = [row.bold && 'b', row.big && 'big'].filter(Boolean).join(' ');
    body.push(`<pre class="${cls}">${esc(rowLines(row).join('\n')) || ' '}</pre>`);
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { background: #e9e9e9; margin: 0; padding: 24px; }
  .paper { background: #fff; width: ${WIDTH}ch; margin: 0 auto; padding: 16px 12px; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  pre { margin: 0; font: 13px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #111; white-space: pre; }
  .b { font-weight: 700; }
  .big { font-size: 26px; line-height: 1.3; }
  .qr { width: 150px; margin: 6px auto; }
  .qr svg { width: 100%; height: auto; display: block; }
</style></head>
<body><div class="paper">
${body.join('\n')}
</div></body></html>
`;
}
