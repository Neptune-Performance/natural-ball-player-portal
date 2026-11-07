// #476: the season stat line saved on an external_stats row (stat_line jsonb)
// and how one is read out of an uploaded spreadsheet.
//
// Shape (every field optional):
//   { batting:  { pa, ab, h, bb, hbp, sf, so, avg, obp, slg, ops },
//     pitching: { ip, bf, pitches, h, bb, so, er, era, whip },
//     origin: 'file' | 'manual', file_name, matched_name }
//
// The SQL behind the Player Card (rating_metric_values in
// 20261103_player_card_coverage.sql) reads batting.pa/obp/ops and
// pitching.ip/whip/bf/so — so normalizeStatLine() fills OBP / OPS / WHIP
// from the counting stats when a file only has those.
//
// Layouts handled:
//   - GameChanger team export (CSV): a section row ("Batting", "Pitching",
//     "Fielding") over one wide header row with Number / Last / First, then
//     one row per player. The same header (H, BB, SO…) appears under several
//     sections, so columns are assigned by section span.
//   - Simple blocks (a family's own sheet): a row starting "Batting" whose
//     other cells are headers, the numbers on the next row; same for
//     "Pitching". No names, so the whole sheet is one athlete.

export const BATTING_FIELDS = [
  { key: 'pa', label: 'PA' }, { key: 'ab', label: 'AB' }, { key: 'h', label: 'H' },
  { key: 'bb', label: 'BB' }, { key: 'hbp', label: 'HBP' }, { key: 'so', label: 'SO' },
  { key: 'avg', label: 'AVG' }, { key: 'obp', label: 'OBP' }, { key: 'slg', label: 'SLG' }, { key: 'ops', label: 'OPS' },
];
export const PITCHING_FIELDS = [
  { key: 'ip', label: 'IP' }, { key: 'bf', label: 'BF' }, { key: 'pitches', label: '#P' },
  { key: 'h', label: 'H' }, { key: 'bb', label: 'BB' }, { key: 'so', label: 'SO' },
  { key: 'er', label: 'ER' }, { key: 'era', label: 'ERA' }, { key: 'whip', label: 'WHIP' },
];

const BAT_HEADERS = { PA: 'pa', AB: 'ab', H: 'h', BB: 'bb', HBP: 'hbp', SF: 'sf', SO: 'so', K: 'so', AVG: 'avg', BA: 'avg', OBP: 'obp', SLG: 'slg', OPS: 'ops' };
const PIT_HEADERS = { IP: 'ip', BF: 'bf', TBF: 'bf', '#P': 'pitches', NP: 'pitches', PITCHES: 'pitches', H: 'h', BB: 'bb', SO: 'so', K: 'so', ER: 'er', ERA: 'era', WHIP: 'whip' };
const SECTION = { BATTING: 'batting', HITTING: 'batting', OFFENSE: 'batting', PITCHING: 'pitching', FIELDING: 'fielding', CATCHING: 'fielding', DEFENSE: 'fielding' };
const BAT_ONLY = new Set(['PA', 'AB', 'AVG', 'OBP', 'SLG', 'OPS']);
const PIT_ONLY = new Set(['IP', 'ERA', 'WHIP', 'BF', '#P']);
const NAME_COLS = { LAST: 'last', 'LAST NAME': 'last', FIRST: 'first', 'FIRST NAME': 'first', NAME: 'name', PLAYER: 'name' };

const U = (c) => String(c ?? '').trim().toUpperCase();

export function num(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/%$/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Number(s);
}

const isHeaderRow = (row) => {
  let n = 0;
  for (const c of row) if (BAT_ONLY.has(U(c)) || PIT_ONLY.has(U(c))) n++;
  return n >= 2;
};

