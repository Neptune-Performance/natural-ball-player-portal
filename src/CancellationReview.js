// #306: the staff side of "who decides a cancellation was sick".
//
// Cordell: "Who decides a cancellation was 'sick'? ... Admins and coaches only
// choose if a cancellation was sick." The athlete's own sick/injured button is
// gone (Schedule.js), so every athlete cancellation now lands here as
// 'athlete_cancelled' — counted against them — until a staff member says
// otherwise.
//
// Two actions per row, and both are always offered so the undo is the same
// control as the do:
//   Sick / injured        -> cancel_reason = 'sick', the session goes back
//   Counts against them   -> cancel_reason = 'athlete_cancelled', the session
//                            is deducted
//
// This is staff-only and is never rendered anywhere an athlete can reach: it
// hangs off the Store area in the Work Portal, which is admin + coach.
//
// WHO CAN ACT ON WHAT. slot_reservations' UPDATE policy (20260713_slot_
// attendance.sql) allows the athlete, the slot's own coach, and admin — it has
// never allowed any coach to edit any coach's reservations. Rather than widen
// that policy (a migration nobody has asked for, on the table that holds every
// booking), a coach's list is filtered to their own sessions and says so.
// Admins see everything. If a write is refused anyway, the row says so out
// loud instead of pretending.

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { Loader2, HeartPulse, Undo2, AlertTriangle, RefreshCw } from 'lucide-react';
import { formatUserError } from './errorMessage';
import { applySessionUsage, USAGE_OUTCOME } from './sessionUsage';
import { CANCEL_REASON_ATHLETE, CANCEL_REASON_SICK, CANCEL_REASON_EARLY, isSickCancel, isFreeCancel, cancelDecisionLabel } from './cancelReasons';

const WINDOW_OPTIONS = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last year' },
];

const FILTERS = [
  { key: 'review', label: 'Needs a decision' },
  { key: 'sick', label: 'Marked sick' },
  { key: 'early', label: "5+ days' notice" },
  { key: 'all', label: 'All' },
];

