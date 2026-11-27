// #456: every reassessment is its own dated assessment_submissions row (never an
// edit of the first one), and this shows how each number moved across them.
//
// A "data point" is any numeric answer in the template: a text field, a combo
// box whose options are numbers, or one cell of a table (row × column). Free
// text, notes and dates are skipped. A point appears once at least one
// assessment has a number for it.
//
// #497 (Cordell): tapping a data point's "First → latest" box opens a graph of
// that number from the first assessment through every reassessment, and each
// step is coloured green / yellow / red for progress / plateau / regression.
// A "Graphs" view shows every data point that way at once.
//
// Which way is "better" is not stored on a template field, so it is read from
// the field's name (metricDirection below): times and sprints are better when
// LOWER, body measurements and equipment sizes have no better direction and
// stay uncoloured, everything else (velocity, jumps, strength, range of
// motion) is better when HIGHER. A template element can override the guess
// with `better: 'higher' | 'lower' | 'none'` in its schema.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineChart, Table2, X } from 'lucide-react';

const NUMBER_RE = /-?\d+(?:\.\d+)?/;

export function parseNumeric(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = String(raw).replace(/,/g, '').match(NUMBER_RE);
  return m ? Number(m[0]) : null;
}

// Oldest first: assessment_date, then created_at for two on the same day.
export function sortSubmissionsAsc(submissions) {
  return [...(submissions || [])].sort((a, b) =>
    (a.assessment_date || '').localeCompare(b.assessment_date || '')
    || (a.created_at || '').localeCompare(b.created_at || ''));
}

// ---------------------------------------------------------------------------
// Direction + status (#497)
// ---------------------------------------------------------------------------

// A change smaller than this share of the previous value counts as a plateau.
export const PLATEAU_PCT = 2;

const NEUTRAL_RE = /\b(height|weight|bat length|length|age|attack angle|warm-?ups?|glasses|contacts|surger(y|ies)|phase|brand|model)\b/i;
const LOWER_RE = /\b(time|secs?|seconds?|sprint|dash|home to)\b/i;

/** 'higher' | 'lower' | 'neutral' — which way this number should move. */
export function metricDirection(label, override) {
  if (override === 'higher' || override === 'lower') return override;
  if (override === 'none' || override === 'neutral') return 'neutral';
  const text = String(label || '');
  if (NEUTRAL_RE.test(text)) return 'neutral';
  if (LOWER_RE.test(text)) return 'lower';
  return 'higher';
}

/** 'progress' | 'plateau' | 'regression' | 'neutral', or null with no pair. */
export function changeStatus(from, to, direction) {
  if (from == null || to == null) return null;
  if (direction === 'neutral') return 'neutral';
  const d = to - from;
  const pct = from !== 0 ? (Math.abs(d) / Math.abs(from)) * 100 : (d === 0 ? 0 : 100);
  if (d === 0 || pct < PLATEAU_PCT) return 'plateau';
  const better = direction === 'lower' ? d < 0 : d > 0;
  return better ? 'progress' : 'regression';
}

// Light = on the white table. Dark = on the ink chart card.
export const STATUS_STYLE = {
  progress: { label: 'Progress', light: 'text-green-700', cell: 'bg-green-50 hover:bg-green-100', hex: '#4ade80' },
  plateau: { label: 'Plateau', light: 'text-yellow-700', cell: 'bg-yellow-50 hover:bg-yellow-100', hex: '#facc15' },
  regression: { label: 'Regression', light: 'text-red-600', cell: 'bg-red-50 hover:bg-red-100', hex: '#f87171' },
  neutral: { label: 'No better / worse direction', light: 'text-gray-500', cell: 'bg-white hover:bg-gray-50', hex: '#E6DBB9' },
};

