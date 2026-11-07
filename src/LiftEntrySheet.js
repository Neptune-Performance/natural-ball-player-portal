// #475: Coach Tools → Lift Entry. Strength coaches enter weight + reps for
// athletes during a group lift, so youth athletes don't need a phone on the
// floor. Pick a day (today or earlier — same rule as the athlete's own
// logging) and a team; every athlete with a workout that day is listed, and
// expanding one shows their workout with the usual save-on-blur boxes.

import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { fmtLocalDate } from './scheduleUtils';
import { Search, ChevronDown, ChevronRight, Dumbbell, ExternalLink } from 'lucide-react';
import WorkoutLogPanel from './WorkoutLogPanel';

export default function LiftEntrySheet({ players, userId, onNavigateToProfile }) {
  const today = fmtLocalDate(new Date());
  const [date, setDate] = useState(today);
  const [teamFilter, setTeamFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [workouts, setWorkouts] = useState([]);
  const [logCounts, setLogCounts] = useState({}); // schedule_event_id → entries
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null); // player id

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setExpanded(null);
      // A day is ~270 workouts facility-wide, so page past the 1,000 clamp (#437)
      // rather than .in() a roster that can run to hundreds of ids.
      const [ev, logs] = await Promise.all([
        readAllPages(() => supabase
          .from('schedule_events')
          .select('id, title, event_date, event_time, player_id, training_day_id, notes')
          .eq('event_type', 'workout')
          .eq('event_date', date)
          .not('player_id', 'is', null)
          .order('event_time', { ascending: true, nullsFirst: false })
          .order('id')),
        readAllPages(() => supabase
          .from('exercise_logs')
          .select('id, schedule_event_id')
          .eq('event_date', date)
          .order('id')),
      ]);
      if (cancelled) return;
      if (ev.error || logs.error) {
        console.error('Error loading lift entry:', ev.error || logs.error);
        setError('Could not load workouts for this day.');
      }
      const counts = {};
      (logs.rows || []).forEach(r => { if (r.schedule_event_id) counts[r.schedule_event_id] = (counts[r.schedule_event_id] || 0) + 1; });
      setWorkouts(ev.rows || []);
      setLogCounts(counts);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [date]);

  const playerById = useMemo(() => Object.fromEntries((players || []).map(p => [p.id, p])), [players]);
  const teamNames = useMemo(() => Array.from(new Set((players || []).flatMap(p => (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean)))).sort(), [players]);

  const athletes = useMemo(() => {
    const byPlayer = {};
    workouts.forEach(w => {
      const p = playerById[w.player_id];
      if (!p) return; // staff accounts' own workouts
      (byPlayer[w.player_id] = byPlayer[w.player_id] || { player: p, workouts: [] }).workouts.push(w);
    });
    const q = search.trim().toLowerCase();
    return Object.values(byPlayer)
      .filter(a => teamFilter === 'all' || (a.player.team_members || []).some(tm => tm.teams?.name === teamFilter))
      .filter(a => !q || (a.player.full_name || '').toLowerCase().includes(q))
      .sort((a, b) => (a.player.full_name || '').localeCompare(b.player.full_name || ''));
  }, [workouts, playerById, teamFilter, search]);

  const bumpCount = (eventId, delta) => {
    if (!delta) return;
    setLogCounts(prev => ({ ...prev, [eventId]: Math.max(0, (prev[eventId] || 0) + delta) }));
  };

  const dayLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Lift Entry</h3>
        <p className="text-sm text-gray-600 mt-0.5">
          Enter the weight and reps for athletes during a lift. Entries land in the athlete's Lift Log exactly as if they had typed them.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => { if (e.target.value && e.target.value <= today) setDate(e.target.value); }}
          aria-label="Workout date"
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          aria-label="Team"
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All teams</option>
          {teamNames.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search athlete..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      {loading ? (
        <div className="text-center py-10 text-gray-500 text-sm">Loading workouts…</div>
      ) : athletes.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-gray-300 rounded-lg">
          <Dumbbell size={28} className="mx-auto text-gray-300 mb-2" />
          <div className="text-sm text-gray-500">No athletes{teamFilter !== 'all' ? ` on ${teamFilter}` : ''} have a workout on {dayLabel}.</div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-gray-500">{athletes.length} athlete{athletes.length === 1 ? '' : 's'} with a workout on {dayLabel}</div>
          {athletes.map(({ player, workouts: ws }) => {
            const open = expanded === player.id;
            const logged = ws.reduce((n, w) => n + (logCounts[w.id] || 0), 0);
            return (
              <div key={player.id} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : player.id)}
                  className="w-full text-left p-3 flex items-center gap-3 hover:bg-gray-50"
                >
                  {open ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 break-words">{player.full_name}</div>
                    <div className="text-xs text-gray-500 mt-0.5 break-words">{ws.map(w => w.title || 'Workout').join(' · ')}</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${logged > 0 ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {logged > 0 ? `${logged} logged` : 'Nothing logged'}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-gray-100 px-3 pb-3">
                    {ws.map(w => (
                      <div key={w.id} className="pt-3">
                        {ws.length > 1 && <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{w.title || 'Workout'}</div>}
                        <WorkoutLogPanel
                          event={w}
                          playerId={player.id}
                          userId={userId}
                          onLogsChange={(delta) => bumpCount(w.id, delta)}
                        />
                      </div>
                    ))}
                    {onNavigateToProfile && (
                      <button type="button" onClick={() => onNavigateToProfile(player.id)} className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                        <ExternalLink size={12} /> Open profile
                      </button>
                    )}
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
