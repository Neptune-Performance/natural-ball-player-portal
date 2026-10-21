import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';
import { Loader2, Trash2, Activity } from 'lucide-react';
import { formatUserError } from './errorMessage';
import { REGIONS, AGE_NAME, NATURE_NAME, checkFields, gradeCheck, overallRead, expLSI, CHECK_METRICS } from './ptEngine';

/*
 * #454 — PT Recovery Engine progress checks, stored in pt_progress_checks.
 * Rendered by the PT generator (after an athlete is picked) and on the
 * athlete's Physical Therapy profile tab. Staff log/delete; the athlete reads
 * their own (RLS). Grading is ptEngine.gradeCheck — the source engine's own
 * thresholds against age/sex norms and the post-injury LSI trajectory.
 */

const TONE = {
  ahead: 'bg-green-100 text-green-800', good: 'bg-green-100 text-green-800', met: 'bg-green-100 text-green-800',
  ontrack: 'bg-blue-100 text-blue-800', mid: 'bg-amber-100 text-amber-800',
  behind: 'bg-orange-100 text-orange-800', low: 'bg-orange-100 text-orange-800', flag: 'bg-red-100 text-red-800',
};
const COL_LABEL = { week: 'Wk', pain: 'Pain', rom: 'ROM%', lsi: 'LSI%', hop: 'Hop%', heel: 'Heel%', grip: 'Grip', chair: 'Chair', gait: 'Gait', pro: 'PRO' };
const num = (v) => (v === '' || v == null ? null : Number(v));

function TrajectoryChart({ checks, nature }) {
  const key = checks.some((c) => c.lsi != null) ? 'lsi' : checks.some((c) => c.pro != null) ? 'pro' : checks.some((c) => c.pain != null) ? 'pain' : null;
  if (!key) return null;
  const pts = checks.filter((c) => c[key] != null && c.week != null).map((c) => ({ x: Number(c.week), y: Number(c[key]) }));
  if (pts.length < 2) return null;
  const yMax = key === 'pain' ? 10 : 100;
  const target = key === 'lsi' ? 90 : key === 'pro' ? 85 : null;
  const band = key === 'lsi' && ['postsurg', 'acute', 'fracture'].includes(nature);
  const W = 560, H = 190, L = 34, B = 22, T = 10, R = 10;
  const maxX = Math.max(8, Math.max(...pts.map((p) => p.x)) + 2);
  const X = (x) => L + (x / maxX) * (W - L - R);
  const Y = (y) => T + ((yMax - y) / yMax) * (H - T - B);
  const bandPath = () => {
    let up = '', lo = '';
    for (let w = 0; w <= maxX; w += 1) { const e = expLSI(w / 4.345); up += `${w ? 'L' : 'M'}${X(w)},${Y(e.hi)} `; lo = `L${X(w)},${Y(e.lo)} ${lo}`; }
    return `${up}${lo}Z`;
  };
  const label = { lsi: 'Strength symmetry (%)', pro: 'Function / PRO (0–100)', pain: 'Pain (0–10)' }[key];
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-gray-600 mb-1">{label} over time (weeks since injury/surgery)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" role="img" aria-label={`${label} trajectory`}>
        {[0, 1, 2, 3, 4, 5].map((i) => { const yv = (yMax * i) / 5; return (
          <g key={i}><line x1={L} x2={W - R} y1={Y(yv)} y2={Y(yv)} stroke="#e5e7eb" /><text x={L - 5} y={Y(yv) + 3} fontSize="9" textAnchor="end" fill="#6b7280">{Math.round(yv)}</text></g>
        ); })}
        {band && <path d={bandPath()} fill="rgba(59,130,246,0.12)" />}
        {target != null && <line x1={L} x2={W - R} y1={Y(target)} y2={Y(target)} stroke="#16a34a" strokeDasharray="3 3" />}
        <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join(' ')} fill="none" stroke="#1f2937" strokeWidth="2" />
        {pts.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="3.5" fill="#1f2937" />)}
        <text x={W / 2} y={H - 4} fontSize="9" textAnchor="middle" fill="#6b7280">weeks</text>
      </svg>
      <p className="text-[11px] text-gray-500">
        Line = this athlete{band ? ' · blue band = typical recovery range' : ''}{target != null ? ` · green = ${target}% return benchmark` : ''}
      </p>
    </div>
  );
}

