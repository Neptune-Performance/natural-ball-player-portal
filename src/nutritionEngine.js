/* ============================================================================
   nutritionEngine.js — "BallFuel" WHOOP-driven daily nutrition engine.

   Dependency-free JS port of the CORE of
   "NBP Systems Development/files (2)/ballfuel.py" (pure stdlib; the scipy LP
   portion-optimizer and USDA food client are separate optional enhancements and
   are NOT part of this port). The `render` pretty-printer is UI and is skipped.

   Takes an athlete profile + a WHOOP daily readout and produces a calorie target,
   macros periodized to the day's load & recovery, hydration, a baseball-specific
   meal-timing template, and a concrete meal plan from a built-in food table.

   Safety before performance: a hard energy-availability floor (RED-S guard) and
   youth protections can override any goal. Decision support, not medical advice.
   ========================================================================== */

export const Sex = { MALE: 'male', FEMALE: 'female' };
export const Goal = {
  GAIN_LEAN_MASS: 'gain_lean_mass', LOSE_FAT: 'lose_fat', MAINTAIN: 'maintain', PERFORMANCE: 'performance',
};
export const Phase = {
  OFF_SEASON: 'off_season', PRE_SEASON: 'pre_season', IN_SEASON: 'in_season', POST_SEASON: 'post_season',
};
export const DayType = {
  REST: 'rest', TRAINING: 'training', GAME: 'game', DOUBLEHEADER: 'doubleheader',
};

/* --------------------------------------------------------------------------- *
 *  1. Energy: BMR -> maintenance TDEE
 * --------------------------------------------------------------------------- */
export function leanBodyMass(p) {
  if (p.body_fat_pct == null) return null;
  return p.weight_kg * (1 - p.body_fat_pct / 100.0);
}

export function bmrKcal(p) {
  const lbm = leanBodyMass(p);
  if (lbm != null) return 500 + 22 * lbm; // Cunningham (lean-mass based)
  const s = p.sex === Sex.MALE ? 5 : -161; // Mifflin-St Jeor
  return 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age + s;
}

const BASE_PAL = 1.30;
const PHASE_LOAD = {
  [Phase.OFF_SEASON]: 0.25, [Phase.PRE_SEASON]: 0.30, [Phase.IN_SEASON]: 0.15, [Phase.POST_SEASON]: 0.10,
};
const DAYTYPE_LOAD = {
  [DayType.REST]: 0.00, [DayType.TRAINING]: 0.25, [DayType.GAME]: 0.30, [DayType.DOUBLEHEADER]: 0.55,
};

export function strainBand(dayStrain) {
  if (dayStrain < 8) return 'light';
  if (dayStrain < 14) return 'moderate';
  if (dayStrain < 18) return 'high';
  return 'very_high';
}

export function maintenanceKcal(p, w, day) {
  const bmr = bmrKcal(p);
  const band = strainBand(w.day_strain);
  const strainAdj = { light: -0.08, moderate: 0.0, high: 0.10, very_high: 0.18 }[band];
  let load = PHASE_LOAD[p.phase] + DAYTYPE_LOAD[day];
  load = Math.max(0.0, load + strainAdj);
  const pal = BASE_PAL + load;
  let tdee; let eee;
  if (w.whoop_kcal) {
    tdee = Math.max(w.whoop_kcal, bmr * BASE_PAL);
    eee = Math.max(0.0, w.whoop_kcal - bmr * BASE_PAL);
  } else {
    tdee = bmr * pal;
    eee = Math.max(0.0, tdee - bmr * BASE_PAL);
  }
  return { tdee, eee };
}

/* --------------------------------------------------------------------------- *
 *  2. Goal adjustment + guardrails (safety can override the goal)
 * --------------------------------------------------------------------------- */