// Section for each column of a header row.
function sectionsFor(grid, r) {
  const row = grid[r];
  const above = r > 0 ? grid[r - 1] : [];
  const labelled = above.some((c) => SECTION[U(c)]) && above.filter((c) => U(c)).every((c) => SECTION[U(c)]);
  const out = [];
  if (labelled) {
    let cur = null;
    for (let i = 0; i < row.length; i++) {
      if (SECTION[U(above[i])]) cur = SECTION[U(above[i])];
      out[i] = cur;
    }
    return out;
  }
  if (SECTION[U(row[0])]) return row.map(() => SECTION[U(row[0])]);
  // No labels: batting until the first pitching-only column.
  let cur = row.some((c) => BAT_ONLY.has(U(c))) ? 'batting' : 'pitching';
  for (let i = 0; i < row.length; i++) {
    if (cur === 'batting' && PIT_ONLY.has(U(row[i]))) cur = 'pitching';
    out[i] = cur;
  }
  return out;
}

const stopRow = (row) => {
  const first = U(row[0]);
  return row.every((c) => !U(c)) || first === 'TOTALS' || first === 'TOTAL' || first === 'GLOSSARY' || isHeaderRow(row);
};

/**
 * Every athlete line found in the grid: [{ name, batting, pitching }].
 * name is null for a sheet without name columns (one athlete).
 */
export function extractStatCandidates(grid) {
  const byName = new Map();
  const add = (name, section, values) => {
    if (section !== 'batting' && section !== 'pitching') return;
    if (!Object.keys(values).length) return;
    const k = name || '';
    if (!byName.has(k)) byName.set(k, { name: name || null, batting: {}, pitching: {} });
    Object.assign(byName.get(k)[section], values);
  };
  for (let r = 0; r < grid.length; r++) {
    const head = grid[r] || [];
    if (!isHeaderRow(head)) continue;
    const secs = sectionsFor(grid, r);
    const nameCols = {};
    head.forEach((c, i) => { const k = NAME_COLS[U(c)]; if (k && nameCols[k] == null) nameCols[k] = i; });
    const hasNames = Object.keys(nameCols).length > 0;
    for (let d = r + 1; d < grid.length; d++) {
      const row = grid[d] || [];
      // A hand-built block can leave a blank line or two under its header.
      if (!hasNames && d - r <= 3 && row.every((c) => !U(c))) continue;
      if (stopRow(row)) break;
      let name = null;
      if (hasNames) {
        name = nameCols.name != null
          ? String(row[nameCols.name] || '').trim()
          : [row[nameCols.first], row[nameCols.last]].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
        if (!name) continue;
      }
      const vals = { batting: {}, pitching: {} };
      head.forEach((h, i) => {
        const sec = secs[i];
        const map = sec === 'batting' ? BAT_HEADERS : sec === 'pitching' ? PIT_HEADERS : null;
        const key = map && map[U(h)];
        if (!key || vals[sec][key] != null) return; // first occurrence wins
        const v = num(row[i]);
        if (v != null) vals[sec][key] = v;
      });
      add(name, 'batting', vals.batting);
      add(name, 'pitching', vals.pitching);
      if (!hasNames) break; // a block has one value row
    }
  }
  return [...byName.values()];
}

// #479: a hand-typed doc of "LABEL value" lines, e.g. Jimmy Facilla's
//   HITTING STATS / PA 124 / AVG .291 / OBP.479 / ... / NO PITCHING STATS
// A line with no number that names a section switches section; before any
// section heading, pitching-only labels go to pitching and the rest batting.
// Several pairs on one line ("PA 124 AB 86") are fine. One athlete only.
const PAIR_RE = /(^|[^A-Z0-9#])([A-Z#]+)\s*:?\s*(-?\d*\.?\d+)(?![\d.%])/gi;
export function extractLabelValueStats(text) {
  const out = { name: null, batting: {}, pitching: {} };
  let section = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/\d/.test(line)) {
      const word = U(line).split(/[^A-Z]+/).find((w) => SECTION[w]);
      if (word) section = SECTION[word];
      continue;
    }
    if (section === 'fielding') continue;
    PAIR_RE.lastIndex = 0;
    let m;
    while ((m = PAIR_RE.exec(line))) {
      const label = U(m[2]);
      const sec = section || (PIT_ONLY.has(label) ? 'pitching' : 'batting');
      const key = (sec === 'pitching' ? PIT_HEADERS : BAT_HEADERS)[label];
      const v = num(m[3]);
      if (key && v != null && out[sec][key] == null) out[sec][key] = v;
    }
  }
  return Object.keys(out.batting).length || Object.keys(out.pitching).length ? [out] : [];
}

