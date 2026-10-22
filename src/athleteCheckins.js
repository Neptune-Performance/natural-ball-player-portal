// #462: athletes check in to today's lifts and booked sessions.
//
// On login a player with a workout or a booked lesson today gets the
// CheckinModal: "Doing it" / "Not today" per item, then "Completed" once it's
// done. The answers live in `athlete_checkins` (one row per athlete per item
// per date) — the athlete's own report, separate from the attendance coaches
// mark on slot_reservations. Completion % over the last 30 days sits next to
// the athlete's age on their profile.
//
// Items:
//   workout -> a schedule_events row with event_type='workout' for the athlete
//              directly, or for one of their teams (team rows that belong to a
//              different athlete are excluded, same as #165)
//   session -> a pending/confirmed slot_reservations row. A reservation is ONE
//              occurrence (#455), so slot_date is the date and no series
//              expansion is needed; tombstone joins are skipped like
//              fetchMyScheduleEvents does.

import { supabase } from './supabaseClient';
import { fmtLocalDate } from './scheduleUtils';

export const COMPLETION_WINDOW_DAYS = 30;

const PROMPT_KEY = (userId) => `nbp_checkin_prompted_${userId}`;

// The login popup shows once per day per browser. Storage can throw (private
// mode); then it simply shows again next load.
export function checkinPromptedToday(userId) {
  try { return localStorage.getItem(PROMPT_KEY(userId)) === fmtLocalDate(new Date()); } catch { return false; }
}
export function markCheckinPrompted(userId) {
  try { localStorage.setItem(PROMPT_KEY(userId), fmtLocalDate(new Date())); } catch {}
}

async function teamIdsFor(userId) {
  const { data } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
  return (data || []).map(t => t.team_id);
}

async function fetchWorkouts(userId, startStr, endStr, select) {
  const teamIds = await teamIdsFor(userId);
  const [direct, team] = await Promise.all([
    supabase.from('schedule_events').select(select)
      .eq('event_type', 'workout').eq('player_id', userId)
      .gte('event_date', startStr).lte('event_date', endStr),
    teamIds.length
      ? supabase.from('schedule_events').select(select)
        .eq('event_type', 'workout').overlaps('team_ids', teamIds)
        .or(`player_id.is.null,player_id.eq.${userId}`)
        .gte('event_date', startStr).lte('event_date', endStr)
      : Promise.resolve({ data: [] }),
  ]);
  if (direct.error) console.error('athleteCheckins: workouts query failed:', direct.error);
  if (team.error) console.error('athleteCheckins: team workouts query failed:', team.error);
  const byId = new Map();
  [...(direct.data || []), ...(team.data || [])].forEach(e => byId.set(e.id, e));
  return [...byId.values()];
}

async function fetchSessions(userId, startStr, endStr) {
  const { data, error } = await supabase.from('slot_reservations')
    .select('id, slot_date, status, training_slots(id, notes, start_time, recurrence_parent_id, is_exception)')
    .eq('player_id', userId).in('status', ['pending', 'confirmed'])
    .gte('slot_date', startStr).lte('slot_date', endStr);
  if (error) console.error('athleteCheckins: sessions query failed:', error);
  return (data || []).filter(r => {
    const slot = r.training_slots;
    if (!slot) return false;
    return !(slot.recurrence_parent_id && slot.is_exception !== false);
  });
}

// Today's items for the athlete, each with its check-in row (or null).
export async function fetchTodayCheckinItems(userId) {
  if (!userId) return [];
  const today = fmtLocalDate(new Date());
  const [workouts, sessions, { data: rows }] = await Promise.all([
    fetchWorkouts(userId, today, today, 'id, title, category, event_date, event_time'),
    fetchSessions(userId, today, today),
    supabase.from('athlete_checkins').select('*').eq('user_id', userId).eq('item_date', today),
  ]);
  const rowFor = (type, id) => (rows || []).find(r => r.item_type === type && r.item_id === id) || null;
  const items = [
    ...workouts.map(w => ({
      item_type: 'workout', item_id: w.id, item_date: today,
      title: w.title || 'Workout', detail: w.category ? `${w.category} workout` : 'Workout', time: w.event_time || null,
    })),
    ...sessions.map(r => ({
      item_type: 'session', item_id: r.id, item_date: today,
      title: r.training_slots.notes || 'Training session', detail: r.status === 'pending' ? 'Session (pending)' : 'Session', time: r.training_slots.start_time || null,
    })),
  ].map(it => ({ ...it, checkin: rowFor(it.item_type, it.item_id) }));
  return items.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
}

// Still needs the athlete: unanswered, or "doing" and not yet completed.
export function openCheckinCount(items) {
  return (items || []).filter(it => !it.checkin?.intent || (it.checkin.intent === 'doing' && !it.checkin.completed_at)).length;
}

export async function saveCheckin(userId, item, patch) {
  const row = {
    user_id: userId,
    item_type: item.item_type,
    item_id: item.item_id,
    item_date: item.item_date,
    title: item.title,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  const { data, error } = await supabase.from('athlete_checkins')
    .upsert(row, { onConflict: 'user_id,item_type,item_id,item_date' })
    .select('*').single();
  if (error) throw error;
  return data;
}

// Completed ÷ scheduled over the last 30 days (today included). null when
// nothing was scheduled, so the profile shows nothing rather than "0%".
export async function fetchCompletionRate(userId) {
  if (!userId) return null;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (COMPLETION_WINDOW_DAYS - 1));
  const startStr = fmtLocalDate(start);
  const endStr = fmtLocalDate(end);
  const [workouts, sessions, { data: done, error }] = await Promise.all([
    fetchWorkouts(userId, startStr, endStr, 'id'),
    fetchSessions(userId, startStr, endStr),
    supabase.from('athlete_checkins').select('id')
      .eq('user_id', userId).not('completed_at', 'is', null)
      .gte('item_date', startStr).lte('item_date', endStr),
  ]);
  if (error) { console.error('athleteCheckins: completion query failed:', error); return null; }
  const scheduled = workouts.length + sessions.length;
  if (scheduled === 0) return null;
  const completed = Math.min((done || []).length, scheduled);
  return { completed, scheduled, pct: Math.round((completed / scheduled) * 100) };
}
