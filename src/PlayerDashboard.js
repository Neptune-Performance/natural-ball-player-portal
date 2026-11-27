import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { fetchUserDirectory } from './userDirectory';
import {
  Calendar, Bell, BarChart3, Clock, MessageSquare, CheckCircle, AlertTriangle,
  // #417 — the Explore carousel
  Compass, ChevronLeft, ChevronRight, Target, HeartPulse, Dumbbell, ClipboardCheck, StickyNote, Upload,
} from 'lucide-react';
// #421: external stats sources (GameChanger / Perfect Game / MaxPreps / PBR).
import { sourceInfo, sourceName } from './externalStatsSources';
// #418: Mechanics area labels are shared with the Notes editor — never re-spelled.
import { mechanicsAreaLabel } from './mechanicsDeficiencies';
import WhoopCommunityCodeCard from './WhoopCommunityCode';
// #277: "My RSVPs" — upcoming team events with this player's current answer,
// so they can answer several at once without opening each event.
import { MyRsvpsCard } from './EventRsvp';
import { reservationsForDate, facilityEventsForDate } from './todaySchedule';

const fmtLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// ---------------------------------------------------------------------------
// #417 — "Explore your training" carousel (Cordell)
//
// "Dashboard needs to cycle different features of the app ... short term and
// long term goals ... arm care routines, notes section or any of the other
// features so the athlete is constantly having visuals of the different places
// they can learn / review about themselves."
//
// The issue has a video attachment that could not be watched, so this is the
// reasonable reading of the text: one self-rotating card, high on the
// dashboard, where each slide previews THIS athlete's own rows from one
// feature area and ends in a button that opens that feature.
//
// Rules this card follows, all of them load-bearing here:
//   * READ ONLY. Every query is a SELECT and every one of them destructures
//     `error`.
//   * An RLS-blocked read comes back 200 / zero rows / no error. So "no rows"
//     is NOT an error — it renders the empty state (or, for coach notes, drops
//     the slide). Only a real `error` drops a slide.
//   * A slide whose source could not be read (`null` below) is skipped
//     entirely rather than rendered broken — fail closed.
//   * No embeds/joins: a blocked embed returns `null` with a 200 and would
//     silently blank out a name. Every lookup is a second simple select.
//   * Postgres `date` columns (start_date, end_date, assessment_date) are
//     parsed with an explicit 'T00:00:00' so they don't land on UTC midnight
//     and print a day early. Never toISOString().slice(0,10).
// ---------------------------------------------------------------------------

const EXPLORE_ROTATE_MS = 8000;

// Mirrors NOTE_CATEGORIES + LEGACY_NOTE_CATEGORIES in src/Profile.js (#418).
// Keep in sync with that list — it is the source of truth and owns the editor.
const EXPLORE_NOTE_CATEGORIES = {
  general: { label: 'General', color: 'bg-gray-100 text-gray-700' },
  practice: { label: 'Practice', color: 'bg-blue-100 text-blue-700' },
  game: { label: 'Game', color: 'bg-green-100 text-green-700' },
  disciplinary: { label: 'Disciplinary', color: 'bg-red-100 text-red-700' },
  mechanics: { label: 'Mechanics', color: 'bg-amber-100 text-amber-800' },
  // Retired values, still allowed by the CHECK for the deploy window:
  skill_session: { label: 'Practice', color: 'bg-blue-100 text-blue-700' },
  hitting: { label: 'Mechanics', color: 'bg-amber-100 text-amber-800' },
  pitching: { label: 'Mechanics', color: 'bg-amber-100 text-amber-800' },
};
const exploreNoteCategory = (cat) => EXPLORE_NOTE_CATEGORIES[cat] || EXPLORE_NOTE_CATEGORIES.general;
// Legacy 'hitting'/'pitching' rows carry their area in the category, not `area`.
const exploreNoteArea = (n) => n?.area
  || (n?.category === 'hitting' ? 'hitting' : n?.category === 'pitching' ? 'pitching_throwing' : '');