// Text from a linked doc/sheet -> candidates. Tables first (tab- or comma-
// separated rows, as a sheet's CSV or a doc table exports), then loose lines.
export function extractStatCandidatesFromText(text, parseCsv) {
  const s = String(text || '');
  const grids = [s.split(/\r?\n/).map((l) => l.split('\t'))];
  if (parseCsv) grids.push(parseCsv(s));
  for (const g of grids) {
    const found = extractStatCandidates(g);
    if (found.length) return found;
  }
  return extractLabelValueStats(s);
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// The candidate that is this athlete, or null when it cannot be told apart.
export function pickCandidate(candidates, fullName) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const want = normName(fullName);
  const [first, ...rest] = want.split(' ');
  const last = rest[rest.length - 1] || '';
  const exact = candidates.filter((c) => normName(c.name) === want);
  if (exact.length === 1) return exact[0];
  // "K Moses" style exports, or a nickname: same last name, same first initial.
  const loose = candidates.filter((c) => {
    const parts = normName(c.name).split(' ');
    return parts.includes(last) && parts.some((p) => p && p[0] === first[0] && p !== last);
  });
  return loose.length === 1 ? loose[0] : null;
}

const round = (v, p) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const outsFromIp = (ip) => (ip == null ? null : Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10));

// Fill PA / OBP / OPS / WHIP from counting stats where they are missing, and
// drop empty sections. Returns null when nothing usable is left.
export function normalizeStatLine(line) {
  if (!line) return null;
  const b = { ...(line.batting || {}) };
  const p = { ...(line.pitching || {}) };
  for (const o of [b, p]) for (const k of Object.keys(o)) { const v = num(o[k]); if (v == null) delete o[k]; else o[k] = v; }
  if (b.pa == null && b.ab != null) b.pa = b.ab + (b.bb || 0) + (b.hbp || 0) + (b.sf || 0);
  if (b.obp == null && b.h != null && b.ab != null) {
    const den = b.ab + (b.bb || 0) + (b.hbp || 0) + (b.sf || 0);
    if (den > 0) b.obp = round((b.h + (b.bb || 0) + (b.hbp || 0)) / den, 3);
  }
  if (b.avg == null && b.h != null && b.ab > 0) b.avg = round(b.h / b.ab, 3);
  if (b.ops == null && b.obp != null && b.slg != null) b.ops = round(b.obp + b.slg, 3);
  const outs = outsFromIp(p.ip);
  if (p.whip == null && outs > 0 && p.h != null && p.bb != null) p.whip = round(((p.h + p.bb) * 3) / outs, 2);
  const out = { ...line };
  out.batting = Object.keys(b).length ? b : undefined;
  out.pitching = Object.keys(p).length ? p : undefined;
  if (!out.batting && !out.pitching) return null;
  return JSON.parse(JSON.stringify(out));
}

// One short line for a saved row: "19 PA · .842 OBP · 9 IP · 1.89 WHIP".
export function statLineSummary(line) {
  if (!line) return '';
  const b = line.batting || {};
  const p = line.pitching || {};
  const rate = (v) => (v < 1 ? v.toFixed(3).replace(/^0/, '') : v.toFixed(3));
  const parts = [];
  if (b.pa != null) parts.push(`${b.pa} PA`);
  if (b.avg != null) parts.push(`${rate(b.avg)} AVG`);
  if (b.obp != null) parts.push(`${rate(b.obp)} OBP`);
  if (b.ops != null) parts.push(`${rate(b.ops)} OPS`);
  if (p.ip != null) parts.push(`${p.ip} IP`);
  if (p.whip != null) parts.push(`${p.whip.toFixed(2)} WHIP`);
  if (p.so != null && p.bf) parts.push(`${p.so} K / ${p.bf} BF`);
  return parts.join(' · ');
}
