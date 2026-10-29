/* ============================================================================
   playerRatings.js — #474 Player Card grading. THE one place to tune ratings.

   Pipeline
   --------
   1. The server function `player_rating_inputs(player_id)` (migration
      20261029_player_ratings.sql) returns the athlete's own raw value for
      every metric they have, plus their PERCENTILE inside their age group
      (share of the group they are better than, already flipped for
      lower-is-better metrics) and the group size. It never returns another
      athlete's numbers. What each metric_key is MADE OF (which assessment
      question, Trackman column, WHOOP field) is defined in that migration.
   2. This file turns each metric into a 0-99 rating (below), averages the
      metrics into a category rating (metric `weight`), and averages the
      categories into Overall (category `weight`).
   3. A coach rating in `player_rating_overrides` REPLACES the computed number
      for that category. The 'overall' row holds the Potential letter (A-D)
      and, if set, replaces the computed Overall too.

   Metric modes
   ------------
   'percentile'  rating = RATING_FLOOR + (RATING_CEIL - RATING_FLOOR) * pct/100
                 i.e. the bottom of the age group is 40, the middle 70, the
                 top 99. No percentile (fewer than 8 athletes have the metric)
                 -> the metric is not graded.
   'absolute'    a fixed scale: `poor` maps to RATING_FLOOR, `elite` to
                 RATING_CEIL, linear and clamped. Used where an age-group
                 comparison is meaningless or the group is tiny (WHOOP,
                 practice/scrimmage stat lines). For a lower-is-better metric
                 simply give poor > elite.

   Ungraded is honest: a category with no graded metric and no coach rating
   shows "—", never an invented number.

   Age groups (see the migration for the full rule): HS graduation year from
   player_profiles.grad_year, else from date of birth; two-class bands; falls
   back to "all athletes" when the band has fewer than 15 athletes with that
   metric.
   ========================================================================== */

export const RATING_FLOOR = 40;
export const RATING_CEIL = 99;

export const COHORT_LABELS = {
  '12u': '6th grade & younger',
  ms: '7th–8th grade',
  hs_under: 'HS 9th–10th grade',
  hs_upper: 'HS 11th–12th grade',
  college: 'college / pro',
  all: 'all NBP athletes',
};

