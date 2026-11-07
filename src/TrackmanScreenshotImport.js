// #483: staff import a past Trackman session from screenshots / photos of the
// Trackman screen. Flow: pick images + session date/type -> stats-extract
// (Claude vision) reads the rows -> staff review / edit them here -> Save
// writes a trackman_sessions row (source 'screenshot', file_path
// 'screenshot/<uuid>' so the FTP sync can never collide) and its pitches with
// pitcher_user_id = this athlete.
//
// Per-pitch screens become normal pitch rows. Summary screens (one line per
// pitch type) become one row per pitch type with is_summary = true,
// summary_count = pitches in that line, max_speed = the line's max velo; the
// Trackman tab and the Player Card weight those rows by summary_count.

import React, { useState } from 'react';
import { X, Upload, Trash2, Plus, Loader2 } from 'lucide-react';
import { supabase } from './supabaseClient';
import { formatUserError } from './errorMessage';
import { uploadScreenshots, extractStats, normalizePitchType } from './statsExtract';

export const TRACKMAN_SCREENSHOT_BUCKET = 'trackman-screenshots';
const SESSION_TYPES = ['Bullpen', 'Live BP', 'Game', 'Pitching'];

// [key, header, width class, kind]
const COLS = [
  ['pitch_type', 'Type', 'w-20', 'text'],
  ['count', '# Pitches', 'w-16', 'int'],
  ['velo', 'Velo', 'w-16', 'num'],
  ['velo_max', 'Max', 'w-16', 'num'],
  ['spin_rate', 'Spin', 'w-16', 'num'],
  ['induced_vert_break', 'IVB', 'w-14', 'num'],
  ['horz_break', 'HB', 'w-14', 'num'],
  ['tilt', 'Tilt', 'w-16', 'text'],
  ['spin_axis', 'Axis', 'w-14', 'num'],
  ['extension', 'Ext', 'w-14', 'num'],
  ['rel_height', 'Rel H', 'w-14', 'num'],
  ['rel_side', 'Rel S', 'w-14', 'num'],
  ['vert_appr_angle', 'VAA', 'w-14', 'num'],
  ['strike_pct', 'Strike %', 'w-16', 'num'],
  ['pitch_call', 'Result', 'w-24', 'text'],
];

const today = () => new Date().toLocaleDateString('en-CA');
const toNum = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const toStr = (v) => (v == null ? '' : String(v));

