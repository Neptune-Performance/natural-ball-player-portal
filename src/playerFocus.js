/* ============================================================================
   playerFocus.js — #496 "3 things to work on" for coaches. THE one place to
   tune what the Player Card recommends. (The views that draw it are in
   FocusAreas.js.)

   Cordell: "When a coach / admin looks up any athlete and clicks on their
   profile it gives the coach 3 things they need to work on improving with the
   athlete based on their assessment / lifting numbers ... hover over the
   player card skill sets and have 3 things it recommends ... with drills
   included per skill."

   Where a recommendation comes from
   ---------------------------------
   1. NUMBERS. Every graded metric on the card (playerRatings.js) already has a
      0-99 rating against the athlete's age group. The lowest-rated metrics in
      a skill are that skill's focus areas. METRIC_FOCUS below says, per
      metric, what the goal is and which drills go with it.
   2. COACH EYES. A deficiency a coach flagged in a Mechanics note in the last
      FLAG_WINDOW_DAYS is a focus area too, with the corrective drills from
      Cordell's own deficiency list (mechanicsDeficiencies.js).
   3. GAPS. If a skill has some numbers but a core test is missing, "get a
      baseline" fills a leftover spot. A skill with nothing measured says so —
      a recommendation is never invented from no data.

   Drills
   ------
   `videos`  exact names from the Exercise Library (exercise_videos). The card
             links each one to its video. Every name here existed in the
             library, with a video, on 2026-11-27 (2,230 entries); a name that
             is later renamed still shows, just without a link.
   `checks`  [area, deficiency name] pairs from mechanicsDeficiencies.js: the
             mechanical causes most worth looking for when that number is low.
             The drill text and source link shown are that list's own, so
             editing the deficiency list updates these too. playerFocus.test.js
             fails if a pair here stops matching the list.
   `habits`  plain actions, for WHOOP (there is no drill for sleep).

   Ranking: a metric scores 100 - rating, so the bottom of the age group (40)
   scores 60 and the middle (70) scores 30. A coach-flagged deficiency scores
   FLAG_BASE_SCORE (+FLAG_REPEAT_BONUS per extra note, capped at
   FLAG_MAX_SCORE) — about the same as a metric rated 55 — so a clearly weak
   number outranks a single flag, and a flag outranks a middling number.
   ========================================================================== */

import { RATING_CATEGORIES, formatMetricValue, metricBasis } from './playerRatings';
import { mechanicsDeficiencyInfo } from './mechanicsDeficiencies';

export const FOCUS_COUNT = 3;
export const FLAG_WINDOW_DAYS = 180;
export const FLAG_BASE_SCORE = 45;
export const FLAG_REPEAT_BONUS = 5;
export const FLAG_MAX_SCORE = 60;
export const DRILLS_PER_ITEM = 3;

// Rating bands for the tag on a metric recommendation. 70 is the middle of the
// athlete's age group (see playerRatings.js).
export const PRIORITY_BELOW = 55;
export const DEVELOP_BELOW = 70;

// A Mechanics note's area -> the card skills it speaks to.
export const AREA_CATEGORIES = {
  hitting: ['hitting'],
  pitching_throwing: ['pitching', 'throwing'],
  catching: ['fielding'],
  fielding: ['fielding'],
  base_running: ['base_running'],
};

// What grades each skill, for the "nothing measured yet" line.
export const CATEGORY_SOURCE = {
  hitting: 'the Hitting Assessment',
  fielding: 'a coach rating, catcher pop times in Practice Stats, or season fielding stats',
  throwing: 'the Pitching/Throwing Assessment (pulldown and shuffle-fire velo)',
  pitching: 'the Pitching/Throwing Assessment or a Trackman session',
  base_running: 'the Base Running Assessment',
  lifting: 'the Strength & Conditioning Assessment',
  whoop: 'a connected WHOOP strap',
  game_play: 'season stats or practice logs on the Stats tab',
};

