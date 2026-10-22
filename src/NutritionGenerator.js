import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { Utensils, Search, User, Save, Check, AlertTriangle, Droplet, Clock } from 'lucide-react';
import {
  Sex, Goal, Phase, DayType, makeProfile, generatePlan, planToMealRows, mealTotals, COACH_OVERRIDE_MIN_KCAL,
} from './nutritionEngine';
import { extractMetricsFromSubmissions } from './assessmentMetrics';

/* --------------------------------------------------------------------------- *
 *  Nutrition Program Generator — "BallFuel" (engine #4).
 *
 *  WHOOP-driven daily fuel plans: calories, periodized macros, hydration,
 *  baseball meal-timing and a sample whole-food meal plan, with RED-S / youth
 *  safety guardrails. Fully wired: auto-fills readiness from the athlete's latest
 *  whoop_cycles and demographics from their profile, then saves into the
 *  normalized meal tables (meals + meal_plan_items + meal_plans).
 *
 *  Scope: core engine (built-in food table). The scipy exact-gram optimizer and
 *  USDA food DB are deferred — so the sample meals approximate the targets (the
 *  targets are the prescription).
 * --------------------------------------------------------------------------- */

const ageFromDob = (dob) => {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) ? age : null;
};
const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;

export default function NutritionGenerator({ userId, userRole }) {
  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedName, setSelectedName] = useState('');
  const [autoNote, setAutoNote] = useState('');

  // Profile inputs (US units in the UI; converted to kg/cm for the engine).
  const [age, setAge] = useState('18');
  const [sex, setSex] = useState(Sex.MALE);
  const [weightLb, setWeightLb] = useState('180');
  const [heightIn, setHeightIn] = useState('72');
  const [bodyFat, setBodyFat] = useState('');
  const [phase, setPhase] = useState(Phase.IN_SEASON);
  const [goal, setGoal] = useState(Goal.PERFORMANCE);
  const [day, setDay] = useState(DayType.GAME);
  const [mealsPerDay, setMealsPerDay] = useState(4);

  // Dietary prefs.
  const [vegetarian, setVegetarian] = useState(false);
  const [vegan, setVegan] = useState(false);
  const [allergies, setAllergies] = useState('');
  const [dislikes, setDislikes] = useState('');

  // WHOOP (auto-filled, editable).
  const [recovery, setRecovery] = useState('60');
  const [strain, setStrain] = useState('12');
  const [hrv, setHrv] = useState('');
  const [hrvBase, setHrvBase] = useState('');
  const [restingHr, setRestingHr] = useState('');
  // #464: coach-set calorie target ('' = use the engine's), floor COACH_OVERRIDE_MIN_KCAL.
  const [kcalOverride, setKcalOverride] = useState('');

  const [programName, setProgramName] = useState('');
  const [assignAthlete, setAssignAthlete] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      // #437: paged past the 1,000-row clamp.
      const { rows: data, error: e } = await readAllPages(() => supabase
        .from('users').select('id, full_name').in('role', ['player', 'coach', 'admin']).order('full_name').order('id'));
      if (e) { setError(e.message); return; }
      let filtered = data;
      if (userRole === 'coach') {
        const { data: coachTeams } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
        const teamIds = (coachTeams || []).map((t) => t.team_id);
        const { data: members } = await supabase.from('team_members').select('user_id')
          .in('team_id', teamIds.length ? teamIds : ['00000000-0000-0000-0000-000000000000']);
        const allowed = new Set((members || []).map((m) => m.user_id));
        filtered = filtered.filter((p) => allowed.has(p.id));
      }
      setPlayers(filtered);
    })();
  }, [userId, userRole]);

  const selectAthlete = useCallback(async (p) => {
    setSelectedId(p.id);
    setSelectedName(p.full_name);
    setSearch('');
    setError('');
    setSaveMsg('');
    const notes = [];
    try {
      const { data: u } = await supabase
        .from('users').select('date_of_birth, height, weight').eq('id', p.id).single();
      const a = ageFromDob(u?.date_of_birth);
      if (a != null) setAge(String(a));
      if (u?.weight) setWeightLb(String(u.weight));
      if (u?.height) setHeightIn(String(u.height));

      const { data: cycles } = await supabase
        .from('whoop_cycles')
        .select('cycle_date, recovery_score, strain_score, hrv_rmssd, resting_heart_rate')
        .eq('athlete_id', p.id)
        .order('cycle_date', { ascending: false })
        .limit(30);
      if (cycles && cycles.length) {
        const latest = cycles[0];
        if (latest.recovery_score != null) { setRecovery(String(Math.round(latest.recovery_score))); notes.push('recovery'); }
        if (latest.strain_score != null) { setStrain(String(Math.round(latest.strain_score * 10) / 10)); notes.push('strain'); }
        if (latest.hrv_rmssd != null) { setHrv(String(Math.round(latest.hrv_rmssd))); }
        if (latest.resting_heart_rate != null) setRestingHr(String(Math.round(latest.resting_heart_rate)));
        const hist = cycles.slice(1).map((c) => c.hrv_rmssd).filter((v) => v != null);
        if (hist.length >= 3) { setHrvBase(String(Math.round(hist.reduce((s, v) => s + v, 0) / hist.length))); notes.push('HRV baseline'); }
      }

      // Assessment-tagged body metrics override the users-table fallbacks — read
      // across ALL past assessments (newest value per metric) so weight/height/
      // body-fat come from whichever assessment last recorded them (#11).
      const { data: subs } = await supabase
        .from('assessment_submissions')
        .select('responses, assessment_templates(name, schema)')
        .eq('player_id', p.id)
        .order('assessment_date', { ascending: false })
        .limit(50);
      const byKey = extractMetricsFromSubmissions(subs || []);
      if (byKey.body_weight != null) { setWeightLb(String(byKey.body_weight)); notes.push('weight'); }
      if (byKey.height != null) { setHeightIn(String(byKey.height)); notes.push('height'); }
      if (byKey.body_fat_pct != null) { setBodyFat(String(byKey.body_fat_pct)); notes.push('body fat'); }

      setProgramName(`${p.full_name} — Fuel Plan`);
      setAutoNote(notes.length ? `Auto-filled from live data: ${notes.join(', ')}. Review & adjust.` : 'No WHOOP data on file — enter recovery/strain manually.');
    } catch (e) {
      setError(e.message || 'Failed to load athlete.');
    }
  }, []);

  const plan = useMemo(() => {
    const numOr = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
    const profile = makeProfile({
      age: parseInt(age, 10) || 18, sex,
      weight_kg: numOr(weightLb, 180) * LB_TO_KG, height_cm: numOr(heightIn, 72) * IN_TO_CM,
      body_fat_pct: bodyFat === '' ? null : numOr(bodyFat, null), phase, goal,
    });
    const whoop = {
      recovery_score: numOr(recovery, 60), day_strain: numOr(strain, 12),
      hrv_ms: hrv === '' ? null : numOr(hrv, null), hrv_baseline_ms: hrvBase === '' ? null : numOr(hrvBase, null),
      resting_hr: restingHr === '' ? null : numOr(restingHr, null), rhr_baseline: restingHr === '' ? null : numOr(restingHr, null),
    };
    const prefs = {
      meals_per_day: mealsPerDay, vegetarian, vegan,
      allergies: allergies.split(',').map((s) => s.trim()).filter(Boolean),
      dislikes: dislikes.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    };
    const override = kcalOverride === '' ? null : numOr(kcalOverride, null);
    return generatePlan({ profile, whoop, day, prefs, calorieOverride: override });
  }, [age, sex, weightLb, heightIn, bodyFat, phase, goal, day, mealsPerDay, vegetarian, vegan, allergies, dislikes, recovery, strain, hrv, hrvBase, restingHr, kcalOverride]);

  const save = async () => {
    if (!plan) return;
    setSaving(true); setError(''); setSaveMsg('');
    try {
      const { planDescription, meals } = planToMealRows(plan);
      const { data: mp, error: pErr } = await supabase
        .from('meal_plans')
        .insert({ name: programName || `${selectedName} — Fuel Plan`, description: planDescription, created_by: userId })
        .select('id').single();
      if (pErr) throw pErr;

      for (let i = 0; i < meals.length; i += 1) {
        const m = meals[i];
        const { data: mealRow, error: mErr } = await supabase
          .from('meals')
          .insert({
            name: m.name, description: m.description, meal_type: m.meal_type,
            calories: m.calories, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g, created_by: userId,
          }).select('id').single();
        if (mErr) throw mErr;
        const { error: iErr } = await supabase.from('meal_plan_items')
          .insert({ meal_plan_id: mp.id, meal_id: mealRow.id, sort_order: i });
        if (iErr) throw iErr;
      }

      if (assignAthlete && selectedId) {
        const { error: aErr } = await supabase.from('meal_plan_assignments').insert({
          meal_plan_id: mp.id, player_id: selectedId, start_date: new Date().toISOString().slice(0, 10), assigned_by: userId,
        });
        if (aErr) throw aErr;
      }
      setSaveMsg(`Saved "${programName}"${assignAthlete ? ` and assigned to ${selectedName}` : ''}.`);
    } catch (e) {
      setError(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const filteredPlayers = players.filter((p) => p.full_name?.toLowerCase().includes(search.toLowerCase())).slice(0, 8);
  const card = 'bg-white rounded-lg border border-gray-200 p-5';
  const eyebrow = 'text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3';
  const label = 'block text-xs font-medium text-gray-500 mb-1';
  const inp = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm';
  const t = plan.targets;
  const zoneClr = { green: 'text-green-600 bg-green-50 border-green-200', yellow: 'text-amber-600 bg-amber-50 border-amber-200', red: 'text-red-600 bg-red-50 border-red-200' }[t.recovery_zone];

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-3 mb-1">
        <Utensils className="w-7 h-7 text-emerald-600" />
        <h1 className="text-2xl font-bold text-gray-900">Nutrition Program Generator</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        WHOOP-driven daily fuel plans — calories, periodized macros, hydration and baseball meal-timing with RED-S /
        youth safety guardrails. Auto-fills recovery from WHOOP; saves into the meal-plan library.
      </p>

      {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* -------------------------------- LEFT -------------------------------- */}
        <div className="space-y-5">
          <div className={card}>
            <div className={eyebrow}>Athlete</div>
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
              <input className="w-full border border-gray-300 rounded pl-8 pr-3 py-2 text-sm"
                placeholder="Search athletes…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && filteredPlayers.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg">
                  {filteredPlayers.map((p) => (
                    <button key={p.id} onClick={() => selectAthlete(p)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-400" />{p.full_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {selectedName && <div className="mt-3 text-sm font-semibold text-gray-900">{selectedName}</div>}
            {autoNote && <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 rounded p-2">{autoNote}</div>}
          </div>

          <div className={card}>
            <div className={eyebrow}>Profile</div>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Age</span><input className={inp} type="number" value={age} onChange={(e) => setAge(e.target.value)} /></div>
              <div><span className={label}>Sex</span>
                <select className={inp} value={sex} onChange={(e) => setSex(e.target.value)}>
                  <option value={Sex.MALE}>Male</option><option value={Sex.FEMALE}>Female</option>
                </select>
              </div>
              <div><span className={label}>Weight (lb)</span><input className={inp} type="number" value={weightLb} onChange={(e) => setWeightLb(e.target.value)} /></div>
              <div><span className={label}>Height (in)</span><input className={inp} type="number" value={heightIn} onChange={(e) => setHeightIn(e.target.value)} /></div>
              <div><span className={label}>Body fat % (optional)</span><input className={inp} type="number" value={bodyFat} onChange={(e) => setBodyFat(e.target.value)} placeholder="—" /></div>
              <div><span className={label}>Meals / day</span>
                <select className={inp} value={mealsPerDay} onChange={(e) => setMealsPerDay(Number(e.target.value))}>
                  {[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className={card}>
            <div className={eyebrow}>Context</div>
            <div className="grid grid-cols-1 gap-3">
              <div>
                <span className={label}>Day type</span>
                <select className={inp} value={day} onChange={(e) => setDay(e.target.value)}>
                  <option value={DayType.REST}>Rest</option><option value={DayType.TRAINING}>Training</option>
                  <option value={DayType.GAME}>Game</option><option value={DayType.DOUBLEHEADER}>Doubleheader / tournament</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={label}>Season phase</span>
                  <select className={inp} value={phase} onChange={(e) => setPhase(e.target.value)}>
                    <option value={Phase.OFF_SEASON}>Off-season</option><option value={Phase.PRE_SEASON}>Pre-season</option>
                    <option value={Phase.IN_SEASON}>In-season</option><option value={Phase.POST_SEASON}>Post-season</option>
                  </select>
                </div>
                <div>
                  <span className={label}>Goal</span>
                  <select className={inp} value={goal} onChange={(e) => setGoal(e.target.value)}>
                    <option value={Goal.PERFORMANCE}>Performance</option><option value={Goal.MAINTAIN}>Maintain</option>
                    <option value={Goal.GAIN_LEAN_MASS}>Gain lean mass</option><option value={Goal.LOSE_FAT}>Lose fat</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className={card}>
            <div className={eyebrow}>WHOOP readout</div>
            <div className="grid grid-cols-2 gap-3">
              <div><span className={label}>Recovery %</span><input className={inp} type="number" value={recovery} onChange={(e) => setRecovery(e.target.value)} /></div>
              <div><span className={label}>Day strain (0–21)</span><input className={inp} type="number" value={strain} onChange={(e) => setStrain(e.target.value)} /></div>
              <div><span className={label}>HRV (ms)</span><input className={inp} type="number" value={hrv} onChange={(e) => setHrv(e.target.value)} placeholder="—" /></div>
              <div><span className={label}>HRV baseline (ms)</span><input className={inp} type="number" value={hrvBase} onChange={(e) => setHrvBase(e.target.value)} placeholder="—" /></div>
              <div><span className={label}>Resting HR</span><input className={inp} type="number" value={restingHr} onChange={(e) => setRestingHr(e.target.value)} placeholder="—" /></div>
            </div>
          </div>

          <div className={card}>
            <div className={eyebrow}>Dietary preferences</div>
            <div className="flex gap-4 mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={vegetarian} onChange={(e) => setVegetarian(e.target.checked)} /> Vegetarian</label>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={vegan} onChange={(e) => setVegan(e.target.checked)} /> Vegan</label>
            </div>
            <span className={label}>Allergies (comma-separated: dairy, nuts, gluten, fish, egg)</span>
            <input className={inp + ' mb-2'} value={allergies} onChange={(e) => setAllergies(e.target.value)} placeholder="none" />
            <span className={label}>Dislikes (food names)</span>
            <input className={inp} value={dislikes} onChange={(e) => setDislikes(e.target.value)} placeholder="none" />
          </div>
        </div>

        {/* -------------------------------- RIGHT ------------------------------- */}
        <div className="space-y-5">
          {/* Targets */}
          <div className={`${card} border ${zoneClr}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide">{t.day_type} · recovery {t.recovery_zone}</div>
              <div className="text-xs font-mono">EA {t.energy_availability} kcal/kg LM</div>
            </div>
            <div className="text-4xl font-bold text-gray-900 mt-1">{t.calories}<span className="text-base font-medium text-gray-400 ml-1">kcal</span></div>
            <div className="flex gap-6 mt-3">
              <Macro label="Protein" v={t.protein_g} />
              <Macro label="Carbs" v={t.carbs_g} />
              <Macro label="Fat" v={t.fat_g} />
            </div>
            <div className="flex gap-2 mt-3 text-xs text-gray-600">
              <Droplet className="w-4 h-4 text-blue-400" /> ~{t.fluid_ml} mL fluid · sodium {t.sodium_mg_range[0]}–{t.sodium_mg_range[1]} mg
            </div>
            <div className="mt-4 pt-3 border-t border-gray-200/70">
              <span className={label}>Coach calorie override (min {COACH_OVERRIDE_MIN_KCAL} kcal, any age)</span>
              <div className="flex items-center gap-2">
                <input className={inp + ' max-w-[9rem]'} type="number" min={COACH_OVERRIDE_MIN_KCAL} step="50"
                  value={kcalOverride} onChange={(e) => setKcalOverride(e.target.value)}
                  placeholder={`engine: ${t.engine_calories}`} />
                {kcalOverride !== '' && (
                  <button type="button" onClick={() => setKcalOverride('')} className="text-xs text-gray-500 hover:text-gray-800 underline">Use engine</button>
                )}
              </div>
              {t.coach_override && (
                <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex gap-1.5">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>Overriding the safety guardrails. The plan is saved with this override noted on it.</span>
                </div>
              )}
            </div>
          </div>

          {/* Flags */}
          {t.flags.length > 0 && (
            <div className={card}>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-600 mb-2">
                <AlertTriangle className="w-4 h-4" /> Safety / medical flags
              </div>
              <ul className="space-y-1.5">
                {t.flags.map((f, i) => <li key={i} className="text-xs text-gray-700 flex gap-2"><span className="text-red-500 mt-0.5">▸</span><span>{f}</span></li>)}
              </ul>
            </div>
          )}

          {/* Notes */}
          <div className={card}>
            <div className={eyebrow}>Coaching notes</div>
            <ul className="space-y-1.5">
              {t.notes.map((n, i) => <li key={i} className="text-xs text-gray-600 flex gap-2"><span className="text-emerald-500 mt-0.5">▸</span><span>{n}</span></li>)}
            </ul>
          </div>

          {/* Timing + hydration */}
          <div className={card}>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2"><Clock className="w-4 h-4" /> Meal timing</div>
            <ul className="space-y-1 mb-4">
              {plan.timing.map((g, i) => <li key={i} className="text-xs text-gray-600 flex gap-2"><span className="text-gray-300">•</span><span>{g}</span></li>)}
            </ul>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2"><Droplet className="w-4 h-4" /> Hydration</div>
            <ul className="space-y-1">
              {plan.hydration.map((h, i) => <li key={i} className="text-xs text-gray-600 flex gap-2"><span className="text-gray-300">•</span><span>{h}</span></li>)}
            </ul>
          </div>

          {/* Sample meals */}
          <div className={card}>
            <div className="flex items-center justify-between mb-3">
              <div className={eyebrow + ' mb-0'}>Sample meals</div>
              <div className="text-[10px] text-gray-400">whole-food approximation — targets are the prescription</div>
            </div>
            <div className="space-y-3">
              {plan.meals.map((m, i) => {
                const tot = mealTotals(m);
                return (
                  <div key={i} className="border-t border-gray-100 first:border-t-0 pt-2 first:pt-0">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-gray-800 text-sm">{m.name} <span className="font-normal text-gray-400 text-xs">· {m.timing}</span></div>
                      <div className="text-xs font-mono text-gray-500">{Math.round(tot.kcal)} kcal · P{Math.round(tot.protein)} C{Math.round(tot.carbs)} F{Math.round(tot.fat)}</div>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{m.items.map((it) => `${it.grams}g ${it.food}`).join(' · ')}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Save */}
          <div className={card}>
            <div className={eyebrow}>Save to library</div>
            <label className={label}>Meal plan name</label>
            <input className={inp} value={programName} onChange={(e) => setProgramName(e.target.value)}
              placeholder={selectedName ? `${selectedName} — Fuel Plan` : 'Select an athlete first'} />
            <label className="flex items-center gap-2 mt-3 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={assignAthlete} onChange={(e) => setAssignAthlete(e.target.checked)} />
              Assign to {selectedName || 'athlete'} (appears on their profile)
            </label>
            <button onClick={save} disabled={saving || !selectedId}
              className="mt-4 w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg">
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save Meal Plan'}
            </button>
            {saveMsg && (
              <div className="mt-3 p-3 rounded bg-green-50 border border-green-200 text-green-700 text-sm flex gap-2">
                <Check className="w-4 h-4 mt-0.5 shrink-0" />{saveMsg}
              </div>
            )}
            <div className="mt-3 text-xs text-gray-400">Not medical/nutrition advice. Have a registered sports dietitian review outputs, especially for minors.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Macro({ label, v }) {
  return (
    <div>
      <div className="text-xl font-mono font-bold text-gray-900">{v}<span className="text-xs text-gray-400 ml-0.5">g</span></div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}
