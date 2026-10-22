// #463: log a whole pitching outing (the line score) instead of pitch by pitch.
// Athletes, college pitchers especially, often only have the box-score numbers
// for a game. Rows live in practice_pitching_outings (athlete inserts/deletes
// own, staff manage all); the pitch-by-pitch log below it is unchanged.
//
// Innings are entered in baseball notation (5.1 = 5⅓, 5.2 = 5⅔) and converted
// to outs for ERA / WHIP.

import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from './supabaseClient';
import { fmtLocalDate } from './scheduleUtils';
import { formatUserError } from './errorMessage';

const OUTING_CONTEXTS = [
  { value: 'game', label: 'Game' },
  { value: 'scrimmage', label: 'Scrimmage' },
  { value: 'lives', label: 'Lives' },
  { value: 'bullpen', label: 'Bullpen' },
  { value: 'practice', label: 'Practice' },
  { value: 'other', label: 'Other' },
];

const NUM_FIELDS = [
  { key: 'innings_pitched', label: 'IP', step: '0.1', hint: '5.1 = 5⅓' },
  { key: 'pitches', label: 'Pitches' },
  { key: 'strikes', label: 'Strikes' },
  { key: 'hits', label: 'H' },
  { key: 'runs', label: 'R' },
  { key: 'earned_runs', label: 'ER' },
  { key: 'walks', label: 'BB' },
  { key: 'strikeouts', label: 'K' },
  { key: 'hit_by_pitch', label: 'HBP' },
  { key: 'max_velo', label: 'Max Velo', step: '0.1' },
  { key: 'avg_velo', label: 'Avg Velo', step: '0.1' },
];

const blankDraft = () => ({
  log_date: fmtLocalDate(new Date()), context: 'game', opponent: '', notes: '',
  ...Object.fromEntries(NUM_FIELDS.map(f => [f.key, ''])),
});

// 5.1 -> 16 outs. A tenths digit above 2 is not valid notation; treat as whole.
export function inningsToOuts(ip) {
  if (ip == null || ip === '') return 0;
  const n = Number(ip);
  if (!Number.isFinite(n) || n < 0) return 0;
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 10);
  return whole * 3 + (frac <= 2 ? frac : 0);
}

const outsToInnings = (outs) => `${Math.floor(outs / 3)}.${outs % 3}`;
const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

