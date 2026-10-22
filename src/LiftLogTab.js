// #460: Records → Lift Log on the player profile. Every movement the athlete
// has logged a weight for (from WorkoutDetailModal on the calendar), grouped
// by normalised exercise name so the same lift is followed across programs
// and templates: latest, best, change since the first entry, a trend line and
// the full history. Read-only here; entries are made and edited inside the
// workout. RLS on exercise_logs: the athlete reads their own, staff read all.

import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { Search, ChevronDown, ChevronRight, Dumbbell, TrendingUp, TrendingDown } from 'lucide-react';
import { readAllPages } from './readAllPages';
import { formatWeight } from './exerciseLogs';

const when = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function Sparkline({ points }) {
  if (points.length < 2) return null;
  const W = 120, H = 32, P = 3;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [
    P + (i * (W - 2 * P)) / (points.length - 1),
    H - P - ((v - min) * (H - 2 * P)) / span,
  ]);
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0" aria-hidden="true">
      <polyline points={xy.map(p => p.join(',')).join(' ')} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.5" fill="#2563eb" />
    </svg>
  );
}

export default function LiftLogTab({ userId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { rows: data, error: err } = await readAllPages(() =>
        supabase
          .from('exercise_logs')
          .select('id, exercise_name, name_key, event_date, weight, unit, reps_done')
          .eq('player_id', userId)
          .order('event_date', { ascending: true })
          .order('id'));
      if (cancelled) return;
      if (err) { console.error('Error loading lift log:', err); setError(err); }
      setRows(data);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const movements = useMemo(() => {
    const byKey = {};
    rows.forEach((r) => {
      (byKey[r.name_key] = byKey[r.name_key] || []).push(r);
    });
    return Object.entries(byKey).map(([key, entries]) => {
      const first = entries[0];
      const latest = entries[entries.length - 1];
      const best = entries.reduce((b, r) => (Number(r.weight) > Number(b.weight) ? r : b), first);
      return {
        key,
        name: latest.exercise_name,
        entries,
        first,
        latest,
        best,
        change: Number(latest.weight) - Number(first.weight),
      };
    }).sort((a, b) => b.latest.event_date.localeCompare(a.latest.event_date) || a.name.localeCompare(b.name));
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? movements.filter(m => m.name.toLowerCase().includes(q)) : movements;
  }, [movements, search]);

  if (loading) return <div className="text-center py-10 text-gray-500 text-sm">Loading lift log…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Lift Log</h3>
          <p className="text-sm text-gray-500">Weights logged in scheduled workouts. Open a workout on the calendar to add or change an entry.</p>
        </div>
        {movements.length > 0 && (
          <div className="relative sm:w-64">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search movements"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </div>

      {error && <div className="text-sm text-red-600">Some entries could not be loaded.</div>}

      {movements.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-lg">
          <Dumbbell size={28} className="mx-auto text-gray-300 mb-2" />
          <div className="text-sm text-gray-500">No weights logged yet.</div>
          <div className="text-xs text-gray-400 mt-1">Open a workout on the calendar and fill in "Weight used" for each movement.</div>
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">No movements match "{search}".</div>
      ) : (
        <div className="space-y-2">
          {visible.map((m) => {
            const open = expanded === m.key;
            return (
              <div key={m.key} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : m.key)}
                  className="w-full text-left p-3 flex items-center gap-3 hover:bg-gray-50"
                >
                  {open ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 break-words">{m.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>Latest <span className="font-medium text-gray-800 tabular-nums">{formatWeight(m.latest)}</span> · {when(m.latest.event_date)}</span>
                      <span>Best <span className="font-medium text-gray-800 tabular-nums">{formatWeight(m.best)}</span></span>
                      <span>{m.entries.length} {m.entries.length === 1 ? 'entry' : 'entries'}</span>
                    </div>
                  </div>
                  {m.entries.length > 1 && m.change !== 0 && (
                    <span className={`hidden sm:inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${m.change > 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {m.change > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {m.change > 0 ? '+' : ''}{Math.round(m.change * 100) / 100} {m.latest.unit || 'lb'}
                    </span>
                  )}
                  <Sparkline points={m.entries.map(e => Number(e.weight))} />
                </button>
                {open && (
                  <div className="border-t border-gray-100 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Weight</th>
                          <th className="px-3 py-2">Reps</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...m.entries].reverse().map((e) => (
                          <tr key={e.id} className="border-t border-gray-100">
                            <td className="px-3 py-2 text-gray-700">{when(e.event_date)}</td>
                            <td className="px-3 py-2 text-gray-900 tabular-nums">
                              {formatWeight(e)}
                              {e.id === m.best.id && m.entries.length > 1 && <span className="ml-2 text-[10px] font-bold uppercase text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Best</span>}
                            </td>
                            <td className="px-3 py-2 text-gray-700">{e.reps_done || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