const EA_HARD_FLOOR = 30.0;
const EA_TARGET = 45.0;
const YOUTH_AGE = 18;
const MAX_GAIN_PER_WEEK = 0.005;
const MAX_LOSS_PER_WEEK = 0.0075;
// #464: a coach can set the day's calories by hand, down to this, at any age,
// to run a deficit the guardrails above would refuse. Warned, never silent.
export const COACH_OVERRIDE_MIN_KCAL = 2000;

export function applyGoalAndGuardrails(p, tdee, eee) {
  const notes = [];
  const flags = [];
  let goal = p.goal;
  const isYouth = p.age < YOUTH_AGE;

  if (isYouth && goal === Goal.LOSE_FAT) {
    goal = Goal.MAINTAIN;
    flags.push('Athlete is under 18: fat-loss goal converted to maintenance. Body-composition change in youth should come from training + growth, under a pediatric RD\'s supervision — not calorie restriction.');
  }

  let target;
  if (goal === Goal.GAIN_LEAN_MASS) {
    target = tdee * 1.12;
    const cap = tdee + (MAX_GAIN_PER_WEEK * p.weight_kg * 7700) / 7;
    if (target > cap) { target = cap; notes.push('Surplus capped to a lean rate (~0.5%/wk) to limit fat gain.'); }
  } else if (goal === Goal.LOSE_FAT) {
    const bf = p.body_fat_pct != null ? p.body_fat_pct : 15.0;
    const deficitFrac = bf < 12 ? 0.12 : (bf < 18 ? 0.15 : 0.20);
    target = tdee * (1 - deficitFrac);
    const floor = tdee - (MAX_LOSS_PER_WEEK * p.weight_kg * 7700) / 7;
    if (target < floor) { target = floor; notes.push('Deficit capped to a lean-mass-sparing rate (~0.75%/wk).'); }
  } else {
    target = tdee;
    if (goal === Goal.PERFORMANCE) notes.push('Performance mode: fueling for output & recovery, weight held.');
  }

  const lbm = leanBodyMass(p) || p.weight_kg * 0.85;
  let ea = (target - eee) / lbm;
  const eaTarget = isYouth ? EA_TARGET : EA_HARD_FLOOR;
  if (ea < eaTarget) {
    const needed = eaTarget * lbm + eee;
    if (needed > target) {
      target = needed;
      ea = (target - eee) / lbm;
      flags.push(`Calories raised to keep energy availability >= ${eaTarget.toFixed(0)} kcal/kg lean mass (guards against RED-S: hormonal, bone & recovery harm from under-fueling).`);
    }
  }
  return { target, notes, flags };
}

export function energyAvailability(targetKcal, eee, p) {
  const lbm = leanBodyMass(p) || p.weight_kg * 0.85;
  return (targetKcal - eee) / lbm;
}

/* --------------------------------------------------------------------------- *
 *  3. Macros: protein floor first, carbs periodized, fat is the balance
 * --------------------------------------------------------------------------- */
export function recoveryZone(recoveryScore) {
  if (recoveryScore >= 67) return 'green';
  if (recoveryScore >= 34) return 'yellow';
  return 'red';
}

function carbGPerKg(day, band, zone) {
  let base = { [DayType.REST]: 3.5, [DayType.TRAINING]: 5.5, [DayType.GAME]: 6.0, [DayType.DOUBLEHEADER]: 8.0 }[day];
  base += { light: -0.5, moderate: 0.0, high: 1.0, very_high: 2.0 }[band];
  base += { green: 0.5, yellow: 0.0, red: -0.3 }[zone];
  return Math.max(3.0, Math.min(base, 11.0));
}

function proteinGPerKg(p) {
  if (p.goal === Goal.LOSE_FAT) return 2.3;
  if (p.goal === Goal.GAIN_LEAN_MASS) return 2.0;
  return 1.8;
}