// `baseline: true` = a core test worth asking for when it is the one missing.
export const METRIC_FOCUS = {
  // ---- Hitting -----------------------------------------------------------
  hit_ev_tee: {
    goal: 'Drive the ball harder off the tee', baseline: true,
    videos: ['Offset Rotation with Weighted Bats and Hitting Plyos off Tee or Flips', 'Med Ball Scoop Throw'],
    checks: [['hitting', 'Arms-only swing / no hip rotation'], ['hitting', 'No hip-hand separation at foot strike']],
  },
  hit_ev_ft: {
    goal: 'Carry tee power into a moving ball', baseline: true,
    videos: ['Angled Front Toss Bounce BP', 'Hit it Flush with Smash Bat and Mini Hitting Plyos off BP or Machine'],
    checks: [['hitting', 'Consistently late or early'], ['hitting', 'Contact point too deep / too far out front']],
  },
  hit_batspeed: {
    goal: 'Swing the bat faster', baseline: true,
    videos: ['Regular (Underload) off Tee or Flips', 'Regular (Weighted Bats) off Tee or Flips'],
    checks: [['hitting', 'Stopping rotation at contact'], ['hitting', "Doesn't load into back leg / no coil"]],
  },
  hit_ttc: {
    goal: 'Get the barrel to the ball quicker', baseline: true,
    videos: ['Barrel Turn Feels', 'Late / Deep Tee Drill'],
    checks: [['hitting', 'Casting / bar arm'], ['hitting', 'Barrel drops below hands early (loop)']],
  },

  // ---- Fielding ----------------------------------------------------------
  fld_pop_time: {
    goal: 'Cut the pop time',
    videos: ['PlyoCare Catcher Step Backs', 'Rapid Fire Transfers'],
    checks: [['catching', 'Slow transfer (catching too deep)'], ['catching', 'Footwork too slow or too big']],
  },
  fld_season_fpct: {
    goal: 'Make the routine play every time',
    videos: ['Routine Groundball Infielding', 'Kneeling Glove Work'],
    checks: [['fielding', 'Feet stop before ball arrives'], ['fielding', 'Slow or fumbled transfer']],
  },

  // ---- Throwing ----------------------------------------------------------
  thr_pulldown: {
    goal: 'Build arm speed and intent', baseline: true,
    videos: ['Drill: Plyo-ball pulldowns', 'Driveline Extension Long Toss Series'],
    checks: [['pitching_throwing', 'Crow hop too big, too small, or absent'], ['pitching_throwing', 'Poor hip-shoulder separation']],
  },
  thr_shuffle: {
    goal: 'Throw harder from a fielding position', baseline: true,
    videos: ['PlyoCare Step Backs', 'PlyoCare Rocker Throws'],
    checks: [['pitching_throwing', 'Throwing flat-footed / feet not under body'], ['pitching_throwing', 'Hips never fully rotate (all arm)']],
  },

  // ---- Pitching ----------------------------------------------------------
  pit_fb_velo: {
    goal: 'Add fastball velocity',
    videos: ['Mound Plyo Rocker Velo', 'PlyoCare Roll-In Throws'],
    checks: [['pitching_throwing', 'Front knee not braced at foot strike (soft landing)'], ['pitching_throwing', 'Poor hip-shoulder separation']],
  },
  pit_fb_spin: {
    goal: 'Get behind the ball for more spin',
    videos: ['PlyoCare Pivot Pickoffs', 'PlyoCare Reverse Throws'],
    checks: [['pitching_throwing', 'Wrist stiff / not behind the ball'], ['pitching_throwing', 'Grip too deep in palm or too tight']],
  },
  pit_zone_pct: {
    goal: 'Throw more strikes',
    videos: ['Command / pen drills', 'Drill: Towel drill'],
    checks: [['pitching_throwing', 'Head pulls off target / falls glove side'], ['pitching_throwing', 'Stride direction closed or open']],
  },

  // ---- Base running ------------------------------------------------------
  run_home_1st: {
    goal: 'Get out of the box faster', baseline: true,
    videos: ['Baseball Sprint Start', 'falling start sprint'],
    checks: [['base_running', 'Standing tall in first steps'], ['base_running', 'Slowing before the base']],
  },
  run_home_2nd: {
    goal: 'Tighten the turn at first',
    videos: ['curved sprint'],
    checks: [['base_running', 'Rounding first too wide or too tight'], ['base_running', 'Not tagging inside corner of base']],
  },
  run_home_3rd: {
    goal: 'Hold speed through two turns',
    videos: ['curved sprint', 'hill sprints'],
    checks: [['base_running', 'Not tagging inside corner of base'], ['base_running', 'Watching the ball instead of the coach']],
  },
  run_home_home: {
    goal: 'Hold top speed all the way around',
    videos: ['60 yard sprint', 'curved sprint'],
    checks: [['base_running', 'Running with tension'], ['base_running', 'Arms crossing body / head bobbing']],
  },
  run_steal: {
    goal: 'Quicker first step on the steal', baseline: true,
    videos: ['First Base Steal', 'Primary Lead'],
    checks: [['base_running', 'False step backward'], ['base_running', 'Crossover step slow or high']],
  },
  run_route_grade: {
    goal: 'Cleaner routes and reads',
    videos: ['Secondary Lead', 'Leadoff'],
    checks: [['base_running', 'Wrong angle out of the box (straight vs round)'], ['base_running', "Not reading outfielder's angle on fly balls"]],
  },
  run_sprint10: {
    goal: 'First-step acceleration',
    videos: ['Sled Push', 'half kneeling sprints', 'Pogo Hops'],
    checks: [],
  },

  // ---- Lifting -----------------------------------------------------------
  lift_vert: {
    goal: 'Build vertical power', baseline: true,
    videos: ['Box Jump', 'Depth jump (to no box)', 'Kettlebell Swing (power)'],
    checks: [],
  },
  lift_approach: {
    goal: 'Turn a run-up into height', baseline: true,
    videos: ['Approach Box Jump', 'Pogo Hops', 'depth drop to vertical jump'],
    checks: [],
  },
  lift_broad: {
    goal: 'Build horizontal power', baseline: true,
    videos: ['Broad Jump to Stick Landing', 'Hip Thrust', 'Med Ball Scoop Throw to Broad Jump'],
    checks: [],
  },
  lift_grip: {
    goal: 'Strengthen the grip', baseline: true,
    videos: ['Farmers Walk', 'Dead Hang', 'Plate Pinch'],
    checks: [],
  },
  lift_pushups: {
    goal: 'Build upper-body strength endurance', baseline: true,
    videos: ['Eccentric Push Up', 'Feet Elevated Push Up', 'DB Bench Press'],
    checks: [],
  },

  // ---- WHOOP (habits, not drills) ----------------------------------------
  whoop_recovery: {
    goal: 'Raise average recovery',
    habits: [
      'Same bedtime and wake time every day, weekends included',
      'Fluids and a real meal within an hour of training',
      'Ease the next session after two red recovery days in a row',
    ],
  },
  whoop_sleep_hrs: {
    goal: 'Sleep longer',
    habits: [
      'Plan for 8+ hours in bed on school nights',
      'Screens off 30 minutes before bed',
      'Keep the room cool and dark',
    ],
  },
  whoop_wear_pct: {
    goal: 'Wear the strap every day',
    habits: [
      'Charge it on the wrist with the battery pack so it never comes off',
      'Open the WHOOP app each morning so a gap gets noticed the same day',
    ],
  },

  // ---- Game play ---------------------------------------------------------
  gp_season_obp: {
    goal: 'Get on base more often',
    videos: ['Angled Front Toss Bounce BP'],
    checks: [['hitting', 'Consistently late or early'], ['hitting', 'Different swing for every location']],
  },
  gp_season_ops: {
    goal: 'Do more damage on contact',
    videos: ['Offset Rotation with Weighted Bats and Hitting Plyos off Tee or Flips'],
    checks: [['hitting', 'Cutting swing off / no extension'], ['hitting', 'Attack angle too steep (chopping)']],
  },
  gp_on_base_pct: {
    goal: 'Win more practice at-bats',
    videos: ['Angled Front Toss Bounce BP'],
    checks: [['hitting', 'Consistently late or early'], ['hitting', 'Eyes come off ball']],
  },
  gp_season_whip: {
    goal: 'Put fewer runners on base',
    videos: ['Command / pen drills'],
    checks: [['pitching_throwing', 'Head pulls off target / falls glove side'], ['pitching_throwing', 'Glove side flies open too early']],
  },
  gp_whip: {
    goal: 'Put fewer runners on base in outings',
    videos: ['Command / pen drills'],
    checks: [['pitching_throwing', 'Head pulls off target / falls glove side'], ['pitching_throwing', 'Glove side flies open too early']],
  },
  gp_season_era: {
    goal: 'Limit the damage',
    videos: ['Command / pen drills'],
    checks: [['pitching_throwing', 'Release too early (sails) or too late (yanks)'], ['pitching_throwing', 'Not finishing over front leg; standing up']],
  },
  gp_season_k_pct: {
    goal: 'Miss more bats',
    videos: ['PlyoCare Pivot Pickoffs'],
    checks: [['pitching_throwing', 'No pronation through release'], ['pitching_throwing', 'Wrist stiff / not behind the ball']],
  },
  gp_strike_pct: {
    goal: 'Fill the strike zone',
    videos: ['Drill: Towel drill', 'Command / pen drills'],
    checks: [['pitching_throwing', 'Stride direction closed or open'], ['pitching_throwing', 'Falling off mound laterally']],
  },
};

