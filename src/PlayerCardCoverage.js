// #478: Work Portal -> Player Card Data. For every athlete, which of the eight
// Player Card categories has data behind it and when it was last measured, so
// staff can see who still needs an assessment, a Trackman session, a WHOOP,
// game stats… (Cordell: "Cruz Payne only has hitting").
//
// "Has data" means exactly what the card itself uses: the staff-gated RPC
// player_rating_coverage() (migration 20261103_player_card_coverage.sql)
// returns metric keys + dates from the same rating_metric_values() that feeds
// player_rating_inputs, inside the same windows (assessments 18 months,
// Trackman / practice logs 12 months, WHOOP 30 days, uploaded season stats
// 18 months). A coach rating (player_rating_overrides) is shown separately —
// the card shows a number, but there is still no data under it.

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import { Search, Download, AlertTriangle, Loader2 } from 'lucide-react';
import { readAllPages } from './readAllPages';
import { RATING_CATEGORIES } from './playerRatings';
import { classLabelForGradYear } from './gradYear';
import { formatUserError } from './errorMessage';

const INACTIVE = new Set(['Archived', 'Inactive']);

const CATEGORY_OF = {};
RATING_CATEGORIES.forEach((c) => c.metrics.forEach((m) => { CATEGORY_OF[m.key] = c.key; }));

const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '');

const profileOf = (u) => {
  const p = u.player_profiles;
  return Array.isArray(p) ? p[0] || {} : p || {};
};