export function computeMacros(p, w, day, targetKcal, { override = false } = {}) {
  const notes = [];
  const zone = recoveryZone(w.recovery_score);
  const band = strainBand(w.day_strain);

  const proteinG = proteinGPerKg(p) * p.weight_kg;
  let carbG = carbGPerKg(day, band, zone) * p.weight_kg;

  const kcalFromPc = proteinG * 4 + carbG * 4;
  let fatG = (targetKcal - kcalFromPc) / 9.0;
  const fatFloorG = Math.max(0.6 * p.weight_kg, (0.18 * targetKcal) / 9.0);

  // #464: under a coach calorie override the 3 g/kg carb floor would push the
  // plan back over the target, so carbs take the remainder and, if even that
  // is not enough, protein comes down toward 1.6 g/kg and fat toward 0.5 g/kg.
  const carbFloor = override ? 0 : 3.0 * p.weight_kg;
  let proteinOut = proteinG;
  if (fatG < fatFloorG) {
    fatG = fatFloorG;
    carbG = Math.max(carbFloor, (targetKcal - proteinG * 4 - fatG * 9) / 4.0);
    notes.push('Carbs trimmed slightly to protect a minimum healthy-fat intake.');
  }

  const total = proteinG * 4 + carbG * 4 + fatG * 9;
  if (total > targetKcal) {
    carbG = Math.max(carbFloor, carbG - (total - targetKcal) / 4.0);
  }
  if (override && proteinOut * 4 + carbG * 4 + fatG * 9 > targetKcal) {
    fatG = Math.max(0.5 * p.weight_kg, (targetKcal - proteinOut * 4 - carbG * 4) / 9.0);
    proteinOut = Math.max(1.6 * p.weight_kg, (targetKcal - carbG * 4 - fatG * 9) / 4.0);
  }

  notes.push(`Recovery ${zone.toUpperCase()} / strain ${band}: carbs set to ${(carbG / p.weight_kg).toFixed(1)} g/kg, protein ${(proteinG / p.weight_kg).toFixed(1)} g/kg.`);
  return { protein: Math.round(proteinOut), carbs: Math.round(carbG), fat: Math.round(fatG), notes };
}

/* --------------------------------------------------------------------------- *
 *  4. WHOOP recovery interpretation -> coaching flags
 * --------------------------------------------------------------------------- */
export function readinessNotes(w) {
  const notes = [];
  const flags = [];
  const zone = recoveryZone(w.recovery_score);

  if (zone === 'red') {
    notes.push('RED recovery: prioritize recovery nutrition today — keep protein high, add anti-inflammatory foods (oily fish/omega-3, berries, leafy greens, tart cherry), and push fluids + electrolytes. Do not impose a calorie deficit today even if cutting.');
  } else if (zone === 'yellow') {
    notes.push('YELLOW recovery: fuel normally, hit protein evenly across meals, and stay on top of hydration and sleep tonight.');
  } else {
    notes.push('GREEN recovery: body is primed — fuel fully to support today\'s work.');
  }

  if (w.hrv_ms && w.hrv_baseline_ms) {
    const drop = (w.hrv_baseline_ms - w.hrv_ms) / w.hrv_baseline_ms;
    const rhrUp = w.resting_hr && w.rhr_baseline && w.resting_hr >= w.rhr_baseline + 5;
    const respUp = w.respiratory_rate && w.resp_baseline && w.respiratory_rate >= w.resp_baseline + 1.5;
    if (drop >= 0.12 && (rhrUp || respUp)) {
      flags.push('HRV is well below baseline with elevated resting HR / respiratory rate — possible illness or accumulated fatigue. Emphasize fluids, easy-to-digest food, and consider a lighter day; if symptoms persist, check in with medical staff.');
    }
  }
  if (w.sleep_performance_pct != null && w.sleep_performance_pct < 70) {
    notes.push('Sleep was short/poor — expect lower recovery tomorrow. Avoid heavy late meals, keep caffeine early, and prioritize a pre-sleep protein feeding.');
  }
  return { notes, flags };
}

/* --------------------------------------------------------------------------- *
 *  5. Hydration
 * --------------------------------------------------------------------------- */
