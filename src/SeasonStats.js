// #487: season stats read from screenshots (GameChanger and friends) into
// external_season_stats, shown on the profile Stats tab under External Stats.
//
// GameChanger athlete pages need a login, so the app can't read a gc.com link.
// Instead the athlete (or staff) screenshots the season stat pages (batting,
// pitching, fielding); stats-extract (Claude vision) reads one line per
// season per category; the uploader checks / edits every number here, then
// saves. Rates the screen didn't show are filled from the counting stats
// (deriveSeasonLine). A re-import of the same source + season + category +
// team replaces the earlier line.
//
// These lines feed the Player Card (rating_metric_values, migration
// 20261107_stats_screenshot_import.sql): Game Play OBP / OPS / WHIP / ERA /
// K% and Fielding %, recent seasons weighted more.

import React, { useState, useEffect, useCallback } from 'react';
import { X, Camera, Trash2, Plus, Loader2, BarChart3 } from 'lucide-react';
import { supabase } from './supabaseClient';
import { formatUserError } from './errorMessage';
import { EXTERNAL_STAT_SOURCES, EXTERNAL_STATS_BUCKET, sourceInfo } from './externalStatsSources';
import { uploadScreenshots, extractStats, deriveSeasonLine, seasonLineKey, SEASON_FIELDS, RATE_FIELDS } from './statsExtract';

const CATEGORIES = [
  { key: 'hitting', label: 'Hitting' },
  { key: 'pitching', label: 'Pitching' },
  { key: 'fielding', label: 'Fielding' },
];
const ALL_STAT_KEYS = [...new Set(Object.values(SEASON_FIELDS).flat().map(([k]) => k))];
const INT_KEYS = new Set(ALL_STAT_KEYS.filter((k) => !RATE_FIELDS.has(k)));

const toNum = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtRate = (k, v) => {
  if (v == null) return '—';
  const x = Number(v);
  if (['avg', 'obp', 'slg', 'ops', 'baa', 'fpct'].includes(k)) return x < 1 ? x.toFixed(3).replace(/^0/, '') : x.toFixed(3);
  if (k === 'era' || k === 'whip') return x.toFixed(2);
  if (k === 'ip') return String(x);
  return String(Math.round(x));
};
const yearOf = (season) => { const m = String(season || '').match(/(20\d{2})/); return m ? Number(m[1]) : null; };

// A review-table line holds strings for the inputs.
const toDraft = (line, source) => {
  const d = { _id: Math.random().toString(36).slice(2), source, category: line.category || 'hitting', season: line.season || '', season_year: line.season_year ?? '', team: line.team || '', extras: line.extras || {} };
  for (const k of ALL_STAT_KEYS) d[k] = line[k] == null ? '' : String(line[k]);
  return d;
};

