// Trackman stats tab (#44). Shows the viewed athlete's Trackman sessions — as a
// pitcher and/or a batter — with per-session summaries and pitch-by-pitch
// detail. RLS returns only rows where this athlete is the pitcher or batter
// (staff see everyone's via their own role), so this component just renders
// whatever comes back.
//
// #483: staff can "Import from screenshot" (TrackmanScreenshotImport.js) to
// add a past session read from photos of the Trackman screen. Summary
// screenshots store one row per pitch type (is_summary, summary_count,
// max_speed); every average here is weighted by summary_count. The Trends
// card follows a pitch type's velo / spin / break across sessions.

import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { ChevronDown, ChevronRight, Activity, Target, Camera, Trash2, TrendingUp } from 'lucide-react';
import TrackmanScreenshotImport, { TRACKMAN_SCREENSHOT_BUCKET } from './TrackmanScreenshotImport';
import { rowWeight, weightedAvg, maxOf, pitchTotal } from './statsExtract';

const n1 = (v) => (v == null || v === '' ? '—' : Number(v).toFixed(1));
const n0 = (v) => (v == null || v === '' ? '—' : Math.round(Number(v)).toString());
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const max = (arr) => (arr.length ? Math.max(...arr) : null);
const nums = (rows, key) => rows.map((r) => r[key]).filter((v) => v != null && v !== '').map(Number);

const dateLabel = (d) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date';

// Pitch type codes shared with BullpenSync (tools/bullpen-sync/static/index.html).
const PITCH_TYPES = ['FB', 'SI', 'CT', 'SL', 'CB', 'CH', 'SP'];

