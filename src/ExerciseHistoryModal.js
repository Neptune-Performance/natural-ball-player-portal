// #461: tap a movement in a workout to see every weight the athlete has
// logged for it (exercise_logs, matched by normalised name across programs and
// templates, same as the profile Lift Log): latest, best, change since the
// first entry, a trend chart and the full list, newest first. Read-only;
// entries are made in the workout's "Weight used" box.

import React, { useState, useEffect } from 'react';
import { X, TrendingUp, TrendingDown, History } from 'lucide-react';
import { fetchMovementHistory, formatWeight } from './exerciseLogs';
import { formatUserError } from './errorMessage';

const when = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function TrendChart({ entries }) {
  if (entries.length < 2) return null;
  const W = 440, H = 140, PX = 36, PY = 14;
  const values = entries.map(e => Number(e.weight));
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const xy = values.map((v, i) => [
    PX + (i * (W - PX - 10)) / (values.length - 1),
    H - PY - ((v - min) * (H - 2 * PY)) / span,
  ]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-36" role="img" aria-label="Weight trend">
      <text x="4" y={PY + 4} className="fill-gray-400" fontSize="10">{max}</text>
      <text x="4" y={H - PY + 4} className="fill-gray-400" fontSize="10">{min}</text>
      <line x1={PX} y1={H - PY} x2={W - 10} y2={H - PY} stroke="#e5e7eb" />
      <polyline points={xy.map(p => p.join(',')).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="3" fill="#2563eb">
          <title>{`${when(entries[i].event_date)}: ${formatWeight(entries[i])}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default function ExerciseHistoryModal({ playerId, exerciseName, onClose }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchMovementHistory(playerId, exerciseName)
      .then(rows => { if (!cancelled) setEntries(rows); })
      .catch(err => { if (!cancelled) setError(formatUserError(err)); });
    return () => { cancelled = true; };
  }, [playerId, exerciseName]);

  const latest = entries?.length ? entries[entries.length - 1] : null;
  const first = entries?.length ? entries[0] : null;
  const best = entries?.length ? entries.reduce((b, e) => (Number(e.weight) > Number(b.weight) ? e : b)) : null;
  const change = latest && first ? Math.round((Number(latest.weight) - Number(first.weight)) * 100) / 100 : 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500 flex items-center gap-1"><History size={12} /> History</div>
            <h3 className="text-lg font-semibold text-gray-900 break-words">{exerciseName}</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-500" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">
          {error && <div className="text-sm text-red-600">{error}</div>}
          {!error && entries === null && <div className="text-sm text-gray-500">Loading…</div>}
          {entries && entries.length === 0 && (
            <div className="text-sm text-gray-500">No weights logged for this movement yet. Enter the weight you use in the workout and it will show up here.</div>
          )}
          {entries && entries.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="rounded-md bg-gray-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">Latest</div>
                  <div className="font-semibold tabular-nums">{formatWeight(latest)}</div>
                </div>
                <div className="rounded-md bg-gray-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">Best</div>
                  <div className="font-semibold tabular-nums">{formatWeight(best)}</div>
                </div>
                <div className="rounded-md bg-gray-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">Since first</div>
                  <div className={`font-semibold tabular-nums flex items-center gap-1 ${change > 0 ? 'text-green-600' : change < 0 ? 'text-red-600' : 'text-gray-700'}`}>
                    {change > 0 ? <TrendingUp size={14} /> : change < 0 ? <TrendingDown size={14} /> : null}
                    {change > 0 ? '+' : ''}{change} {latest.unit || 'lb'}
                  </div>
                </div>
              </div>
              <TrendChart entries={entries} />
              <table className="w-full text-sm mt-2">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1">Date</th><th className="py-1">Weight</th><th className="py-1">Reps</th>
                  </tr>
                </thead>
                <tbody>
                  {[...entries].reverse().map(e => (
                    <tr key={e.id} className="border-t border-gray-100">
                      <td className="py-1.5 text-gray-700">{when(e.event_date)}</td>
                      <td className="py-1.5 font-medium tabular-nums">{formatWeight(e)}</td>
                      <td className="py-1.5 text-gray-600">{e.reps_done || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