export default function PitchingOutingsView({ playerId, canEdit }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(blankDraft);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('practice_pitching_outings')
      .select('*')
      .eq('player_id', playerId)
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (err) setError(formatUserError(err));
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    const outs = rows.reduce((s, r) => s + inningsToOuts(r.innings_pitched), 0);
    const ip = outs / 3;
    const er = sum(rows, 'earned_runs');
    const pitches = sum(rows, 'pitches');
    const strikes = sum(rows, 'strikes');
    const bb = sum(rows, 'walks');
    const k = sum(rows, 'strikeouts');
    const velos = rows.map(r => r.max_velo).filter(v => v != null).map(Number);
    return {
      outings: rows.length,
      ip: outsToInnings(outs),
      era: ip ? ((er * 9) / ip).toFixed(2) : '—',
      whip: ip ? ((bb + sum(rows, 'hits')) / ip).toFixed(2) : '—',
      k,
      bb,
      strikePct: pitches ? `${Math.round((strikes / pitches) * 100)}%` : '—',
      maxVelo: velos.length ? Math.max(...velos) : '—',
    };
  }, [rows]);

  const save = async () => {
    setError('');
    if (!draft.log_date) { setError('Pick the date of the outing.'); return; }
    if (draft.innings_pitched !== '' && Math.round((Number(draft.innings_pitched) % 1) * 10) > 2) {
      setError('Innings use .1 and .2 for one and two outs (e.g. 5.2), never .3 or higher.');
      return;
    }
    if (draft.strikes !== '' && draft.pitches !== '' && Number(draft.strikes) > Number(draft.pitches)) {
      setError('Strikes cannot be more than total pitches.');
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    const row = {
      player_id: playerId,
      log_date: draft.log_date,
      context: draft.context,
      opponent: draft.opponent.trim() || null,
      notes: draft.notes.trim() || null,
      logged_by: user?.id || null,
    };
    NUM_FIELDS.forEach(f => { row[f.key] = draft[f.key] === '' ? null : Number(draft[f.key]); });
    const { error: err } = await supabase.from('practice_pitching_outings').insert(row);
    if (err) { setError('Save failed: ' + formatUserError(err)); return; }
    setAdding(false);
    setDraft(blankDraft());
    load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this outing?')) return;
    const { error: err } = await supabase.from('practice_pitching_outings').delete().eq('id', id);
    if (err) { setError('Delete failed: ' + formatUserError(err)); return; }
    load();
  };

  const inp = 'w-full px-2 py-1.5 border border-gray-300 rounded text-sm';
  const lbl = 'block text-xs font-medium text-gray-700 mb-1';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Outings</h3>
          <p className="text-xs text-gray-500">The whole outing's line: use this when you don't have every pitch.</p>
        </div>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center space-x-1">
            <Plus size={16} />
            <span>Log Whole Outing</span>
          </button>
        )}
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-8 gap-2 text-center">
        {[
          { label: 'Outings', val: totals.outings },
          { label: 'IP', val: totals.ip },
          { label: 'ERA', val: totals.era },
          { label: 'WHIP', val: totals.whip },
          { label: 'K', val: totals.k },
          { label: 'BB', val: totals.bb },
          { label: 'Strike %', val: totals.strikePct },
          { label: 'Max Velo', val: totals.maxVelo },
        ].map(s => (
          <div key={s.label} className="bg-gray-50 rounded-lg p-2 border border-gray-200">
            <div className="text-xs text-gray-500 uppercase tracking-wide">{s.label}</div>
            <div className="text-lg font-bold text-gray-900 tabular-nums">{s.val}</div>
          </div>
        ))}
      </div>

      {adding && (
        <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className={lbl}>Date</label><input type="date" value={draft.log_date} onChange={e => setDraft({ ...draft, log_date: e.target.value })} className={inp} /></div>
            <div><label className={lbl}>Context</label><select value={draft.context} onChange={e => setDraft({ ...draft, context: e.target.value })} className={inp}>{OUTING_CONTEXTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
            <div className="col-span-2"><label className={lbl}>Opponent</label><input value={draft.opponent} onChange={e => setDraft({ ...draft, opponent: e.target.value })} placeholder="optional" className={inp} /></div>
            {NUM_FIELDS.map(f => (
              <div key={f.key}>
                <label className={lbl}>{f.label}{f.hint && <span className="text-gray-400 font-normal"> ({f.hint})</span>}</label>
                <input type="number" min="0" step={f.step || '1'} value={draft[f.key]} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} className={inp} />
              </div>
            ))}
          </div>
          <div><label className={lbl}>Notes</label><textarea value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} rows={2} className={inp} /></div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setAdding(false); setError(''); }} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm">Cancel</button>
            <button onClick={save} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">Save</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 text-center py-6">Loading outings...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No outings logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Context</th>
                <th className="px-3 py-2 text-left">Opp</th>
                {['IP', 'P', 'S', 'H', 'R', 'ER', 'BB', 'K', 'HBP', 'Velo'].map(h => <th key={h} className="px-2 py-2 text-center">{h}</th>)}
                <th className="px-3 py-2 text-left">Notes</th>
                {canEdit && <th className="px-3 py-2 w-10"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.log_date}</td>
                  <td className="px-3 py-2 text-gray-700">{(OUTING_CONTEXTS.find(c => c.value === r.context)?.label) || r.context}</td>
                  <td className="px-3 py-2 text-gray-700">{r.opponent || '—'}</td>
                  {['innings_pitched', 'pitches', 'strikes', 'hits', 'runs', 'earned_runs', 'walks', 'strikeouts', 'hit_by_pitch'].map(k => (
                    <td key={k} className="px-2 py-2 text-center text-gray-700 tabular-nums">{r[k] ?? '—'}</td>
                  ))}
                  <td className="px-2 py-2 text-center text-gray-700 tabular-nums whitespace-nowrap">
                    {r.max_velo != null || r.avg_velo != null ? `${r.max_velo ?? '—'} / ${r.avg_velo ?? '—'}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.notes || ''}</td>
                  {canEdit && <td className="px-3 py-2 text-right"><button onClick={() => remove(r.id)} className="text-gray-400 hover:text-red-600" aria-label="Delete outing"><Trash2 size={14} /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