export default function PtProgressChecks({ playerId, canEdit, currentUserId, defaultCtx, programId = null }) {
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ctx, setCtx] = useState({ region: 'knee', nature: 'acute', ageB: '20s', sex: 'unspec', ...(defaultCtx || {}) });
  const [form, setForm] = useState({});
  const [checkDate, setCheckDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // The generator passes a live context; only the profile tab (no default)
  // adopts the last check's context, and changing the form must not refetch.
  const hasDefault = useRef(!!defaultCtx);
  const load = useCallback(async () => {
    if (!playerId) return;
    setLoading(true);
    const { data, error: e } = await supabase.from('pt_progress_checks').select('*')
      .eq('player_id', playerId).order('check_date', { ascending: true }).order('created_at', { ascending: true });
    if (e) setError(`Could not load progress checks: ${formatUserError(e)}`);
    else {
      setError('');
      setChecks(data || []);
      // Re-use the last check's grading context unless the generator passed one.
      const last = (data || [])[data.length - 1];
      if (last && !hasDefault.current) setCtx({ region: last.region, nature: last.nature, ageB: last.age_band || '20s', sex: last.sex || 'unspec' });
    }
    setLoading(false);
  }, [playerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (defaultCtx) setCtx((c) => ({ ...c, ...defaultCtx })); }, [defaultCtx]);

  const fields = useMemo(() => checkFields(ctx), [ctx]);
  const latest = checks[checks.length - 1];
  const latestCtx = latest ? { region: latest.region, nature: latest.nature, ageB: latest.age_band, sex: latest.sex, tsi: latest.week } : null;
  const grades = useMemo(() => (latest ? gradeCheck(latest, latestCtx) : []), [latest]); // eslint-disable-line react-hooks/exhaustive-deps
  const overall = grades.length ? overallRead(grades) : null;
  const cols = ['week', ...CHECK_METRICS].filter((k) => checks.some((c) => c[k] != null));

  const logCheck = async () => {
    const metrics = {};
    fields.forEach((f) => { metrics[f.id] = num(form[f.id]); });
    if (!CHECK_METRICS.some((k) => metrics[k] != null)) { setError('Enter at least one measurement.'); return; }
    if (metrics.pain != null && (metrics.pain < 0 || metrics.pain > 10)) { setError('Pain must be 0–10.'); return; }
    setSaving(true);
    setError('');
    const { error: e } = await supabase.from('pt_progress_checks').insert({
      player_id: playerId, program_id: programId, check_date: checkDate,
      region: ctx.region, nature: ctx.nature, age_band: ctx.ageB, sex: ctx.sex,
      notes: notes.trim() || null, created_by: currentUserId, ...metrics,
    }).select('id');
    setSaving(false);
    if (e) { setError(`Check not saved: ${formatUserError(e)}`); return; }
    setForm({});
    setNotes('');
    load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this progress check?')) return;
    const { data, error: e } = await supabase.from('pt_progress_checks').delete().eq('id', id).select('id');
    if (e || !data?.length) { setError(e ? formatUserError(e) : 'Not deleted — the database refused the change.'); return; }
    load();
  };

  const sel = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white';

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Activity size={18} className="text-blue-600" />
        <h4 className="text-sm font-semibold text-gray-800">Recovery progress checks</h4>
      </div>
      {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {canEdit && (
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <label className="text-xs text-gray-600">Date<input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} className={sel} /></label>
            <label className="text-xs text-gray-600">Region<select value={ctx.region} onChange={(e) => setCtx({ ...ctx, region: e.target.value })} className={sel}>{Object.entries(REGIONS).map(([k, r]) => <option key={k} value={k}>{r.name}</option>)}</select></label>
            <label className="text-xs text-gray-600">Nature<select value={ctx.nature} onChange={(e) => setCtx({ ...ctx, nature: e.target.value })} className={sel}>{Object.entries(NATURE_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className="text-xs text-gray-600">Age band<select value={ctx.ageB} onChange={(e) => setCtx({ ...ctx, ageB: e.target.value })} className={sel}>{Object.entries(AGE_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className="text-xs text-gray-600">Sex (norms only)<select value={ctx.sex} onChange={(e) => setCtx({ ...ctx, sex: e.target.value })} className={sel}><option value="unspec">Not set</option><option value="m">Male</option><option value="f">Female</option></select></label>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {fields.map((f) => (
              <label key={f.id} className="text-xs text-gray-600">{f.lab} <span className="text-gray-400">({f.u})</span>
                <input type="number" step="0.1" value={form[f.id] ?? ''} onChange={(e) => setForm({ ...form, [f.id]: e.target.value })} className={sel} />
              </label>
            ))}
          </div>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={sel} />
          <button onClick={logCheck} disabled={saving} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1">
            {saving && <Loader2 size={14} className="animate-spin" />} Log check
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : checks.length === 0 ? (
        <p className="text-sm text-gray-500">No progress checks logged yet.{canEdit ? ' Enter measurements above and press Log check — each one is graded against age/level norms and the typical recovery curve.' : ''}</p>
      ) : (
        <>
          <div>
            <p className="text-xs text-gray-500 mb-2">
              Latest check · {latest.check_date}{latest.week != null ? ` · week ${latest.week}` : ''} · {REGIONS[latest.region]?.name || latest.region}, {NATURE_NAME[latest.nature] || latest.nature}
            </p>
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {grades.map((g) => (
                <div key={g.metric} className="px-3 py-2 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 text-sm">
                  <span className="sm:w-32 font-medium text-gray-800 shrink-0">{g.metric}</span>
                  <span className="sm:w-16 text-gray-900 shrink-0">{g.value}</span>
                  <span className="text-gray-600">
                    {g.gate && <span className="mr-1 inline-block rounded px-1.5 py-0.5 text-[11px] bg-green-100 text-green-800">gate met</span>}
                    {g.tag && <span className={`mr-1 inline-block rounded px-1.5 py-0.5 text-[11px] ${TONE[g.cls] || 'bg-gray-100 text-gray-700'}`}>{g.tag}</span>}
                    {g.txt}
                  </span>
                </div>
              ))}
            </div>
            {overall && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${overall.tone === 'warn' ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-green-50 text-green-900 border border-green-200'}`}>{overall.text}</p>
            )}
          </div>

          {checks.length > 1 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">Date</th>{cols.map((c) => <th key={c} className="py-1 pr-3">{COL_LABEL[c]}</th>)}{canEdit && <th />}</tr></thead>
                <tbody>
                  {checks.map((c) => (
                    <tr key={c.id} className="border-t border-gray-100">
                      <td className="py-1 pr-3 whitespace-nowrap">{c.check_date}</td>
                      {cols.map((k) => <td key={k} className="py-1 pr-3">{c[k] != null ? Number(c[k]) : '·'}</td>)}
                      {canEdit && <td><button onClick={() => remove(c.id)} className="text-gray-400 hover:text-red-600" aria-label="Delete check"><Trash2 size={13} /></button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {checks.length === 1 && canEdit && (
            <button onClick={() => remove(latest.id)} className="text-xs text-gray-500 hover:text-red-600 inline-flex items-center gap-1"><Trash2 size={12} /> Delete this check</button>
          )}
          <TrajectoryChart checks={checks} nature={latest.nature} />
        </>
      )}
      <p className="text-[11px] text-gray-400">References are population averages — a guide, not a race. Never push past a phase gate just to catch up to a curve.</p>
    </div>
  );
}
