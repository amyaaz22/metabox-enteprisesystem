// Epson ePOS-Print XML, the format Epson TM printers accept from Server
// Direct Print. The printer draws the QR code itself from the data string.

import { rowLines } from './text.js';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEpos(rows) {
  const out = ['<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">', '<text lang="en"/>'];
  for (const row of rows) {
    if (row.kind === 'qr') {
      out.push('<text align="center"/>');
      out.push(`<symbol type="qrcode_model_2" level="level_m" width="6">${esc(row.data)}</symbol>`);
      out.push('<feed line="1"/>');
      continue;
    }
    const align = row.kind === 'center' ? 'center' : 'left';
    out.push(`<text align="${align}" em="${row.bold ? 'true' : 'false'}" dw="${row.big ? 'true' : 'false'}" dh="${row.big ? 'true' : 'false'}"/>`);
    // Centre rows are laid out by the printer; others keep their padded spacing.
    const lines = row.kind === 'center' ? rowLines(row).map((l) => l.trim()) : rowLines(row);
    out.push(`<text>${esc(lines.join('\n'))}&#10;</text>`);
  }
  out.push('<feed line="2"/>', '<cut type="feed"/>', '</epos-print>');
  return out.join('\n');
}