// 'YYYY-MM-DD' -> "Sep 21". The 'T00:00:00' is what keeps a Postgres `date`
// on its own calendar day in US time zones.
const fmtDayLabel = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
// timestamptz -> "Sep 21". Safe to hand straight to Date.
const fmtStampLabel = (stamp) => {
  if (!stamp) return '';
  const d = new Date(stamp);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const snippet = (text, max = 110) => {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// `null` means "could not read this source" — the caller drops the slide.
// `[]` means "read fine, nothing there yet" — the caller shows an empty state.
const readRows = async (label, query) => {
  const { data, error } = await query;
  if (error) {
    console.error(`Explore carousel: ${label} read failed:`, error);
    return null;
  }
  return data || [];
};

function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const onChange = (e) => setReduced(e.matches);
    setReduced(mq.matches);
    // Safari < 14 only has the deprecated addListener.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

// Short-term / long-term goals the athlete wrote themselves. #417 asks for
// these first. They live in `user_goals` (goal_type short_term|long_term),
// NOT in player_notes — see the comment in App.js's profile-completeness check.
const readGoals = (userId) => readRows('user_goals', supabase
  .from('user_goals')
  .select('id, goal_type, content, created_at')
  .eq('user_id', userId)
  .order('created_at', { ascending: true }));

// The athlete's saved arm care / throwing routines (Profile -> Health -> Arm
// Care, #369). routine_type is one of ARM_CARE_ROUTINE_TYPES in Profile.js.
const readRoutines = (userId) => readRows('arm_care_routines', supabase
  .from('arm_care_routines')
  .select('id, routine_type, title, content, created_at, updated_at')
  .eq('user_id', userId)
  .order('updated_at', { ascending: false }));

// Coach notes about this athlete. #422 (Cordell, confirmed again on #417):
// athletes read their OWN notes via the player_notes_select_own policy, which
// withholds category = 'disciplinary' server-side — so a disciplinary note can
// never reach this card whatever the query asks for. Profile.js shows the
// matching Notes sub-tab (Records → Notes) on the athlete's own profile.
const readNotes = (userId) => readRows('player_notes', supabase
  .from('player_notes')
  .select('id, category, area, deficiencies, content, created_at')
  .eq('player_id', userId)
  .order('created_at', { ascending: false })
  .limit(3));

// The athlete's assigned training program (what ThrowingGenerator / AutoProgram
// / Programming all write): training_program_assignments -> training_programs.
// Assignments are either player-scoped or team-scoped (the table CHECKs exactly
// one of the two), so both legs are read, the same way Profile.js does it.
// Deliberately two selects instead of the `training_programs(...)` embed
// Profile.js uses: a blocked embed returns null on a 200 and would render a
// nameless program.
const readProgram = async (userId) => {
  const { data: teamRows, error: teamErr } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId);
  if (teamErr) {
    // Not fatal: fall back to directly-assigned programs only.
    console.error('Explore carousel: team_members read failed:', teamErr);
  }
  const teamIds = (teamRows || []).map((r) => r.team_id).filter(Boolean);

  const cols = 'id, program_id, team_id, start_date, end_date, created_at';
  const [mine, theirs] = await Promise.all([
    supabase.from('training_program_assignments').select(cols).eq('player_id', userId),
    teamIds.length > 0
      ? supabase.from('training_program_assignments').select(cols).in('team_id', teamIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (mine.error) {
    console.error('Explore carousel: training_program_assignments read failed:', mine.error);
    return null;
  }
  if (theirs.error) {
    console.error('Explore carousel: team training_program_assignments read failed:', theirs.error);
  }

  const assignments = Array.from(new Map(
    [...(mine.data || []), ...(theirs.data || [])].map((a) => [a.id, a]),
  ).values());
  if (assignments.length === 0) return { assignment: null, program: null };

  const programIds = Array.from(new Set(assignments.map((a) => a.program_id).filter(Boolean)));
  if (programIds.length === 0) return { assignment: null, program: null };

  const { data: programRows, error: programErr } = await supabase
    .from('training_programs')
    .select('id, name, description, duration_weeks')
    .in('id', programIds);
  if (programErr) {
    console.error('Explore carousel: training_programs read failed:', programErr);
    return null;
  }
  const byId = new Map((programRows || []).map((p) => [p.id, p]));

  // An assignment whose program row didn't come back would render as a card
  // with no name on it. Drop those; if none survive, drop the whole slide.
  const resolved = assignments.filter((a) => byId.has(a.program_id));
  if (resolved.length === 0) return null;

  const today = fmtLocalDate(new Date());
  const isActive = (a) => (!a.start_date || a.start_date <= today)
    && (!a.end_date || a.end_date >= today);
  const newest = (a, b) => (b.start_date || b.created_at || '').localeCompare(a.start_date || a.created_at || '');

  const active = resolved.filter(isActive).sort(newest);
  const chosen = active[0] || resolved.slice().sort(newest)[0];
  return { assignment: chosen, program: byId.get(chosen.program_id) || null };
};

// #421: external stats the athlete has shared (GameChanger / Perfect Game /
// MaxPreps / PBR / other) — a profile link and/or an uploaded export. RLS lets
// the athlete read their own rows.
const readExternalStats = (userId) => readRows('external_stats', supabase
  .from('external_stats')
  .select('id, source, source_label, title, season, profile_url, file_name, created_at')
  .eq('player_id', userId)
  .order('created_at', { ascending: false })
  .limit(4));

// Assessments taken on this athlete. Template names are a second simple select
// for the same no-embed reason; if that lookup fails the slide still renders
// with a generic label rather than dropping.
const readAssessments = async (userId) => {
  const { data: subs, error } = await supabase
    .from('assessment_submissions')
    .select('id, template_id, assessment_date, created_at')
    .eq('player_id', userId)
    .order('assessment_date', { ascending: false })
    .limit(5);
  if (error) {
    console.error('Explore carousel: assessment_submissions read failed:', error);
    return null;
  }
  const rows = subs || [];
  if (rows.length === 0) return [];

  const templateIds = Array.from(new Set(rows.map((r) => r.template_id).filter(Boolean)));
  let templates = [];
  if (templateIds.length > 0) {
    const { data: tRows, error: tErr } = await supabase
      .from('assessment_templates')
      .select('id, name')
      .in('id', templateIds);
    if (tErr) console.error('Explore carousel: assessment_templates read failed:', tErr);
    templates = tRows || [];
  }
  const byId = new Map(templates.map((t) => [t.id, t]));
  return rows.map((r) => ({ ...r, templateName: byId.get(r.template_id)?.name || 'Assessment' }));
};

function ExploreSlideShell({ icon, accent, title, subtitle, children }) {
  return (
    <>
      <div className="flex items-start space-x-3">
        <div className={`p-2 rounded-lg flex-shrink-0 ${accent}`}>{icon}</div>
        <div className="min-w-0">
          <h4 className="font-semibold text-gray-900 leading-tight">{title}</h4>
          <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </>
  );
}

function ExploreEmpty({ children }) {
  return <p className="text-sm text-gray-500 italic">{children}</p>;
}

function ExploreCarousel({ userId, setCurrentView, onOpenProfileTab }) {
  const [sources, setSources] = useState(null);
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false); // sticky: any manual interaction
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setSources(null);
    (async () => {
      const [goals, routines, program, assessments, notes, externalStats] = await Promise.all([
        readGoals(userId),
        readRoutines(userId),
        readProgram(userId),
        readAssessments(userId),
        readNotes(userId),
        readExternalStats(userId),
      ]);
      if (cancelled) return;
      setSources({ goals, routines, program, assessments, notes, externalStats });
    })().catch((err) => {
      // Nothing above throws today, but a network failure inside the Promise.all
      // must not take the whole dashboard down with it.
      console.error('Explore carousel: load failed:', err);
      if (!cancelled) setSources({ goals: null, routines: null, program: null, assessments: null, notes: null, externalStats: null });
    });
    return () => { cancelled = true; };
  }, [userId]);

  // Profile deep links go through the same mechanism the #278 practice-stats
  // prompt already uses: App.js sets profileInitialTab and switches the view.
  // If the prop is missing (older caller) just open the profile.
  const openProfileTab = (tab) => {
    if (onOpenProfileTab) onOpenProfileTab(tab);
    else if (setCurrentView) setCurrentView('profile');
  };

  const slides = useMemo(() => {
    if (!sources) return [];
    const out = [];
    const { goals, routines, program, assessments, notes, externalStats } = sources;

    // 1. Goals — user_goals, player-authored.
    if (goals) {
      const shortTerm = goals.filter((g) => g.goal_type === 'short_term');
      const longTerm = goals.filter((g) => g.goal_type === 'long_term');
      out.push({
        key: 'goals',
        icon: <Target size={18} className="text-blue-600" />,
        accent: 'bg-blue-50',
        title: 'Your goals',
        subtitle: 'Short-term and long-term, in your own words',
        cta: { label: goals.length > 0 ? 'Review your goals' : 'Set your goals', onClick: () => openProfileTab('goals') },
        body: goals.length === 0 ? (
          <ExploreEmpty>You haven&apos;t written any goals yet. Add one short-term and one long-term goal so you and your coaches are chasing the same thing.</ExploreEmpty>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[{ label: 'Short-term', items: shortTerm }, { label: 'Long-term', items: longTerm }].map(({ label, items }) => (
              <div key={label}>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{label}</p>
                {items.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">None yet</p>
                ) : (
                  <ul className="space-y-1">
                    {items.slice(0, 2).map((g) => (
                      <li key={g.id} className="text-sm text-gray-800">&bull; {snippet(g.content, 70)}</li>
                    ))}
                    {items.length > 2 && <li className="text-xs text-gray-400">+{items.length - 2} more</li>}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ),
      });
    }

    // 2. Arm care / throwing routines — arm_care_routines.
    if (routines) {
      out.push({
        key: 'armcare',
        icon: <HeartPulse size={18} className="text-rose-600" />,
        accent: 'bg-rose-50',
        title: 'Arm care & throwing routine',
        subtitle: 'What you run before and after you throw',
        cta: { label: routines.length > 0 ? 'Open your routines' : 'Build your routine', onClick: () => openProfileTab('armcare') },
        body: routines.length === 0 ? (
          <ExploreEmpty>No arm care routine saved yet. Build your starter, reliever or position routine so you have it on your phone at the field.</ExploreEmpty>
        ) : (
          <ul className="space-y-2">
            {routines.slice(0, 3).map((r) => (
              <li key={r.id} className="flex items-start justify-between space-x-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{r.title || `${r.routine_type || 'Arm care'} Routine`}</p>
                  {r.content && <p className="text-xs text-gray-500">{snippet(r.content, 80)}</p>}
                </div>
                {r.routine_type && (
                  <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700">{r.routine_type}</span>
                )}
              </li>
            ))}
            {routines.length > 3 && <li className="text-xs text-gray-400">+{routines.length - 3} more</li>}
          </ul>
        ),
      });
    }

    // 3. Assigned training program — training_program_assignments.
    if (program) {
      const { assignment, program: prog } = program;
      const range = assignment
        ? [fmtDayLabel(assignment.start_date), fmtDayLabel(assignment.end_date)].filter(Boolean).join(' – ')
        : '';
      out.push({
        key: 'program',
        icon: <Dumbbell size={18} className="text-green-600" />,
        accent: 'bg-green-50',
        title: 'Your training program',
        subtitle: 'The plan your coach put on your calendar',
        cta: { label: 'Open my schedule', onClick: () => setCurrentView && setCurrentView('schedule') },
        body: !prog ? (
          <ExploreEmpty>No training program assigned yet. Once a coach assigns one, every session shows up on your schedule.</ExploreEmpty>
        ) : (
          <div>
            <p className="text-sm font-medium text-gray-900">{prog.name}</p>
            {prog.description && <p className="text-xs text-gray-500 mt-0.5">{snippet(prog.description, 100)}</p>}
            <div className="flex flex-wrap gap-2 mt-2">
              {prog.duration_weeks ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">{prog.duration_weeks} weeks</span>
              ) : null}
              {range ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{range}</span>
              ) : null}
            </div>
          </div>
        ),
      });
    }

    // 4. Assessments — assessment_submissions.
    if (assessments) {
      out.push({
        key: 'assessment',
        icon: <ClipboardCheck size={18} className="text-purple-600" />,
        accent: 'bg-purple-50',
        title: 'Your assessments',
        subtitle: 'Where you tested, and when you last tested',
        cta: { label: assessments.length > 0 ? 'See your assessments' : 'See how assessments work', onClick: () => openProfileTab('assessment') },
        body: assessments.length === 0 ? (
          <ExploreEmpty>No assessments on file yet. Ask a coach about getting assessed &mdash; it&apos;s how your progress gets measured.</ExploreEmpty>
        ) : (
          <ul className="space-y-2">
            {assessments.slice(0, 3).map((a) => (
              <li key={a.id} className="flex items-center justify-between space-x-3">
                <p className="text-sm text-gray-900 min-w-0 truncate">{a.templateName}</p>
                <span className="flex-shrink-0 text-xs text-gray-500">{fmtDayLabel(a.assessment_date) || fmtStampLabel(a.created_at)}</span>
              </li>
            ))}
            {assessments.length > 3 && <li className="text-xs text-gray-400">+{assessments.length - 3} more</li>}
          </ul>
        ),
      });
    }

    // 5. Coach notes — player_notes (own, non-disciplinary — see readNotes).
    // Empty still drops the slide rather than showing an empty state: the
    // athlete can't write notes themselves, so "none yet" has no call to action.
    if (notes && notes.length > 0) {
      out.push({
        key: 'notes',
        icon: <StickyNote size={18} className="text-amber-600" />,
        accent: 'bg-amber-50',
        title: 'Coach notes about you',
        subtitle: 'What your coaches wrote down after sessions',
        cta: { label: 'Read your notes', onClick: () => openProfileTab('notes') },
        body: (
          <ul className="space-y-3">
            {notes.slice(0, 2).map((n) => {
              const cat = exploreNoteCategory(n.category);
              const area = exploreNoteArea(n);
              const deficiencies = Array.isArray(n.deficiencies) ? n.deficiencies : [];
              return (
                <li key={n.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cat.color}`}>{cat.label}</span>
                    {area && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{mechanicsAreaLabel(area)}</span>
                    )}
                    <span className="text-xs text-gray-400">{fmtStampLabel(n.created_at)}</span>
                  </div>
                  {n.content && <p className="text-sm text-gray-800 mt-1">{snippet(n.content, 100)}</p>}
                  {deficiencies.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {deficiencies.slice(0, 3).map((d, i) => (
                        <span key={`${n.id}-d${i}`} className="px-2 py-0.5 rounded text-xs bg-amber-50 text-amber-800 border border-amber-200">{String(d)}</span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ),
      });
    }

    // 6. External stats — external_stats (#421). This one is as much a prompt
    // as a preview: Cordell wants every athlete's GameChanger / PG / MaxPreps /
    // PBR numbers on file, so the empty state asks for them.
    if (externalStats) {
      out.push({
        key: 'external_stats',
        icon: <Upload size={18} className="text-orange-600" />,
        accent: 'bg-orange-50',
        title: 'Your game stats',
        subtitle: 'GameChanger, Perfect Game, MaxPreps, PBR and more',
        cta: { label: externalStats.length > 0 ? 'Manage your stats' : 'Upload your stats', onClick: () => openProfileTab('stats') },
        body: externalStats.length === 0 ? (
          <ExploreEmpty>Share a link to your GameChanger, Perfect Game, MaxPreps or PBR profile, or upload a stats export, so your coaches can train off your real game numbers.</ExploreEmpty>
        ) : (
          <ul className="space-y-2">
            {externalStats.slice(0, 3).map((r) => (
              <li key={r.id} className="flex items-center justify-between space-x-3">
                <div className="flex items-center space-x-2 min-w-0">
                  <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${sourceInfo(r.source).color}`}>{sourceName(r)}</span>
                  <p className="text-sm text-gray-900 min-w-0 truncate">{r.title || r.season || r.file_name || 'Profile link'}</p>
                </div>
                <span className="flex-shrink-0 text-xs text-gray-500">{fmtStampLabel(r.created_at)}</span>
              </li>
            ))}
            {externalStats.length > 3 && <li className="text-xs text-gray-400">+{externalStats.length - 3} more</li>}
          </ul>
        ),
      });
    }

    return out;
    // Deliberately keyed on `sources` alone. The CTA closures capture
    // openProfileTab / setCurrentView, and both of those bottom out in React
    // state setters (App.js's setProfileInitialTab + setCurrentView), which are
    // stable for the life of the component — so a "stale" closure here calls
    // exactly the same thing a fresh one would. Adding the props to the deps
    // would rebuild every slide on each parent render for no behaviour change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // Keep the index in range if the slide count changes between loads.
  useEffect(() => {
    setIndex((i) => (slides.length === 0 ? 0 : i % slides.length));
  }, [slides.length]);

  const paused = stopped || hovered || focused || reducedMotion || slides.length < 2;

  useEffect(() => {
    if (paused) return undefined;
    const timer = setInterval(() => {
      setIndex((i) => (slides.length === 0 ? 0 : (i + 1) % slides.length));
    }, EXPLORE_ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, slides.length]);

  // Any manual interaction stops the auto-rotation for good — an athlete who
  // took control shouldn't have the card move out from under their thumb.
  const goTo = (next) => {
    setStopped(true);
    setIndex(((next % slides.length) + slides.length) % slides.length);
  };

  if (sources === null) return null; // still loading — don't flash an empty card
  if (slides.length === 0) return null; // everything failed to read: show nothing rather than a broken card

  const slide = slides[Math.min(index, slides.length - 1)];

  return (
    <div
      className="bg-white rounded-lg shadow"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      role="group"
      aria-roledescription="carousel"
      aria-label="Explore your training"
    >
      <div className="flex items-center justify-between p-4 sm:p-6 pb-3 sm:pb-4 border-b border-gray-100">
        <div className="flex items-center space-x-2 min-w-0">
          <Compass size={20} className="text-indigo-600 flex-shrink-0" />
          <h3 className="text-lg font-semibold text-gray-900 truncate">Explore your training</h3>
        </div>
        {slides.length > 1 && (
          <div className="flex items-center space-x-1 flex-shrink-0">
            <span className="text-xs text-gray-400 mr-1 hidden sm:inline">{index + 1} / {slides.length}</span>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Previous feature"
              className="p-2 min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition touch-manipulation"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Next feature"
              className="p-2 min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition touch-manipulation"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
      </div>

      <div
        className="p-4 sm:p-6 pt-4 min-h-[190px] sm:min-h-[180px] flex flex-col"
        aria-live={paused ? 'polite' : 'off'}
      >
        <div className="flex-1">
          <ExploreSlideShell icon={slide.icon} accent={slide.accent} title={slide.title} subtitle={slide.subtitle}>
            {slide.body}
          </ExploreSlideShell>
        </div>
        <button
          type="button"
          onClick={() => { setStopped(true); slide.cta.onClick(); }}
          className="mt-4 w-full sm:w-auto sm:self-start inline-flex items-center justify-center space-x-1 bg-blue-600 text-white px-4 py-2 min-h-[40px] rounded-lg text-sm font-medium hover:bg-blue-700 transition touch-manipulation"
        >
          <span>{slide.cta.label}</span>
          <ChevronRight size={16} />
        </button>
      </div>

      {slides.length > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-1 px-4 pb-4">
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Show ${s.title}`}
              aria-current={i === index ? 'true' : undefined}
              className="p-2 min-w-[32px] min-h-[32px] flex items-center justify-center touch-manipulation"
            >
              <span className={`block w-2 h-2 rounded-full transition ${i === index ? 'bg-blue-600' : 'bg-gray-300'}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlayerDashboard({ userId, waiverSigned, setCurrentView, onOpenPracticeStats, onOpenProfileTab }) {
  const [loading, setLoading] = useState(true);
  const [playerData, setPlayerData] = useState(null);
  const [todaySchedule, setTodaySchedule] = useState([]);
  const [notifications, setNotifications] = useState([]);

  const formatTime = (time) => {
    if (!time) return '';
    const [h, m] = time.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  };

  useEffect(() => {
    fetchDashboardData();
  }, [userId]);

  const fetchDashboardData = async () => {
    try {
      // Fetch player profile
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select(`
          *,
          player_profiles!player_profiles_user_id_fkey(*),
          team_members(
            team_id,
            teams(*)
          )
        `)
        .eq('id', userId)
        .single();

      if (userError) throw userError;
      setPlayerData(userData);

      const today = fmtLocalDate(new Date());

      // Fetch today's schedule events for the player (direct + via team_ids)
      const playerTeamIds = (userData.team_members || []).map(tm => tm.team_id).filter(Boolean);
      const [{ data: directEvents }, { data: teamEvents }] = await Promise.all([
        supabase
          .from('schedule_events')
          .select('*')
          .eq('player_id', userId)
          .eq('event_date', today),
        playerTeamIds.length > 0
          ? supabase
              .from('schedule_events')
              .select('*')
              // Union the multi-team array with the legacy scalar team_id, so rows
              // that never got backfilled into team_ids still appear (mirrors MyTeam).
              .or(`team_id.in.(${playerTeamIds.join(',')}),team_ids.ov.{${playerTeamIds.join(',')}}`)
              .eq('event_date', today)
          : Promise.resolve({ data: [] }),
      ]);
      const directIds = new Set((directEvents || []).map(e => e.id));
      const scheduleEvents = [
        ...(directEvents || []),
        ...((teamEvents || []).filter(e => !directIds.has(e.id))),
      ];

      // Fetch facility events for today — only ones the player is involved in:
      // their own lesson/assessment (athlete_id / athlete_ids) or events they
      // signed up for. #502: recurring series are expanded by their real
      // recurrence rule with per-occurrence exceptions honoured (see
      // todaySchedule.js); the old weekday match never ended a series and
      // showed occurrences that had been cancelled.
      const mine = `athlete_id.eq.${userId},athlete_ids.cs.{${userId}}`;
      const [{ data: ownFacilityToday }, { data: ownFacilityMasters }, { data: signups }] = await Promise.all([
        supabase
          .from('facility_events')
          .select('*')
          .or(mine)
          .eq('is_recurring', false)
          .eq('event_date', today),
        supabase
          .from('facility_events')
          .select('*')
          .or(mine)
          .eq('is_recurring', true)
          .is('recurrence_parent_id', null),
        supabase
          .from('event_signups')
          .select('event_id, facility_events:event_id(*)')
          .eq('user_id', userId)
          .eq('event_date', today),
      ]);

      const masterIds = (ownFacilityMasters || []).map(m => m.id);
      let facilityExceptions = [];
      if (masterIds.length > 0) {
        const { data: exRows } = await supabase
          .from('facility_events')
          .select('*')
          .in('recurrence_parent_id', masterIds)
          .or(`original_date.eq.${today},event_date.eq.${today}`);
        facilityExceptions = exRows || [];
      }

      const todayFacility = facilityEventsForDate(ownFacilityToday, ownFacilityMasters, facilityExceptions, today);
      const seenIds = new Set(todayFacility.map(e => e._master_id || e.id));
      (signups || []).forEach(s => {
        const ev = s.facility_events;
        if (ev && !seenIds.has(ev.id)) {
          todayFacility.push({ ...ev, event_date: today });
          seenIds.add(ev.id);
        }
      });

      // The player's sessions TODAY. #502: a reservation is one dated
      // occurrence, so its own slot_date decides — the previous weekday match
      // re-listed every past booking on a weekly slot each week, at that old
      // booking's time. Pending requests are listed too (marked Pending) so
      // the family sees the session they are waiting on.
      const { data: myReservations } = await supabase
        .from('slot_reservations')
        .select('*, training_slots(*)')
        .eq('player_id', userId)
        .eq('slot_date', today)
        .in('status', ['confirmed', 'pending']);

      const bookedSlotIds = [...new Set((myReservations || []).map(r => r.slot_id).filter(Boolean))];
      let slotTombstones = [];
      if (bookedSlotIds.length > 0) {
        const { data: tombRows } = await supabase
          .from('training_slots')
          .select('id, recurrence_parent_id, original_date, is_exception')
          .in('recurrence_parent_id', bookedSlotIds)
          .eq('original_date', today);
        slotTombstones = tombRows || [];
      }
      const todaySlots = reservationsForDate(myReservations, slotTombstones, today);

      // Combine all schedule items
      const allSchedule = [];

      (scheduleEvents || []).forEach(e => {
        allSchedule.push({
          id: e.id,
          title: e.opponent || e.event_type || 'Event',
          time: e.event_time,
          type: e.event_type || 'event',
          location: e.location,
        });
      });

      todayFacility.forEach(e => {
        allSchedule.push({
          id: e.id,
          title: e.title || 'Facility Event',
          time: e.start_time,
          type: 'facility',
          location: e.location,
        });
      });

      todaySlots.forEach(r => {
        const slot = r.training_slots;
        allSchedule.push({
          id: r.id,
          title: 'Training Session',
          time: slot.start_time,
          type: 'training',
          pending: r.status === 'pending',
          duration: slot.duration_minutes,
        });
      });

      allSchedule.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      setTodaySchedule(allSchedule);

      // Fetch notifications: unread messages + pending slot statuses
      const notifs = [];

      // Unread messages
      const { data: participantRows } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', userId);

      const convIds = (participantRows || []).map(p => p.conversation_id);
      if (convIds.length > 0) {
        const { data: allMessages } = await supabase
          .from('messages')
          .select('id, content, created_at, sender_id')
          .in('conversation_id', convIds)
          .neq('sender_id', userId)
          .order('created_at', { ascending: false })
          .limit(10);

        const msgIds = (allMessages || []).map(m => m.id);
        let readIds = new Set();
        if (msgIds.length > 0) {
          const { data: reads } = await supabase
            .from('message_reads')
            .select('message_id')
            .eq('user_id', userId)
            .in('message_id', msgIds);
          readIds = new Set((reads || []).map(r => r.message_id));
        }

        // Sender names come from user_directory rather than an embed on
        // `users`, which would silently degrade every notification to
        // "Someone sent you a message".
        const unread = (allMessages || []).filter(m => !readIds.has(m.id)).slice(0, 5);
        const senders = await fetchUserDirectory(unread.map(m => m.sender_id));
        unread.forEach(m => {
          notifs.push({
            id: m.id,
            type: 'message',
            text: `${senders.get(m.sender_id)?.full_name || 'Someone'} sent you a message`,
            detail: m.content?.substring(0, 60) || '',
            time: m.created_at,
          });
        });
      }

      // Pending slot requests (player's own)
      const { data: pendingReservations } = await supabase
        .from('slot_reservations')
        .select('*, training_slots(*)')
        .eq('player_id', userId)
        .eq('status', 'pending')
        // #502: a request for a date that has already passed is no longer
        // waiting on anyone; listing it only confused families.
        .gte('slot_date', today)
        .order('slot_date', { ascending: true })
        .limit(5);

      (pendingReservations || []).forEach(r => {
        notifs.push({
          id: r.id,
          type: 'pending',
          text: 'Training slot request pending',
          detail: r.training_slots?.start_time ? `${new Date((r.slot_date || r.training_slots.slot_date) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${formatTime(r.training_slots.start_time)}` : '',
          time: r.created_at,
        });
      });

      // Post-practice stats reminder (#278): once a team practice scheduled
      // for today has ended, nudge the player to log stats if they haven't
      // for today yet. Read-only — only reads scheduleEvents (already
      // fetched above) and the three practice-stats tables; no writes.
      const todaysPractices = scheduleEvents.filter(e => e.event_type === 'practice');
      if (todaysPractices.length > 0) {
        const addMinutes = (time, mins) => {
          const [h, m] = time.split(':').map(Number);
          const total = h * 60 + m + mins;
          return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
        };
        const now = new Date();
        let latestEndedAt = null;
        todaysPractices.forEach(p => {
          const start = p.event_time;
          if (!start) return; // no start time — can't tell whether it's over
          const endTime = p.event_end_time || addMinutes(start, 60); // default 1hr, matching how the rest of the app treats a missing end time
          const endedAt = new Date(`${today}T${endTime}`);
          if (now >= endedAt && (!latestEndedAt || endedAt > latestEndedAt)) latestEndedAt = endedAt;
        });

        if (latestEndedAt) {
          const [{ count: abCount }, { count: pitchCount }, { count: catchCount }] = await Promise.all([
            supabase.from('practice_at_bats').select('id', { count: 'exact', head: true }).eq('player_id', userId).eq('ab_date', today),
            supabase.from('practice_pitches').select('id', { count: 'exact', head: true }).eq('player_id', userId).eq('log_date', today),
            supabase.from('practice_catching').select('id', { count: 'exact', head: true }).eq('player_id', userId).eq('log_date', today),
          ]);
          const hasLoggedToday = (abCount || 0) + (pitchCount || 0) + (catchCount || 0) > 0;
          if (!hasLoggedToday) {
            notifs.push({
              id: 'practice-stats-reminder',
              type: 'practice_stats',
              text: 'How did practice go? Add your hitting, pitching and catching stats.',
              detail: '',
              time: latestEndedAt.toISOString(),
              onClick: onOpenPracticeStats,
            });
          }
        }
      }

      notifs.sort((a, b) => new Date(b.time) - new Date(a.time));
      setNotifications(notifs);

    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-600">Loading your dashboard...</p>
      </div>
    );
  }

  if (!playerData) {
    return (
      <div className="bg-white rounded-lg shadow p-12 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Profile Not Found</h2>
        <p className="text-gray-600">Unable to load player profile data.</p>
      </div>
    );
  }

  const profile = playerData.player_profiles?.[0] || playerData.player_profiles;
  const teamInfo = playerData.team_members?.[0]?.teams;

  const getTypeColor = (type) => {
    switch (type) {
      case 'game': return 'bg-blue-100 text-blue-700';
      case 'training': return 'bg-green-100 text-green-700';
      case 'facility': return 'bg-purple-100 text-purple-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getNotifIcon = (type) => {
    switch (type) {
      case 'message': return <MessageSquare size={16} className="text-blue-500" />;
      case 'pending': return <Clock size={16} className="text-yellow-500" />;
      case 'practice_stats': return <BarChart3 size={16} className="text-green-600" />;
      default: return <CheckCircle size={16} className="text-green-500" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Waiver Banner */}
      {waiverSigned === false && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="text-amber-600 flex-shrink-0" size={20} />
            <p className="text-sm font-medium text-amber-800">Action Required: Please sign your waiver to continue.</p>
          </div>
          <button
            onClick={() => setCurrentView('waiver')}
            className="bg-amber-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-amber-700 transition"
          >
            Sign Now
          </button>
        </div>
      )}

      {/* Welcome Header */}
      <div>
        <h2 className="text-3xl font-bold text-gray-900">
          Welcome back, {(playerData.full_name || '').split(' ')[0]}!
        </h2>
        <p className="text-gray-600 mt-1">Here's your overview for today</p>
      </div>

      {/* #319: every player should see this, not just players who open the Whoop tab */}
      <WhoopCommunityCodeCard />

      {/* Player Info Card */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 rounded-lg shadow-lg p-6 text-white">
        <div className="flex items-center space-x-4">
          <div className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center text-3xl font-bold">
            {profile?.jersey_number || '?'}
          </div>
          <div>
            <h3 className="text-2xl font-bold">{playerData.full_name}</h3>
            <div className="flex items-center space-x-3 mt-2 text-blue-100">
              <span>{profile?.position || 'Position not set'}</span>
              {teamInfo && (
                <>
                  <span>&bull;</span>
                  <span>{teamInfo.name}</span>
                </>
              )}
            </div>
            {profile && (
              <div className="mt-2 flex items-center space-x-4 text-sm text-blue-100">
                {profile.grade && <span>Grade: {profile.grade}</span>}
                {profile.bats && <><span>&bull;</span><span>Bats: {profile.bats}</span></>}
                {profile.throws && <><span>&bull;</span><span>Throws: {profile.throws}</span></>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* #417 (Cordell): a rotating "discover" card so the athlete keeps seeing
          the other places in the app that hold their own data — goals, arm
          care, their program, assessments, coach notes (#422), external game
          stats (#421). Sits directly under
          the player card, high enough to be seen without scrolling. */}
      <ExploreCarousel userId={userId} setCurrentView={setCurrentView} onOpenProfileTab={onOpenProfileTab} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's Schedule */}
        <div className="bg-white rounded-lg shadow">
          <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
            <Calendar size={20} className="text-blue-600" />
            <h3 className="text-lg font-semibold text-gray-900">Today's Schedule</h3>
          </div>
          <div className="p-6 pt-4">
            {todaySchedule.length > 0 ? (
              <div className="space-y-3">
                {todaySchedule.map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <div className="text-sm font-semibold text-gray-700 min-w-[70px]">
                        {item.time ? formatTime(item.time) : 'TBD'}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{item.title}</p>
                        {item.location && <p className="text-xs text-gray-500">{item.location}</p>}
                        {item.duration && <p className="text-xs text-gray-500">{item.duration} min</p>}
                      </div>
                    </div>
                    {item.pending ? (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800" title="Waiting for your coach to confirm">
                        Pending
                      </span>
                    ) : (
                      <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${getTypeColor(item.type)}`}>
                        {item.type}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Calendar className="mx-auto text-gray-300 mb-3" size={36} />
                <p className="text-gray-500">No events scheduled for today</p>
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-white rounded-lg shadow">
          <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
            <Bell size={20} className="text-orange-500" />
            <h3 className="text-lg font-semibold text-gray-900">Notifications</h3>
            {notifications.length > 0 && (
              <span className="bg-orange-100 text-orange-700 text-xs font-medium px-2 py-0.5 rounded-full">{notifications.length}</span>
            )}
          </div>
          <div className="p-6 pt-4">
            {notifications.length > 0 ? (
              <div className="space-y-3">
                {notifications.map((notif, idx) => (
                  <div
                    key={notif.id || idx}
                    onClick={notif.onClick}
                    className={`flex items-start space-x-3 p-3 bg-gray-50 rounded-lg ${notif.onClick ? 'cursor-pointer hover:bg-gray-100 transition' : ''}`}
                  >
                    <div className="mt-0.5">{getNotifIcon(notif.type)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{notif.text}</p>
                      {notif.detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{notif.detail}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(notif.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at{' '}
                        {new Date(notif.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Bell className="mx-auto text-gray-300 mb-3" size={36} />
                <p className="text-gray-500">No new notifications</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* #277: My RSVPs — every upcoming practice / game / lifting session for
          this player's team(s), with their current answer. Default is "no
          response" until they click. */}
      <MyRsvpsCard userId={userId} />

      {/* Stats Placeholder */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
          <BarChart3 size={20} className="text-green-600" />
          <h3 className="text-lg font-semibold text-gray-900">Stats</h3>
        </div>
        <div className="p-6 pt-4">
          <div className="text-center py-12">
            <BarChart3 className="mx-auto text-gray-300 mb-4" size={48} />
            <h4 className="text-lg font-semibold text-gray-900 mb-2">Coming Soon</h4>
            <p className="text-gray-500">Your performance stats will appear here.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
