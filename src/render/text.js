// Plain-text layout for an 80mm printer: 48 characters per line in Font A.
// The Epson renderer reuses these lines so spacing matches the preview.

export const WIDTH = 48;

export function wrap(text, width = WIDTH) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (line) out.push(line);
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      line = out.pop();
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

export const center = (text, width = WIDTH) =>
  wrap(text, width).map((l) => ' '.repeat(Math.floor((width - l.length) / 2)) + l);

export function pair(left, right, width = WIDTH) {
  const room = width - right.length - 1;
  const l = left.length > room ? left.slice(0, room) : left;
  return l + ' '.repeat(width - l.length - right.length) + right;
}

// Lines for one row; double-width text gets half the columns.
export function rowLines(row) {
  const width = row.big ? WIDTH / 2 : WIDTH;
  switch (row.kind) {
    case 'center': return center(row.text, width);
    case 'text': return wrap(row.text, width);
    case 'pair': return [pair(row.left, row.right, width)];
    case 'rule': return ['-'.repeat(WIDTH)];
    case 'feed': return [''];
    case 'qr': return center('[QR CODE]');
    default: throw new Error(`Unknown row kind: ${row.kind}`);
  }
}

export function renderText(rows) {
  return rows.flatMap(rowLines).join('\n') + '\n';
}
