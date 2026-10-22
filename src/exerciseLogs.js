// #460: the weight an athlete used for each movement in a scheduled workout.
//
// One `exercise_logs` row per athlete per schedule_events row per exercise.
// `exercise_key` is the training_exercises.id for program workouts, or the
// "n-<index>" id WorkoutDetailModal gives exercises parsed out of a template
// workout's notes. `name_key` is the normalised exercise name, so the profile
// Lift Log (LiftLogTab.js) can follow one movement across every program and
// template it shows up in.

import { supabase } from './supabaseClient';
import { normalizeExerciseName } from './exerciseVideoMatch';
import { fmtLocalDate } from './scheduleUtils';

export const MAX_WEIGHT = 2000; // mirrors the CHECK on exercise_logs.weight

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function exerciseNameKey(name) {
  return normalizeExerciseName(name) || String(name || '').trim().toLowerCase();
}

// Who the weights in this workout belong to: the athlete an individual
// workout was scheduled for, or the viewing player on a team workout. Staff
// opening a team workout have no single athlete to log for, so null.
export function logOwnerForEvent(event, userId, userRole) {
  if (event?.player_id) return event.player_id;
  if (userRole === 'player') return userId || null;
  return null;
}

// Logging is open from the day of the workout onwards, never ahead of it, and
// only on real schedule_events rows (the FK needs a uuid).
export function canLogWorkout(event) {
  if (!event?.id || !UUID_RE.test(String(event.id))) return false;
  return !!event.event_date && event.event_date <= fmtLocalDate(new Date());
}

// '' → null (clear the entry); anything else must be a number in range.
export function parseWeight(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n >= MAX_WEIGHT) return NaN;
  return Math.round(n * 100) / 100;
}

export function formatWeight(row) {
  if (!row) return '';
  return `${Number(row.weight)} ${row.unit || 'lb'}`;
}

export async function fetchWorkoutLogs(eventId, playerId) {
  const { data, error } = await supabase
    .from('exercise_logs')
    .select('*')
    .eq('schedule_event_id', eventId)
    .eq('player_id', playerId);
  if (error) throw error;
  const byKey = {};
  (data || []).forEach((r) => { byKey[r.exercise_key] = r; });
  return byKey;
}

// The most recent earlier entry for each movement, for the "Last time" hint.
export async function fetchLastLogs(playerId, nameKeys, onOrBefore, excludeEventId) {
  const keys = [...new Set(nameKeys.filter(Boolean))];
  if (keys.length === 0) return {};
  let q = supabase
    .from('exercise_logs')
    .select('name_key, weight, unit, reps_done, event_date, schedule_event_id')
    .eq('player_id', playerId)
    .in('name_key', keys)
    .lte('event_date', onOrBefore)
    .order('event_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);
  if (excludeEventId) q = q.neq('schedule_event_id', excludeEventId);
  const { data, error } = await q;
  if (error) throw error;
  const byName = {};
  (data || []).forEach((r) => { if (!byName[r.name_key]) byName[r.name_key] = r; });
  return byName;
}

export async function saveExerciseLog({ event, playerId, exercise, weight, repsDone, createdBy }) {
  const { data, error } = await supabase
    .from('exercise_logs')
    .upsert({
      player_id: playerId,
      schedule_event_id: event.id,
      exercise_key: String(exercise.id),
      exercise_name: exercise.name || 'Exercise',
      name_key: exerciseNameKey(exercise.name),
      event_date: event.event_date,
      weight,
      unit: 'lb',
      reps_done: repsDone?.trim() || null,
      created_by: createdBy || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'schedule_event_id,player_id,exercise_key' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteExerciseLog(id) {
  const { error } = await supabase.from('exercise_logs').delete().eq('id', id);
  if (error) throw error;
}
