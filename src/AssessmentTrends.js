// #456: every reassessment is its own dated assessment_submissions row (never an
// edit of the first one), and this shows how each number moved across them.
//
// A "data point" is any numeric answer in the template: a text field, a combo
// box whose options are numbers, or one cell of a table (row × column). Free
// text, notes and dates are skipped. A point appears once at least one
// assessment has a number for it.
//
// The direction of "better" is not known for an arbitrary template field (a
// faster 60 time is lower, a higher exit velo is higher), so changes are shown
// as signed numbers in a neutral colour rather than green/red.
import React from 'react';

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

export function buildAssessmentTrend(schema, submissions) {
  const subs = sortSubmissionsAsc(submissions);
  const points = [];
  const elements = [...(schema || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const el of elements) {
    const label = el.label || el.type;
    if (el.type === 'text_field' || el.type === 'combo_box') {
      points.push({ key: el.id, label, values: subs.map(s => parseNumeric(s.responses?.[el.id])) });
    } else if (el.type === 'table') {
      for (const row of el.rows || []) {
        for (const col of el.columns || []) {
          points.push({
            key: `${el.id}|${row}|${col}`,
            label: `${label} · ${row}${(el.columns || []).length > 1 ? ` · ${col}` : ''}`,
            values: subs.map(s => parseNumeric(s.responses?.[el.id]?.[row]?.[col])),
          });
        }
      }
    }
  }
  return { submissions: subs, points: points.filter(p => p.values.some(v => v != null)) };
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

function Delta({ from, to }) {
  if (from == null || to == null) return null;
  const d = to - from;
  if (d === 0) return <span className="text-[10px] text-gray-400">no change</span>;
  const pct = from !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / Math.abs(from)) * 100)}%)` : '';
  return (
    <span className="text-[10px] text-blue-600 whitespace-nowrap">
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

export default function AssessmentTrends({ schema, submissions }) {
  const { submissions: subs, points } = buildAssessmentTrend(schema, submissions);
  if (subs.length < 2) {
    return <p className="text-sm text-gray-500 italic">Trends appear once there are at least two assessments.</p>;
  }
  if (points.length === 0) {
    return <p className="text-sm text-gray-500 italic">This assessment has no numeric answers to trend.</p>;
  }
  return (
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
            return (
              <tr key={p.key}>
                <td className="border border-gray-300 px-3 py-1.5 font-medium text-gray-700 bg-gray-50 sticky left-0">{p.label}</td>
                {p.values.map((v, i) => (
                  <td key={i} className="border border-gray-300 px-3 py-1.5 text-gray-800">
                    <div>{v == null ? '—' : fmt(v)}</div>
                    {i > 0 && v != null && <Delta from={prevValue(p.values, i)} to={v} />}
                  </td>
                ))}
                <td className="border border-gray-300 px-3 py-1.5">
                  {p.values.filter(v => v != null).length >= 2
                    ? <><div className="text-gray-800">{fmt(first)} → {fmt(latest)}</div><Delta from={first} to={latest} /></>
                    : <span className="text-gray-400">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
