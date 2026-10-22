import React, { useState, useEffect, useRef, useMemo } from 'react';
import PtProgressChecks from './PtProgressChecks';
import { supabase } from './supabaseClient';
import { fetchUserDirectory, readDirectory } from './userDirectory';
import { Mail, Phone, Ruler, Scale, Edit2, Save, X, Shirt, Camera, Plus, Trash2, Instagram, Twitter, Building2, ArrowLeft, CheckCircle, XCircle, ShoppingBag, ExternalLink, Users, FileText, ClipboardList, ChevronDown, ChevronUp, Eye, Calendar, ChevronLeft, ChevronRight, Paperclip, Search, AlertTriangle } from 'lucide-react';
import AttendanceRings from './AttendanceRings';
import MedicalHistoryForm from './MedicalHistoryForm';
import EmailComposeModal from './EmailComposeModal';
import { AddEventPanel } from './Schedule';
import WhoopTab from './WhoopTab';
import TrackmanTab from './TrackmanTab';
import ExternalStatsTab from './ExternalStatsTab';
import PitchingOutingsView from './PitchingOutings'; // #463
import LiftLogTab from './LiftLogTab'; // #460
import RegistrationTab from './RegistrationTab';
import { fmtLocalDate } from './scheduleUtils';
import SignedSignatureImage from './SignedSignatureImage';
import StoreModal from './StoreModal';
import ApplyDiscountModal from './ApplyDiscountModal';
import AssignPackageModal from './AssignPackageModal';
import PackagesModal from './PackagesModal';
import MentalTrainingModal from './MentalTrainingModal';
import { BadgePercent, CreditCard, Dumbbell, TrendingUp } from 'lucide-react';
import AssessmentTrends from './AssessmentTrends';
import { formatUserError } from './errorMessage';
import { useModalTracking, trackAction } from './usage';
import { FACILITY_FINE_ENABLED, FACILITY_FINE_LABEL } from './facilityFineDocument';
import { MECHANICS_AREAS, mechanicsArea, mechanicsAreaLabel, mechanicsDeficiencyInfo } from './mechanicsDeficiencies';
import RecruitingBoard from './RecruitingBoard';
import { fetchCompletionRate, COMPLETION_WINDOW_DAYS } from './athleteCheckins';

const EQUIPMENT_FIELDS = [
  { key: 'shirt', label: 'Shirt' },
  { key: 'shorts', label: 'Shorts' },
  { key: 'pants', label: 'Pants' },
  { key: 'shoe', label: 'Shoe' },
  { key: 'belt', label: 'Belt' },
  { key: 'hat', label: 'Hat' },
  { key: 'helmet', label: 'Helmet' },
  { key: 'batting_gloves', label: 'Batting Gloves' },
  { key: 'bat', label: 'Bat' },
];

const PROGRAM_OPTIONS = ['Pitching', 'Hitting', 'Pitching/Hitting', 'Strength', 'Academy', 'Rehab', 'No Program'];
const LEVEL_OPTIONS = ['Independent', 'Affiliate', 'High School', 'Professional', 'College', 'Youth', 'Pro - D', 'Pro - ND', '9U', '10U', '11U', '12U', '13U', '14U', '15U', '16U', '17U', '18U', 'AAA', 'AA', 'A+', 'A', 'MLB', 'Complex', 'NPB', 'KBO', 'MiLB', 'No Level'];
const STATUS_OPTIONS = ['On-Site', 'Remote', 'Active', 'Inactive', 'Archived'];
const SPORT_OPTIONS = ['Baseball', 'Basketball', 'Football', 'Soccer', 'Cricket', 'Softball', 'Lacrosse', 'Hockey', 'Golf', 'Wrestling', 'Swimming', 'Track & Field', 'Gymnastics'];

const PROFILE_TABS = [
  { key: 'general', label: 'General' },
  { key: 'athletes', label: 'Athletes', viewedRoles: ['coach', 'admin'] },
  // #226: Programming was merged into Schedule (they function the same). The
  // Schedule tab now renders the calendar followed by the programming list.
  { key: 'schedule', label: 'Schedule', roles: ['admin', 'coach'] },
  // #450: Trackman, HitTrax, WHOOP and Blast Motion live under one
  // "Technology" tab with a sub-nav (TECH_SUB_TABS), like Health and Records.
  { key: 'technology', label: 'Technology' },
  // #421: athlete-uploaded external stats (GameChanger / Perfect Game /
  // MaxPreps / PBR / other). No role gate: the athlete manages their own,
  // staff manage anyone's, and RLS on external_stats enforces both.
  { key: 'stats', label: 'Stats' },
  // #369: Arm Care, Physical Therapy and Assessment used to be three separate
  // tabs. They are now one "Health" tab with a sub-nav inside it. None of the
  // three had a role gate at tab level and none has one now; the gates that
  // exist are inside the sections themselves (PT's status select and Add
  // Visit, Assessment's Submit and delete) and are untouched.
  { key: 'health', label: 'Health' },
  { key: 'recruitment', label: 'Recruitment', roles: ['admin', 'coach'] },
  // #370: Documents, Codes, Goals, Notes and Assessment all live in Records.
  // #376: Mental Training and Marek moved into Health sub-tabs.
  // #376 (second round): Attendance and Practice Stats moved OUT of this list
  // and into RECORDS_SUB_TABS. Their gates moved with them, unchanged — see the
  // note on each entry there.
  { key: 'records', label: 'Records' },
  { key: 'communication', label: 'Communication', roles: ['admin', 'coach'] },
];

// The tab keys that actually have a content block further down this file (each
// one has a matching `activeProfileTab === '<key>'` section). Any other tab
// shows the "Coming Soon" placeholder instead. This used to be a hand-written
// list of `activeProfileTab !== '...'` tests inside the placeholder itself, and
// it drifted twice — tabs gained real content but were never removed from the
// list, so "Coming Soon" was drawn directly above their content. Add a key here
// the moment you add its content block, and nowhere else.
// #450: 'trackman' and 'whoop' moved under 'technology'. HitTrax and Blast
// Motion are Technology sub-tabs with their own "Coming soon" placeholder.
// #376: 'attendance' and 'practice_stats' were removed from this list at the
// same time as they were removed from PROFILE_TABS. Their content now hangs off
// activeProfileTab === 'records' instead, so neither key can ever be the active
// tab: there is no button that sets it, and the deep-link handler rewrites both
// to 'records' + the matching sub-tab. Leaving them here would have been
// harmless; leaving them here while their content moved would have rendered a
// blank page, and removing the content without removing them would have shown
// "Coming Soon" over nothing. Both go, together.
const PROFILE_TABS_WITH_CONTENT = [
  'general', 'athletes', 'schedule', 'technology', 'stats', 'health',
  'recruitment', 'records', 'communication',
];

// #226: whole-years age from a 'YYYY-MM-DD' DOB, or null if absent/invalid.
function ageFromDob(dob) {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) ? age : null;
}
// Fail-closed age gate: true only when DOB is present AND the athlete is at least `min`.
function meetsAge(dob, min) {
  const age = ageFromDob(dob);
  return age != null && age >= min;
}

const PT_STATUS_OPTIONS = ['Active', 'Pending Eval', 'In Treatment', 'Maintenance', 'Discharged'];
const PT_STATUS_COLORS = {
  'Active': 'bg-sky-100 text-sky-700',
  'Pending Eval': 'bg-yellow-100 text-yellow-700',
  'In Treatment': 'bg-orange-100 text-orange-700',
  'Maintenance': 'bg-green-100 text-green-700',
  'Discharged': 'bg-gray-100 text-gray-700',
};
const PT_VISIT_TYPES = ['Evaluation', 'Treatment', 'Follow-up', 'Re-evaluation', 'Discharge'];
const PT_BODY_AREAS = ['Shoulder', 'Elbow', 'Forearm/Wrist', 'Lower back', 'Hip', 'Knee', 'Ankle/Foot', 'Core', 'Other'];

/* #321 — Sets / Reps / Rest / Load, readable on a 375px phone.
 *
 * The reporter said the numbers he trains off still weren't legible on his
 * phone after the first fix. The failure mode is the same everywhere: these
 * four values get packed onto one un-wrapping line (or into squeezed table
 * columns) with no label, so "3 × 8 · 135 · 60" is both unreadable and
 * ambiguous — which number is the rest and which is the load?
 *
 * This renders them as labelled chips that WRAP instead of truncating, and
 * always prints an em-dash for a value that was never programmed, so a blank
 * is never mistaken for a layout bug. Presentation only.
 */
function ExerciseMetrics({ sets, reps, load, rest, className = '' }) {
  const items = [['Sets', sets], ['Reps', reps], ['Load', load], ['Rest', rest]];
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-1 text-sm ${className}`}>
      {items.map(([label, value]) => (
        <span key={label} className="inline-flex items-baseline gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
          <span className={`font-semibold tabular-nums ${value ? 'text-gray-900' : 'text-gray-400'}`}>
            {value || '—'}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * #340: the "package" pill at the top of an athlete's profile.
 *
 * It used to query `.eq('product_kind', 'package')` and take the single newest
 * row. That filter only matches monthly SUBSCRIPTION products, so every
 * one-time lesson pack was invisible to it — 38 athletes with a real assigned
 * pack read as "No Subscription Set Up". Cordell reported it on Colton Kennedy,
 * who has three assignments and saw none of them.
 *
 * Now: look at every kind that represents an assigned package, and summarise
 * them rather than trusting whichever happens to be newest. A player who holds
 * a live pack AND an old unpaid one should read as active, not pending.
 *
 * Kept in one function precisely because there are three call sites (mount,
 * after Assign Payment, after Apply Discount) and they silently drifted before.
 */
export const PACKAGE_KINDS = ['package', 'bundle', 'lesson'];

export async function fetchPackageStatus(userId) {
  try {
    const { data, error } = await supabase
      .from('store_purchases')
      .select('status, paid_at, created_at, product_kind, product_name_snapshot')
      .eq('user_id', userId)
      .in('product_kind', PACKAGE_KINDS)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data || [];
    if (rows.length === 0) return null;
    // Best status wins, so one stale unpaid row can't mask a live package.
    const rank = { active: 4, paid: 4, past_due: 3, pending: 2 };
    const best = rows.reduce((a, b) => ((rank[b.status] || 1) > (rank[a.status] || 1) ? b : a));
    // #341: `pending` on these rows means "Square never told us", NOT "the
    // athlete owes money". store_webhook_events has never recorded a single
    // event since June 2026, so paid_at is NULL on all 130 lesson-pack
    // purchases and every one of them sits at 'pending' — including the ones
    // the owner has confirmed were really paid in Square. The pill below must
    // therefore never tell an athlete they are behind on payment; it can only
    // report what the portal knows.
    //
    // pendingCount therefore counts "purchases Square has not confirmed to us",
    // not "unpaid purchases", and the labels below are worded accordingly. Note
    // that a paid_at test would not rescue the other statuses either:
    // square-subscriptions-backfill writes status='active' with paid_at NULL.
    return {
      ...best,
      total: rows.length,
      pendingCount: rows.filter((r) => r.status === 'pending').length,
    };
  } catch (e) {
    console.error('package status fetch failed:', e);
    return null;
  }
}

const PROGRAM_HEADER_COLOR = {
  hitting:  { bg: 'bg-teal-100',   text: 'text-teal-600' },
  pitching: { bg: 'bg-green-100',  text: 'text-green-600' },
  warmup:   { bg: 'bg-purple-100', text: 'text-purple-600' },
  general:  { bg: 'bg-orange-100', text: 'text-orange-600' },
};
function getProgramCategory(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('pitch') || t.includes('throw') || t.includes('mound') || t.includes('bullpen') || t.includes('long toss') || t.includes('velo') || t.includes('pen ') || t.includes(' pen')) return 'pitching';
  if (t.includes('hit') || t.includes('tee') || t.includes('bp ') || t.includes('batting') || t.includes('swing') || t.includes(' bp')) return 'hitting';
  if (t.includes('warm') || t.includes('mobil') || t.includes('stretch') || t.includes('cars') || t.includes('foam') || t.includes('band') || t.includes('recovery') || t.includes('yoga') || t.includes('cool')) return 'warmup';
  return 'general';
}

const RECRUITMENT_LEVEL_OPTIONS = ['D1', 'D2', 'D3', 'NAIA', 'JUCO', 'Independent', 'Affiliate'];
const RECRUITMENT_STATUS_OPTIONS = ['Interested', 'Talking To', 'Offered', 'Committed'];

const NOTE_CATEGORIES = [
  { value: 'general', label: 'General', color: 'bg-gray-100 text-gray-700' },
  { value: 'practice', label: 'Practice', color: 'bg-blue-100 text-blue-700' },
  { value: 'game', label: 'Game', color: 'bg-green-100 text-green-700' },
  { value: 'disciplinary', label: 'Disciplinary', color: 'bg-red-100 text-red-700' },
  // #418: Mechanics replaces Skill Session (folded into Practice — Cordell:
  // "it's already the same as practice") and the separate Hitting / Pitching
  // categories. The area (base running, hitting, pitching/throwing, catching,
  // fielding) and the deficiency checklist live on the note itself — see
  // src/mechanicsDeficiencies.js.
  { value: 'mechanics', label: 'Mechanics', color: 'bg-amber-100 text-amber-800' },
];
// Rows written before 20260918_player_notes_mechanics.sql moved them, should
// any survive: read them as the category they became.
const LEGACY_NOTE_CATEGORIES = { skill_session: 'practice', hitting: 'mechanics', pitching: 'mechanics' };
const noteCategoryInfo = (cat) => NOTE_CATEGORIES.find(c => c.value === cat)
  || NOTE_CATEGORIES.find(c => c.value === LEGACY_NOTE_CATEGORIES[cat])
  || NOTE_CATEGORIES[0];
const noteArea = (n) => n?.area || (n?.category === 'hitting' ? 'hitting' : n?.category === 'pitching' ? 'pitching_throwing' : '');

// #370: the sections that live inside the merged "Records" tab, in the order
// they appear in the sub-nav. `staffOnly` reproduces exactly the role gate the
// old top-level Notes tab had (roles: ['admin', 'coach']).
// #422: Notes gained `playerSelf` — an athlete now sees their OWN notes (read
// only, and the database withholds Disciplinary rows via the
// player_notes_select_own policy). Other players' notes stay staff-only.
// Assessment moved here from the Health tab (#376).
const RECORDS_SUB_TABS = [
  { key: 'documents', label: 'Documents' },
  // #447: Perfect Game / Top Tier registration proof. Same visibility as
  // Documents — the athlete and any staff member.
  { key: 'registration', label: 'Registration' },
  { key: 'codes', label: 'Codes' },
  { key: 'goals', label: 'Goals' },
  // #460: weights logged per movement in scheduled workouts. Same visibility
  // as Goals — the athlete and any staff member.
  { key: 'lift_log', label: 'Lift Log' },
  { key: 'notes', label: 'Notes', staffOnly: true, playerSelf: true },
  { key: 'assessment', label: 'Assessment' },
  // #376 (second round): moved down from the top-level tab bar. The gates are
  // carried across verbatim.
  //
  // Attendance was `roles: ['admin', 'coach']` with NO player exception, so
  // `staffOnly` alone reproduces it exactly: staffOnly is filtered by
  // `canSeeNotes`, which is literally `userRole === 'admin' || userRole ===
  // 'coach'` — the same test, phrased the same way.
  { key: 'attendance', label: 'Attendance', staffOnly: true },
  // #463: Practice Stats moved on to the Stats tab (STATS_SUB_TABS), gate and all.
];

// #463: the sections inside the "Stats" tab. External (#421) has no gate.
// Practice Stats keeps the two-part gate it had in Records: `staffOnly` AND a
// player-self exception (#278) — a player sees it on their own profile only.
// Drop `playerSelf` and athletes lose the one place they log their own
// practice work; drop `staffOnly` and every player sees every other player's.
// See visibleStatsSubTabs, where the pair is evaluated.
const STATS_SUB_TABS = [
  { key: 'external', label: 'External Stats' },
  { key: 'practice_stats', label: 'Practice Stats', staffOnly: true, playerSelf: true },
];

// #450: the sections inside the "Technology" tab, in sub-nav order (the order
// Cordell listed them). WHOOP used to be a top-level tab with roles
// ['admin','coach'] plus a player-on-own-profile exception (#154). The tab bar
// already hides every tab from a player looking at someone else, so that pair
// reduces to "everyone who can open the Technology tab" and needs no gate here.
// `comingSoon` sections have no integration yet and render a placeholder.
const TECH_SUB_TABS = [
  { key: 'trackman', label: 'Trackman' },
  { key: 'hittrax', label: 'HitTrax', comingSoon: true },
  { key: 'whoop', label: 'WHOOP' },
  { key: 'blast', label: 'Blast Motion', comingSoon: true },
];

// #369: the sections that live inside the merged "Health" tab, in sub-nav order.
// Assessment moved to Records (#376). Marek (bloodwork, staff 18+) and
// Mental Training (modal, all roles) added here per #376.
const HEALTH_SUB_TABS = [
  { key: 'armcare', label: 'Arm Care' },
  { key: 'pt', label: 'Physical Therapy' },
  { key: 'marek', label: 'Marek', staffOnly: true },
  { key: 'mental', label: 'Mental Training' },
];

// #369: the arm care routine types. These strings are written straight into the
// routine_type column and existing rows are displayed from them, so they must
// stay byte-identical Title Case. The drop-down shows "Starter Routine" etc.,
// but what gets stored is still 'Starter'. Changing any of these would need a
// data migration.
const ARM_CARE_ROUTINE_TYPES = ['Starter', 'Reliever', 'Closer', 'Infielder', 'Outfielder', 'Catching', 'Hitting'];

const NOTE_CONTEXT_OPTIONS = ['game', 'lives', 'scrimmage', 'bullpen', 'practice'];
const PITCH_TYPE_OPTIONS = ['Fastball', '4-Seam', '2-Seam', 'Cutter', 'Sinker', 'Slider', 'Curveball', 'Changeup', 'Splitter', 'Knuckle', 'Other'];
const PITCH_LOCATION_OPTIONS = [
  'Up & In', 'Up Middle', 'Up & Away',
  'Middle In', 'Middle Middle', 'Middle Away',
  'Down & In', 'Down Middle', 'Down & Away',
  'Way Out',
];
const HITTING_RESULT_OPTIONS = ['Take - Ball', 'Take - Strike', 'Swing & Miss', 'Foul', 'Weak Contact', 'Hard Contact', 'In Play - Out', 'In Play - Hit', 'HR'];
const PITCHING_RESULT_OPTIONS = ['Ball', 'Called Strike', 'Swing & Miss', 'Foul', 'Weak Contact', 'Hard Contact', 'In Play - Out', 'In Play - Hit', 'HR'];

// #418: the pitch-by-pitch log belongs to the Hitting and Pitching / Throwing
// Mechanics areas. Returns 'hitting' | 'pitching' | null.
const notePitchLog = (note) => {
  if (!note) return null;
  if (note.category === 'mechanics') return mechanicsArea(note.area)?.pitchLog || null;
  if (note.category === 'hitting' || note.category === 'pitching') return note.category; // legacy rows
  return null;
};

