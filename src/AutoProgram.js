import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { scheduleProgramEvents, deleteProgramEvents, singlePassEndDate, describeScheduled, PROGRAM_CALENDAR_CATEGORY } from './programScheduling';
import { insertTrainingProgram } from './insertTrainingProgram';
import {
  Wand2, Search, User, Save, AlertTriangle, ShieldAlert, CheckCircle2, Circle,
  Dumbbell, Zap, Target, Utensils, ChevronDown, ChevronUp, Info, Lock,
} from 'lucide-react';
import {
  ASSESSMENT_AREAS, ASSESSMENT_METRICS, assessmentReadiness, metricLabel,
  extractMetricSourcesFromSubmission, extractMetricSourcesFromSubmissions, toRelativeStrength,
} from './assessmentMetrics';
import {
  Position, Sex, makeAthlete, generateProgram, programToProgramDays,
  phaseForDate, PHASE_LABEL, SC_LEVEL_NAME,
} from './scProgramEngine';
import {
  LEVELS as THROW_LEVELS, POSITIONS as THROW_POSITIONS, PHASES as THROW_PHASES,
  PHASE_ORDER as THROW_PHASE_ORDER, ATHLETE_TYPES,
  readiness as throwReadiness, assessmentGates, gradeThrowing, deficiencyDrills,
  stressUnits, seedLog,
  buildProgram as buildThrowingProgram,
  programToProgramDays as throwingToProgramDays,
} from './throwingEngine';
import {
  LEVELS as HIT_LEVELS, LEVEL_NAME as HIT_LEVEL_NAME, METRICS as HIT_METRICS,
  generatePlan as generateHittingPlan, planToProgramDays as hittingToProgramDays,
} from './hittingEngine';
import {
  Goal, Phase as NutriPhase, DayType, makeProfile,
  generatePlan as generateNutritionPlan, planToMealRows, COACH_OVERRIDE_MIN_KCAL,
} from './nutritionEngine';

/* --------------------------------------------------------------------------- *
 *  Auto-Program — one athlete, one pass, all four engines (issue #174).
 *
 *  WHAT THIS IS. The four generators (S&C, Throwing, Hitting, Nutrition) already
 *  turn an athlete's assessment numbers into complete, saveable programs. What
 *  did not exist was the ORCHESTRATION: a staff member had to open each tab in
 *  turn, search the same athlete four times, re-enter overlapping inputs four
 *  times, and press Generate + Save four times. That repetition is the data
 *  entry Cordell asked us to delete. This tab collects the shared inputs ONCE,
 *  runs all four engines against the athlete's extracted metrics, shows one
 *  combined review, and writes only the domains the coach ticked.
 *
 *  WHAT THIS IS NOT. There is no AI here and no model call — there is no vendor,
 *  no key, and vercel.json's CSP restricts connect-src to self / Supabase /
 *  Resend / WHOOP. Every number below comes from a deterministic rule engine
 *  that a coach can read, argue with and correct. That is a feature, not a
 *  shortfall, and the UI says so rather than implying something is "thinking".
 *
 *  SAFETY POSTURE. Generation is pure and local: NOTHING is written to the
 *  database until the coach presses Save on the review screen. The review screen
 *  is the ask. Every Supabase call destructures `error` — a failed query that
 *  looks like empty data has already cost this project two days of production
 *  bugs, and these programs get assigned to minors.
 * --------------------------------------------------------------------------- */

/* ===========================================================================
   ROSTER-MODE SEAM (deliberately NOT built — see the report on #174).
   Everything below is single-athlete by construction: `selectedId` is a scalar,
   `built` is one athlete's four results, and `save()` writes one athlete's rows.
   A whole-roster mode would wrap loadAthlete() + buildAll() + saveAll() in a
   queue over an array of athletes and render a per-athlete result table. It is
   the obvious next step and it is EXPLICITLY out of scope: batch-assigning
   generated programs to a roster of minors without a per-athlete human review is
   exactly the review step this screen exists to enforce, and a half-built queue
   is worse than none. Build it deliberately, or not at all.
   =========================================================================== */

const iso = (d) => d.toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString() : '');
const numOrNull = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

const ageFromDob = (dob) => {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) ? age : null;
};

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;

// Mirrors ProgramGenerator.js — the S&C engine's equipment vocabulary.
const EQUIPMENT_OPTIONS = [
  'barbell', 'dumbbell', 'bands', 'medball', 'trapbar', 'ssb', 'box',
  'landmine', 'football_bar', 'pullup_bar', 'chains',
  'sled', 'deadlift_platform', 'squat_rack', 'cable_machine', 'kettlebells',
  'multi_grip_bar', 'leg_machines', 'belt_squat', 'trx_band',
];

// player_profiles.position -> S&C engine Position (mirrors ProgramGenerator.js).
function positionFromProfile(pos) {
  const p = String(pos || '').toLowerCase();
  if (/pitch|\bp\b|rhp|lhp|sp|rp/.test(p)) return Position.PITCHER;
  if (/catch|\bc\b/.test(p)) return Position.CATCHER;
  if (/two.?way|util/.test(p)) return Position.TWO_WAY;
  return Position.POSITION;
}

// player_profiles.position -> throwing engine POSITIONS key (mirrors ThrowingGenerator.js).
function posKeyFromProfile(pos) {
  const p = String(pos || '').toLowerCase();
  if (/two.?way/.test(p)) return 'TW';
  if (/relief|\brp\b/.test(p)) return 'RP';
  if (/pitch|\bp\b|rhp|lhp|\bsp\b/.test(p)) return 'SP';
  if (/catch|\bc\b/.test(p)) return 'C';
  if (/short|\bss\b|2b|second|middle|\bmif\b/.test(p)) return 'MIF';
  if (/first|1b|third|3b|corner|\bcif\b/.test(p)) return 'CIF';
  if (/field|\bof\b|lf|cf|rf/.test(p)) return 'OF';
  return 'OF';
}

// Age -> throwing level id (mirrors ThrowingGenerator.js).
function throwLevelFromAge(age) {
  if (age == null) return '17-18';
  if (age < 11) return '9-10';
  if (age < 13) return '11-12';
  if (age < 15) return '13-14';
  if (age < 17) return '15-16';
  if (age < 19) return '17-18';
  if (age < 23) return '19-22';
  return 'pro';
}

// Age -> hitting level id (mirrors HittingGenerator.js).
function hitLevelFromAge(age) {
  if (age == null) return 'hs_varsity';
  if (age < 13) return 'youth';
  if (age < 15) return 'middleschool';
  if (age < 19) return 'hs_varsity';
  if (age < 23) return 'college';
  return 'pro';
}

/* ---------------------------------------------------------------------------
   ⚠️ VERBATIM COPY of `deriveGateScores` from ThrowingGenerator.js.

   That function is a module-private helper in ThrowingGenerator.js, not an
   export of throwingEngine.js, so this tab cannot import it. It is copied here
   RATHER than re-invented, because the bands below are tuned coaching defaults
   (see #351/#352/#354 — grip in pounds not kilos, CMJ vs vertical jump) and a
   second, subtly different derivation would hand two different throwing
   programs to the same athlete depending on which tab a coach opened.

   IF YOU EDIT THE BANDS IN ThrowingGenerator.js, EDIT THEM HERE TOO. The
   permanent fix is to move this function into throwingEngine.js and have both
   screens import it; that touches an existing file and was out of scope for the
   change that added this tab.
--------------------------------------------------------------------------- */
function deriveGateScores(byKey) {
  const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)));
  const lin = (v, lo, hi) => ((v - lo) / (hi - lo)) * 100;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const mobParts = [];
  if (byKey.hipir != null) mobParts.push(lin(byKey.hipir, 10, 40));
  if (byKey.tspine != null) mobParts.push(lin(byKey.tspine, 25, 50));
  if (byKey.ankle != null) mobParts.push(lin(byKey.ankle, 5, 12));
  if (byKey.shoulder_rom_deficit != null) mobParts.push(100 - lin(byKey.shoulder_rom_deficit, 0, 15));
  const mob = mobParts.length ? clamp(avg(mobParts)) : null;

  const strParts = [];
  if (byKey.dl != null) strParts.push(lin(byKey.dl, 0.8, 1.8));
  if (byKey.back_squat != null && byKey.body_weight) strParts.push(lin(byKey.back_squat / byKey.body_weight, 0.8, 1.8));
  const verticalPowerIn = byKey.cmj != null ? byKey.cmj : byKey.vertical_jump;
  if (verticalPowerIn != null) strParts.push(lin(verticalPowerIn, 10, 26));
  if (byKey.broad_jump != null) strParts.push(lin(byKey.broad_jump, 60, 110));
  if (byKey.grip != null) strParts.push(lin(byKey.grip, 55, 121));
  const str = strParts.length ? clamp(avg(strParts)) : null;

  return { mob, str, mobCount: mobParts.length, strCount: strParts.length };
}

/* Canonical metric_key -> the S&C engine's screen field. Copied from
   ProgramGenerator.js's SC_KEY_MAP (data, not logic). Jumps are inches on both
   sides of the map, and `dl` has already been converted to a bodyweight
   multiple by extractMetricSourcesFromSubmissions(). */
const SC_KEY_MAP = {
  hipir: 'hip_ir_deg',
  tspine: 'tspine_rotation_deg',
  ankle: 'ankle_dorsiflexion_cm',
  shoulder_ir: 'shoulder_ir_dom',
  shoulder_er: 'shoulder_er_dom',
  shoulder_rom_deficit: 'total_rom_deficit',
  vertical_jump: 'vertical_jump_in',
  cmj: 'cmj_in',
  seated_vertical_jump: 'seated_vertical_jump_in',
  approach_vertical_jump: 'approach_vertical_jump_in',
  depth_drop_jump: 'depth_drop_jump_in',
  broad_jump: 'broad_jump_in',
  dl: 'rel_trap_bar_dl',
};

// Every athlete starts from this base, so switching athletes never carries a
// previous athlete's hand-edits forward into the next one's program.
const BASE_PROFILE = {
  age: '16', sex: Sex.MALE, position: Position.POSITION, throwPos: 'OF',
  throwLevel: '17-18', hitLevel: 'hs_varsity', athleteType: 'intermediate',
  trainingMonths: '12', recentPitchCount: '0',
  weightLb: '', heightIn: '', bodyFat: '',
};

const BLANK_SCREEN = {
  shoulder_ir_dom: '', shoulder_ir_nondom: '', shoulder_er_dom: '', total_rom_deficit: '',
  hip_ir_deg: '', ankle_dorsiflexion_cm: '', tspine_rotation_deg: '',
  vertical_jump_in: '', cmj_in: '', seated_vertical_jump_in: '', approach_vertical_jump_in: '',
  depth_drop_jump_in: '', broad_jump_in: '', rel_squat: '', rel_trap_bar_dl: '',
  single_leg_stability: '', movement_competency: 'developing',
};

// The screen fields the coach can edit here. The three display-only jumps
// (seated / approach / depth-drop) are carried through silently — the S&C engine
// reads none of them, so an input box would imply an influence they don't have.
const SCREEN_FIELDS = [
  ['shoulder_ir_dom', 'Shoulder IR — throwing (°)'],
  ['shoulder_ir_nondom', 'Shoulder IR — glove (°)'],
  ['shoulder_er_dom', 'Shoulder ER — throwing (°)'],
  ['total_rom_deficit', 'Total ROM deficit (°)'],
  ['hip_ir_deg', 'Hip IR (°)'],
  ['ankle_dorsiflexion_cm', 'Ankle dorsiflexion (cm)'],
  ['tspine_rotation_deg', 'T-spine rotation (°)'],
  ['vertical_jump_in', 'Vertical jump (in)'],
  ['cmj_in', 'Counter-movement jump (in)'],
  ['broad_jump_in', 'Broad jump (in)'],
  ['rel_squat', 'Back squat (× BW)'],
  ['rel_trap_bar_dl', 'Trap-bar deadlift (× BW)'],
];

const HIT_METRIC_KEYS = HIT_METRICS.map((m) => m.key);
const BLANK_HIT = Object.fromEntries(HIT_METRIC_KEYS.map((k) => [k, '']));

const METRIC_UNIT = Object.fromEntries(ASSESSMENT_METRICS.map((m) => [m.key, m.unit]));

