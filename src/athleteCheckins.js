// #462 / #484: athletes check in to everything on today's schedule.
//
// On login a player with anything scheduled today gets the CheckinModal:
// "Doing it" / "Not today" per item, then "Completed" once it's done. The
// answers live in `athlete_checkins` (one row per athlete per item per date)
// — the athlete's own report, separate from the attendance coaches mark on
// slot_reservations. Completion % over the last 30 days sits next to the
// athlete's age on their profile.
//
// Four categories (item_type):
//   workout  -> lift: schedule_events event_type='workout'
//   practice -> schedule_events event_type='practice'
//   game     -> schedule_events event_type='game'
//               (all three: for the athlete directly, or for one of their
//               teams via team_ids overlap; team rows that belong to a
//               different athlete are excluded, same as #165)
//   session  -> a pending/confirmed slot_reservations row. A reservation is ONE
//               occurrence (#455), so slot_date is the date and no series
//               expansion is needed; tombstone joins are skipped like
//               fetchMyScheduleEvents does.
//
// #484 backlog: every item since BACKLOG_START counts as scheduled (it enters
// the completion-rate denominator) and nothing is assumed done. The athlete
// works through past days in the "Catch up" list (CheckinCatchUp.js).
//
// Volumes: a heavy athlete has 300+ lifts this year, so every read pages
// through readAllPages (PostgREST clamps silently at 1,000 rows, #437).
//
// facility_events (titled game/scrimmage/practice) are NOT included: they are
// recurring series with per-occurrence exceptions and no per-athlete
// attendance, so they would need the full recurrence expansion here.

import { supabase } from './supabaseClient';
import { fmtLocalDate } from './scheduleUtils';
import { readAllPages } from './readAllPages';

export const COMPLETION_WINDOW_DAYS = 30;
export const BACKLOG_START = '2026-01-01';

export const CHECKIN_CATEGORIES = {
  workout: { label: 'Lift', plural: 'Lifts' },
  practice: { label: 'Practice', plural: 'Practices' },
  game: { label: 'Game', plural: 'Games' },
  session: { label: 'Session', plural: 'Sessions' },
};
const EVENT_TYPES = ['workout', 'practice', 'game'];

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

const EVENT_SELECT = 'id, title, category, event_type, event_date, event_time, opponent';

async function fetchScheduleItems(userId, startStr, endStr) {
  const teamIds = await teamIdsFor(userId);
  const [direct, team] = await Promise.all([
    readAllPages(() => supabase.from('schedule_events').select(EVENT_SELECT)
      .in('event_type', EVENT_TYPES).eq('player_id', userId)
      .gte('event_date', startStr).lte('event_date', endStr)
      .order('event_date').order('id')),
    teamIds.length
      ? readAllPages(() => supabase.from('schedule_events').select(EVENT_SELECT)
        .in('event_type', EVENT_TYPES).overlaps('team_ids', teamIds)
        .or(`player_id.is.null,player_id.eq.${userId}`)
        .gte('event_date', startStr).lte('event_date', endStr)
        .order('event_date').order('id'))
      : Promise.resolve({ rows: [], error: null }),
  ]);
  if (direct.error) console.error('athleteCheckins: schedule query failed:', direct.error);
  if (team.error) console.error('athleteCheckins: team schedule query failed:', team.error);
  const byId = new Map();
  [...direct.rows, ...team.rows].forEach(e => byId.set(e.id, e));
  return [...byId.values()].map(e => {
    const cat = CHECKIN_CATEGORIES[e.event_type].label;
    let title = e.title || cat;
    if (e.event_type === 'game' && !e.title && e.opponent) title = `Game vs ${e.opponent}`;
    return {
      item_type: e.event_type, item_id: e.id, item_date: e.event_date,
      title, detail: e.event_type === 'workout' && e.category ? `${e.category} lift` : cat,
      time: e.event_time || null,
    };
  });
}

async function fetchSessionItems(userId, startStr, endStr) {
  const { rows, error } = await readAllPages(() => supabase.from('slot_reservations')
    .select('id, slot_date, status, training_slots(id, notes, start_time, recurrence_parent_id, is_exception)')
    .eq('player_id', userId).in('status', ['pending', 'confirmed'])
    .gte('slot_date', startStr).lte('slot_date', endStr)
    .order('slot_date').order('id'));
  if (error) console.error('athleteCheckins: sessions query failed:', error);
  return rows.filter(r => {
    const slot = r.training_slots;
    if (!slot) return false;
    return !(slot.recurrence_parent_id && slot.is_exception !== false);
  }).map(r => ({
    item_type: 'session', item_id: r.id, item_date: r.slot_date,
    title: r.training_slots.notes || 'Training session',
    detail: r.status === 'pending' ? 'Session (pending)' : 'Session',
    time: r.training_slots.start_time || null,
  }));
}