function TeamsList({ teams, onNavigateToTeam }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleClick = (teamId) => {
    setOpen(false);
    if (onNavigateToTeam) onNavigateToTeam(teamId);
  };

  if (sorted.length <= 3) {
    return (
      <div className="flex flex-wrap gap-x-1 mt-1">
        {sorted.map((t, i) => (
          <span key={t.id}>
            {onNavigateToTeam ? (
              <button type="button" onClick={() => handleClick(t.id)} className="text-sm text-blue-600 hover:text-blue-800 hover:underline">{t.name}</button>
            ) : (
              <span className="text-sm text-blue-600">{t.name}</span>
            )}
            {i < sorted.length - 1 && <span className="text-sm text-gray-400">, </span>}
          </span>
        ))}
      </div>
    );
  }

  const preview = sorted.slice(0, 2);
  return (
    <div className="relative inline-block mt-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-sm text-blue-600 hover:text-blue-700 inline-flex items-center"
      >
        <span>{preview.map(t => t.name).join(', ')}</span>
        <span className="ml-1 text-xs text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-full border border-blue-100">
          +{sorted.length - 2} more
        </span>
      </button>
      {open && (
        <div className="absolute z-20 left-0 mt-1 w-64 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-2 text-sm">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-2 pb-1 border-b border-gray-100 mb-1">
            All Teams ({sorted.length})
          </div>
          {sorted.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => handleClick(t.id)}
              className="w-full text-left px-2 py-1.5 text-gray-800 hover:bg-blue-50 hover:text-blue-700 rounded cursor-pointer"
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Profile({ userId, userRole, onBack, loggedInUserId, onNavigateToProfile, onNavigateToTeam, initialTab, onInitialTabHandled }) {
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [equipmentSizes, setEquipmentSizes] = useState({});
  const [editEquipment, setEditEquipment] = useState({});
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [activeProfileTab, setActiveProfileTab] = useState('general');

  // #370: which section is showing inside the merged "Records" tab.
  const [recordsSubTab, setRecordsSubTab] = useState('documents');
  const [statsSubTab, setStatsSubTab] = useState('external'); // #463

  // #369: which section is showing inside the merged "Health" tab, and which
  // routine type is picked in the Arm Care drop-down ('' = nothing picked yet).
  const [healthSubTab, setHealthSubTab] = useState('armcare');
  // #450: which section is showing inside the "Technology" tab.
  const [techSubTab, setTechSubTab] = useState('trackman');
  const activeTechSubTab = TECH_SUB_TABS.some(sub => sub.key === techSubTab) ? techSubTab : 'trackman';
  const [routineTypeChoice, setRoutineTypeChoice] = useState('');

  // Mental Training pop-up (Major League Mindset).
  const [showMentalTraining, setShowMentalTraining] = useState(false);

  // Staff gate — the same test the old top-level Notes tab used. Still the
  // switch for every staffOnly sub-tab and for WRITING notes.
  const canSeeNotes = userRole === 'admin' || userRole === 'coach';
  // #422: an athlete may READ their own notes (the DB hides Disciplinary).
  const canReadOwnNotes = userRole === 'player' && loggedInUserId === userId;
  const canViewNotes = canSeeNotes || canReadOwnNotes;
  // Fail-closed health sub-tab: filter by role/age; mental is modal-only so never a content key.
  const visibleHealthSubTabs = HEALTH_SUB_TABS.filter(sub => {
    if (sub.staffOnly && !canSeeNotes) return false;
    if (sub.key === 'marek' && !meetsAge(userData?.date_of_birth, 18)) return false;
    if (sub.key === 'mental') return false;
    return true;
  });
  const activeHealthSubTab = visibleHealthSubTabs.some(sub => sub.key === healthSubTab)
    ? healthSubTab
    : (visibleHealthSubTabs[0]?.key ?? 'armcare');
  // #376: `playerSelf` is the second half of Practice Stats' old two-part gate —
  // a player may see it, but only on their own profile, exactly as the top-level
  // tab filter did with `return loggedInUserId === userId`. Notes joined it in
  // #422. Attendance and anything else marked staffOnly without playerSelf is
  // unreachable for a player, on their own profile or anyone else's, as before.
  const visibleStatsSubTabs = STATS_SUB_TABS.filter(sub => {
    if (!sub.staffOnly) return true;
    if (canSeeNotes) return true;
    if (sub.playerSelf && userRole === 'player' && loggedInUserId === userId) return true;
    return false;
  });
  const activeStatsSubTab = visibleStatsSubTabs.some(sub => sub.key === statsSubTab) ? statsSubTab : 'external';
  const visibleRecordsSubTabs = RECORDS_SUB_TABS.filter(sub => {
    if (!sub.staffOnly) return true;
    if (canSeeNotes) return true;
    if (sub.playerSelf && userRole === 'player' && loggedInUserId === userId) return true;
    return false;
  });
  // Fail closed. Never trust the raw state value: if it names a section this
  // user is not allowed to see (a stale value left over from a role change, a
  // deep link, or anything else), fall back to the first section they CAN see.
  // Every render and every content block below reads this, never recordsSubTab,
  // so there is no route by which a player reaches Notes.
  const activeRecordsSubTab = visibleRecordsSubTabs.some(sub => sub.key === recordsSubTab)
    ? recordsSubTab
    : visibleRecordsSubTabs[0].key;

  const [viewProgram, setViewProgram] = useState(null); // { id, name } — read-only program viewer
  const [recruitmentTeams, setRecruitmentTeams] = useState([]);
  const [savingRecruitment, setSavingRecruitment] = useState({});
  const [schools, setSchools] = useState([]);
  const [schoolContacts, setSchoolContacts] = useState({});
  const [schoolSearch, setSchoolSearch] = useState('');
  const [schoolLevelFilter, setSchoolLevelFilter] = useState('all');
  const [expandedSchool, setExpandedSchool] = useState(null);
  const [addingSchool, setAddingSchool] = useState(false);
  const [newSchool, setNewSchool] = useState({ name: '', level: 'D1', state: '', city: '', conference: '' });
  const [addingContact, setAddingContact] = useState(null);
  const [newContact, setNewContact] = useState({ name: '', title: '', email: '', phone: '' });
  const [discountCodes, setDiscountCodes] = useState([]);
  const [waiverData, setWaiverData] = useState(null);
  const [contractData, setContractData] = useState(null);
  const [loiData, setLoiData] = useState(null);
  // #378: facility fine acknowledgment status. `unavailable` is a third state,
  // distinct from "not yet signed" - see fetchFacilityFineData below.
  const [facilityFineData, setFacilityFineData] = useState(null);
  const [facilityFineUnavailable, setFacilityFineUnavailable] = useState(false);
  const [armCareRoutines, setArmCareRoutines] = useState([]);
  const [editingRoutineId, setEditingRoutineId] = useState(null);
  const [routineDraft, setRoutineDraft] = useState({ title: '', content: '' });
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [goals, setGoals] = useState([]);
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [goalDraft, setGoalDraft] = useState({ goal_type: 'short_term', content: '' });
  const [savingGoal, setSavingGoal] = useState(false);
  const [playerNotes, setPlayerNotes] = useState([]);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState({ category: 'general', content: '', context: '', pitches: [], area: '', deficiencies: [] });
  const [savingNote, setSavingNote] = useState(false);
  const [noteFilter, setNoteFilter] = useState('all');
  const [noteAreaFilter, setNoteAreaFilter] = useState(''); // #418: Mechanics area sub-filter
  const [attendanceStats, setAttendanceStats] = useState(null);
  // #306: null = not loaded yet (or cancel_reason doesn't exist until its
  // migration runs) — kept distinct from 0 so the stat can stay hidden
  // rather than show a misleading "Sick cancels: 0" before it's meaningful.
  const [sickCancelCount, setSickCancelCount] = useState(null);
  const [attendanceEvents, setAttendanceEvents] = useState([]);
  const [attendanceMap, setAttendanceMap] = useState({});
  const [attendanceFilter, setAttendanceFilter] = useState('all');
  const [savingAttendance, setSavingAttendance] = useState({});
  const [sessionReservations, setSessionReservations] = useState([]);
  const [assessmentTemplates, setAssessmentTemplates] = useState([]);
  const [assessmentSubmissions, setAssessmentSubmissions] = useState([]);
  const [medicalHistory, setMedicalHistory] = useState(null);
  const [showMedicalForm, setShowMedicalForm] = useState(false);
  const [expandedSubmission, setExpandedSubmission] = useState(null);
  const [ageGroupAverages, setAgeGroupAverages] = useState({});
  const [ageGroupLoading, setAgeGroupLoading] = useState({});
  const [assessmentFormTemplate, setAssessmentFormTemplate] = useState(null);
  const [ptVisits, setPtVisits] = useState([]);
  const [editingPtVisitId, setEditingPtVisitId] = useState(null);
  const [ptDraft, setPtDraft] = useState({ visit_date: '', visit_type: 'Treatment', body_area: '', pain_level: '', content: '', exercises: [], follow_up_at: '' });
  const [savingPtVisit, setSavingPtVisit] = useState(false);
  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [scheduleDate, setScheduleDate] = useState(new Date());
  const [programmingData, setProgrammingData] = useState({ programs: [], mealPlans: [], assessments: [], loading: false });
  const [scheduleSelectedDay, setScheduleSelectedDay] = useState(null);
  const [showAddWorkout, setShowAddWorkout] = useState(false);
  const [showEmailCompose, setShowEmailCompose] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const [showUniformStore, setShowUniformStore] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showAssignPackage, setShowAssignPackage] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  const [subscriptionRow, setSubscriptionRow] = useState(null);
  const [communicationLogs, setCommunicationLogs] = useState([]);
  const [loadingComms, setLoadingComms] = useState(false);
  const [coachAthletes, setCoachAthletes] = useState([]);
  const [trainerName, setTrainerName] = useState(null);
  const [allCoaches, setAllCoaches] = useState([]);
  const [sportInput, setSportInput] = useState('');
  const [sportDropdownOpen, setSportDropdownOpen] = useState(false);
  const [sportEditDropdownOpen, setSportEditDropdownOpen] = useState(false);
  // #462: the athlete's own check-in completion over the last 30 days,
  // shown next to their age. null = nothing scheduled (or not a player).
  const [completionRate, setCompletionRate] = useState(null);
  useEffect(() => {
    if (!userId || userData?.role !== 'player') { setCompletionRate(null); return; }
    let cancelled = false;
    fetchCompletionRate(userId).then(r => { if (!cancelled) setCompletionRate(r); });
    return () => { cancelled = true; };
  }, [userId, userData?.role]);
  const avatarInputRef = useRef(null);
  const sportDropdownRef = useRef(null);
  const sportEditDropdownRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (sportDropdownRef.current && !sportDropdownRef.current.contains(e.target)) setSportDropdownOpen(false);
      if (sportEditDropdownRef.current && !sportEditDropdownRef.current.contains(e.target)) setSportEditDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // #377 / K1: the team-store pop-up closes on Escape, like every other modal in
  // this app. Copied from MentalTrainingModal, including its reasoning: the
  // content is read-only and nothing is typed into it, so there is no half-filled
  // form to lose. The listener only exists while the pop-up is open, so it can
  // never swallow an Escape meant for something else on the page.
  useEffect(() => {
    if (!showUniformStore) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setShowUniformStore(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showUniformStore]);

  useEffect(() => {
    let cancelled = false;
    // Reset to a safe tab whenever the viewed user changes. Profile stays mounted
    // across navigation (parent only swaps userId), so without this a tab that's
    // age-gated for the new user (e.g. Marek bloodwork) would keep rendering.
    setActiveProfileTab('general');
    fetchUserData();
    fetchRecruitmentTeams();
    fetchSchools();
    fetchDiscountCodes();
    fetchWaiverData();
    fetchContractData();
    fetchLoiData();
    fetchFacilityFineData();
    fetchArmCareRoutines();
    fetchGoals();
    fetchAssessmentData();
    fetchPtVisits();
    fetchCommunicationLogs();
    readDirectory('staff_directory', (t) => supabase.from(t).select('id, full_name').in('role', ['coach', 'admin']).order('full_name')).then(({ data }) => {
      if (!cancelled) setAllCoaches(data || []);
    }).catch((e) => console.error('coach list fetch failed:', e));
    return () => { cancelled = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [userId]);

  // #376: this effect MUST stay below the `[userId]` effect above. Both fire on
  // the same mount, React runs them in declaration order, and that one opens
  // with setActiveProfileTab('general'). While this block sat above it, the
  // 'general' reset landed second and won, so a deep link only ever worked when
  // Profile happened to be mounted already — which it never is, because App.js
  // unmounts Profile whenever you leave the view. The one in-app caller
  // (PlayerDashboard's "log your practice stats" prompt, #278) therefore landed
  // on General instead of Practice Stats. Pre-existing; fixed here because #376
  // moves both of those deep-link targets.
  // Lets a caller (e.g. the player dashboard's post-practice reminder, #278)
  // open this profile directly on a specific tab. Watches the prop rather
  // than only reading it at mount, then reports back so the parent can
  // clear it — otherwise the next ordinary visit to Profile would land on
  // this tab again instead of 'general'.
  useEffect(() => {
    if (initialTab) {
      // Mental Training is the odd one out here for the same reason it is in the
      // tab bar's onClick below: it is a pop-up, not a tab body. Open the modal
      // and leave whatever tab is underneath alone — parking activeProfileTab on
      // 'mental' would show the "Coming Soon" placeholder, because there is no
      // 'mental' content block for it to fall through to.
      if (initialTab === 'mental') {
        setShowMentalTraining(true);
      // #370: Records sub-tab keys open the Records tab on the right section.
      // assessment and attendance live in Records (#376; practice_stats moved to
      // Stats in #463, handled above), so the old deep links ?tab=attendance keep
      // working — including PlayerDashboard's onOpenPracticeStats, which is the
      // only in-app caller. A player deep-linked to 'attendance' lands on Records
      // and activeRecordsSubTab sends them to Documents; they never see it.
      // #463: Practice Stats moved to the Stats tab; the old deep link (and
      // PlayerDashboard's onOpenPracticeStats) lands there.
      } else if (STATS_SUB_TABS.some(sub => sub.key === initialTab)) {
        setActiveProfileTab('stats');
        setStatsSubTab(initialTab);
      } else if (RECORDS_SUB_TABS.some(sub => sub.key === initialTab)) {
        setActiveProfileTab('records');
        setRecordsSubTab(initialTab);
      // #369/#376: Health sub-tab keys open the Health tab on the right section.
      // marek and mental are now health sub-tabs; assessment moved to Records above.
      } else if (['armcare', 'pt', 'marek'].includes(initialTab)) {
        setActiveProfileTab('health');
        setHealthSubTab(initialTab);
      // #450: the old top-level keys (the WHOOP OAuth return and the WHOOP
      // nudge in the bell both deep-link 'whoop') open Technology on that
      // section.
      } else if (TECH_SUB_TABS.some(sub => sub.key === initialTab)) {
        setActiveProfileTab('technology');
        setTechSubTab(initialTab);
      } else {
        setActiveProfileTab(initialTab);
      }
      onInitialTabHandled?.();
    }
  }, [initialTab]);

  // Player notes: staff read everyone's, an athlete reads their own (#422 —
  // the player_notes_select_own policy withholds Disciplinary rows). Anyone
  // else has no business asking the server for the rows, even though the
  // database would refuse them. This gate is the same test the Notes sub-tab
  // uses.
  // It lives in its own effect, keyed on userRole as well as userId, because
  // userRole arrives from App as null on the first render and only settles once
  // the role lookup comes back. Folding it into the effect above (which re-runs
  // on userId alone) would skip the fetch for admins and coaches and leave the
  // Notes tab permanently empty.
  useEffect(() => {
    if (canViewNotes) fetchPlayerNotes();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [userId, userRole, loggedInUserId]);

  useEffect(() => {
    let cancelled = false;
    if (userData && userData.role === 'player') fetchAttendanceData();
    if (userData && userData.role === 'player' && (userRole === 'admin' || userRole === 'coach')) fetchSickCancelCount();
    if (userData && (userData.role === 'coach' || userData.role === 'admin')) fetchCoachAthletes();
    // Fetch trainer name if player has one assigned. Guard with cancelled so a
    // rapid userData change doesn't write a stale trainer name into state.
    const trainerId = userData?._profile?.trainer_id;
    if (trainerId) {
      readDirectory('staff_directory', (t) => supabase.from(t).select('full_name').eq('id', trainerId).maybeSingle()).then(({ data }) => {
        if (!cancelled && data) setTrainerName(data.full_name);
      }).catch((e) => console.error('trainer name fetch failed:', e));
    } else {
      setTrainerName(null);
    }
    setSportInput(userData?._profile?.sport || '');
    if (userData?.id) {
      fetchPackageStatus(userData.id).then((row) => {
        if (!cancelled) setSubscriptionRow(row);
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userData]);

  const fetchUserData = async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select(`
          *,
          player_profiles!player_profiles_user_id_fkey(*),
          team_members(
            team_id,
            teams(name)
          )
        `)
        .eq('id', userId)
        .single();

      if (error) throw error;

      // Normalize: player_profiles may be object (unique FK) or array
      const pp = data.player_profiles;
      data._profile = Array.isArray(pp) ? pp[0] : pp;

      // Auto-create player_profiles row if missing (fixes #180 — Dom's profile)
      if (!data._profile && data.role === 'player') {
        const { data: newProfile } = await supabase
          .from('player_profiles')
          .insert({ user_id: userId })
          .select()
          .single();
        if (newProfile) data._profile = newProfile;
      }

      setUserData(data);

      const profile = data._profile;
      setEditForm({
        full_name: data.full_name || '',
        email: data.email || '',
        phone: data.phone || '',
        height: data.height || '',
        weight: data.weight || '',
        date_of_birth: data.date_of_birth || '',
        sport: profile?.sport || '',
        jersey_number: profile?.jersey_number || '',
        position: profile?.position || '',
        grade: profile?.grade || '',
        bats: profile?.bats || '',
        throws: profile?.throws || '',
        training_age_years: profile?.training_age_months != null ? String(Math.round((profile.training_age_months / 12) * 10) / 10) : '',
        instagram: data.instagram || '',
        twitter: data.twitter || '',
        organization: data.organization || '',
        parent1_name: data.parent1_name || '',
        parent1_email: data.parent1_email || '',
        parent2_name: data.parent2_name || '',
        parent2_email: data.parent2_email || '',
      });

      // Fetch equipment sizes
      const { data: eqData } = await supabase
        .from('equipment_sizes')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      const eq = eqData || {};
      setEquipmentSizes(eq);
      setEditEquipment({
        shirt: eq.shirt || '',
        shorts: eq.shorts || '',
        pants: eq.pants || '',
        shoe: eq.shoe || '',
        belt: eq.belt || '',
        hat: eq.hat || '',
        helmet: eq.helmet || '',
        batting_gloves: eq.batting_gloves || '',
        bat: eq.bat || '',
      });
    } catch (error) {
      console.error('Error fetching user data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Update users table
      const { error } = await supabase
        .from('users')
        .update({
          full_name: editForm.full_name,
          phone: editForm.phone || null,
          height: editForm.height || null,
          weight: editForm.weight || null,
          date_of_birth: editForm.date_of_birth || null,
          instagram: editForm.instagram || null,
          twitter: editForm.twitter || null,
          organization: editForm.organization || null,
          parent1_name: editForm.parent1_name || null,
          parent1_email: editForm.parent1_email || null,
          parent2_name: editForm.parent2_name || null,
          parent2_email: editForm.parent2_email || null,
        })
        .eq('id', userId);

      if (error) throw error;

      // Update sport in player_profiles
      const profile = userData._profile;
      if (profile) {
        // Training age is entered in years on the profile (single source of truth for the
        // generators) but stored as months in player_profiles.training_age_months.
        const taYears = parseFloat(editForm.training_age_years);
        const trainingAgeMonths = Number.isFinite(taYears) ? Math.max(0, Math.round(taYears * 12)) : null;
        const { error: profileError } = await supabase
          .from('player_profiles')
          .update({ sport: editForm.sport || null, training_age_months: trainingAgeMonths, jersey_number: editForm.jersey_number || null, position: editForm.position || null, grade: editForm.grade || null, bats: editForm.bats || null, throws: editForm.throws || null })
          .eq('user_id', userId);

        if (profileError) throw profileError;
      }

      // Upsert equipment sizes
      const { error: eqError } = await supabase
        .from('equipment_sizes')
        .upsert({
          user_id: userId,
          shirt: editEquipment.shirt || null,
          shorts: editEquipment.shorts || null,
          pants: editEquipment.pants || null,
          shoe: editEquipment.shoe || null,
          belt: editEquipment.belt || null,
          hat: editEquipment.hat || null,
          helmet: editEquipment.helmet || null,
          batting_gloves: editEquipment.batting_gloves || null,
          bat: editEquipment.bat || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

      if (eqError) throw eqError;

      await fetchUserData();
      setEditing(false);
      alert('Profile updated successfully!');
    } catch (error) {
      console.error('Error updating profile:', error);
      alert('Error updating profile: ' + formatUserError(error));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    const profile = userData._profile;
    setEditForm({
      full_name: userData.full_name || '',
      email: userData.email || '',
      phone: userData.phone || '',
      height: userData.height || '',
      weight: userData.weight || '',
      date_of_birth: userData.date_of_birth || '',
      sport: profile?.sport || '',
      instagram: userData.instagram || '',
      twitter: userData.twitter || '',
      organization: userData.organization || '',
      parent1_name: userData.parent1_name || '',
      parent1_email: userData.parent1_email || '',
      parent2_name: userData.parent2_name || '',
      parent2_email: userData.parent2_email || '',
    });
    setEditEquipment({
      shirt: equipmentSizes.shirt || '',
      shorts: equipmentSizes.shorts || '',
      pants: equipmentSizes.pants || '',
      shoe: equipmentSizes.shoe || '',
      belt: equipmentSizes.belt || '',
      hat: equipmentSizes.hat || '',
      helmet: equipmentSizes.helmet || '',
      batting_gloves: equipmentSizes.batting_gloves || '',
      bat: equipmentSizes.bat || '',
    });
    setEditing(false);
  };

  const handleDropdownChange = async (field, value) => {
    try {
      const { error } = await supabase
        .from('player_profiles')
        .update({ [field]: value || null })
        .eq('user_id', userId);
      if (error) throw error;
      await fetchUserData();
    } catch (error) {
      console.error(`Error updating ${field}:`, error);
      alert(`Error updating ${field}: ` + formatUserError(error));
    }
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${userId}/${Date.now()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);
      const { error: updateError } = await supabase
        .from('users')
        .update({ avatar_url: publicUrl })
        .eq('id', userId);
      if (updateError) throw updateError;
      await fetchUserData();
    } catch (error) {
      console.error('Error uploading avatar:', error);
      alert('Error uploading avatar: ' + formatUserError(error));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const fetchRecruitmentTeams = async () => {
    try {
      const { data, error } = await supabase
        .from('recruitment_teams')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      setRecruitmentTeams(data || []);
    } catch (error) {
      console.error('Error fetching recruitment teams:', error);
    }
  };

  const fetchSchools = async () => {
    try {
      const { data, error } = await supabase
        .from('schools')
        .select('*')
        .order('name');
      if (error) throw error;
      setSchools(data || []);
    } catch (error) {
      console.error('Error fetching schools:', error);
    }
  };

  const fetchSchoolContacts = async (schoolId) => {
    if (schoolContacts[schoolId]) return;
    try {
      const { data, error } = await supabase
        .from('school_contacts')
        .select('*')
        .eq('school_id', schoolId)
        .order('name');
      if (error) throw error;
      setSchoolContacts(prev => ({ ...prev, [schoolId]: data || [] }));
    } catch (error) {
      console.error('Error fetching school contacts:', error);
    }
  };

  const addSchool = async () => {
    if (!newSchool.name.trim()) return;
    try {
      const { data, error } = await supabase
        .from('schools')
        .insert(newSchool)
        .select()
        .single();
      if (error) throw error;
      setSchools(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setNewSchool({ name: '', level: 'D1', state: '', city: '', conference: '' });
      setAddingSchool(false);
    } catch (error) {
      console.error('Error adding school:', error);
      alert('Error adding school: ' + formatUserError(error));
    }
  };

  const deleteSchool = async (schoolId) => {
    if (!window.confirm('Delete this school and all its contacts?')) return;
    try {
      const { error } = await supabase.from('schools').delete().eq('id', schoolId);
      if (error) throw error;
      setSchools(prev => prev.filter(s => s.id !== schoolId));
      setSchoolContacts(prev => { const next = { ...prev }; delete next[schoolId]; return next; });
      if (expandedSchool === schoolId) setExpandedSchool(null);
    } catch (error) {
      console.error('Error deleting school:', error);
      alert('Error deleting school: ' + formatUserError(error));
    }
  };

  const addSchoolContact = async (schoolId) => {
    if (!newContact.name.trim()) return;
    try {
      const { data, error } = await supabase
        .from('school_contacts')
        .insert({ ...newContact, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;
      setSchoolContacts(prev => ({
        ...prev,
        [schoolId]: [...(prev[schoolId] || []), data].sort((a, b) => a.name.localeCompare(b.name))
      }));
      setNewContact({ name: '', title: '', email: '', phone: '' });
      setAddingContact(null);
    } catch (error) {
      console.error('Error adding contact:', error);
      alert('Error adding contact: ' + formatUserError(error));
    }
  };

  const deleteSchoolContact = async (schoolId, contactId) => {
    try {
      const { error } = await supabase.from('school_contacts').delete().eq('id', contactId);
      if (error) throw error;
      setSchoolContacts(prev => ({
        ...prev,
        [schoolId]: (prev[schoolId] || []).filter(c => c.id !== contactId)
      }));
    } catch (error) {
      console.error('Error deleting contact:', error);
      alert('Error deleting contact: ' + formatUserError(error));
    }
  };

  const fetchDiscountCodes = async () => {
    try {
      const { data, error } = await supabase
        .from('discount_codes')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      setDiscountCodes(data || []);
    } catch (error) {
      console.error('Error fetching discount codes:', error);
    }
  };

  const fetchArmCareRoutines = async () => {
    try {
      const { data, error } = await supabase
        .from('arm_care_routines')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      setArmCareRoutines(data || []);
    } catch (error) {
      console.error('Error fetching arm care routines:', error);
    }
  };

  const addArmCareRoutine = (routineType) => {
    setEditingRoutineId('new');
    setRoutineDraft({ title: `${routineType} Routine`, content: '', routine_type: routineType });
  };

  const startEditRoutine = (routine) => {
    setEditingRoutineId(routine.id);
    setRoutineDraft({ title: routine.title || '', content: routine.content || '', routine_type: routine.routine_type });
  };

  const cancelEditRoutine = () => {
    setEditingRoutineId(null);
    setRoutineDraft({ title: '', content: '' });
  };

  const saveRoutine = async () => {
    setSavingRoutine(true);
    try {
      if (editingRoutineId === 'new') {
        const { error } = await supabase
          .from('arm_care_routines')
          .insert({
            user_id: userId,
            routine_type: routineDraft.routine_type,
            title: routineDraft.title || null,
            content: routineDraft.content || null,
          });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('arm_care_routines')
          .update({
            title: routineDraft.title || null,
            content: routineDraft.content || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingRoutineId);
        if (error) throw error;
      }
      await fetchArmCareRoutines();
      cancelEditRoutine();
      // Put the drop-down back to "Choose a routine…" now the save went
      // through. Without this it kept the routine that was just added, Add
      // Routine stayed enabled on it, and a second click quietly opened a
      // duplicate draft of the same routine. Only on success — a failed save
      // leaves the choice in place so it can be retried, and cancelling the
      // draft does not touch it either.
      setRoutineTypeChoice('');
    } catch (error) {
      console.error('Error saving routine:', error);
      alert('Error saving routine: ' + formatUserError(error));
    } finally {
      setSavingRoutine(false);
    }
  };

  const deleteRoutine = async (id) => {
    if (!window.confirm('Delete this routine?')) return;
    try {
      const { error } = await supabase.from('arm_care_routines').delete().eq('id', id);
      if (error) throw error;
      await fetchArmCareRoutines();
    } catch (error) {
      console.error('Error deleting routine:', error);
      alert('Error deleting routine: ' + formatUserError(error));
    }
  };

  const fetchGoals = async () => {
    try {
      const { data, error } = await supabase
        .from('user_goals')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      setGoals(data || []);
    } catch (error) {
      console.error('Error fetching goals:', error);
    }
  };

  const addGoal = (goalType) => {
    setEditingGoalId('new');
    setGoalDraft({ goal_type: goalType, content: '' });
  };

  const startEditGoal = (goal) => {
    setEditingGoalId(goal.id);
    setGoalDraft({ goal_type: goal.goal_type, content: goal.content || '' });
  };

  const cancelEditGoal = () => {
    setEditingGoalId(null);
    setGoalDraft({ goal_type: 'short_term', content: '' });
  };

  const saveGoal = async () => {
    if (!goalDraft.content.trim()) return;
    setSavingGoal(true);
    try {
      if (editingGoalId === 'new') {
        const { error } = await supabase
          .from('user_goals')
          .insert({ user_id: userId, goal_type: goalDraft.goal_type, content: goalDraft.content.trim() });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('user_goals')
          .update({ content: goalDraft.content.trim(), updated_at: new Date().toISOString() })
          .eq('id', editingGoalId);
        if (error) throw error;
      }
      await fetchGoals();
      cancelEditGoal();
    } catch (error) {
      console.error('Error saving goal:', error);
      alert('Error saving goal: ' + formatUserError(error));
    } finally {
      setSavingGoal(false);
    }
  };

  const deleteGoal = async (id) => {
    if (!window.confirm('Delete this goal?')) return;
    try {
      const { error } = await supabase.from('user_goals').delete().eq('id', id);
      if (error) throw error;
      await fetchGoals();
    } catch (error) {
      console.error('Error deleting goal:', error);
      alert('Error deleting goal: ' + formatUserError(error));
    }
  };

  const fetchPlayerNotes = async () => {
    try {
      const { data, error } = await supabase
        .from('player_notes')
        .select('*, author:created_by(full_name)')
        .eq('player_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      let notes = data || [];
      // #422: the users SELECT policy is self-or-staff, so for an athlete the
      // `author` embed comes back null on every note. Fill the coach names in
      // through the staff-only SECURITY DEFINER RPC instead of showing "Unknown".
      const missing = [...new Set(notes.filter(n => !n.author?.full_name && n.created_by).map(n => n.created_by))];
      if (missing.length > 0) {
        const { data: names, error: nameErr } = await supabase.rpc('staff_display_names', { ids: missing });
        if (nameErr) {
          console.error('Error resolving note authors:', nameErr);
        } else {
          const byId = Object.fromEntries((names || []).map(r => [r.id, r.full_name]));
          notes = notes.map(n => (!n.author?.full_name && byId[n.created_by])
            ? { ...n, author: { full_name: byId[n.created_by] } }
            : n);
        }
      }
      setPlayerNotes(notes);
    } catch (error) {
      console.error('Error fetching player notes:', error);
    }
  };

  const startNewNote = () => {
    setEditingNoteId('new');
    setNoteDraft({ category: 'general', content: '', context: '', pitches: [], area: '', deficiencies: [] });
  };

  const startEditNote = (note) => {
    setEditingNoteId(note.id);
    setNoteDraft({
      category: LEGACY_NOTE_CATEGORIES[note.category] || note.category,
      area: noteArea(note),
      deficiencies: Array.isArray(note.deficiencies) ? note.deficiencies : [],
      content: note.content || '',
      context: note.context || '',
      pitches: Array.isArray(note.pitches) ? note.pitches : [],
    });
  };

  const cancelEditNote = () => {
    setEditingNoteId(null);
    setNoteDraft({ category: 'general', content: '', context: '', pitches: [], area: '', deficiencies: [] });
  };

  const updateDraftPitch = (idx, field, value) => {
    setNoteDraft(prev => ({
      ...prev,
      pitches: (prev.pitches || []).map((p, i) => i === idx ? { ...p, [field]: value } : p),
    }));
  };

  const addDraftPitch = () => {
    setNoteDraft(prev => ({
      ...prev,
      pitches: [...(prev.pitches || []), { pitch_type: '', location: '', result: '', notes: '' }],
    }));
  };

  const removeDraftPitch = (idx) => {
    setNoteDraft(prev => ({
      ...prev,
      pitches: (prev.pitches || []).filter((_, i) => i !== idx),
    }));
  };

  const noteMatchesFilter = (n) => {
    if (noteFilter === 'all') return true;
    if (noteCategoryInfo(n.category).value !== noteFilter) return false;
    if (noteFilter === 'mechanics' && noteAreaFilter) return noteArea(n) === noteAreaFilter;
    return true;
  };

  const saveNote = async () => {
    const isMechanics = noteDraft.category === 'mechanics';
    if (isMechanics && !noteDraft.area) { alert('Pick a Mechanics area first.'); return; }
    const isPitch = !!notePitchLog(noteDraft);
    const deficiencies = isMechanics
      ? [...new Set((noteDraft.deficiencies || []).map(d => String(d).trim()).filter(Boolean))]
      : [];
    const hasContent = noteDraft.content.trim().length > 0;
    const hasPitches = isPitch && (noteDraft.pitches || []).some(p => p.pitch_type || p.location || p.result || p.notes);
    if (!hasContent && !hasPitches && deficiencies.length === 0) return;
    setSavingNote(true);
    try {
      const payload = {
        category: noteDraft.category,
        content: noteDraft.content.trim(),
        context: isPitch ? (noteDraft.context || null) : null,
        pitches: isPitch
          ? (noteDraft.pitches || []).filter(p => p.pitch_type || p.location || p.result || p.notes)
          : null,
        area: isMechanics ? noteDraft.area : null,
        deficiencies,
      };
      if (editingNoteId === 'new') {
        const { error } = await supabase
          .from('player_notes')
          .insert({
            player_id: userId,
            created_by: loggedInUserId,
            ...payload,
          });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('player_notes')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', editingNoteId);
        if (error) throw error;
      }
      await fetchPlayerNotes();
      cancelEditNote();
    } catch (error) {
      console.error('Error saving note:', error);
      alert('Error saving note: ' + formatUserError(error));
    } finally {
      setSavingNote(false);
    }
  };

  const deleteNote = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    try {
      const { error } = await supabase.from('player_notes').delete().eq('id', id);
      if (error) throw error;
      await fetchPlayerNotes();
    } catch (error) {
      console.error('Error deleting note:', error);
      alert('Error deleting note: ' + formatUserError(error));
    }
  };

  const fetchPtVisits = async () => {
    try {
      const { data, error } = await supabase
        .from('pt_visits')
        .select('*')
        .eq('player_id', userId)
        .order('visit_date', { ascending: false });
      if (error) throw error;
      // Athletes read their own PT visits, so this runs for them too.
      const ptAuthors = await fetchUserDirectory((data || []).map(v => v.created_by));
      setPtVisits((data || []).map(v => ({ ...v, author: ptAuthors.get(v.created_by) || null })));
    } catch (error) {
      console.error('Error fetching PT visits:', error);
    }
  };

  const fetchCommunicationLogs = async () => {
    setLoadingComms(true);
    try {
      const { data, error } = await supabase
        .from('communication_logs')
        .select('*, sender:sent_by(full_name)')
        .eq('player_id', userId)
        .order('sent_at', { ascending: false });
      if (error) throw error;
      setCommunicationLogs(data || []);
    } catch (error) {
      console.error('Error fetching communication logs:', error);
    } finally {
      setLoadingComms(false);
    }
  };

  const fetchCoachAthletes = async () => {
    try {
      // Get the coach's teams
      const { data: teamRows } = await supabase
        .from('team_members')
        .select('team_id, teams(name)')
        .eq('user_id', userId);
      const teamIds = (teamRows || []).map(r => r.team_id);
      if (teamIds.length === 0) { setCoachAthletes([]); return; }

      // Get all player members of those teams
      const { data: members } = await supabase
        .from('team_members')
        .select('team_id, user_id, users(full_name, email, avatar_url, role), teams(name)')
        .in('team_id', teamIds)
        .neq('user_id', userId);

      // Also get athletes explicitly assigned via trainer_id
      const { data: assigned } = await supabase
        .from('player_profiles')
        .select('user_id, users!player_profiles_user_id_fkey(full_name, email, avatar_url)')
        .eq('trainer_id', userId);

      // Merge: group by team, only include players
      const teamMap = {};
      for (const tm of (teamRows || [])) {
        teamMap[tm.team_id] = { name: tm.teams?.name || 'Unknown Team', members: [] };
      }
      const seen = new Set();
      for (const m of (members || [])) {
        if (m.users?.role !== 'player') continue;
        if (seen.has(m.user_id)) continue;
        seen.add(m.user_id);
        if (teamMap[m.team_id]) {
          teamMap[m.team_id].members.push({ id: m.user_id, full_name: m.users.full_name, email: m.users.email, avatar_url: m.users.avatar_url });
        }
      }

      // Add directly assigned athletes that aren't already in a team
      const directAssigned = [];
      for (const a of (assigned || [])) {
        if (!seen.has(a.user_id)) {
          directAssigned.push({ id: a.user_id, full_name: a.users?.full_name, email: a.users?.email, avatar_url: a.users?.avatar_url });
          seen.add(a.user_id);
        }
      }

      const result = Object.entries(teamMap).map(([id, t]) => ({ teamId: id, teamName: t.name, members: t.members })).filter(t => t.members.length > 0);
      if (directAssigned.length > 0) {
        result.push({ teamId: 'direct', teamName: 'Directly Assigned', members: directAssigned });
      }
      setCoachAthletes(result);
    } catch (error) {
      console.error('Error fetching coach athletes:', error);
    }
  };

  const fetchScheduleEvents = async (refDate) => {
    try {
      const d = refDate || scheduleDate;
      const year = d.getFullYear();
      const month = d.getMonth();
      const start = fmtLocalDate(new Date(year, month, 1));
      const end = fmtLocalDate(new Date(year, month + 1, 0));
      const { data: teamRows } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId);
      const teamIds = (teamRows || []).map(r => r.team_id);
      const playerQuery = supabase
        .from('schedule_events')
        .select('*')
        .eq('player_id', userId)
        .gte('event_date', start)
        .lte('event_date', end);
      const teamQuery = teamIds.length > 0
        ? supabase
            .from('schedule_events')
            .select('*')
            .overlaps('team_ids', teamIds)
            .gte('event_date', start)
            .lte('event_date', end)
        : Promise.resolve({ data: [] });
      const [playerRes, teamRes] = await Promise.all([playerQuery, teamQuery]);
      const merged = [...(playerRes.data || []), ...(teamRes.data || [])];
      const dedup = Array.from(new Map(merged.map(e => [e.id, e])).values())
        .sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));
      setScheduleEvents(dedup);
    } catch (error) {
      console.error('Error fetching schedule events:', error);
    }
  };

  const fetchProgrammingData = async () => {
    setProgrammingData(prev => ({ ...prev, loading: true }));
    try {
      const { data: teamRows } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId);
      const teamIds = (teamRows || []).map(r => r.team_id);

      const programPlayerQ = supabase
        .from('training_program_assignments')
        .select('id, program_id, team_id, start_date, end_date, created_at, training_programs(id, name, description, duration_weeks)')
        .eq('player_id', userId);
      const programTeamQ = teamIds.length > 0
        ? supabase
            .from('training_program_assignments')
            .select('id, program_id, team_id, start_date, end_date, created_at, training_programs(id, name, description, duration_weeks)')
            .in('team_id', teamIds)
        : Promise.resolve({ data: [] });

      const mealPlayerQ = supabase
        .from('meal_plan_assignments')
        .select('id, meal_plan_id, team_id, start_date, end_date, created_at, meal_plans(id, name, description, meal_plan_items(sort_order, meals(id, name, meal_type, description, calories, protein_g, carbs_g, fat_g)))')
        .eq('player_id', userId);
      const mealTeamQ = teamIds.length > 0
        ? supabase
            .from('meal_plan_assignments')
            .select('id, meal_plan_id, team_id, start_date, end_date, created_at, meal_plans(id, name, description, meal_plan_items(sort_order, meals(id, name, meal_type, description, calories, protein_g, carbs_g, fat_g)))')
            .in('team_id', teamIds)
        : Promise.resolve({ data: [] });

      const assessmentsQ = supabase
        .from('assessment_submissions')
        .select('id, template_id, assessment_date, notes, created_at, assessment_templates(id, name, short_name)')
        .eq('player_id', userId)
        .order('assessment_date', { ascending: false })
        .limit(10);

      const [pPlayer, pTeam, mPlayer, mTeam, aRes] = await Promise.all([
        programPlayerQ, programTeamQ, mealPlayerQ, mealTeamQ, assessmentsQ,
      ]);

      const programs = Array.from(new Map(
        [...(pPlayer.data || []), ...(pTeam.data || [])].map(r => [r.id, r])
      ).values()).sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

      const mealPlans = Array.from(new Map(
        [...(mPlayer.data || []), ...(mTeam.data || [])].map(r => [r.id, r])
      ).values()).sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

      setProgrammingData({ programs, mealPlans, assessments: aRes.data || [], loading: false });
    } catch (error) {
      console.error('Error fetching programming data:', error);
      setProgrammingData(prev => ({ ...prev, loading: false }));
    }
  };

  useEffect(() => {
    // #226: Schedule tab now also renders the programming list, so fetch both.
    if (activeProfileTab === 'schedule') { fetchScheduleEvents(); fetchProgrammingData(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileTab, scheduleDate, userId]);

  const parseExerciseNotesProfile = (notes) => {
    if (!notes) return { general: '', exercises: [] };
    const delimiter = '--- Exercises ---';
    const idx = notes.indexOf(delimiter);
    if (idx === -1) return { general: notes.trim(), exercises: [] };
    const general = notes.slice(0, idx).trim();
    const exerciseBlock = notes.slice(idx + delimiter.length).trim();
    const exercises = exerciseBlock.split('\n').filter(Boolean).map(line => {
      if (line.includes('|')) {
        // New pipe-delimited format: Name | 3x10 | rest | load | link
        const parts = line.split('|').map(s => s.trim());
        const name = parts[0] || '';
        let sets = '', reps = '', rest = '', load = '', link = '';
        if (parts[1]) {
          const match = parts[1].match(/(\d+)\s*x\s*(\d+)/i);
          if (match) { sets = match[1]; reps = match[2]; } else { sets = parts[1]; }
        }
        if (parts[2]) rest = parts[2];
        if (parts[3]) load = parts[3];
        if (parts[4]) link = parts[4];
        return { name, sets, reps, rest, load, link };
      } else {
        // Legacy format: Name - 3 sets x 10 reps (link) — reps may be a range like 12-15
        const name = line.replace(/ - \d.*$/, '').replace(/ \(https?:.*$/, '').trim();
        let sets = '', reps = '', link = '';
        const srMatch = line.match(/(\d+)\s*sets?\s*x\s*(\d+(?:\s*-\s*\d+)?)\s*reps?/i);
        if (srMatch) { sets = srMatch[1]; reps = srMatch[2].replace(/\s+/g, ''); }
        const linkMatch = line.match(/\((https?:\/\/[^\s)]+)\)/);
        if (linkMatch) link = linkMatch[1];
        return { name, sets, reps, rest: '', load: '', link };
      }
    }).filter(e => e.name);
    return { general, exercises };
  };

  const startNewPtVisit = () => {
    setEditingPtVisitId('new');
    const today = fmtLocalDate(new Date());
    setPtDraft({ visit_date: today, visit_type: 'Treatment', body_area: '', pain_level: '', content: '', exercises: [], follow_up_at: '' });
  };

  const startEditPtVisit = (visit) => {
    setEditingPtVisitId(visit.id);
    setPtDraft({
      visit_date: visit.visit_date || '',
      visit_type: visit.visit_type || 'Treatment',
      body_area: visit.body_area || '',
      pain_level: visit.pain_level == null ? '' : String(visit.pain_level),
      content: visit.content || '',
      exercises: Array.isArray(visit.exercises) ? visit.exercises : [],
      follow_up_at: visit.follow_up_at || '',
    });
  };

  const cancelEditPtVisit = () => {
    setEditingPtVisitId(null);
    setPtDraft({ visit_date: '', visit_type: 'Treatment', body_area: '', pain_level: '', content: '', exercises: [], follow_up_at: '' });
  };

  const updatePtExercise = (idx, field, value) => {
    setPtDraft(prev => ({
      ...prev,
      exercises: (prev.exercises || []).map((ex, i) => i === idx ? { ...ex, [field]: value } : ex),
    }));
  };

  const addPtExercise = () => {
    setPtDraft(prev => ({
      ...prev,
      exercises: [...(prev.exercises || []), { name: '', sets: '', reps: '', notes: '' }],
    }));
  };

  const removePtExercise = (idx) => {
    setPtDraft(prev => ({
      ...prev,
      exercises: (prev.exercises || []).filter((_, i) => i !== idx),
    }));
  };

  const savePtVisit = async () => {
    if (!ptDraft.visit_date) return;
    setSavingPtVisit(true);
    try {
      const exercises = (ptDraft.exercises || []).filter(ex => ex.name || ex.sets || ex.reps || ex.notes);
      const payload = {
        visit_date: ptDraft.visit_date,
        visit_type: ptDraft.visit_type || null,
        body_area: ptDraft.body_area || null,
        pain_level: ptDraft.pain_level === '' ? null : Math.max(0, Math.min(10, parseInt(ptDraft.pain_level, 10) || 0)),
        content: ptDraft.content || null,
        exercises: exercises.length > 0 ? exercises : null,
        follow_up_at: ptDraft.follow_up_at || null,
      };
      if (editingPtVisitId === 'new') {
        const { error } = await supabase.from('pt_visits').insert({
          ...payload,
          player_id: userId,
          created_by: loggedInUserId,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('pt_visits')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', editingPtVisitId);
        if (error) throw error;
      }
      await fetchPtVisits();
      cancelEditPtVisit();
    } catch (error) {
      console.error('Error saving PT visit:', error);
      alert('Error saving PT visit: ' + formatUserError(error));
    } finally {
      setSavingPtVisit(false);
    }
  };

  const deletePtVisit = async (id) => {
    if (!window.confirm('Delete this PT visit?')) return;
    try {
      const { error } = await supabase.from('pt_visits').delete().eq('id', id);
      if (error) throw error;
      await fetchPtVisits();
    } catch (error) {
      alert('Error deleting visit: ' + formatUserError(error));
    }
  };

  const updatePtStatus = async (newStatus) => {
    if (!userData?._profile?.id) return;
    const { error } = await supabase
      .from('player_profiles')
      .update({ pt_status: newStatus || null })
      .eq('id', userData._profile.id);
    if (error) {
      alert('Could not update PT status: ' + formatUserError(error));
      return;
    }
    setUserData(prev => ({ ...prev, _profile: { ...prev._profile, pt_status: newStatus || null } }));
  };

  const fetchAttendanceData = async () => {
    try {
      const teamIds = (userData.team_members || []).map(tm => tm.team_id);
      const today = fmtLocalDate(new Date());

      let allEvents = [];

      // Fetch past team events (games + practices)
      if (teamIds.length > 0) {
        const { data: teamEvents, error: teamEventsError } = await supabase
          .from('schedule_events')
          .select('id, event_type, event_date, opponent, title, team_id, team_ids')
          .overlaps('team_ids', teamIds)
          .is('player_id', null)
          .in('event_type', ['game', 'practice'])
          .lte('event_date', today);
        // DIAGNOSTIC (temporary): supabase-js resolves query errors rather than
        // throwing, so the outer try/catch never sees them — every query in
        // this function was silently discarding its `error` field. Logging
        // only; no behavior change.
        if (teamEventsError) console.error('fetchAttendanceData: teamEvents (schedule_events) query failed:', teamEventsError);
        if (teamEvents) allEvents = [...allEvents, ...teamEvents];
      }

      // Fetch past player-specific workouts
      const { data: workoutEvents, error: workoutEventsError } = await supabase
        .from('schedule_events')
        .select('id, event_type, event_date, title, player_id')
        .eq('player_id', userId)
        .eq('event_type', 'workout')
        .lte('event_date', today);
      if (workoutEventsError) console.error('fetchAttendanceData: workoutEvents (schedule_events) query failed:', workoutEventsError);
      if (workoutEvents) allEvents = [...allEvents, ...workoutEvents];

      // Sort by date descending
      allEvents.sort((a, b) => b.event_date.localeCompare(a.event_date));
      setAttendanceEvents(allEvents);

      // Fetch training slot reservations (sessions) for this player
      const { data: slotRes, error: slotResError } = await supabase
        .from('slot_reservations')
        .select('id, slot_id, slot_date, status, attendance, training_slots(start_time, duration_minutes, notes)')
        .eq('player_id', userId)
        .neq('status', 'cancelled')
        .order('slot_date', { ascending: false });
      if (slotResError) console.error('fetchAttendanceData: slot_reservations query failed:', slotResError);
      setSessionReservations(slotRes || []);

      // Header-circle Sessions count (#271) — deliberately the SAME data and
      // the SAME attended/upcoming rules as the Sessions tab above (#271's
      // live predecessor, 8f89fd5d), so the circle can never disagree with
      // the detail list it summarizes. Not a second fetch, not a second
      // definition of "session" — just a rollup of slotRes.
      const sessionStats = {
        attended: (slotRes || []).filter(r => r.slot_date < today && (r.attendance === 'present' || r.attendance === 'late')).length,
        upcoming: (slotRes || []).filter(r => r.slot_date >= today).length,
      };

      if (allEvents.length === 0) {
        setAttendanceStats({ practice: { attended: 0, total: 0 }, game: { attended: 0, total: 0 }, workout: { attended: 0, total: 0 }, sessions: sessionStats });
        setAttendanceMap({});
        return;
      }

      // Fetch attendance records for this player
      const eventIds = allEvents.map(e => e.id);
      const { data: records, error: recordsError } = await supabase
        .from('event_attendance')
        .select('*')
        .eq('player_id', userId)
        .in('event_id', eventIds);
      if (recordsError) console.error('fetchAttendanceData: event_attendance query failed:', recordsError);

      const recMap = {};
      (records || []).forEach(r => { recMap[r.event_id] = r; });
      setAttendanceMap(recMap);

      // Compute stats per type
      const stats = { practice: { attended: 0, total: 0 }, game: { attended: 0, total: 0 }, workout: { attended: 0, total: 0 } };
      allEvents.forEach(ev => {
        const rec = recMap[ev.id];
        if (!rec) return; // unmarked events don't count
        if (rec.status === 'excused') return; // excused excluded entirely
        const type = ev.event_type;
        if (stats[type]) {
          stats[type].total += 1;
          if (rec.status === 'present') stats[type].attended += 1;
        }
      });
      stats.sessions = sessionStats;
      setAttendanceStats(stats);
    } catch (error) {
      console.error('Error fetching attendance data:', error);
    }
  };

  // #306: "Sick cancels: N" — staff-only, no automatic blocking, just a
  // count so a human can notice a pattern. Counting cancel_reason = 'sick' is
  // still the right query after the decision moved to staff, and a better
  // number than it was: only an admin or coach can write that value now. Separate from fetchAttendanceData
  // above on purpose: that query explicitly excludes cancelled reservations
  // (.neq('status', 'cancelled')) and other things already depend on it
  // staying that way (see its own comment) — this is its own small query,
  // not a change to that one.
  const fetchSickCancelCount = async () => {
    try {
      const { count, error } = await supabase
        .from('slot_reservations')
        .select('id', { count: 'exact', head: true })
        .eq('player_id', userId)
        .eq('status', 'cancelled')
        .eq('cancel_reason', 'sick');
      if (error) throw error;
      setSickCancelCount(count || 0);
    } catch (error) {
      // #306: cancel_reason doesn't exist until its migration
      // (20260812_slot_reservations_cancel_reason.sql) runs — leave the
      // count unset (hidden) rather than show a wrong number.
      console.error('Sick cancel count error (migration pending?):', error);
    }
  };

  const handleMarkAttendance = async (eventId, status) => {
    setSavingAttendance(prev => ({ ...prev, [eventId]: true }));
    try {
      const existing = attendanceMap[eventId];
      if (existing && existing.status === status) {
        // Toggle off — delete the record
        const { error } = await supabase
          .from('event_attendance')
          .delete()
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        // Upsert
        const { error } = await supabase
          .from('event_attendance')
          .upsert({
            event_id: eventId,
            player_id: userId,
            status,
            marked_by: loggedInUserId,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'event_id,player_id' });
        if (error) throw error;
      }
      await fetchAttendanceData();
    } catch (error) {
      console.error('Error marking attendance:', error);
      alert('Error marking attendance: ' + formatUserError(error));
    } finally {
      setSavingAttendance(prev => ({ ...prev, [eventId]: false }));
    }
  };

  const fetchWaiverData = async () => {
    try {
      const { data, error } = await supabase
        .from('waiver_signatures')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      setWaiverData(data);
    } catch (error) {
      console.error('Error fetching waiver data:', error);
    }
  };

  const fetchContractData = async () => {
    try {
      const { data, error } = await supabase
        .from('player_contracts')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      setContractData(data);
    } catch (error) {
      console.error('Error fetching contract data:', error);
    }
  };

  const fetchLoiData = async () => {
    try {
      const { data, error } = await supabase
        .from('player_letters_of_intent')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      setLoiData(data);
    } catch (error) {
      console.error('Error fetching LOI data:', error);
    }
  };

  // #378: read-only status of the facility fine acknowledgment. The signing
  // flow itself is src/FacilityFinePage.js (#189) - this only mirrors it into
  // the Documents list so an athlete (and staff viewing them) sees the same
  // set of documents in both places. Gated by FACILITY_FINE_ENABLED; see
  // src/facilityFineDocument.js for the switch and why it ships off.
  //
  // There can legitimately be more than one row per user (one per uploaded
  // version of the document), so this takes the newest rather than
  // .maybeSingle(), which throws when more than one row matches.
  const fetchFacilityFineData = async () => {
    if (!FACILITY_FINE_ENABLED) return;
    try {
      const { data, error } = await supabase
        .from('facility_fine_signatures')
        .select('*')
        .eq('user_id', userId)
        .order('signed_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      setFacilityFineData((data && data[0]) || null);
      setFacilityFineUnavailable(false);
    } catch (error) {
      // The table or its policies may not have been migrated on this database
      // yet. Never render that as a red "Incomplete": a false unsigned badge
      // sends a family off to sign a document that cannot be saved.
      console.error('Error fetching facility fine data:', error);
      setFacilityFineData(null);
      setFacilityFineUnavailable(true);
    }
  };

  const fetchAssessmentData = async () => {
    try {
      // Fetch assessment templates visible to athlete
      const { data: templates } = await supabase
        .from('assessment_templates')
        .select('*')
        .eq('status', 'active')
        .eq('show_to_athlete', true)
        .order('name');
      setAssessmentTemplates(templates || []);

      // Fetch completed submissions for this player
      const { data: subs, error: subsError } = await supabase
        .from('assessment_submissions')
        .select('*, assessment_templates(name, schema)')
        .eq('player_id', userId)
        .order('created_at', { ascending: false });
      if (subsError) console.error('assessment submissions fetch failed:', subsError);
      // "Assessed by" used to embed `users`. An athlete reads their own
      // submissions, so this runs for them — a blocked embed would print
      // "Assessed by Unknown" on every assessment with no error anywhere.
      const assessors = await fetchUserDirectory((subs || []).map(s => s.assessed_by));
      setAssessmentSubmissions((subs || []).map(s => ({
        ...s, assessor: assessors.get(s.assessed_by) || null,
      })));

      // Fetch medical history status
      const { data: mh } = await supabase
        .from('medical_history')
        .select('id, signed_at')
        .eq('user_id', userId)
        .maybeSingle();
      setMedicalHistory(mh);
    } catch (error) {
      console.error('Error fetching assessment data:', error);
    }
  };

  const getAgeBracket = (dob) => {
    if (!dob) return null;
    const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 10) return 'Under 10';
    if (age <= 12) return '10-12';
    if (age <= 14) return '13-14';
    if (age <= 16) return '15-16';
    if (age <= 18) return '17-18';
    return '19+';
  };

  const extractNumericAverage = (text) => {
    if (!text || typeof text !== 'string') return null;
    const nums = text.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length === 0) return null;
    const values = nums.map(Number);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  const computeAgeGroupAverages = (allSubs, dobMap, currentDob, schema) => {
    const bracket = getAgeBracket(currentDob);
    if (!bracket) return null;

    // Dedup to latest submission per player
    const latestByPlayer = {};
    for (const sub of allSubs) {
      const pid = sub.player_id;
      if (!latestByPlayer[pid] || sub.created_at > latestByPlayer[pid].created_at) {
        latestByPlayer[pid] = sub;
      }
    }

    // Filter to same bracket
    const inBracket = Object.values(latestByPlayer).filter(sub => {
      const dob = dobMap[sub.player_id];
      return dob && getAgeBracket(dob) === bracket;
    });

    if (inBracket.length < 2) return null;

    // Compute per-element averages
    const averages = {};
    for (const el of schema) {
      if (el.type === 'combo_box' || el.type === 'date') continue;

      if (el.type === 'table') {
        const tableAvg = {};
        let hasAny = false;
        for (const row of (el.rows || [])) {
          tableAvg[row] = {};
          for (const col of (el.columns || [])) {
            const vals = [];
            for (const sub of inBracket) {
              const cellVal = sub.responses?.[el.id]?.[row]?.[col];
              const num = extractNumericAverage(String(cellVal || ''));
              if (num !== null) vals.push(num);
            }
            if (vals.length >= 2) {
              tableAvg[row][col] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
              hasAny = true;
            }
          }
        }
        if (hasAny) averages[el.id] = tableAvg;
      } else {
        const vals = [];
        for (const sub of inBracket) {
          const raw = sub.responses?.[el.id];
          const num = extractNumericAverage(String(raw || ''));
          if (num !== null) vals.push(num);
        }
        if (vals.length >= 2) {
          averages[el.id] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
        }
      }
    }

    return { bracket, averages, sampleSize: inBracket.length };
  };

  const fetchAgeGroupAverages = async (templateId, schema) => {
    if (ageGroupAverages[templateId] !== undefined || ageGroupLoading[templateId]) return;
    if (!userData?.date_of_birth) return;

    setAgeGroupLoading(prev => ({ ...prev, [templateId]: true }));
    try {
      // Athlete privacy: players can no longer read the whole cohort's raw
      // submissions (RLS now scopes assessment_submissions to self-or-staff),
      // so the aggregation happens server-side and returns averages only.
      // Staff keep the client-side path below, which is unchanged.
      if (userRole === 'player') {
        const { data: agg, error: aggError } = await supabase
          .rpc('assessment_age_group_averages', { p_template_id: templateId });
        if (aggError) console.error('Error fetching age group averages:', aggError);
        setAgeGroupAverages(prev => ({ ...prev, [templateId]: agg || null }));
        return;
      }

      const { data: allSubs } = await supabase
        .from('assessment_submissions')
        .select('player_id, responses, created_at')
        .eq('template_id', templateId);

      if (!allSubs || allSubs.length === 0) {
        setAgeGroupAverages(prev => ({ ...prev, [templateId]: null }));
        return;
      }

      const playerIds = [...new Set(allSubs.map(s => s.player_id))];
      const { data: users } = await supabase
        .from('users')
        .select('id, date_of_birth')
        .in('id', playerIds);

      const dobMap = {};
      for (const u of (users || [])) {
        if (u.date_of_birth) dobMap[u.id] = u.date_of_birth;
      }

      const result = computeAgeGroupAverages(allSubs, dobMap, userData.date_of_birth, schema);
      setAgeGroupAverages(prev => ({ ...prev, [templateId]: result }));
    } catch (error) {
      console.error('Error fetching age group averages:', error);
      setAgeGroupAverages(prev => ({ ...prev, [templateId]: null }));
    } finally {
      setAgeGroupLoading(prev => ({ ...prev, [templateId]: false }));
    }
  };

  const addRecruitmentTeam = async () => {
    try {
      const { data, error } = await supabase
        .from('recruitment_teams')
        .insert({ user_id: userId })
        .select()
        .single();
      if (error) throw error;
      setRecruitmentTeams([...recruitmentTeams, data]);
    } catch (error) {
      console.error('Error adding recruitment team:', error);
      alert('Error adding team: ' + formatUserError(error));
    }
  };

  const updateRecruitmentTeam = async (teamId, field, value) => {
    setSavingRecruitment(prev => ({ ...prev, [teamId + field]: true }));
    try {
      const { error } = await supabase
        .from('recruitment_teams')
        .update({ [field]: value || null, updated_at: new Date().toISOString() })
        .eq('id', teamId);
      if (error) throw error;
      setRecruitmentTeams(prev =>
        prev.map(t => t.id === teamId ? { ...t, [field]: value } : t)
      );
    } catch (error) {
      console.error('Error updating recruitment team:', error);
    } finally {
      setSavingRecruitment(prev => ({ ...prev, [teamId + field]: false }));
    }
  };

  const deleteRecruitmentTeam = async (teamId) => {
    if (!window.confirm('Delete this recruitment entry?')) return;
    try {
      const { error } = await supabase
        .from('recruitment_teams')
        .delete()
        .eq('id', teamId);
      if (error) throw error;
      setRecruitmentTeams(prev => prev.filter(t => t.id !== teamId));
    } catch (error) {
      console.error('Error deleting recruitment team:', error);
      alert('Error deleting team: ' + formatUserError(error));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-600">Loading profile...</p>
      </div>
    );
  }

  if (!userData) {
    return (
      <div className="bg-white rounded-lg shadow p-12 text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Profile Not Found</h2>
        <p className="text-gray-600 mb-4">Unable to load profile data. This may be caused by an expired session.</p>
        <div className="flex items-center justify-center space-x-3">
          <button
            onClick={() => { setLoading(true); fetchUserData(); }}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition"
          >
            Retry
          </button>
          <button
            onClick={async () => { await supabase.auth.signOut(); window.location.reload(); }}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 transition"
          >
            Log Out &amp; Re-Login
          </button>
        </div>
      </div>
    );
  }

  const profile = userData._profile;
  const canEditProfile = userRole === 'coach' || userRole === 'admin';
  // `onBack` is only passed when viewing SOMEONE ELSE's profile, so
  // "staff, or my own profile" is the rule for every mutating control here.
  const canUploadAvatar = canEditProfile || !onBack;

  // Athlete privacy: a player may only ever see their OWN full profile. This
  // single gate covers everything below it — the tab bar (assessments,
  // trackman, arm care, PT, documents, codes, goals, the coach "Athletes"
  // roster), the Edit Profile button, the avatar upload and the goal
  // add/edit/delete controls. Staff (coach/admin) are unaffected, and a player
  // viewing themselves (loggedInUserId === userId) falls straight through.
  if (userRole === 'player' && loggedInUserId !== userId) {
    return (
      <div className="space-y-6">
        <div className="flex items-center space-x-3">
          {onBack && (
            <button onClick={onBack} className="text-gray-500 hover:text-gray-700 transition">
              <ArrowLeft size={24} />
            </button>
          )}
          <h2 className="text-3xl font-bold text-gray-900">Profile</h2>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
          <Users className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="text-gray-900 font-medium">You don't have access to this profile</p>
          <p className="text-gray-600 text-sm mt-1">Athlete profiles are private. You can always view your own profile from the sidebar.</p>
        </div>
      </div>
    );
  }

  const handleDeleteAssessment = async (subId) => {
    if (!window.confirm('Delete this assessment submission? This cannot be undone.')) return;
    const { error } = await supabase.from('assessment_submissions').delete().eq('id', subId);
    if (error) { alert('Error deleting assessment: ' + formatUserError(error)); return; }
    setAssessmentSubmissions(prev => prev.filter(s => s.id !== subId));
    if (expandedSubmission === subId) setExpandedSubmission(null);
  };

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {onBack && (
            <button onClick={onBack} className="text-gray-500 hover:text-gray-700 transition">
              <ArrowLeft size={24} />
            </button>
          )}
          <div>
            <h2 className="text-3xl font-bold text-gray-900">{onBack ? `${userData.full_name}'s Profile` : 'My Profile'}</h2>
            <p className="text-gray-600 mt-1">{onBack ? 'Viewing player profile' : 'Manage your personal information'}</p>
          </div>
        </div>
        {/* QA 2026-08-15: wrap, so Email Player / Edit Profile stack on a phone
            instead of pushing the page sideways. */}
        <div className="flex flex-wrap items-center gap-2">
          {onBack && userData.email && (userRole === 'admin' || userRole === 'coach') && (
            <button
              onClick={() => setShowEmailCompose(true)}
              className="bg-green-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-green-700 transition flex items-center space-x-2"
            >
              <Mail size={18} />
              <span>Email Player</span>
            </button>
          )}
          {/* Editable only when staff (canEditProfile) or when this is the
              viewer's own profile (no Back button = "My Profile"). */}
          {!editing && (canEditProfile || !onBack) && (
            <button
              onClick={() => setEditing(true)}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
            >
              <Edit2 size={18} />
              <span>Edit Profile</span>
            </button>
          )}
        </div>
      </div>

      {/* Profile Card */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-6">
          {/* Avatar and Name */}
          {/* QA 2026-08-15: the whole header row wraps on a phone. Previously it
              was a single non-wrapping row (avatar + name block + the Pay pill /
              attendance-rings strip), which made the entire Profile page pan
              sideways at 390px — the page #321 is about. Wrapping here rather
              than shrinking the strip: `min-w-0` on the strip made it collapse
              and its children spilled leftwards over the name. */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 mb-6 pb-6 border-b border-gray-200">
            {/* Avatar upload follows the same rule as Edit Profile: staff, or
                the viewer's own profile. Otherwise it is a plain image. */}
            <div
              className={`relative w-24 h-24 rounded-full group ${canUploadAvatar ? 'cursor-pointer' : ''}`}
              onClick={canUploadAvatar ? () => avatarInputRef.current?.click() : undefined}
            >
              {userData.avatar_url ? (
                <img src={userData.avatar_url} alt="Avatar" className="w-24 h-24 rounded-full object-cover" />
              ) : (
                <div className="w-24 h-24 bg-blue-600 rounded-full flex items-center justify-center text-white text-3xl font-bold">
                  {userData.full_name?.charAt(0) || '?'}
                </div>
              )}
              {canUploadAvatar && (
                <>
                  <div className="absolute inset-0 bg-black bg-opacity-40 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                    {uploadingAvatar ? (
                      <span className="text-white text-xs">Uploading...</span>
                    ) : (
                      <Camera className="text-white" size={24} />
                    )}
                  </div>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarUpload}
                  />
                </>
              )}
            </div>
            <div>
              {editing ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={editForm.full_name}
                    onChange={(e) => setEditForm({...editForm, full_name: e.target.value})}
                    className="text-2xl font-bold border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ) : (
                <h3 className="text-2xl font-bold text-gray-900">
                  {userData.full_name}
                  {userData.date_of_birth && (() => {
                    const age = Math.floor((new Date() - new Date(userData.date_of_birth + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
                    return <span className="text-lg font-semibold text-gray-500 ml-2">· Age {age}</span>;
                  })()}
                  {completionRate && (
                    <span
                      className={`ml-2 align-middle inline-block text-sm font-semibold px-2 py-0.5 rounded-full ${completionRate.pct >= 80 ? 'bg-green-100 text-green-700' : completionRate.pct >= 50 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}
                      title={`${completionRate.completed} of ${completionRate.scheduled} lifts and sessions marked completed in the last ${COMPLETION_WINDOW_DAYS} days`}
                    >
                      {completionRate.pct}% completed
                    </span>
                  )}
                </h3>
              )}
              <p className="text-gray-600 capitalize mt-1">{userData.role}</p>
              {userData.team_members && userData.team_members.length > 0 && (
                <TeamsList
                  teams={userData.team_members.map(tm => ({ id: tm.team_id, name: tm.teams?.name })).filter(t => t.name)}
                  onNavigateToTeam={onNavigateToTeam}
                />
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
                {profile?.sport && <span>Sport: <span className="text-gray-700 font-medium">{profile.sport}</span></span>}
                {trainerName && <span>Trainer: <span className="text-gray-700 font-medium">{trainerName}</span></span>}
                {userData.date_of_birth && (() => {
                  const age = Math.floor((new Date() - new Date(userData.date_of_birth + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
                  return <span>Age: <span className="text-gray-700 font-medium">{age}</span></span>;
                })()}
                {userData.created_at && <span>Member since: <span className="text-gray-700 font-medium">{new Date(userData.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span></span>}
              </div>
            </div>
            {/* QA 2026-08-15: this strip (Pay pill + attendance rings) is 455px
                and did not wrap, so the whole Profile page panned sideways on a
                phone — the page #321 is about. Pre-existing, fixed here. */}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
              {!onBack && (
                <button
                  onClick={() => setShowStore(true)}
                  className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition flex items-center space-x-2"
                >
                  <ShoppingBag size={18} />
                  <span>Pay</span>
                </button>
              )}
              {/* #340: coaches can now SEE this (they could already assign a
                  package, then had no way to look at what they'd assigned —
                  the pill was admin-only). Deleting stays admin-only; that is
                  enforced by canDelete on PackagesModal, not here. */}
              {(!onBack || userRole === 'admin' || userRole === 'coach') && userData.role === 'player' && (() => {
                // #340: the label now reflects EVERY assigned package, not just
                // the newest monthly subscription. "Awaiting Payment (2)" is a
                // far more useful thing to see than "No Subscription Set Up"
                // when the athlete has two assignments nobody has paid for.
                const s = subscriptionRow?.status;
                const pending = subscriptionRow?.pendingCount || 0;
                const total = subscriptionRow?.total || 0;
                // #341: who is reading this pill matters. `onBack` is only set
                // when someone is viewing SOMEBODY ELSE'S profile, so no onBack
                // means the athlete is looking at their own page — and this
                // block is rendered for them too (the gate above is
                // `!onBack || admin || coach`). Telling that athlete "Awaiting
                // Payment (3)" accuses them of owing money for packages the
                // owner has confirmed were paid in Square; the portal simply
                // never received the confirmation, because store_webhook_events
                // has been empty since June 2026. Staff still need to know the
                // portal has no payment on file — they just get wording that
                // says that, instead of wording that blames the athlete.
                const staffView = !!onBack && (userRole === 'admin' || userRole === 'coach');
                let label = 'No Package Set Up';
                let cls = 'bg-gray-100 text-gray-600 border-gray-200';
                let hint = null;
                if (s === 'active' || s === 'paid') {
                  label = total > 1 ? `Package Active (${total})` : 'Package Active';
                  cls = 'bg-green-50 text-green-700 border-green-200';
                } else if (s === 'past_due') {
                  // Square PAUSED, not an unpaid bill — see WorkStore.js. This pill
                  // is on the athlete's OWN profile, so the old orange "Payment
                  // Needs Updated" was telling a family they owed money when the
                  // subscription had simply been paused.
                  label = 'Package Paused';
                  cls = 'bg-slate-50 text-slate-700 border-slate-200';
                } else if (s === 'pending') {
                  // Neutral for the athlete ("your pack is on your account"),
                  // explicit for staff ("we have no confirmation, and that is a
                  // fact about our records, not about the athlete").
                  label = staffView
                    ? (pending > 1 ? `Payment Not Confirmed (${pending})` : 'Payment Not Confirmed')
                    : (pending > 1 ? `Package Assigned (${pending})` : 'Package Assigned');
                  hint = staffView
                    ? `${pending} package${pending === 1 ? '' : 's'} with no payment confirmed in the portal. Portal checkouts confirm themselves automatically now, but invoices sent from Square and payments taken at the desk never reach the portal — check Square before following up.`
                    : 'This package is on your account. If you paid by invoice or in person, no action is needed — those payments do not show up here automatically.';
                  cls = 'bg-yellow-50 text-yellow-700 border-yellow-200';
                } else if (total > 0) {
                  // Every row is cancelled / refunded / failed. Saying "No
                  // Package Set Up" here contradicted the tooltip, which said
                  // "2 packages assigned" — confusing for exactly the staff
                  // audience #340 is aimed at.
                  label = total > 1 ? `No Active Package (${total} past)` : 'No Active Package (1 past)';
                  cls = 'bg-gray-100 text-gray-600 border-gray-200';
                }
                // #341: the tooltip is invisible on a phone, which is where most
                // athletes read this, so the reassurance is also rendered as
                // text for the athlete's own pending case. Kept inside a single
                // column wrapper so it stays ONE flex item in the wrapping strip
                // the QA 2026-08-15 note above is about.
                const showAthleteReassurance = !staffView && s === 'pending';
                return (
                  <div className="flex flex-col items-end">
                    <button
                      onClick={() => setShowPackages(true)}
                      title={hint || (total > 0
                        ? `${total} package${total === 1 ? '' : 's'} assigned — click to see all of them`
                        : 'View all packages & sessions')}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition hover:opacity-80 ${cls}`}
                    >
                      {label} ▾
                    </button>
                    {showAthleteReassurance && (
                      <span className="mt-1 max-w-[230px] text-right text-[11px] leading-tight text-gray-500">
                        Paid by invoice or in person? No action needed — those don&apos;t show up here automatically.
                      </span>
                    )}
                  </div>
                );
              })()}
              {onBack && (userRole === 'admin' || userRole === 'coach') && userData.role === 'player' && (
                <button
                  onClick={() => setShowAssignPackage(true)}
                  className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-indigo-700 transition flex items-center space-x-1"
                >
                  <CreditCard size={14} />
                  <span>Assign Payment</span>
                </button>
              )}
              {onBack && userRole === 'admin' && userData.role === 'player' && (
                <button
                  onClick={() => setShowDiscount(true)}
                  className="bg-white border border-indigo-300 text-indigo-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-indigo-50 transition flex items-center space-x-1"
                >
                  <BadgePercent size={14} />
                  <span>Apply Discount</span>
                </button>
              )}
              {userData.role === 'player' && attendanceStats && (
                <AttendanceRings
                  practices={attendanceStats.practice}
                  games={attendanceStats.game}
                  lifts={attendanceStats.workout}
                  sessions={attendanceStats.sessions || { attended: 0, upcoming: 0 }}
                  onToggleLog={() => { setActiveProfileTab('records'); setRecordsSubTab('attendance'); }}
                  canEdit={canEditProfile}
                />
              )}
              {/* #306: staff-only, no automatic blocking — just visible so a
                  human can notice a pattern. Hidden (not "0") until the
                  cancel_reason migration has actually run.
                  The number means something stronger than it used to. When the
                  athlete pressed their own "I'm sick / injured" button this
                  counted self-declared illness; now 'sick' is only ever written
                  by an admin or coach on the Cancellations tab, so this counts
                  the ones staff agreed with. The tooltip says so, because "sick
                  cancels" on its own reads as the athlete's claim. */}
              {userData.role === 'player' && (userRole === 'admin' || userRole === 'coach') && sickCancelCount !== null && (
                <span
                  title="Cancelled sessions an admin or coach agreed were sick or injured, so the session went back to the athlete's package. Athletes cannot set this themselves. Cancellations nobody has decided on yet are not counted here — they are on the Cancellations tab in Store."
                  className="px-3 py-1 rounded-full text-xs font-medium border bg-gray-50 text-gray-600 border-gray-200"
                >
                  Sick cancels: {sickCancelCount}
                </span>
              )}
            </div>
          </div>

          {profile && (
            <div className="mb-6 pb-6 border-b border-gray-200">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Sport</p>
                  <div className="border-t border-gray-200 pt-3">
                    <div className="relative" ref={sportDropdownRef}>
                      <button
                        type="button"
                        onClick={() => canEditProfile && setSportDropdownOpen(o => !o)}
                        disabled={!canEditProfile}
                        className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-left truncate focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white ${!canEditProfile ? 'opacity-75 cursor-not-allowed text-gray-500' : 'text-gray-900'}`}
                      >
                        {sportInput || <span className="text-gray-400">Select sports</span>}
                      </button>
                      {sportDropdownOpen && (
                        <div className="absolute z-20 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                          {SPORT_OPTIONS.map(sport => {
                            const selected = sportInput.split(',').map(s => s.trim()).filter(Boolean).includes(sport);
                            return (
                              <label key={sport} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm text-gray-900">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => {
                                    const current = sportInput.split(',').map(s => s.trim()).filter(Boolean);
                                    const next = selected ? current.filter(s => s !== sport) : [...current, sport];
                                    const newVal = next.join(', ');
                                    setSportInput(newVal);
                                    handleDropdownChange('sport', newVal);
                                  }}
                                />
                                {sport}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Program</p>
                  <div className="border-t border-gray-200 pt-3">
                    <select
                      value={profile.program || ''}
                      onChange={(e) => handleDropdownChange('program', e.target.value)}
                      disabled={!canEditProfile}
                      className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white ${!canEditProfile ? 'opacity-75 cursor-not-allowed' : ''}`}
                    >
                      <option value="">No Program</option>
                      {PROGRAM_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Level</p>
                  <div className="border-t border-gray-200 pt-3">
                    <select
                      value={profile.level || ''}
                      onChange={(e) => handleDropdownChange('level', e.target.value)}
                      disabled={!canEditProfile}
                      className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white ${!canEditProfile ? 'opacity-75 cursor-not-allowed' : ''}`}
                    >
                      <option value="">No Level</option>
                      {LEVEL_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Status</p>
                  <div className="border-t border-gray-200 pt-3">
                    <select
                      value={profile.status || ''}
                      onChange={(e) => handleDropdownChange('status', e.target.value)}
                      disabled={!canEditProfile}
                      className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white ${!canEditProfile ? 'opacity-75 cursor-not-allowed' : ''}`}
                    >
                      <option value="">No Status</option>
                      {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-3">Trainer</p>
                  <div className="border-t border-gray-200 pt-3">
                    <select
                      value={profile.trainer_id || ''}
                      onChange={(e) => handleDropdownChange('trainer_id', e.target.value)}
                      disabled={!canEditProfile}
                      className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white ${!canEditProfile ? 'opacity-75 cursor-not-allowed' : ''}`}
                    >
                      <option value="">No Trainer</option>
                      {allCoaches.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab Bar */}
          <div className="border-b border-gray-200 mb-6 -mx-2 px-2">
            <nav className="flex flex-wrap gap-1 pb-2 min-w-0">
              {PROFILE_TABS.filter(tab => {
                // Athlete privacy, belt-and-braces: a player looking at anyone
                // other than themselves gets no tabs at all. The early return at
                // the top of this component means we should never get here, but
                // if a future edit removes it this filter still fails closed.
                if (userRole === 'player' && loggedInUserId !== userId) return false;
                // #226: age-gate sensitive tabs, fail-closed — hidden when the viewed
                // athlete's DOB is missing or under the threshold.
                // Staff (admin/coach) bypass the gate so they can always manage recruitment.
                // Marek (18+) is now a Health sub-tab and gated there (#376).
                if (tab.key === 'recruitment' && !['admin', 'coach'].includes(userRole) && !meetsAge(userData?.date_of_birth, 15)) return false;
                // Players get a read-only Schedule tab (calendar + their programming,
                // merged per #226) on their OWN profile so they can see what's
                // programmed for them (#153). Staff keep it via tab.roles below.
                if (tab.key === 'schedule' && userRole === 'player') return loggedInUserId === userId;
                // #450: WHOOP (#154: a player connects their OWN WHOOP on their own
                // profile) now lives inside Technology, which has no role gate; the
                // player-on-someone-else case is already refused at the top.
                // Players can view their OWN recruitment entries (#216) — subject to the 15+ gate above.
                if (tab.key === 'recruitment' && userRole === 'player') return loggedInUserId === userId;
                // #376: the Practice Stats exception used to sit here — "a player
                // may see this tab, but only on their own profile" (#278). Practice
                // Stats is no longer a top-level tab, so this line could never fire
                // again; it is not dropped, it MOVED, to the `playerSelf` flag on
                // RECORDS_SUB_TABS and the visibleRecordsSubTabs filter. Leaving a
                // dead permission test in a live permission filter is how the next
                // person re-adds the tab and thinks it is already covered.
                if (tab.roles && !tab.roles.includes(userRole)) return false;
                if (tab.viewedRoles && (!userData || !tab.viewedRoles.includes(userData.role))) return false;
                return true;
              }).map(tab => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setActiveProfileTab(tab.key);
                  }}
                  className={`min-h-[40px] py-2.5 px-3.5 rounded-lg font-medium text-sm md:text-xs md:py-2 md:px-3 text-center transition whitespace-nowrap touch-manipulation ${
                    activeProfileTab === tab.key
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* #370: Records sub-nav. Deliberately lighter than the main tab bar
              above it — smaller, rounded-full, outlined rather than filled — so
              it reads as a level below. flex-wrap, as per the #321 QA notes, so
              it stacks instead of panning sideways on a 390px phone. */}
          {/* #463: Stats sub-nav, same styling as Records. */}
          {activeProfileTab === 'stats' && visibleStatsSubTabs.length > 1 && (
            <nav className="flex flex-wrap gap-1.5 mb-5 min-w-0">
              {visibleStatsSubTabs.map(sub => (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => setStatsSubTab(sub.key)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-full border text-xs font-medium transition whitespace-nowrap touch-manipulation ${
                    activeStatsSubTab === sub.key
                      ? 'bg-white border-blue-300 text-blue-700 shadow-sm'
                      : 'bg-transparent border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </nav>
          )}

          {activeProfileTab === 'records' && (
            <nav className="flex flex-wrap gap-1.5 mb-5 min-w-0">
              {visibleRecordsSubTabs.map(sub => (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => setRecordsSubTab(sub.key)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-full border text-xs font-medium transition whitespace-nowrap touch-manipulation ${
                    activeRecordsSubTab === sub.key
                      ? 'bg-white border-blue-300 text-blue-700 shadow-sm'
                      : 'bg-transparent border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </nav>
          )}

          {/* #369: Health sub-nav. Same lighter styling and same flex-wrap as
              the Records sub-nav above, so both stack rather than pan sideways
              on a 390px phone (#321).
              #376: Mental Training opens a modal; Marek is staff-only + 18+. */}
          {activeProfileTab === 'health' && (
            <nav className="flex flex-wrap gap-1.5 mb-5 min-w-0">
              {HEALTH_SUB_TABS.filter(sub => {
                if (sub.staffOnly && !canSeeNotes) return false;
                if (sub.key === 'marek' && !meetsAge(userData?.date_of_birth, 18)) return false;
                return true;
              }).map(sub => (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => {
                    if (sub.key === 'mental') { setShowMentalTraining(true); return; }
                    setHealthSubTab(sub.key);
                  }}
                  className={`min-h-[36px] px-3 py-1.5 rounded-full border text-xs font-medium transition whitespace-nowrap touch-manipulation ${
                    activeHealthSubTab === sub.key
                      ? 'bg-white border-blue-300 text-blue-700 shadow-sm'
                      : 'bg-transparent border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </nav>
          )}

          {/* #450: Technology sub-nav, same lighter styling as Records/Health. */}
          {activeProfileTab === 'technology' && (
            <nav className="flex flex-wrap gap-1.5 mb-5 min-w-0">
              {TECH_SUB_TABS.map(sub => (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => setTechSubTab(sub.key)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-full border text-xs font-medium transition whitespace-nowrap touch-manipulation ${
                    activeTechSubTab === sub.key
                      ? 'bg-white border-blue-300 text-blue-700 shadow-sm'
                      : 'bg-transparent border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </nav>
          )}

          {activeProfileTab === 'technology' && TECH_SUB_TABS.find(sub => sub.key === activeTechSubTab)?.comingSoon && (
            <div className="py-12 text-center">
              <p className="text-gray-700 text-lg font-medium">
                {TECH_SUB_TABS.find(sub => sub.key === activeTechSubTab).label} is coming soon
              </p>
              <p className="text-gray-500 text-sm mt-1">Session data will show here once the integration is connected.</p>
            </div>
          )}

          {!PROFILE_TABS_WITH_CONTENT.includes(activeProfileTab) && (
            <div className="py-12 text-center">
              <p className="text-gray-500 text-lg">Coming Soon</p>
            </div>
          )}

          {activeProfileTab === 'athletes' && (
            <div className="space-y-6">
              {coachAthletes.length === 0 ? (
                <div className="py-12 text-center">
                  <Users className="mx-auto mb-3 text-gray-300" size={48} />
                  <p className="text-gray-500">No athletes assigned yet.</p>
                  <p className="text-gray-400 text-sm mt-1">Athletes will appear here once team assignments or trainer assignments are made.</p>
                </div>
              ) : (
                coachAthletes.map(team => (
                  <div key={team.teamId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                      <h3 className="font-semibold text-gray-900">{team.teamName}</h3>
                      <p className="text-xs text-gray-500">{team.members.length} athlete{team.members.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {team.members.map(athlete => (
                        <div key={athlete.id} className="px-4 py-3 flex items-center space-x-3 hover:bg-gray-50">
                          {athlete.avatar_url ? (
                            <img src={athlete.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                          ) : (
                            <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold">
                              {athlete.full_name?.charAt(0) || '?'}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{athlete.full_name}</p>
                            {athlete.email && <p className="text-xs text-gray-500 truncate">{athlete.email}</p>}
                          </div>
                          {onNavigateToProfile && (
                            <button
                              onClick={() => onNavigateToProfile(athlete.id)}
                              className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                            >
                              View Profile
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeProfileTab === 'technology' && activeTechSubTab === 'whoop' && (
            <WhoopTab userId={userId} userRole={userRole} loggedInUserId={loggedInUserId} athleteName={userData?.full_name} />
          )}

          {activeProfileTab === 'technology' && activeTechSubTab === 'trackman' && (
            <TrackmanTab userId={userId} userRole={userRole} loggedInUserId={loggedInUserId} />
          )}

          {activeProfileTab === 'stats' && activeStatsSubTab === 'external' && (
            <ExternalStatsTab userId={userId} loggedInUserId={loggedInUserId} userRole={userRole} />
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'attendance' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'practice', label: 'Practices', color: 'bg-green-100 text-green-700' },
                  { value: 'game', label: 'Games', color: 'bg-blue-100 text-blue-700' },
                  { value: 'workout', label: 'Lifts', color: 'bg-amber-100 text-amber-700' },
                  { value: 'session', label: 'Sessions', color: 'bg-purple-100 text-purple-700' },
                ].map(f => (
                  <button
                    key={f.value}
                    onClick={() => setAttendanceFilter(f.value)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                      attendanceFilter === f.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                {attendanceFilter !== 'session' && (
                  <>
                    {attendanceEvents
                      .filter(ev => attendanceFilter === 'all' || ev.event_type === attendanceFilter)
                      .length === 0 && (
                      <p className="text-sm text-gray-500 italic text-center py-8">No past events found.</p>
                    )}
                    {attendanceEvents
                      .filter(ev => attendanceFilter === 'all' || ev.event_type === attendanceFilter)
                      .map(ev => {
                        const rec = attendanceMap[ev.id];
                        const currentStatus = rec?.status || null;
                        const isSaving = savingAttendance[ev.id];
                        const typeBadge = ev.event_type === 'practice'
                          ? 'bg-green-100 text-green-700'
                          : ev.event_type === 'game'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-amber-100 text-amber-700';
                        const typeLabel = ev.event_type === 'practice' ? 'Practice' : ev.event_type === 'game' ? 'Game' : 'Lift';
                        const displayName = ev.title || ev.opponent || typeLabel;
                        const dateStr = new Date(ev.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                        return (
                          <div key={ev.id} className="flex items-center justify-between border border-gray-200 rounded-lg p-3">
                            <div className="flex items-center space-x-3 min-w-0">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${typeBadge}`}>{typeLabel}</span>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{displayName}</p>
                                <p className="text-xs text-gray-500">{dateStr}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-1 flex-shrink-0">
                              <button
                                onClick={() => handleMarkAttendance(ev.id, 'present')}
                                disabled={isSaving}
                                className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                                  currentStatus === 'present'
                                    ? 'bg-green-600 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-green-100 hover:text-green-700'
                                } disabled:opacity-50`}
                              >
                                Present
                              </button>
                              <button
                                onClick={() => handleMarkAttendance(ev.id, 'absent')}
                                disabled={isSaving}
                                className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                                  currentStatus === 'absent'
                                    ? 'bg-red-600 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-red-100 hover:text-red-700'
                                } disabled:opacity-50`}
                              >
                                Absent
                              </button>
                              <button
                                onClick={() => handleMarkAttendance(ev.id, 'excused')}
                                disabled={isSaving}
                                className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                                  currentStatus === 'excused'
                                    ? 'bg-yellow-500 text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-yellow-100 hover:text-yellow-700'
                                } disabled:opacity-50`}
                              >
                                Excused
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </>
                )}
                {attendanceFilter === 'session' && (
                  sessionReservations.length === 0 ? (
                    <p className="text-sm text-gray-500 italic text-center py-8">No sessions found.</p>
                  ) : (
                    <>
                      <div className="flex items-center space-x-3 px-3 py-2 bg-purple-50 rounded-lg text-sm">
                        <span className="text-purple-700 font-medium">
                          {sessionReservations.filter(r => r.slot_date < fmtLocalDate(new Date()) && (r.attendance === 'present' || r.attendance === 'late')).length} attended
                        </span>
                        <span className="text-gray-400">·</span>
                        <span className="text-blue-600 font-medium">
                          {sessionReservations.filter(r => r.slot_date >= fmtLocalDate(new Date())).length} upcoming
                        </span>
                      </div>
                      {sessionReservations.map(r => {
                        const slot = r.training_slots;
                        const today = fmtLocalDate(new Date());
                        const isFuture = r.slot_date >= today;
                        const dateStr = new Date(r.slot_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                        const timeStr = slot?.start_time ? (() => {
                          const [h, m] = slot.start_time.split(':').map(Number);
                          return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
                        })() : null;
                        const attBadge = r.attendance === 'present' ? 'bg-green-100 text-green-700'
                          : r.attendance === 'late' ? 'bg-yellow-100 text-yellow-700'
                          : r.attendance === 'no_show' ? 'bg-red-100 text-red-700'
                          : isFuture ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-500';
                        const attLabel = r.attendance === 'present' ? 'Present'
                          : r.attendance === 'late' ? 'Late'
                          : r.attendance === 'no_show' ? 'No Show'
                          : isFuture ? (r.status === 'confirmed' ? 'Confirmed' : 'Pending')
                          : 'No Record';
                        return (
                          <div key={r.id} className="flex items-center justify-between border border-gray-200 rounded-lg p-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900">{dateStr}{timeStr ? ` · ${timeStr}` : ''}</p>
                              {slot?.notes && (
                                <p className="text-xs text-gray-500 truncate">
                                  {slot.notes.split('--- Exercises ---')[0].trim().split('\n')[0]}
                                </p>
                              )}
                            </div>
                            <span className={`ml-3 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 ${attBadge}`}>{attLabel}</span>
                          </div>
                        );
                      })}
                    </>
                  )
                )}
              </div>
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'assessment' && (
            <div className="space-y-6">
              {/* Assessment Templates */}
              {assessmentTemplates.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center space-x-2">
                    <ClipboardList size={16} className="text-gray-400" />
                    <span>Available Assessments</span>
                  </h4>
                  <div className="space-y-2">
                    {assessmentTemplates.map(template => {
                      const completedCount = assessmentSubmissions.filter(s => s.template_id === template.id).length;
                      const latestSub = assessmentSubmissions.find(s => s.template_id === template.id);
                      const canSubmit = userRole === 'admin' || userRole === 'coach';
                      // #456: a reassessment is always a new blank, dated
                      // submission; the earlier ones are kept and trended.
                      const trendKey = `trend-${template.id}`;
                      return (
                        <div key={template.id} className="border border-gray-200 rounded-lg overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3">
                            <div className="flex items-center space-x-3">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${completedCount > 0 ? 'bg-blue-100' : 'bg-gray-100'}`}>
                                <ClipboardList size={16} className={completedCount > 0 ? 'text-blue-600' : 'text-gray-400'} />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-gray-900">{template.name}</p>
                                <p className="text-xs text-gray-500">
                                  {completedCount > 0 ? `${completedCount} completed submission${completedCount !== 1 ? 's' : ''}` : 'No submissions yet'}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-2">
                              {canSubmit && (
                                <button
                                  onClick={() => setAssessmentFormTemplate(template)}
                                  className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center space-x-1"
                                >
                                  <Plus size={14} />
                                  <span>{completedCount > 0 ? 'Reassess' : 'Submit'}</span>
                                </button>
                              )}
                              {completedCount >= 2 && (
                                <button
                                  onClick={() => setExpandedSubmission(expandedSubmission === trendKey ? null : trendKey)}
                                  className="text-sm text-gray-500 hover:text-gray-700 font-medium flex items-center space-x-1"
                                >
                                  <TrendingUp size={14} />
                                  <span>Trends</span>
                                </button>
                              )}
                              {latestSub && (
                                <button
                                  onClick={() => {
                                    const expanding = expandedSubmission !== latestSub.id;
                                    setExpandedSubmission(expanding ? latestSub.id : null);
                                    if (expanding) fetchAgeGroupAverages(latestSub.template_id, latestSub.assessment_templates?.schema || []);
                                  }}
                                  className="text-sm text-gray-500 hover:text-gray-700 font-medium flex items-center space-x-1"
                                >
                                  <Eye size={14} />
                                  <span>View Latest</span>
                                </button>
                              )}
                            </div>
                          </div>
                          {latestSub && expandedSubmission === latestSub.id && (
                            <div className="border-t border-gray-200 p-4 bg-gray-50">
                              <div className="text-xs text-gray-500 mb-3">
                                {latestSub.assessment_date} &middot; Assessed by {latestSub.assessor?.full_name || 'Unknown'}
                              </div>
                              {ageGroupAverages[latestSub.template_id] && (
                                <p className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded px-3 py-1.5 mb-3">
                                  Showing averages for age group {ageGroupAverages[latestSub.template_id].bracket} (n={ageGroupAverages[latestSub.template_id].sampleSize})
                                </p>
                              )}
                              <SubmissionView submission={latestSub} ageGroupData={ageGroupAverages[latestSub.template_id]} />
                            </div>
                          )}
                          {expandedSubmission === trendKey && (
                            <div className="border-t border-gray-200 p-4 bg-gray-50">
                              <p className="text-xs text-gray-500 mb-3">
                                {completedCount} assessments, first to latest. Each change is against the previous assessment that recorded that number.
                              </p>
                              <AssessmentTrends
                                schema={template.schema || latestSub?.assessment_templates?.schema || []}
                                submissions={assessmentSubmissions.filter(s => s.template_id === template.id)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* All Completed Submissions */}
              {assessmentSubmissions.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center space-x-2">
                    <CheckCircle size={16} className="text-gray-400" />
                    <span>Completed Assessments ({assessmentSubmissions.length})</span>
                  </h4>
                  <div className="space-y-2">
                    {assessmentSubmissions.map(sub => (
                      <div key={sub.id} className="border border-gray-200 rounded-lg overflow-hidden">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            const expanding = expandedSubmission !== sub.id;
                            setExpandedSubmission(expanding ? sub.id : null);
                            if (expanding) fetchAgeGroupAverages(sub.template_id, sub.assessment_templates?.schema || []);
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
                          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition text-left cursor-pointer"
                        >
                          <div className="flex items-center space-x-3">
                            <CheckCircle size={16} className="text-green-500" />
                            <div>
                              <p className="text-sm font-medium text-gray-900">{sub.assessment_templates?.name || 'Assessment'}</p>
                              <p className="text-xs text-gray-500">
                                {sub.assessment_date} &middot; Assessed by {sub.assessor?.full_name || 'Unknown'}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            {canEditProfile && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteAssessment(sub.id); }}
                                className="p-1 text-gray-400 hover:text-red-600 transition"
                                title="Delete this assessment"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                            {expandedSubmission === sub.id ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                          </div>
                        </div>
                        {expandedSubmission === sub.id && (
                          <div className="border-t border-gray-200 p-4 bg-gray-50">
                            {ageGroupAverages[sub.template_id] && (
                              <p className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded px-3 py-1.5 mb-3">
                                Showing averages for age group {ageGroupAverages[sub.template_id].bracket} (n={ageGroupAverages[sub.template_id].sampleSize})
                              </p>
                            )}
                            <SubmissionView submission={sub} ageGroupData={ageGroupAverages[sub.template_id]} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {assessmentTemplates.length === 0 && assessmentSubmissions.length === 0 && (
                <div className="text-center py-8">
                  <ClipboardList size={40} className="mx-auto mb-3 text-gray-300" />
                  <p className="text-gray-500">No assessments available yet.</p>
                </div>
              )}
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'goals' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {[
                { type: 'short_term', label: 'Short-Term Goals' },
                { type: 'long_term', label: 'Long-Term Goals' },
              ].map(({ type, label }) => {
                const items = goals.filter(g => g.goal_type === type);
                return (
                  <div key={type}>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-lg font-semibold text-gray-900">{label}</h4>
                      <button
                        type="button"
                        onClick={() => addGoal(type)}
                        className="bg-blue-600 text-white px-3 py-2 min-h-[40px] rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm touch-manipulation"
                      >
                        <Plus size={14} />
                        <span>Add</span>
                      </button>
                    </div>
                    {editingGoalId === 'new' && goalDraft.goal_type === type && (
                      <div className="border border-blue-300 rounded-lg p-3 mb-3 bg-blue-50">
                        <textarea
                          value={goalDraft.content}
                          onChange={(e) => setGoalDraft({ ...goalDraft, content: e.target.value })}
                          placeholder={`What's a ${label.toLowerCase().replace(' goals', ' goal')}?`}
                          rows={3}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        />
                        <div className="flex justify-end space-x-2 mt-2">
                          <button type="button" onClick={cancelEditGoal} className="px-3 py-2 min-h-[40px] border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm touch-manipulation">Cancel</button>
                          <button type="button" onClick={saveGoal} disabled={savingGoal || !goalDraft.content.trim()} className="px-3 py-2 min-h-[40px] bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm touch-manipulation">
                            {savingGoal ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      {items.length === 0 && editingGoalId !== 'new' && (
                        <p className="text-sm text-gray-500 italic">No {label.toLowerCase()} yet.</p>
                      )}
                      {items.map(goal => (
                        <div key={goal.id} className="border border-gray-200 rounded-lg p-3">
                          {editingGoalId === goal.id ? (
                            <>
                              <textarea
                                value={goalDraft.content}
                                onChange={(e) => setGoalDraft({ ...goalDraft, content: e.target.value })}
                                rows={3}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                              />
                              <div className="flex justify-end space-x-2 mt-2">
                                <button type="button" onClick={cancelEditGoal} className="px-3 py-2 min-h-[40px] border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm touch-manipulation">Cancel</button>
                                <button type="button" onClick={saveGoal} disabled={savingGoal || !goalDraft.content.trim()} className="px-3 py-2 min-h-[40px] bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm touch-manipulation">
                                  {savingGoal ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="flex justify-between items-start">
                              <p className="text-sm text-gray-800 whitespace-pre-wrap flex-1">{goal.content}</p>
                              <div className="flex items-center space-x-1 ml-3 flex-shrink-0">
                                <button onClick={() => startEditGoal(goal)} className="text-gray-400 hover:text-blue-600 transition" title="Edit">
                                  <Edit2 size={14} />
                                </button>
                                <button onClick={() => deleteGoal(goal.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'notes' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-2">
                  {[{ value: 'all', label: 'All' }, ...NOTE_CATEGORIES]
                    // #422: athletes never receive Disciplinary rows, so don't offer the chip.
                    .filter(cat => canSeeNotes || cat.value !== 'disciplinary')
                    .map(cat => (
                    <button
                      key={cat.value}
                      onClick={() => { setNoteFilter(cat.value); if (cat.value !== 'mechanics') setNoteAreaFilter(''); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                        noteFilter === cat.value
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                  {noteFilter === 'mechanics' && (
                    <select
                      value={noteAreaFilter}
                      onChange={(e) => setNoteAreaFilter(e.target.value)}
                      className="px-2.5 py-1 rounded-full text-xs font-medium border border-amber-300 bg-amber-50 text-amber-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      title="Mechanics area"
                    >
                      <option value="">All areas</option>
                      {MECHANICS_AREAS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  )}
                </div>
                {canSeeNotes && (
                  <button
                    onClick={startNewNote}
                    className="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm"
                  >
                    <Plus size={14} />
                    <span>Add Note</span>
                  </button>
                )}
              </div>

              {editingNoteId === 'new' && (
                <div className="border border-blue-300 rounded-lg p-4 bg-blue-50">
                  <NoteEditor
                    draft={noteDraft}
                    setDraft={setNoteDraft}
                    addPitch={addDraftPitch}
                    updatePitch={updateDraftPitch}
                    removePitch={removeDraftPitch}
                  />
                  <div className="flex justify-end space-x-2 mt-3">
                    <button onClick={cancelEditNote} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
                    <button onClick={saveNote} disabled={savingNote} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
                      {savingNote ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {playerNotes
                  .filter(noteMatchesFilter)
                  .length === 0 && editingNoteId !== 'new' && (
                  <p className="text-sm text-gray-500 italic text-center py-6">No notes yet.</p>
                )}
                {playerNotes
                  .filter(noteMatchesFilter)
                  .map(note => {
                    const catInfo = noteCategoryInfo(note.category);
                    const areaLabel = noteArea(note) ? mechanicsAreaLabel(noteArea(note)) : '';
                    const flagged = Array.isArray(note.deficiencies) ? note.deficiencies : [];
                    const canModify = canSeeNotes && (note.created_by === loggedInUserId || userRole === 'admin');
                    return (
                      <div key={note.id} className="border border-gray-200 rounded-lg p-4">
                        {editingNoteId === note.id ? (
                          <>
                            <NoteEditor
                              draft={noteDraft}
                              setDraft={setNoteDraft}
                              addPitch={addDraftPitch}
                              updatePitch={updateDraftPitch}
                              removePitch={removeDraftPitch}
                            />
                            <div className="flex justify-end space-x-2 mt-3">
                              <button onClick={cancelEditNote} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
                              <button onClick={saveNote} disabled={savingNote} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
                                {savingNote ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center space-x-2 flex-wrap">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${catInfo.color}`}>{catInfo.label}</span>
                                {areaLabel && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200">{areaLabel}</span>}
                                {note.context && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">{note.context}</span>}
                                <span className="text-xs text-gray-500">{note.author?.full_name || 'Unknown'}</span>
                                <span className="text-xs text-gray-400">{new Date(note.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                              </div>
                              {canModify && (
                                <div className="flex items-center space-x-1">
                                  <button onClick={() => startEditNote(note)} className="text-gray-400 hover:text-blue-600 transition" title="Edit">
                                    <Edit2 size={14} />
                                  </button>
                                  <button onClick={() => deleteNote(note.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              )}
                            </div>
                            {flagged.length > 0 && (
                              <div className="mb-2 space-y-1">
                                {flagged.map((d, i) => {
                                  // Drills/link come from src/mechanicsDeficiencies.js, not the row.
                                  const info = mechanicsDeficiencyInfo(noteArea(note), d);
                                  return (
                                    <div key={i} className="text-xs leading-5">
                                      <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">{d}</span>
                                      {info && (
                                        <span className="text-gray-600 ml-2">
                                          {info.drills}
                                          {info.link?.url && (
                                            <> · <a href={info.link.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{info.link.label}</a></>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {note.content && <p className="text-sm text-gray-800 whitespace-pre-wrap">{note.content}</p>}
                            {Array.isArray(note.pitches) && note.pitches.length > 0 && (
                              <div className="mt-2 overflow-x-auto">
                                <table className="w-full text-xs border-collapse">
                                  <thead className="bg-gray-50">
                                    <tr>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide w-8">#</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Pitch</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Location</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Result</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Notes</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {note.pitches.map((p, i) => (
                                      <tr key={i} className="border-t border-gray-100">
                                        <td className="px-2 py-1 text-gray-500">{i + 1}</td>
                                        <td className="px-2 py-1 text-gray-900">{p.pitch_type || '—'}</td>
                                        <td className="px-2 py-1 text-gray-700">{p.location || '—'}</td>
                                        <td className="px-2 py-1 text-gray-700">{p.result || '—'}</td>
                                        <td className="px-2 py-1 text-gray-600">{p.notes || ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {note.updated_at && note.updated_at !== note.created_at && (
                              <p className="text-xs text-gray-400 mt-2 italic">Edited {new Date(note.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {activeProfileTab === 'health' && activeHealthSubTab === 'pt' && (
            <div className="space-y-6">
              {/* PT Status */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center space-x-3">
                    <h4 className="text-sm font-semibold text-gray-700">PT Status:</h4>
                    {userData?._profile?.pt_status ? (
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold ${PT_STATUS_COLORS[userData._profile.pt_status] || 'bg-gray-100 text-gray-700'}`}>
                        {userData._profile.pt_status}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500 italic">Not set</span>
                    )}
                  </div>
                  {(userRole === 'admin' || userRole === 'coach') && (
                    <select
                      value={userData?._profile?.pt_status || ''}
                      onChange={(e) => updatePtStatus(e.target.value)}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="">Not set</option>
                      {PT_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Powered by NBP × LW Physical Therapy. Logging visits helps track development, recovery, and onboarding history.
                </p>
              </div>

              {/* #454: PT Recovery Engine progress checks (staff log, athlete reads own) */}
              <PtProgressChecks
                playerId={userId}
                canEdit={userRole === 'admin' || userRole === 'coach'}
                currentUserId={loggedInUserId}
              />

              {/* Add Visit Button */}
              {(userRole === 'admin' || userRole === 'coach') && editingPtVisitId !== 'new' && (
                <div className="flex justify-between items-center">
                  <h4 className="text-sm font-semibold text-gray-700">Visit Log ({ptVisits.length})</h4>
                  <button
                    onClick={startNewPtVisit}
                    className="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm"
                  >
                    <Plus size={14} />
                    <span>Add Visit</span>
                  </button>
                </div>
              )}

              {/* New Visit Form */}
              {editingPtVisitId === 'new' && (
                <div className="border border-blue-300 rounded-lg p-4 bg-blue-50">
                  <PtVisitEditor
                    draft={ptDraft}
                    setDraft={setPtDraft}
                    addExercise={addPtExercise}
                    updateExercise={updatePtExercise}
                    removeExercise={removePtExercise}
                  />
                  <div className="flex justify-end space-x-2 mt-3">
                    <button onClick={cancelEditPtVisit} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
                    <button onClick={savePtVisit} disabled={savingPtVisit} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
                      {savingPtVisit ? 'Saving...' : 'Save Visit'}
                    </button>
                  </div>
                </div>
              )}

              {/* Visit List */}
              {ptVisits.length === 0 && editingPtVisitId !== 'new' && (
                <div className="text-center py-10 text-gray-500">
                  <p className="text-sm">No PT visits logged yet.</p>
                </div>
              )}
              <div className="space-y-3">
                {ptVisits.map(v => {
                  const canModify = (userRole === 'admin' || userRole === 'coach');
                  return (
                    <div key={v.id} className="border border-gray-200 rounded-lg p-4">
                      {editingPtVisitId === v.id ? (
                        <>
                          <PtVisitEditor
                            draft={ptDraft}
                            setDraft={setPtDraft}
                            addExercise={addPtExercise}
                            updateExercise={updatePtExercise}
                            removeExercise={removePtExercise}
                          />
                          <div className="flex justify-end space-x-2 mt-3">
                            <button onClick={cancelEditPtVisit} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
                            <button onClick={savePtVisit} disabled={savingPtVisit} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
                              {savingPtVisit ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-start justify-between mb-2 flex-wrap gap-2">
                            <div className="flex items-center space-x-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-900">
                                {v.visit_date ? new Date(v.visit_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                              </span>
                              {v.visit_type && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">{v.visit_type}</span>}
                              {v.body_area && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">{v.body_area}</span>}
                              {v.pain_level != null && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Pain {v.pain_level}/10</span>}
                              <span className="text-xs text-gray-500">{v.author?.full_name || 'Unknown'}</span>
                            </div>
                            {canModify && (
                              <div className="flex items-center space-x-1">
                                <button onClick={() => startEditPtVisit(v)} className="text-gray-400 hover:text-blue-600 transition" title="Edit">
                                  <Edit2 size={14} />
                                </button>
                                <button onClick={() => deletePtVisit(v.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                          {v.content && <p className="text-sm text-gray-800 whitespace-pre-wrap">{v.content}</p>}
                          {Array.isArray(v.exercises) && v.exercises.length > 0 && (
                            <>
                              {/* #321: below sm this 4-column table squeezed Exercise and
                                  Notes into ~85px each (Sets/Reps hold fixed w-20), so the
                                  athlete's home-plan numbers wrapped one character per line.
                                  Stack as labelled cards on a phone; table unchanged at sm+. */}
                              <div className="sm:hidden mt-2 space-y-2">
                                {v.exercises.map((ex, i) => (
                                  <div key={i} className="border border-gray-200 rounded-lg p-2.5 bg-white">
                                    <div className="text-sm font-medium text-gray-900 break-words">{ex.name || '—'}</div>
                                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                                      {[['Sets', ex.sets], ['Reps', ex.reps]].map(([label, value]) => (
                                        <span key={label} className="inline-flex items-baseline gap-1">
                                          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
                                          <span className={`font-semibold tabular-nums ${value ? 'text-gray-900' : 'text-gray-400'}`}>{value || '—'}</span>
                                        </span>
                                      ))}
                                    </div>
                                    {ex.notes && <div className="mt-1 text-xs text-gray-600 break-words">{ex.notes}</div>}
                                  </div>
                                ))}
                              </div>
                              <div className="hidden sm:block mt-2 overflow-x-auto">
                                <table className="w-full text-xs border-collapse">
                                  <thead className="bg-gray-50">
                                    <tr>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Exercise</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide w-20">Sets</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide w-20">Reps</th>
                                      <th className="text-left px-2 py-1 font-semibold text-gray-600 uppercase tracking-wide">Notes</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {v.exercises.map((ex, i) => (
                                      <tr key={i} className="border-t border-gray-100">
                                        <td className="px-2 py-1 text-gray-900">{ex.name || '—'}</td>
                                        <td className="px-2 py-1 text-gray-700">{ex.sets || '—'}</td>
                                        <td className="px-2 py-1 text-gray-700">{ex.reps || '—'}</td>
                                        <td className="px-2 py-1 text-gray-600">{ex.notes || ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                          {v.follow_up_at && (
                            <p className="text-xs text-blue-700 mt-2">
                              Follow-up: {new Date(v.follow_up_at + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeProfileTab === 'health' && activeHealthSubTab === 'armcare' && (
            <div>
              {/* #369: Cordell asked for the seven routine buttons to become a
                  drop-down. The option VALUES are the Title Case strings that go
                  into routine_type and that existing rows are displayed from —
                  only the visible label reads "Starter Routine". Add is disabled
                  until something other than the placeholder is picked. */}
              <div className="flex flex-wrap items-center gap-2 mb-6 min-w-0">
                <select
                  value={routineTypeChoice}
                  onChange={(e) => setRoutineTypeChoice(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose a routine…</option>
                  {ARM_CARE_ROUTINE_TYPES.map(type => (
                    <option key={type} value={type}>{type} Routine</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => addArmCareRoutine(routineTypeChoice)}
                  disabled={!routineTypeChoice}
                  className="bg-blue-600 text-white px-3 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={14} />
                  <span>Add Routine</span>
                </button>
              </div>

              {editingRoutineId === 'new' && (
                <div className="border border-blue-300 rounded-lg p-4 mb-4 bg-blue-50">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-semibold text-blue-900">New {routineDraft.routine_type} Routine</span>
                  </div>
                  <input
                    type="text"
                    value={routineDraft.title}
                    onChange={(e) => setRoutineDraft({ ...routineDraft, title: e.target.value })}
                    placeholder="Routine title"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                  <textarea
                    value={routineDraft.content}
                    onChange={(e) => setRoutineDraft({ ...routineDraft, content: e.target.value })}
                    placeholder="Describe the routine in detail..."
                    rows={8}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                  <div className="flex justify-end space-x-2 mt-3">
                    <button
                      onClick={cancelEditRoutine}
                      className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveRoutine}
                      disabled={savingRoutine}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm"
                    >
                      {savingRoutine ? 'Saving...' : 'Save Routine'}
                    </button>
                  </div>
                </div>
              )}

              {armCareRoutines.length === 0 && editingRoutineId !== 'new' && (
                <div className="text-center py-8 text-gray-500">
                  <p>No routines yet. Choose a routine above and click Add Routine.</p>
                </div>
              )}

              <div className="space-y-3">
                {armCareRoutines.map(routine => (
                  <div key={routine.id} className="border border-gray-200 rounded-lg p-4">
                    {editingRoutineId === routine.id ? (
                      <>
                        <span className="text-xs font-semibold text-blue-700 bg-blue-100 rounded px-2 py-0.5">{routine.routine_type}</span>
                        <input
                          type="text"
                          value={routineDraft.title}
                          onChange={(e) => setRoutineDraft({ ...routineDraft, title: e.target.value })}
                          placeholder="Routine title"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 mt-2 mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        />
                        <textarea
                          value={routineDraft.content}
                          onChange={(e) => setRoutineDraft({ ...routineDraft, content: e.target.value })}
                          placeholder="Describe the routine in detail..."
                          rows={8}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        />
                        <div className="flex justify-end space-x-2 mt-3">
                          <button onClick={cancelEditRoutine} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm">Cancel</button>
                          <button onClick={saveRoutine} disabled={savingRoutine} className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 text-sm">
                            {savingRoutine ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-2">
                            <span className="text-xs font-semibold text-blue-700 bg-blue-100 rounded px-2 py-0.5">{routine.routine_type}</span>
                            {routine.title && <span className="text-sm font-semibold text-gray-900">{routine.title}</span>}
                          </div>
                          <div className="flex items-center space-x-1">
                            <button onClick={() => startEditRoutine(routine)} className="text-gray-400 hover:text-blue-600 transition" title="Edit">
                              <Edit2 size={16} />
                            </button>
                            <button onClick={() => deleteRoutine(routine.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                        {routine.content && (
                          <p className="text-sm text-gray-700 whitespace-pre-wrap">{routine.content}</p>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeProfileTab === 'recruitment' && (
            <div>
              {/* #416: facility-wide recruiting board, staff only. Sits above the
                  school directory and its level chips, as Cordell asked. */}
              {(userRole === 'admin' || userRole === 'coach') && (
                <RecruitingBoard onNavigateToProfile={onNavigateToProfile} highlightUserId={userId} onChanged={(changedUserId) => { if (changedUserId === userId) fetchRecruitmentTeams(); }} />
              )}

              {/* ── School Directory ── */}
              <div className="mb-8">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-lg font-semibold text-gray-900">School Directory</h4>
                  {(userRole === 'admin' || userRole === 'coach') && !addingSchool && (
                    <button onClick={() => setAddingSchool(true)} className="text-blue-600 hover:text-blue-700 flex items-center space-x-1 text-sm font-medium">
                      <Plus size={16} /><span>Add School</span>
                    </button>
                  )}
                </div>

                {/* Search + Level filter */}
                <div className="flex flex-col sm:flex-row gap-3 mb-3">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={schoolSearch}
                      onChange={e => setSchoolSearch(e.target.value)}
                      placeholder="Search by school name..."
                      className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {['all', 'D1', 'D2', 'D3', 'NAIA', 'JUCO'].map(lvl => (
                      <button
                        key={lvl}
                        onClick={() => setSchoolLevelFilter(lvl)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${schoolLevelFilter === lvl ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                      >
                        {lvl === 'all' ? 'All' : lvl}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Add school form */}
                {addingSchool && (
                  <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 mb-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
                      <input type="text" placeholder="School name *" value={newSchool.name} onChange={e => setNewSchool(s => ({ ...s, name: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <select value={newSchool.level} onChange={e => setNewSchool(s => ({ ...s, level: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white">
                        {['D1', 'D2', 'D3', 'NAIA', 'JUCO'].map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                      <input type="text" placeholder="Conference" value={newSchool.conference} onChange={e => setNewSchool(s => ({ ...s, conference: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <input type="text" placeholder="City" value={newSchool.city} onChange={e => setNewSchool(s => ({ ...s, city: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <input type="text" placeholder="State" value={newSchool.state} onChange={e => setNewSchool(s => ({ ...s, state: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={addSchool} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition">Save</button>
                      <button onClick={() => { setAddingSchool(false); setNewSchool({ name: '', level: 'D1', state: '', city: '', conference: '' }); }} className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-300 transition">Cancel</button>
                    </div>
                  </div>
                )}

                {/* School list */}
                {(() => {
                  const filtered = schools.filter(s => {
                    if (schoolLevelFilter !== 'all' && s.level !== schoolLevelFilter) return false;
                    if (schoolSearch && !s.name.toLowerCase().includes(schoolSearch.toLowerCase())) return false;
                    return true;
                  });
                  if (filtered.length === 0) {
                    return <p className="text-sm text-gray-500 py-4 text-center">{schools.length === 0 ? 'No schools yet.' : 'No schools match your search.'}</p>;
                  }
                  return (
                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                      {filtered.map(school => {
                        const isExpanded = expandedSchool === school.id;
                        const contacts = schoolContacts[school.id];
                        const meta = [school.level, school.conference, [school.city, school.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
                        return (
                          <div key={school.id}>
                            <button
                              type="button"
                              onClick={() => {
                                if (isExpanded) { setExpandedSchool(null); }
                                else { setExpandedSchool(school.id); fetchSchoolContacts(school.id); }
                              }}
                              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition"
                            >
                              <div className="flex items-center space-x-2 min-w-0">
                                {isExpanded ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                                <div className="min-w-0">
                                  <span className="text-sm font-medium text-gray-900">{school.name}</span>
                                  {meta && <span className="text-xs text-gray-500 ml-2">{meta}</span>}
                                </div>
                              </div>
                              {contacts && <span className="text-xs text-gray-400 flex-shrink-0">{contacts.length}</span>}
                            </button>
                            {isExpanded && (
                              <div className="px-4 pb-3 pl-10">
                                {!contacts ? (
                                  <p className="text-xs text-gray-400">Loading contacts...</p>
                                ) : contacts.length === 0 && addingContact !== school.id ? (
                                  <p className="text-xs text-gray-500">No contacts yet.</p>
                                ) : (
                                  <div className="space-y-2">
                                    {contacts.map(c => (
                                      <div key={c.id} className="flex items-start justify-between bg-gray-50 rounded-lg px-3 py-2">
                                        <div>
                                          <p className="text-sm font-medium text-gray-900">{c.name}{c.title && <span className="text-gray-500 font-normal"> · {c.title}</span>}</p>
                                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                                            {c.email && <a href={`mailto:${c.email}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><Mail size={12} />{c.email}</a>}
                                            {c.phone && <a href={`tel:${c.phone}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1"><Phone size={12} />{c.phone}</a>}
                                          </div>
                                        </div>
                                        {(userRole === 'admin' || userRole === 'coach') && (
                                          <button onClick={() => deleteSchoolContact(school.id, c.id)} className="text-red-400 hover:text-red-600 ml-2 flex-shrink-0" title="Delete contact"><Trash2 size={14} /></button>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(userRole === 'admin' || userRole === 'coach') && (
                                  <div className="mt-2">
                                    {addingContact === school.id ? (
                                      <div className="border border-blue-200 bg-blue-50 rounded-lg p-3">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                                          <input type="text" placeholder="Name *" value={newContact.name} onChange={e => setNewContact(c => ({ ...c, name: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                          <input type="text" placeholder="Title" value={newContact.title} onChange={e => setNewContact(c => ({ ...c, title: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                          <input type="email" placeholder="Email" value={newContact.email} onChange={e => setNewContact(c => ({ ...c, email: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                          <input type="text" placeholder="Phone" value={newContact.phone} onChange={e => setNewContact(c => ({ ...c, phone: e.target.value }))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                                        </div>
                                        <div className="flex gap-2">
                                          <button onClick={() => addSchoolContact(school.id)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-blue-700 transition">Save</button>
                                          <button onClick={() => { setAddingContact(null); setNewContact({ name: '', title: '', email: '', phone: '' }); }} className="bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-300 transition">Cancel</button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex gap-2">
                                        <button onClick={() => setAddingContact(school.id)} className="text-blue-600 hover:text-blue-700 text-xs font-medium flex items-center gap-1"><Plus size={14} />Add Contact</button>
                                        <button onClick={() => deleteSchool(school.id)} className="text-red-500 hover:text-red-700 text-xs font-medium flex items-center gap-1"><Trash2 size={14} />Delete School</button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* ── Per-player recruitment entries ── */}
              <h4 className="text-lg font-semibold text-gray-900 mb-3">Player Recruitment</h4>
              {recruitmentTeams.map((team) => (
                <div key={team.id} className="border border-gray-200 rounded-lg p-4 mb-4">
                  <div className="flex justify-between items-start mb-3">
                    <h4 className="text-sm font-semibold text-gray-700">
                      {team.organization_name || 'New Team'}
                    </h4>
                    {(userRole === 'admin' || userRole === 'coach') && (
                      <button
                        onClick={() => deleteRecruitmentTeam(team.id)}
                        className="text-red-400 hover:text-red-600 transition"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Level</label>
                      <select
                        value={team.level || ''}
                        onChange={(e) => updateRecruitmentTeam(team.id, 'level', e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white"
                      >
                        <option value="">Select Level</option>
                        {RECRUITMENT_LEVEL_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Organization Name</label>
                      <input
                        type="text"
                        defaultValue={team.organization_name || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'organization_name', e.target.value)}
                        placeholder="Organization name"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Contact Person</label>
                      <input
                        type="text"
                        defaultValue={team.contact_person || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'contact_person', e.target.value)}
                        placeholder="Contact person"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Role / Position</label>
                      <input
                        type="text"
                        defaultValue={team.role_position || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'role_position', e.target.value)}
                        placeholder="Role or position"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Contact Email</label>
                      <input
                        type="email"
                        defaultValue={team.contact_email || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'contact_email', e.target.value)}
                        placeholder="Email address"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Contact Phone</label>
                      <input
                        type="text"
                        defaultValue={team.contact_phone || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'contact_phone', e.target.value)}
                        placeholder="Phone number"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Status</label>
                      <select
                        value={team.status || ''}
                        onChange={(e) => updateRecruitmentTeam(team.id, 'status', e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white"
                      >
                        <option value="">Select Status</option>
                        {RECRUITMENT_STATUS_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-2 lg:col-span-4">
                      <label className="block text-xs text-gray-500 mb-1">Notes</label>
                      <textarea
                        defaultValue={team.notes || ''}
                        onBlur={(e) => updateRecruitmentTeam(team.id, 'notes', e.target.value)}
                        placeholder="Additional notes..."
                        rows={2}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                      />
                    </div>
                  </div>
                </div>
              ))}
              {(userRole === 'admin' || userRole === 'coach') && (
                <button
                  onClick={addRecruitmentTeam}
                  className="mt-2 bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
                >
                  <Plus size={18} />
                  <span>Add a Team</span>
                </button>
              )}
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'codes' && (
            <div>
              <h4 className="text-lg font-semibold text-gray-900 mb-4">Discount Codes</h4>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Vendor</th>
                    <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Code</th>
                  </tr>
                </thead>
                <tbody>
                  {discountCodes.filter(c => !c.player_id || c.player_id === userId).map(c => (
                    <tr key={c.id} className="border-b border-gray-100">
                      <td className="py-3 px-4 text-sm text-gray-900">{c.vendor || '—'}</td>
                      <td className="py-3 px-4 text-sm text-gray-900 font-mono">{c.code || '—'}</td>
                    </tr>
                  ))}
                  {discountCodes.filter(c => !c.player_id || c.player_id === userId).length === 0 && (
                    <tr>
                      <td colSpan={2} className="py-8 text-center text-gray-500">No discount codes available.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'documents' && (
            <div className="space-y-4">
              {/* Waiver */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedSubmission(expandedSubmission === 'doc-waiver' ? null : 'doc-waiver')}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${waiverData ? 'bg-green-100' : 'bg-gray-100'}`}>
                      <FileText size={20} className={waiverData ? 'text-green-600' : 'text-gray-400'} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-semibold text-gray-900">Waiver</h4>
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">All Athletes</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {waiverData ? (
                          <span className="text-green-600 font-medium">
                            Signed on {new Date(waiverData.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        ) : 'Not yet signed'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {waiverData ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Complete</span> : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Incomplete</span>}
                    {expandedSubmission === 'doc-waiver' ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                  </div>
                </button>
                {expandedSubmission === 'doc-waiver' && (
                  <div className="border-t border-gray-200 p-4">
                    {waiverData ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-gray-600">Participant Name</p>
                            <p className="text-gray-900 font-medium">{waiverData.participant_name}</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Participant Signature</p>
                            <SignedSignatureImage
                              signatureValue={waiverData.participant_signature_url}
                              alt="Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                        </div>
                        {waiverData.is_minor && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-sm font-semibold text-gray-700 mb-3">Parent / Guardian</p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div>
                                <p className="text-sm text-gray-600">Guardian Name</p>
                                <p className="text-gray-900 font-medium">{waiverData.guardian_name}</p>
                              </div>
                              <div>
                                <p className="text-sm text-gray-600">Relationship</p>
                                <p className="text-gray-900 font-medium">{waiverData.guardian_relationship}</p>
                              </div>
                              {waiverData.emergency_phone && (
                                <div>
                                  <p className="text-sm text-gray-600">Emergency Phone</p>
                                  <p className="text-gray-900 font-medium">{waiverData.emergency_phone}</p>
                                </div>
                              )}
                            </div>
                            <div className="mt-3">
                              <p className="text-sm text-gray-600 mb-1">Guardian Signature</p>
                              <SignedSignatureImage
                                signatureValue={waiverData.guardian_signature_url}
                                alt="Guardian Signature"
                                className="border border-gray-200 rounded bg-white max-h-20"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center py-4">
                        <p className="text-sm text-gray-500">Waiver not yet signed.</p>
                        {!onBack && <p className="text-xs text-gray-400 mt-1">Go to the Waiver page from the sidebar to sign.</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Player Contract */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedSubmission(expandedSubmission === 'doc-contract' ? null : 'doc-contract')}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${contractData ? 'bg-green-100' : 'bg-gray-100'}`}>
                      <FileText size={20} className={contractData ? 'text-green-600' : 'text-gray-400'} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-semibold text-gray-900">Player Contract</h4>
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700">Naturals Select</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {contractData ? (
                          <span className="text-green-600 font-medium">
                            Signed on {new Date(contractData.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        ) : 'Not yet signed'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {contractData ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Complete</span> : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Incomplete</span>}
                    {expandedSubmission === 'doc-contract' ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                  </div>
                </button>
                {expandedSubmission === 'doc-contract' && (
                  <div className="border-t border-gray-200 p-4">
                    {contractData ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div>
                            <p className="text-sm text-gray-600">Player Name</p>
                            <p className="text-gray-900 font-medium">{contractData.player_name}</p>
                          </div>
                          {contractData.positions?.length > 0 && (
                            <div>
                              <p className="text-sm text-gray-600">Positions</p>
                              <p className="text-gray-900 font-medium">{contractData.positions.join(', ')}</p>
                            </div>
                          )}
                          {contractData.bats_throws && (
                            <div>
                              <p className="text-sm text-gray-600">Bats/Throws</p>
                              <p className="text-gray-900 font-medium">{contractData.bats_throws}</p>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Player Signature</p>
                            <SignedSignatureImage
                              signatureValue={contractData.player_signature_url}
                              alt="Player Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Parent Signature</p>
                            <SignedSignatureImage
                              signatureValue={contractData.parent_signature_url}
                              alt="Parent Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4">
                        <p className="text-sm text-gray-500">Contract not yet signed.</p>
                        {!onBack && <p className="text-xs text-gray-400 mt-1">Go to the Player Contract page from the sidebar to sign.</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Letter of Intent */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedSubmission(expandedSubmission === 'doc-loi' ? null : 'doc-loi')}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${loiData ? 'bg-green-100' : 'bg-gray-100'}`}>
                      <FileText size={20} className={loiData ? 'text-green-600' : 'text-gray-400'} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-semibold text-gray-900">Letter of Intent</h4>
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700">Naturals Select</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {loiData ? (
                          <span className="text-green-600 font-medium">
                            Signed on {new Date(loiData.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        ) : 'Not yet signed'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {loiData ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Complete</span> : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Incomplete</span>}
                    {expandedSubmission === 'doc-loi' ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                  </div>
                </button>
                {expandedSubmission === 'doc-loi' && (
                  <div className="border-t border-gray-200 p-4">
                    {loiData ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div>
                            <p className="text-sm text-gray-600">Player Name</p>
                            <p className="text-gray-900 font-medium">{loiData.player_name}</p>
                          </div>
                          {loiData.positions?.length > 0 && (
                            <div>
                              <p className="text-sm text-gray-600">Positions</p>
                              <p className="text-gray-900 font-medium">{loiData.positions.join(', ')}</p>
                            </div>
                          )}
                          {loiData.grad_year && (
                            <div>
                              <p className="text-sm text-gray-600">Grad Year</p>
                              <p className="text-gray-900 font-medium">{loiData.grad_year}</p>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Player Signature</p>
                            <SignedSignatureImage
                              signatureValue={loiData.player_signature_url}
                              alt="Player Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Parent Signature</p>
                            <SignedSignatureImage
                              signatureValue={loiData.parent_signature_url}
                              alt="Parent Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4">
                        <p className="text-sm text-gray-500">Letter of Intent not yet signed.</p>
                        {!onBack && <p className="text-xs text-gray-400 mt-1">Go to the Letter of Intent page from the sidebar to sign.</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Facility Fine (#378). Hidden until FACILITY_FINE_ENABLED is
                  flipped on in src/facilityFineDocument.js - which must not
                  happen before Cordell's real policy PDF is uploaded and the
                  20260902_facility_fine_athlete_read.sql migration is run. */}
              {FACILITY_FINE_ENABLED && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedSubmission(expandedSubmission === 'doc-facility-fine' ? null : 'doc-facility-fine')}
                    className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${facilityFineData ? 'bg-green-100' : 'bg-gray-100'}`}>
                        <FileText size={20} className={facilityFineData ? 'text-green-600' : 'text-gray-400'} />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h4 className="text-sm font-semibold text-gray-900">{FACILITY_FINE_LABEL}</h4>
                          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">All Athletes</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {facilityFineData ? (
                            <span className="text-green-600 font-medium">
                              Signed on {new Date(facilityFineData.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          ) : facilityFineUnavailable ? 'Status unavailable' : 'Not yet signed'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      {facilityFineData
                        ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Complete</span>
                        : facilityFineUnavailable
                          ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Unavailable</span>
                          : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Incomplete</span>}
                      {expandedSubmission === 'doc-facility-fine' ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                    </div>
                  </button>
                  {expandedSubmission === 'doc-facility-fine' && (
                    <div className="border-t border-gray-200 p-4">
                      {facilityFineData ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-gray-600">Printed Name</p>
                            <p className="text-gray-900 font-medium">{facilityFineData.signature_text || '—'}</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600 mb-1">Signature</p>
                            <SignedSignatureImage
                              signatureValue={facilityFineData.signature_url}
                              alt="Facility Fine Signature"
                              className="border border-gray-200 rounded bg-white max-h-20"
                            />
                          </div>
                        </div>
                      ) : facilityFineUnavailable ? (
                        <div className="flex items-start space-x-2 py-2">
                          <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
                          <p className="text-sm text-amber-800">
                            Signing status could not be read, so we cannot tell whether this document has been signed. This usually means the facility fine tables have not been migrated on this database yet. Ask an admin to check before treating it as unsigned.
                          </p>
                        </div>
                      ) : (
                        <div className="text-center py-4">
                          <p className="text-sm text-gray-500">Facility fine policy not yet signed.</p>
                          {!onBack && <p className="text-xs text-gray-400 mt-1">Go to the Facility Fine page from the sidebar to sign.</p>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Medical History */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowMedicalForm(!showMedicalForm)}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${medicalHistory ? 'bg-green-100' : 'bg-gray-100'}`}>
                      <FileText size={20} className={medicalHistory ? 'text-green-600' : 'text-gray-400'} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-sm font-semibold text-gray-900">Medical History / Athlete Intake Form</h4>
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">All Athletes</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {medicalHistory ? (
                          <span className="text-green-600 font-medium">
                            Completed {medicalHistory.signed_at ? `on ${new Date(medicalHistory.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                          </span>
                        ) : 'Not yet completed'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {medicalHistory ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Complete</span> : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Incomplete</span>}
                    {showMedicalForm ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
                  </div>
                </button>
                {showMedicalForm && (
                  <div className="border-t border-gray-200 p-4">
                    <MedicalHistoryForm userId={userId} userRole={userRole} />
                  </div>
                )}
              </div>
            </div>
          )}

          {activeProfileTab === 'schedule' && (() => {
            const year = scheduleDate.getFullYear();
            const month = scheduleDate.getMonth();
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const calendarCells = [];
            for (let i = 0; i < firstDay; i++) calendarCells.push(null);
            for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);
            const eventsByDay = {};
            scheduleEvents.forEach(ev => {
              const day = parseInt(ev.event_date?.split('-')[2], 10);
              if (!eventsByDay[day]) eventsByDay[day] = [];
              eventsByDay[day].push(ev);
            });
            const dotColor = (type) => {
              switch (type) {
                case 'workout': return 'bg-orange-400';
                case 'game': return 'bg-slate-500';
                case 'practice': return 'bg-green-400';
                case 'meal': return 'bg-yellow-400';
                default: return 'bg-blue-400';
              }
            };
            const today = new Date();
            const isToday = (d) => d && today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

            return (
              <div className="space-y-4">
                {/* Month Navigation */}
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => { const nd = new Date(year, month - 1, 1); setScheduleDate(nd); setScheduleSelectedDay(null); }}
                    className="p-1 rounded hover:bg-gray-100"
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <h4 className="text-lg font-semibold text-gray-900">
                    {scheduleDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </h4>
                  <div className="flex items-center space-x-2">
                    {canEditProfile && (
                      <button
                        onClick={() => setShowAddWorkout(true)}
                        className="flex items-center space-x-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition"
                      >
                        <Plus size={14} />
                        <span>Add to Schedule</span>
                      </button>
                    )}
                    <button
                      onClick={() => { const nd = new Date(year, month + 1, 1); setScheduleDate(nd); setScheduleSelectedDay(null); }}
                      className="p-1 rounded hover:bg-gray-100"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>

                {/* Calendar Grid */}
                <div className="grid grid-cols-7 gap-px bg-gray-200 rounded-lg overflow-hidden border border-gray-200">
                  {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                    <div key={d} className="bg-gray-50 text-center text-xs font-semibold text-gray-500 py-2">{d}</div>
                  ))}
                  {calendarCells.map((day, i) => {
                    const dayEvents = day ? (eventsByDay[day] || []) : [];
                    const selected = scheduleSelectedDay === day;
                    return (
                      <div
                        key={i}
                        onClick={() => day && setScheduleSelectedDay(day === scheduleSelectedDay ? null : day)}
                        className={`bg-white min-h-[72px] p-1 cursor-pointer transition ${
                          !day ? 'bg-gray-50' : ''
                        } ${selected ? 'ring-2 ring-blue-500 ring-inset' : ''} ${
                          isToday(day) ? 'bg-blue-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        {day && (
                          <>
                            <div className={`text-xs font-medium ${isToday(day) ? 'text-blue-700 font-bold' : 'text-gray-700'}`}>{day}</div>
                            {dayEvents.length > 0 && (
                              <div className="mt-0.5 space-y-0.5">
                                {dayEvents.slice(0, 3).map((ev, j) => (
                                  <div key={j} className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate ${
                                    ev.event_type === 'workout' ? 'bg-orange-50 text-orange-700' :
                                    ev.event_type === 'game' ? 'bg-slate-100 text-slate-700' :
                                    ev.event_type === 'practice' ? 'bg-green-50 text-green-700' :
                                    ev.event_type === 'meal' ? 'bg-yellow-50 text-yellow-700' :
                                    'bg-blue-50 text-blue-700'
                                  }`}>
                                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor(ev.event_type)}`} />
                                    <span className="truncate">{ev.title || ev.opponent || ev.event_type}</span>
                                  </div>
                                ))}
                                {dayEvents.length > 3 && <span className="text-[9px] text-gray-400 pl-1">+{dayEvents.length - 3} more</span>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Selected Day Events */}
                {scheduleSelectedDay && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h5 className="text-sm font-semibold text-gray-700">
                        {new Date(year, month, scheduleSelectedDay).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                      </h5>
                      {canEditProfile && (
                        <button
                          onClick={() => setShowAddWorkout(true)}
                          className="flex items-center space-x-1 px-2.5 py-1 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition"
                        >
                          <Plus size={12} />
                          <span>Add</span>
                        </button>
                      )}
                    </div>
                    {(eventsByDay[scheduleSelectedDay] || []).length === 0 ? (
                      <p className="text-sm text-gray-400 py-4 text-center">No events scheduled</p>
                    ) : (
                      (eventsByDay[scheduleSelectedDay] || []).map((ev, i) => {
                        const { general, exercises } = parseExerciseNotesProfile(ev.notes);
                        return (
                          <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2">
                            <div className="flex items-center space-x-2">
                              <div className={`w-2.5 h-2.5 rounded-full ${dotColor(ev.event_type)}`} />
                              <span className="font-medium text-sm text-gray-900">{ev.title || ev.opponent || ev.event_type}</span>
                              <span className="text-xs text-gray-400 capitalize">{ev.event_type}</span>
                            </div>
                            {ev.event_time && (
                              <div className="text-xs text-gray-500">
                                {ev.event_time.slice(0, 5)}{ev.event_end_time ? ` – ${ev.event_end_time.slice(0, 5)}` : ''}
                              </div>
                            )}
                            {general && (
                              <div className="text-xs text-gray-600 bg-gray-50 rounded p-2 whitespace-pre-wrap">{general}</div>
                            )}
                            {exercises.length > 0 && (
                              <div className="p-2 bg-blue-50 rounded border border-blue-100 space-y-1.5">
                                <div className="text-xs font-semibold text-blue-700">Exercises</div>
                                {exercises.map((ex, j) => (
                                  <div key={j} className="bg-white rounded p-2 border border-blue-100 flex items-start justify-between gap-2 text-xs">
                                    <div className="min-w-0 flex-1">
                                      <span className="font-medium text-gray-900 break-words">{ex.name}</span>
                                      {/* #321: was a non-wrapping `flex items-center gap-2` with no
                                          label on sets/reps — at 375px the rest/load values ran off
                                          the card, and a reps-only exercise rendered nothing at all
                                          (`ex.sets && ex.reps ? … : ex.sets`). */}
                                      <ExerciseMetrics
                                        className="mt-1"
                                        sets={ex.sets}
                                        reps={ex.reps}
                                        load={ex.load}
                                        rest={ex.rest}
                                      />
                                    </div>
                                    {ex.link && (
                                      <a href={ex.link} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 ml-2 flex-shrink-0">
                                        <ExternalLink size={12} />
                                      </a>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}

                {scheduleEvents.length === 0 && !scheduleSelectedDay && (
                  <p className="text-center text-gray-400 text-sm py-4">No events this month</p>
                )}
              </div>
            );
          })()}

          {showAddWorkout && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto pt-8 pb-8">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4">
                <AddEventPanel
                  date={scheduleSelectedDay ? `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, '0')}-${String(scheduleSelectedDay).padStart(2, '0')}` : fmtLocalDate(new Date())}
                  view="player"
                  teamId={null}
                  playerIds={[userId]}
                  onClose={() => setShowAddWorkout(false)}
                  onSuccess={() => { setShowAddWorkout(false); fetchScheduleEvents(); }}
                />
              </div>
            </div>
          )}

          {/* #226: Programming merged into the Schedule tab — renders below the calendar. */}
          {activeProfileTab === 'schedule' && (() => {
            const today = fmtLocalDate(new Date());
            const isActive = (a) => {
              if (!a.start_date && !a.end_date) return true;
              if (a.start_date && a.start_date > today) return false;
              if (a.end_date && a.end_date < today) return false;
              return true;
            };
            const activePrograms = (programmingData.programs || []).filter(isActive);
            const pastPrograms = (programmingData.programs || []).filter(p => !isActive(p));
            const activeMealPlans = (programmingData.mealPlans || []).filter(isActive);
            const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

            return (
              <div className="space-y-6 mt-6 pt-6 border-t border-gray-200">
                <h3 className="text-base font-bold text-gray-900 flex items-center">
                  <ClipboardList size={18} className="mr-2 text-gray-500" />
                  Programming
                </h3>
                {programmingData.loading && (
                  <p className="text-sm text-gray-500">Loading programming...</p>
                )}

                {profile?.program && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">Primary Program</div>
                    <div className="text-lg font-bold text-blue-900">{profile.program}</div>
                  </div>
                )}

                <div>
                  <h4 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                    <ClipboardList size={18} className="mr-2 text-gray-500" />
                    Active Training Programs
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-normal">{activePrograms.length}</span>
                  </h4>
                  {activePrograms.length === 0 ? (
                    <p className="text-sm text-gray-400 py-3">No active training programs.</p>
                  ) : (
                    <div className="space-y-2">
                      {activePrograms.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => a.training_programs?.id && setViewProgram({ id: a.training_programs.id, name: a.training_programs.name })}
                          disabled={!a.training_programs?.id}
                          className="w-full text-left border border-gray-200 rounded-lg p-3 bg-white hover:border-blue-300 hover:bg-blue-50/40 transition disabled:hover:bg-white disabled:hover:border-gray-200"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900 flex items-center gap-1.5">
                                {a.training_programs?.name || 'Untitled program'}
                                {a.training_programs?.id && <Eye size={14} className="text-gray-400 flex-shrink-0" />}
                              </div>
                              {a.training_programs?.description && <div className="text-xs text-gray-500 mt-0.5">{a.training_programs.description}</div>}
                            </div>
                            <div className="text-right text-xs text-gray-500 flex-shrink-0">
                              <div>{fmtDate(a.start_date)} – {fmtDate(a.end_date)}</div>
                              {a.team_id && <div className="mt-0.5 inline-block px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Team</div>}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                    <Calendar size={18} className="mr-2 text-gray-500" />
                    Active Meal Plans
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-normal">{activeMealPlans.length}</span>
                  </h4>
                  {activeMealPlans.length === 0 ? (
                    <p className="text-sm text-gray-400 py-3">No active meal plans.</p>
                  ) : (
                    <div className="space-y-2">
                      {activeMealPlans.map(a => (
                        <div key={a.id} className="border border-gray-200 rounded-lg p-3 bg-white">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900">{a.meal_plans?.name || 'Untitled meal plan'}</div>
                              {a.meal_plans?.description && <div className="text-xs text-gray-500 mt-0.5">{a.meal_plans.description}</div>}
                            </div>
                            <div className="text-right text-xs text-gray-500 flex-shrink-0">
                              <div>{fmtDate(a.start_date)} – {fmtDate(a.end_date)}</div>
                              {a.team_id && <div className="mt-0.5 inline-block px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Team</div>}
                            </div>
                          </div>
                          {(() => {
                            const items = [...(a.meal_plans?.meal_plan_items || [])]
                              .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
                              .map(it => it.meals).filter(Boolean);
                            if (items.length === 0) return null;
                            const tot = items.reduce((s, m) => ({
                              cal: s.cal + (m.calories || 0), p: s.p + (m.protein_g || 0),
                              c: s.c + (m.carbs_g || 0), f: s.f + (m.fat_g || 0),
                            }), { cal: 0, p: 0, c: 0, f: 0 });
                            return (
                              <div className="mt-2 pt-2 border-t border-gray-100">
                                <div className="flex flex-wrap gap-1.5 mb-2 text-[11px]">
                                  <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-medium">{Math.round(tot.cal)} kcal</span>
                                  <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">P {Math.round(tot.p)}g</span>
                                  <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">C {Math.round(tot.c)}g</span>
                                  <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">F {Math.round(tot.f)}g</span>
                                </div>
                                <div className="space-y-1.5">
                                  {items.map(m => (
                                    <div key={m.id} className="flex items-start justify-between gap-2 text-xs">
                                      <div className="min-w-0">
                                        <span className="font-medium text-gray-800">{m.meal_type ? `${m.meal_type}: ` : ''}</span>
                                        <span className="text-gray-700">{m.name}</span>
                                        {m.description && <div className="text-gray-400">{m.description}</div>}
                                      </div>
                                      <div className="text-gray-500 whitespace-nowrap flex-shrink-0">
                                        {Math.round(m.calories || 0)} kcal · {Math.round(m.protein_g || 0)}/{Math.round(m.carbs_g || 0)}/{Math.round(m.fat_g || 0)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                    <FileText size={18} className="mr-2 text-gray-500" />
                    Recent Assessments
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-normal">{(programmingData.assessments || []).length}</span>
                  </h4>
                  {(programmingData.assessments || []).length === 0 ? (
                    <p className="text-sm text-gray-400 py-3">No assessments submitted.</p>
                  ) : (
                    <div className="space-y-2">
                      {programmingData.assessments.map(a => (
                        <div key={a.id} className="border border-gray-200 rounded-lg p-3 bg-white">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900">{a.assessment_templates?.name || a.assessment_templates?.short_name || 'Assessment'}</div>
                              {a.notes && <div className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap line-clamp-2">{a.notes}</div>}
                            </div>
                            <div className="text-xs text-gray-500 flex-shrink-0">{fmtDate(a.assessment_date)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {pastPrograms.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-500 mb-2 uppercase tracking-wide">Past Programs</h4>
                    <div className="space-y-1.5">
                      {pastPrograms.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => a.training_programs?.id && setViewProgram({ id: a.training_programs.id, name: a.training_programs.name })}
                          disabled={!a.training_programs?.id}
                          className="w-full text-left text-xs text-gray-500 px-3 py-1.5 border border-gray-100 rounded bg-gray-50 hover:bg-gray-100 transition disabled:hover:bg-gray-50"
                        >
                          {a.training_programs?.name || 'Untitled'} — {fmtDate(a.start_date)} to {fmtDate(a.end_date)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {activeProfileTab === 'communication' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">Communication History</h3>
                {userData.email && (
                  <button
                    onClick={() => setShowEmailCompose(true)}
                    className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition flex items-center space-x-1"
                  >
                    <Mail size={16} />
                    <span>New Email</span>
                  </button>
                )}
              </div>

              {loadingComms ? (
                <p className="text-gray-500 text-sm text-center py-8">Loading communication history...</p>
              ) : communicationLogs.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Mail size={40} className="mx-auto mb-3 text-gray-300" />
                  <p>No emails sent yet.</p>
                  <p className="text-sm mt-1">Use the "New Email" button to send the first email.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {communicationLogs.map(log => (
                    <div key={log.id} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2 mb-1">
                            <h4 className="font-semibold text-gray-900 text-sm">{log.subject}</h4>
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              log.status === 'sent' ? 'bg-green-100 text-green-700' :
                              log.status === 'delivered' ? 'bg-blue-100 text-blue-700' :
                              'bg-red-100 text-red-700'
                            }`}>
                              {log.status}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600 whitespace-pre-wrap">{log.body}</p>
                          {log.attachment_names && log.attachment_names.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {log.attachment_names.map((name, i) => (
                                <span key={i} className="inline-flex items-center bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full">
                                  <Paperclip size={10} className="mr-1" />{name}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center space-x-3 mt-2 text-xs text-gray-400">
                            <span>To: {log.recipient_name} &lt;{log.recipient_email}&gt;</span>
                            <span>By: {log.sender?.full_name || 'Unknown'}</span>
                            <span>{new Date(log.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'lift_log' && (
            <LiftLogTab userId={userId} />
          )}

          {activeProfileTab === 'records' && activeRecordsSubTab === 'registration' && (
            <RegistrationTab userId={userId} loggedInUserId={loggedInUserId} userRole={userRole} />
          )}

          {activeProfileTab === 'stats' && activeStatsSubTab === 'practice_stats' && (
            // Players can only ever reach this section on their own profile (the
            // visibleStatsSubTabs filter enforces loggedInUserId === userId,
            // and activeStatsSubTab can only ever name a visible one), so it's safe
            // to also let them log their own stats here specifically — this
            // does NOT touch canEditProfile itself, which still gates every
            // other admin/coach-only field on the page (#278).
            <PracticeStatsTab playerId={userId} canEdit={canEditProfile || (userRole === 'player' && loggedInUserId === userId)} />
          )}

          {activeProfileTab === 'health' && activeHealthSubTab === 'marek' && (
            <MarekTab playerId={userId} canEdit={canEditProfile} dateOfBirth={userData?.date_of_birth} />
          )}

          {activeProfileTab === 'general' && (
          <>
          {/* Contact Information */}
          <div className="mb-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center space-x-3">
                <Mail className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Email</p>
                  <p className="text-gray-900">{userData.email}</p>
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Phone className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Phone</p>
                  {editing ? (
                    <input
                      type="tel"
                      value={editForm.phone}
                      onChange={(e) => setEditForm({...editForm, phone: e.target.value})}
                      placeholder="Enter phone number"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.phone || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Users className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Parent 1 Name</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.parent1_name}
                      onChange={(e) => setEditForm({...editForm, parent1_name: e.target.value})}
                      placeholder="Enter parent name"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.parent1_name || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Mail className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Parent 1 Email</p>
                  {editing ? (
                    <input
                      type="email"
                      value={editForm.parent1_email}
                      onChange={(e) => setEditForm({...editForm, parent1_email: e.target.value})}
                      placeholder="Enter parent email"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.parent1_email || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Users className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Parent 2 Name</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.parent2_name}
                      onChange={(e) => setEditForm({...editForm, parent2_name: e.target.value})}
                      placeholder="Enter parent name"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.parent2_name || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Mail className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Parent 2 Email</p>
                  {editing ? (
                    <input
                      type="email"
                      value={editForm.parent2_email}
                      onChange={(e) => setEditForm({...editForm, parent2_email: e.target.value})}
                      placeholder="Enter parent email"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.parent2_email || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Instagram className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Instagram</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.instagram}
                      onChange={(e) => setEditForm({...editForm, instagram: e.target.value})}
                      placeholder="@username"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.instagram || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Twitter className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Twitter</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.twitter}
                      onChange={(e) => setEditForm({...editForm, twitter: e.target.value})}
                      placeholder="@username"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.twitter || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Building2 className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Organization</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.organization}
                      onChange={(e) => setEditForm({...editForm, organization: e.target.value})}
                      placeholder="Enter organization"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.organization || 'Not set'}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Physical Information */}
          <div className="mb-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4">Physical Information</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center space-x-3">
                <Ruler className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Height</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.height}
                      onChange={(e) => setEditForm({...editForm, height: e.target.value})}
                      placeholder="e.g., 6'2&quot;, 72 in"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.height || 'Not set'}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <Scale className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Weight</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.weight}
                      onChange={(e) => setEditForm({...editForm, weight: e.target.value})}
                      placeholder="e.g., 185 lbs"
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">{userData.weight || 'Not set'}</p>
                  )}
                </div>
              </div>

              {userData.role === 'player' && (
                <div className="flex items-center space-x-3">
                  <Dumbbell className="text-gray-400" size={20} />
                  <div className="flex-1">
                    <p className="text-sm text-gray-600">Training age (years lifting)</p>
                    {editing ? (
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={editForm.training_age_years}
                        onChange={(e) => setEditForm({...editForm, training_age_years: e.target.value})}
                        placeholder="e.g., 2"
                        className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    ) : (
                      <p className="text-gray-900">
                        {userData._profile?.training_age_months != null
                          ? `${Math.round((userData._profile.training_age_months / 12) * 10) / 10} yrs`
                          : 'Not set'}
                      </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-0.5">Years of consistent resistance training — used by the program generators.</p>
                  </div>
                </div>
              )}

              <div className="flex items-center space-x-3">
                <Calendar className="text-gray-400" size={20} />
                <div className="flex-1">
                  <p className="text-sm text-gray-600">Date of Birth</p>
                  {editing ? (
                    <input
                      type="date"
                      value={editForm.date_of_birth}
                      onChange={(e) => setEditForm({...editForm, date_of_birth: e.target.value})}
                      className="w-full border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900">
                      {userData.date_of_birth
                        ? `${new Date(userData.date_of_birth + 'T00:00:00').toLocaleDateString()} (${Math.floor((new Date() - new Date(userData.date_of_birth + 'T00:00:00')) / 31557600000)} yrs)`
                        : 'Not set'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Player-Specific Information */}
          {profile && (
            <div className="mb-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4">Player Information</h4>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Sport</p>
                  {editing ? (
                    <div className="relative mt-1" ref={sportEditDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setSportEditDropdownOpen(o => !o)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm text-left truncate focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                      >
                        {editForm.sport || <span className="text-gray-400">Select sports</span>}
                      </button>
                      {sportEditDropdownOpen && (
                        <div className="absolute z-20 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                          {SPORT_OPTIONS.map(sport => {
                            const selected = (editForm.sport || '').split(',').map(s => s.trim()).filter(Boolean).includes(sport);
                            return (
                              <label key={sport} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm text-gray-900">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => {
                                    const current = (editForm.sport || '').split(',').map(s => s.trim()).filter(Boolean);
                                    const next = selected ? current.filter(s => s !== sport) : [...current, sport];
                                    setEditForm({...editForm, sport: next.join(', ')});
                                  }}
                                />
                                {sport}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-gray-900 font-medium">{profile.sport || 'Not set'}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm text-gray-600">Jersey Number</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.jersey_number}
                      onChange={(e) => setEditForm({...editForm, jersey_number: e.target.value})}
                      placeholder="e.g. 12"
                      className="w-full border border-gray-300 rounded px-2 py-1 mt-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900 font-medium">{profile.jersey_number || 'Not set'}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm text-gray-600">Position</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.position}
                      onChange={(e) => setEditForm({...editForm, position: e.target.value})}
                      placeholder="e.g. SS, OF"
                      className="w-full border border-gray-300 rounded px-2 py-1 mt-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900 font-medium">{profile.position || 'Not set'}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm text-gray-600">Grade</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editForm.grade}
                      onChange={(e) => setEditForm({...editForm, grade: e.target.value})}
                      placeholder="e.g. 10th"
                      className="w-full border border-gray-300 rounded px-2 py-1 mt-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900 font-medium">{profile.grade || 'Not set'}</p>
                  )}
                </div>
                <div>
                  <p className="text-sm text-gray-600">Bats / Throws</p>
                  {editing ? (
                    <div className="flex gap-1 mt-1">
                      <select
                        value={editForm.bats}
                        onChange={(e) => setEditForm({...editForm, bats: e.target.value})}
                        className="w-1/2 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Bats</option>
                        <option value="Right">R</option>
                        <option value="Left">L</option>
                        <option value="Switch">S</option>
                      </select>
                      <select
                        value={editForm.throws}
                        onChange={(e) => setEditForm({...editForm, throws: e.target.value})}
                        className="w-1/2 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Throws</option>
                        <option value="Right">R</option>
                        <option value="Left">L</option>
                      </select>
                    </div>
                  ) : (
                    <p className="text-gray-900 font-medium">{profile.bats || 'Not set'} / {profile.throws || 'Not set'}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Equipment Sizes */}
          <div className="mb-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <Shirt className="text-gray-400" size={20} />
              <span>Equipment Sizes</span>
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {EQUIPMENT_FIELDS.map(({ key, label }) => (
                <div key={key}>
                  <p className="text-sm text-gray-600">{label}</p>
                  {editing ? (
                    <input
                      type="text"
                      value={editEquipment[key]}
                      onChange={(e) => setEditEquipment({...editEquipment, [key]: e.target.value})}
                      placeholder={`Enter ${label.toLowerCase()} size`}
                      className="w-full border border-gray-300 rounded px-2 py-1 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <p className="text-gray-900 font-medium">{equipmentSizes[key] || 'Not set'}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Gear Stores */}
          <div className="mb-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <ShoppingBag className="text-gray-400" size={20} />
              <span>Gear Stores</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* #377: renamed from "Natural Ballplayer Store" to "The Natural
                  Ballplayer Store" at Cordell's request. The link is untouched. */}
              <a
                href="https://naturalballplayer.myshopify.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between bg-blue-600 text-white px-4 py-3 rounded-lg font-medium hover:bg-blue-700 transition"
              >
                <span>The Natural Ballplayer Store</span>
                <ExternalLink size={18} />
              </a>
              {/* #377: this was a green "Uniform Store" button up in the profile
                  header next to Pay. Cordell asked for it down here beside the
                  other store button, renamed, and recoloured cream-on-black.
                  bg-blue-200 / text-blue-900 IS the brand cream (#E6DBB9) and the
                  brand ink — tailwind.config.js repoints the whole blue ramp onto
                  the Naturals palette, so this is the same pair the sidebar's
                  "View as Coach" and "Switch to Work Portal" buttons already use,
                  rather than a hand-written hex. Text on cream measures 14.4:1.
                  The border is the one addition: cream on the white profile card
                  is only 1.4:1, so without an edge the button has no visible
                  shape. blue-400 (#9A8C86) against white is 3.2:1, which clears
                  the 3:1 that WCAG asks of a control's boundary. */}
              <button
                type="button"
                onClick={() => setShowUniformStore(true)}
                className="flex items-center justify-between bg-blue-200 border border-blue-400 text-blue-900 px-4 py-3 rounded-lg font-medium hover:bg-blue-300 transition"
              >
                <span>Naturals Select Teams Store</span>
                <ExternalLink size={18} />
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          {editing && (
            <div className="flex space-x-3 pt-4 border-t border-gray-200">
              <button
                onClick={handleCancel}
                className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition flex items-center justify-center space-x-2"
              >
                <X size={18} />
                <span>Cancel</span>
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                <Save size={18} />
                <span>{saving ? 'Saving...' : 'Save Changes'}</span>
              </button>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </div>

    {/* The modal mounts below deliberately live OUTSIDE the space-y-6
        wrapper above. Tailwind compiles space-y-6 to
        `.space-y-6 > :not([hidden]) ~ :not([hidden]) { margin-top: 1.5rem }`,
        so any `fixed inset-0` overlay mounted as a later child of that
        container was given a 24px margin-top: the backdrop started 24px
        down the screen and left the top strip uncovered and clickable —
        clicking it opened the mobile sidebar behind the modal. That rule
        out-specifies a plain `mt-0` utility, so keeping the overlays out of
        any space-y-* parent is the fix. Do not add a space-y-* class to the
        wrapper below, and mount new modals inside it. */}
    <div>
      {showEmailCompose && userData.email && (
        <EmailComposeModal
          recipientName={userData.full_name}
          recipientEmail={userData.email}
          playerId={userData.id}
          onClose={() => setShowEmailCompose(false)}
          onSent={() => fetchCommunicationLogs()}
        />
      )}

      {showStore && (
        <StoreModal userId={userData.id} loggedInUserId={loggedInUserId} onClose={() => setShowStore(false)} />
      )}

      {showUniformStore && (
        /* K1: clicking the dark backdrop closes the pop-up. The card below stops
           the click bubbling, so a click INSIDE the card never closes it. */
        <div
          onClick={() => setShowUniformStore(false)}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          {/* The card scrolls its BODY, not itself: header pinned, body
              overflow-y-auto flex-1 min-h-0. The whole card used to scroll, which
              pushed the close X off the top of a phone screen on a long list. */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden"
          >
            <div className="flex-shrink-0 flex items-center justify-between gap-3 p-5 border-b border-gray-200">
              {/* #377: title follows the button's new name. */}
              <h2 className="text-xl font-bold text-gray-900 min-w-0 truncate">Naturals Select Teams Store</h2>
              <button onClick={() => setShowUniformStore(false)} className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition">
                <X size={22} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0 p-5 space-y-4">
              <p className="text-gray-700 text-sm">Order uniforms for the Naturals Select season.</p>
              {/* K4: the expensive mistake, in its own amber box rather than
                  folded into the sentence above it. This is the line that costs a
                  parent money if they skim past it, so it gets the same treatment
                  it had on the earlier branch. It sits second in the body, so it
                  stays above the fold even at 390x480. */}
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm font-semibold text-amber-900">
                  Once orders are received we are not able to make changes — please order the correct numbers.
                </p>
              </div>
              <a
                href="https://bsnteamsports.com/shop/ykUskUUjsG"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition"
              >
                Open Team Store
              </a>
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">How to Order</h3>
                <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
                  <li>Select your player's age-required player pack. Select all required items — you only need a youth or adult option for each item.</li>
                  <li>Select the athlete's size, name, and/or number on each garment if applicable, then click Add to Cart.</li>
                  <li>Select any fan gear options. Sizes shown are what is currently available and no additional sizes can be added.</li>
                  <li>Click Check Out at the top of the page.</li>
                  <li>Complete checkout. Put the player's name in the recipient name section.</li>
                </ol>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">Order questions?</p>
                <p>Contact: <a href="mailto:clubdirectcare@bsnsports.com" className="text-blue-600 hover:underline">clubdirectcare@bsnsports.com</a></p>
                <p className="mt-1">Stock items ship in 2 days. Custom items ship in 3–4 weeks.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPackages && (
        <PackagesModal
          userId={userData.id}
          userName={userData.full_name}
          canManage={userRole === 'admin' || userRole === 'coach'}
          canDelete={userRole === 'admin'}
          isSelf={loggedInUserId === userData.id}
          onClose={() => setShowPackages(false)}
        />
      )}

      {showAssignPackage && (
        <AssignPackageModal
          playerId={userData.id}
          playerName={userData.full_name}
          onClose={() => setShowAssignPackage(false)}
          onAssigned={() => { fetchPackageStatus(userData.id).then(setSubscriptionRow); }}
        />
      )}

      {showDiscount && (
        <ApplyDiscountModal
          playerId={userData.id}
          playerName={userData.full_name}
          onClose={() => setShowDiscount(false)}
          onApplied={() => { fetchPackageStatus(userData.id).then(setSubscriptionRow); }}
        />
      )}

      {assessmentFormTemplate && (
        <AssessmentFormModal
          template={assessmentFormTemplate}
          playerId={userId}
          onClose={() => setAssessmentFormTemplate(null)}
          onSubmitted={() => { fetchAssessmentData(); setAssessmentFormTemplate(null); }}
        />
      )}

      {showMentalTraining && (
        <MentalTrainingModal onClose={() => setShowMentalTraining(false)} />
      )}

      {viewProgram && (
        <ProgramViewerModal
          programId={viewProgram.id}
          programName={viewProgram.name}
          onClose={() => setViewProgram(null)}
        />
      )}
    </div>
    </>
  );
}

// Read-only viewer for a training program: shows each day's exercises. Used by players
// (and staff) to view what's programmed for them without any edit controls (#153).
function ProgramViewerModal({ programId, programName, onClose }) {
  useModalTracking('ProgramViewerModal');
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const { data: dayRows } = await supabase
        .from('training_days')
        .select('id, day_number, title, notes')
        .eq('program_id', programId)
        .order('day_number', { ascending: true });
      const dayList = dayRows || [];
      const dayIds = dayList.map(d => d.id);
      let exRows = [];
      if (dayIds.length > 0) {
        const { data: ex } = await supabase
          .from('training_exercises')
          .select('id, day_id, category, name, sets, reps, weight, rest, load, video_url, sort_order')
          .in('day_id', dayIds)
          .order('sort_order', { ascending: true });
        exRows = ex || [];
      }
      const byDay = dayList.map(d => ({
        ...d,
        exercises: exRows.filter(e => e.day_id === d.id),
      }));
      if (!cancelled) { setDays(byDay); setLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [programId]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-5 flex items-start justify-between flex-shrink-0">
          <div className="flex items-center space-x-3 min-w-0">
            {(() => { const hc = PROGRAM_HEADER_COLOR[getProgramCategory(programName)] || PROGRAM_HEADER_COLOR.general; return (
              <div className={`p-2 ${hc.bg} rounded-lg flex-shrink-0`}>
                <ClipboardList size={22} className={hc.text} />
              </div>
            ); })()}
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900 truncate">{programName || 'Program'}</h2>
              <div className="text-xs text-gray-500 mt-0.5">View only</div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={22} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center py-10 text-gray-500 text-sm">Loading program...</div>
          ) : days.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm">This program has no days yet.</div>
          ) : (
            days.map(day => (
              <div key={day.id} className="mb-6">
                <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wide mb-1">
                  {day.title || `Day ${day.day_number}`}
                </h3>
                {day.notes && <div className="text-sm text-gray-600 mb-2 whitespace-pre-wrap">{day.notes}</div>}
                {day.exercises.length === 0 ? (
                  <div className="text-xs text-gray-400 py-2">No exercises.</div>
                ) : (
                  <>
                    <div className="sm:hidden space-y-2">
                      {day.exercises.map(ex => (
                        <div key={ex.id} className="border border-gray-200 rounded-lg p-3 bg-white">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold text-gray-900 break-words min-w-0 flex-1">{ex.name}</div>
                            {ex.video_url && (
                              <a href={ex.video_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-50 text-blue-600 text-xs font-medium hover:bg-blue-100 flex-shrink-0">
                                <ExternalLink size={12} />
                                Video
                              </a>
                            )}
                          </div>
                          {/* #321: was `[sets × reps, load, rest].join(' · ')` — unlabelled,
                              so the athlete couldn't tell rest from load, and any value that
                              wasn't set just vanished. */}
                          <ExerciseMetrics
                            className="mt-2"
                            sets={ex.sets}
                            reps={ex.reps}
                            load={ex.load || ex.weight}
                            rest={ex.rest}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="hidden sm:block border border-gray-200 rounded-lg overflow-x-auto">
                      <table className="w-full text-sm min-w-max">
                        <thead className="bg-gray-50">
                          <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                            <th className="px-3 py-2">Exercise</th>
                            <th className="px-3 py-2 w-16 text-center">Sets</th>
                            <th className="px-3 py-2 w-20 text-center">Reps</th>
                            <th className="px-3 py-2 w-24 text-center">Load</th>
                            <th className="px-3 py-2 w-20 text-center">Rest</th>
                            <th className="px-3 py-2 w-12 text-center">Video</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {day.exercises.map(ex => (
                            <tr key={ex.id} className="hover:bg-gray-50">
                              <td className="px-3 py-2 text-gray-900">{ex.name}</td>
                              <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{ex.sets || '—'}</td>
                              <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{ex.reps || '—'}</td>
                              <td className="px-3 py-2 text-center text-gray-700">{ex.load || ex.weight || '—'}</td>
                              <td className="px-3 py-2 text-center text-gray-700">{ex.rest || '—'}</td>
                              <td className="px-3 py-2 text-center">
                                {ex.video_url ? (
                                  <a href={ex.video_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 inline-flex justify-center">
                                    <ExternalLink size={14} />
                                  </a>
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SubmissionView({ submission, ageGroupData }) {
  const schema = submission.assessment_templates?.schema || [];
  const responses = submission.responses || {};
  const avg = ageGroupData?.averages || {};
  const bracket = ageGroupData?.bracket;

  if (schema.length === 0) {
    return <p className="text-sm text-gray-500 italic">No template schema available.</p>;
  }

  return (
    <div className="space-y-3">
      {[...schema].sort((a, b) => a.sort_order - b.sort_order).map(el => (
        <div key={el.id} className="space-y-1">
          <label className="block text-xs font-semibold text-gray-700">{el.label || el.type}</label>
          {(el.type === 'text_field' || el.type === 'text_area' || el.type === 'notes') && (
            <p className="text-sm text-gray-800 bg-white px-3 py-2 rounded border border-gray-200">
              {responses[el.id] || <span className="text-gray-400 italic">No response</span>}
              {avg[el.id] != null && <span className="text-xs text-blue-500 ml-2">(Avg {bracket}: {avg[el.id]})</span>}
            </p>
          )}
          {el.type === 'combo_box' && (
            <p className="text-sm text-gray-800 bg-white px-3 py-2 rounded border border-gray-200">{responses[el.id] || <span className="text-gray-400 italic">No selection</span>}</p>
          )}
          {el.type === 'date' && (
            <p className="text-sm text-gray-800 bg-white px-3 py-2 rounded border border-gray-200">{responses[el.id] || <span className="text-gray-400 italic">No date</span>}</p>
          )}
          {el.type === 'table' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-gray-300">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="border border-gray-300 px-3 py-1.5 text-left text-xs font-medium text-gray-600"></th>
                    {(el.columns || []).map(col => (
                      <th key={col} className="border border-gray-300 px-3 py-1.5 text-left text-xs font-medium text-gray-600">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(el.rows || []).map(row => (
                    <tr key={row}>
                      <td className="border border-gray-300 px-3 py-1.5 font-medium text-gray-700 bg-gray-50 text-xs">{row}</td>
                      {(el.columns || []).map(col => {
                        const cellAvg = avg[el.id]?.[row]?.[col];
                        return (
                          <td key={col} className="border border-gray-300 px-3 py-1.5 text-gray-700 text-xs">
                            <div>{responses[el.id]?.[row]?.[col] || '—'}</div>
                            {cellAvg != null && <div className="text-[10px] text-blue-500">Avg: {cellAvg}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {submission.notes && (
        <div>
          <label className="block text-xs font-semibold text-gray-700">Additional Notes</label>
          <p className="text-sm text-gray-800 bg-white px-3 py-2 rounded border border-gray-200">{submission.notes}</p>
        </div>
      )}
    </div>
  );
}

function AssessmentFormModal({ template, playerId, onClose, onSubmitted }) {
  useModalTracking('AssessmentFormModal');
  const [responses, setResponses] = useState({});
  const [notes, setNotes] = useState('');
  const [assessmentDate, setAssessmentDate] = useState(fmtLocalDate(new Date()));
  const [saving, setSaving] = useState(false);

  const schema = [...(template.schema || [])].sort((a, b) => a.sort_order - b.sort_order);

  const updateResponse = (elId, value) => {
    setResponses(prev => ({ ...prev, [elId]: value }));
  };

  const updateTableCell = (elId, row, col, value) => {
    setResponses(prev => ({
      ...prev,
      [elId]: { ...(prev[elId] || {}), [row]: { ...(prev[elId]?.[row] || {}), [col]: value } }
    }));
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('assessment_submissions').insert({
        template_id: template.id,
        player_id: playerId,
        assessed_by: user.id,
        assessment_date: assessmentDate,
        responses,
        notes: notes.trim() || null,
      });
      if (error) throw error;
      onSubmitted();
    } catch (err) {
      alert('Error submitting assessment: ' + formatUserError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{template.name}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>

        <div className="p-4 space-y-4 flex-1 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assessment Date</label>
            <input
              type="date"
              value={assessmentDate}
              onChange={(e) => setAssessmentDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {schema.map(el => (
            <div key={el.id} className="space-y-1">
              <label className="block text-sm font-medium text-gray-700">{el.label || el.type}</label>

              {el.type === 'text_field' && (
                <input
                  type="text"
                  value={responses[el.id] || ''}
                  onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {(el.type === 'text_area' || el.type === 'notes') && (
                <textarea
                  value={responses[el.id] || ''}
                  onChange={(e) => updateResponse(el.id, e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              )}

              {el.type === 'combo_box' && (
                <select
                  value={responses[el.id] || ''}
                  onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Select...</option>
                  {(el.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              )}

              {el.type === 'date' && (
                <input
                  type="date"
                  value={responses[el.id] || ''}
                  onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}

              {el.type === 'table' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-300">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border border-gray-300 px-3 py-1.5 text-left text-xs font-medium text-gray-600"></th>
                        {(el.columns || []).map(col => (
                          <th key={col} className="border border-gray-300 px-3 py-1.5 text-left text-xs font-medium text-gray-600">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(el.rows || []).map(row => (
                        <tr key={row}>
                          <td className="border border-gray-300 px-3 py-1.5 font-medium text-gray-700 bg-gray-50 text-xs">{row}</td>
                          {(el.columns || []).map(col => (
                            <td key={col} className="border border-gray-300 px-1 py-0.5">
                              <input
                                type="text"
                                value={responses[el.id]?.[row]?.[col] || ''}
                                onChange={(e) => updateTableCell(el.id, row, col, e.target.value)}
                                className="w-full px-2 py-1 text-xs border-0 focus:outline-none focus:ring-1 focus:ring-blue-500 rounded"
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>

        <div className="border-t border-gray-200 p-4 flex justify-end space-x-3">
          <button onClick={onClose} className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50 transition">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition disabled:opacity-50 flex items-center space-x-2"
          >
            <Save size={16} />
            <span>{saving ? 'Submitting...' : 'Submit Assessment'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteEditor({ draft, setDraft, addPitch, updatePitch, removePitch }) {
  const isMechanics = draft.category === 'mechanics';
  const area = isMechanics ? mechanicsArea(draft.area) : null;
  const pitchLog = notePitchLog(draft);
  const isPitch = !!pitchLog;
  const isPitchingCat = pitchLog === 'pitching';
  const resultOptions = isPitchingCat ? PITCHING_RESULT_OPTIONS : HITTING_RESULT_OPTIONS;
  const pitches = draft.pitches || [];
  // #418: deficiencies = the area's checklist (src/mechanicsDeficiencies.js)
  // plus anything the coach types in. Both are stored as plain strings.
  const deficiencies = draft.deficiencies || [];
  const [customDeficiency, setCustomDeficiency] = useState('');
  const toggleDeficiency = (d) => setDraft({
    ...draft,
    deficiencies: deficiencies.includes(d) ? deficiencies.filter(x => x !== d) : [...deficiencies, d],
  });
  const addCustomDeficiency = () => {
    const d = customDeficiency.trim();
    if (!d) return;
    if (!deficiencies.includes(d)) setDraft({ ...draft, deficiencies: [...deficiencies, d] });
    setCustomDeficiency('');
  };
  const customFlagged = area ? deficiencies.filter(d => !area.deficiencies.includes(d)) : deficiencies;
  // Drills + source link for every flagged deficiency that's in the PDF list.
  const flaggedInfo = area ? deficiencies.map(d => mechanicsDeficiencyInfo(area.value, d)).filter(Boolean) : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center space-x-2">
          <label className="text-sm font-medium text-gray-700">Category:</label>
          <select
            value={draft.category}
            onChange={(e) => {
              const category = e.target.value;
              const keep = category === 'mechanics';
              setDraft({ ...draft, category, area: keep ? draft.area : '', deficiencies: keep ? deficiencies : [] });
            }}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {NOTE_CATEGORIES.map(cat => (
              <option key={cat.value} value={cat.value}>{cat.label}</option>
            ))}
          </select>
        </div>
        {isMechanics && (
          <div className="flex items-center space-x-2">
            <label className="text-sm font-medium text-gray-700">Area:</label>
            <select
              value={draft.area || ''}
              onChange={(e) => setDraft({ ...draft, area: e.target.value, deficiencies: [], pitches: [] })}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select…</option>
              {MECHANICS_AREAS.map(a => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>
        )}
        {isPitch && (
          <div className="flex items-center space-x-2">
            <label className="text-sm font-medium text-gray-700">Context:</label>
            <select
              value={draft.context || ''}
              onChange={(e) => setDraft({ ...draft, context: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select…</option>
              {NOTE_CONTEXT_OPTIONS.map(c => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <textarea
        value={draft.content}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        placeholder={isPitch
          ? (isPitchingCat ? 'Notes (overall outing, opponent, conditions...)' : 'Notes (how you were pitched, opponent, conditions...)')
          : 'Write a note...'}
        rows={3}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
      />

      {isMechanics && area && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-700">Deficiencies — {area.label}</span>
            <span className="text-xs text-gray-500">{deficiencies.length} flagged</span>
          </div>
          {area.groups.length > 0 ? (
            area.groups.map(g => (
              <div key={g.name} className="mb-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-1">{g.name}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map(item => (
                    <button
                      type="button"
                      key={item.name}
                      onClick={() => toggleDeficiency(item.name)}
                      title={`${item.drills} — ${item.link.label}`}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${deficiencies.includes(item.name) ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500 italic mb-2">The {area.label} deficiency list hasn't been loaded yet — type them in below for now.</p>
          )}
          {customFlagged.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {customFlagged.map(d => (
                <span key={d} className="px-2.5 py-1 rounded-full text-xs font-medium bg-red-600 text-white flex items-center gap-1">
                  {d}
                  <button type="button" onClick={() => toggleDeficiency(d)} className="hover:text-red-200" title="Remove"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {flaggedInfo.length > 0 && (
            <div className="border-t border-amber-200 pt-2 mb-2 space-y-1">
              <div className="text-xs font-semibold text-gray-700">Corrective drills</div>
              {flaggedInfo.map(info => (
                <div key={info.name} className="text-xs text-gray-700">
                  <span className="font-medium text-red-700">{info.name}:</span> {info.drills}
                  {info.link?.url && (
                    <> · <a href={info.link.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{info.link.label}</a></>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={customDeficiency}
              onChange={(e) => setCustomDeficiency(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomDeficiency(); } }}
              placeholder="Add a deficiency…"
              className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            />
            <button type="button" onClick={addCustomDeficiency} className="px-2.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition">Add</button>
          </div>
        </div>
      )}

      {isPitch && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-700">
              {isPitchingCat ? 'Pitches Thrown' : 'Pitches Seen'} ({pitches.length})
            </span>
            <button
              type="button"
              onClick={addPitch}
              className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition flex items-center space-x-1"
            >
              <Plus size={12} />
              <span>Add pitch</span>
            </button>
          </div>
          {pitches.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No pitches logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600 uppercase tracking-wide w-8">#</th>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600 uppercase tracking-wide">Pitch</th>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600 uppercase tracking-wide">Location</th>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600 uppercase tracking-wide">Result</th>
                    <th className="px-2 py-1 text-left font-semibold text-gray-600 uppercase tracking-wide">Notes</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {pitches.map((p, i) => (
                    <tr key={i} className="border-t border-gray-200">
                      <td className="px-2 py-1 text-gray-500">{i + 1}</td>
                      <td className="px-1 py-1">
                        <select
                          value={p.pitch_type || ''}
                          onChange={(e) => updatePitch(i, 'pitch_type', e.target.value)}
                          className="w-full px-1 py-1 border border-gray-200 rounded text-xs bg-white"
                        >
                          <option value="">—</option>
                          {PITCH_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <select
                          value={p.location || ''}
                          onChange={(e) => updatePitch(i, 'location', e.target.value)}
                          className="w-full px-1 py-1 border border-gray-200 rounded text-xs bg-white"
                        >
                          <option value="">—</option>
                          {PITCH_LOCATION_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <select
                          value={p.result || ''}
                          onChange={(e) => updatePitch(i, 'result', e.target.value)}
                          className="w-full px-1 py-1 border border-gray-200 rounded text-xs bg-white"
                        >
                          <option value="">—</option>
                          {resultOptions.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="text"
                          value={p.notes || ''}
                          onChange={(e) => updatePitch(i, 'notes', e.target.value)}
                          placeholder="(optional)"
                          className="w-full px-1 py-1 border border-gray-200 rounded text-xs bg-white"
                        />
                      </td>
                      <td className="px-1 py-1 text-right">
                        <button
                          type="button"
                          onClick={() => removePitch(i)}
                          className="text-gray-400 hover:text-red-600"
                          title="Remove pitch"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PtVisitEditor({ draft, setDraft, addExercise, updateExercise, removeExercise }) {
  const exercises = draft.exercises || [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Visit date *</label>
          <input
            type="date"
            value={draft.visit_date}
            onChange={(e) => setDraft({ ...draft, visit_date: e.target.value })}
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Visit type</label>
          <select
            value={draft.visit_type || ''}
            onChange={(e) => setDraft({ ...draft, visit_type: e.target.value })}
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">—</option>
            {PT_VISIT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Body area</label>
          <select
            value={draft.body_area || ''}
            onChange={(e) => setDraft({ ...draft, body_area: e.target.value })}
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">—</option>
            {PT_BODY_AREAS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Pain (0–10)</label>
          <input
            type="number"
            min="0"
            max="10"
            value={draft.pain_level}
            onChange={(e) => setDraft({ ...draft, pain_level: e.target.value })}
            placeholder="—"
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
        <textarea
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          rows={3}
          placeholder="Treatment notes, range of motion, observations..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-gray-700">Exercises / Home Plan ({exercises.length})</span>
          <button
            type="button"
            onClick={addExercise}
            className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition flex items-center space-x-1"
          >
            <Plus size={12} />
            <span>Add exercise</span>
          </button>
        </div>
        {exercises.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No exercises added.</p>
        ) : (
          <div className="space-y-2">
            {exercises.map((ex, i) => (
              /* #321: at 375px a 12-column grid gave the Sets and Reps inputs ~45px
                 each — too narrow to read what you just typed. Below sm the fields
                 stack onto their own rows; sm+ keeps the original 12-col layout. */
              <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-center">
                <input
                  type="text"
                  placeholder="Exercise name"
                  value={ex.name || ''}
                  onChange={(e) => updateExercise(i, 'name', e.target.value)}
                  className="col-span-2 sm:col-span-4 px-2 py-1.5 border border-gray-200 rounded text-sm sm:text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="text"
                  placeholder="Sets"
                  value={ex.sets || ''}
                  onChange={(e) => updateExercise(i, 'sets', e.target.value)}
                  className="col-span-1 sm:col-span-2 px-2 py-1.5 border border-gray-200 rounded text-sm sm:text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="text"
                  placeholder="Reps"
                  value={ex.reps || ''}
                  onChange={(e) => updateExercise(i, 'reps', e.target.value)}
                  className="col-span-1 sm:col-span-2 px-2 py-1.5 border border-gray-200 rounded text-sm sm:text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="text"
                  placeholder="Notes (optional)"
                  value={ex.notes || ''}
                  onChange={(e) => updateExercise(i, 'notes', e.target.value)}
                  className="col-span-1 sm:col-span-3 px-2 py-1.5 border border-gray-200 rounded text-sm sm:text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => removeExercise(i)}
                  className="col-span-1 justify-self-end sm:justify-self-auto text-gray-400 hover:text-red-600"
                  title="Remove exercise"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Follow-up date (optional)</label>
        <input
          type="date"
          value={draft.follow_up_at}
          onChange={(e) => setDraft({ ...draft, follow_up_at: e.target.value })}
          className="px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    </div>
  );
}

// ============================================
// PRACTICE STATS TAB (#186)
// Track at-bats during practice, lives, cage, fall ball, scrimmage.
// ============================================
const AB_RESULTS = ['1B', '2B', '3B', 'HR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'PO', 'FC', 'SAC'];
const AB_CONTEXTS = [
  { value: 'practice', label: 'Practice' },
  { value: 'lives', label: 'Lives' },
  { value: 'scrimmage', label: 'Scrimmage' },
  { value: 'fall_ball', label: 'Fall Ball' },
  { value: 'cage', label: 'Cage' },
  { value: 'other', label: 'Other' },
];
const HIT_RESULTS = ['1B', '2B', '3B', 'HR'];
const AB_OUTCOMES = ['1B', '2B', '3B', 'HR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'PO', 'FC', 'SAC'];
const OFFICIAL_AB = ['1B', '2B', '3B', 'HR', 'K', 'GO', 'FO', 'LO', 'PO', 'FC'];

function PracticeStatsTab({ playerId, canEdit }) {
  // #192: mode toggle between hitting / pitching / catching.
  const [mode, setMode] = useState('hitting');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b border-gray-200 pb-3">
        {[
          { key: 'hitting', label: 'Hitting' },
          { key: 'pitching', label: 'Pitching' },
          { key: 'catching', label: 'Catching' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setMode(t.key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${mode === t.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {mode === 'hitting' && <HittingStatsView playerId={playerId} canEdit={canEdit} />}
      {mode === 'pitching' && (
        <div className="space-y-8">
          {/* #463: whole-outing line first; most athletes only have the box score. */}
          <PitchingOutingsView playerId={playerId} canEdit={canEdit} />
          <PitchingStatsView playerId={playerId} canEdit={canEdit} />
        </div>
      )}
      {mode === 'catching' && <CatchingStatsView playerId={playerId} canEdit={canEdit} />}
    </div>
  );
}

function HittingStatsView({ playerId, canEdit }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    ab_date: fmtLocalDate(new Date()),
    context: 'practice',
    pitcher_name: '',
    pitch_type: '',
    result: '1B',
    exit_velocity: '',
    launch_angle: '',
    distance: '',
    notes: '',
  });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('practice_at_bats')
      .select('*')
      .eq('player_id', playerId)
      .order('ab_date', { ascending: false })
      .order('created_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [playerId]);

  const totals = useMemo(() => {
    const ab = rows.filter(r => OFFICIAL_AB.includes(r.result)).length;
    const hits = rows.filter(r => HIT_RESULTS.includes(r.result)).length;
    const tb = rows.reduce((sum, r) => {
      if (r.result === '1B') return sum + 1;
      if (r.result === '2B') return sum + 2;
      if (r.result === '3B') return sum + 3;
      if (r.result === 'HR') return sum + 4;
      return sum;
    }, 0);
    const bb = rows.filter(r => r.result === 'BB').length;
    const hbp = rows.filter(r => r.result === 'HBP').length;
    const onBaseAttempts = ab + bb + hbp;
    const onBaseSuccess = hits + bb + hbp;
    return {
      total: rows.length,
      ab,
      hits,
      avg: ab ? (hits / ab).toFixed(3) : '—',
      slg: ab ? (tb / ab).toFixed(3) : '—',
      obp: onBaseAttempts ? (onBaseSuccess / onBaseAttempts).toFixed(3) : '—',
      bb,
      k: rows.filter(r => r.result === 'K').length,
    };
  }, [rows]);

  const save = async () => {
    if (!draft.ab_date || !draft.result) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('practice_at_bats').insert({
      player_id: playerId,
      ab_date: draft.ab_date,
      context: draft.context,
      pitcher_name: draft.pitcher_name || null,
      pitch_type: draft.pitch_type || null,
      result: draft.result,
      exit_velocity: draft.exit_velocity ? Number(draft.exit_velocity) : null,
      launch_angle: draft.launch_angle ? Number(draft.launch_angle) : null,
      distance: draft.distance ? Number(draft.distance) : null,
      notes: draft.notes || null,
      logged_by: user?.id || null,
    });
    if (error) { alert('Save failed: ' + formatUserError(error)); return; }
    setAdding(false);
    setDraft({ ab_date: fmtLocalDate(new Date()), context: 'practice', pitcher_name: '', pitch_type: '', result: '1B', exit_velocity: '', launch_angle: '', distance: '', notes: '' });
    load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this at-bat?')) return;
    await supabase.from('practice_at_bats').delete().eq('id', id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Practice Stats</h3>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center space-x-1">
            <Plus size={16} />
            <span>Log At-Bat</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 text-center">
        {[
          { label: 'AB', val: totals.ab },
          { label: 'H', val: totals.hits },
          { label: 'AVG', val: totals.avg },
          { label: 'OBP', val: totals.obp },
          { label: 'SLG', val: totals.slg },
          { label: 'BB', val: totals.bb },
          { label: 'K', val: totals.k },
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
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Date</label>
              <input type="date" value={draft.ab_date} onChange={e => setDraft({ ...draft, ab_date: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Context</label>
              <select value={draft.context} onChange={e => setDraft({ ...draft, context: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                {AB_CONTEXTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Result</label>
              <select value={draft.result} onChange={e => setDraft({ ...draft, result: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
                {AB_OUTCOMES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Pitch Type</label>
              <input type="text" value={draft.pitch_type} onChange={e => setDraft({ ...draft, pitch_type: e.target.value })} placeholder="FB / CB / SL" className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Pitcher</label>
              <input type="text" value={draft.pitcher_name} onChange={e => setDraft({ ...draft, pitcher_name: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Exit Velo</label>
              <input type="number" step="0.1" value={draft.exit_velocity} onChange={e => setDraft({ ...draft, exit_velocity: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Launch Angle</label>
              <input type="number" step="0.1" value={draft.launch_angle} onChange={e => setDraft({ ...draft, launch_angle: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Distance</label>
              <input type="number" step="0.1" value={draft.distance} onChange={e => setDraft({ ...draft, distance: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm">Cancel</button>
            <button onClick={save} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">Save</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 text-center py-6">Loading at-bats...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No at-bats logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Context</th>
                <th className="px-3 py-2 text-left">Pitcher</th>
                <th className="px-3 py-2 text-left">Pitch</th>
                <th className="px-3 py-2 text-center">Result</th>
                <th className="px-3 py-2 text-center">EV</th>
                <th className="px-3 py-2 text-center">LA</th>
                <th className="px-3 py-2 text-center">Dist</th>
                <th className="px-3 py-2 text-left">Notes</th>
                {canEdit && <th className="px-3 py-2 w-10"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.ab_date}</td>
                  <td className="px-3 py-2 text-gray-700 capitalize">{(AB_CONTEXTS.find(c => c.value === r.context)?.label) || r.context}</td>
                  <td className="px-3 py-2 text-gray-700">{r.pitcher_name || '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{r.pitch_type || '—'}</td>
                  <td className="px-3 py-2 text-center font-semibold">
                    <span className={`px-2 py-0.5 rounded text-xs ${HIT_RESULTS.includes(r.result) ? 'bg-green-100 text-green-700' : r.result === 'K' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>{r.result}</span>
                  </td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.exit_velocity ?? '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.launch_angle ?? '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.distance ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.notes || ''}</td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => remove(r.id)} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================
// PITCHING STATS VIEW (#192)
// ============================================
const PITCH_CONTEXTS = [
  { value: 'bullpen', label: 'Bullpen' },
  { value: 'lives', label: 'Lives' },
  { value: 'scrimmage', label: 'Scrimmage' },
  { value: 'practice', label: 'Practice' },
  { value: 'cage', label: 'Cage' },
  { value: 'long_toss', label: 'Long Toss' },
  { value: 'other', label: 'Other' },
];
const PITCH_RESULTS = ['strike', 'ball', 'foul', 'swing_miss', 'in_play', 'k', 'bb', 'hbp', 'hit', 'out'];

function PitchingStatsView({ playerId, canEdit }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    log_date: fmtLocalDate(new Date()),
    context: 'bullpen',
    pitch_type: '',
    velocity: '',
    spin_rate: '',
    location: '',
    result: 'strike',
    pitch_count: '',
    notes: '',
  });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('practice_pitches')
      .select('*')
      .eq('player_id', playerId)
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [playerId]);

  const totals = useMemo(() => {
    const total = rows.length;
    const strikes = rows.filter(r => ['strike', 'foul', 'swing_miss', 'in_play', 'k'].includes(r.result)).length;
    const swingMiss = rows.filter(r => r.result === 'swing_miss').length;
    const velos = rows.map(r => r.velocity).filter(v => v != null);
    const maxVelo = velos.length ? Math.max(...velos) : '—';
    const avgVelo = velos.length ? (velos.reduce((a, b) => a + b, 0) / velos.length).toFixed(1) : '—';
    return {
      total,
      strikes,
      strikePct: total ? `${Math.round(strikes / total * 100)}%` : '—',
      swingMiss,
      maxVelo,
      avgVelo,
    };
  }, [rows]);

  const save = async () => {
    if (!draft.log_date) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('practice_pitches').insert({
      player_id: playerId,
      log_date: draft.log_date,
      context: draft.context,
      pitch_type: draft.pitch_type || null,
      velocity: draft.velocity ? Number(draft.velocity) : null,
      spin_rate: draft.spin_rate ? Number(draft.spin_rate) : null,
      location: draft.location || null,
      result: draft.result || null,
      pitch_count: draft.pitch_count ? Number(draft.pitch_count) : null,
      notes: draft.notes || null,
      logged_by: user?.id || null,
    });
    if (error) { alert('Save failed: ' + formatUserError(error)); return; }
    setAdding(false);
    setDraft({ log_date: fmtLocalDate(new Date()), context: 'bullpen', pitch_type: '', velocity: '', spin_rate: '', location: '', result: 'strike', pitch_count: '', notes: '' });
    load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this pitch?')) return;
    await supabase.from('practice_pitches').delete().eq('id', id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Pitch by pitch</h3>
          <p className="text-xs text-gray-500">One row per pitch, when you have them.</p>
        </div>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className="bg-white border border-blue-600 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-50 flex items-center space-x-1">
            <Plus size={16} />
            <span>Log Pitch</span>
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-center">
        {[
          { label: 'Pitches', val: totals.total },
          { label: 'Strikes', val: totals.strikes },
          { label: 'Strike %', val: totals.strikePct },
          { label: 'Swing/Miss', val: totals.swingMiss },
          { label: 'Max Velo', val: totals.maxVelo },
          { label: 'Avg Velo', val: totals.avgVelo },
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
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Date</label><input type="date" value={draft.log_date} onChange={e => setDraft({ ...draft, log_date: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Context</label><select value={draft.context} onChange={e => setDraft({ ...draft, context: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">{PITCH_CONTEXTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Pitch Type</label><input value={draft.pitch_type} onChange={e => setDraft({ ...draft, pitch_type: e.target.value })} placeholder="FB/CB/SL/CH" className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Result</label><select value={draft.result} onChange={e => setDraft({ ...draft, result: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">{PITCH_RESULTS.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Velo (mph)</label><input type="number" step="0.1" value={draft.velocity} onChange={e => setDraft({ ...draft, velocity: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Spin (rpm)</label><input type="number" value={draft.spin_rate} onChange={e => setDraft({ ...draft, spin_rate: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Location</label><input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} placeholder="e.g., low and away" className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Pitch #</label><input type="number" value={draft.pitch_count} onChange={e => setDraft({ ...draft, pitch_count: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
          </div>
          <div><label className="block text-xs font-medium text-gray-700 mb-1">Notes</label><textarea value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm">Cancel</button>
            <button onClick={save} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">Save</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 text-center py-6">Loading pitches...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No pitches logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Context</th>
                <th className="px-3 py-2 text-left">Pitch</th>
                <th className="px-3 py-2 text-center">Velo</th>
                <th className="px-3 py-2 text-center">Spin</th>
                <th className="px-3 py-2 text-left">Location</th>
                <th className="px-3 py-2 text-center">Result</th>
                <th className="px-3 py-2 text-left">Notes</th>
                {canEdit && <th className="px-3 py-2 w-10"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.log_date}</td>
                  <td className="px-3 py-2 text-gray-700 capitalize">{(PITCH_CONTEXTS.find(c => c.value === r.context)?.label) || r.context}</td>
                  <td className="px-3 py-2 text-gray-700">{r.pitch_type || '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.velocity ?? '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.spin_rate ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{r.location || '—'}</td>
                  <td className="px-3 py-2 text-center capitalize">{r.result || '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.notes || ''}</td>
                  {canEdit && <td className="px-3 py-2 text-right"><button onClick={() => remove(r.id)} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================
// CATCHING STATS VIEW (#192)
// ============================================
const CATCH_DRILLS = [
  { value: 'pop_time', label: 'Pop Time' },
  { value: 'framing', label: 'Framing' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'throwdown', label: 'Throwdown' },
  { value: 'receiving', label: 'Receiving' },
  { value: 'other', label: 'Other' },
];
const CATCH_CONTEXTS = [
  { value: 'practice', label: 'Practice' },
  { value: 'lives', label: 'Lives' },
  { value: 'scrimmage', label: 'Scrimmage' },
  { value: 'bullpen', label: 'Bullpen' },
  { value: 'cage', label: 'Cage' },
  { value: 'other', label: 'Other' },
];

function CatchingStatsView({ playerId, canEdit }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    log_date: fmtLocalDate(new Date()),
    context: 'practice',
    drill_type: 'pop_time',
    pop_time_sec: '',
    throwdown_accuracy: '',
    block_attempts: '',
    block_clean: '',
    framing_grade: '',
    notes: '',
  });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('practice_catching')
      .select('*')
      .eq('player_id', playerId)
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false });
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [playerId]);

  const totals = useMemo(() => {
    const popTimes = rows.filter(r => r.drill_type === 'pop_time' && r.pop_time_sec != null).map(r => Number(r.pop_time_sec));
    const blockAttempts = rows.reduce((s, r) => s + (Number(r.block_attempts) || 0), 0);
    const blockClean = rows.reduce((s, r) => s + (Number(r.block_clean) || 0), 0);
    return {
      total: rows.length,
      bestPop: popTimes.length ? Math.min(...popTimes).toFixed(2) : '—',
      avgPop: popTimes.length ? (popTimes.reduce((a, b) => a + b, 0) / popTimes.length).toFixed(2) : '—',
      blockPct: blockAttempts ? `${Math.round(blockClean / blockAttempts * 100)}%` : '—',
    };
  }, [rows]);

  const save = async () => {
    if (!draft.log_date || !draft.drill_type) return;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('practice_catching').insert({
      player_id: playerId,
      log_date: draft.log_date,
      context: draft.context,
      drill_type: draft.drill_type,
      pop_time_sec: draft.pop_time_sec ? Number(draft.pop_time_sec) : null,
      throwdown_accuracy: draft.throwdown_accuracy || null,
      block_attempts: draft.block_attempts ? Number(draft.block_attempts) : null,
      block_clean: draft.block_clean ? Number(draft.block_clean) : null,
      framing_grade: draft.framing_grade || null,
      notes: draft.notes || null,
      logged_by: user?.id || null,
    });
    if (error) { alert('Save failed: ' + formatUserError(error)); return; }
    setAdding(false);
    setDraft({ log_date: fmtLocalDate(new Date()), context: 'practice', drill_type: 'pop_time', pop_time_sec: '', throwdown_accuracy: '', block_attempts: '', block_clean: '', framing_grade: '', notes: '' });
    load();
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this entry?')) return;
    await supabase.from('practice_catching').delete().eq('id', id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Catching Stats</h3>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center space-x-1">
            <Plus size={16} />
            <span>Log Entry</span>
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
        {[
          { label: 'Entries', val: totals.total },
          { label: 'Best Pop', val: totals.bestPop },
          { label: 'Avg Pop', val: totals.avgPop },
          { label: 'Block %', val: totals.blockPct },
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
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Date</label><input type="date" value={draft.log_date} onChange={e => setDraft({ ...draft, log_date: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Context</label><select value={draft.context} onChange={e => setDraft({ ...draft, context: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">{CATCH_CONTEXTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Drill</label><select value={draft.drill_type} onChange={e => setDraft({ ...draft, drill_type: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm">{CATCH_DRILLS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}</select></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Pop Time (sec)</label><input type="number" step="0.01" value={draft.pop_time_sec} onChange={e => setDraft({ ...draft, pop_time_sec: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Throwdown</label><input value={draft.throwdown_accuracy} onChange={e => setDraft({ ...draft, throwdown_accuracy: e.target.value })} placeholder="e.g., on-bag" className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Block Att.</label><input type="number" value={draft.block_attempts} onChange={e => setDraft({ ...draft, block_attempts: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Block Clean</label><input type="number" value={draft.block_clean} onChange={e => setDraft({ ...draft, block_clean: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Framing</label><select value={draft.framing_grade} onChange={e => setDraft({ ...draft, framing_grade: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"><option value="">—</option>{['A','B','C','D','F'].map(g => <option key={g} value={g}>{g}</option>)}</select></div>
          </div>
          <div><label className="block text-xs font-medium text-gray-700 mb-1">Notes</label><textarea value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm">Cancel</button>
            <button onClick={save} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">Save</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 text-center py-6">Loading entries...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No catching entries logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Context</th>
                <th className="px-3 py-2 text-left">Drill</th>
                <th className="px-3 py-2 text-center">Pop</th>
                <th className="px-3 py-2 text-left">Throwdown</th>
                <th className="px-3 py-2 text-center">Block</th>
                <th className="px-3 py-2 text-center">Framing</th>
                <th className="px-3 py-2 text-left">Notes</th>
                {canEdit && <th className="px-3 py-2 w-10"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{r.log_date}</td>
                  <td className="px-3 py-2 text-gray-700 capitalize">{(CATCH_CONTEXTS.find(c => c.value === r.context)?.label) || r.context}</td>
                  <td className="px-3 py-2 text-gray-700">{(CATCH_DRILLS.find(d => d.value === r.drill_type)?.label) || r.drill_type}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.pop_time_sec ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700">{r.throwdown_accuracy || '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{r.block_attempts ? `${r.block_clean ?? 0}/${r.block_attempts}` : '—'}</td>
                  <td className="px-3 py-2 text-center text-gray-700">{r.framing_grade || '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{r.notes || ''}</td>
                  {canEdit && <td className="px-3 py-2 text-right"><button onClick={() => remove(r.id)} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================
// MAREK TAB (#193)
// Bloodwork panels uploaded per-player. Files live in 'bloodwork' bucket.
// ============================================
function MarekTab({ playerId, canEdit, dateOfBirth }) {
  const [panels, setPanels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    panel_date: fmtLocalDate(new Date()),
    panel_type: '',
    summary: '',
    follow_up_at: '',
    file: null,
  });
  const [uploading, setUploading] = useState(false);
  const [marekCode, setMarekCode] = useState(null);

  const playerAge = dateOfBirth
    ? Math.floor((new Date() - new Date(dateOfBirth + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000))
    : null;
  const isEligible = playerAge !== null && playerAge >= 18;

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('marek_panels')
      .select('*')
      .eq('player_id', playerId)
      .order('panel_date', { ascending: false });
    setPanels(data || []);
    setLoading(false);
  };

  const loadMarekCode = async () => {
    const { data } = await supabase
      .from('discount_codes')
      .select('code')
      .eq('player_id', playerId)
      .ilike('vendor', '%marek%')
      .limit(1)
      .maybeSingle();
    setMarekCode(data?.code || null);
  };

  useEffect(() => { load(); loadMarekCode(); }, [playerId]);

  const save = async () => {
    if (!draft.panel_date) { alert('Panel date is required.'); return; }
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    let file_url = null, file_name = null;
    if (draft.file) {
      // CH1: sanitize filename — strip directory components, normalize unicode,
      // collapse runs of unsafe chars to a single dash, cap length. Stops
      // `../../foo.pdf` style names from escaping the player-id folder even
      // if Supabase Storage relaxes path checks in the future.
      const rawName = draft.file.name || 'file';
      const safeName = rawName
        .split(/[\\/]/).pop()
        .normalize('NFKD')
        .replace(/[^\w.\-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'file';
      const path = `${playerId}/${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from('bloodwork').upload(path, draft.file, { upsert: false });
      if (upErr) { setUploading(false); alert('Upload failed: ' + formatUserError(upErr)); return; }
      file_url = path;
      file_name = safeName;
    }
    const { error } = await supabase.from('marek_panels').insert({
      player_id: playerId,
      panel_date: draft.panel_date,
      panel_type: draft.panel_type || null,
      summary: draft.summary || null,
      follow_up_at: draft.follow_up_at || null,
      file_url,
      file_name,
      uploaded_by: user?.id || null,
    });
    setUploading(false);
    if (error) { alert('Save failed: ' + formatUserError(error)); return; }
    setAdding(false);
    setDraft({ panel_date: fmtLocalDate(new Date()), panel_type: '', summary: '', follow_up_at: '', file: null });
    load();
  };

  const remove = async (panel) => {
    if (!window.confirm('Delete this panel and its file?')) return;
    if (panel.file_url) await supabase.storage.from('bloodwork').remove([panel.file_url]);
    await supabase.from('marek_panels').delete().eq('id', panel.id);
    load();
  };

  const downloadFile = async (panel) => {
    if (!panel.file_url) return;
    const { data, error } = await supabase.storage.from('bloodwork').createSignedUrl(panel.file_url, 600);
    if (error || !data) { alert('Could not generate file link.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      {/* Marek Health Instructions */}
      <div className="border border-teal-200 bg-teal-50 rounded-lg p-4 space-y-3">
        <h3 className="text-lg font-semibold text-gray-900">Marek Health Partnership</h3>
        {!isEligible ? (
          <p className="text-sm text-gray-600">
            {playerAge === null
              ? 'Date of birth is required to determine eligibility. Please update your profile.'
              : `This service is available for athletes 18 and older. Current age: ${playerAge}.`}
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-700 leading-relaxed">
              Please fill out the link below and use your discount code during setup — it will run on our end so we can confirm you completed the process. Once finished, Marek Health will reach out within 24 hours to schedule your LabCorp appointment for blood work. They will send you instructions to follow before and after your appointment. <span className="font-semibold">Make sure to not go to the bathroom before your appointment as they do urine analysis too.</span>
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <a
                href="https://marekhealth.com/coach"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-teal-700 font-semibold hover:text-teal-900 hover:underline"
              >
                <ExternalLink size={14} />
                MarekHealth.com/coach
              </a>
              {marekCode ? (
                <span className="inline-flex items-center gap-1.5 bg-teal-100 text-teal-800 px-3 py-1 rounded-md text-sm font-mono font-semibold">
                  Discount Code: {marekCode}
                </span>
              ) : (
                <span className="text-sm text-gray-500 italic">No discount code assigned yet.</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Bloodwork Panels */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Bloodwork Panels</h3>
          <p className="text-sm text-gray-500">Upload lab results from the Marek partnership.</p>
        </div>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center space-x-1">
            <Plus size={16} />
            <span>Add Panel</span>
          </button>
        )}
      </div>
      {adding && (
        <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Panel Date *</label><input type="date" value={draft.panel_date} onChange={e => setDraft({ ...draft, panel_date: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Panel Type</label><input value={draft.panel_type} onChange={e => setDraft({ ...draft, panel_type: e.target.value })} placeholder="e.g., Hormone, Comprehensive" className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
            <div><label className="block text-xs font-medium text-gray-700 mb-1">Follow-up Date</label><input type="date" value={draft.follow_up_at} onChange={e => setDraft({ ...draft, follow_up_at: e.target.value })} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
          </div>
          <div><label className="block text-xs font-medium text-gray-700 mb-1">Summary / Key Findings</label><textarea value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} rows={3} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm" /></div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">PDF Report (optional)</label>
            <input type="file" accept="application/pdf,image/*" onChange={e => setDraft({ ...draft, file: e.target.files?.[0] || null })} className="w-full text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} disabled={uploading} className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm">Cancel</button>
            <button onClick={save} disabled={uploading} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">{uploading ? 'Uploading...' : 'Save'}</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 text-center py-6">Loading panels...</p>
      ) : panels.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <FileText size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm">No Marek panels uploaded yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {panels.map(p => (
            <div key={p.id} className="border border-gray-200 rounded-lg p-4 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-semibold text-gray-900">{p.panel_type || 'Panel'}</h4>
                    <span className="text-sm text-gray-500">{p.panel_date}</span>
                    {p.follow_up_at && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Follow-up {p.follow_up_at}</span>
                    )}
                  </div>
                  {p.summary && <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{p.summary}</p>}
                  {p.file_url && (
                    <button onClick={() => downloadFile(p)} className="mt-2 text-sm text-blue-600 hover:text-blue-800 inline-flex items-center gap-1">
                      <Paperclip size={14} />
                      <span>{p.file_name || 'View report'}</span>
                    </button>
                  )}
                </div>
                {canEdit && (
                  <button onClick={() => remove(p)} className="text-gray-400 hover:text-red-600 flex-shrink-0"><Trash2 size={14} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