// Which canonical metrics feed which engine. Used only to explain the build to
// the coach — the engines themselves read the fields we hand them, below.
const SC_DRIVERS = [
  'hipir', 'tspine', 'ankle', 'shoulder_ir', 'shoulder_er', 'shoulder_rom_deficit',
  'vertical_jump', 'cmj', 'broad_jump', 'dl', 'back_squat', 'body_weight', 'training_age',
];
const SC_CAPTURED_ONLY = ['seated_vertical_jump', 'approach_vertical_jump', 'depth_drop_jump', 'trap_bar_jump'];
const THROW_DRIVERS = [
  'throwing_velo_max', 'fb_velo', 'mobility_score', 'strength_score', 'biomech_score',
  'hipir', 'tspine', 'ankle', 'shoulder_rom_deficit',
  'dl', 'back_squat', 'cmj', 'vertical_jump', 'broad_jump', 'grip', 'body_weight',
];
const HIT_DRIVERS = [...HIT_METRIC_KEYS];
const NUTRI_DRIVERS = ['body_weight', 'height', 'body_fat_pct'];

// Shared season phase -> nutrition engine phase. The throwing engine's phase
// vocabulary is the richest of the four, so it is the one the coach picks.
const NUTRI_PHASE_FOR = {
  DELOAD: NutriPhase.OFF_SEASON,
  ONRAMP: NutriPhase.OFF_SEASON,
  VELO: NutriPhase.OFF_SEASON,
  PRESEASON: NutriPhase.PRE_SEASON,
  INSEASON: NutriPhase.IN_SEASON,
  POSTSEASON: NutriPhase.POST_SEASON,
};

function defaultSeason() {
  const y = new Date().getFullYear();
  const start = new Date(new Date() > new Date(`${y}-03-01`) ? y + 1 : y, 2, 1); // Mar 1
  const end = new Date(start.getFullYear(), 5, 30); // Jun 30
  return { start: iso(start), end: iso(end) };
}

/* Default season phase from the plan date vs the season window. Off-season
   defaults to ON-RAMP rather than VELO: an athlete we know nothing about should
   start on a return-to-throw ramp, not a velocity block. Wrong-and-conservative
   is recoverable; wrong-and-aggressive is an arm. */
function defaultPhaseId(planDate, seasonStart, seasonEnd) {
  const wk = 7 * 24 * 60 * 60 * 1000;
  if (planDate >= seasonStart && planDate <= seasonEnd) return 'INSEASON';
  if (planDate > seasonEnd) return (planDate - seasonEnd) / wk <= 3 ? 'POSTSEASON' : 'ONRAMP';
  return (seasonStart - planDate) / wk <= 4 ? 'PRESEASON' : 'ONRAMP';
}

/* ---------------------------------------------------------------------------
   Provenance. extractMetricSourcesFromSubmissions() tells us the VALUE and
   whether it came from an explicit metric_key tag or a label guess, but not
   WHICH assessment it came from. We rebuild that here by walking the same
   newest-first list with the same first-wins rule, so a coach can read
   "grip 118 lb — tagged, 12 Aug assessment" instead of a bare number.
--------------------------------------------------------------------------- */
function buildProvenance(subs) {
  const where = {};
  for (const sub of subs || []) {
    const one = extractMetricSourcesFromSubmission(sub);
    for (const k of Object.keys(one.values)) {
      if (where[k] === undefined) {
        where[k] = {
          date: sub.assessment_date || sub.created_at || null,
          template: sub.assessment_templates?.name || null,
        };
      }
    }
  }
  return where;
}

/* ============================== small view parts ========================== */

const CARD = 'bg-white rounded-lg border border-gray-200 p-5';
const EYEBROW = 'text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3';
const LBL = 'block text-xs font-medium text-gray-500 mb-1';
const INP = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm';