export function hydrationPlan(p, day, zone) {
  const baseMl = Math.round(35 * p.weight_kg);
  const add = { [DayType.REST]: 0, [DayType.TRAINING]: 700, [DayType.GAME]: 1000, [DayType.DOUBLEHEADER]: 1800 }[day];
  const fluid = baseMl + add;
  const sodium = {
    [DayType.REST]: [1500, 2300], [DayType.TRAINING]: [2300, 3500],
    [DayType.GAME]: [3000, 4500], [DayType.DOUBLEHEADER]: [3500, 6000],
  }[day];

  const steps = [
    `Daily fluid target ~${fluid} mL (adjust to sweat rate & heat).`,
    `Pre-game: ~5-7 mL/kg (~${Math.round(6 * p.weight_kg)} mL) in the 2-4 h before first pitch; sip, don't chug.`,
  ];
  if (day === DayType.GAME || day === DayType.DOUBLEHEADER) {
    steps.push('During: drink between innings; on hot days alternate water and an electrolyte/sports drink. Use the pee-check — clear-to-pale = good.');
    steps.push('After: replace ~1.25-1.5x the body-weight lost as sweat (weigh in/out); include sodium to hold onto fluid.');
  }
  if (zone === 'red') steps.push('Low recovery: add electrolytes today even at rest to aid recovery.');
  return { fluid, sodium, steps };
}

/* --------------------------------------------------------------------------- *
 *  6. Baseball meal-timing template
 * --------------------------------------------------------------------------- */
export function timingGuidance(day, p) {
  const g = [
    `Spread protein into ~0.4 g/kg feedings every 3-4 h (~${Math.round(0.4 * p.weight_kg)} g per meal).`,
    'Pre-sleep: 30-40 g slow protein (casein/Greek yogurt/cottage cheese) to support overnight recovery.',
  ];
  if (day === DayType.GAME) {
    g.push('Pre-game meal 2-3 h out: complex carbs + moderate lean protein + LOW fat & fiber (e.g., rice + chicken + fruit). ~500-700 kcal.');
    g.push('60-30 min out: small easy carb top-up (banana, toast, chews) if hungry.');
    g.push('In-game: dugout snacks = easy-digest carbs (fruit, pretzels, PB&J, chews). Avoid greasy/high-fiber/high-protein foods mid-game.');
    g.push('Within 30-60 min post-game: carbs + protein (~1.0 g/kg carb + 20-40 g protein).');
  } else if (day === DayType.DOUBLEHEADER) {
    g.push('Between games: rapid refuel — ~0.6-1.0 g/kg carbs + ~20 g protein + fluids with sodium. Keep it light and familiar; nothing greasy.');
    g.push('This is the day glycogen runs down fastest — keep a steady carb drip all day.');
    g.push('After the last game: full carb+protein recovery meal within the hour.');
  } else if (day === DayType.TRAINING) {
    g.push('Around lifting/practice: carbs + protein before and within ~1 h after (~1.2 g/kg/h carb + 0.2-0.5 g/kg/h protein when refueling fast).');
  } else {
    g.push('Rest day: still eat evenly — this is when adaptation & repair happen.');
  }
  return g;
}

/* --------------------------------------------------------------------------- *
 *  7. Food database + meal assembler
 * --------------------------------------------------------------------------- */