async function fetchCheckinRows(userId, startStr, endStr) {
  const { rows, error } = await readAllPages(() => supabase.from('athlete_checkins').select('*')
    .eq('user_id', userId).gte('item_date', startStr).lte('item_date', endStr)
    .order('item_date').order('id'));
  if (error) console.error('athleteCheckins: check-in rows query failed:', error);
  return { rows, error };
}

// item_id is a uuid from schedule_events or slot_reservations, so id + date
// identifies an item even if an event's type was edited after a check-in.
const itemKey = (id, date) => `${id}:${date}`;

const byDateThenTime = (a, b) =>
  a.item_date.localeCompare(b.item_date) || (a.time || '99').localeCompare(b.time || '99');

// Every scheduled item between the two dates, each with its check-in row (or
// null), oldest first.
async function fetchItemsWithCheckins(userId, startStr, endStr) {
  const [events, sessions, { rows, error }] = await Promise.all([
    fetchScheduleItems(userId, startStr, endStr),
    fetchSessionItems(userId, startStr, endStr),
    fetchCheckinRows(userId, startStr, endStr),
  ]);
  const rowByKey = new Map(rows.map(r => [itemKey(r.item_id, r.item_date), r]));
  const items = [...events, ...sessions]
    .map(it => ({ ...it, checkin: rowByKey.get(itemKey(it.item_id, it.item_date)) || null }))
    .sort(byDateThenTime);
  return { items, error };
}

// Today's items for the athlete, each with its check-in row (or null).
export async function fetchTodayCheckinItems(userId) {
  if (!userId) return [];
  const today = fmtLocalDate(new Date());
  const { items } = await fetchItemsWithCheckins(userId, today, today);
  return items;
}

// #484: past items (BACKLOG_START .. yesterday) for the catch-up list.
export async function fetchCatchUpItems(userId) {
  if (!userId) return [];
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = fmtLocalDate(y);
  if (yesterday < BACKLOG_START) return [];
  const { items } = await fetchItemsWithCheckins(userId, BACKLOG_START, yesterday);
  return items;
}

// Still needs the athlete: unanswered, or "doing" and not yet completed.
export function openCheckinCount(items) {
  return (items || []).filter(it => !it.checkin?.intent || (it.checkin.intent === 'doing' && !it.checkin.completed_at)).length;
}

// A past item still waiting for the athlete: not completed and not marked missed.
export function needsCatchUp(item) {
  return !item.checkin?.completed_at && item.checkin?.intent !== 'skipping';
}

const checkinRow = (userId, item, patch) => ({
  user_id: userId,
  item_type: item.item_type,
  item_id: item.item_id,
  item_date: item.item_date,
  title: item.title,
  updated_at: new Date().toISOString(),
  ...patch,
});

export async function saveCheckin(userId, item, patch) {
  const { data, error } = await supabase.from('athlete_checkins')
    .upsert(checkinRow(userId, item, patch), { onConflict: 'user_id,item_type,item_id,item_date' })
    .select('*').single();
  if (error) throw error;
  return data;
}

// One upsert for several items (the catch-up "mark this day completed").
export async function saveCheckins(userId, items, patch) {
  if (!items?.length) return [];
  const { data, error } = await supabase.from('athlete_checkins')
    .upsert(items.map(it => checkinRow(userId, it, patch)), { onConflict: 'user_id,item_type,item_id,item_date' })
    .select('*');
  if (error) throw error;
  return data || [];
}

// Completed ÷ scheduled over the last 30 days (today included), across lifts,
// practices, games and sessions. Only check-ins that match a still-scheduled
// item count. null when nothing was scheduled, so the profile shows nothing
// rather than "0%".
export async function fetchCompletionRate(userId) {
  if (!userId) return null;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (COMPLETION_WINDOW_DAYS - 1));
  const { items, error } = await fetchItemsWithCheckins(userId, fmtLocalDate(start), fmtLocalDate(end));
  if (error) return null;
  const scheduled = items.length;
  if (scheduled === 0) return null;
  const completed = items.filter(it => it.checkin?.completed_at).length;
  const byType = {};
  items.forEach(it => {
    const t = byType[it.item_type] || (byType[it.item_type] = { scheduled: 0, completed: 0 });
    t.scheduled += 1;
    if (it.checkin?.completed_at) t.completed += 1;
  });
  return { completed, scheduled, pct: Math.round((completed / scheduled) * 100), byType };
}