function Section({ title, subtitle, open, onToggle, children, right }) {
  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <button onClick={onToggle} className="flex items-center gap-2 text-left">
          {open ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
          <span>
            <span className="block text-sm font-semibold text-gray-900">{title}</span>
            {subtitle && <span className="block text-xs text-gray-500 mt-0.5">{subtitle}</span>}
          </span>
        </button>
        {right}
      </div>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

function FlagList({ items, tone = 'amber', icon: Icon = AlertTriangle }) {
  if (!items || !items.length) return null;
  const c = tone === 'red'
    ? 'border-red-300 bg-red-50 text-red-800'
    : tone === 'blue'
      ? 'border-blue-200 bg-blue-50 text-blue-800'
      : 'border-amber-300 bg-amber-50 text-amber-900';
  return (
    <ul className={`rounded border ${c} p-3 space-y-1.5 text-xs`}>
      {items.map((t, i) => (
        <li key={i} className="flex gap-2">
          <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/* One "which number drove this, and where did it come from" table. */
function DriverTable({ keys, values, sources, where, emptyText, captionTone }) {
  const rows = keys.filter((k) => values[k] != null);
  if (!rows.length) {
    return emptyText ? <div className="text-xs text-gray-500 italic">{emptyText}</div> : null;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody>
          {rows.map((k) => {
            const src = sources[k];
            const w = where[k] || {};
            return (
              <tr key={k} className="border-b border-gray-100 last:border-0">
                <td className="py-1 pr-3 text-gray-600 whitespace-nowrap">{metricLabel(k)}</td>
                <td className="py-1 pr-3 font-mono font-semibold text-gray-900 whitespace-nowrap">
                  {values[k]}{METRIC_UNIT[k] ? ` ${METRIC_UNIT[k]}` : ''}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">
                  {src === 'tag' ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">tagged</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200" title="Matched by reading the field's label, not by an explicit metric tag. Weakest evidence — check it.">label-matched</span>
                  )}
                </td>
                <td className="py-1 text-gray-500">
                  {w.date ? `${fmtDate(w.date)}${w.template ? ` · ${w.template}` : ''}` : 'source unknown'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {captionTone && <div className="text-[10px] text-gray-500 mt-1.5">{captionTone}</div>}
    </div>
  );
}

const DOMAINS = [
  { key: 'sc', label: 'Strength & Conditioning', icon: Dumbbell, area: 'sc', accent: 'text-blue-600' },
  { key: 'throwing', label: 'Throwing', icon: Zap, area: 'throwing', accent: 'text-amber-600' },
  { key: 'hitting', label: 'Hitting', icon: Target, area: 'hitting', accent: 'text-purple-600' },
  { key: 'nutrition', label: 'Nutrition & Meals', icon: Utensils, area: null, accent: 'text-emerald-600' },
];

/* ========================= BATCHED DATABASE WRITES =========================
   One athlete's Auto-Program used to be ~224 HTTP requests: a round-trip per
   training_days row and another per day's exercises, times three domains, plus
   the meal plan. On facility wifi that is slow, and every one of those requests
   is another chance to fail half-way and leave an orphaned program behind.

   PostgREST accepts an array in a single .insert([...]), so each domain is now
   a fixed handful of round-trips: program row, all days, all exercises, the
   assignment. All four domains together are ~16 requests.

   Two rules these helpers exist to enforce:
     1. EVERY call destructures `error`. `const { data } = await supabase...`
        is banned in this codebase — a failed query that looked like empty data
        ran in production for two days.
     2. A batched insert's returned rows come back in NO GUARANTEED ORDER. Never
        zip them to the local rows by array index. Match on a stable field
        (training_days.day_number) or, where the table has none, on the full
        content of the row.
   ========================================================================= */

// Chunk size for a single .insert([...]) call. ~100 days / ~300 exercises fit in
// one request comfortably; this only exists so an unusually long program (or a
// future roster mode) degrades into a few requests instead of one enormous one.
export const INSERT_CHUNK_ROWS = 500;

const chunkRows = (rows, size = INSERT_CHUNK_ROWS) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

// Fire-and-check insert: no rows come back, so nothing needs matching.
async function insertAll(table, rows) {
  for (const batch of chunkRows(rows)) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw error;
  }
}

// Insert and read the rows back. Refuses to continue on a short/absent return:
// a missing row means some local row has no id, and guessing is how exercises
// end up filed under the wrong day.
async function insertAllReturning(table, rows, columns) {
  const back = [];
  for (const batch of chunkRows(rows)) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.from(table).insert(batch).select(columns);
    if (error) throw error;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`${table} returned ${Array.isArray(data) ? data.length : 'no'} row(s) for the ${batch.length} sent — refusing to guess which id belongs to which row.`);
    }
    back.push(...data);
  }
  return back;
}

// Normalizes one value into a comparison key component. NUMERIC columns can come
// back as "20.50" where we sent 20.5, so numbers are compared as numbers.
const keyPart = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? String(n) : String(v);
};
const contentKey = (row, fields) => fields.map((f) => keyPart(row[f])).join('|~|');

/* --------------------------------------------------------------------------
   saveTrainingProgram — training_programs -> training_days -> training_exercises
   -> training_program_assignments. Row shapes are byte-identical to the ones
   ProgramGenerator.save() / ThrowingGenerator.save() / HittingGenerator.save()
   already write.

   Requests: 1 (program) + 1 (all days) + 1 (all exercises, 0 if none) +
   1 (assignment, when assigning) = 3-4.

   ROLLBACK. complete_database_schema.sql declares
     training_days.program_id                UUID REFERENCES training_programs(id) ON DELETE CASCADE
     training_exercises.day_id               UUID REFERENCES training_days(id)     ON DELETE CASCADE
     training_program_assignments.program_id UUID REFERENCES training_programs(id) ON DELETE CASCADE
   so deleting the one program row takes its days, exercises and assignment with
   it. Cleanup is a single DELETE. If that DELETE itself fails we say exactly
   what is still there and where to find it — we never claim a rollback that did
   not happen.
   -------------------------------------------------------------------------- */
export async function saveTrainingProgram({
  name, description, durationWeeks, rows,
  authorId, playerId, startDate, endDate, onStep,
  // #439: schedule_events.category for the calendar rows (PROGRAM_CALENDAR_CATEGORY).
  category = null,
}) {
  const step = (m) => { if (onStep) onStep(m); };

  step('Creating the program…');
  // #393: these day_numbers are (week-1)*7 + weekday + 1 with weekday 0 =
  // MONDAY, so day 1 MEANS Monday. day_anchor tells handleProgramDrop to snap
  // this program to the Monday of the week it's dropped on instead of treating
  // the dropped day as day 1 — without it the whole week rotates and #385's
  // excluded weekdays come back.
  const { data: prog, error: pErr } = await insertTrainingProgram(
    { name, description, duration_weeks: durationWeeks, created_by: authorId, day_anchor: 'weekday' }
  );
  if (pErr) throw pErr;
  if (!prog || !prog.id) throw new Error('training_programs insert returned no id — nothing else was written.');

  const programId = prog.id;
  let stage = 'the training days';
  let daysWritten = 0;
  let exercisesWritten = 0;

  try {
    // day_number is the row's own ABSOLUTE calendar-day offset, not a loop index
    // — rest days emit no row, so the two are not the same number. All three
    // engines emit at most one row per calendar day, so day_number is unique
    // within a program, which is what makes it a safe join key below.
    step(`Writing ${rows.length} day(s)…`);
    const dayRows = await insertAllReturning(
      'training_days',
      rows.map((d) => ({ program_id: programId, day_number: d.day_number, title: d.title, notes: d.notes })),
      'id, day_number',
    );
    daysWritten = dayRows.length;

    // Match returned rows back to local days BY day_number, never by index.
    const idByDayNumber = new Map();
    for (const r of dayRows) {
      if (idByDayNumber.has(r.day_number)) {
        throw new Error(`two training_days rows came back for day_number ${r.day_number} — cannot tell which day an exercise belongs to.`);
      }
      idByDayNumber.set(r.day_number, r.id);
    }

    stage = 'the exercises';
    const exerciseRows = [];
    for (const d of rows) {
      const dayId = idByDayNumber.get(d.day_number);
      if (!dayId) throw new Error(`no training_days row came back for day_number ${d.day_number} — its exercises have nowhere to go.`);
      for (const x of d.exercises) {
        exerciseRows.push({
          day_id: dayId, category: x.category, name: x.name,
          description: x.description, reps: x.reps, sort_order: x.sort_order,
          video_url: x.video_url || null,
        });
      }
    }
    step(`Writing ${exerciseRows.length} exercise(s)…`);
    await insertAll('training_exercises', exerciseRows);
    exercisesWritten = exerciseRows.length;

    let scheduled = null;
    if (playerId) {
      stage = 'the assignment';
      step('Assigning to the athlete…');
      // #439: one pass of the program, ending on its own last day — see
      // singlePassEndDate for why the caller's start + weeks*7 is one day long.
      const assignEnd = singlePassEndDate(startDate, rows);
      const { error: aErr } = await supabase.from('training_program_assignments').insert({
        program_id: programId, player_id: playerId,
        start_date: startDate, end_date: assignEnd,
        assigned_by: authorId,
      });
      if (aErr) throw aErr;

      // #439: assigning puts the program straight on the athlete's calendar.
      stage = 'the calendar';
      step('Adding to the athlete\'s schedule…');
      scheduled = await scheduleProgramEvents({
        programId, programName: name, dayAnchor: 'weekday',
        playerIds: [playerId], startDate, endDate: assignEnd, category,
        days: dayRows.map((r) => ({ id: r.id, day_number: r.day_number, title: rows.find((d) => d.day_number === r.day_number)?.title })),
      });
    }
    return { programId, daysWritten, exercisesWritten, scheduled };
  } catch (e) {
    const base = e.message || 'The save failed.';
    step('Rolling back…');
    // #439: calendar rows don't cascade from the program (training_program_id
    // is ON DELETE SET NULL), so clear them first or they'd be orphaned.
    let calendarLeft = null;
    try { await deleteProgramEvents(programId); } catch (ce) { calendarLeft = ce.message; }
    // .select('id') is not decoration: a DELETE that RLS silently filters out
    // returns 200 with NO error and NO rows. Reading the deleted rows back is
    // the only way to know the cleanup actually happened before we claim it did.
    const { data: deleted, error: delErr } = await supabase
      .from('training_programs').delete().eq('id', programId).select('id');
    const cleanupFailed = delErr ? delErr.message
      : (!Array.isArray(deleted) || deleted.length === 0)
        ? 'the delete removed no rows — most likely a row-level-security policy blocked it'
        : null;
    if (cleanupFailed) {
      throw new Error(`${base} — failed while writing ${stage}, AND THE CLEANUP ALSO FAILED (${cleanupFailed}). The program "${name}" (id ${programId}) is STILL in the database with ${daysWritten} day(s) and ${exercisesWritten} exercise(s) and no assignment. Find it in Programming → Programs and delete it by hand.${calendarLeft ? ` Its calendar workouts could not be removed either (${calendarLeft}).` : ''}`);
    }
    if (calendarLeft) {
      throw new Error(`${base} — failed while writing ${stage}. "${name}" was deleted, but its calendar workouts could not be removed (${calendarLeft}) — delete them from the athlete's schedule by hand.`);
    }
    throw new Error(`${base} — failed while writing ${stage}. Nothing was left behind: "${name}" was deleted, and its days and exercises cascade from it. Nothing was assigned or scheduled. Fix the cause and save again.`);
  }
}

/* --------------------------------------------------------------------------
   saveMealPlan — meal_plans -> meals -> meal_plan_items -> meal_plan_assignments.
   Row shapes are byte-identical to NutritionGenerator.save().

   Requests: 1 (plan) + 1 (all meals) + 1 (all items) + 1 (assignment) = 3-4.

   ROLLBACK. meal_plan_items cascades from BOTH meal_plans and meals, and
   meal_plan_assignments cascades from meal_plans — but `meals` rows are
   free-standing library rows that nothing cascades to. So cleanup deletes the
   meals we just created AND the plan row: deleting the plan alone would leave
   orphaned meals sitting in the meal library.
   -------------------------------------------------------------------------- */
export async function saveMealPlan({
  name, description, meals, authorId, playerId, startDate, onStep,
}) {
  const step = (m) => { if (onStep) onStep(m); };

  step('Creating the meal plan…');
  const { data: mp, error: pErr } = await supabase
    .from('meal_plans')
    .insert({ name, description, created_by: authorId })
    .select('id')
    .single();
  if (pErr) throw pErr;
  if (!mp || !mp.id) throw new Error('meal_plans insert returned no id — nothing else was written.');

  const mealPlanId = mp.id;
  const MEAL_KEY_FIELDS = ['name', 'meal_type', 'description', 'calories', 'protein_g', 'carbs_g', 'fat_g'];
  let stage = 'the meals';
  let mealIds = [];

  try {
    step(`Writing ${meals.length} meal(s)…`);
    const mealRows = await insertAllReturning(
      'meals',
      meals.map((m) => ({
        name: m.name, description: m.description, meal_type: m.meal_type,
        calories: m.calories, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
        created_by: authorId,
      })),
      `id, ${MEAL_KEY_FIELDS.join(', ')}`,
    );
    mealIds = mealRows.map((r) => r.id);

    // `meals` has no natural key to join on, so match returned rows back to the
    // local ones by their full CONTENT, popping ids off a per-key queue. Two
    // meals that collide on this key are byte-identical rows, so either id is
    // the right answer for either slot — but the index of the *local* array
    // still decides sort_order, which is what the plan's ordering depends on.
    const idsByKey = new Map();
    for (const r of mealRows) {
      const k = contentKey(r, MEAL_KEY_FIELDS);
      if (!idsByKey.has(k)) idsByKey.set(k, []);
      idsByKey.get(k).push(r.id);
    }
    const orderedIds = meals.map((m, i) => {
      const queue = idsByKey.get(contentKey(m, MEAL_KEY_FIELDS));
      if (!queue || !queue.length) throw new Error(`the meals insert returned no row matching meal ${i + 1} ("${m.name}") — refusing to guess its id.`);
      return queue.shift();
    });

    stage = 'the plan items';
    step(`Linking ${orderedIds.length} meal(s) to the plan…`);
    await insertAll('meal_plan_items', orderedIds.map((mealId, i) => ({
      meal_plan_id: mealPlanId, meal_id: mealId, sort_order: i,
    })));

    if (playerId) {
      stage = 'the assignment';
      step('Assigning to the athlete…');
      const { error: aErr } = await supabase.from('meal_plan_assignments').insert({
        meal_plan_id: mealPlanId, player_id: playerId,
        start_date: startDate, assigned_by: authorId,
      });
      if (aErr) throw aErr;
    }
  } catch (e) {
    const base = e.message || 'The save failed.';
    step('Rolling back…');
    const leftovers = [];
    // As above: read the deleted rows back. A DELETE filtered out by RLS looks
    // exactly like a successful one unless you count what came back.
    for (const batch of chunkRows(mealIds)) {
      // eslint-disable-next-line no-await-in-loop
      const { data: goneMeals, error: mDelErr } = await supabase
        .from('meals').delete().in('id', batch).select('id');
      const why = mDelErr ? mDelErr.message
        : (!Array.isArray(goneMeals) || goneMeals.length !== batch.length)
          ? 'the delete removed no rows — most likely a row-level-security policy blocked it'
          : null;
      if (why) leftovers.push(`${batch.length} row(s) in meals (ids ${batch.join(', ')}) — ${why}`);
    }
    const { data: gonePlan, error: pDelErr } = await supabase
      .from('meal_plans').delete().eq('id', mealPlanId).select('id');
    const planWhy = pDelErr ? pDelErr.message
      : (!Array.isArray(gonePlan) || gonePlan.length === 0)
        ? 'the delete removed no rows — most likely a row-level-security policy blocked it'
        : null;
    if (planWhy) leftovers.push(`the meal plan "${name}" (id ${mealPlanId}) — ${planWhy}`);
    if (leftovers.length) {
      throw new Error(`${base} — failed while writing ${stage}, AND THE CLEANUP ALSO FAILED. Still in the database: ${leftovers.join('; ')}. Delete these by hand under Programming → Meal Plans. Nothing was assigned.`);
    }
    throw new Error(`${base} — failed while writing ${stage}. Nothing was left behind: the plan "${name}", its items and the ${mealIds.length} meal(s) just created were all deleted. Nothing was assigned. Fix the cause and save again.`);
  }

  return { mealPlanId, written: meals.length };
}
/* ================================ component =============================== */

export default function AutoProgram({ userId, userRole }) {
  const allowed = userRole === 'admin' || userRole === 'coach';

  // `userId` is what created_by / assigned_by are written as. Programming.js
  // passes it alongside userRole exactly as it does to the other four
  // generators; the fallback below keeps the writes attributed if this tab is
  // ever mounted with only userRole.
  const [authorId, setAuthorId] = useState(userId || null);

  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedName, setSelectedName] = useState('');
  const [loadingAthlete, setLoadingAthlete] = useState(false);

  const [error, setError] = useState('');
  const [dataWarnings, setDataWarnings] = useState([]);
  const [autoNote, setAutoNote] = useState('');

  // Assessment layer for the selected athlete.
  const [ready, setReady] = useState(null);           // assessmentReadiness()
  const [metrics, setMetrics] = useState({ values: {}, sources: {}, where: {} });
  const [subCount, setSubCount] = useState(0);

  const season = useMemo(defaultSeason, []);

  // ---- ONE set of shared inputs, filled once instead of four times ----------
  const [shared, setShared] = useState({
    programStart: iso(new Date()),
    seasonStart: season.start,
    seasonEnd: season.end,
    weeks: '8',
    daysPerWeek: '3',
    phaseId: defaultPhaseId(new Date(), new Date(season.start + 'T00:00:00'), new Date(season.end + 'T00:00:00')),
    injuries: '',
    soreness: 'none',
    goal: Goal.PERFORMANCE,
    dayType: DayType.GAME,
    mealsPerDay: 4,
    vegetarian: false,
    vegan: false,
    allergies: '',
    dislikes: '',
    kcalOverride: '', // #464: coach-set calories, '' = engine
    weekInPhase: '1',
  });
  const setS = (k, v) => setShared((s) => ({ ...s, [k]: v }));

  const [equipment, setEquipment] = useState([...EQUIPMENT_OPTIONS]);

  // ---- Athlete profile (auto-filled, editable) -----------------------------
  const [profile, setProfile] = useState({ ...BASE_PROFILE });
  const setP = (k, v) => setProfile((p) => ({ ...p, [k]: v }));

  // ---- Engine input bags ---------------------------------------------------
  const [screen, setScreen] = useState({ ...BLANK_SCREEN });       // S&C screen values
  const [hitVals, setHitVals] = useState({ ...BLANK_HIT });        // hitting metrics
  const [gates, setGates] = useState({ mob: 72, str: 68, bio: 70 });
  const [whoopIn, setWhoopIn] = useState({
    recovery: '60', strain: '12', hrv: '', hrvBase: '', restingHr: '', hrvTrend: 'flat',
  });
  const [benchVals, setBenchVals] = useState({ velo: '', spin: '', ext: '' });
  const [throwLog, setThrowLog] = useState(seedLog);

  // ---- Per-domain include/exclude + why ------------------------------------
  const [include, setInclude] = useState({ sc: false, throwing: false, hitting: false, nutrition: false });
  const [includeReason, setIncludeReason] = useState({});

  const [names, setNames] = useState({ sc: '', throwing: '', hitting: '', nutrition: '' });
  const [assignAthlete, setAssignAthlete] = useState(true);

  const [built, setBuilt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResults, setSaveResults] = useState(null);

  const [open, setOpen] = useState({ plan: true, profile: false, screen: false, hit: false, throw: false, fuel: false });
  const toggleOpen = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  /* ------------------------------ roster ---------------------------------- */
  useEffect(() => {
    if (!allowed) return;
    (async () => {
      // #437: paged past the 1,000-row clamp.
      const { rows: data, error: e } = await readAllPages(() => supabase
        .from('users')
        .select('id, full_name, player_profiles!player_profiles_user_id_fkey(position, throws, level, training_age_months)')
        .in('role', ['player', 'coach', 'admin'])
        .order('full_name')
        .order('id'));
      if (e) { setError(`Could not load the roster: ${e.message}`); return; }
      let filtered = data;
      if (userRole === 'coach') {
        const { data: coachTeams, error: ctErr } = await supabase
          .from('team_members').select('team_id').eq('user_id', userId);
        if (ctErr) { setError(`Could not load your teams: ${ctErr.message}`); return; }
        const teamIds = (coachTeams || []).map((t) => t.team_id);
        const { data: members, error: mErr } = await supabase
          .from('team_members').select('user_id')
          .in('team_id', teamIds.length ? teamIds : ['00000000-0000-0000-0000-000000000000']);
        if (mErr) { setError(`Could not load your team rosters: ${mErr.message}`); return; }
        const allow = new Set((members || []).map((m) => m.user_id));
        filtered = filtered.filter((p) => allow.has(p.id));
      }
      setPlayers(filtered);
    })();
  }, [userId, userRole, allowed]);

  // created_by / assigned_by must be a real user id. If this tab is ever
  // mounted without userId, resolve it from the session rather than writing null.
  useEffect(() => {
    if (!allowed || userId) return;
    (async () => {
      const { data, error: e } = await supabase.auth.getUser();
      if (e) { setDataWarnings((w) => [...w, `Could not resolve the signed-in user (${e.message}); saved programs would be recorded without an author.`]); return; }
      if (data?.user?.id) setAuthorId(data.user.id);
    })();
  }, [userId, allowed]);

  /* --------------------------- athlete load ------------------------------- */
  const selectAthlete = useCallback(async (p) => {
    setSelectedId(p.id);
    setSelectedName(p.full_name);
    setSearch('');
    setLoadingAthlete(true);
    setError('');
    setDataWarnings([]);
    setBuilt(null);
    setSaveResults(null);
    setScreen({ ...BLANK_SCREEN });
    setHitVals({ ...BLANK_HIT });

    const warn = [];
    const notes = [];
    try {
      /* ---- 1. demographics ------------------------------------------------ */
      const { data: u, error: uErr } = await supabase
        .from('users')
        .select('date_of_birth, height, weight, player_profiles!player_profiles_user_id_fkey(position, throws, level, training_age_months)')
        .eq('id', p.id)
        .single();
      if (uErr) throw uErr;
      const pp = Array.isArray(u?.player_profiles) ? u.player_profiles[0] : u?.player_profiles;
      const age = ageFromDob(u?.date_of_birth);

      const nextProfile = { ...BASE_PROFILE };
      if (age != null) {
        nextProfile.age = String(age);
        nextProfile.throwLevel = throwLevelFromAge(age);
        nextProfile.hitLevel = hitLevelFromAge(age);
        notes.push('age → level');
      } else {
        warn.push('No date of birth on file — age-based levels, Pitch Smart caps and the youth guardrails all fall back to defaults (16 yrs / HS). Set the DOB on the athlete profile before assigning this.');
      }
      if (pp?.position) {
        nextProfile.position = positionFromProfile(pp.position);
        nextProfile.throwPos = posKeyFromProfile(pp.position);
        notes.push('position');
      }
      if (pp?.training_age_months != null) {
        const ta = Number(pp.training_age_months);
        nextProfile.trainingMonths = String(ta);
        nextProfile.athleteType = ta < 12 ? 'novice' : ta <= 36 ? 'intermediate' : 'advanced';
        notes.push('training age');
      }
      if (u?.weight) nextProfile.weightLb = String(u.weight);
      if (u?.height) nextProfile.heightIn = String(u.height);

      /* ---- 2. every assessment, newest first ------------------------------ */
      const { data: subs, error: sErr } = await supabase
        .from('assessment_submissions')
        .select('id, assessment_date, created_at, responses, assessment_templates(name, schema)')
        .eq('player_id', p.id)
        .order('assessment_date', { ascending: false })
        .limit(50);
      if (sErr) throw sErr;
      const subList = subs || [];
      setSubCount(subList.length);

      const rdy = assessmentReadiness(subList);
      setReady(rdy);
      const { values: byKey, sources: bySrc } = extractMetricSourcesFromSubmissions(subList);
      setMetrics({ values: byKey, sources: bySrc, where: buildProvenance(subList) });

      if (byKey.body_weight != null) nextProfile.weightLb = String(byKey.body_weight);
      if (byKey.height != null) nextProfile.heightIn = String(byKey.height);
      if (byKey.body_fat_pct != null) nextProfile.bodyFat = String(byKey.body_fat_pct);
      if (byKey.training_age != null) nextProfile.trainingMonths = String(Math.round(byKey.training_age));
      setProfile(nextProfile);

      /* ---- 3. S&C screen fields ------------------------------------------ */
      const nextScreen = { ...BLANK_SCREEN };
      for (const [mk, field] of Object.entries(SC_KEY_MAP)) {
        if (byKey[mk] != null) nextScreen[field] = String(Math.round(byKey[mk] * 100) / 100);
      }
      // back_squat is recorded as a 1RM in pounds; the engine grades × BW.
      // toRelativeStrength() returns null (→ not screened) when it cannot be
      // interpreted, which is the safe direction.
      if (byKey.back_squat != null) {
        const rel = toRelativeStrength(byKey.back_squat, byKey.body_weight);
        if (rel != null) nextScreen.rel_squat = String(rel);
      }
      setScreen(nextScreen);
      const screenFilled = Object.values(nextScreen).filter((v) => v !== '' && v !== 'developing').length;
      if (screenFilled) notes.push(`${screenFilled} S&C screen field(s)`);

      /* ---- 4. hitting metrics -------------------------------------------- */
      const nextHit = { ...BLANK_HIT };
      HIT_METRIC_KEYS.forEach((k) => { if (byKey[k] != null) nextHit[k] = String(byKey[k]); });

      const { data: bb, error: bbErr } = await supabase
        .from('trackman_pitches')
        .select('exit_speed')
        .eq('batter_user_id', p.id)
        .not('exit_speed', 'is', null);
      if (bbErr) {
        warn.push(`Trackman batted-ball query failed (${bbErr.message}) — exit velocity comes from the assessment only.`);
      } else {
        const evs = (bb || []).map((r) => r.exit_speed).filter((v) => v != null);
        // The assessment's front-toss EV outranks Trackman (HittingGenerator does
        // the same); so only fill from Trackman where the assessment is silent.
        if (evs.length) {
          if (!nextHit.evmax) nextHit.evmax = String(Math.round(Math.max(...evs) * 10) / 10);
          if (!nextHit.evavg) nextHit.evavg = String(Math.round((evs.reduce((s, v) => s + v, 0) / evs.length) * 10) / 10);
          notes.push(`EV from ${evs.length} Trackman swings`);
        }
      }
      setHitVals(nextHit);

      /* ---- 5. WHOOP ------------------------------------------------------- */
      const nextWhoop = { recovery: '60', strain: '12', hrv: '', hrvBase: '', restingHr: '', hrvTrend: 'flat' };
      const { data: cycles, error: cErr } = await supabase
        .from('whoop_cycles')
        .select('cycle_date, recovery_score, strain_score, hrv_rmssd, resting_heart_rate')
        .eq('athlete_id', p.id)
        .order('cycle_date', { ascending: false })
        .limit(30);
      if (cErr) {
        warn.push(`WHOOP query failed (${cErr.message}) — readiness and fuel targets use neutral defaults (recovery 60 / strain 12), not this athlete's data.`);
      } else if (cycles && cycles.length) {
        const latest = cycles[0];
        if (latest.recovery_score != null) { nextWhoop.recovery = String(Math.round(latest.recovery_score)); notes.push('WHOOP recovery'); }
        if (latest.strain_score != null) nextWhoop.strain = String(Math.round(latest.strain_score * 10) / 10);
        if (latest.hrv_rmssd != null) nextWhoop.hrv = String(Math.round(latest.hrv_rmssd));
        if (latest.resting_heart_rate != null) nextWhoop.restingHr = String(Math.round(latest.resting_heart_rate));
        const hist = cycles.slice(1).map((c) => c.hrv_rmssd).filter((v) => v != null);
        if (hist.length >= 3) {
          const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
          nextWhoop.hrvBase = String(Math.round(mean));
          if (latest.hrv_rmssd != null) {
            nextWhoop.hrvTrend = latest.hrv_rmssd > mean * 1.03 ? 'up' : latest.hrv_rmssd < mean * 0.97 ? 'down' : 'flat';
            notes.push('HRV trend');
          }
        }
      } else {
        warn.push('No WHOOP data on file — readiness and fuel targets use neutral defaults (recovery 60 / strain 12). Check them before assigning.');
      }
      setWhoopIn(nextWhoop);

      /* ---- 6. Trackman pitching: chronic load + velo benchmark ------------ */
      const nextBench = { velo: '', spin: '', ext: '' };
      const since = iso(new Date(Date.now() - 28 * 24 * 60 * 60 * 1000));
      const { data: pitches, error: pErr2 } = await supabase
        .from('trackman_pitches')
        .select('thrown_date, rel_speed, spin_rate, extension')
        .eq('pitcher_user_id', p.id)
        .gte('thrown_date', since);
      if (pErr2) {
        warn.push(`Trackman pitching query failed (${pErr2.message}) — the throwing chronic-load baseline falls back to a seeded 28-day pattern, not this athlete's real workload.`);
        setThrowLog(seedLog());
      } else if (pitches && pitches.length) {
        const byDate = {};
        pitches.forEach((r) => { byDate[r.thrown_date] = (byDate[r.thrown_date] || 0) + 1; });
        const today = new Date(iso(new Date()) + 'T00:00:00');
        const b = Object.entries(byDate).map(([d, count]) => ({
          id: `tm${d}`,
          dayAgo: Math.round((today - new Date(d + 'T00:00:00')) / (24 * 60 * 60 * 1000)),
          throws: count, intent: 100, mound: true,
        })).filter((e) => e.dayAgo >= 0 && e.dayAgo < 28);
        if (b.length) { setThrowLog(b); notes.push(`${b.length}d Trackman load`); } else setThrowLog(seedLog());

        const velos = pitches.map((r) => r.rel_speed).filter((v) => v != null).map(Number);
        const spins = pitches.map((r) => r.spin_rate).filter((v) => v != null).map(Number);
        const exts = pitches.map((r) => r.extension).filter((v) => v != null).map(Number);
        if (velos.length) { nextBench.velo = String(Math.round(Math.max(...velos) * 10) / 10); notes.push('velocity benchmark'); }
        if (spins.length) nextBench.spin = String(Math.round(spins.reduce((a, x) => a + x, 0) / spins.length));
        if (exts.length) nextBench.ext = String(Math.round((exts.reduce((a, x) => a + x, 0) / exts.length) * 10) / 10);
      } else {
        setThrowLog(seedLog());
        warn.push('No Trackman throw history in the last 28 days — the throwing ACWR baseline is a SEEDED pattern, not this athlete\'s workload. Treat the volume numbers as a starting point, not a measurement.');
      }
      if (!nextBench.velo && (byKey.throwing_velo_max != null || byKey.fb_velo != null)) {
        nextBench.velo = String(byKey.throwing_velo_max != null ? byKey.throwing_velo_max : byKey.fb_velo);
        notes.push('velo (assessment)');
      }
      setBenchVals(nextBench);

      /* ---- 7. throwing assessment gates ---------------------------------- */
      const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));
      const gs = deriveGateScores(byKey);
      const nextGates = { mob: 72, str: 68, bio: 70 };
      if (byKey.mobility_score != null) nextGates.mob = clamp100(byKey.mobility_score);
      else if (gs.mob != null) nextGates.mob = gs.mob;
      if (byKey.strength_score != null) nextGates.str = clamp100(byKey.strength_score);
      else if (gs.str != null) nextGates.str = gs.str;
      if (byKey.biomech_score != null) nextGates.bio = clamp100(byKey.biomech_score);
      else {
        warn.push('No biomechanics score on file — the throwing biomech gate stays at its neutral default (70). It is not measuring this athlete.');
      }
      setGates(nextGates);

      /* ---- 8. default the domain toggles from readiness ------------------- */
      const hasWeight = byKey.body_weight != null || !!u?.weight;
      const anyHit = HIT_METRIC_KEYS.some((k) => nextHit[k] !== '');
      const reasons = {};
      reasons.sc = rdy.sc ? `Assessed ${fmtDate(rdy.sc.date)}` : 'No S&C / mobility assessment on file';
      reasons.throwing = rdy.throwing ? `Assessed ${fmtDate(rdy.throwing.date)}` : 'No throwing assessment on file';
      reasons.hitting = rdy.hitting ? `Assessed ${fmtDate(rdy.hitting.date)}` : 'No hitting assessment on file';
      reasons.nutrition = hasWeight
        ? 'Body weight on file'
        : 'No body weight on file — every calorie and macro would come from a 180 lb default';
      setIncludeReason(reasons);
      setInclude({
        sc: !!rdy.sc,
        throwing: !!rdy.throwing,
        hitting: !!rdy.hitting && anyHit,
        nutrition: hasWeight,
      });

      setNames({
        sc: `${p.full_name} — S&C Program`,
        throwing: `${p.full_name} — Throwing`,
        hitting: `${p.full_name} — Hitting Roadmap`,
        nutrition: `${p.full_name} — Fuel Plan`,
      });

      setAutoNote(notes.length
        ? `Auto-filled from ${subList.length} assessment(s) + live data: ${[...new Set(notes)].join(', ')}. Every field below is editable.`
        : 'Nothing auto-filled — no assessments and no WHOOP/Trackman data on file for this athlete.');
      setDataWarnings(warn);
    } catch (e) {
      setError(e.message || 'Failed to load athlete.');
    } finally {
      setLoadingAthlete(false);
    }
    // No deps: this callback reads nothing from render state — it rebuilds every
    // input bag from BASE_PROFILE + the athlete's own data on each selection.
  }, []);

  /* ------------------------- derived throwing bits ------------------------ */
  const chronicWeekly = useMemo(() => {
    const su = (e) => stressUnits(e.throws, e.intent || 1, e.mound);
    const last28 = throwLog.reduce((s, e) => s + su(e), 0);
    return Math.max(1, Math.round(last28 / 4));
  }, [throwLog]);

  const scDerivedPhase = useMemo(() => {
    const pd = new Date(shared.programStart + 'T00:00:00');
    const ss = new Date(shared.seasonStart + 'T00:00:00');
    const se = new Date(shared.seasonEnd + 'T00:00:00');
    if (!Number.isFinite(pd.getTime()) || !Number.isFinite(ss.getTime()) || !Number.isFinite(se.getTime())) return null;
    return phaseForDate(pd, ss, se);
  }, [shared.programStart, shared.seasonStart, shared.seasonEnd]);

  /* ================================ BUILD =================================
     Pure and local. Runs all four engines, serializes each to the rows that
     would be inserted, and collects the flags a human must actually check.
     Nothing here touches the network.
     ====================================================================== */
  const buildAll = () => {
    setError('');
    setSaveResults(null);
    const weeksN = clampInt(shared.weeks, 1, 16, 8);
    const daysN = clampInt(shared.daysPerWeek, 1, 6, 3);
    const pd = new Date(shared.programStart + 'T00:00:00');
    const ss = new Date(shared.seasonStart + 'T00:00:00');
    const se = new Date(shared.seasonEnd + 'T00:00:00');
    const out = { builtAt: new Date().toISOString(), weeks: weeksN, days: daysN };

    /* ---------------------------- S&C ---------------------------------- */
    try {
      const athlete = makeAthlete({
        name: selectedName || 'Athlete',
        chrono_age: numOrNull(profile.age) ?? 16,
        position: profile.position,
        sex: profile.sex,
        training_age_months: numOrNull(profile.trainingMonths) ?? 0,
        equipment,
        injury_history: shared.injuries.split(',').map((s) => s.trim()).filter(Boolean),
        recent_game_pitch_count: numOrNull(profile.recentPitchCount) ?? 0,
        assessment: {
          shoulder_ir_dom: numOrNull(screen.shoulder_ir_dom),
          shoulder_ir_nondom: numOrNull(screen.shoulder_ir_nondom),
          shoulder_er_dom: numOrNull(screen.shoulder_er_dom),
          total_rom_deficit: numOrNull(screen.total_rom_deficit),
          hip_ir_deg: numOrNull(screen.hip_ir_deg),
          ankle_dorsiflexion_cm: numOrNull(screen.ankle_dorsiflexion_cm),
          tspine_rotation_deg: numOrNull(screen.tspine_rotation_deg),
          vertical_jump_in: numOrNull(screen.vertical_jump_in),
          cmj_in: numOrNull(screen.cmj_in),
          seated_vertical_jump_in: numOrNull(screen.seated_vertical_jump_in),
          approach_vertical_jump_in: numOrNull(screen.approach_vertical_jump_in),
          depth_drop_jump_in: numOrNull(screen.depth_drop_jump_in),
          broad_jump_in: numOrNull(screen.broad_jump_in),
          rel_squat: numOrNull(screen.rel_squat),
          rel_trap_bar_dl: numOrNull(screen.rel_trap_bar_dl),
          single_leg_stability: screen.single_leg_stability || null,
          movement_competency: screen.movement_competency || 'developing',
        },
      });
      const program = generateProgram(athlete, pd, ss, se, weeksN);
      const rows = programToProgramDays(program);

      // Mobility lives INSIDE the S&C week as screen-driven corrective prep —
      // there is no standalone mobility engine. Pull the blocks the engine
      // actually picked out of week 1 day 1 so the review shows the real thing.
      const firstDay = program.weeks?.[0]?.days?.[0];
      const correctives = (firstDay?.blocks || [])
        .filter((b) => /prep|corrective/i.test(b.label))
        .map((b) => ({ name: b.exercise, why: b.why || '', rx: b.prescription }));

      const flags = [];
      if (screen.shoulder_ir_dom && !screen.shoulder_ir_nondom) {
        flags.push('GIRD cannot be checked: the glove-side shoulder IR is blank, and the engine needs BOTH sides to detect a >18° internal-rotation deficit. Enter it in "S&C screen values" if the athlete was measured bilaterally.');
      }
      const screenBlank = SCREEN_FIELDS.filter(([f]) => f !== 'shoulder_ir_nondom' && !screen[f]).length;
      if (screenBlank >= 6) {
        flags.push(`${screenBlank} of ${SCREEN_FIELDS.length} screen fields are blank. The engine treats a blank as "not screened" and conservatively assumes the common thrower deficit — the program is therefore driven mostly by defaults, not by this athlete.`);
      }
      out.sc = {
        program, rows, correctives,
        level: SC_LEVEL_NAME[program.level] || program.level,
        engineFlags: program.flags || [],
        armNote: program.arm_note,
        flags,
        counts: {
          weeks: program.lengthWeeks,
          days: rows.length,
          exercises: rows.reduce((s, r) => s + r.exercises.length, 0),
        },
        headline: `${program.phaseLabel} · ${program.emphasis} · bias ${program.bias} · ${program.load_style === 'percent' ? '%1RM loading' : 'RPE loading'}`,
      };
    } catch (e) {
      out.sc = { error: e.message || 'S&C generation failed.' };
    }

    /* -------------------------- THROWING ------------------------------- */
    try {
      const isP = THROW_POSITIONS[profile.throwPos].group === 'P';
      const rdy = throwReadiness(numOrNull(whoopIn.recovery) ?? 60, whoopIn.hrvTrend, shared.soreness);
      const bench = gradeThrowing(benchVals, profile.throwLevel);
      const veloBad = !!(bench.velo && (bench.velo.status === 'def' || bench.velo.status === 'dev'));
      const drills = deficiencyDrills({ mob: gates.mob, str: gates.str, bio: gates.bio, veloBad, isP });
      const serOpts = { mob: gates.mob, str: gates.str, bio: gates.bio, isP, bench, drills };
      const program = buildThrowingProgram({
        levelId: profile.throwLevel, posId: profile.throwPos, phaseId: shared.phaseId,
        typeId: profile.athleteType, mob: gates.mob, str: gates.str, bio: gates.bio,
        ready: rdy, weekInPhase: clampInt(shared.weekInPhase, 1, 16, 1),
        weeks: weeksN, chronic: chronicWeekly, bench,
      });
      const rows = throwingToProgramDays(program, serOpts);
      const gateInfo = assessmentGates(gates.mob, gates.str, gates.bio);

      // Pitch Smart is a HARD ceiling — surface every day the engine clamped.
      const psCapped = [];
      const psRest = [];
      program.forEach((wk) => wk.days.forEach((d) => {
        if (!d.ps) return;
        if (d.ps.capped) psCapped.push(`Wk ${wk.week} ${d.day}: clamped to the Pitch Smart daily max of ${d.ps.max} pitches for ${profile.throwLevel}.`);
        if (d.ps.rest > 0) psRest.push(`Wk ${wk.week} ${d.day}: ${d.ps.pitches} pitches requires ${d.ps.rest} day(s) rest afterwards.`);
      }));
      const phase = THROW_PHASES[shared.phaseId];
      const acwrHot = program
        .filter((wk) => wk.acwr != null && wk.acwr > phase.acwr[1])
        .map((wk) => `Wk ${wk.week}: ACWR ${wk.acwr.toFixed(2)} is above this phase's ${phase.acwr[0]}–${phase.acwr[1]} window.`);

      const flags = [];
      if (psCapped.length) flags.push(...psCapped.slice(0, 5));
      if (psCapped.length > 5) flags.push(`…and ${psCapped.length - 5} more Pitch Smart caps applied.`);
      if (!gateInfo.canVelo) flags.push('High-intent / velocity work is GATED OFF by the assessment gates — mobility, strength or biomech is below threshold.');
      if (rdy.status === 'REST' || rdy.status === 'CAUTION') flags.push(`Readiness is ${rdy.status}: ${rdy.detail}`);
      if (acwrHot.length) flags.push(...acwrHot.slice(0, 4));
      if (!isP) flags.push('Position player: this plan contains defensive throwing and game days — never a mound outing or a pitch count.');
      out.throwing = {
        program, rows, serOpts, isP, ready: rdy, bench,
        gateNotes: [...gateInfo.notes, ...gateInfo.priorities],
        psRest: psRest.slice(0, 6),
        flags,
        counts: {
          weeks: program.length,
          days: rows.length,
          throws: program.reduce((s, wk) => s + wk.days.reduce((a, d) => a + (d.throws || 0), 0), 0),
        },
        headline: `${phase.label} · ${THROW_POSITIONS[profile.throwPos].label} · ${THROW_LEVELS.find((l) => l.id === profile.throwLevel)?.label || profile.throwLevel} · chronic baseline ${chronicWeekly} SU/wk`,
      };
    } catch (e) {
      out.throwing = { error: e.message || 'Throwing generation failed.' };
    }

    /* --------------------------- HITTING ------------------------------- */
    try {
      const V = {};
      HIT_METRIC_KEYS.forEach((k) => { V[k] = numOrNull(hitVals[k]); });
      const anySet = Object.values(V).some((x) => x !== null);
      if (!anySet) {
        out.hitting = { error: 'No hitting metrics on file or entered — the hitting engine grades measurements, so there is nothing to build a roadmap from. Add a hitting assessment (or type the numbers in) and rebuild.' };
      } else {
        const ageN = parseInt(profile.age, 10) || null;
        const plan = generateHittingPlan({ values: V, level: profile.hitLevel, age: ageN, weeks: weeksN, days: daysN });
        const rows = hittingToProgramDays(plan.phases, plan.plan, daysN);
        const measuredCount = Object.values(V).filter((x) => x !== null).length;
        const flags = [];
        const redFindings = plan.findings.filter((f) => f.tag === 'red');
        if (measuredCount < 4) flags.push(`Only ${measuredCount} hitting metric(s) measured. Everything unmeasured reads as "not screened" — the roadmap is shaped by a very thin slice of this athlete.`);
        if (ageN != null && ageN < 13) flags.push('Athlete is under 13: the engine shifts the phase split toward foundation and skill work and away from a power block. Confirm the volumes with the coach who sees this kid swing.');
        out.hitting = {
          plan, rows, flags,
          findings: plan.findings.slice(0, 6),
          redCount: redFindings.length,
          measuredCount,
          counts: {
            weeks: weeksN,
            days: rows.length,
            exercises: rows.reduce((s, r) => s + r.exercises.length, 0),
            phases: plan.phases.length,
          },
          headline: `${HIT_LEVEL_NAME[profile.hitLevel]} · ${plan.phases.map((ph) => ph.name).join(' → ')}`,
        };
      }
    } catch (e) {
      out.hitting = { error: e.message || 'Hitting generation failed.' };
    }

    /* -------------------------- NUTRITION ------------------------------ */
    try {
      // nutritionEngine.Sex and scProgramEngine.Sex are the same two string
      // literals ('male' / 'female'); one control drives both engines.
      const nProfile = makeProfile({
        age: parseInt(profile.age, 10) || 18,
        sex: profile.sex,
        weight_kg: (numOrNull(profile.weightLb) ?? 180) * LB_TO_KG,
        height_cm: (numOrNull(profile.heightIn) ?? 72) * IN_TO_CM,
        body_fat_pct: profile.bodyFat === '' ? null : numOrNull(profile.bodyFat),
        phase: NUTRI_PHASE_FOR[shared.phaseId] || NutriPhase.IN_SEASON,
        goal: shared.goal,
      });
      const whoop = {
        recovery_score: numOrNull(whoopIn.recovery) ?? 60,
        day_strain: numOrNull(whoopIn.strain) ?? 12,
        hrv_ms: whoopIn.hrv === '' ? null : numOrNull(whoopIn.hrv),
        hrv_baseline_ms: whoopIn.hrvBase === '' ? null : numOrNull(whoopIn.hrvBase),
        resting_hr: whoopIn.restingHr === '' ? null : numOrNull(whoopIn.restingHr),
        rhr_baseline: whoopIn.restingHr === '' ? null : numOrNull(whoopIn.restingHr),
      };
      const prefs = {
        meals_per_day: shared.mealsPerDay,
        vegetarian: shared.vegetarian,
        vegan: shared.vegan,
        allergies: shared.allergies.split(',').map((s) => s.trim()).filter(Boolean),
        dislikes: shared.dislikes.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      };
      const plan = generateNutritionPlan({
        profile: nProfile, whoop, day: shared.dayType, prefs,
        calorieOverride: shared.kcalOverride === '' ? null : numOrNull(shared.kcalOverride),
      });
      const { planDescription, meals } = planToMealRows(plan);
      const flags = [...(plan.targets.flags || [])];
      if (!profile.weightLb) flags.push('No body weight — every number in this plan is computed from a 180 lb / 72 in default athlete. Do not assign it.');
      out.nutrition = {
        plan, meals, planDescription, flags,
        notes: plan.targets.notes || [],
        counts: { meals: meals.length, calories: plan.targets.calories },
        headline: `${plan.targets.calories} kcal · P${plan.targets.protein_g} / C${plan.targets.carbs_g} / F${plan.targets.fat_g} g · recovery ${plan.targets.recovery_zone} · EA ${plan.targets.energy_availability} kcal/kg LBM`,
      };
    } catch (e) {
      out.nutrition = { error: e.message || 'Nutrition generation failed.' };
    }

    setBuilt(out);
  };

  /* ================================ SAVE ==================================
     Runs only from the review screen. Each domain is written independently and
     reports its own success or failure — one domain failing never hides or
     rolls back another. The row shapes below are the ones the four existing
     generators already write; no new columns, no new tables.

     The writes are BATCHED (see saveTrainingProgram / saveMealPlan above): a
     three-domain save is ~13 requests instead of ~224, and every step that can
     fail now cleans up after itself.
     ====================================================================== */
  const endDateFor = (weeksN) => iso(new Date(new Date(shared.programStart + 'T00:00:00').getTime() + weeksN * 7 * 24 * 60 * 60 * 1000));

  const save = async () => {
    if (!built) return;
    setSaving(true);
    setError('');
    const results = {};
    const record = (k, r) => { results[k] = r; setSaveResults({ ...results }); };
    // Progress is now per-DOMAIN STEP, not per row — there are only a handful of
    // requests left to narrate, and "writing 104 days…" is one of them.
    const stepper = (k) => (message) => record(k, { pending: true, message });

    const wantsSave = DOMAINS.filter((d) => include[d.key] && built[d.key] && !built[d.key].error);
    if (!wantsSave.length) {
      setSaving(false);
      setError('Nothing to save — every domain is either switched off or failed to build.');
      return;
    }
    if (!authorId) {
      setSaving(false);
      setError('Cannot save: no signed-in user id is available to record as the author of these programs.');
      return;
    }

    const playerId = assignAthlete && selectedId ? selectedId : null;

    for (const d of wantsSave) {
      try {
        if (d.key === 'sc') {
          const b = built.sc;
          const r = await saveTrainingProgram({
            name: names.sc || `${selectedName} — S&C Program`,
            description: `${b.program.phaseLabel} · ${b.counts.weeks}-wk progression · ${b.program.emphasis} (generated ${iso(new Date())})`,
            durationWeeks: b.counts.weeks,
            rows: b.rows,
            authorId,
            playerId,
            startDate: shared.programStart,
            endDate: endDateFor(b.counts.weeks),
            category: PROGRAM_CALENDAR_CATEGORY.sc,
            onStep: stepper('sc'),
          });
          record('sc', { ok: true, message: `Saved ${r.daysWritten} training day(s) and ${r.exercisesWritten} exercise(s) across ${b.counts.weeks} week(s)${playerId ? ` and assigned to ${selectedName}. ${describeScheduled(r.scheduled, selectedName)}` : '.'}` });
        } else if (d.key === 'throwing') {
          const b = built.throwing;
          const phase = THROW_PHASES[shared.phaseId];
          const r = await saveTrainingProgram({
            name: names.throwing || `${selectedName} — Throwing`,
            description: `${phase.label} · ${b.counts.weeks}-week ramp · ${phase.goal} (generated ${iso(new Date())})`,
            durationWeeks: b.counts.weeks,
            rows: b.rows,
            authorId,
            playerId,
            startDate: shared.programStart,
            endDate: endDateFor(b.counts.weeks),
            category: PROGRAM_CALENDAR_CATEGORY.throwing,
            onStep: stepper('throwing'),
          });
          record('throwing', { ok: true, message: `Saved ${r.daysWritten} session(s) and ${r.exercisesWritten} drill(s) across ${b.counts.weeks} week(s)${playerId ? ` and assigned to ${selectedName}. ${describeScheduled(r.scheduled, selectedName)}` : '.'}` });
        } else if (d.key === 'hitting') {
          const b = built.hitting;
          const topFindings = b.plan.findings.slice(0, 3).map((f) => f.title).join('; ');
          const r = await saveTrainingProgram({
            name: names.hitting || `${selectedName} — Hitting Roadmap`,
            description: `Hitting roadmap · ${HIT_LEVEL_NAME[profile.hitLevel]} · top priorities: ${topFindings || 'balanced'} (generated ${iso(new Date())})`,
            durationWeeks: b.counts.weeks,
            rows: b.rows,
            authorId,
            playerId,
            startDate: shared.programStart,
            endDate: endDateFor(b.counts.weeks),
            category: PROGRAM_CALENDAR_CATEGORY.hitting,
            onStep: stepper('hitting'),
          });
          record('hitting', { ok: true, message: `Saved ${r.daysWritten} day(s) and ${r.exercisesWritten} drill(s) across ${b.counts.weeks} week(s)${playerId ? ` and assigned to ${selectedName}. ${describeScheduled(r.scheduled, selectedName)}` : '.'}` });
        } else if (d.key === 'nutrition') {
          const b = built.nutrition;
          const r = await saveMealPlan({
            name: names.nutrition || `${selectedName} — Fuel Plan`,
            description: b.planDescription,
            meals: b.meals,
            authorId,
            playerId,
            startDate: shared.programStart,
            onStep: stepper('nutrition'),
          });
          record('nutrition', { ok: true, message: `Saved ${r.written} meal(s)${playerId ? ` and assigned to ${selectedName}` : ''}.` });
        }
      } catch (e) {
        record(d.key, { ok: false, message: e.message || 'Save failed.' });
      }
    }
    setSaving(false);
  };

  /* ================================ render ================================ */

  const filteredPlayers = players
    .filter((p) => p.full_name?.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 8);

  const toggleEquip = (item) =>
    setEquipment((eq) => (eq.includes(item) ? eq.filter((x) => x !== item) : [...eq, item]));

  if (!allowed) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6 flex items-start gap-3">
          <Lock className="w-5 h-5 text-gray-500 mt-0.5" />
          <div>
            <div className="font-semibold text-gray-900">Auto-Program is staff-only</div>
            <p className="text-sm text-gray-500 mt-1">
              Building and assigning training, throwing, hitting and meal programs is limited to coaches and admins.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const anyIncluded = DOMAINS.some((d) => include[d.key]);
  const savedAnything = saveResults && Object.values(saveResults).some((r) => r && r.ok);

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-3 mb-1">
        <Wand2 className="w-7 h-7 text-blue-600" />
        <h1 className="text-2xl font-bold text-gray-900">Auto-Program</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        One athlete, one pass. Fill the shared inputs once, run all four engines against this athlete's assessment
        data, review everything on one screen, then save the parts you want.
      </p>

      <div className="mb-5 rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 space-y-1.5">
        <div className="flex gap-2">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong>These are rule engines, not AI.</strong> Every prescription below comes from the same deterministic
            S&amp;C, throwing, hitting and nutrition engines the four Generate tabs use. Identical inputs always produce
            an identical program, and you can read and argue with every rule.
          </span>
        </div>
        <div className="flex gap-2">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong>Nothing is written until you press Save.</strong> Building is local — it touches no data.
          </span>
        </div>
        <div className="flex gap-2">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            The engines carry their own built-in exercise catalogue. The Programs vault (<em>Programming → Programs</em>,
            the <code>workout_templates</code> store) is <strong>not</strong> read by any generator — nothing you save
            there appears in these programs.
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>
      )}

      {/* ------------------------------ 1. athlete ------------------------- */}
      <div className={`${CARD} mb-5`}>
        <div className={EYEBROW}>1 · Athlete</div>
        <div className="relative">
          <Search className="w-4 h-4 text-gray-500 absolute left-2.5 top-2.5" />
          <input
            className="w-full border border-gray-300 rounded pl-8 pr-3 py-2 text-sm"
            placeholder="Search athletes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && filteredPlayers.length > 0 && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg">
              {filteredPlayers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectAthlete(p)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                >
                  <User className="w-4 h-4 text-gray-500" />{p.full_name}
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedName && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900">{selectedName}</span>
            {loadingAthlete && <span className="text-gray-500 text-xs">loading…</span>}
            {!loadingAthlete && <span className="text-xs text-gray-500">· {subCount} assessment(s) on file</span>}
          </div>
        )}
        {autoNote && <div className="mt-2 text-xs text-blue-700 bg-blue-50 rounded p-2">{autoNote}</div>}
        {dataWarnings.length > 0 && (
          <div className="mt-3">
            <FlagList items={dataWarnings} tone="amber" />
          </div>
        )}
      </div>

      {selectedId && (
        <>
          {/* --------------------------- 2. readiness ---------------------- */}
          <div className={`${CARD} mb-5`}>
            <div className={EYEBROW}>2 · Assessment readiness</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {ASSESSMENT_AREAS.map((a) => {
                const done = ready ? ready[a.key] : null;
                return (
                  <div
                    key={a.key}
                    className={`flex items-center gap-2 rounded border px-2.5 py-2 ${done ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}
                  >
                    {done
                      ? <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                      : <Circle className="w-4 h-4 text-gray-300 flex-shrink-0" />}
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-700 truncate">{a.label}</div>
                      <div className="text-[11px] text-gray-500">{done ? `Assessed ${fmtDate(done.date)}` : 'Not assessed'}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-[11px] text-gray-500 mt-2">
              An area counts as assessed when at least one submission carries a real, numeric metric for it. Domains
              whose area is not ready start switched OFF below.
            </div>
          </div>

          {/* --------------------- 3. shared inputs ------------------------ */}
          <div className="space-y-4 mb-5">
            <Section
              title="3 · Plan window & shared inputs"
              subtitle="Filled once here instead of four times across the four Generate tabs."
              open={open.plan}
              onToggle={() => toggleOpen('plan')}
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <span className={LBL}>Program starts</span>
                  <input type="date" className={INP} value={shared.programStart} onChange={(e) => setS('programStart', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Season start</span>
                  <input type="date" className={INP} value={shared.seasonStart} onChange={(e) => setS('seasonStart', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Season end</span>
                  <input type="date" className={INP} value={shared.seasonEnd} onChange={(e) => setS('seasonEnd', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Program length (weeks, 1–16)</span>
                  <input type="number" min="1" max="16" className={INP} value={shared.weeks} onChange={(e) => setS('weeks', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Season phase</span>
                  <select className={INP} value={shared.phaseId} onChange={(e) => setS('phaseId', e.target.value)}>
                    {THROW_PHASE_ORDER.map((k) => <option key={k} value={k}>{THROW_PHASES[k].label}</option>)}
                  </select>
                  <span className="text-[10px] text-gray-500">
                    Drives throwing + nutrition. S&amp;C derives its own phase from the dates
                    {scDerivedPhase ? `: ${PHASE_LABEL[scDerivedPhase]}` : ''}.
                  </span>
                </div>
                <div>
                  <span className={LBL}>Week in phase (throwing ramp)</span>
                  <input type="number" min="1" max="16" className={INP} value={shared.weekInPhase} onChange={(e) => setS('weekInPhase', e.target.value)} />
                  <span className="text-[10px] text-gray-500">1 = the athlete is starting this phase now (lowest volume).</span>
                </div>
                <div>
                  <span className={LBL}>Hitting days / week</span>
                  <select className={INP} value={shared.daysPerWeek} onChange={(e) => setS('daysPerWeek', e.target.value)}>
                    <option value="1">1 · Wed</option>
                    <option value="2">2 · Tue/Thu</option>
                    <option value="3">3 · Mon/Wed/Fri</option>
                  </select>
                  <span className="text-[10px] text-gray-500">S&amp;C (3–4 days) and throwing (7-day microcycle) set their own cadence from the phase.</span>
                </div>
                <div>
                  <span className={LBL}>Arm / body soreness</span>
                  <select className={INP} value={shared.soreness} onChange={(e) => setS('soreness', e.target.value)}>
                    <option value="none">None</option>
                    <option value="mild">Mild</option>
                    <option value="moderate">Moderate</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div className="col-span-2 md:col-span-4">
                  <span className={LBL}>Injury history (comma-separated: ucl, shoulder, elbow, wrist, tj_surgery…)</span>
                  <input className={INP} value={shared.injuries} onChange={(e) => setS('injuries', e.target.value)} placeholder="none" />
                  <span className="text-[10px] text-gray-500">Drives the S&amp;C exercise exclusions (Olympic lifts, heavy pressing).</span>
                </div>
              </div>

              <div className="mt-4">
                <span className={LBL}>Equipment available ({equipment.length}/{EQUIPMENT_OPTIONS.length})</span>
                <div className="flex flex-wrap gap-1.5">
                  {EQUIPMENT_OPTIONS.map((item) => (
                    <button
                      key={item}
                      onClick={() => toggleEquip(item)}
                      className={`px-2 py-1 rounded text-[11px] border ${equipment.includes(item)
                        ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-300'}`}
                    >
                      {item.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t border-gray-100">
                <div>
                  <span className={LBL}>Nutrition goal</span>
                  <select className={INP} value={shared.goal} onChange={(e) => setS('goal', e.target.value)}>
                    <option value={Goal.PERFORMANCE}>Performance</option>
                    <option value={Goal.MAINTAIN}>Maintain</option>
                    <option value={Goal.GAIN_LEAN_MASS}>Gain lean mass</option>
                    <option value={Goal.LOSE_FAT}>Lose fat</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>Fuel day type</span>
                  <select className={INP} value={shared.dayType} onChange={(e) => setS('dayType', e.target.value)}>
                    <option value={DayType.REST}>Rest day</option>
                    <option value={DayType.TRAINING}>Training day</option>
                    <option value={DayType.GAME}>Game day</option>
                    <option value={DayType.DOUBLEHEADER}>Doubleheader</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>Meals per day</span>
                  <select className={INP} value={shared.mealsPerDay} onChange={(e) => setS('mealsPerDay', parseInt(e.target.value, 10))}>
                    {[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="flex items-end gap-4 pb-1">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="checkbox" checked={shared.vegetarian} onChange={(e) => setS('vegetarian', e.target.checked)} />
                    Vegetarian
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="checkbox" checked={shared.vegan} onChange={(e) => setS('vegan', e.target.checked)} />
                    Vegan
                  </label>
                </div>
                <div className="col-span-2">
                  <span className={LBL}>Allergies (comma-separated)</span>
                  <input className={INP} value={shared.allergies} onChange={(e) => setS('allergies', e.target.value)} placeholder="none" />
                </div>
                <div className="col-span-2">
                  <span className={LBL}>Dislikes (comma-separated)</span>
                  <input className={INP} value={shared.dislikes} onChange={(e) => setS('dislikes', e.target.value)} placeholder="none" />
                </div>
                <div className="col-span-2">
                  <span className={LBL}>Coach calorie override (min {COACH_OVERRIDE_MIN_KCAL} kcal, any age; blank = engine)</span>
                  <input className={INP} type="number" min={COACH_OVERRIDE_MIN_KCAL} step="50" value={shared.kcalOverride} onChange={(e) => setS('kcalOverride', e.target.value)} placeholder="engine" />
                  {shared.kcalOverride !== '' && (
                    <div className="mt-1 text-xs text-red-700">Overrides the RED-S / youth safety guardrails. The override is noted on the saved plan.</div>
                  )}
                </div>
              </div>
            </Section>

            <Section
              title="Athlete profile"
              subtitle="Auto-filled from the athlete record and their assessments. Edit anything that's wrong before building."
              open={open.profile}
              onToggle={() => toggleOpen('profile')}
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <span className={LBL}>Age (yrs)</span>
                  <input type="number" className={INP} value={profile.age} onChange={(e) => setP('age', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Sex</span>
                  <select className={INP} value={profile.sex} onChange={(e) => setP('sex', e.target.value)}>
                    <option value={Sex.MALE}>Male</option>
                    <option value={Sex.FEMALE}>Female</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>S&amp;C position</span>
                  <select className={INP} value={profile.position} onChange={(e) => setP('position', e.target.value)}>
                    <option value={Position.POSITION}>Position player</option>
                    <option value={Position.PITCHER}>Pitcher</option>
                    <option value={Position.CATCHER}>Catcher</option>
                    <option value={Position.TWO_WAY}>Two-way</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>Throwing role</span>
                  <select className={INP} value={profile.throwPos} onChange={(e) => setP('throwPos', e.target.value)}>
                    {Object.entries(THROW_POSITIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
                <div>
                  <span className={LBL}>Throwing level</span>
                  <select className={INP} value={profile.throwLevel} onChange={(e) => setP('throwLevel', e.target.value)}>
                    {THROW_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                  <span className="text-[10px] text-gray-500">Sets the Pitch Smart caps.</span>
                </div>
                <div>
                  <span className={LBL}>Hitting level</span>
                  <select className={INP} value={profile.hitLevel} onChange={(e) => setP('hitLevel', e.target.value)}>
                    {HIT_LEVELS.map((l) => <option key={l} value={l}>{HIT_LEVEL_NAME[l]}</option>)}
                  </select>
                </div>
                <div>
                  <span className={LBL}>Throwing tolerance</span>
                  <select className={INP} value={profile.athleteType} onChange={(e) => setP('athleteType', e.target.value)}>
                    {Object.entries(ATHLETE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
                <div>
                  <span className={LBL}>Training age (months lifting)</span>
                  <input type="number" className={INP} value={profile.trainingMonths} onChange={(e) => setP('trainingMonths', e.target.value)} />
                </div>
                <div>
                  <span className={LBL}>Body weight (lb)</span>
                  <input type="number" className={INP} value={profile.weightLb} onChange={(e) => setP('weightLb', e.target.value)} placeholder="—" />
                </div>
                <div>
                  <span className={LBL}>Height (in)</span>
                  <input type="number" className={INP} value={profile.heightIn} onChange={(e) => setP('heightIn', e.target.value)} placeholder="—" />
                </div>
                <div>
                  <span className={LBL}>Body fat (%)</span>
                  <input type="number" className={INP} value={profile.bodyFat} onChange={(e) => setP('bodyFat', e.target.value)} placeholder="—" />
                </div>
                <div>
                  <span className={LBL}>Recent outing pitch count</span>
                  <input type="number" className={INP} value={profile.recentPitchCount} onChange={(e) => setP('recentPitchCount', e.target.value)} />
                </div>
              </div>
            </Section>

            <Section
              title="S&C screen values"
              subtitle="What the S&C engine reads. Blank means “not screened”, which the engine treats conservatively."
              open={open.screen}
              onToggle={() => toggleOpen('screen')}
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {SCREEN_FIELDS.map(([field, label]) => (
                  <div key={field}>
                    <span className={LBL}>{label}</span>
                    <input
                      type="number"
                      className={INP}
                      value={screen[field]}
                      onChange={(e) => setScreen((s) => ({ ...s, [field]: e.target.value }))}
                      placeholder="—"
                    />
                  </div>
                ))}
                <div>
                  <span className={LBL}>Movement competency</span>
                  <select className={INP} value={screen.movement_competency} onChange={(e) => setScreen((s) => ({ ...s, movement_competency: e.target.value }))}>
                    <option value="novice">Novice</option>
                    <option value="developing">Developing</option>
                    <option value="competent">Competent</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>Single-leg stability</span>
                  <select className={INP} value={screen.single_leg_stability} onChange={(e) => setScreen((s) => ({ ...s, single_leg_stability: e.target.value }))}>
                    <option value="">— not screened —</option>
                    <option value="poor">Poor</option>
                    <option value="fair">Fair</option>
                    <option value="good">Good</option>
                  </select>
                </div>
              </div>
              <div className="text-[10px] text-gray-500 mt-2">
                Auto-filled from the shared assessment metric registry — an explicitly tagged <code>metric_key</code>
                first, then the shared label fallback. The S&amp;C tab additionally applies its own stricter local label
                matcher, so where an assessment field carries no metric tag the two screens can disagree. Check anything
                marked <em>label-matched</em> in the review below.
              </div>
            </Section>

            <Section
              title="Hitting metrics"
              subtitle="Blank = not screened. The engine grades only what was measured."
              open={open.hit}
              onToggle={() => toggleOpen('hit')}
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {HIT_METRICS.map((m) => (
                  <div key={m.key}>
                    <span className={LBL}>{m.label}{m.unit ? ` (${m.unit})` : ''}</span>
                    <input
                      type="number"
                      className={INP}
                      value={hitVals[m.key]}
                      onChange={(e) => setHitVals((v) => ({ ...v, [m.key]: e.target.value }))}
                      placeholder="—"
                    />
                  </div>
                ))}
              </div>
            </Section>

            <Section
              title="Throwing gates & readiness"
              subtitle="Derived from the athlete's screen data and WHOOP. These gate high-intent throwing."
              open={open.throw}
              onToggle={() => toggleOpen('throw')}
            >
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[['mob', 'Mobility gate (0–100)'], ['str', 'Strength gate (0–100)'], ['bio', 'Biomech gate (0–100)']].map(([k, label]) => (
                  <div key={k}>
                    <span className={LBL}>{label}</span>
                    <input
                      type="number" min="0" max="100" className={INP}
                      value={gates[k]}
                      onChange={(e) => setGates((g) => ({ ...g, [k]: clampInt(e.target.value, 0, 100, 0) }))}
                    />
                  </div>
                ))}
                <div>
                  <span className={LBL}>WHOOP recovery</span>
                  <input type="number" min="0" max="100" className={INP} value={whoopIn.recovery} onChange={(e) => setWhoopIn((w) => ({ ...w, recovery: e.target.value }))} />
                </div>
                <div>
                  <span className={LBL}>WHOOP day strain</span>
                  <input type="number" className={INP} value={whoopIn.strain} onChange={(e) => setWhoopIn((w) => ({ ...w, strain: e.target.value }))} />
                </div>
                <div>
                  <span className={LBL}>HRV trend</span>
                  <select className={INP} value={whoopIn.hrvTrend} onChange={(e) => setWhoopIn((w) => ({ ...w, hrvTrend: e.target.value }))}>
                    <option value="up">Up</option>
                    <option value="flat">Flat</option>
                    <option value="down">Down</option>
                  </select>
                </div>
                <div>
                  <span className={LBL}>Velocity benchmark (mph)</span>
                  <input type="number" className={INP} value={benchVals.velo} onChange={(e) => setBenchVals((b) => ({ ...b, velo: e.target.value }))} placeholder="—" />
                </div>
                <div>
                  <span className={LBL}>Chronic baseline (SU/wk)</span>
                  <input className={`${INP} bg-gray-50`} value={chronicWeekly} readOnly />
                  <span className="text-[10px] text-gray-500">From the last 28 days of Trackman throws (or a seeded pattern when there are none).</span>
                </div>
              </div>
            </Section>
          </div>

          {/* ---------------------- 4. domains + build --------------------- */}
          <div className={`${CARD} mb-5`}>
            <div className={EYEBROW}>4 · What to build</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DOMAINS.map((d) => {
                const notReady = d.area ? !(ready && ready[d.area]) : includeReason.nutrition && includeReason.nutrition.startsWith('No body weight');
                const Icon = d.icon;
                return (
                  <div key={d.key} className={`rounded border p-3 ${include[d.key] ? 'border-gray-300 bg-white' : 'border-gray-200 bg-gray-50'}`}>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={include[d.key]}
                        onChange={(e) => setInclude((s) => ({ ...s, [d.key]: e.target.checked }))}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                          <Icon className={`w-4 h-4 ${d.accent}`} />{d.label}
                        </span>
                        <span className={`block text-[11px] mt-0.5 ${notReady ? 'text-amber-700' : 'text-gray-500'}`}>
                          {includeReason[d.key] || '—'}
                          {notReady ? ' — defaulted OFF.' : ''}
                        </span>
                      </span>
                    </label>
                    {notReady && include[d.key] && (
                      <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 flex gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>You've switched this on without the data behind it. The engine will fall back to defaults, so the result describes a generic athlete, not this one.</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={buildAll}
                disabled={!anyIncluded}
                className="inline-flex items-center gap-2 px-4 py-2 rounded bg-blue-600 text-white text-sm font-semibold disabled:opacity-40"
              >
                <Wand2 className="w-4 h-4" />Build full program
              </button>
              <span className="text-xs text-gray-500">Local only — writes nothing.</span>
            </div>
          </div>

          {/* --------------------------- 5. review ------------------------- */}
          {built && (
            <div className="space-y-4 mb-5">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900">5 · Review</h2>
                <span className="text-xs text-gray-500">built {new Date(built.builtAt).toLocaleTimeString()}</span>
              </div>

              <div className="rounded border border-gray-200 bg-gray-50 p-3 text-[11px] text-gray-600 flex gap-2">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-gray-500" />
                <span>
                  The assessment values listed under each domain are <strong>derived at build time</strong> from this
                  athlete's assessment submissions. They are <strong>not stored with the saved program</strong> —
                  <code className="mx-1">training_programs</code> has no columns for them, so re-opening a saved program
                  will not show you these numbers. If you need a record of what drove this build, note it now.
                </span>
              </div>

              {/* ---- S&C ---- */}
              {include.sc && built.sc && (
                <div className={CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Dumbbell className="w-5 h-5 text-blue-600" />
                      <span className="font-semibold text-gray-900">Strength &amp; Conditioning</span>
                    </div>
                    {!built.sc.error && (
                      <span className="text-xs text-gray-500">
                        {built.sc.counts.weeks} wk · {built.sc.counts.days} sessions · {built.sc.counts.exercises} exercises
                      </span>
                    )}
                  </div>
                  {built.sc.error ? (
                    <FlagList items={[built.sc.error]} tone="red" />
                  ) : (
                    <>
                      <div className="text-xs text-gray-600 mb-3">
                        {built.sc.headline} · benchmarked at <strong>{built.sc.level}</strong>
                      </div>
                      {scDerivedPhase && (
                        <div className="text-[11px] text-gray-500 mb-3">
                          S&amp;C phase is derived from the plan date against the season window ({PHASE_LABEL[scDerivedPhase]}), not from
                          the season-phase dropdown — that is how the S&amp;C engine is designed to work.
                        </div>
                      )}

                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Mobility</div>
                        <div className="text-[11px] text-gray-500 mb-2">
                          There is no separate mobility program. Mobility is prescribed as screen-driven corrective prep
                          on the first lifting day of each week, chosen from a 5-item corrective pool by the weakness tags
                          your screen values produced. What the engine picked:
                        </div>
                        <ul className="text-xs text-gray-700 space-y-1">
                          {built.sc.correctives.length ? built.sc.correctives.map((c, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-gray-300">•</span>
                              <span><strong>{c.name}</strong> — {c.rx}{c.why ? ` · ${c.why}` : ''}</span>
                            </li>
                          )) : <li className="text-gray-500 italic">No corrective blocks in week 1.</li>}
                        </ul>
                      </div>

                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">What drove it</div>
                        <DriverTable
                          keys={SC_DRIVERS} values={metrics.values} sources={metrics.sources} where={metrics.where}
                          emptyText="No canonical S&C metrics found on this athlete's assessments — the program is running on defaults and whatever you typed above."
                        />
                        <div className="mt-2">
                          <DriverTable
                            keys={SC_CAPTURED_ONLY} values={metrics.values} sources={metrics.sources} where={metrics.where}
                            emptyText=""
                            captionTone="Captured and displayed only — no calibrated benchmark band exists for these yet, so the engine grades nothing on them and they change no prescription."
                          />
                        </div>
                      </div>

                      {(built.sc.flags.length > 0) && (
                        <div className="mb-3"><FlagList items={built.sc.flags} tone="red" icon={ShieldAlert} /></div>
                      )}
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Engine safety flags — check these</div>
                        <FlagList items={built.sc.engineFlags} tone="amber" />
                      </div>
                      {built.sc.armNote && (
                        <div className="text-[11px] text-gray-500">Arm status: {built.sc.armNote}</div>
                      )}
                      <div className="mt-3">
                        <span className={LBL}>Program name</span>
                        <input className={INP} value={names.sc} onChange={(e) => setNames((n) => ({ ...n, sc: e.target.value }))} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ---- Throwing ---- */}
              {include.throwing && built.throwing && (
                <div className={CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Zap className="w-5 h-5 text-amber-600" />
                      <span className="font-semibold text-gray-900">Throwing</span>
                    </div>
                    {!built.throwing.error && (
                      <span className="text-xs text-gray-500">
                        {built.throwing.counts.weeks} wk · {built.throwing.counts.days} sessions · {built.throwing.counts.throws} total throws
                      </span>
                    )}
                  </div>
                  {built.throwing.error ? (
                    <FlagList items={[built.throwing.error]} tone="red" />
                  ) : (
                    <>
                      <div className="text-xs text-gray-600 mb-3">{built.throwing.headline}</div>
                      <div className="text-[11px] text-gray-500 mb-3">
                        Readiness: <strong>{built.throwing.ready.status}</strong> ({built.throwing.ready.score}/100) — {built.throwing.ready.headline}.
                      </div>

                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">What drove it</div>
                        <DriverTable
                          keys={THROW_DRIVERS} values={metrics.values} sources={metrics.sources} where={metrics.where}
                          emptyText="No canonical throwing / screen metrics found — the mobility, strength and biomech gates are at their neutral defaults and describe nobody."
                          captionTone="Where no mobility_score / strength_score is tagged, the gates are derived from the raw screen metrics above using the throwing generator's tuned bands."
                        />
                      </div>

                      {built.throwing.flags.length > 0 && (
                        <div className="mb-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500 mb-1.5">Safety — check these</div>
                          <FlagList items={built.throwing.flags} tone="red" icon={ShieldAlert} />
                        </div>
                      )}
                      {built.throwing.psRest.length > 0 && (
                        <div className="mb-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Pitch Smart required rest</div>
                          <FlagList items={built.throwing.psRest} tone="amber" />
                        </div>
                      )}
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Assessment gates</div>
                        <FlagList items={built.throwing.gateNotes} tone="blue" icon={Info} />
                      </div>
                      <div className="mt-3">
                        <span className={LBL}>Program name</span>
                        <input className={INP} value={names.throwing} onChange={(e) => setNames((n) => ({ ...n, throwing: e.target.value }))} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ---- Hitting ---- */}
              {include.hitting && built.hitting && (
                <div className={CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Target className="w-5 h-5 text-purple-600" />
                      <span className="font-semibold text-gray-900">Hitting</span>
                    </div>
                    {!built.hitting.error && (
                      <span className="text-xs text-gray-500">
                        {built.hitting.counts.weeks} wk · {built.hitting.counts.days} days · {built.hitting.counts.exercises} blocks · {built.hitting.counts.phases} phases
                      </span>
                    )}
                  </div>
                  {built.hitting.error ? (
                    <FlagList items={[built.hitting.error]} tone="red" />
                  ) : (
                    <>
                      <div className="text-xs text-gray-600 mb-3">{built.hitting.headline}</div>
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                          Top findings ({built.hitting.redCount} high-priority)
                        </div>
                        <ul className="text-xs text-gray-700 space-y-1">
                          {built.hitting.findings.map((f, i) => (
                            <li key={i} className="flex gap-2">
                              <span className={f.tag === 'red' ? 'text-red-500' : 'text-amber-500'}>•</span>
                              <span><strong>{f.title}</strong> — {f.measured}</span>
                            </li>
                          ))}
                          {!built.hitting.findings.length && <li className="text-gray-500 italic">No deficiencies flagged against this level.</li>}
                        </ul>
                      </div>
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">What drove it</div>
                        <DriverTable
                          keys={HIT_DRIVERS} values={metrics.values} sources={metrics.sources} where={metrics.where}
                          emptyText="No canonical hitting metrics on file — anything shown above came from what you typed in."
                        />
                      </div>
                      {built.hitting.flags.length > 0 && (
                        <div className="mb-3"><FlagList items={built.hitting.flags} tone="red" icon={ShieldAlert} /></div>
                      )}
                      <div className="mt-3">
                        <span className={LBL}>Program name</span>
                        <input className={INP} value={names.hitting} onChange={(e) => setNames((n) => ({ ...n, hitting: e.target.value }))} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ---- Nutrition ---- */}
              {include.nutrition && built.nutrition && (
                <div className={CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Utensils className="w-5 h-5 text-emerald-600" />
                      <span className="font-semibold text-gray-900">Nutrition &amp; Meals</span>
                    </div>
                    {!built.nutrition.error && (
                      <span className="text-xs text-gray-500">{built.nutrition.counts.meals} meals · {built.nutrition.counts.calories} kcal/day</span>
                    )}
                  </div>
                  {built.nutrition.error ? (
                    <FlagList items={[built.nutrition.error]} tone="red" />
                  ) : (
                    <>
                      <div className="text-xs text-gray-600 mb-3">{built.nutrition.headline}</div>
                      <ul className="text-xs text-gray-700 space-y-1 mb-3">
                        {built.nutrition.meals.map((m, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-gray-300">•</span>
                            <span><strong>{m.name}</strong> — {m.calories} kcal · P{m.protein_g}/C{m.carbs_g}/F{m.fat_g}g</span>
                          </li>
                        ))}
                      </ul>
                      <div className="mb-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">What drove it</div>
                        <DriverTable
                          keys={NUTRI_DRIVERS} values={metrics.values} sources={metrics.sources} where={metrics.where}
                          emptyText="No anthropometric metrics on file — weight, height and body fat came from the athlete record or the defaults."
                          captionTone="Recovery, strain and HRV come from WHOOP (whoop_cycles), not from an assessment."
                        />
                      </div>
                      {built.nutrition.flags.length > 0 && (
                        <div className="mb-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500 mb-1.5">Guardrails — check these</div>
                          <FlagList items={built.nutrition.flags} tone="red" icon={ShieldAlert} />
                        </div>
                      )}
                      {built.nutrition.notes.length > 0 && <FlagList items={built.nutrition.notes} tone="blue" icon={Info} />}
                      <div className="mt-3">
                        <span className={LBL}>Meal plan name</span>
                        <input className={INP} value={names.nutrition} onChange={(e) => setNames((n) => ({ ...n, nutrition: e.target.value }))} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---------------------------- 6. save -------------------------- */}
          {built && (
            <div className={`${CARD} sticky bottom-4 shadow-lg`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-gray-600">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={assignAthlete} onChange={(e) => setAssignAthlete(e.target.checked)} />
                    Assign to {selectedName} and add to their schedule from {fmtDate(shared.programStart)}
                  </label>
                  <div className="text-[11px] text-gray-500 mt-1">
                    Will write:{' '}
                    {DOMAINS.filter((d) => include[d.key] && built[d.key] && !built[d.key].error).map((d) => d.label).join(', ') || 'nothing'}
                  </div>
                </div>
                <button
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded bg-green-600 text-white text-sm font-semibold disabled:opacity-40"
                >
                  <Save className="w-4 h-4" />{saving ? 'Saving…' : 'Save included programs'}
                </button>
              </div>

              {saveResults && (
                <div className="mt-4 space-y-2">
                  {DOMAINS.filter((d) => saveResults[d.key]).map((d) => {
                    const r = saveResults[d.key];
                    return (
                      <div
                        key={d.key}
                        className={`text-xs rounded border p-2.5 flex gap-2 ${r.pending
                          ? 'border-blue-200 bg-blue-50 text-blue-800'
                          : r.ok
                            ? 'border-green-200 bg-green-50 text-green-800'
                            : 'border-red-300 bg-red-50 text-red-800'}`}
                      >
                        {/* pending = a step of THIS domain is in flight (a handful of
                            batched requests, not one per row) */}
                        {r.pending
                          ? <Circle className="w-4 h-4 flex-shrink-0 mt-0.5 animate-pulse" />
                          : r.ok
                            ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                        <span><strong>{d.label}:</strong> {r.message}</span>
                      </div>
                    );
                  })}
                  {savedAnything && (
                    <div className="text-[11px] text-gray-500">
                      Saved programs appear in Programming → Programs (and meal plans under Meal Plans). Only the
                      domains listed above were written — anything not listed was switched off or failed to build.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