export const FOODS = {
  'chicken breast': { kcal: 165, p: 31, c: 0, f: 3.6, tags: ['meat', 'easy'] },
  'lean ground turkey': { kcal: 170, p: 27, c: 0, f: 7, tags: ['meat'] },
  salmon: { kcal: 208, p: 20, c: 0, f: 13, tags: ['fish', 'omega3'] },
  eggs: { kcal: 143, p: 13, c: 1, f: 10, tags: ['veg', 'easy'] },
  'greek yogurt': { kcal: 59, p: 10, c: 3.6, f: 0.4, tags: ['veg', 'dairy', 'slow_protein', 'easy'] },
  'cottage cheese': { kcal: 98, p: 11, c: 3.4, f: 4.3, tags: ['veg', 'dairy', 'slow_protein'] },
  tofu: { kcal: 76, p: 8, c: 1.9, f: 4.8, tags: ['veg', 'vegan'] },
  'lentils cooked': { kcal: 116, p: 9, c: 20, f: 0.4, tags: ['veg', 'vegan', 'fiber'] },
  'whey protein': { kcal: 400, p: 80, c: 8, f: 6, tags: ['veg', 'dairy', 'supplement'] },
  'white rice cooked': { kcal: 130, p: 2.4, c: 28, f: 0.3, tags: ['veg', 'vegan', 'easy', 'gluten_free'] },
  'brown rice cooked': { kcal: 123, p: 2.7, c: 26, f: 1, tags: ['veg', 'vegan', 'fiber', 'gluten_free'] },
  oats: { kcal: 389, p: 17, c: 66, f: 7, tags: ['veg', 'vegan', 'fiber'] },
  'sweet potato': { kcal: 86, p: 1.6, c: 20, f: 0.1, tags: ['veg', 'vegan', 'easy', 'gluten_free'] },
  banana: { kcal: 89, p: 1.1, c: 23, f: 0.3, tags: ['veg', 'vegan', 'easy', 'gluten_free', 'gameday'] },
  'whole wheat pasta': { kcal: 124, p: 5, c: 25, f: 0.9, tags: ['veg', 'vegan', 'fiber'] },
  'white bagel': { kcal: 250, p: 10, c: 48, f: 1.5, tags: ['veg', 'vegan', 'easy', 'gameday'] },
  berries: { kcal: 57, p: 0.7, c: 14, f: 0.3, tags: ['veg', 'vegan', 'omega3_support', 'gluten_free'] },
  'olive oil': { kcal: 884, p: 0, c: 0, f: 100, tags: ['veg', 'vegan', 'gluten_free'] },
  almonds: { kcal: 579, p: 21, c: 22, f: 50, tags: ['veg', 'vegan', 'nuts', 'fiber'] },
  avocado: { kcal: 160, p: 2, c: 9, f: 15, tags: ['veg', 'vegan', 'gluten_free'] },
  'peanut butter': { kcal: 588, p: 25, c: 20, f: 50, tags: ['veg', 'vegan', 'nuts', 'gameday'] },
  'mixed vegetables': { kcal: 65, p: 2.6, c: 13, f: 0.3, tags: ['veg', 'vegan', 'fiber', 'gluten_free'] },
  spinach: { kcal: 23, p: 2.9, c: 3.6, f: 0.4, tags: ['veg', 'vegan', 'gluten_free'] },
};

function has(tags, t) { return tags.indexOf(t) > -1; }

function allowed(food, prefs) {
  const info = FOODS[food];
  const tags = info.tags;
  if (prefs.vegan && !has(tags, 'vegan')) return false;
  if (prefs.vegetarian && !(has(tags, 'veg') || has(tags, 'vegan'))) return false;
  for (let a of prefs.allergies || []) {
    a = String(a).toLowerCase();
    if (a === 'gluten' && !has(tags, 'gluten_free') && ['whole wheat pasta', 'white bagel', 'oats'].includes(food)) return false;
    if (a === 'dairy' && has(tags, 'dairy')) return false;
    if (['nuts', 'nut', 'peanut'].includes(a) && has(tags, 'nuts')) return false;
    if (['fish', 'seafood'].includes(a) && has(tags, 'fish')) return false;
    if (['egg', 'eggs'].includes(a) && food === 'eggs') return false;
  }
  if ((prefs.dislikes || []).includes(food)) return false;
  return true;
}

function filtered(pool, prefs, wantGameday = false) {
  let cands = pool.filter((f) => allowed(f, prefs));
  if (wantGameday) {
    const gd = cands.filter((f) => has(FOODS[f].tags, 'gameday') || has(FOODS[f].tags, 'easy'));
    cands = gd.length ? gd : cands;
  }
  return cands.length ? cands : [...pool];
}

