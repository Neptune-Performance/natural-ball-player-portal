// #457: red / yellow / green bands for every WHOOP number with a right
// direction, so an athlete can see at a glance where each one sits (the
// Prepare score already did this). One place for every threshold.
//
// - WHOOP's own scores use WHOOP's bands (recovery 67 / 34).
// - Sleep cut-offs match the whoop_nudges rules in
//   supabase/functions/whoop/nudges.ts (<7 h asleep, efficiency <85%,
//   >45 min awake) so the bell and the colours never disagree.
// - HRV, resting HR, skin temp and respiratory rate are personal, so they are
//   compared to the athlete's OWN trailing 30-day average (needs
//   BASELINE_MIN_DAYS readings first; before that they stay neutral).
// - Numbers with no right direction (calories, light sleep, workout avg/max
//   HR, duration) are deliberately left neutral — a colour here must always
//   mean good or bad.

export const RECOVERY = { green: 67, yellow: 34 };
export const SLEEP_SCORE = { green: 85, yellow: 70 };
export const ASLEEP_HOURS = { green: 8, yellow: 7 };
export const EFFICIENCY = { green: 90, yellow: 85 };
export const AWAKE_MIN = { green: 30, yellow: 45 };      // at or under
export const REM_PCT = { green: 20, yellow: 15 };         // % of time asleep
export const DEEP_PCT = { green: 16, yellow: 12 };
export const SPO2 = { green: 95, yellow: 92 };
export const DAY_STRAIN = { low: 8, greenLo: 10, greenHi: 18 };
export const WORKOUT_STRAIN = { low: 5, greenLo: 8, greenHi: 18 };
export const HRV_DROP = { yellow: 0.9 };                  // ≥ baseline green, ≥ 90% yellow
export const RHR_RISE = { green: 2, yellow: 5 };          // bpm over baseline
export const SKIN_TEMP_DEV = { green: 0.5, yellow: 1.0 }; // °C either way
export const RESP_DEV = { green: 1, yellow: 2 };          // breaths/min either way
export const BASELINE_DAYS = 30;
export const BASELINE_MIN_DAYS = 7;

export const BAND_CLASS = {
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  red: 'bg-red-100 text-red-700',
};
export const BAND_HEX = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' };

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const higher = (v, t) => (v == null ? null : v >= t.green ? 'green' : v >= t.yellow ? 'yellow' : 'red');
const lower = (v, t) => (v == null ? null : v <= t.green ? 'green' : v <= t.yellow ? 'yellow' : 'red');
const strainBand = (v, t) => (v == null ? null : v < t.low ? 'red' : v < t.greenLo || v >= t.greenHi ? 'yellow' : 'green');

export const asleepMs = (s) => {
  const total = n(s?.total_duration_ms);
  if (total == null) return null;
  return Math.max(0, total - (n(s?.awake_duration_ms) || 0));
};

export const bandRecovery = (v) => higher(n(v), RECOVERY);
export const bandSleepScore = (v) => higher(n(v), SLEEP_SCORE);
export const bandAsleep = (s) => { const ms = asleepMs(s); return ms == null ? null : higher(ms / 3_600_000, ASLEEP_HOURS); };
export const bandEfficiency = (v) => higher(n(v), EFFICIENCY);
export const bandAwake = (ms) => (n(ms) == null ? null : lower(n(ms) / 60000, AWAKE_MIN));
export const bandStagePct = (stageMs, s, t) => {
  const asleep = asleepMs(s);
  if (n(stageMs) == null || !asleep) return null;
  return higher((n(stageMs) / asleep) * 100, t);
};
export const bandRem = (s) => bandStagePct(s?.rem_duration_ms, s, REM_PCT);
export const bandDeep = (s) => bandStagePct(s?.sws_duration_ms, s, DEEP_PCT);
export const bandSpo2 = (v) => higher(n(v), SPO2);
export const bandDayStrain = (v) => strainBand(n(v), DAY_STRAIN);
export const bandWorkoutStrain = (v) => strainBand(n(v), WORKOUT_STRAIN);

/**
 * Trailing average of `field` over the BASELINE_DAYS before `date` (exclusive).
 * rows: cycles or sleep records; dateKey: 'cycle_date' | 'sleep_date'.
 */
export function baseline(rows, dateKey, field, date) {
  if (!date) return null;
  const end = new Date(date + 'T00:00:00');
  const start = new Date(end);
  start.setDate(start.getDate() - BASELINE_DAYS);
  const vals = (rows || [])
    .filter((r) => { const d = new Date(r[dateKey] + 'T00:00:00'); return d >= start && d < end; })
    .map((r) => n(r[field]))
    .filter((v) => v != null && Number.isFinite(v));
  if (vals.length < BASELINE_MIN_DAYS) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function bandHrv(v, base) {
  const x = n(v);
  if (x == null || base == null) return null;
  return x >= base ? 'green' : x >= base * HRV_DROP.yellow ? 'yellow' : 'red';
}
export function bandRhr(v, base) {
  const x = n(v);
  if (x == null || base == null) return null;
  return lower(x - base, RHR_RISE);
}
export function bandDeviation(v, base, t) {
  const x = n(v);
  if (x == null || base == null) return null;
  return lower(Math.abs(x - base), t);
}

const localToday = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** All bands for one cycle row, with personal baselines from `cycles`. */
export function cycleBands(c, cycles) {
  const d = c?.cycle_date;
  return {
    recovery: bandRecovery(c?.recovery_score),
    hrv: bandHrv(c?.hrv_rmssd, baseline(cycles, 'cycle_date', 'hrv_rmssd', d)),
    rhr: bandRhr(c?.resting_heart_rate, baseline(cycles, 'cycle_date', 'resting_heart_rate', d)),
    // Today's cycle is still accumulating strain (whoop/nudges.ts judges
    // completed days only), so it would read red every morning.
    strain: d && d < localToday() ? bandDayStrain(c?.strain_score) : null,
    spo2: bandSpo2(c?.spo2_pct),
    skinTemp: bandDeviation(c?.skin_temp_celsius, baseline(cycles, 'cycle_date', 'skin_temp_celsius', d), SKIN_TEMP_DEV),
  };
}

export function sleepBands(s, sleep) {
  return {
    score: bandSleepScore(s?.sleep_score),
    asleep: bandAsleep(s),
    efficiency: bandEfficiency(s?.sleep_efficiency),
    rem: bandRem(s),
    deep: bandDeep(s),
    awake: bandAwake(s?.awake_duration_ms),
    resp: bandDeviation(s?.respiratory_rate, baseline(sleep, 'sleep_date', 'respiratory_rate', s?.sleep_date), RESP_DEV),
  };
}

export const BAND_LEGEND = 'Green = good, yellow = watch, red = needs attention. HRV, resting HR, skin temp and breathing rate are compared to your own 30-day average.';
