// #416 — the recruiting board: every athlete who hasn't signed yet, grouped by
// class (9th → 12th grade, College Freshman → Senior), with a grad-year
// drop-down covering 2015–2040. Staff only — Profile.js gates the mount.
//
// "Signed" = at least one recruitment_teams row with status 'Committed'.
// Class is derived from player_profiles.grad_year (src/gradYear.js), so the
// board rolls over every August with no data entry. Athletes with no
// grad_year can't be placed; the footer counts them and staff set the year
// in Manage Athletes (or inline here).
import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { ChevronDown, ChevronRight, Users, RefreshCw, Check, X } from 'lucide-react';
import { GRAD_YEAR_OPTIONS, RECRUITING_CLASSES, classForGradYear, schoolYearEnd } from './gradYear';
import { formatUserError } from './errorMessage';

const STATUS_ORDER = ['Offered', 'Talking To', 'Interested'];

// #444: the two marks a coach can put on an athlete straight from the board.
// Both write a recruitment_teams row (the same rows the profile's Recruitment
// tab edits) so there is one source of truth: Committed takes the athlete off
// the board exactly as it does when set on the profile.
const BOARD_MARKS = ['Offered', 'Committed'];
const NEW_SCHOOL = '__new__';

export default function RecruitingBoard({ onNavigateToProfile, highlightUserId, onChanged }) {
  const [athletes, setAthletes] = useState([]);
  const [recruitment, setRecruitment] = useState([]);
  const [missingYear, setMissingYear] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [yearFilter, setYearFilter] = useState('all');
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [savingId, setSavingId] = useState(null);
  // #444: the in-progress mark, one athlete at a time:
  // { userId, status, schoolId (existing row id | NEW_SCHOOL), schoolName }
  const [marking, setMarking] = useState(null);
  const [markSaving, setMarkSaving] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [{ rows: profiles, error: pErr }, { data: rt, error: rErr }, { count, error: cErr }] = await Promise.all([
        // #437: paged past the 1,000-row clamp.
        readAllPages(() => supabase
          .from('player_profiles')
          .select('id, user_id, grade, grad_year, position, level, status, offer_status, users!player_profiles_user_id_fkey(id, full_name, role)')
          .not('grad_year', 'is', null)
          .or('status.is.null,status.neq.Archived')
          .order('id')),
        supabase.from('recruitment_teams').select('id, user_id, status, level, organization_name'),
        supabase
          .from('player_profiles')
          .select('id', { count: 'exact', head: true })
          .is('grad_year', null)
          .or('status.is.null,status.neq.Archived'),
      ]);
      if (pErr) throw pErr;
      if (rErr) throw rErr;
      if (cErr) console.error('RecruitingBoard: missing-year count failed:', cErr);
      setAthletes((profiles || []).filter(p => p.users && p.users.role === 'player'));
      setRecruitment(rt || []);
      setMissingYear(count || 0);
    } catch (e) {
      console.error('RecruitingBoard load failed:', e);
      setError(formatUserError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const recruitmentByUser = useMemo(() => {
    const m = new Map();
    recruitment.forEach(r => {
      if (!m.has(r.user_id)) m.set(r.user_id, []);
      m.get(r.user_id).push(r);
    });
    return m;
  }, [recruitment]);

  const unsigned = useMemo(() => athletes.filter(a => {
    const rows = recruitmentByUser.get(a.user_id) || [];
    return !rows.some(r => r.status === 'Committed');
  }), [athletes, recruitmentByUser]);

  // Groups in board order. A specific grad-year pick shows that one year
  // whatever class it maps to; "all" shows the eight recruiting classes.
  const groups = useMemo(() => {
    const byName = (a, b) => (a.users?.full_name || '').localeCompare(b.users?.full_name || '');
    const end = schoolYearEnd();
    if (yearFilter !== 'all') {
      const yr = Number(yearFilter);
      const cls = classForGradYear(yr);
      return [{ key: String(yr), label: `Class of ${yr}${cls ? ` · ${cls.label}` : ''}`, athletes: unsigned.filter(a => a.grad_year === yr).sort(byName) }];
    }
    return RECRUITING_CLASSES.map(c => {
      const yr = end + c.offset;
      return { key: String(c.offset), label: `${c.label} · Class of ${yr}`, athletes: unsigned.filter(a => a.grad_year === yr).sort(byName) };
    });
  }, [unsigned, yearFilter]);

  const totalShown = groups.reduce((n, g) => n + g.athletes.length, 0);

  const setGradYear = async (profile, value) => {
    const grad_year = value ? parseInt(value, 10) : null;
    setSavingId(profile.id);
    try {
      const { error: uErr } = await supabase.from('player_profiles').update({ grad_year }).eq('id', profile.id);
      if (uErr) throw uErr;
      setAthletes(prev => prev.map(a => a.id === profile.id ? { ...a, grad_year } : a).filter(a => a.grad_year != null));
      if (!grad_year) setMissingYear(n => n + 1);
    } catch (e) {
      alert('Could not update graduation year: ' + formatUserError(e));
    } finally {
      setSavingId(null);
    }
  };

  // #444: start a mark. Existing school rows are offered as the target; a
  // school already at that status is skipped (nothing to change).
  const startMark = (athlete, status) => {
    if (!status) { setMarking(null); return; }
    const rows = (recruitmentByUser.get(athlete.user_id) || []).filter(r => r.organization_name);
    const first = rows.find(r => r.status !== status) || rows[0];
    setMarking({ userId: athlete.user_id, status, schoolId: first ? first.id : NEW_SCHOOL, schoolName: '' });
  };

  const saveMark = async () => {
    if (!marking) return;
    const { userId, status, schoolId } = marking;
    const schoolName = marking.schoolName.trim();
    if (schoolId === NEW_SCHOOL && !schoolName) { alert('Name the school first.'); return; }
    setMarkSaving(true);
    try {
      if (schoolId === NEW_SCHOOL) {
        const { data, error } = await supabase
          .from('recruitment_teams')
          .insert({ user_id: userId, organization_name: schoolName, status })
          .select('id, user_id, status, level, organization_name')
          .single();
        if (error) throw error;
        setRecruitment(prev => [...prev, data]);
      } else {
        const { error } = await supabase
          .from('recruitment_teams')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('id', schoolId);
        if (error) throw error;
        setRecruitment(prev => prev.map(r => r.id === schoolId ? { ...r, status } : r));
      }
      setMarking(null);
      // The profile's own Recruitment list (Profile.js) keeps separate state;
      // let it refetch when the athlete on screen is the one we just marked.
      onChanged?.(userId);
    } catch (e) {
      alert('Could not save: ' + formatUserError(e));
    } finally {
      setMarkSaving(false);
    }
  };

  const summarize = (userId) => {
    const rows = recruitmentByUser.get(userId) || [];
    if (rows.length === 0) return 'No schools yet';
    const counts = {};
    rows.forEach(r => { const k = r.status || 'Interested'; counts[k] = (counts[k] || 0) + 1; });
    return [...STATUS_ORDER, ...Object.keys(counts).filter(k => !STATUS_ORDER.includes(k))]
      .filter(k => counts[k])
      .map(k => `${counts[k]} ${k}`)
      .join(' · ');
  };

  return (
    <div className="mb-8 border border-gray-200 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition rounded-t-lg"
      >
        <div className="flex items-center space-x-2">
          {open ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
          <Users size={16} className="text-blue-600" />
          <h4 className="text-lg font-semibold text-gray-900">Recruiting Board</h4>
          <span className="text-xs text-gray-500">{loading ? 'Loading…' : `${totalShown} unsigned`}</span>
        </div>
        <span className="text-xs text-gray-400">Staff only</span>
      </button>

      {open && (
        <div className="border-t border-gray-200 p-4">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <label className="text-sm font-medium text-gray-700">Grad year:</label>
            <select
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="all">All classes (9th grade → college senior)</option>
              {GRAD_YEAR_OPTIONS.map(y => {
                const cls = classForGradYear(y);
                return <option key={y} value={y}>{y}{cls ? ` · ${cls.label}` : ''}</option>;
              })}
            </select>
            <button type="button" onClick={load} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1" title="Refresh">
              <RefreshCw size={12} /> Refresh
            </button>
            <p className="text-xs text-gray-500 ml-auto">Use <span className="font-medium">Mark…</span> to record an offer or a commitment; Committed athletes drop off the board.</p>
          </div>

          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

          {!loading && totalShown === 0 && !error && (
            <p className="text-sm text-gray-500 italic text-center py-4">No unsigned athletes in this range.</p>
          )}

          <div className="space-y-3">
            {groups.map(g => {
              if (g.athletes.length === 0 && yearFilter === 'all') {
                return (
                  <div key={g.key} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                    <span className="text-sm font-medium text-gray-500">{g.label}</span>
                    <span className="text-xs text-gray-400">none</span>
                  </div>
                );
              }
              const isCollapsed = !!collapsed[g.key];
              return (
                <div key={g.key} className="border border-gray-200 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}
                    className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 rounded-t-lg text-left"
                  >
                    <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      {isCollapsed ? <ChevronRight size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                      {g.label}
                    </span>
                    <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">{g.athletes.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="divide-y divide-gray-100">
                      {g.athletes.map(a => {
                        const rows = recruitmentByUser.get(a.user_id) || [];
                        const offers = rows.filter(r => r.status === 'Offered');
                        const isMarking = marking?.userId === a.user_id;
                        const schoolRows = rows.filter(r => r.organization_name);
                        return (
                        <div
                          key={a.id}
                          className={`px-3 py-2 ${a.user_id === highlightUserId ? 'bg-blue-50' : ''}`}
                        >
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <button
                              type="button"
                              onClick={() => onNavigateToProfile && onNavigateToProfile(a.user_id)}
                              className="text-sm font-medium text-blue-700 hover:underline text-left"
                            >
                              {a.users?.full_name || 'Unnamed'}
                            </button>
                            <span className="text-xs text-gray-500">
                              {[a.position, a.level && a.level !== 'No Level' ? a.level : null, a.grade?.trim()].filter(Boolean).join(' · ') || '—'}
                            </span>
                            {/* #444: college offers stand out; the Naturals Select
                                offer (Manage Athletes, #207) is shown read-only so a
                                coach sees both without leaving the board. */}
                            {offers.length > 0 && (
                              <span className="text-xs font-medium text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full" title={offers.map(o => o.organization_name).filter(Boolean).join(', ')}>
                                Offered · {offers.map(o => o.organization_name).filter(Boolean).join(', ') || offers.length}
                              </span>
                            )}
                            {a.offer_status && (
                              <span className="text-xs text-purple-800 bg-purple-100 px-2 py-0.5 rounded-full" title="Naturals Select offer status (edit in Manage Athletes)">
                                Select: {a.offer_status}
                              </span>
                            )}
                            <span className="text-xs text-gray-600 ml-auto">{summarize(a.user_id)}</span>
                            <select
                              value={isMarking ? marking.status : ''}
                              disabled={markSaving}
                              onChange={(e) => startMark(a, e.target.value)}
                              className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              title="Mark this athlete Offered or Committed"
                            >
                              <option value="">Mark…</option>
                              {BOARD_MARKS.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <select
                              value={a.grad_year || ''}
                              disabled={savingId === a.id}
                              onChange={(e) => setGradYear(a, e.target.value)}
                              className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              title="HS graduation year"
                            >
                              <option value="">— clear —</option>
                              {GRAD_YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
                            </select>
                          </div>
                          {isMarking && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                              <span className="text-xs font-medium text-gray-700">{marking.status} by</span>
                              <select
                                value={marking.schoolId}
                                onChange={(e) => setMarking(m => ({ ...m, schoolId: e.target.value }))}
                                className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                {schoolRows.map(r => (
                                  <option key={r.id} value={r.id}>{r.organization_name}{r.status ? ` (${r.status})` : ''}</option>
                                ))}
                                <option value={NEW_SCHOOL}>New school…</option>
                              </select>
                              {marking.schoolId === NEW_SCHOOL && (
                                <input
                                  type="text"
                                  autoFocus
                                  value={marking.schoolName}
                                  onChange={(e) => setMarking(m => ({ ...m, schoolName: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === 'Enter') saveMark(); if (e.key === 'Escape') setMarking(null); }}
                                  placeholder="School name"
                                  className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px]"
                                />
                              )}
                              {marking.status === 'Committed' && (
                                <span className="text-xs text-gray-500">Committed removes them from this board.</span>
                              )}
                              <button type="button" onClick={saveMark} disabled={markSaving}
                                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                                <Check size={12} /> {markSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button type="button" onClick={() => setMarking(null)} disabled={markSaving}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 text-xs text-gray-700 hover:bg-white">
                                <X size={12} /> Cancel
                              </button>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {missingYear > 0 && (
            <p className="text-xs text-gray-500 mt-4">
              {missingYear} active athlete{missingYear === 1 ? '' : 's'} {missingYear === 1 ? 'has' : 'have'} no graduation year and can't be placed on the board. Set it under Manage Athletes → Edit → HS Graduation Year.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