export const videoKey = (name) => String(name || '').trim().toLowerCase();

// Every Exercise Library name the config can show, for one lookup query.
export function focusVideoNames() {
  const names = new Set();
  for (const f of Object.values(METRIC_FOCUS)) for (const v of f.videos || []) names.add(v);
  return [...names];
}

export function priorityTag(rating) {
  if (rating == null) return null;
  if (rating < PRIORITY_BELOW) return 'priority';
  if (rating < DEVELOP_BELOW) return 'develop';
  return 'sharpen';
}

export const TAG_LABELS = {
  priority: 'Priority',
  develop: 'Develop',
  sharpen: 'Sharpen',
  flagged: 'Coach flagged',
  baseline: 'No number yet',
};

// Up to DRILLS_PER_ITEM lines for a metric: two library videos and one
// mechanical cause to check when there are both, filled from whichever is left.
function metricDrills(focus, videoMap) {
  const habits = (focus.habits || []).map((name) => ({ kind: 'habit', name }));
  if (habits.length) return habits.slice(0, DRILLS_PER_ITEM);

  const videos = (focus.videos || []).map((name) => ({
    kind: 'video', name, url: videoMap?.[videoKey(name)] || null,
  }));
  const checks = (focus.checks || []).map(([area, name]) => {
    const info = mechanicsDeficiencyInfo(area, name);
    return info ? { kind: 'check', name: info.drills, forDeficiency: info.name, url: info.link?.url || null, linkLabel: info.link?.label || null } : null;
  }).filter(Boolean);

  return [videos[0], videos[1], checks[0], checks[1], videos[2]].filter(Boolean).slice(0, DRILLS_PER_ITEM);
}

