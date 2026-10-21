import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { insertTrainingProgram } from './insertTrainingProgram';
import { scheduleProgramEvents, singlePassEndDate, describeScheduled, mondayOnOrAfter, deleteProgramEvents, PROGRAM_CALENDAR_CATEGORY } from './programScheduling';
import { HeartPulse, Search, User, Save, AlertTriangle, ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import {
  REGIONS, AGE_NAME, ATH_NAME, CAP_WORD, CAP_DESC, NATURE_NAME, GENERAL_FLAGS,
  buildPlan, planToProgramDays, historyAnalysis, goalEmphasis,
} from './ptEngine';
import PtProgressChecks from './PtProgressChecks';

/* --------------------------------------------------------------------------- *
 *  PT Recovery Engine — "Return Path" (#454).
 *
 *  Cordell's PT Recovery Engine.html, ported: the five input stations
 *  (individual, injury, history, goals, clinician drop-in) feed ptEngine's
 *  capacity tier → healing-adjusted phases → per-region library → week-by-week
 *  plan. Save writes a training program (one day per session, weekday-anchored
 *  like the other generators) and schedules it on the athlete's calendar under
 *  category 'pt', starting at the plan week the athlete is in now — an athlete
 *  14 weeks post-op does not need weeks 1–13 on their calendar. Progress
 *  checks are stored per athlete (pt_progress_checks) and also show on the
 *  athlete's Physical Therapy tab.
 * --------------------------------------------------------------------------- */

const HIST = [
  ['samesite', 'Prior injury, same site'], ['samesurg', 'Prior surgery, same site'], ['otherlower', 'Other lower-limb injury'],
  ['otherupper', 'Other upper-limb injury'], ['back', 'Prior back injury'], ['recurrent', 'Recurrent / multiple'], ['none', 'No significant history'],
];
const GOALS = [
  ['rts', 'Return to sport'], ['train', 'Return to training / work'], ['adl', 'Daily activities'], ['pain', 'Reduce pain'], ['rom', 'Restore ROM'],
  ['strength', 'Rebuild strength'], ['power', 'Power / explosiveness'], ['balance', 'Balance / fall prevention'], ['prevent', 'Prevent re-injury'], ['milestone', 'Post-op milestones'],
];
const CUSTOM_PHASES = [['all', 'All phases'], ['protect', 'Protect'], ['motion', 'Motion'], ['strength', 'Strength'], ['advanced', 'Advanced']];

function ageBandFromDob(dob) {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
  if (!Number.isFinite(age)) return null;
  if (age <= 12) return 'youth';
  if (age <= 17) return 'teen';
  if (age < 30) return '20s';
  if (age < 40) return '30s';
  if (age < 60) return '4050s';
  if (age < 70) return '60s';
  return '70s';
}

// player_profiles.level is "14U" / "College" / "Professional" / "No Level".
function athleteFromLevel(level) {
  const l = String(level || '').toLowerCase();
  if (l.includes('pro')) return 'pro';
  if (l.includes('college')) return 'college';
  const u = parseInt(l, 10);
  if (Number.isFinite(u)) return u >= 14 ? 'hs' : 'youth';
  return 'hs';
}

const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export default function PtGenerator({ userId, userRole }) {
  const [players, setPlayers] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedName, setSelectedName] = useState('');
  const [autoNote, setAutoNote] = useState('');

  const [athlete, setAthlete] = useState('hs');
  const [ageB, setAgeB] = useState('teen');
  const [sport, setSport] = useState('baseball');
  const [sex, setSex] = useState('unspec');
  const [region, setRegion] = useState('shoulder');
  const [nature, setNature] = useState('acute');
  const [dx, setDx] = useState('');
  const [tsi, setTsi] = useState('');
  const [pain, setPain] = useState('');
  const [irrit, setIrrit] = useState('mod');
  const [hist, setHist] = useState([]);
  const [histnote, setHistnote] = useState('');
  const [goals, setGoals] = useState(['rts']);
  const [clnotes, setClnotes] = useState('');
  const [days, setDays] = useState('4');
  const [horizon, setHorizon] = useState('auto');
  const [custom, setCustom] = useState([{ n: '', d: '', phase: 'all' }]);

  const [openLib, setOpenLib] = useState({});
  const [openWeek, setOpenWeek] = useState({});
  const [programName, setProgramName] = useState('');
  const [assignAthlete, setAssignAthlete] = useState(true);
  const [startDate, setStartDate] = useState(mondayOnOrAfter(new Date().toISOString().slice(0, 10)));
  const [startWeek, setStartWeek] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      // #437: paged past the 1,000-row clamp.
      const { rows: data, error: e } = await readAllPages(() => supabase
        .from('users')
        .select('id, full_name, date_of_birth, player_profiles!player_profiles_user_id_fkey(level)')
        .in('role', ['player', 'coach', 'admin'])
        .order('full_name')
        .order('id'));
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

  const selectAthlete = useCallback((p) => {
    setSelectedId(p.id);
    setSelectedName(p.full_name);
    setSearch('');
    setError('');
    setSaveMsg('');
    const notes = [];
    const band = ageBandFromDob(p.date_of_birth);
    if (band) { setAgeB(band); notes.push(`age band ${AGE_NAME[band]} from date of birth`); }
    const prof = Array.isArray(p.player_profiles) ? p.player_profiles[0] : p.player_profiles;
    if (prof?.level) { setAthlete(athleteFromLevel(prof.level)); notes.push(`level ${prof.level}`); }
    setProgramName(`${p.full_name} — PT Recovery Plan`);
    setAutoNote(notes.length ? `Auto-filled: ${notes.join(', ')}. Review and fill in the injury below.` : 'No date of birth or level on file — set them below.');
  }, []);

  const customClean = useMemo(() => custom.map((c) => ({ ...c, n: c.n.trim(), d: c.d.trim() })).filter((c) => c.n), [custom]);
  const tsiNum = tsi === '' ? null : parseFloat(tsi);
  const painNum = pain === '' ? null : parseFloat(pain);

  const plan = useMemo(() => buildPlan({
    athlete, ageB, region, nature, tsi: Number.isFinite(tsiNum) ? tsiNum : null, pain: Number.isFinite(painNum) ? painNum : null,
    irrit, goals, days: parseInt(days, 10), horizon, custom: customClean,
  }), [athlete, ageB, region, nature, tsiNum, painNum, irrit, goals, days, horizon, customClean]);

  // The plan week the athlete is in now; the calendar starts here.
  const currentWeek = useMemo(() => {
    if (!Number.isFinite(tsiNum)) return 1;
    return Math.min(plan.totalWk, Math.max(1, Math.floor(tsiNum) + 1));
  }, [tsiNum, plan.totalWk]);
  useEffect(() => { setStartWeek(currentWeek); }, [currentWeek]);

  const progressCtx = useMemo(() => ({ region, nature, ageB, sex }), [region, nature, ageB, sex]);

  const save = async () => {
    setSaving(true); setError(''); setSaveMsg('');
    let progId = null;
    try {
      const offset = (startWeek - 1) * 7;
      const rows = planToProgramDays(plan, parseInt(days, 10))
        .filter((r) => r.day_number > offset)
        .map((r) => ({ ...r, day_number: r.day_number - offset }));
      if (!rows.length) throw new Error('No plan weeks left to save from that start week.');
      const weeksSaved = plan.totalWk - startWeek + 1;
      const name = programName || `${selectedName || 'Athlete'} — PT Recovery Plan`;
      // #393: day 1 = Monday (weekday 0), so the program is weekday-anchored.
      const { data: prog, error: pErr } = await insertTrainingProgram({
        name,
        description: `PT recovery plan · ${REGIONS[region].name} · ${NATURE_NAME[nature]}${dx ? ` (${dx})` : ''} · capacity ${plan.cap.tier}/5 · plan weeks ${startWeek}–${plan.totalWk}${clnotes ? ` · clinician: ${clnotes}` : ''} (generated ${new Date().toISOString().slice(0, 10)})`,
        duration_weeks: weeksSaved, created_by: userId, day_anchor: 'weekday',
      });
      if (pErr) throw pErr;
      progId = prog.id;
      for (const d of rows) {
        const { data: dayRow, error: dErr } = await supabase
          .from('training_days')
          .insert({ program_id: prog.id, day_number: d.day_number, title: d.title, notes: d.notes })
          .select('id').single();
        if (dErr) throw dErr;
        if (d.exercises.length) {
          const { error: exErr } = await supabase.from('training_exercises').insert(
            d.exercises.map((x) => ({ day_id: dayRow.id, category: x.category, name: x.name, description: x.description, reps: x.reps, sort_order: x.sort_order })),
          );
          if (exErr) throw exErr;
        }
      }
      let scheduled = null;
      if (assignAthlete && selectedId) {
        const endDate = singlePassEndDate(startDate, rows);
        const { error: aErr } = await supabase.from('training_program_assignments').insert({
          program_id: prog.id, player_id: selectedId, start_date: startDate, end_date: endDate, assigned_by: userId,
        });
        if (aErr) throw aErr;
        scheduled = await scheduleProgramEvents({
          programId: prog.id, programName: name, dayAnchor: 'weekday', playerIds: [selectedId], startDate, endDate,
          category: PROGRAM_CALENDAR_CATEGORY.pt,
        });
      }
      setSaveMsg(assignAthlete && selectedId
        ? `Saved "${name}" (plan weeks ${startWeek}–${plan.totalWk}) and assigned to ${selectedName}. ${describeScheduled(scheduled, selectedName)}`
        : `Saved "${name}" to the training-program library.`);
    } catch (e) {
      // Don't leave a half-written program on the calendar.
      if (progId) { try { await deleteProgramEvents(progId); } catch (_) { /* reported below */ } }
      setError(`${e.message || 'Save failed.'}${progId ? ' The program row was created; delete it from Training Programs before retrying.' : ''}`);
    } finally {
      setSaving(false);
    }
  };

  const filteredPlayers = players.filter((p) => p.full_name?.toLowerCase().includes(search.toLowerCase())).slice(0, 8);
  const card = 'bg-white rounded-lg border border-gray-200 p-5';
  const eyebrow = 'text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3';
  const label = 'block text-xs font-medium text-gray-500 mb-1';
  const inp = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white';
  const chip = (on) => `px-2.5 py-1.5 rounded-lg border text-xs ${on ? 'border-rose-500 bg-rose-50 text-rose-800' : 'border-gray-300 text-gray-700 hover:border-rose-300'}`;
  const { cap, D, R, phases, curIdx } = plan;
  const histNotes = historyAnalysis(hist, region);
  const goalNotes = goalEmphasis(goals, ageB, cap, D, athlete);

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-3 mb-1">
        <HeartPulse className="w-7 h-7 text-rose-600" />
        <h1 className="text-2xl font-bold text-gray-900">PT Recovery Engine</h1>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Sets a training-capacity tier, classifies the healing phase, and builds a progressive week-by-week recovery plan with a
        per-region exercise library, objective phase gates and a clinician drop-in.
      </p>
      <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
        <b>Education, not medical care.</b> This builds a structured, evidence-informed plan; it does not diagnose and does not replace a
        licensed physical therapist, physician or surgeon. Post-surgical cases follow the operating surgeon&apos;s protocol, which overrides
        anything here. Stop and seek care if any red-flag sign below appears.
      </div>

      {error && <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className={card}>
          <div className={eyebrow}>01 · The individual</div>
          <div className="relative mb-3">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
            <input className="w-full border border-gray-300 rounded pl-8 pr-3 py-2 text-sm" placeholder="Search athletes…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && filteredPlayers.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg">
                {filteredPlayers.map((p) => (
                  <button key={p.id} onClick={() => selectAthlete(p)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
                    <User className="w-4 h-4 text-gray-400" />{p.full_name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedName && <p className="text-sm font-medium text-gray-900 mb-1">{selectedName}</p>}
          {autoNote && <p className="text-xs text-gray-500 mb-3">{autoNote}</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>Athlete level<select className={inp} value={athlete} onChange={(e) => setAthlete(e.target.value)}>{Object.entries(ATH_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className={label}>Age band<select className={inp} value={ageB} onChange={(e) => setAgeB(e.target.value)}>{Object.entries(AGE_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className={label}>Sport / activity<input className={inp} value={sport} onChange={(e) => setSport(e.target.value)} /></label>
            <label className={label}>Sex (norms only)<select className={inp} value={sex} onChange={(e) => setSex(e.target.value)}><option value="unspec">Prefer not to say</option><option value="m">Male</option><option value="f">Female</option></select></label>
          </div>
        </div>

        <div className={card}>
          <div className={eyebrow}>02 · The injury / condition</div>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>Body region<select className={inp} value={region} onChange={(e) => setRegion(e.target.value)}>{Object.entries(REGIONS).map(([k, r]) => <option key={k} value={k}>{r.name}</option>)}</select></label>
            <label className={label}>Nature<select className={inp} value={nature} onChange={(e) => setNature(e.target.value)}>{Object.entries(NATURE_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className={`${label} col-span-2`}>Diagnosis / procedure (if known)<input className={inp} value={dx} onChange={(e) => setDx(e.target.value)} placeholder="e.g., UCL reconstruction" /></label>
            <label className={label}>Weeks since injury / surgery<input type="number" step="0.5" min="0" className={inp} value={tsi} onChange={(e) => setTsi(e.target.value)} /></label>
            <label className={label}>Current pain (0–10)<input type="number" min="0" max="10" className={inp} value={pain} onChange={(e) => setPain(e.target.value)} /></label>
            <label className={label}>Irritability<select className={inp} value={irrit} onChange={(e) => setIrrit(e.target.value)}><option value="low">Low</option><option value="mod">Moderate</option><option value="high">High</option></select></label>
          </div>
        </div>

        <div className={card}>
          <div className={eyebrow}>03 · Injury history</div>
          <div className="flex flex-wrap gap-2">
            {HIST.map(([v, l]) => (
              <button key={v} type="button" className={chip(hist.includes(v))}
                onClick={() => setHist(v === 'none' ? (hist.includes('none') ? [] : ['none']) : toggleIn(hist.filter((x) => x !== 'none'), v))}>{l}</button>
            ))}
          </div>
          <input className={`${inp} mt-3`} value={histnote} onChange={(e) => setHistnote(e.target.value)} placeholder="Notes, e.g. UCL sprain same elbow 2 yrs ago" />
        </div>

        <div className={card}>
          <div className={eyebrow}>04 · Goals</div>
          <div className="flex flex-wrap gap-2">
            {GOALS.map(([v, l]) => <button key={v} type="button" className={chip(goals.includes(v))} onClick={() => setGoals(toggleIn(goals, v))}>{l}</button>)}
          </div>
        </div>

        <div className={`${card} lg:col-span-2`}>
          <div className={eyebrow}>05 · Clinician drop-in (optional)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-3">
              <label className={label}>Custom precautions / clinical notes
                <textarea className={`${inp} min-h-[70px]`} value={clnotes} onChange={(e) => setClnotes(e.target.value)} placeholder="e.g., Surgeon restricts flexion to 90° until week 4" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className={label}>Training days / week<select className={inp} value={days} onChange={(e) => setDays(e.target.value)}>{['3', '4', '5', '6'].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
                <label className={label}>Plan horizon<select className={inp} value={horizon} onChange={(e) => setHorizon(e.target.value)}><option value="auto">Auto (full healing arc)</option>{['8', '12', '16', '26', '52'].map((w) => <option key={w} value={w}>{w} weeks</option>)}</select></label>
              </div>
            </div>
            <div>
              <span className={label}>Custom exercises to inject</span>
              {custom.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_7rem_7rem_2rem] gap-2 mb-2">
                  <input className={inp} placeholder="exercise name" value={c.n} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, n: e.target.value } : x)))} />
                  <input className={inp} placeholder="dose (3×10)" value={c.d} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, d: e.target.value } : x)))} />
                  <select className={inp} value={c.phase} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? { ...x, phase: e.target.value } : x)))}>{CUSTOM_PHASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  <button type="button" aria-label="Remove exercise" className="text-gray-400 hover:text-red-600" onClick={() => setCustom(custom.filter((_, j) => j !== i))}><X className="w-4 h-4" /></button>
                </div>
              ))}
              <button type="button" className="text-sm text-rose-700 inline-flex items-center gap-1" onClick={() => setCustom([...custom, { n: '', d: '', phase: 'all' }])}><Plus className="w-4 h-4" /> Add exercise</button>
              <p className="text-xs text-gray-400 mt-1">Merged into the chosen phase and every week of it, tagged “clinician”. Blank rows are ignored.</p>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------ OUTPUT ------------------------------ */}
      <div className="mt-8 space-y-5">
        <div className={card}>
          <div className={eyebrow}>Capacity tier · {ATH_NAME[athlete]} · {AGE_NAME[ageB]}{sport ? ` · ${sport}` : ''}</div>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="text-center sm:w-36 shrink-0">
              <p className="text-4xl font-extrabold text-gray-900">{cap.tier}<span className="text-base text-gray-400 font-normal"> / 5</span></p>
              <p className="text-xs text-rose-700 font-medium">{CAP_WORD[cap.tier]}</p>
            </div>
            <div className="text-sm text-gray-700 space-y-1">
              <p>{CAP_DESC[cap.tier]}</p>
              <p className="text-gray-500">Loading ≈ <b>{D.freq}×/wk</b> · dose <b>{D.setsN} sets × {D.reps}</b> · {D.plyo ? 'plyometrics permitted later' : 'low-impact power substituted'} · healing factor <b>×{D.heal}</b> · {D.progr}.</p>
              {cap.ltad && <p className="text-amber-700"><b>Growth-stage cap:</b> {cap.ltad === 'youth' ? 'youth — movement skill & light loading; no maximal loading or aggressive plyometrics.' : 'teen — technique & tissue tolerance lead; conservative load progression.'}</p>}
            </div>
          </div>
        </div>

        <div className={card}>
          <div className={eyebrow}>Where they are now · {NATURE_NAME[nature]}{dx ? ` · ${dx}` : ''}{Number.isFinite(tsiNum) ? ` · ${tsiNum} wk in` : ''}</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {phases.map((p, i) => (
              <div key={p.nm} className={`rounded-lg border p-3 ${i === curIdx ? 'border-rose-400 bg-rose-50' : i < curIdx ? 'border-gray-200 bg-gray-50 opacity-70' : 'border-gray-200'}`}>
                <p className="text-[11px] font-semibold text-gray-500">PHASE {i + 1}{i === curIdx && <span className="ml-1 text-rose-700">· NOW</span>}</p>
                <p className="text-sm font-semibold text-gray-900">{p.nm}</p>
                <p className="text-xs text-gray-500">≈ wk {p.adjWk[0]}–{p.adjWk[1]}</p>
                <p className="text-xs text-gray-600 mt-1">{p.goal.split('.')[0]}.</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-gray-700"><b>Healing context:</b> {R.heal}</p>
          {(nature === 'postsurg' || nature === 'fracture') && <p className="mt-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded p-2">Phase windows are healing-adjusted estimates. The surgeon&apos;s / treating clinician&apos;s weight-bearing and ROM limits override them — don&apos;t advance a phase without clearance.</p>}
          {plan.heldBack && <p className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-2">High current pain{Number.isFinite(painNum) ? ` (${painNum}/10)` : ''}{irrit === 'high' ? ' / irritability' : ''} — the plan starts one phase more conservative than the timeline suggests.</p>}
          {(clnotes || customClean.length > 0) && <p className="mt-2 text-sm text-violet-900 bg-violet-50 border border-violet-200 rounded p-2"><b>Clinician drop-in applied.</b> {clnotes}{customClean.length ? ` ${customClean.length} custom exercise${customClean.length > 1 ? 's' : ''} injected.` : ''}</p>}
        </div>

        <div className={card}>
          <div className={eyebrow}>Exercise library by phase · {R.name}</div>
          {phases.map((p, i) => {
            const open = openLib[i] ?? i === curIdx;
            const pool = (R.pools[p.pool] || R.pools.motion).concat(customClean.filter((c) => c.phase === p.kind || c.phase === 'all' || c.phase === p.pool).map((c) => ({ n: c.n, d: c.d || 'as directed', p: 'per clinician', cl: true })));
            return (
              <div key={p.nm} className="border-t border-gray-100 first:border-t-0">
                <button className="w-full flex items-center gap-2 py-2 text-left" onClick={() => setOpenLib({ ...openLib, [i]: !open })}>
                  <span className="text-xs font-semibold text-gray-400 w-6">P{i + 1}</span>
                  <span className="text-sm font-semibold text-gray-900 flex-1">{p.nm}{i === curIdx && <span className="ml-2 text-[11px] text-rose-700">current</span>}</span>
                  <span className="text-xs text-gray-500">≈ wk {p.adjWk[0]}–{p.adjWk[1]}</span>
                  {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {open && (
                  <div className="pb-3 pl-8 space-y-2 text-sm">
                    <p><b className="text-gray-700">Goal:</b> {p.goal}</p>
                    <p className="text-amber-800"><b>Precautions:</b> {p.prec}</p>
                    <ul className="space-y-1">{pool.map((x) => <li key={x.n}><b>{x.n}</b>{x.cl && <span className="ml-1 text-[11px] text-violet-700">clinician</span>} — {x.d}{x.p && <span className="text-gray-500"> · {x.p}</span>}</li>)}</ul>
                    <p className="text-green-800"><b>Criteria to advance:</b> {p.crit.join(' · ')}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={card}>
          <div className={eyebrow}>Week-by-week plan · {plan.totalWk} weeks · {days} days/wk</div>
          <p className="text-xs text-gray-500 mb-2">Each week ramps volume and deloads every 4th week. Phase jumps are gated: start the next phase only once its criteria are met — otherwise repeat the prior week.</p>
          {plan.weeks.map((wk) => {
            const open = openWeek[wk.week] ?? wk.week === currentWeek;
            return (
              <div key={wk.week} className="border-t border-gray-100 first:border-t-0">
                <button className="w-full flex items-center gap-2 py-2 text-left" onClick={() => setOpenWeek({ ...openWeek, [wk.week]: !open })}>
                  <span className="text-xs font-semibold text-gray-400 w-12">WK {String(wk.week).padStart(2, '0')}</span>
                  <span className="text-sm text-gray-900 flex-1">{wk.phaseName}{wk.deload && <span className="ml-2 text-[11px] text-amber-700">deload</span>}{wk.week === currentWeek && Number.isFinite(tsiNum) && <span className="ml-2 text-[11px] text-rose-700">this week</span>}</span>
                  {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {open && (
                  <div className="pb-3 pl-14 space-y-2 text-sm">
                    {wk.gate && <div className="rounded border border-green-200 bg-green-50 p-2 text-green-900"><b>Gate — confirm from “{wk.gateFrom}”:</b> {wk.gate.join(' · ')}</div>}
                    <p className="text-gray-600 italic">{wk.focus}</p>
                    {wk.blocks.map((b) => (
                      <div key={b.t}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{b.t}{b.note && <span className="normal-case tracking-normal font-normal"> — {b.note}</span>}</p>
                        <ul className="ml-1">{b.items.map((x) => <li key={x.n}>{x.n}{x.cl && <span className="ml-1 text-[11px] text-violet-700">clinician</span>} <span className="text-gray-500">— {x.d}</span></li>)}</ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className={card}>
            <div className={eyebrow}>History &amp; risk{histnote ? ` · ${histnote}` : ''}</div>
            {histNotes.map((n) => <div key={n.k} className="mb-2 text-sm"><p className="font-semibold text-gray-900">{n.k}</p><p className="text-gray-600">{n.v}</p></div>)}
            {goalNotes.length > 0 && <div className={`${eyebrow} mt-4`}>Goal-driven emphasis</div>}
            {goalNotes.map((n) => <div key={n.k} className="mb-2 text-sm"><p className="font-semibold text-gray-900">{n.k}</p><p className="text-gray-600">{n.v}</p></div>)}
          </div>
          <div className={card}>
            <div className={eyebrow}>Return gate · criteria, not a date</div>
            <ul className="list-disc pl-5 text-sm text-gray-700">{R.rts.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className={`${eyebrow} mt-4 text-red-600`}><AlertTriangle className="inline w-3.5 h-3.5 mr-1" />Red flags — stop &amp; seek care</div>
            <ul className="list-disc pl-5 text-sm text-red-800">{R.flags.concat(GENERAL_FLAGS).map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        </div>

        <div className={card}>
          <div className={eyebrow}>Save &amp; assign</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className={`${label} md:col-span-2`}>Program name<input className={inp} value={programName} onChange={(e) => setProgramName(e.target.value)} placeholder={selectedName ? `${selectedName} — PT Recovery Plan` : 'Select an athlete first'} /></label>
            <label className={label}>Start at plan week<select className={inp} value={startWeek} onChange={(e) => setStartWeek(parseInt(e.target.value, 10))}>{plan.weeks.map((w) => <option key={w.week} value={w.week}>Week {w.week}{w.week === currentWeek && Number.isFinite(tsiNum) ? ' (now)' : ''}</option>)}</select></label>
            <label className={label}>Calendar start (Monday)<input type="date" className={inp} value={startDate} onChange={(e) => setStartDate(mondayOnOrAfter(e.target.value))} /></label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={assignAthlete} onChange={(e) => setAssignAthlete(e.target.checked)} disabled={!selectedId} />
            {selectedId ? `Assign to ${selectedName} and put it on their calendar` : 'Pick an athlete above to assign it'}
          </label>
          <p className="text-xs text-gray-500 mt-1">{(plan.totalWk - startWeek + 1)} week{plan.totalWk - startWeek ? 's' : ''} × {days} sessions, shown on the calendar as PT workouts.</p>
          <button onClick={save} disabled={saving} className="mt-3 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2">
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save plan'}
          </button>
          {saveMsg && <p className="mt-2 text-sm text-green-700">{saveMsg}</p>}
        </div>

        {selectedId && (
          <PtProgressChecks playerId={selectedId} canEdit currentUserId={userId} defaultCtx={progressCtx} />
        )}
      </div>
    </div>
  );
}
