// #421: the "Stats" profile tab. An athlete attaches their external stats —
// a GameChanger / Perfect Game / MaxPreps / PBR (or other) profile link
// and/or an exported file — so NBP staff can work from real game numbers
// during the year. Athletes manage their own entries; admin and coach can
// manage anyone's (RLS on external_stats + the external-stats bucket). The
// staff-wide roster of these uploads is Coach Tools → Player Stats.
//
// #476: an entry can also carry a season stat line (external_stats.stat_line)
// that feeds the Player Card's Game Play grade. Choosing a CSV / XLSX reads the
// numbers into the boxes below (finding this athlete's row in a team export);
// the uploader checks them before saving. Screenshots and links: type them.

import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { Plus, ExternalLink, FileText, Download, Trash2, Edit2, Upload, BarChart3 } from 'lucide-react';
import { formatUserError } from './errorMessage';
import {
  EXTERNAL_STAT_SOURCES, EXTERNAL_STATS_BUCKET, sourceInfo, sourceName, safeFileName, normalizeUrl,
} from './externalStatsSources';
import { readStatGrid, isReadableStatFile } from './statFileReader';
import {
  BATTING_FIELDS, PITCHING_FIELDS, extractStatCandidates, pickCandidate, normalizeStatLine, statLineSummary,
} from './externalStatLine';

const emptyStats = () => ({ batting: {}, pitching: {} });
const emptyDraft = () => ({ source: 'gamechanger', source_label: '', title: '', season: '', profile_url: '', notes: '', file: null, stats: emptyStats(), statsOrigin: 'manual', matchedName: null });

// Saved stat_line -> the strings shown in the boxes.
const statsFromLine = (line) => {
  const out = emptyStats();
  for (const sec of ['batting', 'pitching']) {
    for (const [k, v] of Object.entries(line?.[sec] || {})) out[sec][k] = v == null ? '' : String(v);
  }
  return out;
};