function addFood(food, grams) {
  const i = FOODS[food];
  const g = Math.max(0.0, grams) / 100.0;
  return {
    food, grams: Math.round(grams), kcal: Math.round(i.kcal * g),
    protein_g: Math.round(i.p * g * 10) / 10, carbs_g: Math.round(i.c * g * 10) / 10, fat_g: Math.round(i.f * g * 10) / 10,
  };
}

const PROTEIN_POOL = ['chicken breast', 'salmon', 'lean ground turkey', 'eggs', 'greek yogurt', 'cottage cheese', 'tofu', 'lentils cooked', 'whey protein'];
const CARB_POOL = ['oats', 'sweet potato', 'brown rice cooked', 'banana', 'white rice cooked', 'whole wheat pasta', 'white bagel', 'berries'];
const FAT_POOL = ['avocado', 'almonds', 'peanut butter', 'olive oil'];
const VEG_POOL = ['mixed vegetables', 'spinach', 'berries'];

export function assembleMeals(t, prefs, day) {
  const n = Math.max(3, prefs.meals_per_day || 4);
  const names = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Snack 2', 'Pre-sleep'].slice(0, n);

  const gameday = day === DayType.GAME || day === DayType.DOUBLEHEADER;
  const proteins = filtered(PROTEIN_POOL.filter((f) => !has(FOODS[f].tags, 'supplement')), prefs);
  const carbs = filtered(CARB_POOL, prefs, gameday);
  const fats = filtered(FAT_POOL, prefs);
  const slow = filtered(['greek yogurt', 'cottage cheese', 'whey protein'], prefs);
  const veg = filtered(VEG_POOL, prefs);

  const pW = Array(n).fill(1.0);
  if (n >= 4) pW[n - 1] = 1.2;
  const pTotal = pW.reduce((a, b) => a + b, 0);

  const meals = [];
  for (let idx = 0; idx < names.length; idx += 1) {
    const name = names[idx];
    const share = pW[idx] / pTotal;
    const mP = t.protein_g * share;
    const mC = t.carbs_g / n;
    const mF = t.fat_g / n;
    const items = [];

    const pf = name === 'Pre-sleep' ? slow[idx % slow.length] : proteins[idx % proteins.length];
    const gramsP = FOODS[pf].p ? mP / (FOODS[pf].p / 100.0) : 0;
    let it = addFood(pf, gramsP);
    items.push(it);
    let gotC = it.carbs_g; let gotF = it.fat_g;

    const cf = carbs[idx % carbs.length];
    const gramsC = FOODS[cf].c ? Math.max(0, mC - gotC) / (FOODS[cf].c / 100.0) : 0;
    it = addFood(cf, gramsC);
    items.push(it);
    gotF += it.fat_g;

    if ((name === 'Lunch' || name === 'Dinner') && day !== DayType.DOUBLEHEADER) {
      const vf = veg[idx % veg.length];
      items.push(addFood(vf, 120));
    }

    const needF = mF - gotF;
    if (needF > 2) {
      const ff = fats[idx % fats.length];
      items.push(addFood(ff, needF / (FOODS[ff].f / 100.0)));
    }

    const timing = {
      Breakfast: 'morning', Lunch: 'midday', Dinner: 'evening', Snack: 'afternoon',
      'Snack 2': 'pre/post training', 'Pre-sleep': '~30-60 min before bed',
    }[name] || '';
    meals.push({ name, timing, items });
  }
  return meals;
}

