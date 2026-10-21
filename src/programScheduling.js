// #439: put a training program's days on athletes' calendars.
//
// Before this, every generator (S&C, Throwing, Hitting, Auto-Program) saved a
// program to the library and wrote a training_program_assignments row, but
// NOTHING reached schedule_events — the coach still had to open Coach Tools
// and run "Assign" with an end date, or drag the program onto the calendar.
// Cordell: "all coaches don't have to add multiple steps to get the program
// into the players schedule". This is the one shared writer; the generators
// and CoachTools' AssignTrainingProgramModal all go through it so a program
// lands on the calendar the same way whichever door it came in by.
//
// Row shape mirrors what AssignTrainingProgramModal.generateWorkoutEvents and
// Schedule.js handleProgramDrop already wrote (event_type 'workout', title,
// training_program_id, training_day_id), plus `category` — the #436 program
// status RPC keys lifting/throwing/hitting off schedule_events.category, so a
// program scheduled without one never turns the athlete's check mark green.

import { supabase } from './supabaseClient';
import { placeProgramDays, fmtLocalDate } from './scheduleUtils';

// schedule_events.category each generator's output should carry. Exercise
// categories inside a program are mixed (a throwing day emits conditioning,
// pitching, recovery AND fielding rows), so the generator names its own.
export const PROGRAM_CALENDAR_CATEGORY = {
  sc: 'strength',
  throwing: 'pitching',
  hitting: 'hitting',
  // #454: its own category so a rehab plan does not satisfy the #436
  // Lifting/Mobility requirement.
  pt: 'pt',
};

const BATCH = 500;

// The Monday on or after `dateStr` — where a 'weekday' program's day 1 lands.
export function mondayOnOrAfter(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  const dow = d.getDay();
  if (dow !== 1) d.setDate(d.getDate() + ((8 - dow) % 7));
  return fmtLocalDate(d);
}

// Last calendar day of ONE pass of a 'weekday' program started on `startStr`.
// placeProgramDays repeats the block until the end date, so a generator that
// wants its program on the calendar exactly once must end on this day — the
// old `start + weeks*7` maths ended one day into the next cycle and dropped a
// stray "day 1" on the Monday after the last week.
export function singlePassEndDate(startStr, days) {
  const maxDay = Math.max(1, ...(days || []).map((d) => d.day_number || 1));
  const cycleDays = Math.max(7, Math.ceil(maxDay / 7) * 7);
  const end = new Date(mondayOnOrAfter(startStr) + 'T00:00:00');
  end.setDate(end.getDate() + cycleDays - 1);
  return fmtLocalDate(end);
}

/**
 * Write one schedule_events row per (placed day × athlete), or per placed day
 * for a team. Returns { count, dates: [first, last] }.
 *
 *   programId   training_programs.id
 *   programName fallback title when a day has none
 *   dayAnchor   training_programs.day_anchor ('weekday' | 'sequential' | null)
 *   playerIds   athletes (ignored when teamId is given)
 *   teamId      one team → one row per day with team_id/team_ids
 *   startDate   ISO date
 *   endDate     ISO date; omit for a 'weekday' program to schedule ONE pass
 *   weekdays    Sun..Sat booleans, only read for 'sequential' programs
 *   category    schedule_events.category (see PROGRAM_CALENDAR_CATEGORY)
 *   days        optional pre-fetched training_days rows (id, day_number, title)
 */
export async function scheduleProgramEvents({
  programId, programName, dayAnchor, playerIds = [], teamId = null,
  startDate, endDate, weekdays, category = null, days = null,
}) {
  if (!programId || !startDate) return { count: 0, dates: null };
  if (!teamId && (!playerIds || playerIds.length === 0)) return { count: 0, dates: null };

  let dayRows = days;
  if (!dayRows) {
    const { data, error } = await supabase
      .from('training_days')
      .select('id, day_number, title')
      .eq('program_id', programId)
      .order('day_number');
    if (error) throw error;
    dayRows = data || [];
  }
  if (dayRows.length === 0) return { count: 0, dates: null };

  const endStr = endDate || (dayAnchor === 'weekday' ? singlePassEndDate(startDate, dayRows) : null);
  if (!endStr) return { count: 0, dates: null };

  const placed = placeProgramDays({ dayAnchor, days: dayRows, startStr: startDate, endStr, weekdays });
  if (placed.length === 0) return { count: 0, dates: null };

  const rows = [];
  placed.forEach(({ date, day }) => {
    const base = {
      event_type: 'workout',
      event_date: date,
      title: day.title || `${programName || 'Program'} - Day ${day.day_number}`,
      training_program_id: programId,
      training_day_id: day.id,
      category,
    };
    if (teamId) rows.push({ ...base, team_id: teamId, team_ids: [teamId] });
    else playerIds.forEach((pid) => rows.push({ ...base, player_id: pid }));
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('schedule_events').insert(chunk);
    if (error) throw error;
    inserted += chunk.length;
  }
  const dates = placed.map((p) => p.date).sort();
  return { count: inserted, dates: [dates[0], dates[dates.length - 1]] };
}

// Undo for a failed save: schedule_events.training_program_id is ON DELETE SET
// NULL, so deleting the program would leave orphan workouts on the calendar.
export async function deleteProgramEvents(programId) {
  if (!programId) return;
  const { error } = await supabase.from('schedule_events').delete().eq('training_program_id', programId);
  if (error) throw error;
}

// Human line for the save confirmation.
export function describeScheduled(result, athleteName) {
  if (!result || !result.count) return '';
  const [first, last] = result.dates || [];
  const span = first && last && first !== last ? `${first} → ${last}` : (first || '');
  return `${result.count} workout${result.count === 1 ? '' : 's'} added to ${athleteName ? `${athleteName}'s` : 'the'} schedule${span ? ` (${span})` : ''}.`;
}