const ROW_LIMIT = 200;

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  const hr = parseInt(h, 10);
  if (Number.isNaN(hr)) return '';
  return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CancellationReview({ userId, userRole }) {
  const isAdmin = userRole === 'admin';
  const [rows, setRows] = useState([]);
  const [usageByRes, setUsageByRes] = useState({});
  const [coachNames, setCoachNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [windowDays, setWindowDays] = useState(90);
  const [filter, setFilter] = useState('review');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null);

  // Every read surfaces its error. "No cancellations" must never be what a
  // failed query looks like — on this screen that would read as "nobody has
  // cancelled", which is the most reassuring possible way to be wrong.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setNote(null);
    try {
      let q = supabase
        .from('slot_reservations')
        .select('id, slot_id, slot_date, player_id, cancelled_at, cancel_reason, cancel_reason_at, cancel_reason_by, users:player_id(full_name, email), training_slots!inner(id, title, start_time, duration_minutes, coach_id)')
        .eq('status', 'cancelled')
        .gte('slot_date', isoDaysAgo(windowDays))
        .order('slot_date', { ascending: false })
        .limit(ROW_LIMIT);
      // A coach can only update reservations on their own slots, so showing
      // them everyone else's would be a wall of buttons that silently do
      // nothing.
      if (!isAdmin) q = q.eq('training_slots.coach_id', userId);
      const { data, error } = await q;
      if (error) throw error;
      const list = data || [];
      setRows(list);

      // Which of these actually had a session deducted. Without this the
      // buttons would be guessing, and "give the session back" would claim to
      // have done something when there was nothing to give.
      const ids = list.map(r => r.id);
      const usage = {};
      if (ids.length > 0) {
        const { data: used, error: usedErr } = await supabase
          .from('store_session_usage')
          .select('id, source_id')
          .eq('source_type', 'training_slot')
          .in('source_id', ids);
        if (usedErr) throw usedErr;
        (used || []).forEach(u => { usage[u.source_id] = true; });
      }
      setUsageByRes(usage);

      const coachIds = [...new Set(list.map(r => r.training_slots?.coach_id).filter(Boolean))];
      if (coachIds.length > 0) {
        const { data: coaches, error: coachErr } = await supabase
          .from('users').select('id, full_name').in('id', coachIds);
        if (coachErr) throw coachErr;
        const map = {};
        (coaches || []).forEach(c => { map[c.id] = c.full_name; });
        setCoachNames(map);
      } else {
        setCoachNames({});
      }
    } catch (e) {
      // The three cancel_reason columns ship in
      // supabase/migrations/20260812_slot_reservations_cancel_reason.sql. If
      // that has not been run this screen cannot work at all, and saying which
      // migration is missing beats a raw PostgREST message.
      const raw = String(e?.message || '');
      setLoadError(
        /cancel_reason/i.test(raw)
          ? 'This screen needs the cancel_reason columns on slot_reservations, and they are not there yet. The migration supabase/migrations/20260812_slot_reservations_cancel_reason.sql has to be run first.'
          : `Cancellations could not be loaded. ${formatUserError(e)}`
      );
      setRows([]);
      setUsageByRes({});
    } finally {
      setLoading(false);
    }
  }, [isAdmin, userId, windowDays]);

  useEffect(() => { load(); }, [load]);

  // One decision = one reason write + one package write, and BOTH are judged on
  // rows affected. A refused update comes back from PostgREST as 200 with an
  // empty body, so an unchecked result here would report "session returned" on
  // a row where nothing moved.
  const decide = async (row, sick) => {
    setBusyId(row.id);
    setNote(null);
    const who = row.users?.full_name || 'This athlete';
    try {
      const now = new Date().toISOString();
      const { data: updated, error } = await supabase
        .from('slot_reservations')
        .update({
          cancel_reason: sick ? CANCEL_REASON_SICK : CANCEL_REASON_ATHLETE,
          cancel_reason_by: userId,
          cancel_reason_at: now,
        })
        .eq('id', row.id)
        .select('id, cancel_reason, cancel_reason_at, cancel_reason_by');
      if (error) {
        setNote({ kind: 'error', text: `Nothing was saved. ${formatUserError(error)}` });
        return;
      }
      if (!updated || updated.length === 0) {
        setNote({
          kind: 'error',
          text: `Nothing was saved — the change was refused (zero rows). A coach can only change cancellations on their own sessions; an admin can change any of them.`,
        });
        return;
      }

      // Only now touch the package. If this half fails the decision still
      // stands and the message says exactly which half went wrong, because
      // "it half worked" is information somebody needs to fix it by hand.
      const usage = await applySessionUsage({
        reservationId: row.id,
        playerId: row.player_id,
        usedOn: row.slot_date,
        consume: !sick,
        actorId: userId,
        note: sick ? 'Sick / injured cancellation' : 'Cancelled session — counted against package',
      });

      setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...updated[0] } : r)));
      setUsageByRes(prev => {
        const next = { ...prev };
        if (usage.ok) {
          if (sick) delete next[row.id];
          else if (usage.outcome === USAGE_OUTCOME.CONSUMED || usage.outcome === USAGE_OUTCOME.ALREADY) next[row.id] = true;
        }
        return next;
      });

      const headline = sick
        ? `${who}'s cancellation is marked sick / injured.`
        : `${who}'s cancellation now counts against them.`;
      setNote({ kind: usage.ok ? 'ok' : 'error', text: `${headline} ${usage.message}` });
    } finally {
      setBusyId(null);
    }
  };

  const visible = rows.filter(r => {
    if (filter === 'sick' && !isSickCancel(r.cancel_reason)) return false;
    if (filter === 'early' && r.cancel_reason !== CANCEL_REASON_EARLY) return false;
    // #477: a 5+ days' notice cancel is free by rule, so it never needs a decision.
    if (filter === 'review' && isFreeCancel(r.cancel_reason)) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (r.users?.full_name || '').toLowerCase().includes(q)
      || (r.users?.email || '').toLowerCase().includes(q)
      || (r.training_slots?.title || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-700">
        <p>
          Cancelling a session uses it up, unless the athlete cancelled it themselves with {"5+ days'"} notice — those are free
          and never need a decision. Marking one <span className="font-medium">sick / injured</span> puts the session
          back into the athlete's package. This is the only place that decision is made — athletes cannot make it for themselves.
        </p>
        <p className="text-xs text-gray-600 mt-2">
          Nothing here happens on its own. An athlete's browser is not allowed to change their own package, so the session is
          only actually deducted when someone presses <span className="font-medium">Counts against them</span>. Each row shows
          whether a session has been deducted yet.
        </p>
        {!isAdmin && (
          <p className="text-xs text-gray-500 mt-2">
            You are seeing cancellations on your own sessions. An admin can review every coach's.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                filter === f.key ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-gray-700"
        >
          {WINDOW_OPTIONS.map(o => <option key={o.days} value={o.days}>{o.label}</option>)}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search athlete or session…"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-gray-700 flex-1 min-w-[180px]"
        />
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:text-indigo-800 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {note && (
        <div className={`rounded-lg p-3 text-sm border ${
          note.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          {note.text}
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : loadError ? null : visible.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          {rows.length === 0
            ? 'No cancelled sessions in this window.'
            : 'No cancellations match this filter.'}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {visible.map(r => {
            const sick = isSickCancel(r.cancel_reason);
            const free = isFreeCancel(r.cancel_reason);
            const deducted = !!usageByRes[r.id];
            const busy = busyId === r.id;
            return (
              <div key={r.id} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {r.users?.full_name || 'Unknown athlete'}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {formatDate(r.slot_date)}
                    {r.training_slots?.start_time ? ` · ${formatTime(r.training_slots.start_time)}` : ''}
                    {r.training_slots?.title ? ` · ${r.training_slots.title}` : ''}
                    {coachNames[r.training_slots?.coach_id] ? ` · ${coachNames[r.training_slots.coach_id]}` : ''}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Cancelled {r.cancelled_at ? new Date(r.cancelled_at).toLocaleString() : 'at an unrecorded time'}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                      free ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-600 border-gray-200'
                    }`}>
                      {cancelDecisionLabel(r.cancel_reason)}
                    </span>
                    {/* The ledger, not the label. These two can disagree — a
                        package with no session count has nothing to move — and
                        hiding that would make the buttons look broken. */}
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-white text-gray-500 border-gray-200">
                      {deducted ? 'A session is deducted' : 'No session deducted'}
                    </span>
                  </div>
                </div>
                {/* A button is disabled only when the label AND the ledger
                    already say what it would do. That is what makes "Counts
                    against them" both the undo for a mis-marked sick cancel
                    and the way to actually deduct a session an athlete
                    cancelled — nothing deducts it automatically, because an
                    athlete's own browser is not allowed to write the package
                    ledger. It also means a half-applied write can simply be
                    pressed again. */}
                <div className="flex flex-shrink-0 gap-2">
                  <button
                    onClick={() => decide(r, true)}
                    disabled={busy || (sick && !deducted)}
                    title={sick && !deducted ? 'Already marked sick / injured, with no session deducted' : "Give this session back to the athlete's package"}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-green-300 text-green-700 hover:bg-green-50 transition disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <HeartPulse size={12} />}
                    Sick / injured
                  </button>
                  <button
                    onClick={() => decide(r, false)}
                    disabled={busy || (!free && deducted)}
                    title={free ? 'Undo — put this back to counting against the athlete' : 'Deduct the session for this cancellation'}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 transition disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                    Counts against them
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && !loadError && rows.length >= ROW_LIMIT && (
        <p className="text-xs text-gray-500">
          Showing the {ROW_LIMIT} most recent cancellations in this window. Narrow the window to see older ones.
        </p>
      )}
    </div>
  );
}