// Deficiencies flagged in Mechanics notes inside the window, per card skill:
// { [categoryKey]: [{ area, name, count, last }] }, most-flagged first.
export function flaggedDeficiencies(notes, today = new Date()) {
  const cutoff = new Date(today.getTime() - FLAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const byKey = {};
  for (const n of notes || []) {
    if (!n || !n.area || !Array.isArray(n.deficiencies)) continue;
    const when = n.created_at ? new Date(n.created_at) : null;
    if (when && when < cutoff) continue;
    const day = n.created_at ? String(n.created_at).slice(0, 10) : '';
    for (const raw of n.deficiencies) {
      const name = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const key = `${n.area}|${name.toLowerCase()}`;
      const cur = byKey[key] || (byKey[key] = { area: n.area, name, count: 0, last: '' });
      cur.count += 1;
      if (day > cur.last) cur.last = day;
    }
  }
  const out = {};
  for (const f of Object.values(byKey)) {
    for (const cat of AREA_CATEGORIES[f.area] || []) (out[cat] || (out[cat] = [])).push(f);
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return out;
}

/**
 * The focus areas for every skill on the card.
 * @param model     buildPlayerRatings() output
 * @param notes     the athlete's Mechanics notes ({ area, deficiencies, created_at })
 * @param videoMap  { [lower-cased library name]: video_url }
 * @returns { byCategory: { [key]: { items, empty, weight } }, top: [...] }
 */
export function buildFocus(model, notes, videoMap = {}, today = new Date()) {
  const flags = flaggedDeficiencies(notes, today);
  const byCategory = {};

  for (const cat of model?.categories || []) {
    const candidates = [];

    for (const m of cat.metrics) {
      const focus = METRIC_FOCUS[m.key];
      if (!focus || m.rating == null) continue;
      candidates.push({
        id: `m:${m.key}`, kind: 'metric', category: cat.key, categoryLabel: cat.label,
        title: focus.goal, metricLabel: m.label, rating: m.rating,
        tag: priorityTag(m.rating),
        detail: `${m.label}: ${formatMetricValue(m)} · rated ${m.rating}`,
        basis: metricBasis(m),
        score: 100 - m.rating,
        drills: metricDrills(focus, videoMap),
      });
    }

    for (const f of flags[cat.key] || []) {
      const info = mechanicsDeficiencyInfo(f.area, f.name);
      candidates.push({
        id: `f:${f.area}:${f.name.toLowerCase()}`, kind: 'flag', category: cat.key, categoryLabel: cat.label,
        title: f.name, tag: 'flagged', rating: null,
        detail: `Flagged in ${f.count === 1 ? 'a Mechanics note' : `${f.count} Mechanics notes`}${f.last ? ` · last ${f.last}` : ''}`,
        basis: info?.group || null,
        score: Math.min(FLAG_MAX_SCORE, FLAG_BASE_SCORE + FLAG_REPEAT_BONUS * (f.count - 1)),
        drills: info
          ? [{ kind: 'check', name: info.drills, url: info.link?.url || null, linkLabel: info.link?.label || null }]
          : [],
      });
    }

    candidates.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const items = candidates.slice(0, FOCUS_COUNT);

    // Leftover spots: a core test that has no number yet — only when the skill
    // already has something to stand on, so an untested skill is not padded
    // out with three "go test it" lines.
    if (items.length > 0 && items.length < FOCUS_COUNT) {
      for (const m of cat.metrics) {
        if (items.length >= FOCUS_COUNT) break;
        const focus = METRIC_FOCUS[m.key];
        if (!focus?.baseline || m.value != null) continue;
        items.push({
          id: `b:${m.key}`, kind: 'baseline', category: cat.key, categoryLabel: cat.label,
          title: `Get a baseline: ${m.label}`, tag: 'baseline', rating: null,
          detail: `Not measured yet. Comes from ${CATEGORY_SOURCE[cat.key] || 'an assessment'}.`,
          basis: null, score: 5, drills: [],
        });
      }
    }

    let empty = null;
    if (items.length === 0) {
      empty = cat.source === 'coach'
        ? `Coach-rated ${cat.rating}, with no measured numbers behind it. Specific focus areas appear once there is data from ${CATEGORY_SOURCE[cat.key] || 'an assessment'}.`
        : `Nothing measured yet. Focus areas come from ${CATEGORY_SOURCE[cat.key] || 'an assessment'}.`;
    }
    byCategory[cat.key] = { items, empty, weight: cat.weight };
  }

  // The coach's top 3 across the whole card: the strongest candidate from each
  // skill (so the three are three different skills), weighted like Overall so
  // WHOOP habits do not crowd out baseball skills.
  const leaders = [];
  for (const [key, entry] of Object.entries(byCategory)) {
    const best = entry.items.find((it) => it.kind !== 'baseline');
    if (!best) continue;
    const weight = entry.weight == null ? 1 : entry.weight;
    leaders.push({ ...best, categoryKey: key, topScore: best.score * (0.5 + 0.5 * weight) });
  }
  leaders.sort((a, b) => b.topScore - a.topScore || a.title.localeCompare(b.title));

  return { byCategory, top: leaders.slice(0, FOCUS_COUNT) };
}

// Kept in sync with playerRatings.js by playerFocus.test.js.
export const FOCUS_METRIC_KEYS = RATING_CATEGORIES.flatMap((c) => c.metrics.map((m) => m.key));