const when = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function ExternalStatsTab({ userId, loggedInUserId, userRole }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [athleteName, setAthleteName] = useState('');
  // #476 file read state: { kind: 'ok'|'warn'|'error', text } and, when the
  // athlete's row could not be told apart, the rows to choose from.
  const [readNote, setReadNote] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [reading, setReading] = useState(false);

  const isStaff = userRole === 'admin' || userRole === 'coach';
  const isOwn = loggedInUserId === userId;
  const canManage = isStaff || isOwn;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('external_stats')
      .select('*')
      .eq('player_id', userId)
      .order('created_at', { ascending: false });
    if (error) console.error('Error loading external stats:', error);
    setRows(data || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    supabase.from('users').select('full_name').eq('id', userId).maybeSingle()
      .then(({ data }) => setAthleteName(data?.full_name || ''));
  }, [userId]);

  const applyCandidate = (c, fileName, base) => {
    setDraft((d) => ({
      ...(base || d),
      stats: statsFromLine(normalizeStatLine({ batting: c.batting, pitching: c.pitching }) || {}),
      statsOrigin: 'file',
      matchedName: c.name,
    }));
    setCandidates([]);
    setReadNote({ kind: 'ok', text: `Read from ${fileName}${c.name ? ` (row: ${c.name})` : ''}. Check the numbers, then save.` });
  };

  // Read a CSV / XLSX into the stat boxes. `base` = the draft to merge into
  // (the file input's change handler has not committed its state yet).
  const readFile = async (blob, fileName, base) => {
    setReadNote(null);
    setCandidates([]);
    if (!isReadableStatFile(fileName)) {
      setReadNote({ kind: 'warn', text: 'Numbers can only be read from CSV or XLSX files. For a PDF, screenshot or link, type the season totals below so they count on the Player Card.' });
      return;
    }
    setReading(true);
    try {
      const grid = await readStatGrid(blob, fileName);
      const found = extractStatCandidates(grid || []);
      if (!found.length) {
        setReadNote({ kind: 'warn', text: `No batting or pitching table was found in ${fileName}. Type the season totals below instead.` });
        return;
      }
      const mine = pickCandidate(found, athleteName);
      if (mine) { applyCandidate(mine, fileName, base); return; }
      setCandidates(found.filter((c) => c.name));
      setReadNote({ kind: 'warn', text: `${fileName} has ${found.length} players and none is clearly ${athleteName || 'this athlete'}. Pick the right row:` });
    } catch (err) {
      setReadNote({ kind: 'error', text: `Could not read ${fileName}: ${formatUserError(err)}. Type the numbers below instead.` });
    } finally {
      setReading(false);
    }
  };

  const readSavedFile = async (row) => {
    setReading(true);
    const { data, error } = await supabase.storage.from(EXTERNAL_STATS_BUCKET).download(row.file_url);
    setReading(false);
    if (error || !data) { setReadNote({ kind: 'error', text: 'Could not download the saved file.' }); return; }
    readFile(data, row.file_name || row.file_url);
  };

  const setStat = (sec, key, value) => setDraft((d) => ({
    ...d, statsOrigin: 'manual', stats: { ...d.stats, [sec]: { ...d.stats[sec], [key]: value } },
  }));

  const startAdd = () => { setEditingId(null); setDraft(emptyDraft()); setAdding(true); };
  const startEdit = (row) => {
    setAdding(false);
    setEditingId(row.id);
    setDraft({
      source: row.source, source_label: row.source_label || '', title: row.title || '', season: row.season || '',
      profile_url: row.profile_url || '', notes: row.notes || '', file: null,
      stats: statsFromLine(row.stat_line), statsOrigin: row.stat_line?.origin || 'manual', matchedName: row.stat_line?.matched_name || null,
    });
    setReadNote(null);
    setCandidates([]);
  };
  const cancel = () => { setAdding(false); setEditingId(null); setDraft(emptyDraft()); setReadNote(null); setCandidates([]); };

  const save = async () => {
    const url = normalizeUrl(draft.profile_url);
    if (url === null) { alert('That link does not look like a web address. Please paste the full URL.'); return; }
    const editing = editingId ? rows.find((r) => r.id === editingId) : null;
    const keepsFile = editing?.file_url && !draft.file;
    if (!url && !draft.file && !keepsFile) { alert('Add a link to your profile or attach a file (or both).'); return; }
    if (draft.source === 'other' && !draft.source_label.trim()) { alert('Tell us where these stats are from.'); return; }

    setSaving(true);
    let file_url = editing?.file_url || null;
    let file_name = editing?.file_name || null;
    if (draft.file) {
      const safeName = safeFileName(draft.file.name);
      const path = `${userId}/${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from(EXTERNAL_STATS_BUCKET).upload(path, draft.file, { upsert: false });
      if (upErr) { setSaving(false); alert('Upload failed: ' + formatUserError(upErr)); return; }
      // Replacing an existing file: drop the old object once the new one is in.
      if (editing?.file_url) await supabase.storage.from(EXTERNAL_STATS_BUCKET).remove([editing.file_url]);
      file_url = path;
      file_name = safeName;
    }

    const stat_line = normalizeStatLine({
      batting: draft.stats.batting,
      pitching: draft.stats.pitching,
      origin: draft.statsOrigin,
      file_name: draft.statsOrigin === 'file' ? file_name : undefined,
      matched_name: draft.statsOrigin === 'file' ? (draft.matchedName || undefined) : undefined,
    });
    const payload = {
      stat_line,
      source: draft.source,
      source_label: draft.source === 'other' ? draft.source_label.trim() : null,
      title: draft.title.trim() || null,
      season: draft.season.trim() || null,
      profile_url: url || null,
      notes: draft.notes.trim() || null,
      file_url,
      file_name,
    };
    const { error } = editing
      ? await supabase.from('external_stats').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editing.id)
      : await supabase.from('external_stats').insert({ ...payload, player_id: userId, uploaded_by: loggedInUserId });
    setSaving(false);
    if (error) { alert('Save failed: ' + formatUserError(error)); return; }
    cancel();
    load();
  };

  const remove = async (row) => {
    if (!window.confirm('Delete this stats entry' + (row.file_url ? ' and its file' : '') + '?')) return;
    if (row.file_url) await supabase.storage.from(EXTERNAL_STATS_BUCKET).remove([row.file_url]);
    const { error } = await supabase.from('external_stats').delete().eq('id', row.id);
    if (error) { alert('Delete failed: ' + formatUserError(error)); return; }
    load();
  };

  const openFile = async (row) => {
    const { data, error } = await supabase.storage.from(EXTERNAL_STATS_BUCKET).createSignedUrl(row.file_url, 600);
    if (error || !data) { alert('Could not open that file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const form = (
    <div className="border border-blue-300 rounded-lg p-4 bg-blue-50 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Source</label>
          <select
            value={draft.source}
            onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {EXTERNAL_STAT_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {draft.source === 'other' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Where from?</label>
            <input
              type="text"
              value={draft.source_label}
              onChange={(e) => setDraft({ ...draft, source_label: e.target.value })}
              placeholder="e.g. Prep Baseball, team site"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Title <span className="text-gray-400">(optional)</span></label>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="e.g. Varsity hitting stats"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Season <span className="text-gray-400">(optional)</span></label>
          <input
            type="text"
            value={draft.season}
            onChange={(e) => setDraft({ ...draft, season: e.target.value })}
            placeholder="e.g. Spring 2026"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Profile / stats link</label>
          <input
            type="url"
            value={draft.profile_url}
            onChange={(e) => setDraft({ ...draft, profile_url: e.target.value })}
            placeholder="https://..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Stats file <span className="text-gray-400">(PDF, CSV, spreadsheet or screenshot, up to 25 MB)</span>
          </label>
          <input
            type="file"
            accept=".pdf,.csv,.xls,.xlsx,.txt,image/png,image/jpeg,image/webp,image/heic"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              const next = { ...draft, file };
              setDraft(next);
              if (file) readFile(file, file.name, next);
            }}
            className="block w-full text-sm text-gray-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-white file:text-blue-700 file:font-medium file:border file:border-gray-300"
          />
          {editingId && rows.find((r) => r.id === editingId)?.file_name && !draft.file && (
            <p className="text-xs text-gray-500 mt-1">Keeping current file: {rows.find((r) => r.id === editingId).file_name}. Choose a new one to replace it.</p>
          )}
        </div>
        <div className="md:col-span-2 border border-blue-200 bg-white rounded-lg p-3 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5"><BarChart3 size={15} className="text-blue-600" />Season totals for the Player Card</p>
              <p className="text-xs text-gray-500 mt-0.5">These count toward the Game Play rating. Read automatically from a CSV / XLSX; otherwise type what you have. Leave blank what you don't.</p>
            </div>
            {(() => {
              const ed = editingId ? rows.find((r) => r.id === editingId) : null;
              return ed?.file_url && !draft.file && isReadableStatFile(ed.file_name) ? (
                <button type="button" onClick={() => readSavedFile(ed)} disabled={reading} className="px-2.5 py-1.5 border border-blue-300 text-blue-700 rounded-lg text-xs font-medium hover:bg-blue-50 disabled:opacity-50">
                  {reading ? 'Reading…' : 'Read numbers from saved file'}
                </button>
              ) : null;
            })()}
          </div>
          {reading && <p className="text-xs text-gray-500">Reading file…</p>}
          {readNote && (
            <p className={`text-xs rounded-md px-2.5 py-2 ${readNote.kind === 'ok' ? 'bg-green-50 text-green-800' : readNote.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>{readNote.text}</p>
          )}
          {candidates.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => { const c = candidates[Number(e.target.value)]; if (c) applyCandidate(c, draft.file?.name || 'the file'); }}
              className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm bg-white"
            >
              <option value="" disabled>Choose a player row…</option>
              {candidates.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
            </select>
          )}
          {[['batting', 'Batting', BATTING_FIELDS], ['pitching', 'Pitching', PITCHING_FIELDS]].map(([sec, title, fields]) => (
            <div key={sec}>
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">{title}</p>
              <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
                {fields.map((f) => (
                  <label key={f.key} className="block">
                    <span className="block text-[10px] text-gray-500 text-center">{f.label}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft.stats[sec][f.key] ?? ''}
                      onChange={(e) => setStat(sec, f.key, e.target.value)}
                      className="w-full px-1 py-1 border border-gray-300 rounded text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-gray-400">Batting counts with 15+ PA, pitching WHIP with 5+ IP, strikeout % with 20+ batters faced (across all uploads from the last 18 months).</p>
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={2}
            placeholder="Anything the coaches should know about these numbers"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
      <div className="flex justify-end space-x-2">
        <button onClick={cancel} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
        <button onClick={save} disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
          {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add stats'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">External Stats</h3>
          <p className="text-sm text-gray-600 mt-0.5">
            {isOwn
              ? 'Link your GameChanger, Perfect Game, MaxPreps or PBR profile, or upload a stats export, so your coaches can train off your real game numbers.'
              : 'Profile links and stat exports this athlete has shared from GameChanger, Perfect Game, MaxPreps, PBR and elsewhere.'}
          </p>
        </div>
        {canManage && !adding && !editingId && (
          <button
            onClick={startAdd}
            className="bg-blue-600 text-white px-3 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm min-h-[40px] touch-manipulation"
          >
            <Upload size={16} />
            <span>Upload stats</span>
          </button>
        )}
      </div>

      {adding && form}

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : rows.length === 0 && !adding ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <FileText size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No external stats yet.</p>
          {isOwn && (
            <button onClick={startAdd} className="mt-3 inline-flex items-center space-x-1 text-sm text-blue-600 hover:underline">
              <Plus size={14} /><span>Add your first one</span>
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const info = sourceInfo(row.source);
            return (
              <div key={row.id} className="border border-gray-200 rounded-lg p-4">
                {editingId === row.id ? form : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${info.color}`}>{sourceName(row)}</span>
                          {row.season && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{row.season}</span>}
                          <span className="text-xs text-gray-400">Added {when(row.created_at)}</span>
                        </div>
                        {row.title && <p className="text-sm font-medium text-gray-900 mt-1.5">{row.title}</p>}
                        {row.notes && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{row.notes}</p>}
                        {row.stat_line ? (
                          <p className="text-xs text-blue-800 bg-blue-50 rounded-md px-2 py-1 mt-1.5 inline-flex items-center gap-1.5">
                            <BarChart3 size={12} />Player Card: {statLineSummary(row.stat_line)}
                          </p>
                        ) : canManage && (
                          <p className="text-xs text-gray-500 mt-1.5">
                            Not counted on the Player Card yet.{' '}
                            <button onClick={() => startEdit(row)} className="text-blue-600 hover:underline">Add the season totals</button>
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 mt-2">
                          {row.profile_url && (
                            <a
                              href={row.profile_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 min-h-[32px]"
                            >
                              <ExternalLink size={13} /><span>Open profile</span>
                            </a>
                          )}
                          {row.file_url && (
                            <button
                              onClick={() => openFile(row)}
                              className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 min-h-[32px]"
                              title={row.file_name || 'Download'}
                            >
                              <Download size={13} /><span className="truncate max-w-[200px]">{row.file_name || 'Download file'}</span>
                            </button>
                          )}
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex items-center space-x-1 flex-shrink-0">
                          <button onClick={() => startEdit(row)} className="p-1.5 text-gray-400 hover:text-blue-600 transition" title="Edit"><Edit2 size={15} /></button>
                          <button onClick={() => remove(row)} className="p-1.5 text-gray-400 hover:text-red-600 transition" title="Delete"><Trash2 size={15} /></button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