// Categories in the order Cordell listed them (#474). `short` is the label
// under the bar on the card; keep it to ~5 characters so 8 bars fit a phone.
// Category `weight` feeds Overall: Overall = weighted mean of every GRADED
// category (computed or coach-set). WHOOP counts half: it measures recovery
// habits, not baseball skill.
export const RATING_CATEGORIES = [
  {
    key: 'hitting', label: 'Hitting', short: 'HIT', weight: 1,
    metrics: [
      { key: 'hit_ev_tee', label: 'Tee exit velo (middle)', unit: 'mph', mode: 'percentile', weight: 2 },
      { key: 'hit_ev_ft', label: 'Front-toss exit velo', unit: 'mph', mode: 'percentile', weight: 1 },
      { key: 'hit_batspeed', label: 'Bat speed', unit: 'mph', mode: 'percentile', weight: 1 },
      { key: 'hit_ttc', label: 'Time to contact', unit: 's', mode: 'percentile', weight: 1, lowerIsBetter: true },
    ],
  },
  {
    // No fielding data is recorded yet (the Fielding Assessment template has 0
    // submissions as of 2026-10-29). Catcher pop time lights up when logged in
    // Practice Stats; everyone else is coach-rated.
    key: 'fielding', label: 'Fielding', short: 'FLD', weight: 1,
    metrics: [
      { key: 'fld_pop_time', label: 'Pop time (catchers)', unit: 's', mode: 'percentile', weight: 1, lowerIsBetter: true },
    ],
  },
  {
    key: 'throwing', label: 'Throwing', short: 'THR', weight: 1,
    metrics: [
      { key: 'thr_pulldown', label: 'Pulldown velo (5 oz)', unit: 'mph', mode: 'percentile', weight: 2 },
      { key: 'thr_shuffle', label: 'Shuffle-fire velo (5 oz)', unit: 'mph', mode: 'percentile', weight: 1 },
    ],
  },
  {
    key: 'pitching', label: 'Pitching', short: 'PIT', weight: 1,
    metrics: [
      // Best of the assessment reading and Trackman (last 12 months).
      { key: 'pit_fb_velo', label: 'Fastball velo', unit: 'mph', mode: 'percentile', weight: 3 },
      { key: 'pit_fb_spin', label: 'Fastball spin (Trackman)', unit: 'rpm', mode: 'percentile', weight: 1 },
      { key: 'pit_zone_pct', label: 'Zone % (Trackman)', unit: '%', mode: 'percentile', weight: 1 },
    ],
  },
  {
    // The S&C template has a "10 Yard Sprint" box that nobody has filled in
    // yet; until it is, base running is coach-rated only.
    key: 'base_running', label: 'Base Running', short: 'RUN', weight: 1,
    metrics: [
      { key: 'run_sprint10', label: '10-yard sprint', unit: 's', mode: 'percentile', weight: 1, lowerIsBetter: true },
    ],
  },
  {
    // The S&C assessment battery (power, strength, muscular endurance).
    // exercise_logs is not used: 12 athletes, all on different lifts.
    key: 'lifting', label: 'Lifting', short: 'LIFT', weight: 1,
    metrics: [
      { key: 'lift_vert', label: 'Vertical jump', unit: 'in', mode: 'percentile', weight: 1 },
      { key: 'lift_approach', label: 'Approach vertical', unit: 'in', mode: 'percentile', weight: 1 },
      { key: 'lift_broad', label: 'Broad jump', unit: 'in', mode: 'percentile', weight: 1 },
      { key: 'lift_grip', label: 'Grip strength (best hand)', unit: 'lb', mode: 'percentile', weight: 1 },
      { key: 'lift_pushups', label: 'Push-ups to failure', unit: '', mode: 'percentile', weight: 1 },
    ],
  },
  {
    // Last 30 days. Absolute scales: a recovery or sleep number means the same
    // thing at 13 and at 21.
    key: 'whoop', label: 'WHOOP', short: 'WHOOP', weight: 0.5,
    metrics: [
      { key: 'whoop_recovery', label: 'Avg recovery (30 days)', unit: '%', mode: 'absolute', poor: 33, elite: 75, weight: 2 },
      { key: 'whoop_sleep_hrs', label: 'Avg sleep (30 days)', unit: 'h', mode: 'absolute', poor: 6, elite: 9, weight: 2 },
      { key: 'whoop_wear_pct', label: 'Days worn (30 days)', unit: '%', mode: 'absolute', poor: 40, elite: 100, weight: 1 },
    ],
  },
  {
    // Practice / scrimmage / lives logs from the profile Stats tab (last 12
    // months). Uploaded GameChanger / Perfect Game files are PDFs and links,
    // not numbers, so season stats are coach-rated for now.
    key: 'game_play', label: 'Game Play', short: 'GAME', weight: 1,
    metrics: [
      { key: 'gp_strike_pct', label: 'Strike % (outings, 50+ pitches)', unit: '%', mode: 'absolute', poor: 50, elite: 68, weight: 1 },
      { key: 'gp_whip', label: 'WHIP (outings, 3+ IP)', unit: '', mode: 'absolute', poor: 2.5, elite: 0.9, weight: 1 },
      { key: 'gp_on_base_pct', label: 'On-base % (at-bats, 10+ PA)', unit: '%', mode: 'absolute', poor: 20, elite: 50, weight: 1 },
    ],
  },
];