export default function TrackmanScreenshotImport({ playerId, loggedInUserId, onClose, onSaved }) {
  const [files, setFiles] = useState([]);
  const [date, setDate] = useState(today());
  const [type, setType] = useState('Bullpen');
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState('pick'); // pick | reading | review | saving
  const [error, setError] = useState('');
  const [paths, setPaths] = useState([]);
  const [format, setFormat] = useState('per_pitch_type');
  const [rows, setRows] = useState([]);
  const [readNotes, setReadNotes] = useState('');

  const read = async () => {
    if (!files.length) { setError('Choose at least one screenshot.'); return; }
    if (files.length > 10) { setError('Up to 10 screenshots at a time.'); return; }
    setError(''); setStep('reading');
    let uploaded = paths;
    try {
      if (!uploaded.length) {
        uploaded = await uploadScreenshots(TRACKMAN_SCREENSHOT_BUCKET, playerId, files);
        setPaths(uploaded);
      }
      const result = await extractStats({ mode: 'trackman_session', playerId, paths: uploaded });
      const fmt = result.format === 'per_pitch' ? 'per_pitch' : 'per_pitch_type';
      setFormat(fmt);
      setRows((result.rows || []).map((r, i) => {
        const out = {};
        for (const [k] of COLS) out[k] = toStr(r[k]);
        out.pitch_type = normalizePitchType(r.pitch_type);
        out.pitch_no = toStr(r.pitch_no ?? (fmt === 'per_pitch' ? i + 1 : ''));
        if (fmt === 'per_pitch') out.count = '';
        return out;
      }));
      if (result.session_date && /^\d{4}-\d{2}-\d{2}$/.test(result.session_date) && date === today()) setDate(result.session_date);
      setReadNotes(result.notes || '');
      setStep('review');
    } catch (err) {
      setError(err.message || String(err));
      setStep('pick');
    }
  };

  const setCell = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const addRow = () => setRows((rs) => [...rs, Object.fromEntries([...COLS.map(([k]) => [k, '']), ['pitch_no', String(rs.length + 1)]])]);
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));

  const discard = async () => {
    if (paths.length) await supabase.storage.from(TRACKMAN_SCREENSHOT_BUCKET).remove(paths);
    onClose();
  };

  const save = async () => {
    const isSummary = format === 'per_pitch_type';
    const clean = rows.filter((r) => r.pitch_type.trim() || toNum(r.velo) != null);
    if (!clean.length) { setError('There are no rows to save.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('Set the session date.'); return; }
    setError(''); setStep('saving');
    const pitchCount = isSummary ? clean.reduce((n, r) => n + Math.max(1, toNum(r.count) || 1), 0) : clean.length;
    const { data: session, error: sErr } = await supabase.from('trackman_sessions').insert({
      file_path: `screenshot/${crypto.randomUUID()}`,
      session_date: date,
      session_type: type || null,
      source: 'screenshot',
      player_id: playerId,
      screenshot_paths: paths,
      captured_by: loggedInUserId,
      notes: notes.trim() || null,
      pitch_count: pitchCount,
    }).select('id').single();
    if (sErr) { setError(`Save failed: ${formatUserError(sErr)}`); setStep('review'); return; }

    const pitches = clean.map((r, i) => ({
      session_row_id: session.id,
      thrown_date: date,
      pitch_no: isSummary ? i + 1 : (toNum(r.pitch_no) ?? i + 1),
      pitcher_user_id: playerId,
      tagged_pitch_type: normalizePitchType(r.pitch_type) || null,
      pitch_call: r.pitch_call.trim() || null,
      rel_speed: toNum(r.velo),
      max_speed: isSummary ? toNum(r.velo_max) : null,
      spin_rate: toNum(r.spin_rate),
      spin_axis: toNum(r.spin_axis),
      tilt: r.tilt.trim() || null,
      induced_vert_break: toNum(r.induced_vert_break),
      horz_break: toNum(r.horz_break),
      extension: toNum(r.extension),
      rel_height: toNum(r.rel_height),
      rel_side: toNum(r.rel_side),
      vert_appr_angle: toNum(r.vert_appr_angle),
      is_summary: isSummary,
      summary_count: isSummary ? Math.min(1000, Math.max(1, Math.round(toNum(r.count) || 1))) : null,
      source: 'screenshot',
      raw: { screenshot: true, strike_pct: toNum(r.strike_pct), count_shown: toNum(r.count) != null },
    }));
    const { error: pErr } = await supabase.from('trackman_pitches').insert(pitches);
    if (pErr) {
      await supabase.from('trackman_sessions').delete().eq('id', session.id);
      setError(`Save failed: ${formatUserError(pErr)}`);
      setStep('review');
      return;
    }
    onSaved?.();
    onClose();
  };

  const busy = step === 'reading' || step === 'saving';
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[95vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Import Trackman session from screenshots</h3>
            <p className="text-xs text-gray-500">The numbers are read automatically. Check every row against the screenshot before saving.</p>
          </div>
          <button onClick={discard} disabled={busy} className="p-1.5 text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Session date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Session type</span>
              <input list="tm-session-types" value={type} onChange={(e) => setType(e.target.value)} disabled={busy}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              <datalist id="tm-session-types">{SESSION_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </label>
          </div>

          {step !== 'review' && step !== 'saving' && (
            <div>
              <span className="block text-xs font-medium text-gray-700 mb-1">Screenshots or photos of the Trackman screen (up to 10)</span>
              <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/heic"
                disabled={busy}
                onChange={(e) => { setFiles([...(e.target.files || [])]); setPaths([]); }}
                className="block w-full text-sm text-gray-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:bg-white file:text-blue-700 file:font-medium" />
              {files.length > 0 && <p className="text-xs text-gray-500 mt-1">{files.length} image{files.length === 1 ? '' : 's'} selected.</p>}
            </div>
          )}

          {error && <p className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{error}</p>}
          {step === 'reading' && (
            <p className="text-sm text-gray-600 flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Reading the screenshots… this can take up to a minute.</p>
          )}

          {(step === 'review' || step === 'saving') && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs text-gray-700 flex items-center gap-2">
                  Rows are
                  <select value={format} onChange={(e) => setFormat(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-xs">
                    <option value="per_pitch_type">one line per pitch type (averages)</option>
                    <option value="per_pitch">one row per pitch</option>
                  </select>
                </label>
                {format === 'per_pitch_type' && <span className="text-xs text-gray-500">Set "# Pitches" for each line so averages and trends weight it correctly.</span>}
              </div>
              {readNotes && <p className="text-xs bg-amber-50 text-amber-800 rounded-md px-2.5 py-2">Reader notes: {readNotes}</p>}
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="text-xs">
                  <thead className="bg-gray-100 text-gray-600">
                    <tr>
                      {format === 'per_pitch' && <th className="px-1.5 py-1.5 text-left font-semibold">#</th>}
                      {COLS.filter(([k]) => format === 'per_pitch_type' || (k !== 'count' && k !== 'velo_max' && k !== 'strike_pct'))
                        .filter(([k]) => format === 'per_pitch' || k !== 'pitch_call')
                        .map(([k, h]) => <th key={k} className="px-1.5 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>)}
                      <th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((r, i) => (
                      <tr key={i}>
                        {format === 'per_pitch' && (
                          <td className="px-1 py-1"><input value={r.pitch_no || ''} onChange={(e) => setCell(i, 'pitch_no', e.target.value)} className="w-10 px-1 py-0.5 border border-gray-300 rounded" /></td>
                        )}
                        {COLS.filter(([k]) => format === 'per_pitch_type' || (k !== 'count' && k !== 'velo_max' && k !== 'strike_pct'))
                          .filter(([k]) => format === 'per_pitch' || k !== 'pitch_call')
                          .map(([k, , w, kind]) => (
                            <td key={k} className="px-1 py-1">
                              <input value={r[k] ?? ''} inputMode={kind === 'text' ? 'text' : 'decimal'}
                                onChange={(e) => setCell(i, k, e.target.value)}
                                className={`${w} px-1 py-0.5 border rounded ${kind !== 'text' && r[k] !== '' && toNum(r[k]) == null ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                            </td>
                          ))}
                        <td className="px-1 py-1"><button onClick={() => removeRow(i)} className="p-1 text-gray-400 hover:text-red-600" title="Remove row"><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={addRow} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"><Plus size={13} />Add row</button>
              <p className="text-[11px] text-gray-400">Units: mph, rpm, inches (IVB / HB), feet (extension, release). Pitch types: FB, SI, CT, SL, CB, CH, SP.</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t">
          <button onClick={discard} disabled={busy} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          {step === 'review' || step === 'saving' ? (
            <>
              <button onClick={() => { setStep('pick'); setRows([]); }} disabled={busy} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50">Read again</button>
              <button onClick={save} disabled={busy} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {step === 'saving' ? 'Saving…' : `Save session (${rows.length} row${rows.length === 1 ? '' : 's'})`}
              </button>
            </>
          ) : (
            <button onClick={read} disabled={busy || !files.length} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
              <Upload size={15} />{step === 'reading' ? 'Reading…' : 'Read screenshots'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
