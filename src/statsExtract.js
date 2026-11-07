// #483 / #487: shared client side of the stats-extract edge function
// (Claude vision reads stat screenshots; a person reviews before saving).
//   prepareImage      shrink / re-encode a photo so it fits the 5 MB API limit
//   uploadScreenshots put the images in the athlete's storage folder
//   extractStats      call the function, return its parsed result
//   normalizePitchType / deriveSeasonLine  tidy what came back

import { supabase } from './supabaseClient';
import { safeFileName } from './externalStatsSources';

const MAX_DIM = 2400;
const KEEP_BYTES = 3.5 * 1024 * 1024;
const PASS_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} could not be opened as an image. Use a PNG or JPEG screenshot.`)); };
    img.src = url;
  });
}

// Returns { blob, name } ready to upload. Small PNG / JPEG / WebP files pass
// through; anything big, huge, or another format (HEIC on Safari) is redrawn
// to a JPEG no larger than MAX_DIM on its long edge.
export async function prepareImage(file) {
  const img = await loadImage(file);
  const big = Math.max(img.naturalWidth, img.naturalHeight);
  if (PASS_TYPES.includes(file.type) && file.size <= KEEP_BYTES && big <= MAX_DIM) {
    return { blob: file, name: safeFileName(file.name) };
  }
  const scale = Math.min(1, MAX_DIM / big);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error(`${file.name} could not be converted.`);
  return { blob, name: safeFileName(file.name).replace(/\.[^.]+$/, '') + '.jpg' };
}

// Uploads to `${playerId}/${prefix}${ts}-${i}-${name}`; returns the paths.
export async function uploadScreenshots(bucket, playerId, files, prefix = '') {
  const paths = [];
  const ts = Date.now();
  for (let i = 0; i < files.length; i++) {
    const { blob, name } = await prepareImage(files[i]);
    const path = `${playerId}/${prefix}${ts}-${i}-${name}`;
    const { error } = await supabase.storage.from(bucket).upload(path, blob, {
      upsert: false, contentType: blob.type || 'image/jpeg',
    });
    if (error) {
      if (paths.length) await supabase.storage.from(bucket).remove(paths);
      throw new Error(`Upload of ${files[i].name} failed: ${error.message}`);
    }
    paths.push(path);
  }
  return paths;
}

// Calls stats-extract. Throws an Error with a user-facing message.
export async function extractStats({ mode, playerId, paths }) {
  const { data, error } = await supabase.functions.invoke('stats-extract', {
    body: { mode, player_id: playerId, paths },
  });
  if (error) {
    // supabase-js puts a non-2xx body on error.context, not on data.
    let msg = 'Could not read the screenshots. Try again, or enter the numbers by hand.';
    try {
      const body = await error.context?.json?.();
      if (body?.message) msg = body.message;
      else if (body?.error) msg = `Could not read the screenshots (${body.error}).`;
    } catch (_e) { /* keep the generic message */ }
    throw new Error(msg);
  }
  if (!data?.result) throw new Error('The screenshot reader returned nothing.');
  return data.result;
}

// ---- Trackman ---------------------------------------------------------------
// Codes shared with BullpenSync / the Trackman tab retag menu.
const PITCH_ALIASES = [
  ['FB', /^(fb|ff|fa|4s|(four|4)[- ]?seam( fastball)?|fastball)$/i],
  ['SI', /^(si|ft|2s|sinker|two[- ]?seam|2[- ]?seam)/i],
  ['CT', /^(ct|fc|cut|cutter)/i],
  ['SL', /^(sl|slider|sweeper|sw|st)$/i],
  ['CB', /^(cb|cu|kc|curve|curveball|knuckle ?curve|slurve)/i],
  ['CH', /^(ch|chg|change|changeup|change-up|circle change)/i],
  ['SP', /^(sp|fs|splitter|split|split-finger|forkball)/i],
];
export function normalizePitchType(label) {
  const t = String(label || '').trim();
  if (!t) return '';
  for (const [code, re] of PITCH_ALIASES) if (re.test(t)) return code;
  return t;
}

// Weighted helpers: a screenshot summary row stands for summary_count pitches.
export const rowWeight = (r) => (r?.is_summary ? Math.max(1, Number(r.summary_count) || 1) : 1);
export function weightedAvg(rows, key) {
  let s = 0; let w = 0;
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === '' || !Number.isFinite(Number(v))) continue;
    const k = rowWeight(r);
    s += Number(v) * k; w += k;
  }
  return w ? s / w : null;
}
export function maxOf(rows, keys) {
  let m = null;
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k];
      if (v == null || v === '' || !Number.isFinite(Number(v))) continue;
      m = m == null ? Number(v) : Math.max(m, Number(v));
    }
  }
  return m;
}
export const pitchTotal = (rows) => rows.reduce((n, r) => n + rowWeight(r), 0);

// ---- Season lines (#487) ----------------------------------------------------
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
// 4.2 (baseball notation) -> 14 outs
export const ipToOuts = (ip) => {
  const v = n(ip);
  if (v == null || v < 0) return null;
  return Math.floor(v) * 3 + Math.round((v - Math.floor(v)) * 10);
};

export const SEASON_FIELDS = {
  hitting: [
    ['games', 'G'], ['pa', 'PA'], ['ab', 'AB'], ['r', 'R'], ['h', 'H'], ['doubles', '2B'], ['triples', '3B'], ['hr', 'HR'],
    ['rbi', 'RBI'], ['bb', 'BB'], ['so', 'K'], ['hbp', 'HBP'], ['sf', 'SF'], ['sb', 'SB'], ['cs', 'CS'],
    ['avg', 'AVG'], ['obp', 'OBP'], ['slg', 'SLG'], ['ops', 'OPS'],
  ],
  pitching: [
    ['games', 'G'], ['ip', 'IP'], ['w', 'W'], ['l', 'L'], ['sv', 'SV'], ['bf', 'BF'], ['pitches', '#P'], ['h', 'H'],
    ['er', 'ER'], ['bb', 'BB'], ['so', 'K'], ['hbp', 'HBP'], ['era', 'ERA'], ['whip', 'WHIP'], ['baa', 'BAA'],
  ],
  fielding: [
    ['games', 'G'], ['tc', 'TC'], ['po', 'PO'], ['a', 'A'], ['e', 'E'], ['dp', 'DP'], ['fpct', 'FPCT'],
  ],
};
export const RATE_FIELDS = new Set(['avg', 'obp', 'slg', 'ops', 'era', 'whip', 'baa', 'fpct', 'ip']);

// Fill rates the screen didn't show from the counting stats it did, so a line
// with only counts still counts on the Player Card. Never overwrites a value.
export function deriveSeasonLine(line) {
  const o = { ...line };
  for (const [k] of SEASON_FIELDS[o.category] || []) o[k] = n(o[k]);
  if (o.category === 'hitting') {
    const onBase = (o.h ?? 0) + (o.bb ?? 0) + (o.hbp ?? 0);
    if (o.pa == null && o.ab != null) o.pa = o.ab + (o.bb ?? 0) + (o.hbp ?? 0) + (o.sf ?? 0);
    if (o.avg == null && o.ab > 0 && o.h != null) o.avg = r3(o.h / o.ab);
    const obpDen = o.ab != null ? o.ab + (o.bb ?? 0) + (o.hbp ?? 0) + (o.sf ?? 0) : null;
    if (o.obp == null && obpDen > 0 && o.h != null) o.obp = r3(onBase / obpDen);
    if (o.slg == null && o.ab > 0 && o.h != null && o.doubles != null && o.triples != null && o.hr != null) {
      const tb = o.h + o.doubles + 2 * o.triples + 3 * o.hr;
      o.slg = r3(tb / o.ab);
    }
    if (o.ops == null && o.obp != null && o.slg != null) o.ops = r3(o.obp + o.slg);
  } else if (o.category === 'pitching') {
    const outs = ipToOuts(o.ip);
    if (o.whip == null && outs > 0 && o.h != null && o.bb != null) o.whip = r2(((o.h + o.bb) * 3) / outs);
    if (o.era == null && outs > 0 && o.er != null) o.era = r2((o.er * 27) / outs);
    // Batters faced, when not shown: outs + hits + walks + hit batters (an
    // estimate that ignores errors / fielder's choices; good enough for K%).
    if (o.bf == null && outs != null && o.h != null && o.bb != null) o.bf = outs + o.h + o.bb + (o.hbp ?? 0);
  } else if (o.category === 'fielding') {
    if (o.tc == null && o.po != null && o.a != null && o.e != null) o.tc = o.po + o.a + o.e;
    if (o.fpct == null && o.tc > 0 && o.po != null && o.a != null) o.fpct = r3((o.po + o.a) / o.tc);
  }
  return o;
}

export const seasonLineKey = (l) => [l.source, String(l.season || '').trim().toLowerCase(), l.category, String(l.team || '').trim().toLowerCase()].join('|');