export const POTENTIAL_GRADES = ['A', 'B', 'C', 'D'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function percentileToRating(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return Math.round(RATING_FLOOR + ((RATING_CEIL - RATING_FLOOR) * clamp(Number(pct), 0, 100)) / 100);
}

export function absoluteToRating(value, poor, elite) {
  const v = Number(value);
  if (!Number.isFinite(v) || poor === elite) return null;
  const t = clamp((v - poor) / (elite - poor), 0, 1);
  return Math.round(RATING_FLOOR + (RATING_CEIL - RATING_FLOOR) * t);
}

function weightedMean(items) {
  let sum = 0;
  let w = 0;
  for (const it of items) {
    if (it.rating == null) continue;
    sum += it.rating * it.weight;
    w += it.weight;
  }
  return w > 0 ? Math.round(sum / w) : null;
}

/**
 * Build the whole card model.
 * @param inputs rows from player_rating_inputs()
 * @param overrides rows from player_rating_overrides for this athlete
 * @returns { categories: [...], overall, overallComputed, overallOverride, potential, overallNote }
 */
export function buildPlayerRatings(inputs, overrides) {
  const byKey = {};
  for (const r of inputs || []) byKey[r.metric_key] = r;
  const ov = {};
  for (const o of overrides || []) ov[o.category] = o;

  const categories = RATING_CATEGORIES.map((cat) => {
    const metrics = cat.metrics.map((m) => {
      const row = byKey[m.key];
      if (!row) return { ...m, value: null, rating: null };
      const rating = m.mode === 'absolute'
        ? absoluteToRating(row.value, m.poor, m.elite)
        : percentileToRating(row.percentile);
      return {
        ...m,
        value: row.value == null ? null : Number(row.value),
        measuredOn: row.measured_on,
        cohort: row.cohort,
        cohortN: row.cohort_n,
        percentile: row.percentile == null ? null : Number(row.percentile),
        rating,
      };
    });
    const computed = weightedMean(metrics);
    const o = ov[cat.key];
    const override = o && o.rating != null ? Number(o.rating) : null;
    return {
      key: cat.key,
      label: cat.label,
      short: cat.short,
      weight: cat.weight,
      metrics,
      computed,
      override,
      note: o?.note || '',
      rating: override != null ? override : computed,
      source: override != null ? 'coach' : (computed != null ? 'data' : null),
    };
  });

  const overallComputed = weightedMean(categories.map((c) => ({ rating: c.rating, weight: c.weight })));
  const o = ov.overall;
  const overallOverride = o && o.rating != null ? Number(o.rating) : null;
  return {
    categories,
    overallComputed,
    overallOverride,
    overall: overallOverride != null ? overallOverride : overallComputed,
    potential: o?.potential || null,
    overallNote: o?.note || '',
    gradedCount: categories.filter((c) => c.rating != null).length,
  };
}

// Colour bands, The Show style. Full class strings so Tailwind keeps them.
export function ratingTone(r) {
  if (r == null) return { bar: 'bg-white/10', text: 'text-white/40', chip: 'bg-white/10 text-white/60' };
  if (r >= 90) return { bar: 'bg-sky-400', text: 'text-sky-300', chip: 'bg-sky-400 text-sky-950' };
  if (r >= 80) return { bar: 'bg-emerald-400', text: 'text-emerald-300', chip: 'bg-emerald-400 text-emerald-950' };
  if (r >= 65) return { bar: 'bg-yellow-300', text: 'text-yellow-200', chip: 'bg-yellow-300 text-yellow-950' };
  if (r >= 50) return { bar: 'bg-orange-400', text: 'text-orange-300', chip: 'bg-orange-400 text-orange-950' };
  return { bar: 'bg-red-500', text: 'text-red-300', chip: 'bg-red-500 text-white' };
}

export function formatMetricValue(m) {
  if (m.value == null) return '—';
  const v = m.value;
  let s;
  if (m.unit === 's') s = v.toFixed(2);
  else if (m.key === 'gp_whip') s = v.toFixed(2);
  else if (Math.abs(v) >= 100) s = String(Math.round(v));
  else s = String(Math.round(v * 10) / 10);
  return m.unit ? `${s}${m.unit === '%' ? '%' : ` ${m.unit}`}` : s;
}

// One line saying where a metric's rating came from.
export function metricBasis(m) {
  if (m.value == null) return 'Not measured yet';
  if (m.mode === 'absolute') {
    return m.rating == null ? 'Not graded' : `Scale: ${m.poor} = ${RATING_FLOOR}, ${m.elite} = ${RATING_CEIL}`;
  }
  if (m.percentile == null) return `Not graded yet (only ${m.cohortN || 0} athletes have this)`;
  return `Better than ${Math.round(m.percentile)}% of ${COHORT_LABELS[m.cohort] || m.cohort} (${m.cohortN})`;
}

// Tooltip text for a category bar.
export function categoryBasis(cat) {
  if (cat.source === 'coach') return `${cat.label}: coach rating${cat.note ? ` — ${cat.note}` : ''}`;
  if (cat.source !== 'data') return `${cat.label}: not graded yet`;
  const used = cat.metrics.filter((m) => m.rating != null).map((m) => m.label);
  return `${cat.label}: based on ${used.join(', ')}`;
}
