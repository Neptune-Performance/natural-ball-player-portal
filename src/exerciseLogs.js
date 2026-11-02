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

// #461: every entry for one movement, oldest first, for the in-workout history.
export async function fetchMovementHistory(playerId, exerciseName) {
  const { data, error } = await supabase
    .from('exercise_logs')
    .select('id, weight, unit, reps_done, event_date, created_at')
    .eq('player_id', playerId)
    .eq('name_key', exerciseNameKey(exerciseName))
    .order('event_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return data || [];
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

// Template workouts carry their exercises in schedule_events.notes, pipe-delimited
// under "--- Exercises ---" (see CLAUDE.md, workout_templates).
export function parseExerciseNotes(notes) {
  if (!notes) return { general: '', exercises: [] };
  const delimiter = '--- Exercises ---';
  const idx = notes.indexOf(delimiter);
  if (idx === -1) return { general: notes.trim(), exercises: [] };
  const general = notes.slice(0, idx).trim();
  const exerciseBlock = notes.slice(idx + delimiter.length).trim();
  const exercises = exerciseBlock.split('\n').filter(Boolean).map(line => {
    if (line.includes('|')) {
      // New pipe-delimited format: Name | 3x10 | rest | load | link
      const parts = line.split('|').map(s => s.trim());
      const name = parts[0] || '';
      let sets = '', reps = '', rest = '', load = '', link = '';
      if (parts[1]) {
        const match = parts[1].match(/(\d+)\s*x\s*(\d+)/i);
        if (match) { sets = match[1]; reps = match[2]; } else { sets = parts[1]; }
      }
      if (parts[2]) rest = parts[2];
      if (parts[3]) load = parts[3];
      if (parts[4]) link = parts[4];
      return { name, sets, reps, rest, load, link };
    } else {
      // Legacy format: Name - 3 sets x 10 reps (link) — reps may be a range like 12-15
      const name = line.replace(/ - \d.*$/, '').replace(/ \(https?:.*$/, '').trim();
      let sets = '', reps = '', link = '';
      const srMatch = line.match(/(\d+)\s*sets?\s*x\s*(\d+(?:\s*-\s*\d+)?)\s*reps?/i);
      if (srMatch) { sets = srMatch[1]; reps = srMatch[2].replace(/\s+/g, ''); }
      const linkMatch = line.match(/\((https?:\/\/[^\s)]+)\)/);
      if (linkMatch) link = linkMatch[1];
      return { name, sets, reps, rest: '', load: '', link };
    }
  }).filter(e => e.name);
  return { general, exercises };
}

// The exercises a workout shows, with the ids exercise_logs keys on: program
// workouts read training_exercises; template workouts (or a program day with
// no exercises) fall back to the parsed notes, keyed "n-<index>".
export async function loadWorkoutExercises(event) {
  let day = null;
  let generalNotes = '';
  let exercises = [];
  if (event.training_day_id) {
    const [{ data: dayRow }, { data: ex }] = await Promise.all([
      supabase
        .from('training_days')
        .select('id, day_number, title, notes, program_id, training_programs(id, name, description)')
        .eq('id', event.training_day_id)
        .single(),
      supabase
        .from('training_exercises')
        .select('id, day_id, category, name, description, sets, reps, weight, video_url, image_url, sort_order, rest, load, super_set')
        .eq('day_id', event.training_day_id)
        .order('sort_order', { ascending: true }),
    ]);
    day = dayRow || null;
    if (day?.notes) generalNotes = day.notes;
    exercises = ex || [];
  }
  if (exercises.length === 0 && event.notes) {
    const parsed = parseExerciseNotes(event.notes);
    if (parsed.general) generalNotes = parsed.general;
    exercises = (parsed.exercises || []).map((e, i) => ({
      id: `n-${i}`,
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      rest: e.rest,
      load: e.load,
      video_url: e.link,
      category: 'general',
    }));
  }
  return { exercises, day, generalNotes };
}

// What a weight box's blur does: validate, then save, or delete when cleared.
// Returns the saved row, or null when the entry was removed.
export async function commitExerciseLog({ event, playerId, exercise, weightText, repsText, existing, createdBy }) {
  const weight = parseWeight(weightText);
  if (Number.isNaN(weight)) throw new Error(`Enter a weight in lb, from 0 to ${MAX_WEIGHT - 1}.`);
  if (weight === null) {
    if (existing) await deleteExerciseLog(existing.id);
    return null;
  }
  return saveExerciseLog({ event, playerId, exercise, weight, repsDone: repsText, createdBy });
}