export default function SeasonStats({ userId, loggedInUserId, canManage }) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('external_season_stats').select('*')
      .eq('player_id', userId)
      .order('season_year', { ascending: false, nullsFirst: false })
      .order('season', { ascending: false })
      .order('id');
    if (error) console.error('Error loading season stats:', error);
    setLines(data || []);
    setLoading(false);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const remove = async (line) => {
    if (!window.confirm(`Delete the ${line.season} ${line.category} line?`)) return;
    const { error } = await supabase.from('external_season_stats').delete().eq('id', line.id);
    if (error) { alert('Delete failed: ' + formatUserError(error)); return; }
    load();
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-gray-900 flex items-center gap-1.5"><BarChart3 size={16} className="text-blue-600" />Season stats</h4>
          <p className="text-xs text-gray-500 mt-0.5">Season-by-season hitting, pitching and fielding. These count toward the Player Card's Game Play and Fielding ratings (recent seasons count more).</p>
        </div>
        {canManage && (
          <button onClick={() => setImporting(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 min-h-[40px]">
            <Camera size={16} />Import stats from screenshots
          </button>
        )}
      </div>
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : !lines.length ? (
        <p className="text-sm text-gray-500">
          No season stats yet.{canManage && ' On GameChanger, open your Stats page for each season (batting, pitching and fielding), take screenshots, and import them here.'}
        </p>
      ) : CATEGORIES.map((cat) => {
        const rows = lines.filter((l) => l.category === cat.key);
        if (!rows.length) return null;
        const fields = SEASON_FIELDS[cat.key];
        return (
          <div key={cat.key}>
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">{cat.label}</p>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-100 text-gray-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-semibold">Season</th>
                    {fields.map(([k, h]) => <th key={k} className="px-1.5 py-1.5 text-right font-semibold">{h}</th>)}
                    {canManage && <th />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span className="font-medium text-gray-900">{l.season}</span>
                        {l.team && <span className="text-gray-500"> · {l.team}</span>}
                        <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${sourceInfo(l.source).color}`}>{sourceInfo(l.source).label}</span>
                      </td>
                      {fields.map(([k]) => <td key={k} className="px-1.5 py-1 text-right text-gray-800">{fmtRate(k, l[k])}</td>)}
                      {canManage && (
                        <td className="px-1 py-1"><button onClick={() => remove(l)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><Trash2 size={13} /></button></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {importing && (
        <SeasonStatsImport userId={userId} loggedInUserId={loggedInUserId} existing={lines}
          onClose={() => setImporting(false)} onSaved={load} />
      )}
    </div>
  );
}

function SeasonStatsImport({ userId, loggedInUserId, existing, onClose, onSaved }) {
  const [source, setSource] = useState('gamechanger');
  const [files, setFiles] = useState([]);
  const [paths, setPaths] = useState([]);
  const [step, setStep] = useState('pick'); // pick | reading | review | saving
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [readNotes, setReadNotes] = useState('');
  const [savedSome, setSavedSome] = useState(false); // saved lines point at the screenshots

  const read = async () => {
    if (!files.length) { setError('Choose at least one screenshot.'); return; }
    if (files.length > 10) { setError('Up to 10 screenshots at a time. Import the rest in a second batch.'); return; }
    setError(''); setStep('reading');
    try {
      let uploaded = paths;
      if (!uploaded.length) {
        uploaded = await uploadScreenshots(EXTERNAL_STATS_BUCKET, userId, files, 'screenshots-');
        setPaths(uploaded);
      }
      const result = await extractStats({ mode: 'game_stats', playerId: userId, paths: uploaded });
      const got = (result.lines || []).map((l) => {
        const extras = {};
        for (const e of l.extras || []) if (e?.label) extras[e.label] = e.value;
        return toDraft({ ...l, extras }, source);
      });
      setDrafts(got);
      setReadNotes([result.athlete_name_seen ? `Name on screen: ${result.athlete_name_seen}.` : '', result.notes || ''].filter(Boolean).join(' '));
      if (!got.length) setError('No season stats were found in those screenshots. Make sure they show the stat tables, or add lines by hand.');
      setStep('review');
    } catch (err) {
      setError(err.message || String(err));
      setStep('pick');
    }
  };

  const setCell = (id, k, v) => setDrafts((ds) => ds.map((d) => (d._id === id ? { ...d, [k]: v } : d)));
  const addLine = (category) => setDrafts((ds) => [...ds, toDraft({ category }, source)]);
  const removeLine = (id) => setDrafts((ds) => ds.filter((d) => d._id !== id));

  const discard = async () => {
    if (paths.length && !savedSome) await supabase.storage.from(EXTERNAL_STATS_BUCKET).remove(paths);
    onClose();
  };

  const save = async () => {
    const bad = drafts.find((d) => !d.season.trim());
    if (bad) { setError('Every line needs a season (e.g. "2025" or "Spring 2025").'); return; }
    if (!drafts.length) { setError('There is nothing to save.'); return; }
    setError(''); setStep('saving');
    const byKey = new Map(existing.map((l) => [seasonLineKey(l), l]));
    const seen = new Set();
    for (const d of drafts) {
      const base = { category: d.category };
      for (const k of ALL_STAT_KEYS) {
        const v = toNum(d[k]);
        base[k] = v == null ? null : (INT_KEYS.has(k) ? Math.round(v) : v);
      }
      const derived = deriveSeasonLine(base);
      const row = {
        player_id: userId,
        source,
        season: d.season.trim(),
        season_year: toNum(d.season_year) ?? yearOf(d.season),
        category: d.category,
        team: d.team.trim() || null,
        extras: Object.keys(d.extras || {}).length ? d.extras : null,
        origin: 'screenshot',
        screenshot_paths: paths,
        updated_at: new Date().toISOString(),
      };
      for (const k of ALL_STAT_KEYS) {
        // Only the category's own fields are stored.
        row[k] = (SEASON_FIELDS[d.category] || []).some(([f]) => f === k) ? derived[k] ?? null : null;
      }
      const key = seasonLineKey(row);
      if (seen.has(key)) continue; // duplicate line in this batch
      seen.add(key);
      const match = byKey.get(key);
      const { error: err } = match
        ? await supabase.from('external_season_stats').update(row).eq('id', match.id)
        : await supabase.from('external_season_stats').insert({ ...row, uploaded_by: loggedInUserId });
      if (err) { setError(`Saving ${row.season} ${row.category} failed: ${formatUserError(err)}`); setStep('review'); onSaved?.(); return; }
      setSavedSome(true);
    }
    onSaved?.();
    onClose();
  };

  const busy = step === 'reading' || step === 'saving';
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl max-h-[95vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Import season stats from screenshots</h3>
            <p className="text-xs text-gray-500">The numbers are read automatically. Check them against your screenshots before saving.</p>
          </div>
          <button onClick={discard} disabled={busy} className="p-1.5 text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          {step !== 'review' && step !== 'saving' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block">
                  <span className="block text-xs font-medium text-gray-700 mb-1">Where are the stats from?</span>
                  <select value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white">
                    {EXTERNAL_STAT_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <div className="sm:col-span-2">
                  <span className="block text-xs font-medium text-gray-700 mb-1">Screenshots (up to 10)</span>
                  <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/heic" disabled={busy}
                    onChange={(e) => { setFiles([...(e.target.files || [])]); setPaths([]); }}
                    className="block w-full text-sm text-gray-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:bg-white file:text-blue-700 file:font-medium" />
                  {files.length > 0 && <p className="text-xs text-gray-500 mt-1">{files.length} image{files.length === 1 ? '' : 's'} selected.</p>}
                </div>
              </div>
              <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 space-y-1">
                <p className="font-medium text-gray-800">GameChanger: what to screenshot</p>
                <p>Open your athlete profile → Stats. For each season, screenshot the Batting, Pitching and Fielding tables (scroll sideways if columns are cut off, and include the season / team name at the top).</p>
              </div>
            </>
          )}
          {error && <p className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{error}</p>}
          {step === 'reading' && <p className="text-sm text-gray-600 flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Reading the screenshots… this can take up to a minute.</p>}
          {(step === 'review' || step === 'saving') && (
            <div className="space-y-4">
              {readNotes && <p className="text-xs bg-amber-50 text-amber-800 rounded-md px-2.5 py-2">Reader notes: {readNotes}</p>}
              {CATEGORIES.map((cat) => {
                const rows = drafts.filter((d) => d.category === cat.key);
                const fields = SEASON_FIELDS[cat.key];
                return (
                  <div key={cat.key}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{cat.label}</p>
                      <button onClick={() => addLine(cat.key)} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"><Plus size={12} />Add {cat.label.toLowerCase()} line</button>
                    </div>
                    {rows.length ? (
                      <div className="overflow-x-auto border border-gray-200 rounded-lg">
                        <table className="text-xs">
                          <thead className="bg-gray-100 text-gray-600">
                            <tr>
                              <th className="px-1.5 py-1.5 text-left font-semibold">Season</th>
                              <th className="px-1.5 py-1.5 text-left font-semibold">Team</th>
                              {fields.map(([k, h]) => <th key={k} className="px-1 py-1.5 text-left font-semibold">{h}</th>)}
                              <th />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {rows.map((d) => (
                              <tr key={d._id}>
                                <td className="px-1 py-1"><input value={d.season} onChange={(e) => setCell(d._id, 'season', e.target.value)} placeholder="2025" className="w-28 px-1 py-0.5 border border-gray-300 rounded" /></td>
                                <td className="px-1 py-1"><input value={d.team} onChange={(e) => setCell(d._id, 'team', e.target.value)} className="w-28 px-1 py-0.5 border border-gray-300 rounded" /></td>
                                {fields.map(([k]) => (
                                  <td key={k} className="px-0.5 py-1">
                                    <input value={d[k]} inputMode="decimal" onChange={(e) => setCell(d._id, k, e.target.value)}
                                      className={`${RATE_FIELDS.has(k) ? 'w-14' : 'w-11'} px-1 py-0.5 border rounded text-right ${d[k] !== '' && toNum(d[k]) == null ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                                  </td>
                                ))}
                                <td className="px-1 py-1"><button onClick={() => removeLine(d._id)} className="p-1 text-gray-400 hover:text-red-600" title="Remove line"><Trash2 size={13} /></button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="text-xs text-gray-400">None.</p>}
                  </div>
                );
              })}
              <p className="text-[11px] text-gray-400">Blank rates (AVG, OBP, SLG, OPS, ERA, WHIP, FPCT) are worked out from the counting stats when you save. A season you already imported from the same source and team is replaced. Player Card minimums: 15 PA for batting, 5 IP for pitching, 20 chances for fielding (across seasons from the last 3 years).</p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t">
          <button onClick={discard} disabled={busy} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          {step === 'review' || step === 'saving' ? (
            <>
              <button onClick={() => { setStep('pick'); setDrafts([]); setError(''); }} disabled={busy} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">Back</button>
              <button onClick={save} disabled={busy || !drafts.length} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {step === 'saving' ? 'Saving…' : `Save ${drafts.length} line${drafts.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button onClick={read} disabled={busy || !files.length} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              <Camera size={15} />{step === 'reading' ? 'Reading…' : 'Read screenshots'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