export default function TrackmanTab({ userId, userRole, loggedInUserId }) {
  const isStaff = userRole === 'admin' || userRole === 'coach';
  const [importing, setImporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // #435: the linked athlete (own pitches) or staff may retag a pitch.
  const canEdit = userRole === 'admin' || userRole === 'coach' || (userRole === 'player' && loggedInUserId === userId);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // all | pitching | hitting
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      const { data, error } = await supabase
        .from('trackman_pitches')
        .select('id, session_row_id, thrown_date, pitch_no, pitcher_user_id, batter_user_id, pitcher_throws, batter_side, tagged_pitch_type, pitch_call, rel_speed, max_speed, is_summary, summary_count, spin_rate, tilt, induced_vert_break, horz_break, extension, rel_height, rel_side, exit_speed, launch_angle, distance, hit_type, session:trackman_sessions(session_date, session_type, source, screenshot_paths, notes)')
        .or(`pitcher_user_id.eq.${userId},batter_user_id.eq.${userId}`)
        .order('thrown_date', { ascending: false })
        .order('pitch_no', { ascending: true });
      if (cancelled) return;
      if (error) setError(error.message);
      setRows(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId, reloadKey]);

  // #483: staff remove a screenshot-imported session (pitches cascade).
  const deleteSession = async (s) => {
    if (!window.confirm(`Delete the screenshot-imported session from ${dateLabel(s.date)}?`)) return;
    const { error } = await supabase.from('trackman_sessions').delete().eq('id', s.id);
    if (error) { alert(`Could not delete: ${error.message}`); return; }
    if (s.screenshotPaths?.length) await supabase.storage.from(TRACKMAN_SCREENSHOT_BUCKET).remove(s.screenshotPaths);
    setReloadKey((k) => k + 1);
  };

  const openScreenshot = async (path) => {
    const { data, error } = await supabase.storage.from(TRACKMAN_SCREENSHOT_BUCKET).createSignedUrl(path, 600);
    if (error || !data) { alert('Could not open that screenshot.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const retag = async (pitchId, type) => {
    const value = type || null;
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === pitchId ? { ...r, tagged_pitch_type: value } : r)));
    const { error } = await supabase.from('trackman_pitches').update({ tagged_pitch_type: value }).eq('id', pitchId);
    if (error) {
      setRows(prev);
      alert(`Could not update pitch type: ${error.message}`);
    }
  };

  // Group rows into sessions, tagging the athlete's role in each.
  const sessions = (() => {
    const byId = new Map();
    for (const r of rows) {
      const isPitcher = r.pitcher_user_id === userId;
      const isBatter = r.batter_user_id === userId;
      if (!byId.has(r.session_row_id)) {
        byId.set(r.session_row_id, {
          id: r.session_row_id,
          date: r.session?.session_date || r.thrown_date,
          type: r.session?.session_type || '',
          source: r.session?.source || 'ftp',
          screenshotPaths: r.session?.screenshot_paths || [],
          notes: r.session?.notes || '',
          pitcherRows: [], batterRows: [],
        });
      }
      const s = byId.get(r.session_row_id);
      if (isPitcher) s.pitcherRows.push(r);
      if (isBatter && r.exit_speed != null && r.exit_speed !== '') s.batterRows.push(r);
      else if (isBatter) s.batterRows.push(r);
    }
    return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  })();

  const hasPitching = sessions.some((s) => s.pitcherRows.length);
  const hasHitting = sessions.some((s) => s.batterRows.length);

  const visible = sessions.filter((s) =>
    filter === 'all' ? true : filter === 'pitching' ? s.pitcherRows.length : s.batterRows.length
  );

  // Personal bests across everything.
  const allPitch = rows.filter((r) => r.pitcher_user_id === userId);
  const allHit = rows.filter((r) => r.batter_user_id === userId);
  const bestVelo = maxOf(allPitch, ['rel_speed', 'max_speed']);
  const bestExit = max(nums(allHit, 'exit_speed'));

  const importModal = importing && (
    <TrackmanScreenshotImport
      playerId={userId}
      loggedInUserId={loggedInUserId}
      onClose={() => setImporting(false)}
      onSaved={() => setReloadKey((k) => k + 1)}
    />
  );
  const importButton = isStaff && (
    <button onClick={() => setImporting(true)}
      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50 min-h-[40px]">
      <Camera size={16} />Import from screenshot
    </button>
  );

  if (loading) return <p className="text-sm text-gray-500 py-6">Loading Trackman data…</p>;
  if (error) return <p className="text-sm text-red-600 py-6">Error loading Trackman data: {error}</p>;
  if (!sessions.length) {
    return (
      <div className="text-center py-16 text-gray-500">
        <Activity size={40} className="mx-auto mb-3 text-gray-300" />
        <p className="font-medium text-gray-700">No Trackman sessions yet</p>
        <p className="text-sm">Sessions appear here once this athlete's name is mapped in Admin → Trackman.</p>
        {isStaff && <div className="mt-4 flex justify-center">{importButton}</div>}
        {isStaff && <p className="text-xs text-gray-400 mt-2">Past sessions can be added from screenshots of the Trackman screen.</p>}
        {importModal}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {importModal}
      {importButton && <div className="flex justify-end">{importButton}</div>}
      {/* Personal bests */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {bestVelo != null && <BestTile label="Top Velocity" value={`${n1(bestVelo)} mph`} icon={<Activity size={16} />} tone="blue" />}
        {bestExit != null && <BestTile label="Top Exit Velo" value={`${n1(bestExit)} mph`} icon={<Target size={16} />} tone="orange" />}
        <BestTile label="Sessions" value={sessions.length} tone="gray" />
      </div>

      {/* Pitching / Hitting filter (only if both exist) */}
      {hasPitching && hasHitting && (
        <div className="flex space-x-2">
          {[{ k: 'all', l: 'All' }, { k: 'pitching', l: 'Pitching' }, { k: 'hitting', l: 'Hitting' }].map((t) => (
            <button key={t.k} onClick={() => setFilter(t.k)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${filter === t.k ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {t.l}
            </button>
          ))}
        </div>
      )}

      {hasPitching && filter !== 'hitting' && <PitchTrends sessions={sessions.filter((s) => s.pitcherRows.length)} />}

      <div className="space-y-2">
        {visible.map((s) => (
          <SessionCard key={s.id} session={s} open={openId === s.id} onToggle={() => setOpenId(openId === s.id ? null : s.id)} onRetag={canEdit ? retag : null}
            onDelete={isStaff && s.source === 'screenshot' ? () => deleteSession(s) : null}
            onOpenScreenshot={openScreenshot} />
        ))}
      </div>
    </div>
  );
}

function BestTile({ label, value, icon, tone }) {
  const tones = { blue: 'bg-blue-50 text-blue-700', orange: 'bg-orange-50 text-orange-700', gray: 'bg-gray-50 text-gray-700' };
  return (
    <div className={`rounded-lg p-3 ${tones[tone] || tones.gray}`}>
      <div className="flex items-center space-x-1.5 text-xs font-medium opacity-80">{icon}<span>{label}</span></div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
    </div>
  );
}

function SessionCard({ session, open, onToggle, onRetag, onDelete, onOpenScreenshot }) {
  const isPitch = session.pitcherRows.length > 0;
  const isHit = session.batterRows.length > 0;
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition text-left">
        <div className="flex items-center space-x-3 min-w-0">
          {open ? <ChevronDown size={18} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={18} className="text-gray-400 flex-shrink-0" />}
          <div className="min-w-0">
            <div className="font-semibold text-gray-900 truncate">{dateLabel(session.date)}</div>
            <div className="flex flex-wrap gap-1.5 mt-0.5">
              {session.type && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{session.type}</span>}
              {session.source === 'screenshot' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">From screenshot</span>}
              {isPitch && <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{pitchTotal(session.pitcherRows)} pitches</span>}
              {isHit && <span className="text-[11px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">{session.batterRows.length} swings</span>}
            </div>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3 space-y-4 bg-gray-50/50">
          {session.source === 'screenshot' && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
              {session.notes && <span className="italic">{session.notes}</span>}
              {session.screenshotPaths.map((p, i) => (
                <button key={p} onClick={() => onOpenScreenshot(p)} className="px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50">Screenshot {i + 1}</button>
              ))}
              {onDelete && (
                <button onClick={onDelete} className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-red-200 text-red-600 bg-white hover:bg-red-50"><Trash2 size={12} />Delete session</button>
              )}
            </div>
          )}
          {isPitch && <PitchingDetail rows={session.pitcherRows} onRetag={onRetag} />}
          {isHit && <HittingDetail rows={session.batterRows} />}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-sm font-bold text-gray-900">{value}</div>
    </div>
  );
}

function PitchingDetail({ rows, onRetag }) {
  // Summary by pitch type.
  const byType = {};
  for (const r of rows) {
    const t = r.tagged_pitch_type || 'Untagged';
    (byType[t] = byType[t] || []).push(r);
  }
  const summary = rows.some((r) => r.is_summary);
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="Pitches" value={pitchTotal(rows)} />
        <Stat label="Avg Velo" value={`${n1(weightedAvg(rows, 'rel_speed'))} mph`} />
        <Stat label="Max Velo" value={`${n1(maxOf(rows, ['rel_speed', 'max_speed']))} mph`} />
        <Stat label="Avg Spin" value={`${n0(weightedAvg(rows, 'spin_rate'))} rpm`} />
      </div>
      <div className="mb-3 space-y-1">
        {Object.entries(byType).sort((a, b) => pitchTotal(b[1]) - pitchTotal(a[1])).map(([type, tr]) => (
          <div key={type} className="flex items-center justify-between text-xs bg-white rounded border border-gray-200 px-2.5 py-1.5">
            <span className="font-medium text-gray-800">{type} <span className="text-gray-400">×{pitchTotal(tr)}</span></span>
            <span className="text-gray-600">avg {n1(weightedAvg(tr, 'rel_speed'))} / max {n1(maxOf(tr, ['rel_speed', 'max_speed']))} mph · IVB {n1(weightedAvg(tr, 'induced_vert_break'))}" · HB {n1(weightedAvg(tr, 'horz_break'))}"</span>
          </div>
        ))}
      </div>
      {summary && <p className="text-[11px] text-gray-500 mb-1">Imported from a summary screen: each row is one pitch type's averages ("Avg of N").</p>}
      <DetailTable
        cols={['#', 'Type', 'Velo', 'Spin', 'IVB', 'HB', 'Tilt', 'Ext', 'Result']}
        rows={rows.map((r) => [r.is_summary ? `Avg of ${rowWeight(r)}` : (r.pitch_no ?? ''), onRetag ? <PitchTypeSelect key={r.id} value={r.tagged_pitch_type} onChange={(t) => onRetag(r.id, t)} /> : (r.tagged_pitch_type || '—'), n1(r.rel_speed), n0(r.spin_rate), n1(r.induced_vert_break), n1(r.horz_break), r.tilt || '—', n1(r.extension), r.pitch_call || '—'])}
      />
    </div>
  );
}

function HittingDetail({ rows }) {
  const hits = rows.filter((r) => r.exit_speed != null && r.exit_speed !== '');
  const ev = nums(hits, 'exit_speed');
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="Swings" value={rows.length} />
        <Stat label="Avg Exit Velo" value={`${n1(avg(ev))} mph`} />
        <Stat label="Max Exit Velo" value={`${n1(max(ev))} mph`} />
        <Stat label="Max Distance" value={`${n0(max(nums(hits, 'distance')))} ft`} />
      </div>
      <DetailTable
        cols={['#', 'Exit Velo', 'Launch°', 'Dist', 'Type']}
        rows={rows.map((r) => [r.pitch_no ?? '', n1(r.exit_speed), n1(r.launch_angle), n0(r.distance), r.hit_type || '—'])}
      />
    </div>
  );
}

function PitchTypeSelect({ value, onChange }) {
  const cur = value || '';
  // Keep an unexpected existing tag (e.g. Trackman's "Fastball") selectable.
  const opts = cur && !PITCH_TYPES.includes(cur) ? [cur, ...PITCH_TYPES] : PITCH_TYPES;
  return (
    <select
      value={cur}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className="border border-gray-300 rounded px-1 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
      title="Change pitch type"
    >
      <option value="">—</option>
      {opts.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

function DetailTable({ cols, rows }) {
  return (
    <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
      <table className="w-full text-xs">
        <thead className="bg-gray-100 text-gray-600">
          <tr>{cols.map((c) => <th key={c} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-gray-50">
              {r.map((cell, j) => <td key={j} className="px-2 py-1 whitespace-nowrap text-gray-800">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// #483: a pitch type's numbers across sessions (FTP, BullpenSync and
// screenshot imports alike), oldest -> newest.
const TREND_METRICS = [
  { key: 'velo', label: 'Avg velo', unit: 'mph', get: (rows) => weightedAvg(rows, 'rel_speed'), fmt: n1 },
  { key: 'max', label: 'Max velo', unit: 'mph', get: (rows) => maxOf(rows, ['rel_speed', 'max_speed']), fmt: n1 },
  { key: 'spin', label: 'Avg spin', unit: 'rpm', get: (rows) => weightedAvg(rows, 'spin_rate'), fmt: n0 },
  { key: 'ivb', label: 'IVB', unit: 'in', get: (rows) => weightedAvg(rows, 'induced_vert_break'), fmt: n1 },
  { key: 'hb', label: 'HB', unit: 'in', get: (rows) => weightedAvg(rows, 'horz_break'), fmt: n1 },
  { key: 'ext', label: 'Extension', unit: 'ft', get: (rows) => weightedAvg(rows, 'extension'), fmt: n1 },
];

function PitchTrends({ sessions }) {
  const typeTotals = {};
  for (const s of sessions) {
    for (const r of s.pitcherRows) {
      const t = r.tagged_pitch_type || 'Untagged';
      typeTotals[t] = (typeTotals[t] || 0) + rowWeight(r);
    }
  }
  const types = Object.keys(typeTotals).sort((a, b) => typeTotals[b] - typeTotals[a]);
  const [picked, setType] = useState(null);
  const [metricKey, setMetricKey] = useState('velo');
  const [open, setOpen] = useState(false);
  if (sessions.length < 2 || !types.length) return null;
  const type = picked && types.includes(picked) ? picked : (types.includes('FB') ? 'FB' : types[0]);
  const metric = TREND_METRICS.find((m) => m.key === metricKey);
  const points = [...sessions]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((s) => {
      const rows = s.pitcherRows.filter((r) => (r.tagged_pitch_type || 'Untagged') === type);
      return rows.length ? { date: s.date, value: metric.get(rows), n: pitchTotal(rows), shot: s.source === 'screenshot' } : null;
    })
    .filter((p) => p && p.value != null);

  const W = 640; const H = 180; const P = 32;
  const vals = points.map((p) => p.value);
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const pad = (hi - lo) * 0.15 || 1;
  const y = (v) => H - P - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - 2 * P);
  const x = (i) => (points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const first = points[0];
  const last = points[points.length - 1];
  const change = points.length > 1 ? last.value - first.value : null;

  return (
    <div className="border border-gray-200 rounded-lg">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-3 hover:bg-gray-50 text-left">
        <span className="flex items-center gap-2 font-semibold text-gray-900"><TrendingUp size={16} className="text-blue-600" />Pitch trends</span>
        {open ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <select value={type} onChange={(e) => setType(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm">
              {types.map((t) => <option key={t} value={t}>{t} ({typeTotals[t]})</option>)}
            </select>
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1 text-sm">
              {TREND_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            {change != null && (
              <span className="text-sm text-gray-600 self-center">
                {metric.fmt(first.value)} → {metric.fmt(last.value)} {metric.unit} ({change >= 0 ? '+' : ''}{metric.fmt(change)})
              </span>
            )}
          </div>
          {points.length < 2 ? (
            <p className="text-sm text-gray-500">Not enough {type} sessions with {metric.label.toLowerCase()} to draw a trend.</p>
          ) : (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${type} ${metric.label} by session`}>
              <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="#e5e7eb" />
              <text x={4} y={y(hi) + 4} fontSize="10" fill="#6b7280">{metric.fmt(hi)}</text>
              <text x={4} y={y(lo) + 4} fontSize="10" fill="#6b7280">{metric.fmt(lo)}</text>
              <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
              {points.map((p, i) => (
                <g key={i}>
                  <circle cx={x(i)} cy={y(p.value)} r="4" fill={p.shot ? '#9333ea' : '#2563eb'}>
                    <title>{`${dateLabel(p.date)}: ${metric.fmt(p.value)} ${metric.unit} (${p.n} pitches${p.shot ? ', from screenshot' : ''})`}</title>
                  </circle>
                  {(i === 0 || i === points.length - 1 || points.length <= 8) && (
                    <text x={x(i)} y={H - P + 14} fontSize="9" fill="#6b7280" textAnchor="middle">
                      {new Date(p.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                    </text>
                  )}
                </g>
              ))}
            </svg>
          )}
          <p className="text-[11px] text-gray-400">Purple points are sessions imported from screenshots. Averages are weighted by pitch count.</p>
        </div>
      )}
    </div>
  );
}
