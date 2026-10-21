import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import { Search, Loader2, ExternalLink, RefreshCw, Check, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { readAllPages } from './readAllPages';
import { formatUserError } from './errorMessage';
import { classifyWriteOutcome } from './writeOutcome';
import { fmtLocalDate } from './scheduleUtils';
import { validateVideoUrl, VIDEO_URL_HELP } from './ExerciseVideoGaps';
import { invalidateExerciseVideos } from './exerciseVideos';

/*
 * #459 — "Video library needs to show all of the 1,275 videos that already
 * have hyperlinks". The Missing videos screen (#170) only lists gaps, so staff
 * had no way to swap an existing link for one of NBP's own coaches.
 *
 * A library link is COPIED into every place it is used (workout_templates
 * exercises[].link, training_exercises.video_url, and the pipe-delimited notes
 * of scheduled workouts), so changing exercise_videos alone would change
 * nothing an athlete sees. Replacing a video therefore rewrites, after a
 * preview:
 *   - the exercise_videos row,
 *   - every template entry whose link is exactly the old URL,
 *   - every assigned program row whose video_url is exactly the old URL,
 *   - every scheduled workout from TODAY on whose notes contain the old URL.
 * Past calendar history is left as it was. Every write ends in .select() and
 * zero rows is reported as not saved (see writeOutcome.js).
 */

const VISIBLE_STEP = 100;
const READ_BATCH_SIZE = 50;

const sameUrl = (a, b) => String(a || '').trim() === String(b || '').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Only whole-URL occurrences: youtu.be/abc must not rewrite youtu.be/abcd.
const urlInTextRe = (url) => new RegExp(`${escapeRe(url)}(?=$|[\\s|)\\]"'<>,])`, 'g');

export default function ExerciseVideoLibrary() {
  const [videos, setVideos] = useState([]);
  const [usage, setUsage] = useState(new Map()); // url -> { templates, programs }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(VISIBLE_STEP);

  const [editingId, setEditingId] = useState(null);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftError, setDraftError] = useState('');
  const [preview, setPreview] = useState(null); // { video, newUrl, templates, programs, events }
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const [vids, tpls, progs] = await Promise.all([
      readAllPages(() => supabase.from('exercise_videos').select('id, name, name_key, video_url, updated_at').order('name_key').order('id')),
      readAllPages(() => supabase.from('workout_templates').select('id, exercises').order('id')),
      readAllPages(() => supabase.from('training_exercises').select('id, video_url').order('id')),
    ]);
    const err = vids.error || tpls.error || progs.error;
    if (err) {
      console.error('ExerciseVideoLibrary: load failed:', err);
      setLoadError(`Could not load the video library: ${formatUserError(err)}`);
      setLoading(false);
      return;
    }
    const counts = new Map();
    const bump = (url, field) => {
      const k = String(url || '').trim();
      if (!k) return;
      const c = counts.get(k) || { templates: 0, programs: 0 };
      c[field] += 1;
      counts.set(k, c);
    };
    tpls.rows.forEach((t) => (Array.isArray(t.exercises) ? t.exercises : []).forEach((x) => bump(x && x.link, 'templates')));
    progs.rows.forEach((r) => bump(r.video_url, 'programs'));
    setVideos(vids.rows);
    setUsage(counts);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter((v) => (v.name || '').toLowerCase().includes(q) || (v.video_url || '').toLowerCase().includes(q));
  }, [videos, query]);

  const startEdit = (v) => {
    setEditingId(v.id);
    setDraftUrl('');
    setDraftError('');
    setPreview(null);
    setResult(null);
  };
  const cancelEdit = () => { setEditingId(null); setPreview(null); setDraftError(''); };

  // Count exactly what Apply would touch, from fresh reads.
  const buildPreview = async (video) => {
    const check = validateVideoUrl(draftUrl);
    if (!check.ok) { setDraftError(check.reason); return; }
    if (sameUrl(check.url, video.video_url)) { setDraftError('That is already the link for this video.'); return; }
    setDraftError('');
    setPreviewing(true);
    const oldUrl = String(video.video_url || '').trim();
    const today = fmtLocalDate(new Date());
    const [tpls, progs, evs] = await Promise.all([
      readAllPages(() => supabase.from('workout_templates').select('id, exercises').order('id')),
      readAllPages(() => supabase.from('training_exercises').select('id').eq('video_url', oldUrl).order('id')),
      // LIKE is only a coarse filter ('_' is a wildcard); the regex below decides.
      readAllPages(() => supabase.from('schedule_events').select('id, notes').gte('event_date', today).like('notes', `%${oldUrl}%`).order('id')),
    ]);
    setPreviewing(false);
    const err = tpls.error || progs.error || evs.error;
    if (err) { setDraftError(`Could not count where this video is used: ${formatUserError(err)}`); return; }
    const templateIds = [];
    let templateEntries = 0;
    tpls.rows.forEach((t) => {
      const n = (Array.isArray(t.exercises) ? t.exercises : []).filter((x) => x && sameUrl(x.link, oldUrl)).length;
      if (n > 0) { templateIds.push(t.id); templateEntries += n; }
    });
    const re = urlInTextRe(oldUrl);
    const eventIds = evs.rows.filter((e) => { re.lastIndex = 0; return re.test(e.notes || ''); }).map((e) => e.id);
    setPreview({ video, oldUrl, newUrl: check.url, templateIds, templateEntries, programIds: progs.rows.map((r) => r.id), eventIds });
  };

  const apply = async () => {
    if (!preview) return;
    const { video, oldUrl, newUrl, templateIds, programIds, eventIds } = preview;
    setApplying(true);
    const failures = [];
    let templateEntriesWritten = 0;
    let programsWritten = 0;
    let eventsWritten = 0;

    // 1. The library row itself.
    const { data: vRow, error: vErr } = await supabase.from('exercise_videos')
      .update({ video_url: newUrl, updated_at: new Date().toISOString() }).eq('id', video.id).select('id');
    const vOut = classifyWriteOutcome({ error: vErr, data: vRow, expected: 1 });
    if (vOut.outcome !== 'written') {
      setApplying(false);
      setResult({ ok: false, message: vErr ? formatUserError(vErr) : 'The library row was not saved (the database refused the change). Nothing else was touched.' });
      return;
    }

    // 2. Templates — re-read and rewrite only entries still on the old URL.
    for (let i = 0; i < templateIds.length; i += READ_BATCH_SIZE) {
      const batch = templateIds.slice(i, i + READ_BATCH_SIZE);
      const { data: fresh, error: rErr } = await supabase.from('workout_templates').select('id, name, exercises').in('id', batch);
      if (rErr) { failures.push(`${batch.length} workout template(s): ${formatUserError(rErr)}`); continue; }
      for (const tpl of fresh || []) {
        let changed = 0;
        const next = (Array.isArray(tpl.exercises) ? tpl.exercises : []).map((x) => {
          if (!x || !sameUrl(x.link, oldUrl)) return x;
          changed += 1;
          return { ...x, link: newUrl };
        });
        if (!changed) continue;
        const { data: up, error: uErr } = await supabase.from('workout_templates').update({ exercises: next }).eq('id', tpl.id).select('id');
        const out = classifyWriteOutcome({ error: uErr, data: up, expected: 1 });
        if (out.outcome === 'written') templateEntriesWritten += changed;
        else failures.push(`template "${tpl.name || tpl.id}": ${uErr ? formatUserError(uErr) : 'not saved'}`);
      }
    }

    // 3. Assigned program rows — guarded on the old URL so a concurrent edit wins.
    if (programIds.length > 0) {
      for (let i = 0; i < programIds.length; i += 200) {
        const ids = programIds.slice(i, i + 200);
        const { data: up, error: uErr } = await supabase.from('training_exercises')
          .update({ video_url: newUrl }).in('id', ids).eq('video_url', oldUrl).select('id');
        if (uErr) failures.push(`${ids.length} program row(s): ${formatUserError(uErr)}`);
        else programsWritten += (up || []).length;
      }
    }

    // 4. Upcoming scheduled workouts — replace the URL inside the notes text.
    for (let i = 0; i < eventIds.length; i += READ_BATCH_SIZE) {
      const batch = eventIds.slice(i, i + READ_BATCH_SIZE);
      const { data: fresh, error: rErr } = await supabase.from('schedule_events').select('id, notes').in('id', batch);
      if (rErr) { failures.push(`${batch.length} scheduled workout(s): ${formatUserError(rErr)}`); continue; }
      for (const ev of fresh || []) {
        const nextNotes = (ev.notes || '').replace(urlInTextRe(oldUrl), newUrl);
        if (nextNotes === ev.notes) continue;
        const { data: up, error: uErr } = await supabase.from('schedule_events').update({ notes: nextNotes }).eq('id', ev.id).select('id');
        const out = classifyWriteOutcome({ error: uErr, data: up, expected: 1 });
        if (out.outcome === 'written') eventsWritten += 1;
        else failures.push(`scheduled workout ${ev.id}: ${uErr ? formatUserError(uErr) : 'not saved'}`);
      }
    }

    invalidateExerciseVideos();
    setApplying(false);
    setEditingId(null);
    setPreview(null);
    await load();
    setResult({
      ok: failures.length === 0,
      message: `"${video.name}" now links to the new video. Updated ${templateEntriesWritten} workout entr${templateEntriesWritten === 1 ? 'y' : 'ies'}, ${programsWritten} program row${programsWritten === 1 ? '' : 's'} and ${eventsWritten} upcoming scheduled workout${eventsWritten === 1 ? '' : 's'}.`,
      failures,
    });
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-500 py-8"><Loader2 className="animate-spin" size={18} /> Loading the video library…</div>;
  }
  if (loadError) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{loadError}</span>
        <button onClick={load} className="inline-flex items-center gap-1 text-red-700 font-medium"><RefreshCw size={14} /> Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">All videos</h3>
          <p className="text-sm text-gray-600">
            {videos.length.toLocaleString()} movements have a video. Replacing one updates the library, every workout and program
            that uses that link, and upcoming scheduled workouts.
          </p>
        </div>
        <div className="relative sm:w-72">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setVisible(VISIBLE_STEP); }}
            placeholder="Search movement or link"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
      </div>

      {result && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${result.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <div className="flex items-start gap-2">
            {result.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <div>
              <p>{result.message}</p>
              {result.failures && result.failures.length > 0 && (
                <ul className="mt-1 list-disc pl-5">{result.failures.map((f) => <li key={f}>Not saved: {f}</li>)}</ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
        {filtered.slice(0, visible).map((v) => {
          const u = usage.get(String(v.video_url || '').trim()) || { templates: 0, programs: 0 };
          const editing = editingId === v.id;
          return (
            <div key={v.id} className="px-4 py-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 break-words">{v.name}</p>
                  <a href={v.video_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 break-all">
                    <ExternalLink size={12} className="shrink-0" />{v.video_url}
                  </a>
                </div>
                <p className="text-xs text-gray-500 sm:w-44 shrink-0">
                  {u.templates.toLocaleString()} workout entr{u.templates === 1 ? 'y' : 'ies'} · {u.programs.toLocaleString()} program row{u.programs === 1 ? '' : 's'}
                </p>
                {!editing && (
                  <button onClick={() => startEdit(v)} className="text-sm font-medium text-blue-600 hover:text-blue-800 shrink-0 self-start sm:self-auto">
                    Replace video
                  </button>
                )}
              </div>

              {editing && (
                <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3 space-y-2">
                  {!preview ? (
                    <>
                      <label className="block text-xs font-medium text-gray-700">New video link</label>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          autoFocus
                          value={draftUrl}
                          onChange={(e) => { setDraftUrl(e.target.value); setDraftError(''); }}
                          placeholder="https://youtu.be/…"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        <button onClick={() => buildPreview(v)} disabled={previewing} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1">
                          {previewing ? <Loader2 size={14} className="animate-spin" /> : null} Review change
                        </button>
                        <button onClick={cancelEdit} className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700">Cancel</button>
                      </div>
                      <p className="text-xs text-gray-500">{draftError ? <span className="text-red-600">{draftError}</span> : VIDEO_URL_HELP}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-gray-800">This will replace the link for <span className="font-semibold">{v.name}</span> in:</p>
                      <ul className="text-sm text-gray-700 list-disc pl-5">
                        <li>the video library</li>
                        <li>{preview.templateEntries.toLocaleString()} workout template entr{preview.templateEntries === 1 ? 'y' : 'ies'} ({preview.templateIds.length.toLocaleString()} template{preview.templateIds.length === 1 ? '' : 's'})</li>
                        <li>{preview.programIds.length.toLocaleString()} assigned program row{preview.programIds.length === 1 ? '' : 's'}</li>
                        <li>{preview.eventIds.length.toLocaleString()} scheduled workout{preview.eventIds.length === 1 ? '' : 's'} from today on (past ones are left as they were)</li>
                      </ul>
                      <p className="text-xs text-gray-500 break-all">New link: {preview.newUrl}</p>
                      <div className="flex gap-2">
                        <button onClick={apply} disabled={applying} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1">
                          {applying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {applying ? 'Saving…' : 'Replace everywhere'}
                        </button>
                        <button onClick={() => setPreview(null)} disabled={applying} className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 inline-flex items-center gap-1">
                          <X size={14} /> Back
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="px-4 py-6 text-sm text-gray-500">No videos match "{query}".</p>}
      </div>

      {filtered.length > visible && (
        <button onClick={() => setVisible((n) => n + VISIBLE_STEP)} className="text-sm font-medium text-blue-600 hover:text-blue-800">
          Show more ({(filtered.length - visible).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}