export function buildAssessmentTrend(schema, submissions) {
  const subs = sortSubmissionsAsc(submissions);
  const points = [];
  const elements = [...(schema || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const el of elements) {
    const label = el.label || el.type;
    if (el.type === 'text_field' || el.type === 'combo_box') {
      points.push({
        key: el.id, label, direction: metricDirection(label, el.better),
        values: subs.map(s => parseNumeric(s.responses?.[el.id])),
      });
    } else if (el.type === 'table') {
      for (const row of el.rows || []) {
        for (const col of el.columns || []) {
          const full = `${label} · ${row}${(el.columns || []).length > 1 ? ` · ${col}` : ''}`;
          points.push({
            key: `${el.id}|${row}|${col}`,
            label: full, direction: metricDirection(full, el.better),
            values: subs.map(s => parseNumeric(s.responses?.[el.id]?.[row]?.[col])),
          });
        }
      }
    }
  }
  return { submissions: subs, points: points.filter(p => p.values.some(v => v != null)) };
}

// The dated readings of one data point, oldest first, blanks dropped.
export function pointSeries(point, subs) {
  const out = [];
  (point?.values || []).forEach((v, i) => {
    if (v == null) return;
    out.push({ value: v, date: subs[i]?.assessment_date || '', id: subs[i]?.id || String(i) });
  });
  return out;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
// One decimal under 10% so a 1.7% change does not print as "2%" right next to
// a plateau band defined as "under 2%".
export const pctText = (p) => (Math.abs(p) < 10 ? String(Math.round(p * 10) / 10) : String(Math.round(p)));

// "Exit Velo Tee Middle (MPH):" -> { title: 'Exit Velo Tee Middle', unit: 'MPH' }
export function splitLabelUnit(label) {
  const clean = String(label || '').replace(/\s*:\s*$/, '').trim();
  // Only a single trailing "(unit)". "Bat Length (in)/ Weight (oz)" holds two
  // measures, so it keeps its whole name and gets no unit.
  const m = clean.match(/^([^()]*?)\s*\(([^()]{1,14})\)$/);
  if (m && m[1].trim()) return { title: m[1].trim(), unit: m[2].trim() };
  return { title: clean, unit: '' };
}

// 2026-11-16 -> 11/16 (or 11/16/26 when the series spans more than one year).
export function shortDate(dateStr, withYear) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr || '';
  const base = `${Number(m[2])}/${Number(m[3])}`;
  return withYear ? `${base}/${m[1].slice(2)}` : base;
}

function Delta({ from, to, direction }) {
  const status = changeStatus(from, to, direction);
  if (!status) return null;
  const d = to - from;
  if (d === 0) return <span className={`text-[10px] ${direction === 'neutral' ? 'text-gray-400' : STATUS_STYLE.plateau.light}`}>no change</span>;
  const pct = from !== 0 ? ` (${d > 0 ? '+' : ''}${pctText((d / Math.abs(from)) * 100)}%)` : '';
  return (
    <span className={`text-[10px] whitespace-nowrap ${STATUS_STYLE[status].light}`} title={STATUS_STYLE[status].label}>
      {d > 0 ? '▲ +' : '▼ '}{fmt(d)}{pct}
    </span>
  );
}

// Last non-null value at or before index i (so a skipped field compares to the
// most recent assessment that actually recorded it).
const prevValue = (values, i) => {
  for (let j = i - 1; j >= 0; j--) if (values[j] != null) return values[j];
  return null;
};

// ---------------------------------------------------------------------------
// The graph (#497). Hand-drawn SVG: the app has no chart library.
// ---------------------------------------------------------------------------

const INK = '#1A091B';
const CREAM = '#E6DBB9';
const W = 600;
const H = 250;
const PAD = { left: 44, right: 30, top: 30, bottom: 34 };

// x positions: mostly proportional to the real time between assessments, with
// some even spacing mixed in so two assessments a few days apart stay readable.
export function chartPositions(series) {
  const n = series.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const times = series.map(p => new Date(`${p.date}T12:00:00`).getTime());
  const t0 = times[0];
  const span = times[n - 1] - t0;
  const usable = span > 0 && times.every(t => Number.isFinite(t));
  return series.map((_, i) => {
    const even = i / (n - 1);
    if (!usable) return even;
    return 0.65 * ((times[i] - t0) / span) + 0.35 * even;
  });
}

function TrendChart({ point, subs, onOpen, large }) {
  const series = useMemo(() => pointSeries(point, subs), [point, subs]);
  const { title, unit } = splitLabelUnit(point.label);
  const direction = point.direction;
  if (series.length === 0) return null;

  const first = series[0];
  const latest = series[series.length - 1];
  const overall = series.length >= 2 ? changeStatus(first.value, latest.value, direction) : null;
  const overallStyle = overall ? STATUS_STYLE[overall] : null;
  const spansYears = first.date.slice(0, 4) !== latest.date.slice(0, 4);

  const vals = series.map(p => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const padY = max === min ? Math.max(1, Math.abs(max) * 0.05) : (max - min) * 0.18;
  const lo = min - padY;
  const hi = max + padY;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xs = chartPositions(series).map(t => PAD.left + t * plotW);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const pts = series.map((p, i) => ({ ...p, x: xs[i], y: y(p.value) }));
  const baseY = PAD.top + plotH;
  const ticks = [hi - padY * 0.2, (hi + lo) / 2, lo + padY * 0.2];
  // Axis labels: whole numbers for wide ranges, decimals only when the whole
  // range is small (a 0.15–0.22 s time to contact).
  const range = hi - lo;
  const tickLabel = (t) => (range >= 20 ? String(Math.round(t)) : range >= 1 ? String(Math.round(t * 10) / 10) : String(Math.round(t * 100) / 100));
  // With many reassessments only the ends and the extremes are labelled.
  const labelAll = pts.length <= 8;
  const showLabel = (i) => labelAll || i === 0 || i === pts.length - 1 || pts[i].value === max || pts[i].value === min;
  const dateEvery = Math.max(1, Math.ceil(pts.length / 8));
  const segStatus = (i) => changeStatus(pts[i - 1].value, pts[i].value, direction);
  const pointColor = (i) => (i === 0 ? CREAM : STATUS_STYLE[segStatus(i)]?.hex || CREAM);

  const summary = `${title}: ${series.map(p => `${shortDate(p.date, true)} ${fmt(p.value)}`).join(', ')}`;
  const body = (
    <>
      <p className="text-[11px] sm:text-xs font-bold uppercase tracking-[0.18em] text-brand-cream break-words">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`${large ? 'text-5xl' : 'text-4xl'} font-black leading-none text-white tabular-nums`}>{fmt(latest.value)}</span>
        {unit && <span className="text-xs font-semibold uppercase tracking-wider text-white/50">{unit}</span>}
      </div>
      {series.length >= 2 ? (
        <p className="mt-1 text-sm font-semibold" style={{ color: overallStyle.hex }}>
          {latest.value === first.value ? 'No change' : signed(latest.value - first.value)} since {shortDate(first.date, spansYears)}
          {overall !== 'neutral' && <span className="font-normal text-white/60"> · {overallStyle.label}</span>}
        </p>
      ) : (
        <p className="mt-1 text-sm text-white/60">One assessment so far ({shortDate(first.date, true)})</p>
      )}

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full h-auto" role="img" aria-label={summary}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#ffffff" strokeOpacity="0.08" />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="13" fill="#ffffff" fillOpacity="0.45">{tickLabel(t)}</text>
          </g>
        ))}
        {pts.length >= 2 && (
          <polygon
            points={`${pts[0].x},${baseY} ${pts.map(p => `${p.x},${p.y}`).join(' ')} ${pts[pts.length - 1].x},${baseY}`}
            fill={CREAM} fillOpacity="0.13"
          />
        )}
        {pts.map((p, i) => i > 0 && (
          <line
            key={`s${i}`} x1={pts[i - 1].x} y1={pts[i - 1].y} x2={p.x} y2={p.y}
            stroke={pointColor(i)} strokeWidth="3.5" strokeLinecap="round"
          />
        ))}
        {pts.map((p, i) => {
          // A valley (every neighbour sits higher on the chart) is labelled
          // underneath, so the number is not drawn across the line running
          // down into it; everything else is labelled above.
          const neighbours = [pts[i - 1], pts[i + 1]].filter(Boolean);
          const valley = neighbours.length > 0 && neighbours.every(nb => nb.y < p.y - 4);
          const above = valley ? false : p.y - 12 > 14;
          return (
            <g key={p.id}>
              <circle cx={p.x} cy={p.y} r="6" fill={pointColor(i)} stroke={INK} strokeWidth="2">
                <title>{`${shortDate(p.date, true)}: ${fmt(p.value)}${unit ? ` ${unit}` : ''}`}</title>
              </circle>
              {showLabel(i) && (
                <text
                  x={Math.min(W - 6, Math.max(6, p.x))} y={above ? p.y - 12 : p.y + 22}
                  textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
                  fontSize="15" fontWeight="600"
                  fill={i === pts.length - 1 && i > 0 ? pointColor(i) : '#ffffff'} fillOpacity={i === pts.length - 1 ? 1 : 0.85}
                >
                  {fmt(p.value)}
                </text>
              )}
              {(i % dateEvery === 0 || i === pts.length - 1) && (
                <text
                  x={p.x} y={H - 10} fontSize="13" fill="#ffffff" fillOpacity="0.55"
                  textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
                >
                  {shortDate(p.date, spansYears)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </>
  );

  const shell = 'w-full text-left rounded-2xl bg-gradient-to-br from-brand-ink via-brand-700 to-brand-600 p-4 sm:p-5 shadow-lg ring-1 ring-brand-cream/15';
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={`${shell} transition hover:ring-brand-cream/40 focus:outline-none focus:ring-2 focus:ring-brand-cream/60`} aria-label={`Open the ${title} graph`}>
        {body}
      </button>
    );
  }
  return <div className={shell}>{body}</div>;
}

function Legend({ dark }) {
  const text = dark ? 'text-white/70' : 'text-gray-600';
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] ${text}`}>
      {['progress', 'plateau', 'regression'].map(k => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_STYLE[k].hex }} />
          {STATUS_STYLE[k].label}{k === 'plateau' ? ` (under ${PLATEAU_PCT}% change)` : ''}
        </span>
      ))}
    </div>
  );
}

function TrendModal({ point, subs, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const series = pointSeries(point, subs);
  const { unit } = splitLabelUnit(point.label);
  const directionNote = point.direction === 'lower'
    ? 'Lower is better for this measure.'
    : point.direction === 'higher'
      ? 'Higher is better for this measure.'
      : 'This measure has no better or worse direction, so it is shown without colours.';

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={`${point.label} trend`}
    >
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-brand-ink p-3 sm:p-4" onClick={(e) => e.stopPropagation()}>
        <button
          type="button" onClick={onClose} aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-white/10 p-1.5 text-white/80 hover:bg-white/20 hover:text-white"
        >
          <X size={18} />
        </button>
        <TrendChart point={point} subs={subs} large />
        <div className="mt-3 px-1">
          <Legend dark />
          <p className="mt-1.5 text-[11px] text-white/50">{directionNote}</p>
        </div>
        <ul className="mt-3 divide-y divide-white/10 rounded-xl bg-white/5">
          {series.map((p, i) => {
            const status = i > 0 ? changeStatus(series[i - 1].value, p.value, point.direction) : null;
            const d = i > 0 ? p.value - series[i - 1].value : 0;
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-white/70">{i === 0 ? 'First · ' : ''}{p.date}</span>
                <span className="flex items-baseline gap-3">
                  {status && (
                    <span className="text-xs font-semibold" style={{ color: STATUS_STYLE[status].hex }}>
                      {d === 0 ? 'no change' : signed(d)}{status !== 'neutral' ? ` · ${STATUS_STYLE[status].label}` : ''}
                    </span>
                  )}
                  <span className="font-bold tabular-nums text-white">{fmt(p.value)}{unit ? <span className="ml-1 text-[10px] font-medium uppercase text-white/50">{unit}</span> : null}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body
  );
}

export default function AssessmentTrends({ schema, submissions }) {
  const { submissions: subs, points } = useMemo(() => buildAssessmentTrend(schema, submissions), [schema, submissions]);
  const [view, setView] = useState('table');
  const [openKey, setOpenKey] = useState(null);

  if (subs.length < 2) {
    return <p className="text-sm text-gray-500 italic">Trends appear once there are at least two assessments.</p>;
  }
  if (points.length === 0) {
    return <p className="text-sm text-gray-500 italic">This assessment has no numeric answers to trend.</p>;
  }

  const graphable = points.filter(p => p.values.filter(v => v != null).length >= 2);
  const openPoint = openKey ? points.find(p => p.key === openKey) : null;
  const tabCls = (active) => `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${active ? 'bg-brand-ink text-brand-cream shadow' : 'text-gray-600 hover:text-gray-900'}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-gray-200/70 p-0.5" role="tablist" aria-label="Trend view">
          <button type="button" role="tab" aria-selected={view === 'table'} onClick={() => setView('table')} className={tabCls(view === 'table')}>
            <Table2 size={14} /> Table
          </button>
          <button type="button" role="tab" aria-selected={view === 'graphs'} onClick={() => setView('graphs')} className={tabCls(view === 'graphs')}>
            <LineChart size={14} /> Graphs
          </button>
        </div>
        <Legend />
      </div>

      {view === 'graphs' ? (
        graphable.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No data point has been measured twice yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {graphable.map(p => (
              <TrendChart key={p.key} point={p} subs={subs} onOpen={() => setOpenKey(p.key)} />
            ))}
          </div>
        )
      ) : (
        <>
          <p className="text-[11px] text-gray-500">Tap a First → latest box to see that number as a graph.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-gray-300 bg-white">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-300 px-3 py-1.5 text-left font-medium text-gray-600 sticky left-0 bg-gray-100">Data point</th>
                  {subs.map((s, i) => (
                    <th key={s.id} className="border border-gray-300 px-3 py-1.5 text-left font-medium text-gray-600 whitespace-nowrap">
                      {i === 0 ? 'First · ' : ''}{s.assessment_date}
                    </th>
                  ))}
                  <th className="border border-gray-300 px-3 py-1.5 text-left font-medium text-gray-600 whitespace-nowrap">First → latest</th>
                </tr>
              </thead>
              <tbody>
                {points.map(p => {
                  const first = p.values.find(v => v != null);
                  const latest = [...p.values].reverse().find(v => v != null);
                  const hasTrend = p.values.filter(v => v != null).length >= 2;
                  const status = hasTrend ? changeStatus(first, latest, p.direction) : null;
                  return (
                    <tr key={p.key}>
                      <td className="border border-gray-300 px-3 py-1.5 font-medium text-gray-700 bg-gray-50 sticky left-0">{p.label}</td>
                      {p.values.map((v, i) => (
                        <td key={i} className="border border-gray-300 px-3 py-1.5 text-gray-800">
                          <div>{v == null ? '—' : fmt(v)}</div>
                          {i > 0 && v != null && <Delta from={prevValue(p.values, i)} to={v} direction={p.direction} />}
                        </td>
                      ))}
                      <td className="border border-gray-300 p-0">
                        {hasTrend ? (
                          <button
                            type="button" onClick={() => setOpenKey(p.key)}
                            title={`${STATUS_STYLE[status].label} — open the graph`}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition ${STATUS_STYLE[status].cell}`}
                          >
                            <span>
                              <span className="block text-gray-800 whitespace-nowrap">{fmt(first)} → {fmt(latest)}</span>
                              <Delta from={first} to={latest} direction={p.direction} />
                            </span>
                            <LineChart size={14} className={`shrink-0 ${STATUS_STYLE[status].light}`} />
                          </button>
                        ) : (
                          <span className="block px-3 py-1.5 text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openPoint && <TrendModal point={openPoint} subs={subs} onClose={() => setOpenKey(null)} />}
    </div>
  );
}