export default function PlayerCardCoverage() {
  const [players, setPlayers] = useState([]);
  const [coverage, setCoverage] = useState({}); // player -> category -> { n, latest }
  const [coached, setCoached] = useState({});   // player -> Set(category)
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [nbpPlusOnly, setNbpPlusOnly] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [missing, setMissing] = useState('any_or_none'); // 'any_or_none' | 'any' | <category key>

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      const [u, cov, ov] = await Promise.all([
        readAllPages(() => supabase
          .from('users')
          .select('id, full_name, player_profiles!player_profiles_user_id_fkey(status, grad_year), team_members(teams(name, team_type))')
          .eq('role', 'player')
          .order('full_name')
          .order('id')),
        readAllPages(() => supabase.rpc('player_rating_coverage').order('player_id').order('metric_key')),
        readAllPages(() => supabase.from('player_rating_overrides').select('player_id, category, rating').order('player_id').order('category')),
      ]);
      if (cancelled) return;
      const err = u.error || cov.error || ov.error;
      if (err) setLoadError(formatUserError(err));
      const map = {};
      for (const r of cov.rows) {
        const cat = CATEGORY_OF[r.metric_key];
        if (!cat) continue;
        const pc = (map[r.player_id] ||= {});
        const c = (pc[cat] ||= { n: 0, latest: null });
        c.n += 1;
        if (!c.latest || r.measured_on > c.latest) c.latest = r.measured_on;
      }
      const co = {};
      for (const o of ov.rows) {
        if (o.rating == null || o.category === 'overall') continue;
        (co[o.player_id] ||= new Set()).add(o.category);
      }
      setPlayers(u.rows);
      setCoverage(map);
      setCoached(co);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const teamNames = useMemo(() => Array.from(new Set(players.flatMap((p) => (p.team_members || []).map((tm) => tm.teams?.name).filter(Boolean)))).sort(), [players]);

  const scoped = useMemo(() => players.filter((p) => {
    const prof = profileOf(p);
    if (!showInactive && INACTIVE.has(prof.status)) return false;
    const teams = p.team_members || [];
    if (nbpPlusOnly && !teams.some((tm) => tm.teams?.team_type === 'training')) return false;
    if (teamFilter !== 'all' && !teams.some((tm) => tm.teams?.name === teamFilter)) return false;
    if (search.trim() && !(p.full_name || '').toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  }), [players, showInactive, nbpPlusOnly, teamFilter, search]);

  const has = (pid, cat) => !!coverage[pid]?.[cat];

  // Per-category counts over the scoped roster (before the "missing" filter,
  // so the numbers answer "how much of this group is covered").
  const totals = useMemo(() => {
    const t = {};
    RATING_CATEGORIES.forEach((c) => { t[c.key] = scoped.filter((p) => has(p.id, c.key)).length; });
    return t;
  }, [scoped, coverage]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = scoped.filter((p) => {
    if (missing === 'any_or_none') return true;
    if (missing === 'any') return RATING_CATEGORIES.some((c) => !has(p.id, c.key));
    return !has(p.id, missing);
  });

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Athlete', 'Class', 'Status', 'Categories with data', ...RATING_CATEGORIES.map((c) => c.label)];
    const lines = visible.map((p) => {
      const prof = profileOf(p);
      const n = RATING_CATEGORIES.filter((c) => has(p.id, c.key)).length;
      return [p.full_name, classLabelForGradYear(prof.grad_year) || '', prof.status || 'Active', `${n}/${RATING_CATEGORIES.length}`,
        ...RATING_CATEGORIES.map((c) => coverage[p.id]?.[c.key]?.latest || (coached[p.id]?.has(c.key) ? 'coach rated' : ''))];
    });
    const csv = [head, ...lines].map((r) => r.map(esc).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `player-card-data-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-gray-500 text-sm"><Loader2 size={16} className="animate-spin mr-2" />Loading athletes and card data…</div>;
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Some data did not load, so gaps below may be wrong: {loadError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {RATING_CATEGORIES.map((c) => {
          const n = totals[c.key];
          const pct = scoped.length ? Math.round((n * 100) / scoped.length) : 0;
          const active = missing === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setMissing(active ? 'any_or_none' : c.key)}
              title={`Show athletes with no ${c.label} data`}
              className={`text-left rounded-lg border p-2.5 transition ${active ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-300'}`}
            >
              <div className="text-xs font-medium text-gray-600">{c.label}</div>
              <div className="text-lg font-semibold text-gray-900">{n}<span className="text-xs font-normal text-gray-500"> / {scoped.length}</span></div>
              <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
              <div className="text-[11px] text-gray-500 mt-1">{scoped.length - n} missing</div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search athletes" className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm w-48" />
        </div>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="all">All teams</option>
          {teamNames.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={missing} onChange={(e) => setMissing(e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="any_or_none">Everyone</option>
          <option value="any">Missing any category</option>
          {RATING_CATEGORIES.map((c) => <option key={c.key} value={c.key}>Missing {c.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={nbpPlusOnly} onChange={(e) => setNbpPlusOnly(e.target.checked)} />NBP+ only</label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Include archived / inactive</label>
        <div className="flex-1" />
        <span className="text-xs text-gray-500">{visible.length} athletes</span>
        <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"><Download size={14} />Export CSV</button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="text-left font-medium px-3 py-2 sticky left-0 bg-gray-50">Athlete</th>
              <th className="text-left font-medium px-2 py-2">Class</th>
              <th className="font-medium px-2 py-2">Data</th>
              {RATING_CATEGORIES.map((c) => <th key={c.key} className="font-medium px-2 py-2 whitespace-nowrap">{c.short}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((p) => {
              const prof = profileOf(p);
              const n = RATING_CATEGORIES.filter((c) => has(p.id, c.key)).length;
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 sticky left-0 bg-white font-medium text-gray-900 whitespace-nowrap">
                    {p.full_name}
                    {INACTIVE.has(prof.status) && <span className="ml-1.5 text-[10px] text-gray-400">{prof.status}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-500 whitespace-nowrap">{classLabelForGradYear(prof.grad_year) || '—'}</td>
                  <td className={`px-2 py-1.5 text-center text-xs font-semibold ${n === 0 ? 'text-red-600' : n >= 6 ? 'text-emerald-700' : 'text-gray-700'}`}>{n}/{RATING_CATEGORIES.length}</td>
                  {RATING_CATEGORIES.map((c) => {
                    const cell = coverage[p.id]?.[c.key];
                    if (cell) {
                      return (
                        <td key={c.key} className="px-1.5 py-1.5 text-center" title={`${c.label}: ${cell.n} metric${cell.n === 1 ? '' : 's'}, last ${cell.latest}`}>
                          <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px] whitespace-nowrap">✓ {fmtDate(cell.latest)}</span>
                        </td>
                      );
                    }
                    if (coached[p.id]?.has(c.key)) {
                      return <td key={c.key} className="px-1.5 py-1.5 text-center" title={`${c.label}: coach rating, no data`}><span className="inline-block px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[11px]">coach</span></td>;
                    }
                    return <td key={c.key} className="px-1.5 py-1.5 text-center text-gray-300" title={`${c.label}: no data`}>—</td>;
                  })}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={3 + RATING_CATEGORIES.length} className="text-center py-10 text-gray-500 text-sm">No athletes match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        ✓ = the Player Card has data for this category, with the date it was last measured. Windows match the card: assessments
        18 months, Trackman and practice logs 12 months, WHOOP 30 days, uploaded season stats 18 months. "coach" = a coach set the
        rating by hand, but there is still no data behind it.
      </p>
    </div>
  );
}
