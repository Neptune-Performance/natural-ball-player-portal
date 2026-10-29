// #474 — Player Card: MLB The Show style ratings for an athlete.
//
// Grades come from player_rating_inputs() (own values + age-group percentile,
// SECURITY DEFINER so no other athlete's data reaches the browser) and are
// turned into 0-99 ratings by src/playerRatings.js, the one config to tune.
// Coach ratings (player_rating_overrides) replace any category, and the
// 'overall' row holds the Potential letter.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Save, X, Info } from 'lucide-react';
import { supabase } from './supabaseClient';
import { formatUserError } from './errorMessage';
import { classLabelForGradYear } from './gradYear';
import {
  RATING_CATEGORIES, POTENTIAL_GRADES, COHORT_LABELS,
  buildPlayerRatings, ratingTone, formatMetricValue, metricBasis, categoryBasis,
} from './playerRatings';

function ageFromDob(dob) {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(`${dob}T00:00:00`)) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) ? age : null;
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function BioItem({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-widest text-white/50">{label}</p>
      <p className="text-sm font-semibold text-white truncate">{value || '—'}</p>
    </div>
  );
}

export default function PlayerCard({ userId, userRole, loggedInUserId }) {
  const isStaff = userRole === 'admin' || userRole === 'coach';
  const [person, setPerson] = useState(null);
  const [profile, setProfile] = useState(null);
  const [inputs, setInputs] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('hitting');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError('');
    const [u, p, r, o] = await Promise.all([
      supabase.from('users').select('id, full_name, avatar_url, height, weight, date_of_birth').eq('id', userId).maybeSingle(),
      supabase.from('player_profiles').select('bats, throws, position, jersey_number, grad_year').eq('user_id', userId).limit(1),
      supabase.rpc('player_rating_inputs', { p_player: userId }),
      supabase.from('player_rating_overrides').select('category, rating, potential, note, updated_at').eq('player_id', userId),
    ]);
    if (u.error || r.error || o.error) setError(formatUserError(u.error || r.error || o.error, 'Could not load the player card.'));
    setPerson(u.data || null);
    setProfile((p.data && p.data[0]) || null);
    setInputs(r.data || []);
    setOverrides(o.data || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const model = useMemo(() => buildPlayerRatings(inputs, overrides), [inputs, overrides]);
  const selectedCat = model.categories.find((c) => c.key === selected) || model.categories[0];
  const overallTone = ratingTone(model.overall);
  const age = ageFromDob(person?.date_of_birth);
  const classLabel = classLabelForGradYear(profile?.grad_year);
  // The age group the athlete is ranked in: whichever band most metrics used.
  const cohortLabel = useMemo(() => {
    const counts = {};
    for (const r of inputs) if (r.percentile != null) counts[r.cohort] = (counts[r.cohort] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? COHORT_LABELS[top[0]] || top[0] : null;
  }, [inputs]);

  if (loading) {
    return <div className="py-12 text-center text-gray-500 text-sm">Loading player card…</div>;
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="relative overflow-hidden rounded-2xl text-white shadow-xl bg-gradient-to-br from-[#070b2a] via-[#16124a] to-[#3b1670] p-4 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -left-10 bottom-0 h-40 w-40 rounded-full bg-indigo-500/20 blur-3xl" />

        {/* Header: photo, name, Overall + Potential */}
        <div className="relative flex gap-4 sm:gap-6">
          <div className="shrink-0">
            {person?.avatar_url ? (
              <img src={person.avatar_url} alt="" className="h-28 w-24 sm:h-40 sm:w-32 rounded-xl object-cover ring-2 ring-white/20" />
            ) : (
              <div className="h-28 w-24 sm:h-40 sm:w-32 rounded-xl ring-2 ring-white/20 bg-white/10 flex items-center justify-center text-3xl font-black text-white/70">
                {initials(person?.full_name)}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.25em] text-white/50">
              {[profile?.position, profile?.jersey_number ? `#${profile.jersey_number}` : null].filter(Boolean).join(' · ') || 'Natural Ball Player'}
            </p>
            <h2 className="mt-0.5 text-2xl sm:text-4xl font-black uppercase leading-tight tracking-tight break-words">
              {person?.full_name || 'Athlete'}
            </h2>
            <div className="mt-3 flex items-stretch gap-2 sm:gap-3">
              <div className="rounded-xl bg-white/10 px-3 py-2 sm:px-4 text-center" title={model.overallOverride != null ? 'Overall: coach rating' : 'Overall: weighted average of the graded categories'}>
                <p className="text-[10px] uppercase tracking-widest text-white/60">Overall</p>
                <p className={`text-3xl sm:text-5xl font-black leading-none ${overallTone.text}`}>{model.overall ?? '—'}</p>
              </div>
              <div className="rounded-xl bg-white/10 px-3 py-2 sm:px-4 text-center" title="Potential: set by your coaches">
                <p className="text-[10px] uppercase tracking-widest text-white/60">Potential</p>
                <p className="text-3xl sm:text-5xl font-black leading-none text-fuchsia-300">{model.potential || '—'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Bio row */}
        <div className="relative mt-4 grid grid-cols-3 sm:grid-cols-6 gap-x-3 gap-y-2 border-y border-white/10 py-3">
          <BioItem label="B/T" value={profile?.bats || profile?.throws ? `${profile?.bats || '?'}/${profile?.throws || '?'}` : null} />
          <BioItem label="Height" value={person?.height} />
          <BioItem label="Weight" value={person?.weight ? `${String(person.weight).replace(/\s*lbs?$/i, '')} lb` : null} />
          <BioItem label="Age" value={age != null ? String(age) : null} />
          <BioItem label="Class" value={classLabel} />
          <BioItem label="Grad" value={profile?.grad_year ? String(profile.grad_year) : null} />
        </div>

        {/* Attribute bars */}
        <div className="relative mt-4 grid grid-cols-8 gap-1 sm:gap-3">
          {model.categories.map((cat) => {
            const tone = ratingTone(cat.rating);
            const active = cat.key === selectedCat.key;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setSelected(cat.key)}
                title={categoryBasis(cat)}
                aria-label={`${cat.label} ${cat.rating ?? 'not graded'}`}
                className={`flex flex-col items-center rounded-lg px-0.5 py-1.5 transition touch-manipulation ${active ? 'bg-white/15' : 'hover:bg-white/5'}`}
              >
                <span className={`text-sm sm:text-xl font-black leading-none ${tone.text}`}>{cat.rating ?? '—'}</span>
                <span className="mt-1.5 flex h-20 sm:h-28 w-3 sm:w-5 items-end overflow-hidden rounded-full bg-white/10">
                  {cat.rating != null && (
                    <span className={`block w-full rounded-full ${tone.bar}`} style={{ height: `${Math.max(4, cat.rating)}%` }} />
                  )}
                </span>
                <span className="mt-1.5 text-[9px] sm:text-[11px] font-bold tracking-wide text-white/80 leading-none">{cat.short}</span>
                {cat.source === 'coach' && <span className="mt-1 h-1 w-1 rounded-full bg-fuchsia-300" title="Coach rating" />}
              </button>
            );
          })}
        </div>

        {/* Selected category breakdown (the "repertoire" panel) */}
        <div className="relative mt-4 rounded-xl bg-black/25 p-3 sm:p-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-bold uppercase tracking-wider">{selectedCat.label}</p>
            <p className="text-xs text-white/60">
              {selectedCat.source === 'coach' && 'Coach rating'}
              {selectedCat.source === 'data' && 'From your data'}
              {!selectedCat.source && 'Not graded yet'}
              {isStaff && selectedCat.source === 'coach' && selectedCat.computed != null && ` · data says ${selectedCat.computed}`}
            </p>
          </div>
          {selectedCat.note && <p className="mt-1 text-xs italic text-white/70">“{selectedCat.note}”</p>}
          <ul className="mt-2 space-y-2">
            {selectedCat.metrics.map((m) => {
              const tone = ratingTone(m.rating);
              return (
                <li key={m.key} className="flex items-center gap-2 sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs sm:text-sm text-white/90 truncate">{m.label}</span>
                      <span className="text-xs sm:text-sm font-semibold tabular-nums whitespace-nowrap">{formatMetricValue(m)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                      {m.rating != null && <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${m.rating}%` }} />}
                    </div>
                    <p className="mt-0.5 text-[10px] sm:text-[11px] text-white/50">
                      {metricBasis(m)}{m.measuredOn ? ` · ${m.measuredOn}` : ''}
                    </p>
                  </div>
                  <span className={`w-9 shrink-0 rounded-md py-0.5 text-center text-xs font-black ${tone.chip}`}>{m.rating ?? '—'}</span>
                </li>
              );
            })}
          </ul>
          {!selectedCat.source && (
            <p className="mt-2 text-xs text-white/60">
              No data on file for this yet. {isStaff ? 'Set a coach rating with Edit ratings.' : 'Your coaches can add a rating.'}
            </p>
          )}
        </div>

        <p className="relative mt-3 flex items-start gap-1.5 text-[11px] text-white/50">
          <Info className="mt-px h-3 w-3 shrink-0" />
          <span>
            Ratings compare you with NBP athletes in your age group{cohortLabel ? ` (${cohortLabel})` : ''}: 40 is the bottom of the group, 70 the middle, 99 the top. Overall averages the graded categories ({model.gradedCount} of {RATING_CATEGORIES.length}).
          </span>
        </p>
      </div>

      {isStaff && !editing && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Edit2 className="h-4 w-4" /> Edit ratings
        </button>
      )}
      {isStaff && editing && (
        <RatingEditor
          userId={userId}
          loggedInUserId={loggedInUserId}
          model={model}
          onCancel={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); }}
        />
      )}
    </div>
  );
}

function RatingEditor({ userId, loggedInUserId, model, onCancel, onSaved }) {
  const initial = useMemo(() => {
    const rows = {};
    for (const c of model.categories) rows[c.key] = { rating: c.override ?? '', note: c.note || '' };
    rows.overall = { rating: model.overallOverride ?? '', note: model.overallNote || '', potential: model.potential || '' };
    return rows;
  }, [model]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const set = (cat, field, value) => setForm((f) => ({ ...f, [cat]: { ...f[cat], [field]: value } }));

  const save = async () => {
    setErr('');
    const upserts = [];
    const deletes = [];
    for (const [category, row] of Object.entries(form)) {
      const raw = String(row.rating ?? '').trim();
      let rating = null;
      if (raw !== '') {
        rating = Number(raw);
        if (!Number.isInteger(rating) || rating < 0 || rating > 99) {
          setErr(`${category === 'overall' ? 'Overall' : RATING_CATEGORIES.find((c) => c.key === category)?.label}: rating must be a whole number 0–99.`);
          return;
        }
      }
      const note = String(row.note || '').trim();
      const potential = category === 'overall' ? (row.potential || null) : null;
      if (rating == null && !note && !potential) deletes.push(category);
      else upserts.push({ player_id: userId, category, rating, note: note || null, potential, set_by: loggedInUserId, updated_at: new Date().toISOString() });
    }
    setSaving(true);
    try {
      if (upserts.length) {
        const { error } = await supabase.from('player_rating_overrides').upsert(upserts, { onConflict: 'player_id,category' });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await supabase.from('player_rating_overrides').delete().eq('player_id', userId).in('category', deletes);
        if (error) throw error;
      }
      await onSaved();
    } catch (e) {
      setErr(formatUserError(e, 'Could not save the ratings.'));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">Coach ratings</h3>
        <button type="button" onClick={onCancel} className="rounded p-1 text-gray-400 hover:text-gray-700" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <p className="mt-1 text-xs text-gray-500">A coach rating (0–99) replaces the computed number for that category. Leave blank to use the data. The athlete sees ratings and notes.</p>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_120px_120px] gap-2 rounded-lg bg-gray-50 p-3">
        <div className="text-sm font-semibold text-gray-800 self-center">Overall &amp; Potential <span className="font-normal text-gray-500">(data: {model.overallComputed ?? '—'})</span></div>
        <input type="number" min="0" max="99" placeholder="Overall" value={form.overall.rating} onChange={(e) => set('overall', 'rating', e.target.value)} className={inputCls} />
        <select value={form.overall.potential} onChange={(e) => set('overall', 'potential', e.target.value)} className={`${inputCls} bg-white`}>
          <option value="">Potential —</option>
          {POTENTIAL_GRADES.map((g) => <option key={g} value={g}>Potential {g}</option>)}
        </select>
        <input type="text" placeholder="Note (optional)" value={form.overall.note} onChange={(e) => set('overall', 'note', e.target.value)} className={`${inputCls} sm:col-span-3`} />
      </div>

      <div className="mt-3 space-y-3">
        {model.categories.map((c) => (
          <div key={c.key} className="grid grid-cols-[minmax(0,1fr)_88px] sm:grid-cols-[160px_88px_minmax(0,1fr)] gap-2 items-center">
            <div className="text-sm text-gray-800">
              {c.label} <span className="text-xs text-gray-500">(data: {c.computed ?? '—'})</span>
            </div>
            <input type="number" min="0" max="99" placeholder="—" value={form[c.key].rating} onChange={(e) => set(c.key, 'rating', e.target.value)} className={inputCls} />
            <input type="text" placeholder="Note (optional)" value={form[c.key].note} onChange={(e) => set(c.key, 'note', e.target.value)} className={`${inputCls} col-span-2 sm:col-span-1`} />
          </div>
        ))}
      </div>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
        <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save ratings'}
        </button>
      </div>
    </div>
  );
}
