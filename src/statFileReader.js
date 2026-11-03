// #476: turn an uploaded stats file into a grid of strings (rows x cells).
//
// CSV and XLSX only — that is what GameChanger exports and what families build
// in Excel / Numbers. PDFs, screenshots, old binary .xls and links return
// null and the uploader types the numbers instead.
//
// XLSX is a zip of XML. Rather than pull in a spreadsheet library (the npm
// `xlsx` package is frozen at a version with open advisories) this reads the
// zip directory itself and inflates entries with the browser's built-in
// DecompressionStream. Only the first worksheet is read.

const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read .xlsx files');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// name -> Uint8Array for the entries we ask for.
async function readZipEntries(buf, wanted) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = utf8(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + compSize);
    if (method === 0) out[name] = raw;
    else if (method === 8) out[name] = await inflateRaw(raw);
  }
  return out;
}

const colIndex = (ref) => {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function parseXlsx(buf) {
  const entries = await readZipEntries(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheetName = Object.keys(entries)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  if (!sheetName) throw new Error('No worksheet found in that file');
  const xml = (bytes) => new DOMParser().parseFromString(utf8(bytes), 'application/xml');
  const shared = [];
  if (entries['xl/sharedStrings.xml']) {
    const doc = xml(entries['xl/sharedStrings.xml']);
    for (const si of Array.from(doc.getElementsByTagName('si'))) {
      shared.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent).join(''));
    }
  }
  const doc = xml(entries[sheetName]);
  const grid = [];
  for (const rowEl of Array.from(doc.getElementsByTagName('row'))) {
    const r = Number(rowEl.getAttribute('r')) - 1;
    const row = [];
    for (const c of Array.from(rowEl.getElementsByTagName('c'))) {
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent;
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = Array.from(c.getElementsByTagName('t')).map((t) => t.textContent).join('');
      else if (v != null) {
        // Excel stores 0.824 as 0.82399999999999995; trim the float noise.
        const num = Number(v);
        val = Number.isFinite(num) && type !== 'str' ? String(Number(num.toPrecision(12))) : v;
      }
      row[colIndex(c.getAttribute('r') || '')] = val.trim();
    }
    grid[r >= 0 ? r : grid.length] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(grid, (x) => x || []);
}

export const isReadableStatFile = (name) => /\.(csv|xlsx|txt)$/i.test(name || '');

// A File / Blob + its name -> grid, or null when the format is not readable.
export async function readStatGrid(blob, name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCsv(await blob.text());
  if (ext === 'xlsx') return parseXlsx(await blob.arrayBuffer());
  return null;
}