export function mealTotals(meal) {
  return meal.items.reduce((a, i) => ({
    kcal: a.kcal + i.kcal, protein: a.protein + i.protein_g, carbs: a.carbs + i.carbs_g, fat: a.fat + i.fat_g,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

/* --------------------------------------------------------------------------- *
 *  8. Orchestrator + serializer
 * --------------------------------------------------------------------------- */
export function makeProfile(a = {}) {
  return {
    age: a.age ?? 24, sex: a.sex ?? Sex.MALE, height_cm: a.height_cm ?? 183, weight_kg: a.weight_kg ?? 85,
    body_fat_pct: a.body_fat_pct ?? null, position: a.position ?? 'position_player',
    phase: a.phase ?? Phase.IN_SEASON, goal: a.goal ?? Goal.PERFORMANCE,
  };
}

export function generatePlan({ profile, whoop, day, prefs, calorieOverride = null }) {
  const pr = prefs || { meals_per_day: 4, vegetarian: false, vegan: false, allergies: [], dislikes: [] };
  const { tdee, eee } = maintenanceKcal(profile, whoop, day);
  const guarded = applyGoalAndGuardrails(profile, tdee, eee);
  let target = guarded.target;
  const gNotes = guarded.notes;
  let gFlags = guarded.flags;
  const override = Number.isFinite(calorieOverride) && calorieOverride > 0
    ? Math.max(COACH_OVERRIDE_MIN_KCAL, Math.round(calorieOverride))
    : null;
  if (override != null) {
    const ea = energyAvailability(override, eee, profile);
    gFlags = [
      `COACH OVERRIDE: calories set by hand to ${override} kcal (engine recommended ${Math.round(guarded.target)}). `
        + `Energy availability ${ea.toFixed(1)} kcal/kg lean mass${ea < EA_HARD_FLOOR ? ` is below the ${EA_HARD_FLOOR} RED-S floor` : ''}`
        + `${profile.age < YOUTH_AGE ? '; athlete is under 18' : ''}. Monitor weight, energy, sleep and performance weekly.`,
    ];
    target = override;
  }
  const { protein, carbs, fat, notes: mNotes } = computeMacros(profile, whoop, day, target, { override: override != null });

  const zone = recoveryZone(whoop.recovery_score);
  const { notes: rNotes, flags: rFlags } = readinessNotes(whoop);
  const { fluid, sodium, steps: hyd } = hydrationPlan(profile, day, zone);
  const ea = energyAvailability(target, eee, profile);

  const targets = {
    calories: Math.round(target), protein_g: protein, carbs_g: carbs, fat_g: fat,
    fluid_ml: fluid, sodium_mg_range: sodium, energy_availability: Math.round(ea * 10) / 10,
    recovery_zone: zone, day_type: day, notes: [...gNotes, ...mNotes, ...rNotes], flags: [...gFlags, ...rFlags],
    coach_override: override != null, engine_calories: Math.round(guarded.target),
  };
  const meals = assembleMeals(targets, pr, day);
  return { targets, meals, hydration: hyd, timing: timingGuidance(day, profile) };
}

// Map a BallFuel meal name -> the meals.meal_type CHECK enum (only 4 legal values).
function mealTypeFor(name) {
  const n = name.toLowerCase();
  if (n.startsWith('breakfast')) return 'breakfast';
  if (n.startsWith('lunch')) return 'lunch';
  if (n.startsWith('dinner')) return 'dinner';
  return 'snack';
}

/**
 * Serialize a plan into rows for the app's normalized meal tables.
 * @returns {{ planDescription, meals: Array<{name, meal_type, description, calories, protein_g, carbs_g, fat_g}> }}
 */
export function planToMealRows(plan) {
  const t = plan.targets;
  const planDescription = `${t.day_type} · ${t.calories} kcal${t.coach_override ? ` (coach override; engine ${t.engine_calories})` : ''} · P${t.protein_g}/C${t.carbs_g}/F${t.fat_g}g · recovery ${t.recovery_zone} · EA ${t.energy_availability}`;
  const meals = plan.meals.map((m) => {
    const tot = mealTotals(m);
    return {
      name: `${m.name} — ${m.timing}`,
      meal_type: mealTypeFor(m.name),
      description: m.items.map((i) => `${i.grams}g ${i.food}`).join(', '),
      calories: Math.round(tot.kcal),
      protein_g: Math.round(tot.protein * 10) / 10,
      carbs_g: Math.round(tot.carbs * 10) / 10,
      fat_g: Math.round(tot.fat * 10) / 10,
    };
  });
  return { planDescription, meals };
}
