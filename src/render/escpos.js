// Raw ESC/POS bytes for generic thermal receipt printers (Epson, Xprinter,
// Rongta, Star in ESC/POS mode...). Sent by the Windows print agent straight
// to the printer, so no driver template is involved. The QR code uses the
// standard GS ( k commands, which the printer draws itself.

import { rowLines } from './text.js';

const ESC = 0x1b;
const GS = 0x1d;

// Receipt text is ASCII-safe: accents and symbols the printer's code page
// might print as garbage are mapped to plain letters.
const ascii = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x0a\x20-\x7e]/g, '?');

export function renderEscpos(rows) {
  const out = [];
  const bytes = (...b) => out.push(Buffer.from(b));
  const text = (s) => out.push(Buffer.from(ascii(s), 'latin1'));

  bytes(ESC, 0x40); // initialise
  for (const row of rows) {
    if (row.kind === 'qr') {
      const data = Buffer.from(row.data, 'utf8');
      const len = data.length + 3;
      bytes(ESC, 0x61, 1);
      bytes(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // model 2
      bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6); // module size
      bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
      bytes(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30);
      out.push(data);
      bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
      bytes(0x0a);
      continue;
    }
    const center = row.kind === 'center';
    bytes(ESC, 0x61, center ? 1 : 0);
    bytes(ESC, 0x45, row.bold ? 1 : 0);
    bytes(GS, 0x21, row.big ? 0x11 : 0x00);
    const lines = center ? rowLines(row).map((l) => l.trim()) : rowLines(row);
    text(lines.join('\n') + '\n');
  }
  bytes(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0);
  bytes(GS, 0x56, 0x42, 3); // feed and partial cut
  return Buffer.concat(out);
}
