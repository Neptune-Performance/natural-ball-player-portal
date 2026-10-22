import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from './supabaseClient';
import { fetchUserDirectory, readDirectory } from './userDirectory';
import { Calendar as CalendarIcon, MessageSquare, ChevronLeft, ChevronRight, Plus, X, Users, User, UserCheck, Dumbbell, Utensils, Trash2, Edit2, Building, MapPin, AlignLeft, Repeat, Clock, Check, ClipboardList, Apple, Search, ExternalLink, CheckSquare, History, Copy, DollarSign, AlertTriangle, UserCog, LayoutGrid } from 'lucide-react';
import { fmtLocalDate, expandRecurringEvents, monthWeekRange, buildSlotExceptionMap, getSlotDateException, collectMovedSlots, upsertFacilityException, deleteFacilityOccurrence, deleteFacilitySeries, deleteFacilityFuture, countFacilitySeriesImpact, countSignupsForEvents, facilitySeriesDeleteWarning, DELETE_CANCELLED, placeProgramDays } from './scheduleUtils';
import CalendarContextMenu from './CalendarContextMenu';
import RecurrenceDecisionModal from './RecurrenceDecisionModal';
import LaneMoveDecisionModal from './LaneMoveDecisionModal';
import CopyToPickerModal from './CopyToPickerModal';
import ProgramLibrarySidebar, { compareTemplates } from './ProgramLibrarySidebar';
import CalendarSyncModal from './CalendarSyncModal';
import MessageCoachModal from './MessageCoachModal'; // #407
import { formatUserError } from './errorMessage';
import { useModalTracking, trackAction } from './usage';
import { COACH_SKILL_OPTIONS } from './skillOptions';
import { allowancesForPurchases, sessionClass, weekRangeForDate, capWarningMessage, weeklyFrequencyFromName, SESSION_SC } from './bookingCaps';
import { CreateUserModal } from './AdminSettings';
import { familyKey, familyLabel, sameFamily } from './productFamily';
import { applySessionUsage } from './sessionUsage';
import { CANCEL_REASON_ATHLETE } from './cancelReasons';
// #277: per-occurrence RSVP (Going / Not going / Maybe) + coach roster & nudge.
import { EventRsvpSection } from './EventRsvp';
import { readAllPages } from './readAllPages';
import PublicBookingPage from './PublicBookingPage'; // #452
import ExerciseLogInput from './ExerciseLogInput'; // #460
import ExerciseHistoryModal from './ExerciseHistoryModal'; // #461
import { logOwnerForEvent, canLogWorkout, parseWeight, exerciseNameKey, fetchWorkoutLogs, fetchLastLogs, saveExerciseLog, deleteExerciseLog, MAX_WEIGHT } from './exerciseLogs';

// #347 QA: every path that would wipe a whole facility series asks here first,
// so the warning and its numbers can never differ between the Delete button on
// the event card and the right-click menu. `master` is optional — pass it when
// the caller already has the series row, otherwise it is read here so the date
// count is measured from the series' own start, not from whichever occurrence
// happens to be open. Returns true only if the user said yes.
async function confirmWholeFacilitySeriesDelete(masterId, master, lead) {
  let seriesRow = master;
  if (!seriesRow) {
    const { data } = await supabase
      .from('facility_events').select('recurrence_rule, event_date').eq('id', masterId).maybeSingle();
    seriesRow = data || null;
  }
  const counts = await countFacilitySeriesImpact(supabase, masterId, seriesRow);
  return window.confirm(facilitySeriesDeleteWarning(counts, lead));
}

// #347 QA: shown when "Delete this and future events" is picked on the first
// date of a series, where it quietly means "delete everything".
const WHOLE_SERIES_FROM_FUTURE_LEAD =
  'Delete the ENTIRE repeating series?\n\nThere are no dates in this series before this one, so "Delete this and future events" '
  + 'here removes the whole thing — nothing would be left.';

const WHOLE_SERIES_LEAD = 'Delete the ENTIRE repeating series?';

// #347 QA: asked before Escape or a backdrop click throws away a half-filled
// edit form. Same wording FacilityEventDetail already uses.
const DISCARD_EDITS_PROMPT = 'Discard your unsaved changes to this event?';

// Format a time string (e.g. "14:00" or "2:30 PM") to 12-hour AM/PM
function formatTimeDisplay(time) {
  if (!time) return '';
  // Already has AM/PM — return as-is
  if (/[ap]m/i.test(time)) return time;
  const parts = time.match(/^(\d{1,2}):(\d{2})/);
  if (!parts) return time;
  const h = parseInt(parts[1], 10);
  const m = parts[2];
  return `${h % 12 || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Get the week range label for a given date (e.g. "May 12 – May 18, 2026")
function getWeekRangeLabel(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  if (start.getMonth() === end.getMonth()) {
    return `${start.toLocaleDateString('en-US', opts)} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  // Across a year boundary (Dec → Jan) show the start year too.
  if (start.getFullYear() !== end.getFullYear()) {
    const optsY = { month: 'short', day: 'numeric', year: 'numeric' };
    return `${start.toLocaleDateString('en-US', optsY)} – ${end.toLocaleDateString('en-US', optsY)}`;
  }
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}, ${end.getFullYear()}`;
}

// #276 — weekly booking caps. Returns a warning string when booking one more
// session for `playerId` on `slotDate` would exceed the allowance their package
// name implies, or null when it would not (or when we cannot tell, in which
// case we stay silent). This NEVER blocks: callers show the message and offer
// "Book anyway".
//
// Facility-wide by design: every reservation the player holds that week counts,
// whichever coach or lane it belongs to.
async function checkWeeklyBookingCap({ playerId, playerName, self, slotDate, slotId, slotSessionType, slotCoach, slotCoachId, excludeReservationId, purchases }) {
  try {
    if (!playerId || !slotDate) return null;

    // What the player owns. Same filter the reserve modal already uses for its
    // "payment confirmed" badge: currently-held, unexpired purchases.
    let owned = purchases;
    if (!owned) {
      const nowIso = new Date().toISOString();
      const { data } = await supabase
        .from('store_purchases')
        .select('product_name_snapshot, product_kind, status')
        .eq('user_id', playerId)
        .in('product_kind', ['package', 'bundle', 'lesson'])
        .in('status', ['active', 'paid'])
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`);
      owned = data || [];
    }
    // #306: per-package allowances (two pots, S&C and skills) with the #276
    // name-parse as the fallback. Null = the player holds nothing = silence.
    const allowances = allowancesForPurchases(owned);
    if (!allowances) return null;

    // Which class is the session being booked? Its own session_type first;
    // failing that, the coach's S&C skill tag (the pre-#306 rule). The coach
    // row also supplies the name for the coach-only allowance.
    let coach = slotCoach;
    if ((!coach || !Array.isArray(coach.skills) || !coach.full_name) && slotCoachId) {
      const { data } = await readDirectory('staff_directory', (t) => supabase.from(t).select('id, full_name, skills').eq('id', slotCoachId).maybeSingle());
      if (data) coach = { ...(coach || {}), ...data };
    }
    let sessionType = slotSessionType;
    if (sessionType === undefined && slotId) {
      const { data } = await supabase.from('training_slots').select('session_type').eq('id', slotId).maybeSingle();
      sessionType = data?.session_type ?? null;
    }
    const bookingClass = sessionClass({ session_type: sessionType }, coach);

    // Everything already on the player's schedule that Sun–Sat week. Only
    // live bookings count: 'cancelled' is excluded because the athlete gave the
    // spot back, and 'declined' because the coach never gave it to them — a
    // declined request is not a session they hold.
    const { startStr, endStr } = weekRangeForDate(slotDate);
    const { data: existing, error } = await supabase
      .from('slot_reservations')
      .select('id, slot_date, status, training_slots(coach_id, session_type)')
      .eq('player_id', playerId)
      .gte('slot_date', startStr)
      .lte('slot_date', endStr)
      .in('status', ['pending', 'confirmed']);
    if (error) return null; // a failed count must not stand in the way of a booking

    const rows = (existing || []).filter(r => r.id !== excludeReservationId);
    const coachIds = [...new Set(rows.map(r => r.training_slots?.coach_id).filter(Boolean))];
    let skillsByCoach = {};
    if (coachIds.length > 0) {
      const { data: coachRows } = await readDirectory('staff_directory', (t) => supabase.from(t).select('id, skills').in('id', coachIds));
      (coachRows || []).forEach(c => { skillsByCoach[c.id] = c.skills; });
    }
    const counts = { sc: 0, skills: 0 };
    rows.forEach(r => {
      const cls = sessionClass(r.training_slots, { skills: skillsByCoach[r.training_slots?.coach_id] });
      if (cls === SESSION_SC) counts.sc++; else counts.skills++;
    });

    return capWarningMessage({ playerName, self, allowances, counts, bookingClass, bookingCoachName: coach?.full_name });
  } catch (_) {
    return null; // never let the cap check break a booking
  }
}

// #276 — the warning itself. Warn, never block: Cancel backs out, the primary
// button goes ahead with the booking anyway.
function BookingCapWarningModal({ message, onCancel, onProceed, proceedLabel = 'Book anyway' }) {
  // Escape backs out, the same as the Cancel button — the safe direction, and
  // the only one: it can never be mistaken for going ahead with the booking.
  // This card is always the top layer (z-[60]) when it is up, so it owns the
  // key press outright.
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full">
        <div className="p-6 space-y-3">
          <div className="flex items-start space-x-2">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-500" />
            <div>
              <h4 className="font-semibold text-gray-900">Weekly session limit reached</h4>
              <p className="text-sm text-gray-600 mt-1">{message}</p>
            </div>
          </div>
          <div className="flex space-x-3 pt-1">
            <button onClick={onCancel} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
            <button onClick={onProceed} className="flex-1 bg-amber-600 text-white py-2 rounded-lg hover:bg-amber-700 transition">{proceedLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Categorize workout events by title for color-coding
function getWorkoutCategory(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('pitch') || t.includes('throw') || t.includes('mound') || t.includes('bullpen') || t.includes('long toss') || t.includes('velo') || t.includes('pen ') || t.includes(' pen')) return 'pitching';
  if (t.includes('hit') || t.includes('tee') || t.includes('bp ') || t.includes('batting') || t.includes('swing') || t.includes(' bp')) return 'hitting';
  if (t.includes('warm') || t.includes('mobil') || t.includes('stretch') || t.includes('cars') || t.includes('foam') || t.includes('band') || t.includes('recovery') || t.includes('yoga') || t.includes('cool')) return 'warmup';
  return 'general';
}

// Map a training slot title to Tailwind color classes matching EZ Facility colors (#232).
function getTrainingSlotColorClasses(title, variant) {
  const t = (title || '').toLowerCase();
  // biomechanics must precede assessment (both contain 'assessment')
  if (t.includes('biomechanics')) {
    if (variant === 'pill') return 'bg-gray-500 text-white border-gray-600';
    if (variant === 'card') return 'border-l-4 border-gray-500 bg-gray-100';
    return 'bg-gray-100 text-gray-800 border-gray-400';
  }
  if (t.includes('assessment')) {
    if (variant === 'pill') return 'bg-gray-900 text-white border-gray-800';
    if (variant === 'card') return 'border-l-4 border-gray-900 bg-gray-200';
    return 'bg-gray-200 text-gray-900 border-gray-700';
  }
  if (t.includes('cage')) {
    if (variant === 'pill') return 'bg-yellow-500 text-white border-yellow-600';
    if (variant === 'card') return 'border-l-4 border-yellow-500 bg-yellow-100';
    return 'bg-yellow-100 text-yellow-800 border-yellow-400';
  }
  if (t.includes('local group')) {
    if (variant === 'pill') return 'bg-red-900 text-white border-red-800';
    if (variant === 'card') return 'border-l-4 border-red-900 bg-red-100';
    return 'bg-red-100 text-red-900 border-red-600';
  }
  if (t.includes('youth group')) {
    if (variant === 'pill') return 'bg-red-400 text-white border-red-500';
    if (variant === 'card') return 'border-l-4 border-red-400 bg-red-50';
    return 'bg-red-50 text-red-700 border-red-300';
  }
  if (t.includes('nbp+') && t.includes('hit')) {
    if (variant === 'pill') return 'bg-purple-600 text-white border-purple-700';
    if (variant === 'card') return 'border-l-4 border-purple-600 bg-purple-100';
    return 'bg-purple-100 text-purple-800 border-purple-400';
  }
  if (t.includes('nbp+') && (t.includes('pitch') || t.includes('throw'))) {
    if (variant === 'pill') return 'bg-pink-500 text-white border-pink-600';
    if (variant === 'card') return 'border-l-4 border-pink-500 bg-pink-100';
    return 'bg-pink-100 text-pink-800 border-pink-400';
  }
  if (t.includes('nbp+') && (t.includes('base') || t.includes('field'))) {
    if (variant === 'pill') return 'bg-sky-400 text-white border-sky-500';
    if (variant === 'card') return 'border-l-4 border-sky-400 bg-sky-100';
    return 'bg-sky-100 text-sky-800 border-sky-300';
  }
  if (t.includes('nbp+') && (t.includes('strength') || t.includes('condition'))) {
    if (variant === 'pill') return 'bg-green-600 text-white border-green-700';
    if (variant === 'card') return 'border-l-4 border-green-600 bg-green-100';
    return 'bg-green-100 text-green-800 border-green-400';
  }
  if (t.includes('lesson')) {
    if (variant === 'pill') return 'bg-orange-500 text-white border-orange-600';
    if (variant === 'card') return 'border-l-4 border-orange-500 bg-orange-100';
    return 'bg-orange-100 text-orange-800 border-orange-400';
  }
  // Default teal
  if (variant === 'pill') return 'bg-teal-500 text-white border-teal-600';
  if (variant === 'card') return 'border-l-4 border-teal-600 bg-teal-100';
  return 'bg-teal-100 text-teal-800 border-teal-300';
}

// Map a ProgramLibrarySidebar folder name to the canonical category we store on
// schedule_events.category so calendar tiles inherit the source-library color.
// Keep in sync with FOLDER_COLORS in ProgramLibrarySidebar.js (#191).
export function folderToCategory(folder) {
  if (!folder) return null;
  const f = String(folder).toLowerCase();
  if (f === 'hitting') return 'hitting';
  if (f === 'pitching') return 'pitching';
  if (['catching', 'infield', 'outfield', 'submarine', 'football'].includes(f)) return 'fielding';
  if (['strength', 'body builder', 'college', 'high school', 'pro', 'youth', 'youth weighted'].includes(f)) return 'strength';
  if (['recovery', 'rehab', 'meals'].includes(f)) return 'recovery';
  if (f === 'warmup') return 'warmup';
  if (f === 'cardio') return 'conditioning';
  return null;
}

function expandMealPlanAssignments(assignments, startOfMonth, endOfMonth) {
  const events = [];
  for (const a of assignments) {
    const planName = a.meal_plans?.name || 'Meal Plan';
    const aStart = new Date(a.start_date + 'T00:00:00');
    const aEnd = a.end_date ? new Date(a.end_date + 'T00:00:00') : null;
    const from = aStart > startOfMonth ? aStart : startOfMonth;
    const to = aEnd && aEnd < endOfMonth ? aEnd : endOfMonth;
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      events.push({
        id: `mpa-${a.id}-${fmtLocalDate(d)}`,
        event_type: 'meal',
        event_date: fmtLocalDate(d),
        title: planName,
        player_id: a.player_id,
        _isMealPlan: true,
        _mealPlanId: a.meal_plan_id,
      });
    }
  }
  return events;
}

// #287: facility events assigned to any of `teamIds`, expanded for the given
// window and tagged _is_facility so the schedule_events-based calendars (Team
// view, My Schedule) can render them read-only. Same three-query shape as
// fetchFacilityEvents — standalone rows, recurring masters, exceptions — with
// exceptions fetched by recurrence_parent_id rather than by team, so a
// cancellation or modified occurrence of an assigned series applies even when
// the child row's own team_ids is empty. Tombstones (is_exception=true) are
// hidden by expandRecurringEvents and excluded from the direct query.
async function fetchTeamFacilityEvents(teamIds, rangeStart, rangeEnd, startStr, endStr) {
  if (!teamIds || teamIds.length === 0) return [];

  const [directRes, masterRes] = await Promise.all([
    supabase.from('facility_events').select('*')
      .overlaps('team_ids', teamIds)
      .eq('is_recurring', false)
      .eq('is_exception', false)
      .gte('event_date', startStr).lte('event_date', endStr),
    supabase.from('facility_events').select('*')
      .overlaps('team_ids', teamIds)
      .eq('is_recurring', true)
      .is('recurrence_parent_id', null),
  ]);
  if (directRes.error) console.error('fetchTeamFacilityEvents: direct facility_events query failed:', directRes.error);
  if (masterRes.error) console.error('fetchTeamFacilityEvents: facility_events masters query failed:', masterRes.error);

  const masters = masterRes.data || [];
  let expanded = [];
  if (masters.length > 0) {
    const { data: exceptions, error: exceptionsError } = await supabase.from('facility_events').select('*')
      .in('recurrence_parent_id', masters.map(m => m.id))
      .gte('event_date', startStr).lte('event_date', endStr);
    if (exceptionsError) console.error('fetchTeamFacilityEvents: facility_events exceptions query failed:', exceptionsError);
    expanded = expandRecurringEvents(masters, exceptions || [], rangeStart, rangeEnd);
  }

  // Dedupe by id — a team-assigned exception occurrence can arrive via both
  // the direct query and the expansion.
  const rows = new Map();
  [...(directRes.data || []), ...expanded].forEach(ev => rows.set(String(ev.id), { ...ev, _is_facility: true }));
  return [...rows.values()];
}

// Expands raw training_slots rows (masters, tombstones and #292 moved children)
// into the occurrences shown by CoachSlotsWeekView for the week of
// `selectedDate`, over a range that also covers the whole month. Shared by the
// single-coach view (fetchCoachSlots) and the #452 all-coaches lessons view.
function expandSlotsForWeekView(slots, selectedDate) {
  // Expand range to cover the displayed week even if it spans month boundaries
  const startOfWeek = new Date(selectedDate);
  startOfWeek.setDate(selectedDate.getDate() - selectedDate.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  const startOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  const endOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0);
  const rangeStart = startOfWeek < startOfMonth ? startOfWeek : startOfMonth;
  const rangeEnd = endOfWeek > endOfMonth ? endOfWeek : endOfMonth;
  const startStr = fmtLocalDate(rangeStart);
  const endStr = fmtLocalDate(rangeEnd);
  const exceptionMap = buildSlotExceptionMap(slots);
  const expandedSlots = [];
  (slots || []).forEach(slot => {
    if (slot.recurrence_parent_id) return;
    if (slot.repeat_weekly) {
      const slotStart = new Date(slot.slot_date + 'T00:00:00');
      const endDate = slot.repeat_end_date ? new Date(slot.repeat_end_date + 'T00:00:00') : rangeEnd;
      let current = new Date(slotStart);
      let index = 0;
      while (current <= endDate && current <= rangeEnd) {
        const dateStr = fmtLocalDate(current);
        // #292: ANY exception skips the date — tombstoned dates are gone,
        // moved dates render from their child row below.
        if (current >= rangeStart && !getSlotDateException(exceptionMap, slot.id, dateStr)) {
          expandedSlots.push({ ...slot, slot_date: dateStr, _occurrence_index: index, _is_virtual: index > 0 });
        }
        current.setDate(current.getDate() + 7);
        index++;
      }
    } else if (slot.slot_date >= startStr && slot.slot_date <= endStr && !getSlotDateException(exceptionMap, slot.id, slot.slot_date)) {
      expandedSlots.push(slot);
    }
  });
  // #292: moved occurrences are real sessions on their own date. Not
  // _is_virtual — they're real rows, draggable again via the moved-child
  // branch of onSlotDrop.
  collectMovedSlots(slots).forEach(slot => {
    if (slot.slot_date >= startStr && slot.slot_date <= endStr) {
      expandedSlots.push(slot);
    }
  });
  // Ensure the first occurrence visible in the current week is draggable (not an
  // earlier-month occurrence that is outside the week view).
  const weekStartStr = fmtLocalDate(startOfWeek);
  const weekEndStr = fmtLocalDate(endOfWeek);
  const firstRepeatSeen = new Set();
  for (const es of expandedSlots) {
    if (es.repeat_weekly && !firstRepeatSeen.has(es.id) && es.slot_date >= weekStartStr && es.slot_date <= weekEndStr) {
      es._is_virtual = false;
      firstRepeatSeen.add(es.id);
    }
  }
  return { expandedSlots, startStr, endStr };
}

export default function Schedule({ userId, userRole, onMessageCoach, initialMode, onInitialModeHandled }) {
  const [view, setView] = useState(userRole === 'player' ? 'my-schedule' : 'facility');
  // #452: athlete "Private Lessons" tab — every coach's open lesson slots for
  // the week in one grid (Cordell: "the calendar showing all of the coaches
  // lesson time slots"). Same slot expansion + Reserve flow as one coach.
  const [lessonSlots, setLessonSlots] = useState([]);
  const [lessonReservations, setLessonReservations] = useState([]);
  const [lessonBookedCounts, setLessonBookedCounts] = useState({});
  const [lessonsLoading, setLessonsLoading] = useState(false);
  const [lessonCoachFilter, setLessonCoachFilter] = useState('all');
  const [lessonSkillFilter, setLessonSkillFilter] = useState('All');
  // #452: an athlete's Facility tab used to show only events they were
  // already on, so it looked empty. It now opens on the bookable facility
  // times (the same list as /book); 'mine' is the old calendar, kept because
  // facility-event sign-ups and their own assigned events live there.
  const [facilityMode, setFacilityMode] = useState('book');
  const [bookingPrefill, setBookingPrefill] = useState(null);
  // #407: { coachId, coachName, date, startTime, title } for the session the
  // athlete wants to message their coach about; null when the modal is closed.
  const [messageCoachTarget, setMessageCoachTarget] = useState(null);
  const [myScheduleEvents, setMyScheduleEvents] = useState([]);
  const [showCalendarSync, setShowCalendarSync] = useState(false); // #415
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewMode, setViewMode] = useState(userRole === 'player' ? 'month' : 'lanes');
  // QA 2026-08-15: `userRole` arrives as null on the first render (App.js reads
  // it from the users table after mount), so both useState initialisers above
  // silently took the staff branch and never corrected themselves — every
  // athlete landed on the facility lane grid instead of My Schedule. Correct
  // once, the first time the role resolves. It runs before a human could
  // realistically click anything (measured at under 80ms), so it does not fight
  // the user — but note it is a one-shot on role, not a "has the user navigated
  // yet" check, and it re-applies if the component remounts.
  const roleAppliedRef = useRef(false);
  useEffect(() => {
    if (!userRole || roleAppliedRef.current) return;
    roleAppliedRef.current = true;
    if (userRole === 'player') { setView('my-schedule'); setViewMode('month'); }
  }, [userRole]);
  // #452: App's "Book a Session" picker opens Schedule straight on Private
  // Lessons ('lessons') or bookable facility time ('facility'). Declared after
  // the role effect so, when both fire in the same commit, this one wins.
  useEffect(() => {
    if (!initialMode || !userRole) return;
    if (initialMode === 'lessons') setView('lessons');
    else if (initialMode === 'facility') { setView('facility'); setFacilityMode('book'); setSelectedCoach(null); }
    onInitialModeHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode, userRole]);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [playerDropdownOpen, setPlayerDropdownOpen] = useState(false);
  const [playerSearch, setPlayerSearch] = useState('');
  const [events, setEvents] = useState([]);
  const [showAddPanel, setShowAddPanel] = useState(null);
  const [hoveredDate, setHoveredDate] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showEventDetail, setShowEventDetail] = useState(false);
  // Facility & Training Slots state
  const [facilityEvents, setFacilityEvents] = useState([]);
  const [showAddFacilityEvent, setShowAddFacilityEvent] = useState(null);
  // #229: choosing between an Organization Event and a Public Booking before the
  // create panel opens. Holds the prefill (date/cell) until a type is picked.
  const [showEventTypeChooser, setShowEventTypeChooser] = useState(null);
  const [showAddPublicBooking, setShowAddPublicBooking] = useState(null);
  const [coaches, setCoaches] = useState([]);
  const [selectedCoach, setSelectedCoach] = useState(null);
  // #309/#314: clicking a training-slot entry in the Lanes view's Staff
  // Schedule band sets selectedCoach (same as picking a coach from the
  // sidebar drawer) so every existing selectedCoach-driven piece of
  // CoachSlotsWeekView — add/edit slot, drag-to-move, confirm/decline,
  // attendance — keeps working completely unchanged. coachModalOpen only
  // controls WHERE it renders: as a modal over Lanes instead of replacing
  // the main panel, so the grid the user clicked from stays visible.
  const [coachModalOpen, setCoachModalOpen] = useState(false);
  // #309: a Work Portal shift clicked in the same band — a lightweight,
  // read-only detail popup, not tied to selectedCoach at all.
  const [shiftDetailEvent, setShiftDetailEvent] = useState(null);
  const [coachSlots, setCoachSlots] = useState([]);
  const [slotReservations, setSlotReservations] = useState([]);
  const [publicSlotBookings, setPublicSlotBookings] = useState([]);
  // #428: live booked count per occurrence, keyed `${slot_id}|${slot_date}`,
  // from the slot_booked_counts RPC (SECURITY DEFINER). slotReservations /
  // publicSlotBookings above are RLS-scoped — an athlete only sees their own
  // rows, so counting those told them every session was open.
  const [slotBookedCounts, setSlotBookedCounts] = useState({});
  const [showCreateSlot, setShowCreateSlot] = useState(null);
  const [showReserveSlot, setShowReserveSlot] = useState(null);
  // #276: pending over-the-weekly-cap warning on the coach-side confirm.
  const [capConfirm, setCapConfirm] = useState(null); // { message, reservationId }
  const [showEditSlot, setShowEditSlot] = useState(null);
  const [showFacilityEventDetail, setShowFacilityEventDetail] = useState(false);
  const [selectedFacilityEvent, setSelectedFacilityEvent] = useState(null);
  const [laneDate, setLaneDate] = useState(fmtLocalDate(new Date()));
  const [coachesDrawerOpen, setCoachesDrawerOpen] = useState(false);
  const [coachSkillFilter, setCoachSkillFilter] = useState('All');
  const [showPlayerAddGame, setShowPlayerAddGame] = useState(false);
  const [staffScheduleEvents, setStaffScheduleEvents] = useState([]);
  const [staffAssignments, setStaffAssignments] = useState([]);
  // #229: a coach's own training slots + public bookings for the lane day, so
  // the Staff Schedule rows reflect sessions they're connected to even before a
  // client books. Keyed for the single `laneDate` shown in the lanes view.
  const [coachDaySlots, setCoachDaySlots] = useState([]);
  const [eventPublicBookings, setEventPublicBookings] = useState({});
  // Calendar selection + context menu state (shared across views)
  const [selecting, setSelecting] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState([]); // raw event objects (need event object for source context)
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, event, source }
  const [recurrencePrompt, setRecurrencePrompt] = useState(null); // { event, action, source, onPick }
  // #289: a multi-lane facility event dropped on a different lane suspends the
  // move here until the user picks whole-event vs single-lane in the modal.
  const [pendingLaneMove, setPendingLaneMove] = useState(null); // { ev, sourceLane, targetLane, targetStartTime, wholeLanes }
  // #292: a repeating training slot's master bar dropped on a new day suspends
  // the move until the user picks this-occurrence vs whole-series.
  const [pendingSlotMove, setPendingSlotMove] = useState(null); // { slot, newDate }
  // #309: dragging a slot horizontally within its own row on the Lanes
  // Staff Schedule band changes its TIME (same day) — a different axis than
  // pendingSlotMove above (which changes the DAY via CoachSlotsWeekView's
  // week grid), so this is its own state/prompt rather than overloading
  // that one with a message that would need to talk about both.
  const [pendingSlotTimeMove, setPendingSlotTimeMove] = useState(null); // { slot, newStartTime }
  const [copyToPicker, setCopyToPicker] = useState(null); // { event, source, options, onPick, title }
  const selectedIds = useMemo(() => new Set(selectedEvents.map((e) => String(e.id))), [selectedEvents]);
  const toggleSelect = (ev) => setSelectedEvents((arr) => {
    const sid = String(ev.id);
    return arr.some((e) => String(e.id) === sid) ? arr.filter((e) => String(e.id) !== sid) : [...arr, ev];
  });
  const exitSelectMode = () => { setSelecting(false); setSelectedEvents([]); };
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);

  // Escape closes the read-only popups this component owns, matching what
  // EventDetailModal and FacilityEventDetail already do. Only popups with
  // nothing to lose are listed: a form you could be halfway through typing
  // into (Add Event, Create Slot, Reserve Slot, Add Game) is deliberately left
  // alone, because closing one on a stray key press would throw the typing
  // away without asking.
  //
  // Innermost first, one layer per press — the same rule EventDetailModal's
  // handler follows. `anyPanelOverCoachModal` is the list of things that open
  // ON TOP of the coach week-view modal; while one of those is up the key press
  // belongs to it, and closing the modal underneath would yank the panel's
  // context out from under the user.
  const anyPanelOverCoachModal = !!(showCreateSlot || showEditSlot || showReserveSlot
    || capConfirm || ctxMenu || recurrencePrompt || copyToPicker);
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (shiftDetailEvent) { setShiftDetailEvent(null); return; }
      if (showEventTypeChooser !== null) { setShowEventTypeChooser(null); return; }
      if (selectedCoach && coachModalOpen && !anyPanelOverCoachModal) {
        setCoachModalOpen(false);
        setSelectedCoach(null);
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [shiftDetailEvent, showEventTypeChooser, selectedCoach, coachModalOpen, anyPanelOverCoachModal]);

  useEffect(() => {
    fetchTeams();
    if (userRole === 'admin' || userRole === 'coach') {
      fetchPlayers();
    }
  }, [userRole]);

  useEffect(() => {
    if (view === 'team' && selectedTeam) {
      fetchTeamEvents();
    } else if (view === 'player' && (selectedPlayers.length > 0 || selectedPlayer)) {
      fetchPlayerEvents();
    }
  }, [view, selectedTeam, selectedPlayer, selectedPlayers, selectedDate]);

  useEffect(() => {
    if (view === 'my-schedule') {
      fetchMyScheduleEvents();
    }
  }, [view, selectedDate]);

  // #452
  useEffect(() => {
    if (view !== 'lessons') return;
    fetchLessonSlots();
    if (coaches.length === 0) fetchCoaches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedDate]);

  // #452: name/email/phone for the embedded facility booking form, so an
  // athlete is not asked to type who they are.
  useEffect(() => {
    if (userRole !== 'player' || view !== 'facility' || bookingPrefill) return;
    supabase.from('users').select('full_name, email, phone').eq('id', userId).maybeSingle()
      .then(({ data }) => setBookingPrefill({ name: data?.full_name || '', email: data?.email || '', phone: data?.phone || '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userRole, view, userId]);

  useEffect(() => {
    // QA 2026-08-15: `userRole` must be resolved before this runs. fetchFacilityEvents
    // scopes its query with `const restrictToPlayer = userRole === 'player'`, and on the
    // very first render userRole is still null — so the athlete's own browser was firing
    // three UNSCOPED facility_events queries and pulling the entire facility calendar,
    // other athletes' names included. userRole was not in the dep array, so it never
    // re-ran to correct itself. Waiting one tick costs nothing and closes that.
    if (!userRole) return;
    if (view === 'facility') {
      fetchFacilityEvents();
      fetchCoaches();
    }
  }, [view, selectedDate, userRole]);

  // Fetch staff schedule for lane view
  useEffect(() => {
    if (view === 'facility' && viewMode === 'lanes' && laneDate) {
      fetchStaffSchedule(laneDate);
    }
  }, [view, viewMode, laneDate]);

  // Sync selectedDate month when laneDate changes to a different month, OR
  // when viewMode flips into 'lanes' for an existing laneDate. The effect
  // previously only watched laneDate, so switching to the Lanes view while
  // laneDate was already set left selectedDate's month out of sync.
  useEffect(() => {
    if (viewMode === 'lanes' && laneDate) {
      const ld = new Date(laneDate + 'T12:00:00');
      if (ld.getMonth() !== selectedDate.getMonth() || ld.getFullYear() !== selectedDate.getFullYear()) {
        setSelectedDate(new Date(ld.getFullYear(), ld.getMonth(), 1));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneDate, viewMode]);

  useEffect(() => {
    if (selectedCoach) {
      fetchCoachSlots(selectedCoach.id);
    }
  }, [selectedCoach, selectedDate]);

  const fetchTeams = async () => {
    const { data } = await supabase
      .from('teams')
      .select('*')
      .order('name');
    if (data && data.length > 0) {
      setTeams(data);
      setSelectedTeam(data[0].id);
    }
  };

  const fetchPlayers = async () => {
    // #437: paged. `users` is past 1,000 rows and PostgREST clamps a single
    // read there with no error, which silently dropped every name from ~"W"
    // on (Zach Robman) out of this picker.
    const build = () => supabase
      .from('users')
      .select(`
        id,
        full_name,
        team_members(team_id, teams(name))
      `)
      // Include everyone (players, coaches, interns, admins) so staff can be programmed
      // just like athletes (#156). Coach view is still scoped to their teams below.
      .order('full_name')
      .order('id');

    // If coach, only show players from their teams
    if (userRole === 'coach') {
      const { data: coachTeams } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId);

      const teamIds = coachTeams?.map(t => t.team_id) || [];
      // A coach only ever sees players on their own teams. With no teams, that's an
      // empty set — never fall through to the unfiltered all-users query.
      if (teamIds.length === 0) {
        setPlayers([]);
        return;
      }
      // Filter to only players on coach's teams
      const { rows } = await readAllPages(build);
      const filteredPlayers = rows.filter(p =>
        p.team_members?.some(tm => teamIds.includes(tm.team_id))
      );
      setPlayers(filteredPlayers);
      return;
    }

    const { rows } = await readAllPages(build);
    setPlayers(rows);
  };

  const fetchTeamEvents = async () => {
    if (!selectedTeam) return;

    const { rangeStart, rangeEnd, startStr, endStr } = monthWeekRange(selectedDate);

    // Team view shows only group events (team_ids contains the team) — NOT the
    // individual player_id events of every roster member. Per-player events
    // still show in the player-filtered views. #287 adds the team's assigned
    // facility events alongside them (read-only rows tagged _is_facility).
    const [{ data: teamData, error: teamDataError }, facilityTeamEvents] = await Promise.all([
      supabase.from('schedule_events').select('*')
        .contains('team_ids', [selectedTeam])
        .gte('event_date', startStr).lte('event_date', endStr),
      fetchTeamFacilityEvents([selectedTeam], rangeStart, rangeEnd, startStr, endStr),
    ]);
    if (teamDataError) console.error('fetchTeamEvents: schedule_events query failed:', teamDataError);
    setEvents([...(teamData || []), ...facilityTeamEvents]);
  };

  const fetchPlayerEvents = async () => {
    const ids = selectedPlayers.length > 0 ? selectedPlayers : (selectedPlayer ? [selectedPlayer] : []);
    if (ids.length === 0) { setEvents([]); return; }

    const { rangeStart, rangeEnd, startStr, endStr } = monthWeekRange(selectedDate);

    const { data: tmRows } = await supabase.from('team_members').select('team_id').in('user_id', ids);
    const playerTeamIds = Array.from(new Set((tmRows || []).map(r => r.team_id).filter(Boolean)));

    const [{ data }, { data: mpa }, { data: teamEv }] = await Promise.all([
      supabase.from('schedule_events').select('*').in('player_id', ids)
        .gte('event_date', startStr).lte('event_date', endStr),
      supabase.from('meal_plan_assignments').select('*, meal_plans(name)').in('player_id', ids)
        .lte('start_date', endStr).or(`end_date.gte.${startStr},end_date.is.null`),
      playerTeamIds.length > 0
        ? supabase.from('schedule_events').select('*')
            .overlaps('team_ids', playerTeamIds).gte('event_date', startStr).lte('event_date', endStr)
        : Promise.resolve({ data: [] }),
    ]);

    const directIds = new Set((data || []).map(e => e.id));
    const teamOnly = (teamEv || []).filter(e => !directIds.has(e.id));
    const mealEvents = expandMealPlanAssignments(mpa || [], rangeStart, rangeEnd);
    setEvents([...(data || []), ...teamOnly, ...mealEvents]);
  };

  const fetchMyScheduleEvents = async () => {
    const { rangeStart, rangeEnd, startStr, endStr } = monthWeekRange(selectedDate);
    const isCoach = userRole === 'coach' || userRole === 'admin';

    // Direct per-player events only make sense for players. For coaches/admins
    // we skip this query entirely so a coach's My Schedule does not pull in
    // per-athlete rows where player_id happens to equal their user id.
    let data = [];
    if (!isCoach) {
      const { data: directData, error: evErr } = await supabase.from('schedule_events').select('*')
        .eq('player_id', userId).gte('event_date', startStr).lte('event_date', endStr);
      if (evErr) console.error('Error fetching schedule events:', evErr);
      data = directData || [];
    }

    // Fetch direct meal plan assignments (player view only)
    let directMpa = [];
    if (!isCoach) {
      const { data: mpa, error: mpaErr } = await supabase.from('meal_plan_assignments').select('*, meal_plans(name)')
        .eq('player_id', userId).lte('start_date', endStr).or(`end_date.gte.${startStr},end_date.is.null`);
      if (mpaErr) console.error('Error fetching meal plan assignments:', mpaErr);
      directMpa = mpa || [];
    }

    // Resolve team memberships once for both team events and team meal plans
    const { data: myTeams } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
    const teamIds = (myTeams || []).map(t => t.team_id);

    let teamEvents = [];
    let teamMpa = [];
    let teamFacilityEvents = [];
    if (teamIds.length > 0) {
      // For coaches the team overlap must exclude per-player rows (issue #165):
      // team programming creates one schedule_events row per athlete with both
      // player_id set AND team_ids populated, so .overlaps('team_ids', ...)
      // would otherwise pull every athlete's workout onto the coach calendar.
      let teamEvQuery = supabase.from('schedule_events').select('*')
        .overlaps('team_ids', teamIds).gte('event_date', startStr).lte('event_date', endStr);
      if (isCoach) teamEvQuery = teamEvQuery.is('player_id', null);

      const [{ data: tEv, error: tEvErr }, { data: tMpa, error: tErr }, facEvents] = await Promise.all([
        teamEvQuery,
        supabase.from('meal_plan_assignments').select('*, meal_plans(name)')
          .in('team_id', teamIds).lte('start_date', endStr).or(`end_date.gte.${startStr},end_date.is.null`),
        // #287: facility events assigned to this user's teams, read-only.
        fetchTeamFacilityEvents(teamIds, rangeStart, rangeEnd, startStr, endStr),
      ]);
      if (tEvErr) console.error('Error fetching team schedule events:', tEvErr);
      if (tErr) console.error('Error fetching team meal plan assignments:', tErr);

      const directIds = new Set(data.map(e => e.id));
      teamEvents = (tEv || []).filter(e => !directIds.has(e.id));
      teamMpa = (tMpa || []).map(a => ({ ...a, player_id: userId }));
      teamFacilityEvents = facEvents;
    }

    const allMpa = [...directMpa, ...teamMpa];
    const mealEvents = expandMealPlanAssignments(allMpa, rangeStart, rangeEnd);

    // Show training slots in My Schedule:
    // coaches see slots where they are the coach; players see their confirmed reservations.
    const slotEvents = [];
    if (isCoach) {
      const { data: rawSlots, error: rawSlotsError } = await supabase.from('training_slots').select('*').eq('coach_id', userId);
      if (rawSlotsError) console.error('fetchMyScheduleEvents: training_slots query failed:', rawSlotsError);
      const slotExceptionMap = buildSlotExceptionMap(rawSlots);
      (rawSlots || []).forEach(slot => {
        if (slot.recurrence_parent_id) return;
        if (slot.repeat_weekly) {
          const slotStart = new Date(slot.slot_date + 'T00:00:00');
          const endDate = slot.repeat_end_date ? new Date(slot.repeat_end_date + 'T00:00:00') : rangeEnd;
          let current = new Date(slotStart);
          let index = 0;
          while (current <= rangeEnd && current <= endDate) {
            const occStr = fmtLocalDate(current);
            // #292: ANY exception skips the date — a tombstoned date is gone,
            // and a moved date's session renders from its child row instead.
            if (occStr >= startStr && occStr <= endStr && !getSlotDateException(slotExceptionMap, slot.id, occStr)) {
              slotEvents.push({ ...slot, event_date: occStr, event_type: 'training_slot', title: slot.notes || 'Training Slot', _is_slot: true, _occurrence_index: index, _is_virtual: index > 0 });
            }
            current.setDate(current.getDate() + 7);
            index++;
            if (index > 500) break;
          }
        } else if (slot.slot_date >= startStr && slot.slot_date <= endStr && !getSlotDateException(slotExceptionMap, slot.id, slot.slot_date)) {
          slotEvents.push({ ...slot, event_date: slot.slot_date, event_type: 'training_slot', title: slot.notes || 'Training Slot', _is_slot: true });
        }
      });
      // #292: moved occurrences render as real sessions on their own date.
      collectMovedSlots(rawSlots).forEach(slot => {
        if (slot.slot_date >= startStr && slot.slot_date <= endStr) {
          slotEvents.push({ ...slot, event_date: slot.slot_date, event_type: 'training_slot', title: slot.notes || 'Training Slot', _is_slot: true });
        }
      });

      // #431: attach booking counts so MonthView/WeekView can show a green
      // checkmark on sessions that have at least one sign-up.
      if (slotEvents.length > 0) {
        const slotIds = [...new Set(slotEvents.map(e => e.id))];
        const { data: counts, error: cErr } = await supabase.rpc('slot_booked_counts', { p_slot_ids: slotIds, p_start: startStr, p_end: endStr });
        if (!cErr && counts) {
          const countMap = {};
          counts.forEach(c => { countMap[`${c.slot_id}|${c.slot_date}`] = c.booked; });
          slotEvents.forEach(e => { e._booked_count = countMap[`${e.id}|${e.event_date}`] || 0; });
        }
      }
    } else {
      const { data: myRes } = await supabase.from('slot_reservations').select('*, training_slots(*)').eq('player_id', userId).eq('status', 'confirmed');
      // #455: a reservation is for ONE occurrence (r.slot_date). Expanding
      // the whole weekly series per reservation drew every Friday once per
      // booking — three bookings on a series = three copies each week, plus
      // sessions on weeks the athlete never booked. A reservation repointed
      // at a moved child (#292) carries the child's new date, so this covers
      // that case too; tombstone joins (is_exception=true) stay excluded.
      (myRes || []).forEach(r => {
        const slot = r.training_slots;
        if (!slot) return;
        if (slot.recurrence_parent_id && slot.is_exception !== false) return;
        const occStr = r.slot_date || slot.slot_date;
        if (occStr < startStr || occStr > endStr) return;
        slotEvents.push({ ...slot, event_date: occStr, event_type: 'training_slot', title: slot.notes || 'Training Session', _is_slot: true, _reservation_id: r.id });
      });
    }

    setMyScheduleEvents([...data, ...teamEvents, ...teamFacilityEvents, ...mealEvents, ...slotEvents]);
  };

  const fetchFacilityEvents = async () => {
    const { rangeStart, rangeEnd, startStr, endStr } = monthWeekRange(selectedDate);
    // No embeds onto `users` — see src/userDirectory.js. The athlete and coach
    // names are attached from the directory just before setState instead, so a
    // blocked embed cannot silently drop the "Coach:" line.
    const facSelect = '*';
    let nrQuery = supabase.from('facility_events').select(facSelect).eq('is_recurring', false).is('recurrence_parent_id', null).gte('event_date', startStr).lte('event_date', endStr);
    let masterQuery = supabase.from('facility_events').select(facSelect).eq('is_recurring', true).is('recurrence_parent_id', null);
    let exceptionsQuery = supabase.from('facility_events').select(facSelect).not('recurrence_parent_id', 'is', null).gte('event_date', startStr).lte('event_date', endStr);
    // Players only see facility events they're the athlete for, or signed up for.
    const restrictToPlayer = userRole === 'player';
    let signedUpIds = new Set();
    if (restrictToPlayer) {
      nrQuery = nrQuery.eq('athlete_id', userId);
      masterQuery = masterQuery.eq('athlete_id', userId);
      exceptionsQuery = exceptionsQuery.eq('athlete_id', userId);
      const { data: signups } = await supabase
        .from('event_signups')
        .select('event_id')
        .eq('user_id', userId)
        .gte('event_date', startStr)
        .lte('event_date', endStr);
      signedUpIds = new Set((signups || []).map(s => s.event_id));
    }
    const { data: nonRecurring } = await nrQuery;
    const { data: masters } = await masterQuery;
    const { data: exceptions } = await exceptionsQuery;
    const expanded = expandRecurringEvents(masters || [], exceptions || [], rangeStart, rangeEnd);
    let combined = [...(nonRecurring || []), ...expanded];
    if (restrictToPlayer && signedUpIds.size > 0) {
      const haveIds = new Set(combined.map(e => e.id));
      const missingIds = [...signedUpIds].filter(id => !haveIds.has(id));
      if (missingIds.length > 0) {
        const { data: signedUpEvents } = await supabase
          .from('facility_events')
          .select(facSelect)
          .in('id', missingIds)
          .gte('event_date', startStr)
          .lte('event_date', endStr);
        combined = [...combined, ...(signedUpEvents || [])];
      }
    }
    const facPeople = await fetchUserDirectory(
      combined.flatMap(e => [e.athlete_id, e.coach_id])
    );

    // #431 (facility calendar): who is booked on each occurrence, so the
    // Month/Week/Lane views can flag it without a hover. Cordell: "If a green
    // check mark pops up in the top right corner of all sessions that have an
    // athlete(s) signed up ... that would make it easy to delete the ones not
    // used." Three sources, any one is enough: athletes who signed themselves
    // up (event_signups — keyed by the series master OR the child row, plus
    // the occurrence date, exactly as FacilityEventDetail reads them), athletes
    // staff put on the event (athlete_id / athlete_ids), and paid-or-pending
    // public bookings. event_signups is staff-read-all and public_bookings is
    // staff-only, so this is skipped for athletes — their own calendar is
    // already filtered to events they're on.
    const bookedByKey = {};
    const addBooked = (eventId, date, who) => {
      if (!eventId || !date) return;
      const k = `${eventId}|${date}`;
      (bookedByKey[k] = bookedByKey[k] || new Set()).add(who);
    };
    if (!restrictToPlayer && combined.length > 0) {
      const [signupRes, pubRes] = await Promise.all([
        supabase.from('event_signups').select('event_id, event_date, user_id').gte('event_date', startStr).lte('event_date', endStr),
        supabase.from('public_bookings').select('id, source_id, occurrence_date').eq('source_type', 'facility_event').in('status', ['pending_payment', 'confirmed']).gte('occurrence_date', startStr).lte('occurrence_date', endStr),
      ]);
      if (signupRes.error) console.error('fetchFacilityEvents: event_signups query failed:', signupRes.error);
      if (pubRes.error) console.error('fetchFacilityEvents: public_bookings query failed:', pubRes.error);
      (signupRes.data || []).forEach(r => addBooked(r.event_id, r.event_date, `u:${r.user_id}`));
      (pubRes.data || []).forEach(r => addBooked(r.source_id, r.occurrence_date, `p:${r.id}`));
    }
    const bookedCountFor = (e) => {
      // A virtual occurrence's id is synthetic (`${master}_${n}`); its sign-ups
      // live under _master_id. A child exception row can hold rows under its
      // own id or its parent's (see FacilityEventDetail's ownChildRowId branch).
      const ids = [...new Set([e._master_id, e.recurrence_parent_id, e._is_virtual ? null : e.id].filter(Boolean))];
      const people = new Set();
      ids.forEach(id => (bookedByKey[`${id}|${e.event_date}`] || []).forEach(who => people.add(who)));
      if (e.athlete_id) people.add(`u:${e.athlete_id}`);
      (e.athlete_ids || []).forEach(id => people.add(`u:${id}`));
      return people.size;
    };

    setFacilityEvents(combined.map(e => ({
      ...e,
      athlete: e.athlete_id ? (facPeople.get(e.athlete_id) || null) : null,
      coach: e.coach_id ? (facPeople.get(e.coach_id) || null) : null,
      _booked_count: bookedCountFor(e),
    })));
  };

  // #289: the write half of a LaneView drag — extracted from the inline
  // onEventMove prop so the lane-choice modal can suspend the move until the
  // user picks. newLanes null means "lanes unchanged" (a time-only move);
  // targetStartTime null means "time unchanged" (a lanes-only move). The
  // real-row and virtual-occurrence branches are #285's logic, unchanged —
  // in particular is_exception stays FALSE on the exception insert (true
  // means hidden/cancelled and would vanish the occurrence).
  const applyFacilityEventMove = async (ev, newLanes, targetStartTime) => {
    const currentLanes = ev.lanes || [];
    const currentStart = ev.start_time || ev.event_time;

    const updates = {};
    if (newLanes) updates.lanes = newLanes;

    // Shift both start and end by the same amount so the event keeps its
    // original duration rather than being truncated or stretched to
    // whatever the drop slot happens to be.
    if (targetStartTime && currentStart && targetStartTime !== currentStart) {
      const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const fromMinutes = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const startMinutes = toMinutes(currentStart);
      const durationMinutes = ev.end_time ? (toMinutes(ev.end_time) - startMinutes) : 60; // default 1 hour, matching LaneView's own default span
      const newStartMinutes = toMinutes(targetStartTime);
      updates.start_time = fromMinutes(newStartMinutes);
      updates.end_time = fromMinutes(newStartMinutes + durationMinutes);
    }

    if (Object.keys(updates).length === 0) return;

    if (!ev._is_virtual) {
      const { error } = await supabase.from('facility_events').update(updates).eq('id', ev.id);
      if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
      fetchFacilityEvents();
      return;
    }

    // Virtual occurrence (no row to update — its id is synthetic): write a
    // per-occurrence exception instead. is_exception MUST be false here —
    // true means hidden/deleted (see scheduleUtils.expandRecurringEvents),
    // and a true exception would make the moved event vanish entirely.
    // #347: the find-or-create and the field list now live in
    // scheduleUtils.upsertFacilityException, shared with the five other
    // per-occurrence writes below. The old hand-written list here dropped
    // is_public/public_price_cents/public_capacity/booking_type, so moving one
    // week of a public paid rental silently unpublished it.
    const masterId = ev._master_id || ev.recurrence_parent_id;
    const error = await upsertFacilityException(supabase, { ...ev, lanes: currentLanes }, masterId, ev.event_date, updates);
    if (error) { console.error('applyFacilityEventMove: exception write failed:', error); alert('Failed to move event: ' + formatUserError(error)); return; }
    fetchFacilityEvents();
  };

  // #292: move ONE date of a repeating training slot. Writes/updates the
  // per-occurrence child row — is_exception: FALSE, because true means
  // hidden/cancelled in this codebase (the trap that has now bitten three
  // separate issues) — and migrates that date's reservations onto the child
  // row so athletes' bookings follow the session. sourceSlotId is wherever
  // the date's reservations currently live: the master id on a first move,
  // the child's own id when re-moving an already-moved occurrence.
  const moveSlotOccurrence = async (masterId, sourceSlotId, template, fromDate, toDate, knownChildId = null) => {
    // Refuse a drop onto a date the series already occupies — two sessions
    // from one series on one day is not a move.
    const occupied = coachSlots.some(s =>
      s.slot_date === toDate &&
      (String(s.id) === String(masterId) || String(s.recurrence_parent_id || '') === String(masterId)));
    if (occupied) { alert('That series already has a session on that day.'); return; }

    // Count booked athletes AND paid outside bookings before confirming.
    const [resResult, pubResult] = await Promise.all([
      supabase.from('slot_reservations').select('id, status').eq('slot_id', sourceSlotId).eq('slot_date', fromDate),
      supabase.from('public_bookings').select('id, status').eq('source_type', 'training_slot').eq('source_id', sourceSlotId).eq('occurrence_date', fromDate).in('status', ['pending_payment', 'confirmed']),
    ]);
    if (resResult.error) { alert('Failed to check bookings: ' + formatUserError(resResult.error)); return; }
    const dateReservations = resResult.data || [];
    const datePubBookings = pubResult.data || [];
    const activeCount = dateReservations.filter(r => r.status === 'pending' || r.status === 'confirmed').length;
    const pubCount = datePubBookings.length;
    if (activeCount > 0 || pubCount > 0) {
      const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const parts = [];
      if (activeCount > 0) parts.push(`${activeCount} athlete${activeCount === 1 ? ' is' : 's are'} booked`);
      if (pubCount > 0) parts.push(`${pubCount} paid outside booking${pubCount === 1 ? '' : 's'}`);
      const ok = window.confirm(`Move this session from ${fmt(fromDate)} to ${fmt(toDate)}? ${parts.join(' and ')} will move with it.`);
      if (!ok) return;
    }

    // Find-or-create the child row. A re-moved occurrence passes its own row
    // id (knownChildId) — its original_date is the ORIGINAL series date, not
    // its current slot_date, so looking it up by fromDate would miss it and
    // insert a duplicate. A first move looks up by (master, fromDate); the
    // partial unique index on (recurrence_parent_id, original_date) forbids a
    // second child for the same series date, so a race updates in place.
    let childId;
    let existingChild = knownChildId ? { id: knownChildId } : null;
    if (!existingChild) {
      const { data: found, error: findError } = await supabase
        .from('training_slots')
        .select('id')
        .eq('recurrence_parent_id', masterId)
        .eq('original_date', fromDate)
        .maybeSingle();
      if (findError) { alert('Failed to move slot: ' + formatUserError(findError)); return; }
      existingChild = found;
    }
    if (existingChild) {
      const { error } = await supabase.from('training_slots')
        .update({ slot_date: toDate, is_exception: false })
        .eq('id', existingChild.id);
      if (error) { alert('Failed to move slot: ' + formatUserError(error)); return; }
      childId = existingChild.id;
    } else {
      // The #279 tombstone field list plus the fields a RENDERED session
      // needs — a tombstone never displays, but a moved occurrence keeps its
      // capacity, notes, booking behaviour and public pricing.
      const { data: inserted, error } = await supabase.from('training_slots').insert({
        recurrence_parent_id: masterId,
        original_date: fromDate,
        slot_date: toDate,
        is_exception: false,
        repeat_weekly: false,
        coach_id: template.coach_id,
        start_time: template.start_time,
        duration_minutes: template.duration_minutes,
        is_public: template.is_public,
        public_price_cents: template.public_price_cents ?? null,
        is_subscription_session: template.is_subscription_session,
        store_product_id: template.store_product_id ?? null,
        store_product_ids: template.store_product_ids,
        session_type: template.session_type ?? null,
        max_players: template.max_players,
        auto_confirm: template.auto_confirm,
        notes: template.notes ?? null,
        lanes: template.lanes || [],
      }).select('id').single();
      if (error) { alert('Failed to move slot: ' + formatUserError(error)); return; }
      childId = inserted.id;
    }

    // Bookings follow the session: repoint that date's reservations at the
    // moved occurrence (readers look bookings up by the rendered slot's id +
    // date, which for a moved occurrence is the child row). .select() so a
    // shortfall is surfaced instead of silently stranding bookings.
    if (dateReservations.length > 0) {
      const { data: movedRes, error: resError } = await supabase
        .from('slot_reservations')
        .update({ slot_id: childId, slot_date: toDate })
        .eq('slot_id', sourceSlotId)
        .eq('slot_date', fromDate)
        .select('id');
      if (resError) {
        alert('The session moved, but its bookings could not be moved: ' + formatUserError(resError));
      } else if ((movedRes || []).length < dateReservations.length) {
        alert(`The session moved, but ${dateReservations.length - (movedRes || []).length} of its booking(s) could not be moved.`);
      }
    }

    // Carry public_bookings across the same way: repoint source_id and
    // occurrence_date onto the moved child row so paid outside bookings
    // follow the session (#304).
    if (datePubBookings.length > 0) {
      const { error: pubError } = await supabase
        .from('public_bookings')
        .update({ source_id: childId, occurrence_date: toDate })
        .eq('source_type', 'training_slot')
        .eq('source_id', sourceSlotId)
        .eq('occurrence_date', fromDate);
      if (pubError) {
        alert('The session moved, but its outside bookings could not be moved: ' + formatUserError(pubError));
      }
    }

    fetchCoachSlots(selectedCoach.id);
  };

  // #309/#314: pulled these out of inline closures at the CoachSlotsWeekView
  // call site so the exact same handlers can be reused when that component
  // is opened as a modal from the Lanes view's Staff Schedule band
  // (coachModalOpen below) — one implementation, two render call sites,
  // both driven by the same selectedCoach the rest of this file already
  // uses. No behaviour change from what these bodies did inline.
  const handleConfirmReservation = async (reservationId, force = false) => {
    // #276: this is the coach-side booking decision — confirming is what puts
    // the athlete on the schedule — so the weekly-allowance check runs here
    // too. It warns; the coach can still confirm ("Confirm anyway").
    if (!force) {
      const res = slotReservations.find(r => r.id === reservationId);
      if (res) {
        const warning = await checkWeeklyBookingCap({
          playerId: res.player_id,
          playerName: res.users?.full_name,
          slotDate: res.slot_date,
          slotId: res.slot_id,
          slotCoach: selectedCoach,
          // Don't count the request being confirmed as one of the sessions
          // already booked — it is the one being added.
          excludeReservationId: reservationId,
        });
        if (warning) { setCapConfirm({ message: warning, reservationId }); return; }
      }
    }
    const { error } = await supabase.from('slot_reservations').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', reservationId);
    if (error) { alert('Failed to confirm reservation: ' + formatUserError(error)); return; }
    fetchCoachSlots(selectedCoach.id);
  };
  const handleDeclineReservation = async (reservationId) => {
    const { error } = await supabase.from('slot_reservations').update({ status: 'declined' }).eq('id', reservationId);
    if (error) { alert('Failed to decline reservation: ' + formatUserError(error)); return; }
    fetchCoachSlots(selectedCoach.id);
  };
  const handleMarkAttendance = async (reservationId, value) => {
    // Toggle off if the same status is clicked again.
    const res = slotReservations.find(r => r.id === reservationId);
    const next = res?.attendance === value ? null : value;
    const { error } = await supabase.from('slot_reservations').update({
      attendance: next,
      attendance_marked_at: next ? new Date().toISOString() : null,
      attendance_marked_by: next ? userId : null,
    }).eq('id', reservationId);
    if (error) { alert('Failed to mark attendance: ' + formatUserError(error)); return; }
    // Present/Late consume a package session; anything else releases it.
    await syncReservationSessionUsage(res, next === 'present' || next === 'late', userId);
    fetchCoachSlots(selectedCoach.id);
  };
  const handleSlotDrop = async (slotId, newDate, grabbedDate) => {
    // A repeating slot's expanded entries all share the master's id —
    // grabbedDate identifies WHICH occurrence was dragged (#292).
    const slot = coachSlots.find((s) => String(s.id) === String(slotId) && (!grabbedDate || s.slot_date === grabbedDate))
      || coachSlots.find((s) => String(s.id) === String(slotId));
    if (!slot || slot.slot_date === newDate) return;

    // An already-moved occurrence dragged again (#292): update the same
    // child row in place.
    if (slot.recurrence_parent_id) {
      await moveSlotOccurrence(slot.recurrence_parent_id, slot.id, slot, slot.slot_date, newDate, slot.id);
      return;
    }

    // Plain non-recurring slot: today's behaviour, unchanged.
    if (!slot.repeat_weekly) {
      const { error } = await supabase.from('training_slots').update({ slot_date: newDate }).eq('id', slotId);
      if (error) { alert('Failed to move slot: ' + formatUserError(error)); return; }
      fetchCoachSlots(selectedCoach.id);
      return;
    }

    // A later occurrence of a repeating series: move just this date — no
    // prompt, that's the whole ask (#292). Keyed on _occurrence_index, NOT
    // _is_virtual: the first-visible-per-week bar is force-marked
    // non-virtual for drag (see fetchCoachSlots), so _is_virtual can't tell
    // "the master's own date" from "this week's copy".
    if (slot._occurrence_index > 0) {
      await moveSlotOccurrence(slot.id, slot.id, slot, slot.slot_date, newDate);
      return;
    }

    // The master's own first date: ambiguous, so ask — the same modal #279
    // taught. allowFuture stays false: splitting a series strands
    // slot_reservations (same call as #287).
    setPendingSlotMove({ slot, newDate });
  };

  // #309: applies a TIME change (same day) to one training_slots occurrence,
  // dragged within its own row on the Lanes Staff Schedule band. Choice
  // 'one' finds-or-creates a per-occurrence exception row — the same shape
  // applyTeamAssignment/applyCoachAssignment already use for facility_events
  // (#287), applied to training_slots here rather than a new mechanism.
  // Choice 'all' updates the master directly. Deliberately does NOT touch
  // slot_reservations or public_bookings the way moveSlotOccurrence's DATE
  // change does — the occurrence's identity (id, date) isn't changing here,
  // only its start_time, so there's nothing that needs to follow it.
  const applySlotTimeChange = async (choice, slot, newStartTime) => {
    try {
      if (choice === 'one') {
        if (slot.recurrence_parent_id) {
          // Already its own per-occurrence row (a previous move or time
          // change) — update in place.
          const { error } = await supabase.from('training_slots').update({ start_time: newStartTime }).eq('id', slot.slot_id);
          if (error) throw error;
        } else {
          const { data: existingChild, error: findErr } = await supabase
            .from('training_slots')
            .select('id')
            .eq('recurrence_parent_id', slot.slot_id)
            .eq('original_date', slot.slot_date)
            .maybeSingle();
          if (findErr) throw findErr;
          if (existingChild) {
            const { error } = await supabase.from('training_slots').update({ start_time: newStartTime }).eq('id', existingChild.id);
            if (error) throw error;
          } else {
            const { data: master, error: masterErr } = await supabase.from('training_slots').select('*').eq('id', slot.slot_id).single();
            if (masterErr) throw masterErr;
            const { error } = await supabase.from('training_slots').insert({
              recurrence_parent_id: slot.slot_id,
              original_date: slot.slot_date,
              slot_date: slot.slot_date,
              is_exception: false,
              repeat_weekly: false,
              coach_id: master.coach_id,
              start_time: newStartTime,
              duration_minutes: master.duration_minutes,
              is_public: master.is_public,
              public_price_cents: master.public_price_cents ?? null,
              is_subscription_session: master.is_subscription_session,
              store_product_id: master.store_product_id ?? null,
              store_product_ids: master.store_product_ids,
              session_type: master.session_type ?? null,
              max_players: master.max_players,
              auto_confirm: master.auto_confirm,
              notes: master.notes ?? null,
              lanes: master.lanes || [],
            });
            if (error) throw error;
          }
        }
      } else {
        // 'all' — the whole series moves to the new time. An existing
        // per-occurrence exception child keeps whatever start_time it
        // already has (it was independently customized already) — the same
        // "children don't auto-inherit a later master edit" limitation
        // #310's merge already accepted for facility_events, not new here.
        const masterId = slot.recurrence_parent_id || slot.slot_id;
        const { error } = await supabase.from('training_slots').update({ start_time: newStartTime }).eq('id', masterId);
        if (error) throw error;
      }
      fetchStaffSchedule(laneDate);
    } catch (err) {
      alert('Failed to move session: ' + formatUserError(err));
    }
  };

  // #309: reuses the application/x-slot-id drag payload CoachSlotsWeekView's
  // day-to-day drag already uses (same MIME keys, not a second mechanism) —
  // here the drop target is a TIME cell within the SAME coach's row rather
  // than a different day column, so it changes start_time instead of
  // slot_date. Dropping on a different coach's row is not supported (that
  // would be reassigning the session to a different coach — a separate
  // feature; see the #309 report).
  const handleSlotTimeDrop = async (slotId, newStartTime) => {
    const slot = coachDaySlots.find((s) => String(s.slot_id) === String(slotId));
    if (!slot || slot.start_time === newStartTime) return;
    if (slot.recurrence_parent_id) {
      await applySlotTimeChange('one', slot, newStartTime);
      return;
    }
    if (!slot.repeat_weekly) {
      await applySlotTimeChange('all', slot, newStartTime);
      return;
    }
    // Recurring, and this is the master/virtual occurrence — ambiguous
    // (just today's time, or the whole series'?), so ask, same #279/#292
    // pattern. Unlike handleSlotDrop's _occurrence_index shortcut (which
    // can tell "a later week's copy" from "the master's own anchor date"),
    // this band shows one day at a time and coachDaySlots carries no such
    // signal — always ask here rather than risk guessing wrong.
    setPendingSlotTimeMove({ slot, newStartTime });
  };

  // Reads `staff_directory`, not `users`. This is the single most important
  // line in the privacy change: athletes DO get the Facility tab, and opening
  // it fires this. Against a locked `users` table it would return [], the
  // coach drawer would read "No coaches cover All", no coach could be picked,
  // and booking would be dead facility-wide with no error message anywhere.
  const fetchCoaches = async () => {
    const { data, error } = await readDirectory('staff_directory', (t) => supabase.from(t).select('id, full_name, email, title, avatar_url, role, skills, show_on_facility_schedule').in('role', ['coach', 'admin']).order('full_name'));
    if (error) console.error('fetchCoaches failed:', error);
    setCoaches(data || []);
  };

  // #260: show/hide a coach on the facility calendar Staff Schedule rows.
  // Only flips a per-user flag — role/permissions are untouched.
  const toggleCoachSchedule = async (coachId, visible) => {
    setCoaches(prev => prev.map(c => c.id === coachId ? { ...c, show_on_facility_schedule: visible } : c));
    const { error } = await supabase.from('users').update({ show_on_facility_schedule: visible }).eq('id', coachId);
    if (error) {
      alert(`Could not update: ${error.message}`);
      setCoaches(prev => prev.map(c => c.id === coachId ? { ...c, show_on_facility_schedule: !visible } : c));
    }
  };

  const fetchStaffSchedule = async (dateStr) => {
    // Build day boundaries in UTC for the given local date
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dateStr + 'T23:59:59');
    const [evRes, asgRes, slotRes, pubRes] = await Promise.all([
      supabase.from('staff_schedule_events').select('*').gte('start_at', dayStart.toISOString()).lte('start_at', dayEnd.toISOString()).order('start_at'),
      supabase.from('staff_schedule_assignments').select('id, event_id, user_id, role, user:user_id(full_name, avatar_url)'),
      supabase.from('training_slots').select('*'),
      supabase.from('public_bookings').select('source_type, source_id, guest_name, status').eq('occurrence_date', dateStr).in('status', ['pending_payment', 'confirmed']),
    ]);
    if (slotRes.error) console.error('fetchStaffSchedule: training_slots query failed:', slotRes.error);
    setStaffScheduleEvents(evRes.data || []);
    setStaffAssignments(asgRes.data || []);

    // Which training slots (across all coaches) occur on `dateStr`? Weekly
    // masters repeat every 7 days from slot_date; non-recurring must match the
    // exact date. Exclude per-occurrence child rows and dates tombstoned via
    // the exception map (#279).
    const staffSlotExceptionMap = buildSlotExceptionMap(slotRes.data);
    const occurringSlots = (slotRes.data || []).filter(s => {
      // #292: a moved occurrence (child row, is_exception=false) occurs on its
      // own slot_date; tombstone children never occur.
      if (s.recurrence_parent_id) return s.is_exception === false && s.slot_date === dateStr;
      // ANY exception on this series date skips it — tombstoned dates are
      // gone, moved dates render from their child row above (#292).
      if (getSlotDateException(staffSlotExceptionMap, s.id, dateStr)) return false;
      if (!s.repeat_weekly) return s.slot_date === dateStr;
      if (dateStr < s.slot_date) return false;
      if (s.repeat_end_date && dateStr > s.repeat_end_date) return false;
      const diffDays = Math.round((new Date(dateStr + 'T00:00:00') - new Date(s.slot_date + 'T00:00:00')) / 86400000);
      return diffDays % 7 === 0;
    });

    // Split public bookings by what they're attached to.
    const pubBySlot = {};
    const pubByEvent = {};
    (pubRes.data || []).forEach(p => {
      const bucket = p.source_type === 'training_slot' ? pubBySlot : pubByEvent;
      (bucket[p.source_id] = bucket[p.source_id] || []).push(p);
    });

    // Internal reservations that fall on this day.
    const occIds = occurringSlots.map(s => s.id);
    const resCount = {};
    if (occIds.length > 0) {
      const { data: resv } = await supabase.from('slot_reservations').select('slot_id').eq('slot_date', dateStr).neq('status', 'cancelled').in('slot_id', occIds);
      (resv || []).forEach(r => { resCount[r.slot_id] = (resCount[r.slot_id] || 0) + 1; });
    }

    setCoachDaySlots(occurringSlots.map(s => ({
      coach_id: s.coach_id,
      slot_id: s.id,
      start_time: s.start_time,
      duration_minutes: s.duration_minutes,
      title: s.notes || 'Training slot',
      is_public: !!s.is_public,
      lanes: s.lanes || [],
      capacity: s.max_players || 1,
      reserved: resCount[s.id] || 0,
      publicBookings: pubBySlot[s.id] || [],
      // #309: needed to drag-move this occurrence's TIME (not just click it)
      // — recurrence_parent_id/repeat_weekly decide whether moving it needs
      // the one-vs-series prompt; slot_date is THIS OCCURRENCE's own date
      // (dateStr, the function's own day) — s.slot_date is the wrong thing
      // to use here for a repeating master, since that's the SERIES anchor
      // date, not necessarily today's.
      recurrence_parent_id: s.recurrence_parent_id,
      repeat_weekly: s.repeat_weekly,
      slot_date: dateStr,
    })));
    setEventPublicBookings(pubByEvent);
  };

  // #452: every coach's slots for the Private Lessons week. 843 training_slots
  // rows on 2026-10-16, so this pages past PostgREST's silent 1,000-row cap.
  const fetchLessonSlots = async () => {
    setLessonsLoading(true);
    const { rows: slots, error: slotErr } = await readAllPages(() =>
      supabase.from('training_slots').select('*').order('id'));
    if (slotErr) console.error('fetchLessonSlots: training_slots query failed:', slotErr);
    const { expandedSlots, startStr, endStr } = expandSlotsForWeekView(slots, selectedDate);
    const startOfWeek = new Date(selectedDate);
    startOfWeek.setDate(selectedDate.getDate() - selectedDate.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    const weekStart = fmtLocalDate(startOfWeek);
    const weekEnd = fmtLocalDate(endOfWeek);
    const weekSlots = expandedSlots.filter(sl => sl.slot_date >= weekStart && sl.slot_date <= weekEnd);
    setLessonSlots(weekSlots);
    const slotIds = [...new Set(weekSlots.map(sl => sl.id))];
    if (slotIds.length > 0) {
      const [resResult, countResult] = await Promise.all([
        // RLS returns only this athlete's own reservations — that is all the
        // grid needs to show "Pending" / "Confirmed" on their own bookings.
        supabase.from('slot_reservations').select('*').eq('player_id', userId).in('slot_id', slotIds).gte('slot_date', startStr).lte('slot_date', endStr),
        // #428: capacity must come from the SECURITY DEFINER RPC.
        supabase.rpc('slot_booked_counts', { p_slot_ids: slotIds, p_start: weekStart, p_end: weekEnd }),
      ]);
      if (resResult.error) console.error('fetchLessonSlots: slot_reservations failed:', resResult.error);
      if (countResult.error) console.error('fetchLessonSlots: slot_booked_counts failed:', countResult.error);
      setLessonReservations(resResult.data || []);
      const counts = {};
      (countResult.data || []).forEach(c => { counts[`${c.slot_id}|${c.slot_date}`] = c.booked; });
      setLessonBookedCounts(counts);
    } else {
      setLessonReservations([]);
      setLessonBookedCounts({});
    }
    setLessonsLoading(false);
  };

  const fetchCoachSlots = async (coachId) => {
    const { data: slots, error: slotErr } = await supabase.from('training_slots').select('*').eq('coach_id', coachId);
    if (slotErr) console.error('Error fetching training slots:', slotErr);
    const { expandedSlots, startStr, endStr } = expandSlotsForWeekView(slots, selectedDate);
    setCoachSlots(expandedSlots);
    const slotIds = (slots || []).map(s => s.id);
    if (slotIds.length > 0) {
      const [resResult, pubResult, countResult] = await Promise.all([
        supabase.from('slot_reservations').select('*, users:player_id(full_name, email)').in('slot_id', slotIds).gte('slot_date', startStr).lte('slot_date', endStr),
        supabase.from('public_bookings').select('source_id, occurrence_date, guest_name, status').eq('source_type', 'training_slot').in('source_id', slotIds).gte('occurrence_date', startStr).lte('occurrence_date', endStr).in('status', ['pending_payment', 'confirmed']),
        supabase.rpc('slot_booked_counts', { p_slot_ids: slotIds, p_start: startStr, p_end: endStr }),
      ]);
      setSlotReservations(resResult.data || []);
      setPublicSlotBookings(pubResult.data || []);
      if (countResult.error) console.error('slot_booked_counts failed:', countResult.error);
      const counts = {};
      (countResult.data || []).forEach(c => { counts[`${c.slot_id}|${c.slot_date}`] = c.booked; });
      setSlotBookedCounts(counts);
    } else {
      setSlotReservations([]);
      setPublicSlotBookings([]);
      setSlotBookedCounts({});
    }
  };

  // ============================================
  // Calendar action helpers (delete / duplicate / copy / bulk delete)
  // source: 'facility' | 'team' | 'slot' | 'staff'
  // ============================================

  const tableForSource = (source) => ({
    facility: 'facility_events',
    team: 'schedule_events',
    slot: 'training_slots',
    staff: 'staff_schedule_events',
  })[source];

  const refetchForSource = (source) => {
    if (source === 'facility') fetchFacilityEvents();
    else if (source === 'team') { if (view === 'team') fetchTeamEvents(); else fetchPlayerEvents(); }
    else if (source === 'slot' && selectedCoach) fetchCoachSlots(selectedCoach.id);
  };

  const isRecurringEvent = (event, source) => {
    if (source === 'slot') return !!event.repeat_weekly;
    return !!(event._is_virtual || event.is_recurring || event.recurrence_parent_id);
  };

  // Delete one occurrence (virtual): insert exception
  const deleteVirtualOccurrence = async (event, source) => {
    if (source === 'facility') {
      // #347: was a blind INSERT with a hand-written field list. It could
      // leave a second child row for a date that already had one, and it
      // dropped every column it forgot. Shared with FacilityEventDetail's
      // Delete button so the two paths cannot drift again.
      return deleteFacilityOccurrence(
        supabase, event,
        event._master_id || event.recurrence_parent_id,
        event.original_date || event.event_date,
      );
    }
    if (source === 'staff') {
      const { error } = await supabase.from('staff_schedule_events').insert({
        recurrence_parent_id: event._master_id || event.recurrence_parent_id,
        original_date: event.event_date,
        event_date: event.event_date,
        is_cancelled: true,
        title: event.title,
        start_at: event.start_at,
        end_at: event.end_at,
      });
      return error;
    }
    if (source === 'team') {
      const { error } = await supabase.from('schedule_events').delete().eq('id', event.id);
      return error;
    }
    if (source === 'slot') {
      // Tombstone this one occurrence (#279) — a child training_slots row with
      // is_exception=true, matched by fetchCoachSlots' exceptionMap during expansion.
      const masterId = event._master_id || event.recurrence_parent_id || event.id;
      const { error: tombstoneError } = await supabase.from('training_slots').insert({
        recurrence_parent_id: masterId,
        original_date: event.slot_date,
        slot_date: event.slot_date,
        is_exception: true,
        repeat_weekly: false,
        coach_id: event.coach_id,
        start_time: event.start_time,
        duration_minutes: event.duration_minutes,
        is_public: event.is_public,
        is_subscription_session: event.is_subscription_session,
        store_product_ids: event.store_product_ids,
      });
      if (tombstoneError) {
        // 23505 = unique_violation on (recurrence_parent_id, original_date) — a duplicate
        // tombstone (e.g. a double-click). Treat as already-cancelled rather than erroring.
        if (tombstoneError.code !== '23505') {
          console.error('deleteVirtualOccurrence (slot): tombstone insert failed:', tombstoneError);
          return tombstoneError;
        }
        console.warn('deleteVirtualOccurrence (slot): tombstone already exists, treating as already-cancelled:', tombstoneError);
      }
      // A cancelled session should not keep its bookings.
      const { error: resError } = await supabase.from('slot_reservations').delete().eq('slot_id', event.id).eq('slot_date', event.slot_date);
      if (resError) console.error('deleteVirtualOccurrence (slot): failed to clear reservations:', resError);
      return resError;
    }
  };

  // Delete entire series ('all'): delete master and children
  const deleteSeries = async (event, source) => {
    const masterId = event._master_id || event.recurrence_parent_id || event.id;
    // #347: shared with FacilityEventDetail's Delete button.
    // #347 QA: and so is the warning. This call site used to delete the whole
    // series bare, so the same "Delete all events in series" choice destroyed
    // every date and every athlete sign-up with no confirm at all when it was
    // made from the right-click menu in Month/Week view, while the identical
    // choice in Lanes view warned first. The guard belongs to the operation,
    // not to one menu. Backing out returns DELETE_CANCELLED, which handleDelete
    // already treats as neither an error nor a success.
    if (source === 'facility') {
      if (!(await confirmWholeFacilitySeriesDelete(masterId, null, WHOLE_SERIES_LEAD))) return DELETE_CANCELLED;
      return deleteFacilitySeries(supabase, masterId);
    }
    if (source === 'team') {
      await supabase.from('schedule_events').delete().eq('recurrence_parent_id', masterId);
      const { error } = await supabase.from('schedule_events').delete().eq('id', masterId);
      return error;
    }
    const table = tableForSource(source);
    await supabase.from(table).delete().eq('recurrence_parent_id', masterId);
    const { error } = await supabase.from(table).delete().eq('id', masterId);
    return error;
  };

  // Delete this and future
  const deleteFuture = async (event, source) => {
    const masterId = event._master_id || event.recurrence_parent_id || event.id;
    const cutoff = event.event_date || event.slot_date;
    if (source === 'team') {
      const { error } = await supabase.from('schedule_events').delete().eq('recurrence_parent_id', masterId).gte('event_date', cutoff);
      if (event.id === masterId) {
        const { error: e2 } = await supabase.from('schedule_events').delete().eq('id', masterId);
        return e2;
      }
      return error;
    }
    // #347: shared with FacilityEventDetail's Delete button. The cutoff is the
    // SERIES date, which for a moved occurrence is original_date rather than
    // the date the child row now sits on.
    // #347 QA: on the series' own first date this choice really means "delete
    // everything", so deleteFacilityFuture asks before it escalates and returns
    // DELETE_CANCELLED (handled in handleDelete) if the answer is no.
    if (source === 'facility') {
      return deleteFacilityFuture(
        supabase, masterId, event.original_date || cutoff,
        (master) => confirmWholeFacilitySeriesDelete(masterId, master, WHOLE_SERIES_FROM_FUTURE_LEAD),
      );
    }
    if (source === 'staff') {
      const { data: master } = await supabase.from(tableForSource(source)).select('recurrence_rule, event_date').eq('id', masterId).single();
      if (!master) return null;
      const cutoffDate = new Date(cutoff + 'T00:00:00');
      cutoffDate.setDate(cutoffDate.getDate() - 1);
      const until = fmtLocalDate(cutoffDate);
      if (master.event_date && master.event_date > until) {
        return await deleteSeries(event, source);
      }
      const rule = typeof master.recurrence_rule === 'string' ? JSON.parse(master.recurrence_rule) : (master.recurrence_rule || {});
      rule.until = until;
      const ruleVal = source === 'facility' || source === 'staff' ? rule : JSON.stringify(rule);
      const { error } = await supabase.from(tableForSource(source)).update({ recurrence_rule: ruleVal }).eq('id', masterId);
      return error;
    }
    if (source === 'slot') {
      const cutoffDate = new Date(cutoff + 'T00:00:00');
      cutoffDate.setDate(cutoffDate.getDate() - 1);
      const { error } = await supabase.from('training_slots').update({ repeat_end_date: fmtLocalDate(cutoffDate) }).eq('id', masterId);
      return error;
    }
  };

  const handleDelete = (event, source) => {
    const recurring = isRecurringEvent(event, source);
    if (!recurring) {
      if (!window.confirm('Delete this event?')) return;
      (async () => {
        const id = event._master_id || event.id;
        const { error } = await supabase.from(tableForSource(source)).delete().eq('id', id);
        if (error) { alert('Failed to delete: ' + formatUserError(error)); return; }
        refetchForSource(source);
      })();
      return;
    }
    setRecurrencePrompt({
      event, source, action: 'delete',
      allowOne: true,
      onPick: async (choice) => {
        setRecurrencePrompt(null);
        let err;
        if (choice === 'one') err = await deleteVirtualOccurrence(event, source);
        else if (choice === 'future') err = await deleteFuture(event, source);
        else err = await deleteSeries(event, source);
        // The user was warned that this would take the whole series and said
        // no. Nothing was deleted and nothing failed.
        if (err === DELETE_CANCELLED) return;
        if (err) { alert('Failed to delete: ' + formatUserError(err)); return; }
        refetchForSource(source);
      },
    });
  };

  const handleDuplicate = async (event, source) => {
    const newDateStr = window.prompt('Duplicate to which date? (YYYY-MM-DD)', event.event_date || event.slot_date);
    if (!newDateStr) return;
    const id = event._master_id || event.id;
    const { data: src } = await supabase.from(tableForSource(source)).select('*').eq('id', id).single();
    if (!src) { alert('Original event not found'); return; }
    const clone = { ...src };
    delete clone.id;
    delete clone.created_at;
    delete clone.updated_at;
    if (source === 'slot') {
      clone.slot_date = newDateStr;
      clone.repeat_weekly = false;
      clone.repeat_end_date = null;
      clone.is_recurring = false;
      clone.recurrence_parent_id = null;
      delete clone.recurrence_rule;
      delete clone.original_date;
    } else {
      clone.is_recurring = false;
      clone.recurrence_parent_id = null;
      clone.recurrence_rule = null;
      clone.original_date = null;
      clone.event_date = newDateStr;
      if (source === 'staff' && src.start_at && src.end_at) {
        const oldStart = new Date(src.start_at);
        const newStart = new Date(newDateStr + 'T00:00:00');
        newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
        const dur = new Date(src.end_at) - new Date(src.start_at);
        clone.start_at = newStart.toISOString();
        clone.end_at = new Date(newStart.getTime() + dur).toISOString();
      }
    }
    const { error } = await supabase.from(tableForSource(source)).insert(clone);
    if (error) { alert('Failed to duplicate: ' + formatUserError(error)); return; }
    refetchForSource(source);
  };

  const openCopyToPicker = async (event, source) => {
    if (source === 'slot') {
      const { data: list } = await supabase.from('users').select('id, full_name, email').in('role', ['coach', 'admin']).order('full_name');
      const opts = (list || []).filter((u) => u.id !== (event.coach_id)).map((u) => ({ id: u.id, label: u.full_name, subtitle: u.email }));
      setCopyToPicker({ event, source, options: opts, title: 'Copy slot to other coaches', actionLabel: 'Copy', onPick: async (ids) => {
        for (const cid of ids) {
          const { data: src } = await supabase.from('training_slots').select('*').eq('id', event.id).single();
          const clone = { ...src };
          delete clone.id; delete clone.created_at; delete clone.updated_at;
          clone.coach_id = cid;
          await supabase.from('training_slots').insert(clone);
        }
        setCopyToPicker(null);
        refetchForSource(source);
      } });
      return;
    }
    if (source === 'team') {
      const { data: list } = await supabase.from('teams').select('id, name').order('name');
      const evTeams = new Set(event.team_ids || (event.team_id ? [event.team_id] : []));
      const opts = (list || []).filter((t) => !evTeams.has(t.id)).map((t) => ({ id: t.id, label: t.name }));
      setCopyToPicker({ event, source, options: opts, title: 'Copy event to other teams', actionLabel: 'Copy', onPick: async (ids) => {
        const id = event._master_id || event.id;
        const { data: src } = await supabase.from('schedule_events').select('*').eq('id', id).single();
        for (const tid of ids) {
          const clone = { ...src };
          delete clone.id; delete clone.created_at; delete clone.updated_at;
          clone.team_id = tid;
          clone.team_ids = [tid];
          clone.recurrence_parent_id = null;
          await supabase.from('schedule_events').insert(clone);
        }
        setCopyToPicker(null);
        refetchForSource(source);
      } });
      return;
    }
    if (source === 'staff') {
      const { data: list } = await supabase.from('users').select('id, full_name, email').in('role', ['coach', 'admin']).order('full_name');
      const opts = (list || []).map((u) => ({ id: u.id, label: u.full_name, subtitle: u.email }));
      setCopyToPicker({ event, source, options: opts, title: 'Assign copy of event to staff', actionLabel: 'Create + assign', onPick: async (ids) => {
        const masterId = event._master_id || event.id;
        const { data: src } = await supabase.from('staff_schedule_events').select('*').eq('id', masterId).single();
        const clone = { ...src };
        delete clone.id; delete clone.created_at; delete clone.updated_at;
        clone.is_recurring = false;
        clone.recurrence_parent_id = null;
        clone.recurrence_rule = null;
        clone.original_date = null;
        const { data: newEv } = await supabase.from('staff_schedule_events').insert(clone).select().single();
        if (newEv) {
          for (const uid of ids) {
            await supabase.from('staff_schedule_assignments').insert({ event_id: newEv.id, user_id: uid });
          }
        }
        setCopyToPicker(null);
        refetchForSource(source);
      } });
    }
  };

  const buildContextMenuItems = (event, source) => {
    const items = [];
    const editable = !!event;
    items.push({ label: 'Edit', icon: <Edit2 size={14} />, onClick: () => {
      if (source === 'facility') { setSelectedFacilityEvent(event); setShowFacilityEventDetail(true); }
      else if (source === 'team') { setSelectedEvent(event); setShowEventDetail(true); }
      else if (source === 'slot') { setShowEditSlot(event); }
    }, disabled: !editable });
    items.push({ label: 'Duplicate', icon: <Copy size={14} />, onClick: () => handleDuplicate(event, source) });
    if (source === 'team' || source === 'slot' || source === 'staff') {
      items.push({ label: 'Copy to...', icon: <Copy size={14} />, onClick: () => openCopyToPicker(event, source) });
    }
    items.push({ divider: true });
    items.push({ label: 'Delete', icon: <Trash2 size={14} />, onClick: () => handleDelete(event, source), danger: true });
    return items;
  };

  const onEventContextMenu = (source) => (event, e) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, items: buildContextMenuItems(event, source) });
  };

  // #347: the source is a property of the ROW, not of the view. Facility view
  // shows facility_events in the main panel and training_slots in the coach
  // drawer, and selectedCoach stays set after the drawer closes — so keying
  // off `selectedCoach` sent facility deletes at training_slots with facility
  // UUIDs: zero rows matched, no error, and the UI reported success.
  // A training_slots row is the one with its own slot_date column.
  const sourceForSelectedEvent = (ev) => {
    if (view === 'team' || view === 'player') return 'team';
    if (ev && (ev._is_slot || ev.slot_date)) return 'slot';
    return 'facility';
  };

  // #347 QA: a facility row that belongs to a repeating series must never be
  // row-deleted. A modified-occurrence child row (recurrence_parent_id set) is
  // only an OVERRIDE of one date, so deleting it does not delete that date — the
  // master's original version of it comes straight back, and
  // event_signups_event_id_fkey (ON DELETE CASCADE) destroys that date's athlete
  // sign-ups on the way out. Those rows go through the same tombstone path a
  // single-occurrence delete uses, which turns the override into "this date is
  // gone". Standalone facility rows are still a plain delete.
  const facilitySeriesDate = (ev) => {
    if (ev._is_virtual) return { masterId: ev._master_id, date: ev.original_date || ev.event_date };
    if (ev.recurrence_parent_id) return { masterId: ev.recurrence_parent_id, date: ev.original_date || ev.event_date };
    return null;
  };

  const bulkDelete = async () => {
    if (selectedEvents.length === 0) return;
    // Determine sources before confirming so we can warn about recurring series.
    const sources = [...new Set(selectedEvents.map(sourceForSelectedEvent))];
    const recurringMasters = selectedEvents.filter(ev => sourceForSelectedEvent(ev) === 'slot' && !ev._is_virtual && ev.repeat_weekly);
    let confirmMsg = `Delete ${selectedEvents.length} selected event(s)?`;
    if (recurringMasters.length > 0) {
      const seriesWord = recurringMasters.length === 1 ? '1 selection is a repeating series' : `${recurringMasters.length} selections are repeating series`;
      confirmMsg += `\n\nWARNING: ${seriesWord} — all future occurrences will be permanently deleted.`;
    }
    // #347 QA: say out loud when athletes are signed up for what is being
    // removed. Same counting helper the whole-series warning uses, and the same
    // honesty rule: a number we could not establish is never printed as one.
    // A date of a series is counted on that date only; a standalone row is
    // counted across every date on it, because deleting the row takes them all.
    //
    // #347 follow-up: a date of a series is keyed (master id, series date) —
    // the same key FacilityEventDetail signs athletes up under. An already
    // edited date is a real child row, and older sign-ups on it may still be
    // keyed to that CHILD's id under whatever date the child carried at the
    // time; that child row stands for this one date only, so every date on it
    // counts (eventDate omitted). Counting only `ev.id` on `ev.event_date`, as
    // this did, missed both halves once a date had been edited and moved.
    const signupTargets = selectedEvents
      .filter(ev => sourceForSelectedEvent(ev) === 'facility')
      .flatMap(ev => {
        const series = facilitySeriesDate(ev);
        if (!series) return [{ eventId: ev.id, eventDate: null }];
        const targets = [{ eventId: series.masterId, eventDate: series.date }];
        if (!ev._is_virtual) targets.push({ eventId: ev.id });
        return targets;
      });
    if (signupTargets.length > 0) {
      const signups = await countSignupsForEvents(supabase, signupTargets);
      if (signups == null) {
        confirmMsg += '\n\nAny athlete sign-ups on the selected dates will be cancelled.';
      } else if (signups > 0) {
        confirmMsg += `\n\n${signups} athlete sign-up${signups === 1 ? '' : 's'} on the selected dates will be cancelled.`;
      }
    }
    if (!window.confirm(confirmMsg)) return;
    trackAction('bulk_delete_events', { count: selectedEvents.length });
    let failed = 0;
    let deleted = 0;
    for (const ev of selectedEvents) {
      const id = ev._master_id || ev.id;
      const source = sourceForSelectedEvent(ev);
      const facilitySeries = source === 'facility' ? facilitySeriesDate(ev) : null;
      try {
        if (ev._is_virtual && (source === 'facility' || source === 'slot')) {
          const error = await deleteVirtualOccurrence(ev, source);
          if (error) throw error;
          deleted++;
        } else if (facilitySeries) {
          // A real child row for one date of a series: tombstone the date
          // (upsert turns the existing override row into "this date is gone")
          // instead of deleting the override and letting the master's version
          // of that date reappear.
          const error = await deleteFacilityOccurrence(supabase, ev, facilitySeries.masterId, facilitySeries.date);
          if (error) throw error;
          deleted++;
        } else {
          const { error } = await supabase.from(tableForSource(source)).delete().eq('id', id);
          if (error) throw error;
          deleted++;
        }
      } catch (err) {
        failed++;
        console.error('Bulk delete failed for event', id, err);
      }
    }
    if (failed > 0) {
      alert(`${deleted} deleted, ${failed} failed. Refresh to see current state.`);
    }
    exitSelectMode();
    sources.forEach(refetchForSource);
  };

  // ============================================
  // Drop handler for Program Library sidebar
  // payload: { kind: 'template'|'program'|'meal_plan'|'meal', id, name }
  // ============================================
  const handleProgramDrop = async (payload, dateStr) => {
    trackAction('drop_template_on_calendar', { kind: payload?.kind });
    if (!payload || !dateStr) return;
    if (!canManageCalendar() && view !== 'my-schedule') { alert('You are not able to schedule events on this calendar. Ask an admin or a coach to add it for you.'); return; }

    // Determine targets based on current view
    let targets = {};
    if (view === 'team') {
      if (!selectedTeam) { alert('Select a team first.'); return; }
      // Fetch team members to create per-player events (visible on individual schedules)
      const { data: members } = await supabase.from('team_members').select('user_id').eq('team_id', selectedTeam);
      const memberIds = (members || []).map(m => m.user_id).filter(Boolean);
      if (memberIds.length === 0) { alert('No players on this team.'); return; }
      targets = { _playerIds: memberIds };
    } else if (view === 'player') {
      const playerIds = selectedPlayers.length > 0 ? selectedPlayers : (selectedPlayer ? [selectedPlayer] : []);
      if (playerIds.length === 0) { alert('Select a player first.'); return; }
      targets = { _playerIds: playerIds };
    } else if (view === 'my-schedule') {
      targets = { player_id: userId };
    } else {
      return;
    }

    const insertSchedule = async (rows) => {
      const expanded = [];
      if (targets._playerIds) {
        for (const pid of targets._playerIds) {
          for (const r of rows) expanded.push({ ...r, player_id: pid });
        }
      } else {
        for (const r of rows) expanded.push({ ...r, ...targets });
      }
      const { error } = await supabase.from('schedule_events').insert(expanded);
      if (error) { alert('Failed to schedule: ' + formatUserError(error)); return false; }
      return true;
    };

    if (payload.kind === 'template') {
      // Fetch template exercises so the workout has full details
      const { data: tpl } = await supabase.from('workout_templates').select('*').eq('id', payload.id).single();
      const exercises = tpl?.exercises || [];
      const notesWithExercises = [
        tpl?.notes || '',
        exercises.length > 0 ? '\n--- Exercises ---\n' + exercises.map(ex =>
          [ex.name, ex.sets && ex.reps ? `${ex.sets}x${ex.reps}` : (ex.sets || ''), ex.rest || '', ex.load || '', ex.link || ''].join(' | ')
        ).join('\n') : ''
      ].filter(Boolean).join('\n');
      const category = folderToCategory(tpl?.folder) || folderToCategory(payload.folder) || getWorkoutCategory(tpl?.name || payload.name);
      const ok = await insertSchedule([{ event_type: 'workout', title: tpl?.name || payload.name, notes: notesWithExercises || null, event_date: dateStr, category }]);
      if (ok) { if (view === 'team') fetchTeamEvents(); else if (view === 'player') fetchPlayerEvents(); else fetchMyScheduleEvents(); }
      return;
    }
    if (payload.kind === 'meal') {
      const ok = await insertSchedule([{ event_type: 'meal', meal_id: payload.id, title: payload.name, event_date: dateStr }]);
      if (ok) { if (view === 'team') fetchTeamEvents(); else if (view === 'player') fetchPlayerEvents(); else fetchMyScheduleEvents(); }
      return;
    }
    if (payload.kind === 'program') {
      // #393: day_number means two different things depending on who wrote the
      // program, and this is the one place that has to tell them apart.
      //
      //   'weekday'    — the generators emit (week-1)*7 + weekday + 1 with
      //                  weekday 0 = MONDAY, so day 1/3/5 MEANS Mon/Wed/Fri.
      //   'sequential' — Coach Tools hand-built: a plain 1..N running order
      //                  with no weekday meaning at all.
      //
      // Placing a 'weekday' program at drop_date + day_number - 1 makes
      // whatever day you dropped on become Monday, silently rotating the whole
      // week: drop the Mon/Fri/Sun program above on a Wednesday and the
      // sessions land Wed/Sun/Tue — including two on the Tuesday the coach
      // deselected because the team practises then (#385).
      //
      // So a 'weekday' program anchors to the MONDAY OF THE WEEK DROPPED ON,
      // not to the dropped day. 'sequential' keeps the original arithmetic
      // exactly — snapping those would scatter a hand-built program across a
      // week and could place its day 1 in the past.
      //
      // day_anchor may be missing here in two ways, and both must read as
      // 'sequential' (today's behaviour): the column doesn't exist until
      // 20260910_training_programs_day_anchor.sql runs, and the .select()
      // below would then error rather than return rows — hence the fallback
      // query. Defaulting the other way would move real sessions on programs
      // nobody has verified.
      let dayAnchor = 'sequential';
      let days = null;
      const withAnchor = await supabase
        .from('training_programs').select('day_anchor').eq('id', payload.id).maybeSingle();
      if (withAnchor.error) {
        console.error('day_anchor read failed (migration pending?):', withAnchor.error);
      } else if (withAnchor.data?.day_anchor === 'weekday') {
        dayAnchor = 'weekday';
      }
      ({ data: days } = await supabase.from('training_days').select('id, day_number, title').eq('program_id', payload.id).order('day_number'));

      // Monday of the dropped week. getDay() is 0=Sun..6=Sat, so Sunday needs
      // to go BACK six days, not forward one — a Sunday drop belongs to the
      // week that is ending, which is the week the coach is looking at.
      const anchorDate = (() => {
        const d = new Date(dateStr + 'T00:00:00');
        if (dayAnchor !== 'weekday') return d;
        const dow = d.getDay();
        d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        return d;
      })();
      const anchorStr = fmtLocalDate(anchorDate);

      // Snapping backwards is the fix working as designed, but it has one
      // consequence worth saying out loud: drop on a Thursday and the week's
      // Mon/Tue/Wed sessions are created in the PAST. That is sometimes exactly
      // what a coach wants (backfilling the week they're partway through) and
      // sometimes a surprise, so ask rather than assume. Only fires when the
      // snap actually moves the start behind today — a drop on a future week
      // never sees this.
      if (dayAnchor === 'weekday' && anchorStr < fmtLocalDate(new Date())) {
        const pretty = anchorDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const ok = window.confirm(
          `This program's days are Monday-based, so it will start on ${pretty} — the Monday of the week you dropped on.\n\n` +
          `That date has already passed, so the earliest sessions will be added to the past. Continue?`
        );
        if (!ok) return;
      }

      const rows = (days || []).map((d) => {
        const dt = new Date(anchorStr + 'T00:00:00');
        dt.setDate(dt.getDate() + ((d.day_number || 1) - 1));
        return {
          event_type: 'workout',
          training_program_id: payload.id,
          training_day_id: d.id,
          title: d.title || payload.name,
          event_date: fmtLocalDate(dt),
        };
      });
      if (rows.length === 0) { alert('Program has no days to schedule.'); return; }
      const ok = await insertSchedule(rows);
      if (ok) { if (view === 'team') fetchTeamEvents(); else if (view === 'player') fetchPlayerEvents(); else fetchMyScheduleEvents(); }
      return;
    }
    if (payload.kind === 'meal_plan') {
      const assignments = [];
      if (view === 'team') {
        assignments.push({ meal_plan_id: payload.id, team_id: selectedTeam, start_date: dateStr });
      } else if (view === 'player') {
        for (const pid of (targets._playerIds || [])) assignments.push({ meal_plan_id: payload.id, player_id: pid, start_date: dateStr });
      } else {
        assignments.push({ meal_plan_id: payload.id, player_id: userId, start_date: dateStr });
      }
      const { error } = await supabase.from('meal_plan_assignments').insert(assignments);
      if (error) { alert('Failed to assign meal plan: ' + formatUserError(error)); return; }
      if (view === 'team') fetchTeamEvents(); else if (view === 'player') fetchPlayerEvents(); else fetchMyScheduleEvents();
    }
  };

  const canManageCalendar = () => {
    if (userRole === 'admin') return true;
    if (userRole === 'coach') {
      if (view === 'facility') return true;
      if (view === 'team') return true;
      if (view === 'player') {
        const player = players.find(p => p.id === selectedPlayer);
        return player !== undefined;
      }
    }
    return false;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Schedule</h2>
          <p className="text-gray-600 mt-1">Manage team events and player calendars</p>
        </div>
        
        {/* View Toggle */}
        {/* QA 2026-08-15: added flex-wrap — this row is 253px+ and did not wrap,
            so the Schedule page panned sideways on a phone. Pre-existing. */}
        <div className="flex flex-wrap items-center gap-2">
          {userRole === 'player' ? (
            <>
              <button
                onClick={() => { setView('my-schedule'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'my-schedule' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <CalendarIcon size={18} />
                <span>My Schedule</span>
              </button>
              {/* #452 */}
              <button
                onClick={() => { setView('lessons'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'lessons' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Dumbbell size={18} />
                <span>Private Lessons</span>
              </button>
              <button
                onClick={() => { setView('facility'); setFacilityMode('book'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'facility' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Building size={18} />
                <span>Facility</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { setView('team'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'team' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Users size={18} />
                <span>Team</span>
              </button>
              <button
                onClick={() => { setView('player'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'player' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <User size={18} />
                <span>Player</span>
              </button>
              <button
                onClick={() => { setView('facility'); setSelectedCoach(null); }}
                className={`px-4 py-2 rounded-lg font-medium transition flex items-center space-x-2 ${
                  view === 'facility' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                <Building size={18} />
                <span>Facility</span>
              </button>
            </>
          )}
        </div>
      </div>

      {showCalendarSync && <CalendarSyncModal userId={userId} onClose={() => setShowCalendarSync(false)} />}

      {/* My Schedule View (Player) */}
      {view === 'my-schedule' && (
        <div className="flex space-x-4">
          {(userRole === 'admin' || userRole === 'coach') && (
            <ProgramLibrarySidebar collapsed={libraryCollapsed} onToggle={() => setLibraryCollapsed(!libraryCollapsed)} />
          )}
          <div className="bg-white rounded-lg shadow flex-1 min-w-0">
          <div className="border-b border-gray-200 p-6">
            {/* QA 2026-08-15: added flex-wrap + gap so the title/Add Game group
                and the Week/Month/Lanes toggle stack on a phone instead of
                pushing the whole Schedule page sideways. Pre-existing. */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-lg font-semibold text-gray-900">My Schedule</h3>
                <button
                  onClick={() => setShowPlayerAddGame(true)}
                  className="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-1 text-sm"
                >
                  <Plus size={16} />
                  <span>Add Game</span>
                </button>
                {userRole === 'player' && (
                  <button
                    onClick={() => setShowCalendarSync(true)}
                    className="bg-white border border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 transition flex items-center space-x-1 text-sm"
                    title="Subscribe from Google, Apple or Outlook calendar"
                  >
                    <CalendarIcon size={16} />
                    <span>Sync to calendar</span>
                  </button>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <button onClick={() => setViewMode('week')} className={`px-3 py-1 rounded text-sm font-medium transition ${viewMode === 'week' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Week</button>
                <button onClick={() => setViewMode('month')} className={`px-3 py-1 rounded text-sm font-medium transition ${viewMode === 'month' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Month</button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <button onClick={() => {
                if (viewMode === 'week') { const d = new Date(selectedDate); d.setDate(d.getDate() - 7); setSelectedDate(d); }
                else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1));
              }} className="p-2 hover:bg-gray-100 rounded-lg transition"><ChevronLeft size={20} /></button>
              <h3 className="text-xl font-semibold text-gray-900">{viewMode === 'week' ? getWeekRangeLabel(selectedDate) : selectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h3>
              <button onClick={() => {
                if (viewMode === 'week') { const d = new Date(selectedDate); d.setDate(d.getDate() + 7); setSelectedDate(d); }
                else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1));
              }} className="p-2 hover:bg-gray-100 rounded-lg transition"><ChevronRight size={20} /></button>
            </div>
          </div>
          <div className="p-6">
            {viewMode === 'month' ? (
              <MonthView
                selectedDate={selectedDate}
                events={myScheduleEvents}
                onDateClick={() => {}}
                hoveredDate={hoveredDate}
                setHoveredDate={setHoveredDate}
                canManage={true}
                setSelectedEvent={setSelectedEvent}
                setShowEventDetail={setShowEventDetail}
                eventColorFn={(ev) => ev?._is_facility ? getFacilityColorClasses(ev?.color, 'month') : null}
                onFacilityEventClick={(ev) => { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); }}
                onProgramDrop={handleProgramDrop}
              />
            ) : (
              <WeekView
                selectedDate={selectedDate}
                events={myScheduleEvents}
                onDateClick={() => {}}
                canManage={true}
                onEventClick={(ev) => {
                  if (ev._is_facility) { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); return; }
                  setSelectedEvent(ev); setShowEventDetail(true);
                }}
                eventColorFn={(ev) => ev?._is_facility ? getFacilityColorClasses(ev?.color, 'week') : null}
                onProgramDrop={handleProgramDrop}
              />
            )}
          </div>
          {showPlayerAddGame && (
            <PlayerAddGameModal
              userId={userId}
              onClose={() => setShowPlayerAddGame(false)}
              onSuccess={() => { setShowPlayerAddGame(false); fetchMyScheduleEvents(); }}
            />
          )}
          </div>
        </div>
      )}

      {/* Facility View */}
      {/* #452: Private Lessons — every coach's open lesson slots for the week. */}
      {view === 'lessons' && (() => {
        const coachesById = Object.fromEntries(coaches.map(c => [c.id, c]));
        const coachIdsWithSlots = new Set(lessonSlots.map(sl => sl.coach_id));
        const coachOptions = coaches.filter(c => coachIdsWithSlots.has(c.id));
        const visibleSlots = lessonSlots.filter(sl => {
          if (lessonCoachFilter !== 'all' && sl.coach_id !== lessonCoachFilter) return false;
          if (lessonSkillFilter !== 'All' && !(coachesById[sl.coach_id]?.skills || []).includes(lessonSkillFilter)) return false;
          return true;
        }).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
        return (
          <div className="bg-white rounded-lg shadow">
            <div className="border-b border-gray-200 p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Book a Private Lesson</h3>
                  <p className="text-sm text-gray-500">Open lesson times for every coach. Tap Reserve to request a session.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={lessonCoachFilter}
                    onChange={(e) => setLessonCoachFilter(e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    aria-label="Filter by coach"
                  >
                    <option value="all">All coaches</option>
                    {coachOptions.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                  </select>
                  <select
                    value={lessonSkillFilter}
                    onChange={(e) => setLessonSkillFilter(e.target.value)}
                    className="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    aria-label="Filter by skill"
                  >
                    <option value="All">All skills</option>
                    {COACH_SKILL_OPTIONS.map(sk => <option key={sk} value={sk}>{sk}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <button onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() - 7); setSelectedDate(d); }} className="p-2 hover:bg-gray-100 rounded-lg transition" aria-label="Previous week"><ChevronLeft size={20} /></button>
                <h3 className="text-xl font-semibold text-gray-900">{getWeekRangeLabel(selectedDate)}</h3>
                <button onClick={() => { const d = new Date(selectedDate); d.setDate(d.getDate() + 7); setSelectedDate(d); }} className="p-2 hover:bg-gray-100 rounded-lg transition" aria-label="Next week"><ChevronRight size={20} /></button>
              </div>
            </div>
            <div className="p-6">
              {lessonsLoading && lessonSlots.length === 0 ? (
                <div className="py-12 text-center text-gray-500">Loading lesson times…</div>
              ) : (
                <CoachSlotsWeekView
                  selectedDate={selectedDate}
                  slots={visibleSlots}
                  reservations={lessonReservations}
                  bookedCounts={lessonBookedCounts}
                  coach={null}
                  coachesById={coachesById}
                  userId={userId}
                  userRole={userRole}
                  canManage={false}
                  onAddSlot={() => {}}
                  onReserve={(slot) => setShowReserveSlot(slot)}
                  onMessageCoach={(target) => setMessageCoachTarget(target)}
                />
              )}
            </div>
          </div>
        );
      })()}

      {/* #452: athlete Facility tab — bookable facility time first. */}
      {view === 'facility' && userRole === 'player' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFacilityMode('book')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${facilityMode === 'book' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            Book facility time
          </button>
          <button
            onClick={() => setFacilityMode('mine')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${facilityMode === 'mine' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            My facility events
          </button>
        </div>
      )}
      {view === 'facility' && userRole === 'player' && facilityMode === 'book' && (
        <div className="bg-white rounded-lg shadow p-4 sm:p-6">
          <p className="text-sm text-gray-600 mb-4">
            NBP+ hour blocks, assessments, strength &amp; conditioning and cage time. For a one-on-one session with a coach, use{' '}
            <button type="button" onClick={() => setView('lessons')} className="text-indigo-600 font-medium hover:underline">Private Lessons</button>.
          </p>
          <PublicBookingPage embedded facilityOnly prefill={bookingPrefill} key={bookingPrefill ? 'prefilled' : 'blank'} />
        </div>
      )}

      {view === 'facility' && !(userRole === 'player' && facilityMode === 'book') && (
        <div className="bg-white rounded-lg shadow relative">
          {/* Coach Drawer (pop-out) */}
          {coachesDrawerOpen && (
            <div className="fixed inset-0 z-[60]" onClick={() => setCoachesDrawerOpen(false)}>
              <div className="absolute inset-0 bg-black bg-opacity-40" />
              <aside
                className="absolute top-0 left-0 h-full w-80 max-w-[90vw] bg-white shadow-xl flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">Coaches</h3>
                    <p className="text-xs text-gray-500 mt-1">Select a coach to view training slots</p>
                  </div>
                  <button
                    onClick={() => setCoachesDrawerOpen(false)}
                    className="p-1 text-gray-500 hover:text-gray-900"
                    aria-label="Close coaches drawer"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="p-3 border-b border-gray-200">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Filter by skill</label>
                  <select
                    value={coachSkillFilter}
                    onChange={(e) => setCoachSkillFilter(e.target.value)}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white text-gray-700"
                  >
                    <option value="All">All skills</option>
                    {COACH_SKILL_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {selectedCoach && (
                    <button
                      onClick={() => { setSelectedCoach(null); setCoachesDrawerOpen(false); }}
                      className="w-full px-4 py-3 text-left text-sm text-teal-600 hover:bg-teal-50 border-b border-gray-200 font-medium"
                    >
                      &larr; Back to Facility Events
                    </button>
                  )}
                  {coaches
                    .filter(coach => userRole !== 'player' || viewMode !== 'lanes' || coachDaySlots.some(s => s.coach_id === coach.id))
                    .filter(coach => coachSkillFilter === 'All' || (coach.skills || []).includes(coachSkillFilter))
                    .map(coach => (
                    <button
                      key={coach.id}
                      onClick={() => {
                        setSelectedCoach(selectedCoach?.id === coach.id ? null : coach);
                        setCoachesDrawerOpen(false);
                      }}
                      className={`w-full px-4 py-3 text-left hover:bg-gray-100 transition border-b border-gray-100 ${selectedCoach?.id === coach.id ? 'bg-teal-50 border-l-4 border-l-teal-500' : ''}`}
                    >
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-teal-600 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0">{coach.full_name.charAt(0)}</div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{coach.full_name}</div>
                          {coach.title && <div className="text-xs text-gray-500">{coach.title}</div>}
                          {coach.skills && coach.skills.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {coach.skills.map(s => (
                                <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${s === coachSkillFilter ? 'bg-teal-600 text-white' : 'bg-teal-50 text-teal-700'}`}>{s}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                  {coaches
                    .filter(coach => userRole !== 'player' || viewMode !== 'lanes' || coachDaySlots.some(s => s.coach_id === coach.id))
                    .filter(coach => coachSkillFilter === 'All' || (coach.skills || []).includes(coachSkillFilter)).length === 0 && (
                    <div className="px-4 py-6 text-center text-sm text-gray-500">
                      {userRole === 'player' && viewMode === 'lanes' && coachSkillFilter === 'All'
                        ? 'No coaches have availability on this day.'
                        : `No coaches cover ${coachSkillFilter}.`}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          )}

          <div className="flex">
            {/* Main Calendar Area */}
            <div className="flex-1 min-w-0">
              <div className="border-b border-gray-200 p-6">
                {/* QA 2026-08-15: flex-wrap, same reason as the My Schedule bar. */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      onClick={() => setCoachesDrawerOpen(true)}
                      className="flex items-center space-x-1 bg-gray-100 text-gray-700 hover:bg-gray-200 px-3 py-1.5 rounded-lg text-sm font-medium transition"
                    >
                      <Users size={16} />
                      <span>Coaches</span>
                    </button>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {selectedCoach ? `${selectedCoach.full_name}'s Training Slots` : 'Facility Calendar'}
                    </h3>
                    {canManageCalendar() && !selectedCoach && (
                      <button onClick={() => setShowEventTypeChooser('new')} className="bg-teal-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-teal-700 transition flex items-center space-x-1">
                        <Plus size={16} /><span>Add Event</span>
                      </button>
                    )}
                    {selectedCoach && (userRole === 'coach' || userRole === 'admin') && (
                      <button onClick={() => setShowCreateSlot('new')} className="bg-teal-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-teal-700 transition flex items-center space-x-1">
                        <Plus size={16} /><span>Add Training Slot</span>
                      </button>
                    )}
                    {canManageCalendar() && viewMode !== 'lanes' && (
                      <button onClick={() => { if (selecting) exitSelectMode(); else setSelecting(true); }} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition flex items-center space-x-1 ${selecting ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                        <CheckSquare size={16} /><span>{selecting ? 'Done' : 'Select'}</span>
                      </button>
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={() => setViewMode('week')} className={`px-3 py-1 rounded text-sm font-medium transition ${viewMode === 'week' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Week</button>
                    <button onClick={() => setViewMode('month')} className={`px-3 py-1 rounded text-sm font-medium transition ${viewMode === 'month' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Month</button>
                    <button onClick={() => setViewMode('lanes')} className={`px-3 py-1 rounded text-sm font-medium transition ${viewMode === 'lanes' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Lanes</button>
                  </div>
                </div>
                {selecting && selectedEvents.length > 0 && (
                  <div className="mb-3 flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-2 px-3">
                    <span className="text-sm text-blue-900 font-medium">{selectedEvents.length} selected</span>
                    <div className="flex items-center space-x-2">
                      <button onClick={bulkDelete} className="bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-red-700 transition flex items-center space-x-1">
                        <Trash2 size={14} /><span>Delete</span>
                      </button>
                      <button onClick={exitSelectMode} className="bg-gray-200 text-gray-700 px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-300 transition">Cancel</button>
                    </div>
                  </div>
                )}
                {viewMode !== 'lanes' && (
                <div className="flex items-center justify-between">
                  {/* When a coach is selected we always render CoachSlotsWeekView (a week
                      grid), so navigation must move by week regardless of viewMode —
                      otherwise players jump a whole month at a time and can't browse
                      availability to book (#152). */}
                  <button onClick={() => {
                    if (viewMode === 'week' || selectedCoach) { const d = new Date(selectedDate); d.setDate(d.getDate() - 7); setSelectedDate(d); }
                    else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1));
                  }} className="p-2 hover:bg-gray-100 rounded-lg transition"><ChevronLeft size={20} /></button>
                  <h3 className="text-xl font-semibold text-gray-900">{(viewMode === 'week' || selectedCoach) ? getWeekRangeLabel(selectedDate) : selectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h3>
                  <button onClick={() => {
                    if (viewMode === 'week' || selectedCoach) { const d = new Date(selectedDate); d.setDate(d.getDate() + 7); setSelectedDate(d); }
                    else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1));
                  }} className="p-2 hover:bg-gray-100 rounded-lg transition"><ChevronRight size={20} /></button>
                </div>
                )}
              </div>
              <div className={viewMode === 'lanes' ? 'p-3' : 'p-6'}>
                {selectedCoach && !coachModalOpen ? (
                  <CoachSlotsWeekView
                    selectedDate={selectedDate}
                    slots={coachSlots}
                    reservations={slotReservations}
                    publicBookings={publicSlotBookings}
                    bookedCounts={slotBookedCounts}
                    coach={selectedCoach}
                    userId={userId}
                    userRole={userRole}
                    canManage={userRole === 'coach' || userRole === 'admin'}
                    onAddSlot={(dateStr) => setShowCreateSlot(dateStr)}
                    selecting={selecting}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onEventContextMenu={onEventContextMenu('slot')}
                    onSlotDrop={handleSlotDrop}
                    onReserve={(slot) => setShowReserveSlot(slot)}
                    onConfirm={handleConfirmReservation}
                    onDecline={handleDeclineReservation}
                    onMarkAttendance={handleMarkAttendance}
                    onMessageCoach={(target) => setMessageCoachTarget(target)}
                  />
                ) : viewMode === 'lanes' ? (
                  <LaneView
                    selectedDate={selectedDate}
                    events={facilityEvents}
                    laneDate={laneDate}
                    setLaneDate={setLaneDate}
                    canManage={canManageCalendar()}
                    onCellClick={(prefill) => canManageCalendar() && setShowEventTypeChooser(prefill)}
                    onEventClick={(ev) => { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); }}
                    onEventMove={(eventId, sourceLane, targetLane, targetStartTime) => {
                      const ev = facilityEvents.find(e => String(e.id) === String(eventId));
                      if (!ev) return;

                      const currentLanes = ev.lanes || [];
                      const currentStart = ev.start_time || ev.event_time;
                      const timeChanged = !!targetStartTime && targetStartTime !== currentStart;

                      // Same-lane drop: a time-only move — no lane choice exists, no
                      // modal (#289 keeps today's behaviour here).
                      if (targetLane === sourceLane) {
                        if (!timeChanged) return;
                        applyFacilityEventMove(ev, null, targetStartTime);
                        return;
                      }

                      // Single-lane event: nothing to choose — today's behaviour,
                      // no modal. (shiftLanes on one lane always lands in bounds;
                      // the null-check stays as a backstop.)
                      if (currentLanes.length <= 1) {
                        const wholeLanes = shiftLanes(currentLanes, sourceLane, targetLane);
                        if (!wholeLanes) return;
                        applyFacilityEventMove(ev, wholeLanes, timeChanged ? targetStartTime : null);
                        return;
                      }

                      // Multi-lane event dropped on a different lane: the user picks
                      // whole-event vs single-lane in the modal (#289). wholeLanes
                      // null means the whole block wouldn't fit (#280's refusal) —
                      // the modal then offers only the single-lane move. Never
                      // auto-pick single-lane here: silently moving one lane is
                      // exactly the data-loss collapse #280 fixed.
                      setPendingLaneMove({
                        ev,
                        sourceLane,
                        targetLane,
                        targetStartTime: timeChanged ? targetStartTime : null,
                        wholeLanes: shiftLanes(currentLanes, sourceLane, targetLane),
                      });
                    }}
                    staffEvents={staffScheduleEvents}
                    staffAssignments={staffAssignments}
                    coachDaySlots={coachDaySlots}
                    eventPublicBookings={eventPublicBookings}
                    coaches={coaches}
                    onToggleCoachSchedule={toggleCoachSchedule}
                    onSlotEntryClick={(coach) => {
                      fetchCoachSlots(coach.id);
                      setSelectedCoach(coach);
                      setCoachModalOpen(true);
                    }}
                    onShiftEntryClick={(ev) => setShiftDetailEvent(ev)}
                    onSlotTimeDrop={handleSlotTimeDrop}
                  />
                ) : viewMode === 'month' ? (
                  <MonthView selectedDate={selectedDate} events={facilityEvents} onDateClick={(date) => canManageCalendar() && setShowEventTypeChooser(date)} hoveredDate={hoveredDate} setHoveredDate={setHoveredDate} canManage={canManageCalendar()} allowEventClick={true} setSelectedEvent={setSelectedFacilityEvent} setShowEventDetail={setShowFacilityEventDetail} eventColorFn={(ev) => getFacilityColorClasses(ev?.color, 'month')} selecting={selecting} selectedIds={selectedIds} onToggleSelect={toggleSelect} onEventContextMenu={onEventContextMenu('facility')} onEventDrop={async (eventId, newDate) => {
                    const ev = facilityEvents.find(e => String(e.id) === String(eventId));
                    if (!ev || ev._is_virtual || ev.event_date === newDate) return;
                    const { error } = await supabase.from('facility_events').update({ event_date: newDate }).eq('id', eventId);
                    if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
                    fetchFacilityEvents();
                  }} />
                ) : (
                  <WeekView selectedDate={selectedDate} events={facilityEvents} onDateClick={(date) => canManageCalendar() && setShowEventTypeChooser(date)} canManage={canManageCalendar()} allowEventClick={true} onEventClick={(ev) => { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); }} eventColorFn={(ev) => getFacilityColorClasses(ev?.color, 'week')} selecting={selecting} selectedIds={selectedIds} onToggleSelect={toggleSelect} onEventContextMenu={onEventContextMenu('facility')} onEventDrop={async (eventId, newDate) => {
                    const ev = facilityEvents.find(e => String(e.id) === String(eventId));
                    if (!ev || ev._is_virtual || ev.event_date === newDate) return;
                    const { error } = await supabase.from('facility_events').update({ event_date: newDate }).eq('id', eventId);
                    if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
                    fetchFacilityEvents();
                  }} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Team/Player Calendar Container */}
      {view !== 'facility' && view !== 'my-schedule' && <><div className="flex space-x-4">{(userRole === 'admin' || userRole === 'coach') && <ProgramLibrarySidebar collapsed={libraryCollapsed} onToggle={() => setLibraryCollapsed(!libraryCollapsed)} />}<div className="bg-white rounded-lg shadow flex-1 min-w-0">
        {/* Calendar Header */}
        <div className="border-b border-gray-200 p-6">
          {/* QA 2026-08-15: flex-wrap, same reason as the My Schedule bar. */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            {/* Team/Player Selector */}
            <div className="flex flex-wrap items-center gap-4">
              {view === 'team' ? (
                <select
                  value={selectedTeam || ''}
                  onChange={(e) => setSelectedTeam(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {teams.map(team => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              ) : (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => { setPlayerDropdownOpen(!playerDropdownOpen); if (playerDropdownOpen) setPlayerSearch(''); }}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-[240px] text-left flex items-center justify-between"
                  >
                    <span className="text-sm truncate">
                      {selectedPlayers.length === 0
                        ? (selectedPlayer ? (players.find(p => p.id === selectedPlayer)?.full_name || 'Select players...') : 'Select players...')
                        : selectedPlayers.length === 1
                          ? (players.find(p => p.id === selectedPlayers[0])?.full_name || '1 player')
                          : `${selectedPlayers.length} players selected`}
                    </span>
                    <ChevronRight size={16} className={`transition-transform ${playerDropdownOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {playerDropdownOpen && (
                    <div className="absolute z-20 mt-1 w-72 bg-white border border-gray-300 rounded-lg shadow-lg max-h-80 flex flex-col">
                      <div className="p-2 border-b border-gray-200">
                        <div className="relative mb-2">
                          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                          <input
                            type="text"
                            value={playerSearch}
                            onChange={(e) => setPlayerSearch(e.target.value)}
                            placeholder="Search players..."
                            className="w-full pl-7 pr-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-500">{selectedPlayers.length} selected</span>
                          <button
                            type="button"
                            onClick={() => { setSelectedPlayers([]); setSelectedPlayer(null); }}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            Clear all
                          </button>
                        </div>
                      </div>
                      <div className="overflow-y-auto flex-1">
                      {players.filter(p => !playerSearch || p.full_name.toLowerCase().includes(playerSearch.toLowerCase())).map((player) => {
                        const checked = selectedPlayers.includes(player.id);
                        const paletteIdx = selectedPlayers.indexOf(player.id);
                        return (
                          <label key={player.id} className="flex items-center space-x-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setSelectedPlayers(prev => {
                                  const next = prev.includes(player.id) ? prev.filter(id => id !== player.id) : [...prev, player.id];
                                  setSelectedPlayer(next[0] || null);
                                  return next;
                                });
                              }}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            {checked && paletteIdx >= 0 && (
                              <span className={`inline-block w-3 h-3 rounded-full ${PLAYER_OVERLAY_PALETTE[paletteIdx % PLAYER_OVERLAY_PALETTE.length].dot}`} />
                            )}
                            <span className="text-sm text-gray-900">{player.full_name}</span>
                          </label>
                        );
                      })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* View Mode Toggle */}
            {/* QA 2026-08-15: wrap this inner group too — the 240px player picker
                beside it meant the outer row had no break point on a phone. */}
            <div className="flex flex-wrap items-center gap-2">
              {canManageCalendar() && (
                <button
                  onClick={() => { if (selecting) exitSelectMode(); else setSelecting(true); }}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition flex items-center space-x-1 ${selecting ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  <CheckSquare size={16} /><span>{selecting ? 'Done' : 'Select'}</span>
                </button>
              )}
              <button
                onClick={() => setViewMode('week')}
                className={`px-3 py-1 rounded text-sm font-medium transition ${
                  viewMode === 'week' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Week
              </button>
              <button
                onClick={() => setViewMode('month')}
                className={`px-3 py-1 rounded text-sm font-medium transition ${
                  viewMode === 'month' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Month
              </button>
            </div>
          </div>

          {selecting && selectedEvents.length > 0 && (
            <div className="mb-3 flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-2 px-3">
              <span className="text-sm text-blue-900 font-medium">{selectedEvents.length} selected</span>
              <div className="flex items-center space-x-2">
                <button onClick={bulkDelete} className="bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-red-700 transition flex items-center space-x-1">
                  <Trash2 size={14} /><span>Delete</span>
                </button>
                <button onClick={exitSelectMode} className="bg-gray-200 text-gray-700 px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-300 transition">Cancel</button>
              </div>
            </div>
          )}

          {/* Month / Week Navigation */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                if (viewMode === 'week') { const d = new Date(selectedDate); d.setDate(d.getDate() - 7); setSelectedDate(d); }
                else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1));
              }}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronLeft size={20} />
            </button>
            <h3 className="text-xl font-semibold text-gray-900">
              {viewMode === 'week' ? getWeekRangeLabel(selectedDate) : selectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h3>
            <button
              onClick={() => {
                if (viewMode === 'week') { const d = new Date(selectedDate); d.setDate(d.getDate() + 7); setSelectedDate(d); }
                else setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1));
              }}
              className="p-2 hover:bg-gray-100 rounded-lg transition"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="p-6">
          {view === 'player' && selectedPlayers.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {selectedPlayers.map((pid, idx) => {
                const player = players.find(p => p.id === pid);
                if (!player) return null;
                const c = PLAYER_OVERLAY_PALETTE[idx % PLAYER_OVERLAY_PALETTE.length];
                return (
                  <span key={pid} className="inline-flex items-center space-x-2 px-2 py-1 rounded-full bg-gray-100 text-xs">
                    <span className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
                    <span className="text-gray-800">{player.full_name}</span>
                  </span>
                );
              })}
            </div>
          )}
          {viewMode === 'month' ? (
            <MonthView
              selectedDate={selectedDate}
              events={events}
              onDateClick={(date) => canManageCalendar() && setShowAddPanel(date)}
              hoveredDate={hoveredDate}
              setHoveredDate={setHoveredDate}
              canManage={canManageCalendar()}
              allowEventClick={true}
              setSelectedEvent={setSelectedEvent}
              setShowEventDetail={setShowEventDetail}
              eventColorFn={(ev) => ev?._is_facility ? getFacilityColorClasses(ev?.color, 'month') : null}
              onFacilityEventClick={(ev) => { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); }}
              selecting={selecting}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onEventContextMenu={onEventContextMenu('team')}
              onProgramDrop={handleProgramDrop}
              onEventDrop={async (eventId, newDate) => {
                const ev = events.find(e => String(e.id) === String(eventId));
                if (!ev || ev._is_facility || ev.event_date === newDate) return;
                const { error } = await supabase.from('schedule_events').update({ event_date: newDate }).eq('id', eventId);
                if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
                if (view === 'team') fetchTeamEvents(); else fetchPlayerEvents();
              }}
              playerNames={(view === 'player' && selectedPlayers.length > 1) || view === 'team' ? players.reduce((m, p) => { m[p.id] = p.full_name; return m; }, {}) : null}
            />
          ) : (
            <WeekView
              selectedDate={selectedDate}
              events={events}
              onDateClick={(date) => canManageCalendar() && setShowAddPanel(date)}
              canManage={canManageCalendar()}
              allowEventClick={true}
              onEventClick={(ev) => {
                if (ev._is_facility) { setSelectedFacilityEvent(ev); setShowFacilityEventDetail(true); return; }
                setSelectedEvent(ev); setShowEventDetail(true);
              }}
              eventColorFn={(ev) => ev?._is_facility ? getFacilityColorClasses(ev?.color, 'week') : null}
              selecting={selecting}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onEventContextMenu={onEventContextMenu('team')}
              onProgramDrop={handleProgramDrop}
              onEventDrop={async (eventId, newDate) => {
                const ev = events.find(e => String(e.id) === String(eventId));
                if (!ev || ev._is_facility || ev.event_date === newDate) return;
                const { error } = await supabase.from('schedule_events').update({ event_date: newDate }).eq('id', eventId);
                if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
                if (view === 'team') fetchTeamEvents(); else fetchPlayerEvents();
              }}
              playerNames={(view === 'player' && selectedPlayers.length > 1) || view === 'team' ? players.reduce((m, p) => { m[p.id] = p.full_name; return m; }, {}) : null}
            />
          )}
        </div>
      </div>
      </div>

      {/* Add Event Panel */}
      {showAddPanel && (
        <AddEventPanel
          date={showAddPanel}
          view={view}
          teamId={selectedTeam}
          playerIds={selectedPlayers.length > 0 ? selectedPlayers : (selectedPlayer ? [selectedPlayer] : [])}
          onClose={() => setShowAddPanel(null)}
          onSuccess={() => {
            setShowAddPanel(null);
            if (view === 'team') fetchTeamEvents();
            else fetchPlayerEvents();
          }}
        />
      )}

      {/* Event Detail/Edit Modal */}
      </>}

      {/* Event detail modal — rendered at top level so it works in every view
          (team/player AND the player's My Schedule view). Previously this lived
          inside the team/player fragment, so players clicking a workout on their
          own schedule set the state but no modal ever mounted (#153, #159). */}
      {showEventDetail && selectedEvent && (
        selectedEvent.event_type === 'workout' ? (
          <WorkoutDetailModal
            event={selectedEvent}
            userRole={userRole}
            userId={userId}
            onClose={() => {
              setShowEventDetail(false);
              setSelectedEvent(null);
            }}
            onDelete={() => {
              setShowEventDetail(false);
              setSelectedEvent(null);
              if (view === 'team') fetchTeamEvents();
              else if (view === 'my-schedule') fetchMyScheduleEvents();
              else fetchPlayerEvents();
            }}
          />
        ) : (
          <EventDetailModal
            event={selectedEvent}
            userRole={userRole}
            userId={userId}
            onMessageCoach={(target) => setMessageCoachTarget(target)}
            onClose={() => {
              setShowEventDetail(false);
              setSelectedEvent(null);
            }}
            onDelete={() => {
              setShowEventDetail(false);
              setSelectedEvent(null);
              if (view === 'team') fetchTeamEvents();
              else if (view === 'my-schedule') fetchMyScheduleEvents();
              else fetchPlayerEvents();
            }}
            onUpdate={() => {
              setShowEventDetail(false);
              setSelectedEvent(null);
              if (view === 'team') fetchTeamEvents();
              else if (view === 'my-schedule') fetchMyScheduleEvents();
              else fetchPlayerEvents();
            }}
          />
        )
      )}

      {/* Facility Event Panels */}
      {showEventTypeChooser !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowEventTypeChooser(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xl font-bold text-gray-900">Add event</h3>
              <button onClick={() => setShowEventTypeChooser(null)} className="text-gray-400 hover:text-gray-600"><X size={22} /></button>
            </div>
            <p className="text-sm text-gray-500 mb-5">What would you like to create?</p>
            <div className="space-y-3">
              <button
                onClick={() => { setShowAddFacilityEvent(showEventTypeChooser); setShowEventTypeChooser(null); }}
                className="w-full flex items-start space-x-3 border border-gray-200 rounded-lg p-4 hover:border-teal-400 hover:bg-teal-50/40 transition text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center flex-shrink-0"><CalendarIcon size={18} /></div>
                <div>
                  <div className="font-semibold text-gray-900">Organization Event</div>
                  <div className="text-xs text-gray-500">Internal facility event — teams, athletes, lanes, coaches.</div>
                </div>
              </button>
              <button
                onClick={() => { setShowAddPublicBooking(showEventTypeChooser); setShowEventTypeChooser(null); }}
                className="w-full flex items-start space-x-3 border border-gray-200 rounded-lg p-4 hover:border-emerald-400 hover:bg-emerald-50/40 transition text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0"><DollarSign size={18} /></div>
                <div>
                  <div className="font-semibold text-gray-900">Public Booking</div>
                  <div className="text-xs text-gray-500">Bookable & payable by outside customers on the public /book page.</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
      {showAddFacilityEvent && (
        <AddFacilityEventPanel
          date={showAddFacilityEvent}
          mode="org"
          onClose={() => setShowAddFacilityEvent(null)}
          onSuccess={() => { setShowAddFacilityEvent(null); fetchFacilityEvents(); }}
        />
      )}
      {showAddPublicBooking && (
        <AddFacilityEventPanel
          date={showAddPublicBooking}
          mode="public"
          onClose={() => setShowAddPublicBooking(null)}
          onSuccess={() => { setShowAddPublicBooking(null); fetchFacilityEvents(); }}
        />
      )}
      {showFacilityEventDetail && selectedFacilityEvent && (
        <FacilityEventDetail
          event={selectedFacilityEvent}
          userId={userId}
          userRole={userRole}
          coaches={coaches}
          onClose={() => { setShowFacilityEventDetail(false); setSelectedFacilityEvent(null); }}
          onUpdate={() => {
            setShowFacilityEventDetail(false); setSelectedFacilityEvent(null); fetchFacilityEvents();
            // #287: the modal can now be opened from the Team calendar and My
            // Schedule too — refresh whichever event list is on screen.
            if (view === 'team') fetchTeamEvents(); else if (view === 'my-schedule') fetchMyScheduleEvents();
          }}
          onDelete={() => {
            setShowFacilityEventDetail(false); setSelectedFacilityEvent(null); fetchFacilityEvents();
            if (view === 'team') fetchTeamEvents(); else if (view === 'my-schedule') fetchMyScheduleEvents();
          }}
        />
      )}
      {/* #289: whole-event vs single-lane choice for a multi-lane LaneView drop.
          Cancel aborts the move entirely — nothing is written. */}
      {pendingLaneMove && (
        <LaneMoveDecisionModal
          eventTitle={pendingLaneMove.ev.title}
          sourceLane={pendingLaneMove.sourceLane}
          targetLane={pendingLaneMove.targetLane}
          allowWhole={!!pendingLaneMove.wholeLanes}
          startTimeLabel={pendingLaneMove.targetStartTime
            ? formatTimeDisplay(pendingLaneMove.ev.start_time || pendingLaneMove.ev.event_time)
            : null}
          onPick={(choice) => {
            const move = pendingLaneMove;
            setPendingLaneMove(null);
            if (choice === 'whole') {
              if (!move.wholeLanes) return;
              applyFacilityEventMove(move.ev, move.wholeLanes, move.targetStartTime);
            } else {
              // Lanes only — a single-lane time change would require splitting
              // the row into two events (out of scope for v1); the modal
              // says so, and the time is deliberately not applied here.
              applyFacilityEventMove(move.ev, replaceSingleLane(move.ev.lanes || [], move.sourceLane, move.targetLane), null);
            }
          }}
          onClose={() => setPendingLaneMove(null)}
        />
      )}
      {/* #292: moving the master bar of a repeating training slot is ambiguous
          — this occurrence or the whole series? Same modal #279 taught.
          "This and future" is deliberately absent (allowFuture) — splitting a
          series would strand slot_reservations. Cancel writes nothing. */}
      {pendingSlotMove && (
        <RecurrenceDecisionModal
          title="Move a repeating slot"
          message={`Move just the ${new Date(pendingSlotMove.slot.slot_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} session to ${new Date(pendingSlotMove.newDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, or move the whole series?`}
          actionLabel="Move"
          allowOne={true}
          allowFuture={false}
          onPick={async (choice) => {
            const move = pendingSlotMove;
            setPendingSlotMove(null);
            if (choice === 'one') {
              await moveSlotOccurrence(move.slot.id, move.slot.id, move.slot, move.slot.slot_date, move.newDate);
              return;
            }
            // 'all' — the whole series re-anchors to the drop date, exactly
            // what dragging this bar did before #292.
            const { error } = await supabase.from('training_slots').update({ slot_date: move.newDate }).eq('id', move.slot.id);
            if (error) { alert('Failed to move slot: ' + formatUserError(error)); return; }
            fetchCoachSlots(selectedCoach.id);
          }}
          onClose={() => setPendingSlotMove(null)}
        />
      )}
      {/* #309: dragging a repeating slot's time on the Lanes Staff Schedule
          band is the same one-vs-series ambiguity #292 already solved for a
          DAY change — same modal, applied here to a TIME change instead. */}
      {pendingSlotTimeMove && (
        <RecurrenceDecisionModal
          title="Change the time of a repeating slot"
          message={`Change just today's session to ${formatTimeDisplay(pendingSlotTimeMove.newStartTime)}, or change the whole series' time?`}
          actionLabel="Change"
          allowOne={true}
          allowFuture={false}
          onPick={async (choice) => {
            const move = pendingSlotTimeMove;
            setPendingSlotTimeMove(null);
            await applySlotTimeChange(choice === 'one' ? 'one' : 'all', move.slot, move.newStartTime);
          }}
          onClose={() => setPendingSlotTimeMove(null)}
        />
      )}
      {/* #309/#314: CoachSlotsWeekView reused as a modal over the Lanes view
          when a slot entry is clicked in the Staff Schedule band — same
          component, same selectedCoach-driven state and handlers as the main
          panel render above, just a different render location. z-40 (below
          the standard z-50 used by CreateSlotPanel/ReserveSlotModal/
          RecurrenceDecisionModal below) so those still open on top of this
          when triggered from inside it, exactly as they do from the main
          panel. */}
      {selectedCoach && coachModalOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-40 p-4 overflow-y-auto"
          onClick={() => { setCoachModalOpen(false); setSelectedCoach(null); }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold text-gray-900">{selectedCoach.full_name}</h3>
              <button onClick={() => { setCoachModalOpen(false); setSelectedCoach(null); }} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <div className="p-4">
              <CoachSlotsWeekView
                selectedDate={selectedDate}
                slots={coachSlots}
                reservations={slotReservations}
                publicBookings={publicSlotBookings}
                bookedCounts={slotBookedCounts}
                coach={selectedCoach}
                userId={userId}
                userRole={userRole}
                canManage={userRole === 'coach' || userRole === 'admin'}
                onAddSlot={(dateStr) => setShowCreateSlot(dateStr)}
                selecting={selecting}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onEventContextMenu={onEventContextMenu('slot')}
                onSlotDrop={handleSlotDrop}
                onReserve={(slot) => setShowReserveSlot(slot)}
                onConfirm={handleConfirmReservation}
                onDecline={handleDeclineReservation}
                onMarkAttendance={handleMarkAttendance}
                onMessageCoach={(target) => setMessageCoachTarget(target)}
              />
            </div>
          </div>
        </div>
      )}
      {/* #407: compose-and-jump "Message coach" for a booked session. onSent
          closes everything here and hands the conversation id up to App, which
          switches to Messages with that thread open. */}
      {messageCoachTarget && (
        <MessageCoachModal
          {...messageCoachTarget}
          userId={userId}
          onClose={() => setMessageCoachTarget(null)}
          onSent={(conversationId) => {
            setMessageCoachTarget(null);
            setShowEventDetail(false);
            setSelectedEvent(null);
            if (onMessageCoach) onMessageCoach(conversationId);
            else alert('Message sent. Find the reply under Communication → Messages.');
          }}
        />
      )}
      {/* #309: read-only detail popup for a Work Portal shift clicked in the
          same band. Deliberately NOT WorkSchedule.js's EventDetailModal —
          that component also drives shift editing/deletion and recurrence
          changes, which pulls in staff_schedule_assignments plumbing this
          file doesn't have loaded; a lightweight, view-only popup covers what
          #309 actually asked for without that cross-file coupling. */}
      {shiftDetailEvent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShiftDetailEvent(null)}>
          {/* #347 QA sweep: capped and scrollable, so long text makes the card
              scroll rather than pushing its own close button off the screen. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b gap-3">
              {/* #347 QA sweep: free-text title in a header. Clamped to two lines
                  (full text on hover) so a long one can neither grow the header
                  nor push the X out of the card. */}
              <h3 className="text-lg font-semibold text-gray-900 min-w-0 line-clamp-2 break-words" title={shiftDetailEvent.title || undefined}>{shiftDetailEvent.title}</h3>
              <button onClick={() => setShiftDetailEvent(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center space-x-2 text-sm text-gray-700">
                <CalendarIcon size={16} className="text-gray-400" />
                <span>
                  {new Date(shiftDetailEvent.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>
              <div className="flex items-center space-x-2 text-sm text-gray-700">
                <Clock size={16} className="text-gray-400" />
                <span>
                  {new Date(shiftDetailEvent.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  {shiftDetailEvent.end_at ? ` – ${new Date(shiftDetailEvent.end_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
                </span>
              </div>
              {shiftDetailEvent.location && (
                /* #347 QA sweep: a long location used to paint straight out of
                   the card. min-w-0 + break-words keeps it inside. */
                <div className="flex items-center space-x-2 text-sm text-gray-700 min-w-0">
                  <MapPin size={16} className="text-gray-400 flex-shrink-0" />
                  <span className="min-w-0 break-words">{shiftDetailEvent.location}</span>
                </div>
              )}
              {shiftDetailEvent.recurrence_parent_id && (
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <Repeat size={14} className="text-gray-400" />
                  <span>Recurring shift</span>
                </div>
              )}
              {shiftDetailEvent.description && (
                <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{shiftDetailEvent.description}</div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Training Slot Panels */}
      {showCreateSlot && selectedCoach && (
        <CreateSlotPanel
          onClose={() => setShowCreateSlot(null)}
          onSuccess={() => { setShowCreateSlot(null); if (selectedCoach) fetchCoachSlots(selectedCoach.id); }}
          coachId={selectedCoach.id}
          coachName={selectedCoach.full_name}
          initialDate={typeof showCreateSlot === 'string' && showCreateSlot !== 'new' ? showCreateSlot : null}
        />
      )}
      {showEditSlot && selectedCoach && (
        <CreateSlotPanel
          onClose={() => setShowEditSlot(null)}
          onSuccess={() => { setShowEditSlot(null); if (selectedCoach) fetchCoachSlots(selectedCoach.id); }}
          coachId={selectedCoach.id}
          coachName={selectedCoach.full_name}
          existingSlot={showEditSlot}
        />
      )}
      {showReserveSlot && (
        <ReserveSlotModal
          slot={showReserveSlot}
          coach={selectedCoach || coaches.find(c => c.id === showReserveSlot.coach_id) || null}
          onClose={() => setShowReserveSlot(null)}
          onSuccess={() => { setShowReserveSlot(null); if (selectedCoach) fetchCoachSlots(selectedCoach.id); if (view === 'lessons') fetchLessonSlots(); }}
        />
      )}
      {/* #276: coach confirming a booking that puts the athlete over their
          weekly allowance — warn, but let the coach go ahead. */}
      {capConfirm && (
        <BookingCapWarningModal
          message={capConfirm.message}
          proceedLabel="Confirm anyway"
          onCancel={() => setCapConfirm(null)}
          onProceed={() => { const id = capConfirm.reservationId; setCapConfirm(null); handleConfirmReservation(id, true); }}
        />
      )}
      {ctxMenu && (
        <CalendarContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}
      {recurrencePrompt && (
        <RecurrenceDecisionModal
          title="This is a recurring event"
          message="What part of the series do you want to delete?"
          actionLabel="Delete"
          allowOne={recurrencePrompt.allowOne !== false}
          onPick={recurrencePrompt.onPick}
          onClose={() => setRecurrencePrompt(null)}
        />
      )}
      {copyToPicker && (
        <CopyToPickerModal
          title={copyToPicker.title}
          options={copyToPicker.options}
          actionLabel={copyToPicker.actionLabel || 'Copy'}
          onPick={copyToPicker.onPick}
          onClose={() => setCopyToPicker(null)}
        />
      )}
    </div>
  );
}

// ============================================
// MONTH VIEW
// ============================================

function MonthView({ selectedDate, events, onDateClick, hoveredDate, setHoveredDate, canManage, setSelectedEvent, setShowEventDetail, eventColorFn, onEventDrop, allowEventClick, selecting, selectedIds, onToggleSelect, onEventContextMenu, onProgramDrop, playerNames, onFacilityEventClick }) {
  const eventsAreClickable = canManage || allowEventClick;
  const isSelected = (e) => selecting && selectedIds && selectedIds.has(String(e.id));
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Previous month's trailing days
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startingDayOfWeek - 1; i >= 0; i--) {
    days.push({
      date: new Date(year, month - 1, prevMonthLastDay - i),
      isCurrentMonth: false
    });
  }

  // Current month's days
  for (let i = 1; i <= daysInMonth; i++) {
    days.push({
      date: new Date(year, month, i),
      isCurrentMonth: true
    });
  }

  // Next month's leading days
  const remainingDays = 42 - days.length; // 6 rows × 7 days
  for (let i = 1; i <= remainingDays; i++) {
    days.push({
      date: new Date(year, month + 1, i),
      isCurrentMonth: false
    });
  }

  const formatLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const getEventsForDate = (date) => {
    const dateStr = formatLocal(date);
    return events.filter(e => e.event_date === dateStr);
  };

  const getEventColor = (event) => {
    const eventType = typeof event === 'string' ? event : event?.event_type;
    if (eventType === 'workout') {
      // Prefer the explicit category column set at drag/drop time (#191); fall
      // back to title heuristic for legacy rows that don't have it yet.
      const cat = (typeof event === 'object' && event?.category) || getWorkoutCategory(typeof event === 'string' ? '' : event?.title);
      switch(cat) {
        case 'hitting': return 'bg-teal-500 text-white border-teal-600';
        case 'pitching': return 'bg-green-500 text-white border-green-600';
        case 'fielding': return 'bg-green-500 text-white border-green-600';
        case 'strength': return 'bg-orange-500 text-white border-orange-600';
        case 'recovery': return 'bg-purple-500 text-white border-purple-600';
        case 'warmup': return 'bg-purple-500 text-white border-purple-600';
        case 'mobility': return 'bg-purple-500 text-white border-purple-600';
        case 'pt': return 'bg-rose-500 text-white border-rose-600'; // #454
        case 'conditioning': return 'bg-yellow-500 text-white border-yellow-600';
        default: return 'bg-gray-500 text-white border-gray-600';
      }
    }
    switch(eventType) {
      case 'game': return 'bg-slate-600 text-white border-slate-700';
      case 'practice': return 'bg-green-500 text-white border-green-600';
      case 'tryout': return 'bg-amber-500 text-white border-amber-600';
      case 'meal': return 'bg-yellow-400 text-yellow-900 border-yellow-500';
      case 'training_slot': return getTrainingSlotColorClasses(typeof event === 'object' ? event?.title : '', 'pill');
      default: return 'bg-gray-500 text-white border-gray-600';
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="p-2 text-center text-sm font-semibold text-gray-700">
            {day}
          </div>
        ))}
      </div>

      {/* Calendar days */}
      <div className="grid grid-cols-7">
        {days.map((day, idx) => {
          const dateStr = formatLocal(day.date);
          const dayEvents = getEventsForDate(day.date);
          const isToday = day.date.getTime() === today.getTime();
          const isHovered = hoveredDate === dateStr;

          return (
            <div
              key={idx}
              className={`min-h-[120px] border-b border-r border-gray-200 p-2 relative ${
                !day.isCurrentMonth ? 'bg-gray-50' : 'bg-white hover:bg-gray-50'
              } transition cursor-pointer`}
              onClick={() => day.isCurrentMonth && onDateClick(dateStr)}
              onMouseEnter={() => setHoveredDate(dateStr)}
              onMouseLeave={() => setHoveredDate(null)}
              onDragOver={(e) => {
                if (!day.isCurrentMonth) return;
                const types = [...e.dataTransfer.types];
                if (types.includes('application/x-program-item') && onProgramDrop) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                } else if (types.includes('application/x-event-id') && canManage && onEventDrop) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                if (!day.isCurrentMonth) return;
                e.preventDefault();
                const eventId = e.dataTransfer.getData('application/x-event-id');
                if (eventId && canManage && onEventDrop) { onEventDrop(eventId, dateStr); return; }
                const programData = e.dataTransfer.getData('application/x-program-item');
                if (programData && onProgramDrop) {
                  try { onProgramDrop(JSON.parse(programData), dateStr); } catch (_) {}
                }
              }}
            >
              {/* Date number */}
              <div className={`text-sm font-medium mb-1 ${
                !day.isCurrentMonth ? 'text-gray-400' :
                isToday ? 'text-blue-600 font-bold' : 'text-gray-900'
              }`}>
                {day.date.getDate()}
              </div>

              {/* Events */}
              <div className="space-y-1 max-h-[140px] overflow-y-auto">
                {dayEvents.map(event => (
                  <div
                    key={event.id}
                    draggable={canManage && !selecting && !event._is_virtual && !event._isMealPlan && !event._is_facility && !!onEventDrop}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.setData('application/x-event-id', String(event.id));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      // #287: facility rows on the team/my-schedule calendars are
                      // read-only here — never selectable (bulk delete targets
                      // schedule_events), and clicking opens the facility detail
                      // modal instead of the schedule_events one.
                      if (event._is_facility) {
                        if (!selecting && eventsAreClickable && onFacilityEventClick) onFacilityEventClick(event);
                        return;
                      }
                      if (selecting && onToggleSelect) { onToggleSelect(event); return; }
                      if (eventsAreClickable && setSelectedEvent && setShowEventDetail) {
                        setSelectedEvent(event);
                        setShowEventDetail(true);
                      }
                    }}
                    onContextMenu={(e) => { if (onEventContextMenu && !event._is_facility) { e.preventDefault(); e.stopPropagation(); onEventContextMenu(event, e); } }}
                    className={`text-xs px-2 py-1 rounded border truncate flex items-center justify-between gap-1 group/event ${(eventColorFn && eventColorFn(event)) || getEventColor(event)} ${eventsAreClickable ? 'cursor-pointer hover:opacity-75' : ''} ${isSelected(event) ? 'ring-2 ring-blue-500' : ''}`}
                    title={canManage ? `Right-click for options. Drag to reschedule: ${event.title || event.opponent || event.event_type}` : event.title || event.opponent || event.event_type}
                  >
                    <span className="truncate">
                      {isSelected(event) && <Check size={10} className="inline mr-1" />}
                      {playerNames && event.player_id && playerNames[event.player_id] && (
                        <span className="font-semibold mr-1 opacity-70">{playerNames[event.player_id].split(' ').map(n => n[0]).join('')}</span>
                      )}
                      {(event.start_time || event.event_time) && <span className="font-medium">{formatTimeDisplay(event.start_time || event.event_time)} </span>}
                      {event.title || event.opponent || event.event_type}
                    </span>
                    {/* #431: training slots (coach schedule) and facility events
                        both carry _booked_count; anything without it (team
                        schedule events) gets no badge. */}
                    {event._booked_count > 0 && (
                      <span className="flex-shrink-0 w-3.5 h-3.5 bg-green-500 rounded-full inline-flex items-center justify-center group-hover/event:opacity-0 transition" title={`${event._booked_count} booked`}>
                        <Check size={8} className="text-white" />
                      </span>
                    )}
                    {canManage && !selecting && <Edit2 size={10} className="flex-shrink-0 opacity-0 group-hover/event:opacity-70 transition" />}
                  </div>
                ))}
              </div>

              {/* Add button on hover */}
              {canManage && day.isCurrentMonth && isHovered && (
                <button
                  className="absolute top-1 right-1 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center hover:bg-blue-700 transition"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDateClick(dateStr);
                  }}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================
// WEEK VIEW
// ============================================

function WeekView({ selectedDate, events, onDateClick, canManage, eventColorFn, onEventClick, onEventDrop, allowEventClick, selecting, selectedIds, onToggleSelect, onEventContextMenu, onProgramDrop, playerNames }) {
  // Get the week containing selectedDate
  const startOfWeek = new Date(selectedDate);
  startOfWeek.setDate(selectedDate.getDate() - selectedDate.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + i);
    weekDays.push(date);
  }

  const formatLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const getEventsForDate = (date) => {
    const dateStr = formatLocal(date);
    return events.filter(e => e.event_date === dateStr);
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="grid grid-cols-7 divide-x divide-gray-200">
        {weekDays.map((date, idx) => {
          const dateStr = formatLocal(date);
          const dayEvents = getEventsForDate(date);
          const isToday = date.getTime() === today.getTime();

          return (
            <div
              key={idx}
              className="min-h-[400px] bg-white"
              onDragOver={(e) => {
                const types = [...e.dataTransfer.types];
                if (types.includes('application/x-program-item') && onProgramDrop) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                } else if (types.includes('application/x-event-id') && canManage && onEventDrop) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const eventId = e.dataTransfer.getData('application/x-event-id');
                if (eventId && canManage && onEventDrop) { onEventDrop(eventId, dateStr); return; }
                const programData = e.dataTransfer.getData('application/x-program-item');
                if (programData && onProgramDrop) {
                  try { onProgramDrop(JSON.parse(programData), dateStr); } catch (_) {}
                }
              }}
            >
              {/* Day header */}
              <div className={`p-3 border-b border-gray-200 text-center ${
                isToday ? 'bg-blue-50' : 'bg-gray-50'
              }`}>
                <div className="text-xs font-medium text-gray-600">
                  {date.toLocaleDateString('en-US', { weekday: 'short' })}
                </div>
                <div className={`text-lg font-semibold ${
                  isToday ? 'text-blue-600' : 'text-gray-900'
                }`}>
                  {date.getDate()}
                </div>
              </div>

              {/* Events */}
              <div className="p-2 space-y-2">
                {dayEvents.map(event => (
                  <EventCard
                    key={event.id}
                    event={event}
                    compact
                    eventColorFn={eventColorFn}
                    playerNames={playerNames}
                    onClick={(ev) => {
                      // #287: facility rows are read-only — never selectable;
                      // clicks still route (the parent opens the facility modal).
                      if (ev._is_facility) {
                        if (!selecting && (canManage || allowEventClick) && onEventClick) onEventClick(ev);
                        return;
                      }
                      if (selecting && onToggleSelect) { onToggleSelect(ev); return; }
                      if ((canManage || allowEventClick) && onEventClick) onEventClick(ev);
                    }}
                    onContextMenu={onEventContextMenu}
                    draggable={canManage && !selecting && !event._is_virtual && !event._isMealPlan && !event._is_facility && !!onEventDrop}
                    selected={selecting && selectedIds && selectedIds.has(String(event.id))}
                  />
                ))}

                {/* Add button */}
                {canManage && (
                  <button
                    onClick={() => onDateClick(dateStr)}
                    className="w-full border-2 border-dashed border-gray-300 rounded-lg py-2 text-gray-500 hover:border-blue-500 hover:text-blue-600 transition flex items-center justify-center space-x-1"
                  >
                    <Plus size={16} />
                    <span className="text-xs font-medium">Add</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventCard({ event, compact, eventColorFn, onClick, draggable, onContextMenu, selected, playerNames }) {
  const getEventColor = (ev) => {
    const eventType = typeof ev === 'string' ? ev : ev?.event_type;
    if (eventType === 'workout') {
      // Match MonthView palette: read explicit category first (#191).
      const cat = (typeof ev === 'object' && ev?.category) || getWorkoutCategory(typeof ev === 'string' ? '' : ev?.title);
      switch(cat) {
        case 'hitting': return 'border-l-4 border-teal-600 bg-teal-100';
        case 'pitching': return 'border-l-4 border-green-600 bg-green-100';
        case 'fielding': return 'border-l-4 border-green-600 bg-green-100';
        case 'strength': return 'border-l-4 border-orange-600 bg-orange-100';
        case 'recovery': return 'border-l-4 border-purple-600 bg-purple-100';
        case 'warmup': return 'border-l-4 border-purple-600 bg-purple-100';
        case 'mobility': return 'border-l-4 border-purple-600 bg-purple-100';
        case 'pt': return 'border-l-4 border-rose-600 bg-rose-100';
        case 'conditioning': return 'border-l-4 border-yellow-600 bg-yellow-100';
        default: return 'border-l-4 border-gray-600 bg-gray-100';
      }
    }
    switch(eventType) {
      case 'game': return 'border-l-4 border-slate-600 bg-slate-100';
      case 'practice': return 'border-l-4 border-green-600 bg-green-100';
      case 'tryout': return 'border-l-4 border-amber-600 bg-amber-100';
      case 'meal': return 'border-l-4 border-yellow-600 bg-yellow-100';
      case 'training_slot': return getTrainingSlotColorClasses(typeof ev === 'object' ? ev?.title : '', 'card');
      default: return 'border-l-4 border-gray-600 bg-gray-100';
    }
  };

  const displayText = event.title || event.opponent || event.event_type;
  const clickable = typeof onClick === 'function';
  // Facility events (and training slots) carry start_time rather than
  // schedule_events' event_time; facility rows also get their end time shown
  // so the card reads like the facility calendar's own (#287).
  const displayTime = formatTimeDisplay(event.start_time || event.event_time) || 'TBD';
  const displayTimeRange = event._is_facility && event.end_time
    ? `${displayTime} – ${formatTimeDisplay(event.end_time)}`
    : displayTime;

  return (
    <div
      className={`p-2 rounded relative group ${(eventColorFn && eventColorFn(event)) || getEventColor(event)} ${clickable ? 'cursor-pointer hover:opacity-80 transition' : ''} ${selected ? 'ring-2 ring-blue-500' : ''}`}
      onClick={clickable ? (e) => { e.stopPropagation(); onClick(event); } : undefined}
      onContextMenu={(e) => { if (onContextMenu && !event._is_facility) { e.preventDefault(); e.stopPropagation(); onContextMenu(event, e); } }}
      draggable={!!draggable}
      onDragStart={draggable ? (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('application/x-event-id', String(event.id));
        e.dataTransfer.effectAllowed = 'move';
      } : undefined}
      title={clickable ? (draggable ? 'Right-click for options. Drag to reschedule.' : 'Click to edit') : undefined}
    >
      {event._booked_count > 0 && (
        <span className="absolute top-1.5 right-1.5 w-3.5 h-3.5 bg-green-500 rounded-full flex items-center justify-center group-hover:opacity-0 transition" title={`${event._booked_count} booked`}>
          <Check size={8} className="text-white" />
        </span>
      )}
      {clickable && (
        <Edit2 size={12} className="absolute top-1.5 right-1.5 text-gray-500 opacity-0 group-hover:opacity-100 transition" />
      )}
      <div className="text-xs font-semibold text-gray-900 pr-4">
        {playerNames && event.player_id && playerNames[event.player_id] && (
          <span className="opacity-70 mr-1">{playerNames[event.player_id].split(' ').map(n => n[0]).join('')}</span>
        )}
        {displayText}
      </div>
      <div className="text-xs text-gray-600 mt-1">{displayTimeRange}</div>
      {!compact && event.location && (
        <div className="text-xs text-gray-500 mt-1">{event.location}</div>
      )}
    </div>
  );
}

// ============================================
// LANE VIEW (Daily Schedule by Lane)
// ============================================

// Module-level (not just inside LaneView) so the drag-and-drop handler in
// the parent Schedule component can also use it to compute a lane offset
// (#280) — order matters here, it's the same left-to-right order the grid
// renders in. Exported for #300 (AthleteOutreach) so open-cage-time
// availability reads the same lane list this grid renders, not a second copy.
export const LANES = ['Lane 1', 'Lane 2', 'Lane 3', 'Lane 4', 'Lane 5', 'Lane 6', 'Lane 7', 'Turf Field', 'Main Weight Room', 'Top Weight Room', 'Speed & Agility'];

// Shifts every lane an event occupies by the same offset as the bar the
// user grabbed (sourceLane) relative to where they're hovering/dropping
// (targetLane) — e.g. an event on Lanes 1,2,3 grabbed from Lane 2 and
// hovered over Lane 5 shifts to Lanes 4,5,6. Returns null if any shifted
// lane would fall outside the grid. Shared by LaneView's drop-preview
// highlight and the parent's onEventMove handler so the "would this be
// refused" logic can't drift between what's shown and what's enforced (#280).
function shiftLanes(eventLanes, sourceLane, targetLane) {
  const sourceIdx = LANES.indexOf(sourceLane);
  const targetIdx = LANES.indexOf(targetLane);
  if (sourceIdx === -1 || targetIdx === -1) return null;
  const offset = targetIdx - sourceIdx;
  const shiftedIndexes = eventLanes.map((l) => LANES.indexOf(l) + offset);
  if (shiftedIndexes.some((idx) => idx < 0 || idx >= LANES.length)) return null;
  return shiftedIndexes.map((idx) => LANES[idx]);
}

// #289: "move just this lane" — the grabbed lane becomes the target lane and
// every other lane stays put. Deduped (dropping onto a lane the event already
// occupies legitimately narrows it by one lane, it isn't refused) and
// re-sorted into LANES grid order like every other lanes write. No bounds
// check needed: the target is always a real lane in LANES.
function replaceSingleLane(eventLanes, sourceLane, targetLane) {
  const replaced = (eventLanes || []).map((l) => (l === sourceLane ? targetLane : l));
  const deduped = new Set(replaced);
  return LANES.filter((l) => deduped.has(l));
}

// 15-minute time slots for the Lanes grid. DEFAULT_START_HOUR/DEFAULT_END_HOUR
// (8:00 AM to 10:45 PM) are the fallback range LaneView uses whenever
// nothing scheduled on the selected day falls outside it — the common case,
// so most days render identically to before. buildTimeSlots is the shared
// generator: TIME_SLOTS below is just that default range built once at
// module load; LaneView calls buildTimeSlots again itself, per day, when
// something needs a wider window (#322 — a booking before 8am or after
// 11pm used to render nowhere on this grid at all: timeToIndex went
// negative, or the grid simply had no column past the fixed end, even
// though the row itself was created successfully).
//
// shiftStartIdx used to read TIME_SLOTS directly because it's module-level
// and the grid's slot count never changed (#280) — that's still true WITHIN
// any single render/drag interaction, it's just no longer the SAME count on
// every day. So shiftStartIdx now takes the current slot count as an
// explicit parameter instead of closing over a fixed module constant; every
// call site passes the day's actual (possibly expanded) timeSlots.length.
// The array is never rebuilt mid-drag — only when `laneDate` changes — so
// the "doesn't drift under your cursor" guarantee #280 fixed is untouched.
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 22; // last slot is 22:45
function buildTimeSlots(startHour, endHour) {
  const slots = [];
  for (let h = startHour; h <= endHour; h++) {
    for (let m = 0; m < 60; m += 15) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}
const TIME_SLOTS = buildTimeSlots(DEFAULT_START_HOUR, DEFAULT_END_HOUR);

// Shifts an event's start by the same offset within its own bar that the
// user grabbed, so the point they grabbed stays under the cursor instead of
// the event's start jumping to wherever the pointer happens to be — that
// jump was the actual bug: a bar's <td> spans several slot columns, so
// every slot it covers used to resolve to the bar's own start slot,
// meaning you had to drag past the entire bar before a 1-slot nudge could
// register (#280). Returns null — refused, not clamped, mirroring
// shiftLanes — if the event wouldn't fully fit in the grid at the result.
// slotsLength is the CALLER's current timeSlots.length (#322) — see the
// comment above TIME_SLOTS for why this isn't read from a module constant.
function shiftStartIdx(pointerSlotIdx, grabOffset, span, slotsLength) {
  const startIdx = pointerSlotIdx - grabOffset;
  if (startIdx < 0 || startIdx + span > slotsLength) return null;
  return startIdx;
}

function LaneView({ selectedDate, events, laneDate, setLaneDate, canManage, onCellClick, onEventClick, onEventMove, staffEvents = [], staffAssignments = [], coachDaySlots = [], eventPublicBookings = {}, coaches = [], onToggleCoachSchedule, onSlotEntryClick, onShiftEntryClick, onSlotTimeDrop }) {
  // #260: coaches can be hidden from the Staff Schedule rows without touching
  // their role. The manage modal lists all coaches; the rows show only visible.
  const [showManageCoaches, setShowManageCoaches] = useState(false);
  const visibleCoaches = coaches.filter(c => c.show_on_facility_schedule !== false);

  // Drop-preview state for drag-and-drop (#280). draggedInfo describes the
  // event currently being dragged — set on dragstart, cleared on dragend —
  // and has to live in React state (not read from dataTransfer) because
  // browsers only expose dataTransfer.types during dragover, not the actual
  // data. grabOffset is which slot WITHIN the bar was grabbed (grabbed slot
  // minus the event's own start slot) — needed so the grabbed point stays
  // under the cursor rather than the event's start jumping to the pointer.
  // hoveredCell tracks the slot currently under the cursor (derived from
  // pointer position, not from which cell fired the event — see
  // slotIdxFromPointerX below) while dragging, so the grid can show exactly
  // where the event would land before the user releases.
  const [draggedInfo, setDraggedInfo] = useState(null); // { eventId, sourceLane, lanes, span, grabOffset }
  const [hoveredCell, setHoveredCell] = useState(null); // { lane, slotIdx }
  const clearDragPreview = () => { setDraggedInfo(null); setHoveredCell(null); };

  const dateStr = laneDate || fmtLocalDate(new Date());

  // Filter events for this date
  const dayEvents = events.filter(ev => ev.event_date === dateStr);

  // #322: expand the grid to cover anything actually scheduled outside the
  // default 8am-10:45pm window, on the same 15-minute grid, instead of
  // silently having nowhere to render it. Gathered from every kind of entry
  // this view renders for the day: facility events (dayEvents), Work Portal
  // shifts (staffEvents) and coach training sessions (coachDaySlots) — both
  // of those are already scoped to `laneDate` by fetchStaffSchedule, so no
  // extra date filtering is needed here. Falls back to the default range
  // when nothing exceeds it.
  let dayStartHour = DEFAULT_START_HOUR;
  let dayEndHour = DEFAULT_END_HOUR;
  const considerRange = (startTimeStr, endTimeStr, durationMinutes) => {
    if (!startTimeStr) return;
    const [sh, sm] = startTimeStr.split(':').map(Number);
    if (Number.isNaN(sh)) return;
    dayStartHour = Math.min(dayStartHour, sh);
    const startTotalMin = sh * 60 + (sm || 0);
    let endTotalMin;
    if (endTimeStr) {
      const [eh, em] = endTimeStr.split(':').map(Number);
      endTotalMin = Number.isNaN(eh) ? startTotalMin + 60 : eh * 60 + (em || 0);
    } else {
      endTotalMin = startTotalMin + (durationMinutes || 60);
    }
    dayEndHour = Math.max(dayEndHour, Math.ceil(endTotalMin / 60));
  };
  dayEvents.forEach(ev => considerRange(ev.start_time || ev.event_time, ev.end_time));
  staffEvents.forEach(ev => {
    const start = new Date(ev.start_at);
    const end = ev.end_at ? new Date(ev.end_at) : null;
    const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    considerRange(fmt(start), end ? fmt(end) : null);
  });
  coachDaySlots.forEach(s => considerRange(s.start_time, null, s.duration_minutes || 60));
  // Sane full-day clamp — a malformed row (e.g. an end time that wrapped
  // past midnight) can't blow the grid out past what's actually renderable.
  dayStartHour = Math.max(0, dayStartHour);
  dayEndHour = Math.min(23, dayEndHour);

  const timeSlots = (dayStartHour === DEFAULT_START_HOUR && dayEndHour === DEFAULT_END_HOUR)
    ? TIME_SLOTS
    : buildTimeSlots(dayStartHour, dayEndHour);

  // Parse time to slot index
  const timeToIndex = (timeStr) => {
    if (!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h - dayStartHour) * 4 + Math.floor(m / 15);
  };

  // Derived from draggedInfo + hoveredCell: which lanes (if any) the drop
  // preview should highlight, or null if the currently-hovered lane would
  // put the event out of bounds. previewStartIdx applies the same grab
  // offset the actual drop will (shiftStartIdx), so the highlighted range
  // is exactly where the event would land, not just wherever the pointer
  // happens to be — same math the drop itself uses, so what lights up is
  // exactly what will happen. When refused we don't have a valid
  // lane/range to show, so the preview falls back to just the one hovered
  // cell — see previewClassFor below.
  const previewLanes = draggedInfo && hoveredCell
    ? (hoveredCell.lane === draggedInfo.sourceLane ? draggedInfo.lanes : shiftLanes(draggedInfo.lanes, draggedInfo.sourceLane, hoveredCell.lane))
    : null;
  const previewStartIdx = draggedInfo && hoveredCell
    ? shiftStartIdx(hoveredCell.slotIdx, draggedInfo.grabOffset, draggedInfo.span, timeSlots.length)
    : null;
  const previewTimeOk = previewStartIdx !== null;
  // #289: a multi-lane bar hovered where the whole block wouldn't fit is no
  // longer a refusal — the drop opens a choice where only the single grabbed
  // lane can move. Amber on the hovered cell says "droppable, but single-lane
  // only" before the user commits. An out-of-grid TIME is still a hard red
  // refusal for every event, exactly as before.
  const previewSingleLaneOnly = !!draggedInfo && !!hoveredCell && previewTimeOk && !previewLanes && draggedInfo.lanes.length > 1;
  const previewRefused = !!draggedInfo && !!hoveredCell && (!previewTimeOk || (!previewLanes && draggedInfo.lanes.length <= 1));

  const previewClassFor = (lane, slotIdx) => {
    if (!draggedInfo || !hoveredCell) return '';
    if (previewRefused) {
      return (lane === hoveredCell.lane && slotIdx === hoveredCell.slotIdx)
        ? 'ring-2 ring-inset ring-red-400 bg-red-100/60'
        : '';
    }
    if (previewSingleLaneOnly) {
      return (lane === hoveredCell.lane && slotIdx === hoveredCell.slotIdx)
        ? 'ring-2 ring-inset ring-amber-400 bg-amber-100/60'
        : '';
    }
    const inRange = slotIdx >= previewStartIdx && slotIdx < previewStartIdx + draggedInfo.span;
    return (previewLanes.includes(lane) && inRange)
      ? 'ring-2 ring-inset ring-blue-400 bg-blue-100/50'
      : '';
  };

  // Build a map: lane -> array of {startIdx, span, event}
  const laneEvents = {};
  LANES.forEach(lane => { laneEvents[lane] = []; });

  dayEvents.forEach(ev => {
    const evLanes = ev.lanes || [];
    const startTime = ev.start_time || ev.event_time;
    if (!startTime) return;
    const startIdx = timeToIndex(startTime);
    if (startIdx < 0) return;
    const endTime = ev.end_time;
    const endIdx = endTime ? timeToIndex(endTime) : startIdx + 4; // default 1 hour
    const span = Math.max(endIdx - startIdx, 1);

    evLanes.forEach(lane => {
      if (laneEvents[lane]) {
        laneEvents[lane].push({ startIdx, span, event: ev });
      }
    });
  });

  // #434: coach lessons that reserved a lane render in the lane rows too, so
  // staff see lane availability without cross-checking the Staff Schedule
  // band. Pseudo-events: not draggable here (retime them in the staff band,
  // #309), click opens the coach's session tools like the band entry does.
  coachDaySlots.forEach(s => {
    const slotLanes = s.lanes || [];
    if (slotLanes.length === 0) return;
    const startIdx = timeToIndex(s.start_time);
    if (startIdx < 0) return;
    const durationMin = s.duration_minutes || 60;
    const span = Math.max(Math.round(durationMin / 15), 1);
    const [sh, sm] = s.start_time.split(':').map(Number);
    const endTotal = sh * 60 + (sm || 0) + durationMin;
    const endTime = `${String(Math.floor(endTotal / 60) % 24).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
    const coach = coaches.find(c => c.id === s.coach_id) || null;
    const clients = (s.reserved || 0) + (s.publicBookings ? s.publicBookings.length : 0);
    const pseudo = {
      id: `slot-${s.slot_id}-${s.slot_date}`,
      _isSlot: true,
      _slotCoach: coach,
      _slotTitle: s.title,
      _capacity: s.capacity,
      title: `${coach?.full_name ? coach.full_name.split(' ')[0] : 'Coach'} · ${s.title}`,
      start_time: s.start_time,
      end_time: endTime,
      lanes: slotLanes,
      coach_id: s.coach_id,
      _booked_count: clients,
    };
    slotLanes.forEach(lane => {
      if (laneEvents[lane]) laneEvents[lane].push({ startIdx, span, event: pseudo });
    });
  });

  // Assign each lane's events to non-overlapping tracks so overlapping events render as stacked rows
  const assignTracks = (entries) => {
    const sorted = [...entries].sort((a, b) => a.startIdx - b.startIdx);
    const tracks = [];
    for (const entry of sorted) {
      let placed = false;
      for (const track of tracks) {
        const last = track[track.length - 1];
        if (last.startIdx + last.span <= entry.startIdx) {
          track.push(entry);
          placed = true;
          break;
        }
      }
      if (!placed) tracks.push([entry]);
    }
    return tracks;
  };

  const laneTracks = {};
  LANES.forEach(lane => { laneTracks[lane] = assignTracks(laneEvents[lane]); });

  // Stacked hour label: number on top, am/pm underneath, so columns stay
  // narrow and uniform (#263). Only on-the-hour slots are labeled, so minutes
  // are always :00 and dropped.
  const formatLabel = (slot) => {
    const [h] = slot.split(':').map(Number);
    const ampm = h >= 12 ? 'pm' : 'am';
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return (
      <span className="flex flex-col items-center leading-tight">
        <span>{hour12}</span>
        <span className="text-[8px] text-gray-400">{ampm}</span>
      </span>
    );
  };

  const prevDay = () => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    setLaneDate(fmtLocalDate(d));
  };
  const nextDay = () => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    setLaneDate(fmtLocalDate(d));
  };

  const handleEmptyClick = (lane, slot) => {
    if (!canManage || !onCellClick) return;
    const [h, m] = slot.split(':').map(Number);
    const endH = m + 60 >= 60 ? h + 1 : h;
    const endM = (m + 60) % 60;
    const endSlot = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
    onCellClick({ date: dateStr, lane, startTime: slot, endTime: endSlot });
  };

  const LANE_COL_WIDTH = 76; // px, lane-name column — sticky, needs a real width (#273)

  // Mirror a horizontal scrollbar above the grid so staff can scroll time
  // without dragging to the bottom of a tall table. The two scroll containers
  // stay in sync; the top one just holds a spacer the width of the table.
  const topScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);

  // Every time column gets the SAME exact integer pixel width, computed here
  // and applied via <colgroup> below — letting the browser split leftover
  // width itself (the previous approach) drops a stray extra pixel on some
  // columns and not others, so the grid boxes weren't quite even (#273,
  // Cordell). A ResizeObserver (not a one-time mount measure) keeps this
  // correct across window resizes and any other layout change to the
  // container. Floored, with an 8px minimum, so the table is never a
  // fraction of a column wider than the container — being a few px short is
  // fine and invisible; being over means horizontal scroll.
  //
  // Flooring 60 columns leaves up to 59px of leftover width unclaimed by any
  // column, which used to show up as a visible gap at the right edge. That
  // remainder goes to the lane-name column instead (laneCol) so the grid
  // still ends flush with the container — the time columns stay exactly
  // equal either way. On the rare narrow-screen case where the 8px floor
  // already makes the table wider than the container, remainder goes
  // negative; laneCol is clamped so it never shrinks below the base 76px.
  //
  // Two feedback-loop guards (#273): (1) a 4px safety margin is subtracted
  // from the measured width before computing anything, so the table is
  // always a little narrower than its container, never wider — sizing the
  // table to EXACTLY the measured width let the flex-child container grow
  // to fit the table, which made the next measurement wider, which grew the
  // table again, etc. (2) the setters only fire when the computed value
  // actually changed, using the functional updater form so the comparison
  // is against the real latest state rather than this effect's stale
  // closure — otherwise an identical re-measurement still triggers a
  // render, which is what let the loop keep going instead of settling.
  const [slotWidth, setSlotWidth] = useState(8);
  const [laneCol, setLaneCol] = useState(LANE_COL_WIDTH);
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const compute = (containerWidth) => {
      const usable = containerWidth - 4;
      const raw = Math.floor((usable - LANE_COL_WIDTH) / timeSlots.length);
      const slot = Math.max(raw, 8);
      const remainder = usable - LANE_COL_WIDTH - slot * timeSlots.length;
      const nextLaneCol = LANE_COL_WIDTH + Math.max(remainder, 0);
      setSlotWidth(prev => (prev === slot ? prev : slot));
      setLaneCol(prev => (prev === nextLaneCol ? prev : nextLaneCol));
    };
    compute(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) compute(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // #322: timeSlots.length changes when switching to a day whose grid was
    // expanded (or back to one that wasn't) — recompute column widths for
    // the new count rather than leaving them sized for the previous day's.
  }, [timeSlots.length]);

  // scrollWidth here is purely cosmetic: it sizes the spacer in the mirrored
  // top scrollbar to match the real table.
  const [scrollWidth, setScrollWidth] = useState(0);
  useEffect(() => {
    const measure = () => { if (bodyScrollRef.current) setScrollWidth(bodyScrollRef.current.scrollWidth); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // #322: re-measure when the day's grid width changes (see above).
  }, [timeSlots.length]);
  const syncFromTop = () => { if (bodyScrollRef.current && topScrollRef.current && bodyScrollRef.current.scrollLeft !== topScrollRef.current.scrollLeft) bodyScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft; };
  const syncFromBody = () => { if (bodyScrollRef.current && topScrollRef.current && topScrollRef.current.scrollLeft !== bodyScrollRef.current.scrollLeft) topScrollRef.current.scrollLeft = bodyScrollRef.current.scrollLeft; };

  // Which time column the pointer is over, from its actual X position
  // rather than which <td> happens to contain it (#280). A cell's <td>
  // spans several slot columns once an event is rendered there, so
  // deriving the target from "which cell fired the event" collapses every
  // slot that cell covers down to one value — that's the root cause of the
  // original bug. Using laneCol/slotWidth (the same measurements #273's
  // ResizeObserver already produces) makes every 15-minute column
  // individually reachable regardless of what's rendered on top of it.
  const slotIdxFromPointerX = (clientX) => {
    const el = bodyScrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const xInTable = clientX - rect.left + el.scrollLeft;
    const xInSlotArea = xInTable - laneCol;
    const idx = Math.floor(xInSlotArea / slotWidth);
    return Math.min(Math.max(idx, 0), timeSlots.length - 1);
  };

  return (
    <div>
      <div className="flex items-center justify-center space-x-4 mb-4">
        <button onClick={prevDay} className="p-1 hover:bg-gray-100 rounded transition"><ChevronLeft size={18} /></button>
        <div className="flex items-center space-x-2">
          <input type="date" value={dateStr} onChange={(e) => setLaneDate(e.target.value)} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          <span className="text-sm font-medium text-gray-700">
            {new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
        <button onClick={nextDay} className="p-1 hover:bg-gray-100 rounded transition"><ChevronRight size={18} /></button>
      </div>
      <div
        ref={topScrollRef}
        onScroll={syncFromTop}
        className="overflow-x-auto overflow-y-hidden border border-gray-200 border-b-0 rounded-t-lg max-w-full"
      >
        <div style={{ width: scrollWidth, height: 16 }} />
      </div>
      <div
        ref={bodyScrollRef}
        onScroll={syncFromBody}
        onDragLeave={(e) => {
          // Only clear when the pointer actually leaves the grid, not when
          // it moves from one cell to another child within it — otherwise
          // the highlight would flicker off and back on between every cell.
          if (!e.currentTarget.contains(e.relatedTarget)) setHoveredCell(null);
        }}
        className="overflow-x-auto overflow-y-auto border border-gray-200 rounded-b-lg max-w-full"
        style={{
          // 230px is a magic number: it's the chrome stacked above this grid
          // (app header + page heading + view tabs + the date bar and the
          // mirrored scrollbar right above the table). Re-tune it if any of
          // that changes height.
          // max() puts a floor under the subtraction. On a short viewport the
          // bare calc() shrinks toward zero, and below ~230px of viewport
          // height it goes negative and collapses the grid entirely with no
          // scroll region — so never less than 240px of scrollable grid.
          maxHeight: 'max(240px, calc(100vh - 230px))',
        }}
      >
        <table className="border-collapse text-xs" style={{ tableLayout: 'fixed', width: laneCol + slotWidth * timeSlots.length, minWidth: LANE_COL_WIDTH + 8 * timeSlots.length }}>
          <colgroup>
            <col style={{ width: laneCol }} />
            {timeSlots.map((slot) => <col key={slot} style={{ width: slotWidth }} />)}
          </colgroup>
          <thead className="sticky top-0 z-20 bg-white">
            <tr>
              <th className="border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-left text-[9px] font-semibold text-gray-700 sticky left-0 z-30 truncate" style={{ width: laneCol, minWidth: laneCol }} title="Lane">
                Lane
              </th>
              {timeSlots.map((slot) => {
                const isHour = slot.endsWith(':00');
                return (
                  <th
                    key={slot}
                    className={`border-y border-r border-gray-100 ${isHour ? 'border-l border-l-gray-300' : 'border-l border-l-gray-100'} px-0 py-1 text-center text-[9px] font-medium text-gray-600 ${isHour ? 'bg-gray-100' : 'bg-gray-50'}`}
                  >
                    {isHour ? formatLabel(slot) : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {LANES.flatMap((lane) => {
              const tracks = laneTracks[lane];
              const renderTracks = tracks.length === 0 ? [[]] : tracks;
              return renderTracks.map((track, trackIdx) => (
                <tr key={`${lane}-${trackIdx}`} className="h-[26px] max-h-[26px]" style={{ height: 26 }}>
                  {trackIdx === 0 && (
                    <td
                      rowSpan={renderTracks.length}
                      className="border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[9px] font-semibold text-gray-700 sticky left-0 z-10 truncate leading-none"
                      style={{ width: laneCol, minWidth: laneCol }}
                      title={lane}
                    >
                      {lane}
                    </td>
                  )}
                  {timeSlots.map((slot, slotIdx) => {
                    const entry = track.find(e => e.startIdx === slotIdx);
                    if (entry) {
                      const colorClasses = entry.event._isSlot
                        ? getTrainingSlotColorClasses(entry.event._slotTitle, 'lane')
                        : getFacilityColorClasses(entry.event.color, 'lane');
                      const entryIsHourStart = timeSlots[entry.startIdx].endsWith(':00');
                      const entryTitle = entry.event.title || entry.event.opponent;
                      const entryStart = entry.event.start_time || entry.event.event_time;
                      const entryTimeRange = entryStart ? `${formatTimeDisplay(entryStart)}${entry.event.end_time ? `–${formatTimeDisplay(entry.event.end_time)}` : ''}` : '';
                      const entryCoachIds = [...new Set([
                        ...(entry.event.coach_ids || []),
                        ...(entry.event.coach_id ? [entry.event.coach_id] : []),
                      ])];
                      const entryCoachNames = entryCoachIds
                        .map(id => coaches.find(c => c.id === id)?.full_name)
                        .filter(Boolean);
                      const entryTooltipParts = [
                        entryTimeRange ? `${entryTitle} - ${entryTimeRange}` : entryTitle,
                        entryCoachNames.length ? `Coach: ${entryCoachNames.join(', ')}` : null,
                        entry.event.athlete?.full_name ? `Athlete: ${entry.event.athlete.full_name}` : null,
                        entry.event._isSlot ? 'Coach lesson (also on the Staff Schedule band)' : null,
                        entry.event._isSlot
                          ? (entry.event._booked_count > 0 ? `Booked: ${entry.event._booked_count}/${entry.event._capacity}` : 'Unbooked')
                          : (entry.event._booked_count > 0 ? `Booked: ${entry.event._booked_count}` : null),
                      ].filter(Boolean);
                      return (
                        <td
                          key={slot}
                          colSpan={entry.span}
                          className={`border-y border-r border-gray-100 ${entryIsHourStart ? 'border-l border-l-gray-300' : 'border-l border-l-gray-100'} p-0 overflow-hidden ${previewClassFor(lane, slotIdx)}`}
                          onDragOver={(e) => {
                            const types = [...e.dataTransfer.types];
                            if (types.includes('application/x-event-id') && canManage && onEventMove) {
                              e.preventDefault();
                              const pointerSlotIdx = slotIdxFromPointerX(e.clientX);
                              let valid = true;
                              if (draggedInfo) {
                                // #289: a multi-lane event is always lane-valid — if the whole block
                                // doesn't fit, the drop offers a single-lane move instead of refusing.
                                const validLane = lane === draggedInfo.sourceLane || draggedInfo.lanes.length > 1 || !!shiftLanes(draggedInfo.lanes, draggedInfo.sourceLane, lane);
                                const validTime = shiftStartIdx(pointerSlotIdx, draggedInfo.grabOffset, draggedInfo.span, timeSlots.length) !== null;
                                valid = validLane && validTime;
                              }
                              e.dataTransfer.dropEffect = valid ? 'move' : 'none';
                              setHoveredCell((prev) => (prev && prev.lane === lane && prev.slotIdx === pointerSlotIdx) ? prev : { lane, slotIdx: pointerSlotIdx });
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const eventId = e.dataTransfer.getData('application/x-event-id');
                            const sourceLane = e.dataTransfer.getData('application/x-event-source-lane');
                            if (eventId && canManage && onEventMove && draggedInfo) {
                              const pointerSlotIdx = slotIdxFromPointerX(e.clientX);
                              const targetStartIdx = shiftStartIdx(pointerSlotIdx, draggedInfo.grabOffset, draggedInfo.span, timeSlots.length);
                              if (targetStartIdx !== null) onEventMove(eventId, sourceLane, lane, timeSlots[targetStartIdx]);
                            }
                            clearDragPreview();
                          }}
                        >
                          <button
                            type="button"
                            draggable={canManage && !entry.event._isMealPlan && !entry.event._isSlot && !!onEventMove}
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.setData('application/x-event-id', String(entry.event.id));
                              // The lane this specific bar was grabbed from — a multi-lane
                              // event renders one bar per lane, so this identifies which
                              // one, letting the drop handler shift the whole set by the
                              // same offset rather than collapsing it down to one lane (#280).
                              e.dataTransfer.setData('application/x-event-source-lane', lane);
                              e.dataTransfer.effectAllowed = 'move';
                              const grabbedSlotIdx = slotIdxFromPointerX(e.clientX);
                              setDraggedInfo({
                                eventId: entry.event.id,
                                sourceLane: lane,
                                lanes: entry.event.lanes && entry.event.lanes.length > 0 ? entry.event.lanes : [lane],
                                span: entry.span,
                                // Which slot within the bar was grabbed, clamped into the
                                // bar's own range in case of a sub-pixel discrepancy right
                                // at its edge — kept under the cursor on drop (#280).
                                grabOffset: Math.min(Math.max(grabbedSlotIdx - entry.startIdx, 0), entry.span - 1),
                              });
                            }}
                            onDragEnd={clearDragPreview}
                            onClick={() => {
                              if (entry.event._isSlot) {
                                if (onSlotEntryClick && entry.event._slotCoach) onSlotEntryClick(entry.event._slotCoach);
                                return;
                              }
                              if (onEventClick) onEventClick(entry.event);
                            }}
                            title={entryTooltipParts.join('\n')}
                            className={`${colorClasses} rounded px-1 h-[26px] w-full text-left hover:opacity-80 transition leading-none flex items-center overflow-hidden`}
                          >
                            <span className="truncate text-[8px] font-semibold leading-none">{entryTitle}</span>
                            {/* #431: at-a-glance "someone is on this" — the
                                lane bars are 26px tall and the title already
                                truncates, so the badge is small and pinned to
                                the right edge. */}
                            {entry.event._booked_count > 0 && (
                              <span className="ml-auto pl-1 flex-shrink-0 inline-flex items-center justify-center w-3 h-3 bg-green-500 rounded-full">
                                <Check size={7} className="text-white" />
                              </span>
                            )}
                          </button>
                        </td>
                      );
                    }
                    // Skip cells consumed by the colSpan of an earlier event in this track
                    const covered = track.some(e => slotIdx > e.startIdx && slotIdx < e.startIdx + e.span);
                    if (covered) return null;
                    const isHour = slot.endsWith(':00');
                    return (
                      <td
                        key={slot}
                        onClick={() => handleEmptyClick(lane, slot)}
                        onDragOver={(e) => {
                          const types = [...e.dataTransfer.types];
                          if (types.includes('application/x-event-id') && canManage && onEventMove) {
                            e.preventDefault();
                            const pointerSlotIdx = slotIdxFromPointerX(e.clientX);
                            let valid = true;
                            if (draggedInfo) {
                              // #289: a multi-lane event is always lane-valid — if the whole block
                              // doesn't fit, the drop offers a single-lane move instead of refusing.
                              const validLane = lane === draggedInfo.sourceLane || draggedInfo.lanes.length > 1 || !!shiftLanes(draggedInfo.lanes, draggedInfo.sourceLane, lane);
                              const validTime = shiftStartIdx(pointerSlotIdx, draggedInfo.grabOffset, draggedInfo.span, timeSlots.length) !== null;
                              valid = validLane && validTime;
                            }
                            e.dataTransfer.dropEffect = valid ? 'move' : 'none';
                            setHoveredCell((prev) => (prev && prev.lane === lane && prev.slotIdx === pointerSlotIdx) ? prev : { lane, slotIdx: pointerSlotIdx });
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const eventId = e.dataTransfer.getData('application/x-event-id');
                          const sourceLane = e.dataTransfer.getData('application/x-event-source-lane');
                          if (eventId && canManage && onEventMove && draggedInfo) {
                            const pointerSlotIdx = slotIdxFromPointerX(e.clientX);
                            const targetStartIdx = shiftStartIdx(pointerSlotIdx, draggedInfo.grabOffset, draggedInfo.span, timeSlots.length);
                            if (targetStartIdx !== null) onEventMove(eventId, sourceLane, lane, timeSlots[targetStartIdx]);
                          }
                          clearDragPreview();
                        }}
                        className={`border-y border-r border-gray-100 ${isHour ? 'border-l border-l-gray-300 bg-gray-50/40' : 'border-l border-l-gray-100'} ${canManage ? 'cursor-pointer hover:bg-teal-50' : ''} ${previewClassFor(lane, slotIdx)}`}
                        style={{ height: 26 }}
                      />
                    );
                  })}
                </tr>
              ));
            })}
            {/* Staff Schedule separator */}
            {coaches.length > 0 && (
              <tr>
                <td
                  colSpan={timeSlots.length + 1}
                  className="bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[10px] font-bold text-indigo-700 sticky left-0 z-10"
                >
                  <span className="mr-3">Staff Schedule</span>
                  <span className="inline-flex items-center gap-3 font-normal align-middle">
                    <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-sky-400 inline-block" />Shift</span>
                    <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-teal-300 inline-block" />Session</span>
                    <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-amber-300 inline-block" />Facility event</span>
                  </span>
                  {canManage && onToggleCoachSchedule && (
                    <button
                      type="button"
                      onClick={() => setShowManageCoaches(true)}
                      className="ml-3 inline-flex items-center gap-1 rounded border border-sky-400 bg-white px-2 py-0.5 min-h-[24px] text-[10px] font-medium text-sky-800 hover:bg-sky-100 align-middle"
                    >
                      <UserCog size={12} /> Manage coaches
                    </button>
                  )}
                </td>
              </tr>
            )}
            {/* Staff rows */}
            {visibleCoaches.map((coach) => {
              // Color/label per source so a coach's row reads at a glance.
              const KIND_STYLES = {
                shift: 'bg-sky-100 text-sky-800 border-sky-400',
                slot: 'bg-teal-100 text-teal-800 border-teal-300',
                facility: 'bg-amber-100 text-amber-800 border-amber-300',
              };
              const endLabel = (timeStr, mins) => {
                const [h, m] = timeStr.split(':').map(Number);
                const total = h * 60 + m + mins;
                return formatTimeDisplay(`${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`);
              };

              // 1. Work Portal shifts assigned to this coach.
              const coachEventIds = staffAssignments.filter(a => a.user_id === coach.id).map(a => a.event_id);
              const shiftEntries = staffEvents.filter(ev => coachEventIds.includes(ev.id)).map(ev => {
                const start = new Date(ev.start_at);
                const end = new Date(ev.end_at);
                const startIdx = (start.getHours() - dayStartHour) * 4 + Math.floor(start.getMinutes() / 15);
                const endIdx = (end.getHours() - dayStartHour) * 4 + Math.floor(end.getMinutes() / 15);
                return {
                  startIdx: Math.max(startIdx, 0), span: Math.max(endIdx - startIdx, 1), kind: 'shift',
                  title: ev.title,
                  timeLabel: `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${ev.end_at ? `–${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}`,
                  // #309: was always null — shift blocks were hover-tooltip
                  // only, unlike facility events in this same band.
                  info: null, onClick: onShiftEntryClick ? () => onShiftEntryClick(ev) : null,
                };
              });

              // 2. The coach's own training slots occurring today — shown even
              // when no client has booked (#229).
              const slotEntries = coachDaySlots.filter(s => s.coach_id === coach.id).map(s => {
                const clients = (s.reserved || 0) + (s.publicBookings ? s.publicBookings.length : 0);
                return {
                  startIdx: timeToIndex(s.start_time), span: Math.max(Math.round((s.duration_minutes || 60) / 15), 1), kind: 'slot',
                  title: s.title,
                  colorClass: getTrainingSlotColorClasses(s.title, 'lane'),
                  timeLabel: `${formatTimeDisplay(s.start_time)}–${endLabel(s.start_time, s.duration_minutes || 60)}`,
                  info: clients > 0 ? `${clients}/${s.capacity} booked` : (s.is_public ? 'Open' : 'Unbooked'),
                  booked: clients > 0, // #431
                  // #309/#314: was always null — hover tooltip only, no route
                  // to the roster/attendance tools that already exist for
                  // this exact session in CoachSlotsWeekView. Opens that
                  // same component as a modal (see coachModalOpen).
                  onClick: onSlotEntryClick ? () => onSlotEntryClick(coach) : null,
                  // #309: drag-to-retime — see the onDragStart/onDrop wiring
                  // below. Only slot entries are draggable in this band;
                  // shifts and facility events keep their existing
                  // click-only behaviour (out of scope here).
                  slotId: s.slot_id,
                  draggableSlot: canManage && !!onSlotTimeDrop,
                };
              });

              // 3. Facility events this coach is assigned to.
              const facEntries = dayEvents.filter(ev => (ev.coach_ids || []).includes(coach.id) || ev.coach_id === coach.id).map(ev => {
                const startTime = ev.start_time || ev.event_time;
                const startIdx = timeToIndex(startTime);
                const endIdx = ev.end_time ? timeToIndex(ev.end_time) : startIdx + 4;
                const pubs = eventPublicBookings[ev._master_id || ev.id] || [];
                // #431: _booked_count (sign-ups + assigned athletes + public
                // bookings for the month range) already includes today's
                // public bookings; the day-scoped `pubs` is kept as a fallback
                // for the moment between the two fetches.
                const bookedCount = Math.max(ev._booked_count || 0, pubs.length);
                return {
                  startIdx, span: Math.max(endIdx - startIdx, 1), kind: 'facility',
                  title: ev.title,
                  timeLabel: `${formatTimeDisplay(startTime)}${ev.end_time ? `–${formatTimeDisplay(ev.end_time)}` : ''}`,
                  info: bookedCount > 0 ? `${bookedCount} booked` : null,
                  booked: bookedCount > 0,
                  onClick: () => onEventClick && onEventClick(ev),
                };
              });

              const entries = [...shiftEntries, ...slotEntries, ...facEntries]
                .filter(e => e.startIdx >= 0 && e.startIdx < timeSlots.length);

              const tracks = assignTracks(entries);
              const renderTracks = tracks.length === 0 ? [[]] : tracks;

              return renderTracks.map((track, trackIdx) => (
                <tr key={`staff-${coach.id}-${trackIdx}`} className="h-[26px] max-h-[26px]" style={{ height: 26 }}>
                  {trackIdx === 0 && (
                    <td
                      rowSpan={renderTracks.length}
                      className="border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700 sticky left-0 z-10 truncate leading-none"
                      style={{ width: laneCol, minWidth: laneCol }}
                      title={coach.full_name}
                    >
                      {coach.full_name.split(' ')[0]}
                    </td>
                  )}
                  {timeSlots.map((slot, slotIdx) => {
                    const entry = track.find(e => e.startIdx === slotIdx);
                    if (entry) {
                      const entryTitleAttr = [entry.title, entry.timeLabel, entry.info].filter(Boolean).join(' - ');
                      const inner = (
                        <>
                          <span className="truncate text-[8px] font-semibold leading-none">{entry.title}</span>
                          {entry.booked && (
                            <span className="ml-auto pl-1 flex-shrink-0 inline-flex items-center justify-center w-3 h-3 bg-green-500 rounded-full">
                              <Check size={7} className="text-white" />
                            </span>
                          )}
                        </>
                      );
                      const entryIsHourStart = timeSlots[entry.startIdx].endsWith(':00');
                      return (
                        <td
                          key={slot}
                          colSpan={entry.span}
                          className={`border-y border-r border-indigo-100 ${entryIsHourStart ? 'border-l border-l-indigo-300' : 'border-l border-l-indigo-100'} p-0 overflow-hidden`}
                        >
                          {entry.onClick ? (
                            <button
                              type="button"
                              onClick={entry.onClick}
                              title={entryTitleAttr}
                              draggable={entry.draggableSlot || undefined}
                              onDragStart={entry.draggableSlot ? (e) => {
                                e.stopPropagation();
                                e.dataTransfer.setData('application/x-slot-id', String(entry.slotId));
                                e.dataTransfer.setData('application/x-slot-date', String(dateStr));
                                e.dataTransfer.effectAllowed = 'move';
                              } : undefined}
                              className={`${entry.colorClass || KIND_STYLES[entry.kind]} border rounded px-1 h-[26px] w-full text-left hover:opacity-80 transition leading-none flex items-center overflow-hidden ${entry.draggableSlot ? 'cursor-grab' : ''}`}
                            >{inner}</button>
                          ) : (
                            <div title={entryTitleAttr} className={`${entry.colorClass || KIND_STYLES[entry.kind]} border rounded px-1 h-[26px] w-full text-left leading-none flex items-center overflow-hidden`}>{inner}</div>
                          )}
                        </td>
                      );
                    }
                    const covered = track.some(e => slotIdx > e.startIdx && slotIdx < e.startIdx + e.span);
                    if (covered) return null;
                    const isHour = slot.endsWith(':00');
                    return (
                      <td
                        key={slot}
                        className={`border-y border-r border-indigo-100 ${isHour ? 'border-l border-l-indigo-300 bg-indigo-50/30' : 'border-l border-l-indigo-100'}`}
                        style={{ height: 26 }}
                        onDragOver={canManage && onSlotTimeDrop ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
                        onDrop={canManage && onSlotTimeDrop ? (e) => {
                          e.preventDefault();
                          const slotId = e.dataTransfer.getData('application/x-slot-id');
                          if (!slotId) return;
                          // #309: same-coach-row only — dropping on a different
                          // coach's row would mean reassigning the session to
                          // that coach, a separate feature this doesn't build.
                          // Checked here (not left to the handler) so a
                          // cross-row drop is a clean no-op, not an accidental
                          // time-only move that silently ignores which row it
                          // landed on.
                          const draggedSlot = coachDaySlots.find(s => String(s.slot_id) === String(slotId));
                          if (!draggedSlot || draggedSlot.coach_id !== coach.id) return;
                          onSlotTimeDrop(slotId, slot);
                        } : undefined}
                      />
                    );
                  })}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>

      {showManageCoaches && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowManageCoaches(false)}>
          <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="text-lg font-semibold text-gray-900">Coaches on schedule</h3>
              <button onClick={() => setShowManageCoaches(false)} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
            </div>
            <p className="px-4 pt-3 text-xs text-gray-500">Uncheck a coach to hide their row from the facility schedule. This doesn't change their account or access.</p>
            <div className="max-h-80 overflow-y-auto px-4 py-3 space-y-1">
              {coaches.length === 0 && <p className="text-sm text-gray-500">No coaches found.</p>}
              {coaches.map((c) => {
                const visible = c.show_on_facility_schedule !== false;
                return (
                  <label key={c.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => onToggleCoachSchedule(c.id, e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-800">{c.full_name}</span>
                  </label>
                );
              })}
            </div>
            <div className="border-t border-gray-200 px-4 py-3 text-right">
              <button onClick={() => setShowManageCoaches(false)} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// ADD EVENT PANEL
// ============================================

export function AddEventPanel({ date, view, teamId, playerIds = [], onClose, onSuccess }) {
  const [eventType, setEventType] = useState(null); // 'team-event', 'workout', 'meal'
  const [workoutType, setWorkoutType] = useState(null); // 'single-day', 'program'
  const [mealType, setMealType] = useState(null); // 'single-meal', 'plan'
  
  const LANE_OPTIONS = ['Lane 1', 'Lane 2', 'Lane 3', 'Lane 4', 'Lane 5', 'Lane 6', 'Lane 7', 'Turf Field', 'Main Weight Room', 'Top Weight Room', 'Speed & Agility'];
  const [teamEventData, setTeamEventData] = useState({
    event_type: 'practice',
    opponent: '',
    event_time: '',
    location: '',
    address: '',
    home_away: null,
    is_optional: false,
    notes: '',
    lanes: []
  });
  const [timeTBD, setTimeTBD] = useState(false);

  const [trainingPrograms, setTrainingPrograms] = useState([]);
  const [trainingDays, setTrainingDays] = useState([]);
  const [meals, setMeals] = useState([]);
  const [mealPlans, setMealPlans] = useState([]);
  const [selectedProgramId, setSelectedProgramId] = useState('');
  const [selectedDayId, setSelectedDayId] = useState('');
  const [selectedMealId, setSelectedMealId] = useState('');
  const [selectedMealPlanId, setSelectedMealPlanId] = useState('');
  const [mealsPerDay, setMealsPerDay] = useState(3);
  const [workoutSelectionMode, setWorkoutSelectionMode] = useState(null); // 'existing' or 'create'
  const [mealSelectionMode, setMealSelectionMode] = useState(null); // 'existing' or 'create'
  const [newWorkoutData, setNewWorkoutData] = useState({ title: '', notes: '', program: 'No Program', folder: '', exercises: [{ name: '', sets: '', reps: '', rest: '', load: '', link: '' }] });
  const [workoutTemplates, setWorkoutTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [newMealData, setNewMealData] = useState({ 
    name: '', 
    description: '', 
    meal_type: 'breakfast',
    calories: '',
    protein_g: '',
    carbs_g: '',
    fat_g: ''
  });
  const [programEndDate, setProgramEndDate] = useState('');
  const [programWeekdays, setProgramWeekdays] = useState([false, true, true, true, true, true, false]); // Mon-Fri default
  const [loading, setLoading] = useState(false);

  // Lesson / assessment booking (#214)
  const [lessonData, setLessonData] = useState({
    lesson_type: 'lesson', // 'lesson' or 'assessment'
    coach_id: '',
    event_time: '',
    event_end_time: '',
    location: '',
    notes: '',
  });
  const [coaches, setCoaches] = useState([]);

  useEffect(() => {
    if (eventType === 'workout') {
      fetchTrainingPrograms();
      fetchWorkoutTemplates();
    } else if (eventType === 'meal') {
      fetchMeals();
      fetchMealPlans();
    } else if (eventType === 'lesson') {
      fetchCoaches();
    }
  }, [eventType]);

  const fetchCoaches = async () => {
    const { data } = await supabase
      .from('users')
      .select('id, full_name')
      .in('role', ['admin', 'coach'])
      .order('full_name');
    setCoaches(data || []);
  };

  const fetchWorkoutTemplates = async () => {
    const { data } = await supabase
      .from('workout_templates')
      .select('*')
      .order('created_at');
    // Group by program, then training-cycle order within each (month → week → day type) (#158)
    const sorted = (data || []).sort((a, b) => {
      const pa = a.program || '', pb = b.program || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return compareTemplates(a, b);
    });
    setWorkoutTemplates(sorted);
  };

  useEffect(() => {
    if (selectedProgramId) {
      fetchTrainingDays(selectedProgramId);
    }
  }, [selectedProgramId]);

  const fetchTrainingPrograms = async () => {
    const { data } = await supabase
      .from('training_programs')
      .select('id, name, description, day_anchor') // day_anchor: #393
      .order('created_at'); // build order, not alphabetical (#158)
    setTrainingPrograms(data || []);
  };

  const fetchTrainingDays = async (programId) => {
    const { data } = await supabase
      .from('training_days')
      .select('id, day_number, title')
      .eq('program_id', programId)
      .order('day_number');
    setTrainingDays(data || []);
  };

  const fetchMeals = async () => {
    const { data } = await supabase
      .from('meals')
      .select('*')
      .order('meal_type')
      .order('name');
    setMeals(data || []);
  };

  const fetchMealPlans = async () => {
    const { data } = await supabase
      .from('meal_plans')
      .select('id, name, description')
      .order('name');
    setMealPlans(data || []);
  };

  const handleSubmit = async () => {
    setLoading(true);

    // Normalize the date prop (Date object or string) to a local YYYY-MM-DD string
    // to avoid the toISOString UTC drift that shifts dates by a day.
    const dateStr = (() => {
      if (typeof date === 'string') return date;
      if (date instanceof Date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
      return date;
    })();

    try {
      // For meal/workout events on a team, expand to every team member.
      if ((eventType === 'workout' || eventType === 'meal') && playerIds.length === 0 && view === 'team' && teamId) {
        const { data: members, error: membersErr } = await supabase
          .from('team_members')
          .select('user_id')
          .eq('team_id', teamId);
        if (membersErr) throw membersErr;
        playerIds = (members || []).map(m => m.user_id).filter(Boolean);
        if (playerIds.length === 0) {
          throw new Error('This team has no members. Add players to the team before scheduling.');
        }
      }

      // Guard: meal/workout events require at least one player
      if ((eventType === 'workout' || eventType === 'meal') && playerIds.length === 0) {
        throw new Error('No player selected. Please select a player first.');
      }

      if (eventType === 'lesson') {
        // Book a lesson or assessment for the selected player(s) (#214)
        if (playerIds.length === 0) {
          throw new Error('No player selected. Please select a player first.');
        }
        const coach = coaches.find(c => c.id === lessonData.coach_id);
        const typeLabel = lessonData.lesson_type === 'assessment' ? 'Assessment' : 'Lesson';
        const title = coach ? `${typeLabel} with ${coach.full_name}` : typeLabel;
        const rows = playerIds.map(pid => ({
          player_id: pid,
          event_type: lessonData.lesson_type, // 'lesson' or 'assessment'
          event_date: dateStr,
          event_time: timeTBD ? null : (lessonData.event_time || null),
          event_end_time: lessonData.event_end_time || null,
          title,
          location: lessonData.location || null,
          notes: lessonData.notes || null,
        }));
        const { error } = await supabase.from('schedule_events').insert(rows);
        if (error) throw error;

      } else if (eventType === 'team-event') {
        // Create team event
        const { error } = await supabase
          .from('schedule_events')
          .insert({
            team_id: teamId,
            team_ids: [teamId],
            event_type: teamEventData.event_type,
            opponent: teamEventData.opponent,
            event_date: dateStr,
            event_time: timeTBD ? null : (teamEventData.event_time || null),
            location: teamEventData.location,
            address: teamEventData.address || null,
            home_away: teamEventData.event_type === 'game' ? teamEventData.home_away : null,
            is_optional: teamEventData.is_optional,
            notes: teamEventData.notes || null,
            lanes: teamEventData.lanes.length > 0 ? teamEventData.lanes : null
          });

        if (error) throw error;

      } else if (eventType === 'workout') {
        if (workoutType === 'single-day') {
          if (workoutSelectionMode === 'create') {
            // Create new workout with exercises
            const filteredExercises = (newWorkoutData.exercises || []).filter(ex => ex.name.trim());
            const notesWithExercises = [
              newWorkoutData.notes || '',
              filteredExercises.length > 0 ? '\n--- Exercises ---\n' + filteredExercises.map(ex =>
                [ex.name, ex.sets && ex.reps ? `${ex.sets}x${ex.reps}` : (ex.sets || ''), ex.rest || '', ex.load || '', ex.link || ''].join(' | ')
              ).join('\n') : ''
            ].filter(Boolean).join('\n');

            const rows = playerIds.map(pid => ({
              player_id: pid,
              event_type: 'workout',
              event_date: dateStr,
              title: newWorkoutData.title,
              notes: notesWithExercises || null
            }));
            const { error } = await supabase.from('schedule_events').insert(rows);

            if (error) {
              console.error('Error creating new workout:', error);
              throw error;
            }
          } else if (workoutSelectionMode === 'template') {
            // Apply workout template to calendar
            const template = workoutTemplates.find(t => t.id === selectedTemplateId);
            if (template) {
              const exercises = template.exercises || [];
              const notesWithExercises = [
                template.notes || '',
                exercises.length > 0 ? '\n--- Exercises ---\n' + exercises.map(ex =>
                  [ex.name, ex.sets && ex.reps ? `${ex.sets}x${ex.reps}` : (ex.sets || ''), ex.rest || '', ex.load || '', ex.link || ''].join(' | ')
                ).join('\n') : ''
              ].filter(Boolean).join('\n');

              const rows = playerIds.map(pid => ({
                player_id: pid,
                event_type: 'workout',
                event_date: dateStr,
                title: template.name,
                notes: notesWithExercises || null
              }));
              const { error } = await supabase.from('schedule_events').insert(rows);
              if (error) throw error;
            }
          } else {
            // Create single workout day event from existing program
            const day = trainingDays.find(d => d.id === selectedDayId);
            const rows = playerIds.map(pid => ({
              player_id: pid,
              event_type: 'workout',
              event_date: dateStr,
              title: day?.title || `Day ${day?.day_number}`,
              training_day_id: selectedDayId
            }));
            const { error } = await supabase.from('schedule_events').insert(rows);

            if (error) {
              console.error('Error creating workout event:', error);
              throw error;
            }
          }
        } else if (workoutType === 'program') {
          // Assign full training program to all selected players
          const { data: { user } } = await supabase.auth.getUser();
          const endDateVal = programEndDate || null;
          const assignRows = playerIds.map(pid => ({
            program_id: selectedProgramId,
            player_id: pid,
            start_date: dateStr,
            end_date: endDateVal,
            assigned_by: user?.id
          }));
          const { error } = await supabase.from('training_program_assignments').insert(assignRows);

          if (error) throw error;

          // Generate calendar events if an end date is set. #393: a generated
          // ('weekday') program lays itself out from the Monday on/after the
          // start date by its own day numbers; a hand-built ('sequential')
          // program still needs ticked weekdays. See placeProgramDays.
          const program = trainingPrograms.find(p => p.id === selectedProgramId);
          const isWeekdayProgram = program?.day_anchor === 'weekday';
          if (programEndDate && (isWeekdayProgram || programWeekdays.some(Boolean))) {
            const { data: days } = await supabase
              .from('training_days')
              .select('id, day_number, title')
              .eq('program_id', selectedProgramId)
              .order('day_number');
            const placed = placeProgramDays({
              dayAnchor: program?.day_anchor, days,
              startStr: dateStr, endStr: programEndDate, weekdays: programWeekdays,
            });
            if (placed.length > 0) {
              const rows = [];
              placed.forEach(({ date: ds, day }) => {
                playerIds.forEach(pid => {
                  rows.push({
                    player_id: pid,
                    event_type: 'workout',
                    event_date: ds,
                    title: day.title || `${program?.name || 'Program'} - Day ${day.day_number}`,
                    training_program_id: selectedProgramId,
                    training_day_id: day.id,
                  });
                });
              });
              if (rows.length > 0) {
                const BATCH = 500;
                for (let i = 0; i < rows.length; i += BATCH) {
                  const { error: insErr } = await supabase.from('schedule_events').insert(rows.slice(i, i + BATCH));
                  if (insErr) throw insErr;
                }
              }
            }
          }
        }

      } else if (eventType === 'meal') {
        if (mealType === 'single-meal') {
          if (mealSelectionMode === 'create') {
            // Create new meal in meals table first, then schedule it
            const { data: { user } } = await supabase.auth.getUser();
            const { data: newMeal, error: mealError } = await supabase
              .from('meals')
              .insert({
                name: newMealData.name,
                description: newMealData.description || null,
                meal_type: newMealData.meal_type,
                calories: newMealData.calories ? parseInt(newMealData.calories) : null,
                protein_g: newMealData.protein_g ? parseFloat(newMealData.protein_g) : null,
                carbs_g: newMealData.carbs_g ? parseFloat(newMealData.carbs_g) : null,
                fat_g: newMealData.fat_g ? parseFloat(newMealData.fat_g) : null,
                created_by: user?.id
              })
              .select()
              .single();

            if (mealError) {
              console.error('Error creating meal:', mealError);
              throw mealError;
            }

            // Now create schedule events referencing the new meal for all selected players
            const mealEventRows = playerIds.map(pid => ({
              player_id: pid,
              event_type: 'meal',
              event_date: dateStr,
              title: newMeal.name,
              meal_id: newMeal.id
            }));
            const { error: scheduleError } = await supabase.from('schedule_events').insert(mealEventRows);

            if (scheduleError) {
              console.error('Error creating meal event:', scheduleError);
              throw scheduleError;
            }
          } else {
            // Create single meal event from existing meal for all selected players
            const meal = meals.find(m => m.id === selectedMealId);
            const mealRows = playerIds.map(pid => ({
              player_id: pid,
              event_type: 'meal',
              event_date: dateStr,
              title: meal?.name,
              meal_id: selectedMealId
            }));
            const { error } = await supabase.from('schedule_events').insert(mealRows);

            if (error) {
              console.error('Error creating meal event:', error);
              throw error;
            }
          }
        } else if (mealType === 'plan') {
          // Assign full meal plan to all selected players
          const { data: { user } } = await supabase.auth.getUser();
          const planRows = playerIds.map(pid => ({
            meal_plan_id: selectedMealPlanId,
            player_id: pid,
            start_date: dateStr,
            assigned_by: user?.id,
            meals_per_day: mealsPerDay,
          }));
          const { error } = await supabase.from('meal_plan_assignments').insert(planRows);

          if (error) throw error;
        }
      }

      // Success! Close modal and refresh
      const playerCount = (eventType === 'workout' || eventType === 'meal') ? playerIds.length : 1;
      alert(playerCount > 1 ? `Event added for ${playerCount} players!` : 'Event added successfully!');
      onSuccess();
    } catch (error) {
      console.error('Error in handleSubmit:', error);
      alert('Error creating event: ' + formatUserError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="bg-white border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-xl font-bold text-gray-900">Add Event</h3>
            <p className="text-sm text-gray-600 mt-1">
              {new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto flex-1 min-h-0">
          {/* Event Type Selection */}
          {!eventType && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700">What would you like to add?</p>
              
              {view === 'team' && (
                <>
                  <button
                    onClick={() => setEventType('team-event')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Users className="text-blue-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Team Event</div>
                        <div className="text-sm text-gray-600">Game, practice, or team activity</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => setEventType('workout')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Dumbbell className="text-purple-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Workout</div>
                        <div className="text-sm text-gray-600">Add a single workout for the whole team</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => { setEventType('workout'); setWorkoutType('program'); }}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <ClipboardList className="text-blue-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Assign Training Program</div>
                        <div className="text-sm text-gray-600">Assign a full multi-day program to the whole team</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => setEventType('meal')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Utensils className="text-orange-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Meal</div>
                        <div className="text-sm text-gray-600">Add a single meal for the whole team</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => { setEventType('meal'); setMealType('plan'); }}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Apple className="text-green-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Assign Meal Plan</div>
                        <div className="text-sm text-gray-600">Assign a full meal plan to the whole team</div>
                      </div>
                    </div>
                  </button>
                </>
              )}

              {view === 'player' && (
                <>
                  <button
                    onClick={() => setEventType('lesson')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <UserCheck className="text-blue-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Lesson / Assessment</div>
                        <div className="text-sm text-gray-600">Book a lesson or assessment with a coach</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => setEventType('workout')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Dumbbell className="text-purple-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Workout</div>
                        <div className="text-sm text-gray-600">Add a single workout day</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => setEventType('meal')}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Utensils className="text-orange-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Meal</div>
                        <div className="text-sm text-gray-600">Add a single meal</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => { setEventType('workout'); setWorkoutType('program'); }}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <ClipboardList className="text-blue-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Assign Training Program</div>
                        <div className="text-sm text-gray-600">Assign a full multi-day program</div>
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => { setEventType('meal'); setMealType('plan'); }}
                    className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition text-left"
                  >
                    <div className="flex items-center space-x-3">
                      <Apple className="text-green-600" size={24} />
                      <div>
                        <div className="font-semibold text-gray-900">Assign Meal Plan</div>
                        <div className="text-sm text-gray-600">Assign a full meal plan</div>
                      </div>
                    </div>
                  </button>
                </>
              )}
            </div>
          )}

          {/* Team Event Form */}
          {eventType === 'team-event' && (
            <div className="space-y-4">
              <button
                onClick={() => setEventType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Event Type *</label>
                  <select
                    value={teamEventData.event_type}
                    onChange={(e) => setTeamEventData({...teamEventData, event_type: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="practice">Practice</option>
                    <option value="game">Game</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {teamEventData.event_type === 'game' ? 'Opponent' : 'Event Name'} *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder={teamEventData.event_type === 'game' ? 'e.g., Hawks Academy' : 'e.g., Team Practice'}
                    value={teamEventData.opponent}
                    onChange={(e) => setTeamEventData({...teamEventData, opponent: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Time {!timeTBD && '*'}</label>
                  <input
                    type="time"
                    required={!timeTBD}
                    disabled={timeTBD}
                    value={timeTBD ? '' : teamEventData.event_time}
                    onChange={(e) => setTeamEventData({...teamEventData, event_time: e.target.value})}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
                  />
                  <label className="flex items-center space-x-2 mt-2">
                    <input
                      type="checkbox"
                      checked={timeTBD}
                      onChange={(e) => setTimeTBD(e.target.checked)}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span className="text-xs text-gray-600">TBD (set later)</span>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Location *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Home Field"
                    value={teamEventData.location}
                    onChange={(e) => setTeamEventData({...teamEventData, location: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {teamEventData.event_type === 'game' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Home/Away</label>
                    <select
                      value={teamEventData.home_away || ''}
                      onChange={(e) => setTeamEventData({...teamEventData, home_away: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Not specified</option>
                      <option value="home">Home</option>
                      <option value="away">Away</option>
                    </select>
                  </div>
                )}

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Reserved Lanes</label>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {LANE_OPTIONS.map(lane => (
                      <label key={lane} className="flex items-center space-x-2 text-sm">
                        <input type="checkbox" checked={teamEventData.lanes.includes(lane)} onChange={(e) => {
                          const updated = e.target.checked ? [...teamEventData.lanes, lane] : teamEventData.lanes.filter(l => l !== lane);
                          setTeamEventData({...teamEventData, lanes: updated});
                        }} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" />
                        <span className="text-gray-700">{lane}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Workout Selection — auto-route to single-day when clicking "Workout" */}
          {eventType === 'workout' && !workoutType && (
            <div className="space-y-3">
              <button
                onClick={() => setEventType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <p className="text-sm font-medium text-gray-700">Select workout type:</p>

              <button
                onClick={() => setWorkoutType('single-day')}
                className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
              >
                <div className="font-semibold text-gray-900">Single Workout Day</div>
                <div className="text-sm text-gray-600">Add one workout to this date</div>
              </button>

              <button
                onClick={() => setWorkoutType('program')}
                className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
              >
                <div className="font-semibold text-gray-900">Full Training Program</div>
                <div className="text-sm text-gray-600">Assign entire multi-day program</div>
              </button>
            </div>
          )}

          {/* Single Workout Day Form */}
          {eventType === 'workout' && workoutType === 'single-day' && (
            <div className="space-y-4">
              <button
                onClick={() => setWorkoutType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              {/* Choose Existing or Create New */}
              {!workoutSelectionMode && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-3">Choose option:</p>
                  <div className="space-y-2">
                    <button
                      onClick={() => setWorkoutSelectionMode('existing')}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
                    >
                      <div className="font-semibold text-gray-900">From Training Program</div>
                      <div className="text-sm text-gray-600">Choose a day from a training program</div>
                    </button>
                    <button
                      onClick={() => setWorkoutSelectionMode('template')}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
                    >
                      <div className="font-semibold text-gray-900">From Saved Templates</div>
                      <div className="text-sm text-gray-600">Choose from your workout templates</div>
                    </button>
                    <button
                      onClick={() => setWorkoutSelectionMode('create')}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition text-left"
                    >
                      <div className="font-semibold text-gray-900">Create New Workout</div>
                      <div className="text-sm text-gray-600">Build a custom workout with exercises</div>
                    </button>
                  </div>
                </div>
              )}

              {/* Existing Workout Selection */}
              {workoutSelectionMode === 'existing' && (
                <div className="space-y-4">
                  <button
                    onClick={() => setWorkoutSelectionMode(null)}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                  >
                    <ChevronLeft size={16} />
                    <span>Back</span>
                  </button>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Training Program *</label>
                    <select
                      value={selectedProgramId}
                      onChange={(e) => setSelectedProgramId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select program...</option>
                      {trainingPrograms.map(program => (
                        <option key={program.id} value={program.id}>{program.name}</option>
                      ))}
                    </select>
                  </div>

                  {selectedProgramId && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Workout Day *</label>
                      <select
                        value={selectedDayId}
                        onChange={(e) => setSelectedDayId(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select day...</option>
                        {trainingDays.map(day => (
                          <option key={day.id} value={day.id}>
                            Day {day.day_number}{day.title ? `: ${day.title}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {/* Create New Workout */}
              {workoutSelectionMode === 'create' && (
                <div className="space-y-4">
                  <button
                    onClick={() => setWorkoutSelectionMode(null)}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                  >
                    <ChevronLeft size={16} />
                    <span>Back</span>
                  </button>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Workout Name *</label>
                    <input
                      type="text"
                      placeholder="e.g., Upper Body Day, Hitting Focus"
                      value={newWorkoutData.title}
                      onChange={(e) => setNewWorkoutData({ ...newWorkoutData, title: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Program</label>
                      <select
                        value={newWorkoutData.program}
                        onChange={(e) => setNewWorkoutData({ ...newWorkoutData, program: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {['No Program', 'Pitching', 'Hitting', 'Pitching/Hitting', 'Strength', 'Academy', 'Rehab'].map(o => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Folder</label>
                      <input
                        type="text"
                        placeholder="No Folder"
                        value={newWorkoutData.folder}
                        onChange={(e) => setNewWorkoutData({ ...newWorkoutData, folder: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Workout Notes</label>
                    <textarea
                      placeholder="Any special instructions or details..."
                      value={newWorkoutData.notes}
                      onChange={(e) => setNewWorkoutData({ ...newWorkoutData, notes: e.target.value })}
                      rows="2"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Exercises — #321: this 7-column editor had no responsive handling
                      at all, so on a 375px phone the four numeric inputs were squeezed to
                      roughly 30px each: you could not read the reps you had just typed.
                      Below sm each exercise stacks as a labelled card; sm+ is unchanged. */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Exercises</label>

                    {/* Portrait phone: stacked cards */}
                    <div className="sm:hidden space-y-3">
                      {newWorkoutData.exercises.map((ex, i) => {
                        const setField = (field, value) => {
                          const updated = [...newWorkoutData.exercises];
                          updated[i] = { ...updated[i], [field]: value };
                          setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                        };
                        return (
                          <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white space-y-2">
                            <div className="flex items-start gap-2">
                              <span className="text-xs font-semibold text-gray-500 pt-2">#{i + 1}</span>
                              <input type="text" placeholder="Exercise name" value={ex.name}
                                onChange={(e) => setField('name', e.target.value)}
                                className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                              <button type="button" onClick={() => {
                                const updated = newWorkoutData.exercises.filter((_, idx) => idx !== i);
                                setNewWorkoutData({ ...newWorkoutData, exercises: updated.length ? updated : [{ name: '', sets: '', reps: '', rest: '', load: '', link: '' }] });
                              }} className="text-gray-400 hover:text-red-600 flex-shrink-0 pt-2"><Trash2 size={14} /></button>
                            </div>
                            <div className="grid grid-cols-4 gap-2">
                              {[['Sets', 'sets', '3'], ['Reps', 'reps', '10'], ['Rest', 'rest', 'Rest'], ['Load', 'load', 'Load']].map(([label, field, ph]) => (
                                <div key={field}>
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5">{label}</label>
                                  <input type="text" placeholder={ph} value={ex[field] || ''}
                                    onChange={(e) => setField(field, e.target.value)}
                                    className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                                  />
                                </div>
                              ))}
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5">Link</label>
                              <input type="url" placeholder="https://..." value={ex.link}
                                onChange={(e) => setField('link', e.target.value)}
                                className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Tablet/desktop: original table, unchanged */}
                    <table className="hidden sm:table w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                          <th className="pb-2 pr-2">Name</th>
                          <th className="pb-2 pr-2 w-16">Sets</th>
                          <th className="pb-2 pr-2 w-16">Reps</th>
                          <th className="pb-2 pr-2 w-16">Rest</th>
                          <th className="pb-2 pr-2 w-16">Load</th>
                          <th className="pb-2 pr-2">Link</th>
                          <th className="pb-2 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {newWorkoutData.exercises.map((ex, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="py-1.5 pr-2">
                              <input type="text" placeholder="Exercise name" value={ex.name}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], name: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="text" placeholder="3" value={ex.sets}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], sets: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="text" placeholder="10" value={ex.reps}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], reps: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="text" placeholder="Rest" value={ex.rest || ''}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], rest: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="text" placeholder="Load" value={ex.load || ''}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], load: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5 pr-2">
                              <input type="url" placeholder="https://..." value={ex.link}
                                onChange={(e) => {
                                  const updated = [...newWorkoutData.exercises];
                                  updated[i] = { ...updated[i], link: e.target.value };
                                  setNewWorkoutData({ ...newWorkoutData, exercises: updated });
                                }}
                                className="w-full px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            </td>
                            <td className="py-1.5">
                              <button type="button" onClick={() => {
                                const updated = newWorkoutData.exercises.filter((_, idx) => idx !== i);
                                setNewWorkoutData({ ...newWorkoutData, exercises: updated.length ? updated : [{ name: '', sets: '', reps: '', rest: '', load: '', link: '' }] });
                              }} className="text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={() => setNewWorkoutData({ ...newWorkoutData, exercises: [...newWorkoutData.exercises, { name: '', sets: '', reps: '', rest: '', load: '', link: '' }] })}
                      className="mt-2 text-blue-600 hover:text-blue-800 text-sm font-medium flex items-center space-x-1">
                      <Plus size={14} /><span>Add Exercise</span>
                    </button>
                  </div>

                  {/* Save as Template button */}
                  <button
                    type="button"
                    onClick={async () => {
                      if (!newWorkoutData.title) { alert('Enter a workout name first'); return; }
                      const { data: { user } } = await supabase.auth.getUser();
                      const filteredExercises = (newWorkoutData.exercises || []).filter(ex => ex.name.trim());
                      const { error } = await supabase.from('workout_templates').insert({
                        name: newWorkoutData.title,
                        program: newWorkoutData.program || null,
                        folder: newWorkoutData.folder || null,
                        notes: newWorkoutData.notes || null,
                        exercises: filteredExercises,
                        created_by: user?.id,
                      });
                      if (error) { alert('Error saving template: ' + formatUserError(error)); }
                      else { alert('Workout saved as template!'); }
                    }}
                    className="w-full border-2 border-dashed border-blue-300 text-blue-600 py-2 rounded-lg text-sm font-medium hover:bg-blue-50 transition"
                  >
                    Save as Template
                  </button>
                </div>
              )}

              {/* Select from Saved Templates */}
              {workoutSelectionMode === 'template' && (
                <div className="space-y-4">
                  <button
                    onClick={() => setWorkoutSelectionMode(null)}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                  >
                    <ChevronLeft size={16} />
                    <span>Back</span>
                  </button>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Workout Template *</label>
                    <select
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a template...</option>
                      {workoutTemplates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}{t.program && t.program !== 'No Program' ? ` (${t.program})` : ''}</option>
                      ))}
                    </select>
                  </div>

                  {selectedTemplateId && (() => {
                    const tmpl = workoutTemplates.find(t => t.id === selectedTemplateId);
                    const exercises = tmpl?.exercises || [];
                    return exercises.length > 0 ? (
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-xs font-medium text-gray-500 mb-2">Exercises ({exercises.length})</p>
                        {exercises.map((ex, i) => (
                          <div key={i} className="text-sm text-gray-700 py-1">
                            {ex.name}{ex.sets ? ` - ${ex.sets} sets` : ''}{ex.reps ? ` x ${ex.reps}` : ''}
                          </div>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Full Program Form */}
          {eventType === 'workout' && workoutType === 'program' && (
            <div className="space-y-4">
              <button
                onClick={() => setWorkoutType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Training Program *</label>
                <select
                  value={selectedProgramId}
                  onChange={(e) => setSelectedProgramId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select program...</option>
                  {trainingPrograms.map(program => (
                    <option key={program.id} value={program.id}>{program.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Program starts on {(typeof date === 'string' ? new Date(date + 'T00:00:00') : date).toLocaleDateString()}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">End Date *</label>
                <input
                  type="date"
                  value={programEndDate}
                  onChange={(e) => setProgramEndDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {trainingPrograms.find(p => p.id === selectedProgramId)?.day_anchor === 'weekday' ? (
                <div className="border border-blue-200 rounded-lg p-3 bg-blue-50 text-xs text-blue-800">
                  This program was generated with its own training days (day 1 = Monday). It will start on the Monday on or after the start date, keep its rest-day spacing, and repeat until the end date. <span className="font-medium">Weekday picks don't apply.</span>
                </div>
              ) : (
              <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                <p className="text-sm font-medium text-gray-700 mb-2">Repeat on:</p>
                <div className="flex flex-wrap gap-1.5">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => (
                    <button
                      type="button"
                      key={label}
                      onClick={() => setProgramWeekdays(prev => { const next = [...prev]; next[i] = !next[i]; return next; })}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${programWeekdays[i] ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">Cycles through the program's days; loops back to Day 1 when it runs out.</p>
              </div>
              )}
            </div>
          )}

          {/* Meal Selection */}
          {eventType === 'meal' && !mealType && (
            <div className="space-y-3">
              <button
                onClick={() => setEventType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <p className="text-sm font-medium text-gray-700">Select meal type:</p>

              <button
                onClick={() => setMealType('single-meal')}
                className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
              >
                <div className="font-semibold text-gray-900">Single Meal</div>
                <div className="text-sm text-gray-600">Add one specific meal</div>
              </button>

              <button
                onClick={() => setMealType('plan')}
                className="w-full p-4 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
              >
                <div className="font-semibold text-gray-900">Full Meal Plan</div>
                <div className="text-sm text-gray-600">Assign entire meal plan</div>
              </button>
            </div>
          )}

          {/* Single Meal Form */}
          {eventType === 'meal' && mealType === 'single-meal' && (
            <div className="space-y-4">
              <button
                onClick={() => setMealType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              {/* Choose Existing or Create New */}
              {!mealSelectionMode && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-3">Choose option:</p>
                  <div className="space-y-2">
                    <button
                      onClick={() => setMealSelectionMode('existing')}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
                    >
                      <div className="font-semibold text-gray-900">Select Existing Meal</div>
                      <div className="text-sm text-gray-600">Choose from meal library</div>
                    </button>
                    <button
                      onClick={() => setMealSelectionMode('create')}
                      className="w-full p-3 border-2 border-gray-200 rounded-lg hover:border-orange-500 hover:bg-orange-50 transition text-left"
                    >
                      <div className="font-semibold text-gray-900">Create New Meal</div>
                      <div className="text-sm text-gray-600">Create a one-time meal</div>
                    </button>
                  </div>
                </div>
              )}

              {/* Existing Meal Selection */}
              {mealSelectionMode === 'existing' && (
                <div className="space-y-4">
                  <button
                    onClick={() => setMealSelectionMode(null)}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                  >
                    <ChevronLeft size={16} />
                    <span>Back</span>
                  </button>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Meal *</label>
                    <select
                      value={selectedMealId}
                      onChange={(e) => setSelectedMealId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a meal...</option>
                      {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
                        const typeMeals = meals.filter(m => m.meal_type === type);
                        if (typeMeals.length === 0) return null;
                        return (
                          <optgroup key={type} label={type.charAt(0).toUpperCase() + type.slice(1)}>
                            {typeMeals.map(meal => (
                              <option key={meal.id} value={meal.id}>
                                {meal.name} {meal.calories && `(${meal.calories} cal)`}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </div>
                </div>
              )}

              {/* Create New Meal */}
              {mealSelectionMode === 'create' && (
                <div className="space-y-4">
                  <button
                    onClick={() => setMealSelectionMode(null)}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                  >
                    <ChevronLeft size={16} />
                    <span>Back</span>
                  </button>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Meal Name *</label>
                    <input
                      type="text"
                      placeholder="e.g., Pre-Game Breakfast, Recovery Smoothie"
                      value={newMealData.name}
                      onChange={(e) => setNewMealData({ ...newMealData, name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                    <textarea
                      placeholder="Optional details..."
                      value={newMealData.description}
                      onChange={(e) => setNewMealData({ ...newMealData, description: e.target.value })}
                      rows="2"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Meal Type *</label>
                    <select
                      value={newMealData.meal_type}
                      onChange={(e) => setNewMealData({ ...newMealData, meal_type: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="breakfast">Breakfast</option>
                      <option value="lunch">Lunch</option>
                      <option value="dinner">Dinner</option>
                      <option value="snack">Snack</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Calories</label>
                      <input
                        type="number"
                        placeholder="550"
                        value={newMealData.calories}
                        onChange={(e) => setNewMealData({ ...newMealData, calories: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Protein (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="40"
                        value={newMealData.protein_g}
                        onChange={(e) => setNewMealData({ ...newMealData, protein_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Carbs (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="60"
                        value={newMealData.carbs_g}
                        onChange={(e) => setNewMealData({ ...newMealData, carbs_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Fat (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="15"
                        value={newMealData.fat_g}
                        onChange={(e) => setNewMealData({ ...newMealData, fat_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Meal Plan Form */}
          {eventType === 'meal' && mealType === 'plan' && (
            <div className="space-y-4">
              <button
                onClick={() => setMealType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Meal Plan *</label>
                <select
                  value={selectedMealPlanId}
                  onChange={(e) => setSelectedMealPlanId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select plan...</option>
                  {mealPlans.map(plan => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Plan will start on {(typeof date === 'string' ? new Date(date + 'T00:00:00') : date).toLocaleDateString()}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Meals / Snacks per day *</label>
                <select
                  value={mealsPerDay}
                  onChange={(e) => setMealsPerDay(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value={2}>2 meals/snacks per day</option>
                  <option value={3}>3 meals/snacks per day</option>
                  <option value={4}>4 meals/snacks per day</option>
                  <option value={5}>5 meals/snacks per day</option>
                  <option value={6}>6 meals/snacks per day</option>
                </select>
              </div>
            </div>
          )}

          {/* Lesson / Assessment Form (#214) */}
          {eventType === 'lesson' && (
            <div className="space-y-4">
              <button
                onClick={() => setEventType(null)}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
              >
                <ChevronLeft size={16} />
                <span>Back</span>
              </button>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Type *</label>
                  <select
                    value={lessonData.lesson_type}
                    onChange={(e) => setLessonData({ ...lessonData, lesson_type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="lesson">Lesson</option>
                    <option value="assessment">Assessment</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Coach *</label>
                  <select
                    value={lessonData.coach_id}
                    onChange={(e) => setLessonData({ ...lessonData, coach_id: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a coach…</option>
                    {coaches.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Start Time {!timeTBD && '*'}</label>
                  <input
                    type="time"
                    disabled={timeTBD}
                    value={timeTBD ? '' : lessonData.event_time}
                    onChange={(e) => setLessonData({ ...lessonData, event_time: e.target.value })}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
                  />
                  <label className="flex items-center space-x-2 mt-2">
                    <input
                      type="checkbox"
                      checked={timeTBD}
                      onChange={(e) => setTimeTBD(e.target.checked)}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span className="text-xs text-gray-600">TBD (set later)</span>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">End Time</label>
                  <input
                    type="time"
                    disabled={timeTBD}
                    value={timeTBD ? '' : lessonData.event_end_time}
                    onChange={(e) => setLessonData({ ...lessonData, event_end_time: e.target.value })}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Location</label>
                  <input
                    type="text"
                    placeholder="e.g., Cage 2, Main Field"
                    value={lessonData.location}
                    onChange={(e) => setLessonData({ ...lessonData, location: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
                  <textarea
                    rows={3}
                    placeholder="Focus areas, what to bring, etc."
                    value={lessonData.notes}
                    onChange={(e) => setLessonData({ ...lessonData, notes: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="border-t border-gray-200 p-6 flex space-x-3 flex-shrink-0">
          <button
            onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !eventType ||
              (eventType === 'team-event' && !teamEventData.opponent) ||
              (eventType === 'workout' && !workoutType) ||
              (eventType === 'workout' && workoutType === 'single-day' && workoutSelectionMode === 'existing' && !selectedDayId) ||
              (eventType === 'workout' && workoutType === 'single-day' && workoutSelectionMode === 'create' && !newWorkoutData.title) ||
              (eventType === 'workout' && workoutType === 'single-day' && workoutSelectionMode === 'template' && !selectedTemplateId) ||
              (eventType === 'workout' && workoutType === 'program' && (!selectedProgramId || !programEndDate)) ||
              (eventType === 'meal' && !mealType) ||
              (eventType === 'meal' && mealType === 'single-meal' && !mealSelectionMode) ||
              (eventType === 'meal' && mealType === 'single-meal' && mealSelectionMode === 'existing' && !selectedMealId) ||
              (eventType === 'meal' && mealType === 'single-meal' && mealSelectionMode === 'create' && !newMealData.name) ||
              (eventType === 'meal' && mealType === 'plan' && !selectedMealPlanId) ||
              (eventType === 'lesson' && (!lessonData.coach_id || (!timeTBD && !lessonData.event_time)))
            }
            className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? 'Saving...' : eventType === 'workout' ? 'Save Programming' : eventType === 'lesson' ? 'Book' : 'Add Event'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// EXERCISE NOTES PARSER
// ============================================

/* #321 — Sets / Reps / Rest / Load, readable on a 375px phone.
 *
 * Same helper as the one in Profile.js (kept local, this repo has no shared
 * component module). These four numbers were being packed onto one
 * un-wrapping line with no labels — "3 × 8 · 135 · 60" tells an athlete
 * nothing about which value is the rest and which is the load, and anything
 * that wasn't programmed simply disappeared. Labelled chips that wrap, with
 * an em-dash placeholder so a missing value can't read as a layout bug.
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

function parseExerciseNotes(notes) {
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
}

// ============================================
// WORKOUT DETAIL MODAL — Traq-style structured workout view
// ============================================

const CATEGORY_LABEL = {
  warmup: 'Warm-up',
  hitting: 'Hitting',
  pitching: 'Pitching',
  fielding: 'Fielding',
  conditioning: 'Conditioning',
  recovery: 'Recovery',
  strength: 'Strength',
  mobility: 'Mobility',
  other: 'Other',
  general: 'Workout',
};

// Aligned with ProgramLibrarySidebar FOLDER_COLORS so the color a coach sees in the
// program library matches what the athlete sees on their workout view (#179).
const CATEGORY_BAR = {
  warmup: 'bg-purple-500',
  hitting: 'bg-teal-500',
  pitching: 'bg-green-500',
  fielding: 'bg-green-500',
  conditioning: 'bg-yellow-500',
  recovery: 'bg-purple-500',
  strength: 'bg-orange-500',
  mobility: 'bg-purple-500',
  other: 'bg-gray-500',
  general: 'bg-gray-500',
};

const WORKOUT_HEADER_COLOR = {
  hitting:  { bg: 'bg-teal-100',   text: 'text-teal-600' },
  pitching: { bg: 'bg-green-100',  text: 'text-green-600' },
  warmup:   { bg: 'bg-purple-100', text: 'text-purple-600' },
  general:  { bg: 'bg-orange-100', text: 'text-orange-600' },
};

function WorkoutDetailModal({ event, onClose, onDelete, userRole, userId }) {
  useModalTracking('WorkoutDetailModal');
  const [exercises, setExercises] = useState([]);
  const [trainingDay, setTrainingDay] = useState(null);
  const [program, setProgram] = useState(null);
  const [generalNotes, setGeneralNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canManage = userRole === 'admin' || userRole === 'coach';
  // #460: the athlete logs the weight used per movement. Staff can log on an
  // individual athlete's workout; a team workout opened by staff has no single
  // athlete, so it stays read-only.
  const logPlayerId = logOwnerForEvent(event, userId, userRole);
  const canLog = !!logPlayerId && canLogWorkout(event);
  const [logs, setLogs] = useState({});
  const [lastLogs, setLastLogs] = useState({});
  const [historyFor, setHistoryFor] = useState(null); // #461: exercise name

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setLogs({});
      setLastLogs({});
      let loadedExercises = [];
      if (event.training_day_id) {
        const { data: day } = await supabase
          .from('training_days')
          .select('id, day_number, title, notes, program_id, training_programs(id, name, description)')
          .eq('id', event.training_day_id)
          .single();
        if (day) {
          setTrainingDay(day);
          setProgram(day.training_programs || null);
          if (day.notes) setGeneralNotes(day.notes);
        }
        const { data: ex } = await supabase
          .from('training_exercises')
          .select('id, day_id, category, name, description, sets, reps, weight, video_url, image_url, sort_order, rest, load, super_set')
          .eq('day_id', event.training_day_id)
          .order('sort_order', { ascending: true });
        loadedExercises = ex || [];
      }
      if (loadedExercises.length === 0 && event.notes) {
        const parsed = parseExerciseNotes(event.notes);
        if (parsed.general) setGeneralNotes(parsed.general);
        loadedExercises = (parsed.exercises || []).map((e, i) => ({
          id: `n-${i}`,
          name: e.name,
          sets: e.sets,
          reps: e.reps,
          rest: e.rest,
          load: e.load,
          video_url: e.link,
          category: 'general',
        }));
      }
      setExercises(loadedExercises);
      if (canLog && loadedExercises.length > 0) {
        try {
          const [mine, last] = await Promise.all([
            fetchWorkoutLogs(event.id, logPlayerId),
            fetchLastLogs(logPlayerId, loadedExercises.map(e => exerciseNameKey(e.name)), event.event_date, event.id),
          ]);
          setLogs(mine);
          setLastLogs(last);
        } catch (err) {
          console.error('Error loading exercise logs:', err);
        }
      }
      setLoading(false);
    };
    load();
  }, [event, canLog, logPlayerId]);

  const saveLog = async (ex, weightText, repsText) => {
    const key = String(ex.id);
    const existing = logs[key];
    const weight = parseWeight(weightText);
    if (Number.isNaN(weight)) throw new Error(`Enter a weight in lb, from 0 to ${MAX_WEIGHT - 1}.`);
    if (weight === null) {
      if (existing) await deleteExerciseLog(existing.id);
      setLogs(prev => { const next = { ...prev }; delete next[key]; return next; });
      return;
    }
    const row = await saveExerciseLog({ event, playerId: logPlayerId, exercise: ex, weight, repsDone: repsText, createdBy: userId });
    setLogs(prev => ({ ...prev, [key]: row }));
  };

  const groupedByCategory = useMemo(() => {
    const groups = {};
    exercises.forEach(ex => {
      const cat = (ex.category || 'general').toLowerCase();
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(ex);
    });
    return groups;
  }, [exercises]);

  const handleDelete = async () => {
    setDeleting(true);
    const { error } = await supabase.from('schedule_events').delete().eq('id', event.id);
    setDeleting(false);
    if (error) {
      alert('Could not delete: ' + formatUserError(error));
      return;
    }
    onDelete && onDelete();
  };

  // Escape closes this card, matching EventDetailModal and FacilityEventDetail.
  // Weight entries (#460) save on blur, so there is nothing to confirm — but the delete
  // confirmation sits on top of the card, so the first press steps back out of
  // that rather than closing both at once. A delete already in flight is left
  // alone: closing mid-request would hide the result of it.
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (deleting) return;
      if (confirmDelete) { setConfirmDelete(false); return; }
      // A weight box being typed in saves on blur; the first press commits it.
      if (document.activeElement?.tagName === 'INPUT') { document.activeElement.blur(); return; }
      onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [confirmDelete, deleting, onClose]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350 sweep: overflow-hidden so the height cap is authoritative and a
          long unbroken word in the program name or an exercise cannot stretch
          the card — and the page — wider than the screen. */}
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-5 flex items-start justify-between flex-shrink-0">
          <div className="flex items-start space-x-3 min-w-0">
            {(() => { const hc = WORKOUT_HEADER_COLOR[getWorkoutCategory(event.title)] || WORKOUT_HEADER_COLOR.general; return (
              <div className={`p-2 ${hc.bg} rounded-lg flex-shrink-0`}>
                <Dumbbell size={22} className={hc.text} />
              </div>
            ); })()}
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900 truncate">{event.title || 'Workout'}</h2>
              <div className="text-sm text-gray-600 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{new Date(event.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
                {event.event_time && <span>• {formatTimeDisplay(event.event_time)}</span>}
                {/* #350 sweep: the program name is free text in a header that does
                    not shrink — min-w-0 + break-words keep it from widening the card. */}
                {program?.name && <span className="min-w-0 break-words line-clamp-2" title={program.name}>• {program.name}{trainingDay?.day_number ? ` — Day ${trainingDay.day_number}` : ''}</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={22} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 min-h-0">
          {loading ? (
            <div className="text-center py-10 text-gray-500 text-sm">Loading workout...</div>
          ) : (
            <>
              {generalNotes && (
                <div className="mb-5 p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">Notes</div>
                  <div className="text-sm text-gray-800 whitespace-pre-wrap">{generalNotes}</div>
                </div>
              )}

              {exercises.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">No exercises in this workout.</div>
              ) : (
                Object.entries(groupedByCategory).map(([cat, exs]) => {
                  const label = CATEGORY_LABEL[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
                  const bar = CATEGORY_BAR[cat] || 'bg-gray-500';
                  return (
                    <div key={cat} className="mb-5">
                      <div className="flex items-center mb-2">
                        <div className={`w-1.5 h-5 rounded-sm mr-2 ${bar}`} />
                        <h3 className="text-sm font-bold text-gray-800 uppercase tracking-wide">{label}</h3>
                        <span className="ml-2 text-xs text-gray-400">({exs.length})</span>
                      </div>
                      <div className="sm:hidden space-y-2">
                        {exs.map((ex, i) => {
                          return (
                            <div key={ex.id || i} className="border border-gray-200 rounded-lg p-3 bg-white">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start min-w-0 flex-1">
                                  {ex.super_set && (
                                    <span className="mr-2 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase flex-shrink-0">
                                      {ex.super_set}
                                    </span>
                                  )}
                                  <div className="min-w-0">
                                    {logPlayerId ? (
                                      <button type="button" onClick={() => setHistoryFor(ex.name)} className="font-semibold text-gray-900 break-words text-left hover:text-blue-600 inline-flex items-center gap-1" title="See this movement's history">
                                        {ex.name}<History size={13} className="text-gray-400 flex-shrink-0" />
                                      </button>
                                    ) : (
                                      <div className="font-semibold text-gray-900 break-words">{ex.name}</div>
                                    )}
                                    {ex.description && <div className="text-xs text-gray-500 mt-0.5 break-words">{ex.description}</div>}
                                  </div>
                                </div>
                                {ex.video_url && (
                                  <a href={ex.video_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-50 text-blue-600 text-xs font-medium hover:bg-blue-100 flex-shrink-0" title="Open video">
                                    <ExternalLink size={12} />
                                    Video
                                  </a>
                                )}
                              </div>
                              {/* #321: was `[sets × reps, load, rest].join(' · ')` — no labels,
                                  and a value that wasn't programmed was dropped silently. */}
                              <ExerciseMetrics
                                className="mt-2"
                                sets={ex.sets}
                                reps={ex.reps}
                                load={ex.load || ex.weight}
                                rest={ex.rest}
                              />
                              {canLog && (
                                <ExerciseLogInput
                                  log={logs[String(ex.id)]}
                                  last={lastLogs[exerciseNameKey(ex.name)]}
                                  onSave={(w, r) => saveLog(ex, w, r)}
                                />
                              )}
                            </div>
                          );
                        })}
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
                              {canLog && <th className="px-3 py-2">Weight used · Reps</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {exs.map((ex, i) => (
                              <tr key={ex.id || i} className="border-t border-gray-100 hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  <div className="flex items-center">
                                    {ex.super_set && (
                                      <span className="mr-2 inline-flex items-center justify-center w-5 h-5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase">
                                        {ex.super_set}
                                      </span>
                                    )}
                                    <div>
                                      {logPlayerId ? (
                                        <button type="button" onClick={() => setHistoryFor(ex.name)} className="font-medium text-gray-900 text-left hover:text-blue-600 inline-flex items-center gap-1" title="See this movement's history">
                                          {ex.name}<History size={12} className="text-gray-400 flex-shrink-0" />
                                        </button>
                                      ) : (
                                        <div className="font-medium text-gray-900">{ex.name}</div>
                                      )}
                                      {ex.description && <div className="text-xs text-gray-500 mt-0.5">{ex.description}</div>}
                                    </div>
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{ex.sets || '—'}</td>
                                <td className="px-3 py-2 text-center text-gray-700 tabular-nums">{ex.reps || '—'}</td>
                                <td className="px-3 py-2 text-center text-gray-700">{ex.load || ex.weight || '—'}</td>
                                <td className="px-3 py-2 text-center text-gray-700">{ex.rest || '—'}</td>
                                <td className="px-3 py-2 text-center">
                                  {ex.video_url ? (
                                    <a href={ex.video_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center text-blue-500 hover:text-blue-700" title="Open video">
                                      <ExternalLink size={14} />
                                    </a>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </td>
                                {canLog && (
                                  <td className="px-3 py-2 align-top">
                                    <ExerciseLogInput
                                      compact
                                      log={logs[String(ex.id)]}
                                      last={lastLogs[exerciseNameKey(ex.name)]}
                                      onSave={(w, r) => saveLog(ex, w, r)}
                                    />
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="border-t border-gray-200 p-4 flex space-x-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium hover:bg-gray-50 transition">
            Close
          </button>
          {canManage && (
            <button onClick={() => setConfirmDelete(true)} disabled={deleting} className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition disabled:opacity-50 flex items-center space-x-2">
              <Trash2 size={16} />
              <span>{deleting ? 'Deleting...' : 'Delete'}</span>
            </button>
          )}
        </div>

        {confirmDelete && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center rounded-lg p-4">
            {/* #350 sweep: this confirmation had no cap and no scroll of its own,
                and the workout title inside it is free text, so a long title
                pushed Cancel / Delete off the bottom of the screen with nothing
                to scroll. Capped and scrollable, with the title clamped. */}
            <div className="bg-white rounded-lg p-6 max-w-sm mx-4 max-h-[90vh] overflow-y-auto">
              <h3 className="text-lg font-bold text-gray-900 mb-2">Delete workout?</h3>
              <p className="text-gray-700 text-sm mb-4">
                {/* No `block` class here: Tailwind's .block beats .line-clamp-3's
                    display:-webkit-box and would silently disable the clamp. */}
                <span className="font-semibold break-words line-clamp-3" title={event.title || 'Workout'}>"{event.title || 'Workout'}"</span>
                This workout will be removed from the calendar. The underlying training program is not affected.
              </p>
              <div className="flex space-x-3">
                <button onClick={() => setConfirmDelete(false)} className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium hover:bg-gray-50 transition">
                  Cancel
                </button>
                <button onClick={() => { setConfirmDelete(false); handleDelete(); }} disabled={deleting} className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-red-700 transition disabled:opacity-50">
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {historyFor && logPlayerId && (
        <ExerciseHistoryModal playerId={logPlayerId} exerciseName={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  );
}

// ============================================
// EVENT DETAIL/EDIT/DELETE MODAL - COMPLETE VERSION
// ============================================

function EventDetailModal({ event, onClose, onDelete, onUpdate, userRole, userId, onMessageCoach }) {
  useModalTracking('EventDetailModal');
  console.log('🔵 EventDetailModal rendered with event:', event);

  const isOwnGame = event.player_id === userId && event.event_type === 'game';
  const canManage = userRole === 'admin' || userRole === 'coach' || isOwnGame;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false); // Custom confirm modal
  const [mealData, setMealData] = useState(null);
  const [planMeals, setPlanMeals] = useState(null); // fuel-plan assignment: full meal breakdown
  const [slotReservations, setSlotReservations] = useState([]);
  const [slotResLoading, setSlotResLoading] = useState(false);
  // #306: the "are you sure, this uses the session" step, shown after the
  // player presses Cancel and before anything is written. It used to be the
  // sick/not-sick picker; the reason is no longer the athlete's to choose.
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [formData, setFormData] = useState({
    title: event.title || event.opponent || '',
    event_date: event.event_date,
    event_time: event.event_time || '',
    location: event.location || '',
    notes: event.notes || ''
  });
  const [mealFormData, setMealFormData] = useState({
    name: '',
    description: '',
    meal_type: 'breakfast',
    calories: '',
    protein_g: '',
    carbs_g: '',
    fat_g: ''
  });

  // Fetch full meal data if this is a meal event
  useEffect(() => {
    if (event.event_type === 'meal' && event.meal_id) {
      fetchMealData();
    }
    // Fuel-plan assignment (no single meal_id): load the plan's meal breakdown so
    // the schedule shows calories/macros instead of a blank/"TBD" (#12).
    if (event._isMealPlan && event._mealPlanId) {
      fetchPlanMeals();
    }
  }, [event]);

  // For staff viewing a training slot, fetch who is booked and their active package.
  useEffect(() => {
    if (event.event_type !== 'training_slot') return;
    setSlotResLoading(true);
    (async () => {
      try {
        const { data: resData } = await supabase
          .from('slot_reservations')
          .select('id, status, player_id, attendance, users(full_name)')
          .eq('slot_id', event.id)
          .eq('slot_date', event.event_date)
          .neq('status', 'cancelled');
        const rows = resData || [];
        const playerIds = rows.map(r => r.player_id).filter(Boolean);
        let pkgByPlayer = {};
        if (playerIds.length > 0) {
          const { data: purchases } = await supabase
            .from('store_purchases')
            .select('user_id, remaining_qty, expires_at, store_products(name)')
            .in('user_id', playerIds)
            .order('expires_at', { ascending: true });
          const now = new Date().toISOString();
          (purchases || []).forEach(p => {
            const active = p.remaining_qty === null || p.remaining_qty > 0;
            const notExpired = !p.expires_at || p.expires_at > now;
            if (active && notExpired && !pkgByPlayer[p.user_id]) pkgByPlayer[p.user_id] = p;
          });
        }
        setSlotReservations(rows.map(r => ({ ...r, _pkg: pkgByPlayer[r.player_id] || null })));
      } catch (_) {
        setSlotReservations([]);
      }
      setSlotResLoading(false);
    })();
  }, [event.id, event.event_date, event.event_type, userRole]);

  const fetchPlanMeals = async () => {
    const { data, error } = await supabase
      .from('meal_plan_items')
      .select('sort_order, meals(name, meal_type, calories, protein_g, carbs_g, fat_g)')
      .eq('meal_plan_id', event._mealPlanId)
      .order('sort_order', { ascending: true });
    if (!error && data) {
      setPlanMeals(data.map((r) => r.meals).filter(Boolean));
    }
  };

  const fetchMealData = async () => {
    const { data, error } = await supabase
      .from('meals')
      .select('*')
      .eq('id', event.meal_id)
      .single();
    
    if (!error && data) {
      setMealData(data);
      // Populate meal form data
      setMealFormData({
        name: data.name || '',
        description: data.description || '',
        meal_type: data.meal_type || 'breakfast',
        calories: data.calories || '',
        protein_g: data.protein_g || '',
        carbs_g: data.carbs_g || '',
        fat_g: data.fat_g || ''
      });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        throw new Error('Not authenticated. Please log in again.');
      }

      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      if (userError || !userData) {
        throw new Error('Could not verify user permissions.');
      }
      if (!['admin', 'coach'].includes(userData.role) && !isOwnGame) {
        throw new Error('You are not able to delete events. Ask an admin or a coach to delete this one for you.');
      }

      const { data: deleteData, error: deleteError } = await supabase
        .from('schedule_events')
        .delete()
        .eq('id', event.id)
        .select();
      if (deleteError) throw deleteError;
      if (!deleteData || deleteData.length === 0) {
        throw new Error('This event may already be gone. Refresh the page to check — if it is still there, ask an admin or a coach to delete it.');
      }

      alert('Event deleted successfully!');
      onDelete();
    } catch (error) {
      alert('Error deleting event: ' + formatUserError(error));
      setDeleting(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    
    try {
      // Update schedule_events record
      const updates = {
        title: formData.title,
        event_time: formData.event_time || null,
        location: formData.location || null,
        notes: formData.notes || null
      };

      // For team events, also update opponent
      if (event.team_id || (Array.isArray(event.team_ids) && event.team_ids.length > 0)) {
        updates.opponent = formData.title;
      }

      const { error: scheduleError } = await supabase
        .from('schedule_events')
        .update(updates)
        .eq('id', event.id);

      if (scheduleError) throw scheduleError;

      // If this is a meal with meal_id, also update the meals table
      if (event.event_type === 'meal' && event.meal_id) {
        const mealUpdates = {
          name: mealFormData.name,
          description: mealFormData.description || null,
          meal_type: mealFormData.meal_type,
          calories: mealFormData.calories ? parseInt(mealFormData.calories) : null,
          protein_g: mealFormData.protein_g ? parseFloat(mealFormData.protein_g) : null,
          carbs_g: mealFormData.carbs_g ? parseFloat(mealFormData.carbs_g) : null,
          fat_g: mealFormData.fat_g ? parseFloat(mealFormData.fat_g) : null
        };

        const { error: mealError } = await supabase
          .from('meals')
          .update(mealUpdates)
          .eq('id', event.meal_id);

        if (mealError) throw mealError;

        // Also update the title in schedule_events to match meal name
        const { error: titleError } = await supabase
          .from('schedule_events')
          .update({ title: mealFormData.name })
          .eq('id', event.id);

        if (titleError) throw titleError;
      }

      alert('Event updated successfully!');
      setEditing(false);
      onUpdate();
    } catch (error) {
      console.error('Error updating event:', error);
      alert('Error updating event: ' + formatUserError(error));
    } finally {
      setLoading(false);
    }
  };

  const getEventColor = (ev) => {
    const eventType = typeof ev === 'string' ? ev : ev?.event_type;
    if (eventType === 'workout') {
      const cat = (typeof ev === 'object' && ev?.category) || getWorkoutCategory(typeof ev === 'string' ? '' : ev?.title);
      switch(cat) {
        case 'hitting': return 'from-teal-50 to-teal-100 border-teal-200';
        case 'pitching': return 'from-green-50 to-green-100 border-green-200';
        case 'fielding': return 'from-green-50 to-green-100 border-green-200';
        case 'strength': return 'from-orange-50 to-orange-100 border-orange-200';
        case 'recovery': return 'from-purple-50 to-purple-100 border-purple-200';
        case 'warmup': return 'from-purple-50 to-purple-100 border-purple-200';
        case 'mobility': return 'from-purple-50 to-purple-100 border-purple-200';
        case 'pt': return 'from-rose-50 to-rose-100 border-rose-200';
        case 'conditioning': return 'from-yellow-50 to-yellow-100 border-yellow-200';
        default: return 'from-gray-50 to-gray-100 border-gray-200';
      }
    }
    switch(eventType) {
      case 'game': return 'from-slate-50 to-slate-100 border-slate-200';
      case 'practice': return 'from-green-50 to-green-100 border-green-200';
      case 'meal': return 'from-yellow-50 to-yellow-100 border-yellow-200';
      default: return 'from-gray-50 to-gray-100 border-gray-200';
    }
  };

  // #347 QA: this card's only way out was the X in its header. The header is
  // flex-shrink-0, so a long title grew it past the card's max-h and the card's
  // overflow-hidden then clipped everything below it — including the Close
  // button — leaving a reload as the only escape. The title is clamped below so
  // the header cannot grow, and Escape / a backdrop click now close the card as
  // well, so a tall header can never trap the user again. Same shape as
  // FacilityEventDetail: unsaved edits are confirmed before they are discarded,
  // and a click that STARTED inside the card does not dismiss it (so dragging a
  // text selection out of the card is safe).
  // Escape and a backdrop click always step back ONE layer, never straight out:
  // the delete confirmation and the cancel confirmation both sit on
  // top of this card, so dismissing them must not throw the card away too.
  const requestClose = () => {
    if (confirmDelete) { setConfirmDelete(false); return; }
    if (showCancelConfirm) { setShowCancelConfirm(false); return; }
    if (editing && !window.confirm(DISCARD_EDITS_PROMPT)) return;
    onClose();
  };

  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (confirmDelete) { setConfirmDelete(false); return; }
      if (showCancelConfirm) { setShowCancelConfirm(false); return; }
      if (editing && !window.confirm(DISCARD_EDITS_PROMPT)) return;
      onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [confirmDelete, showCancelConfirm, editing, onClose]);

  const backdropMouseDown = useRef(false);
  const backdropProps = {
    onMouseDown: (e) => { backdropMouseDown.current = e.target === e.currentTarget; },
    onClick: (e) => { if (e.target === e.currentTarget && backdropMouseDown.current) requestClose(); },
  };

  // Training-slot / private session (#233): players see a Cancel button with a
  // 12h-before cutoff; staff get a read-only summary (slots are managed from the
  // Slots tab, not from schedule_events, so the normal delete path doesn't apply).
  if (event.event_type === 'training_slot') {
    const fmtTime = (t) => {
      if (!t) return '';
      const [h, m] = t.split(':');
      const hr = parseInt(h, 10);
      return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
    };
    const startAt = new Date(`${event.event_date}T${event.start_time || '00:00'}:00`);
    const CUTOFF_MS = 12 * 60 * 60 * 1000;
    const isPlayer = userRole === 'player';
    const withinCancelWindow = Date.now() <= startAt.getTime() - CUTOFF_MS;

    // #306: the athlete no longer decides whether their own cancellation was
    // "sick". Cordell: "Admins and coaches only choose if a cancellation was
    // sick." So this writes one reason — athlete_cancelled, meaning "the
    // athlete cancelled and nobody has looked at it yet" — and gives nothing
    // back. Staff turn it into a sick cancel from the Cancellations tab in the
    // Store area, which is where the give-back now happens.
    //
    // The package is deliberately NOT touched from here. It never really was:
    // store_session_usage is staff-write and store_purchases is staff-update
    // under RLS, so the old attended=true call from an athlete's own browser
    // was refused with a 200 and an empty body every single time, and the
    // swallowed error hid it. Rather than keep a write that cannot succeed,
    // the deduction is a staff action on the review screen, and the athlete is
    // told the truth: cancelling uses the session.
    const handleCancelReservation = async () => {
      setLoading(true);
      try {
        const { data: resRow, error: findErr } = await supabase
          .from('slot_reservations')
          .select('id')
          .eq('slot_id', event.id)
          .eq('slot_date', event.event_date)
          .eq('player_id', userId)
          .in('status', ['confirmed', 'pending'])
          .maybeSingle();
        if (findErr) throw findErr;
        if (!resRow) throw new Error('Could not find your reservation for this session.');
        const now = new Date().toISOString();
        const { data: updated, error: updErr } = await supabase
          .from('slot_reservations')
          .update({
            status: 'cancelled',
            cancelled_at: now,
            cancel_reason: CANCEL_REASON_ATHLETE,
            cancel_reason_by: userId,
            cancel_reason_at: now,
          })
          .eq('id', resRow.id)
          .select('id');
        if (updErr) throw updErr;
        // A refused write comes back as success with zero rows, so an empty
        // array here is a failure that would otherwise show as "cancelled!"
        // while the athlete is still on the roster.
        if (!updated || updated.length === 0) {
          throw new Error('Nothing was saved — the cancellation was refused. You are still booked in, so please tell your coach directly.');
        }
        alert('Session cancelled. It uses the session from your package. If you were ill or injured, a coach or admin can give it back.');
        onDelete();
      } catch (err) {
        alert('Error cancelling session: ' + formatUserError(err));
        setLoading(false);
      }
    };

    return (
      // #347: this card listed every booked player with no height cap, so on a
      // full session the Close button sat below the viewport of a `fixed`
      // overlay the page cannot scroll. Same chrome as the main modal below.
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" {...backdropProps}>
        {/* #347 QA: overflow-hidden keeps the card's own box honest, and the
            title is clamped to two lines (full text on hover). This heading is
            a coach's free-text note, so a long one used to grow the header past
            the card and push the buttons off the bottom of the screen. */}
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
          <div className="bg-gradient-to-br from-teal-50 to-teal-100 border-2 border-teal-200 p-6 rounded-t-lg flex-shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1">Training Session</div>
                <h3 className="text-xl font-bold text-gray-900 line-clamp-2 break-words" title={event.title || 'Training Session'}>{event.title || 'Training Session'}</h3>
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
            </div>
          </div>
          <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
            <div className="text-sm text-gray-700">
              <div className="font-medium">{startAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
              <div>{fmtTime(event.start_time)}{event.duration_minutes ? ` · ${event.duration_minutes} min` : ''}</div>
            </div>
            {/* #347 QA: the coach's note is free text. Without break-words a
                single long unbroken string (a pasted URL, a run-on word) made
                this modal's body scroll sideways for thousands of pixels, so
                the note could not be read at all. */}
            {event.notes && <div className="text-sm text-gray-500 break-words">{event.notes}</div>}

            {isPlayer && (
              withinCancelWindow ? (
                showCancelConfirm ? (
                  /* #306: the athlete used to pick their own reason here, and
                     picking "I'm sick / injured" handed the session straight
                     back. That choice is now a staff one, so this step is a
                     plain confirmation with the consequence stated. The copy
                     says staff CAN give the session back, not that they will —
                     the whole point of the change is that it is their call. */
                  <div className="space-y-2 pt-2">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                      Cancelling uses the session from your package. If you are ill or injured, tell your coach — an admin or coach can give the session back.
                    </div>
                    <button
                      onClick={handleCancelReservation}
                      disabled={loading}
                      className="w-full bg-red-600 text-white py-2.5 rounded-lg font-medium hover:bg-red-700 transition disabled:opacity-50"
                    >
                      {loading ? 'Cancelling...' : 'Yes, cancel this session'}
                    </button>
                    <button onClick={() => setShowCancelConfirm(false)} disabled={loading} className="w-full text-xs text-gray-500 hover:text-gray-700 transition">Never mind</button>
                  </div>
                ) : (
                  <div className="space-y-2 pt-2">
                    <button
                      onClick={() => setShowCancelConfirm(true)}
                      className="w-full bg-red-600 text-white py-2.5 rounded-lg font-medium hover:bg-red-700 transition"
                    >
                      Cancel this session
                    </button>
                    <p className="text-xs text-gray-500 text-center">Cancellations are allowed up to 12 hours before the session.</p>
                  </div>
                )
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                  Cancellations close 12 hours before the session. Please contact your coach if you can't make it.
                </div>
              )
            )}
            {/* #407: the athlete can reach the coach about this session directly —
                the only route before was the sidebar's Messages, with no context. */}
            {isPlayer && onMessageCoach && event.coach_id && (
              <button
                onClick={() => onMessageCoach({ coachId: event.coach_id, coachName: event.coach_name || event.coach?.full_name || '', date: event.event_date, startTime: event.start_time, title: event.notes })}
                className="w-full border border-teal-600 text-teal-700 py-2.5 rounded-lg font-medium hover:bg-teal-50 transition inline-flex items-center justify-center space-x-2 touch-manipulation"
              >
                <MessageSquare size={16} /><span>Message coach about this session</span>
              </button>
            )}

            <div className="space-y-2 pt-2 border-t border-gray-100">
              {slotResLoading ? (
                <div className="text-xs text-gray-400">Loading bookings…</div>
              ) : slotReservations.length === 0 ? (
                <div className="text-xs text-gray-400">No bookings for this session.</div>
              ) : (
                slotReservations.map(res => (
                  <div key={res.id} className="flex items-start justify-between gap-2 bg-gray-50 rounded-lg p-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{res.users?.full_name || 'Unknown'}</div>
                      {!isPlayer && (res._pkg ? (
                        <div className="text-gray-500 mt-0.5 truncate">{res._pkg.store_products?.name}{res._pkg.remaining_qty != null ? ` · ${res._pkg.remaining_qty} session${res._pkg.remaining_qty !== 1 ? 's' : ''} left` : ''}</div>
                      ) : (
                        <div className="text-gray-400 mt-0.5">No active package</div>
                      ))}
                    </div>
                    <span className={`flex-shrink-0 px-2 py-0.5 rounded-full font-medium ${res.status === 'confirmed' ? 'bg-green-100 text-green-700' : res.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>{res.status}</span>
                  </div>
                ))
              )}
              {!isPlayer && <div className="text-xs text-gray-400">Manage attendance from the Slots tab.</div>}
            </div>

            <button onClick={onClose} className="w-full border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" {...backdropProps}>
      {/* #347 QA: overflow-hidden, same as the training-session and facility
          cards. Without it this card is a flex item whose automatic minimum
          width is its content, so one long unbroken word in a title, location
          or note stretched the card — and the page — thousands of pixels wide. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className={`bg-gradient-to-br ${getEventColor(event)} border-2 p-6 rounded-t-lg flex-shrink-0`}>
          {/* #347 QA: min-w-0 lets the flex child shrink, break-words lets a long
              unbroken title wrap instead of pushing the modal wider than the
              screen, and line-clamp-2 caps how tall that wrapping can make this
              header — the header does not shrink, so an unclamped title grew it
              past the card's max-h and the card's overflow-hidden then hid the
              date, the notes, the RSVP section and the Close/Edit/Delete row.
              Full title on hover, and Escape/backdrop close the card either way. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1">
                {event.event_type}
              </div>
              <h3 className="text-xl font-bold text-gray-900 line-clamp-2 break-words" title={event.title || event.opponent || undefined}>
                {event.title || event.opponent}
              </h3>
            </div>
            <button onClick={requestClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
              <X size={24} />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {editing ? (
            // EDIT MODE
            <div className="space-y-4">
              {event.event_type === 'meal' && event.meal_id ? (
                // MEAL EDIT FORM
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Meal Name *</label>
                    <input
                      type="text"
                      value={mealFormData.name}
                      onChange={(e) => setMealFormData({ ...mealFormData, name: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                    <textarea
                      value={mealFormData.description}
                      onChange={(e) => setMealFormData({ ...mealFormData, description: e.target.value })}
                      rows="2"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Meal Type *</label>
                    <select
                      value={mealFormData.meal_type}
                      onChange={(e) => setMealFormData({ ...mealFormData, meal_type: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="breakfast">Breakfast</option>
                      <option value="lunch">Lunch</option>
                      <option value="dinner">Dinner</option>
                      <option value="snack">Snack</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Calories</label>
                      <input
                        type="number"
                        value={mealFormData.calories}
                        onChange={(e) => setMealFormData({ ...mealFormData, calories: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Protein (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={mealFormData.protein_g}
                        onChange={(e) => setMealFormData({ ...mealFormData, protein_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Carbs (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={mealFormData.carbs_g}
                        onChange={(e) => setMealFormData({ ...mealFormData, carbs_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Fat (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={mealFormData.fat_g}
                        onChange={(e) => setMealFormData({ ...mealFormData, fat_g: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      rows="2"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </>
              ) : (
                // REGULAR EVENT EDIT FORM
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Title</label>
                    <input
                      type="text"
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {(event.team_id || (Array.isArray(event.team_ids) && event.team_ids.length > 0)) && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Time</label>
                        <input
                          type="time"
                          value={formData.event_time}
                          onChange={(e) => setFormData({ ...formData, event_time: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Location</label>
                        <input
                          type="text"
                          value={formData.location}
                          onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
                    <textarea
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      rows="3"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </>
              )}

              <div className="flex space-x-3 pt-4 border-t border-gray-200">
                <button
                  onClick={() => setEditing(false)}
                  className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {loading ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            // VIEW MODE
            <div className="space-y-3">
              <div className="flex items-center space-x-3 text-sm">
                <CalendarIcon size={16} className="text-gray-400" />
                <span className="text-gray-900">
                  {new Date(event.event_date + 'T00:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </span>
              </div>

              <div className="flex items-center space-x-3 text-sm">
                <span className="text-gray-400 font-medium">Time:</span>
                <span className={event.event_time ? 'text-gray-900' : 'text-yellow-700 font-medium'}>{formatTimeDisplay(event.event_time) || 'TBD'}</span>
              </div>

              {event.location && (
                <div className="flex items-center space-x-3 text-sm min-w-0">
                  <span className="text-gray-400 font-medium flex-shrink-0">Location:</span>
                  <span className="text-gray-900 min-w-0 break-words">{event.location}</span>
                </div>
              )}

              {/* Meal Nutritional Data */}
              {event.event_type === 'meal' && mealData && (
                <div className="mt-4 p-4 bg-orange-50 rounded-lg border-2 border-orange-200">
                  <h4 className="text-sm font-semibold text-orange-900 mb-3">Nutritional Information</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {mealData.meal_type && (
                      <div>
                        <span className="text-orange-700 font-medium">Type:</span>
                        <span className="ml-2 text-gray-900 capitalize">{mealData.meal_type}</span>
                      </div>
                    )}
                    {mealData.calories && (
                      <div>
                        <span className="text-orange-700 font-medium">Calories:</span>
                        <span className="ml-2 text-gray-900">{mealData.calories}</span>
                      </div>
                    )}
                    {mealData.protein_g && (
                      <div>
                        <span className="text-orange-700 font-medium">Protein:</span>
                        <span className="ml-2 text-gray-900">{mealData.protein_g}g</span>
                      </div>
                    )}
                    {mealData.carbs_g && (
                      <div>
                        <span className="text-orange-700 font-medium">Carbs:</span>
                        <span className="ml-2 text-gray-900">{mealData.carbs_g}g</span>
                      </div>
                    )}
                    {mealData.fat_g && (
                      <div>
                        <span className="text-orange-700 font-medium">Fat:</span>
                        <span className="ml-2 text-gray-900">{mealData.fat_g}g</span>
                      </div>
                    )}
                  </div>
                  {mealData.description && (
                    <div className="mt-3 pt-3 border-t border-orange-300">
                      <span className="text-orange-700 font-medium text-sm">Description:</span>
                      <p className="text-gray-900 text-sm mt-1 break-words">{mealData.description}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Fuel-plan assignment — full meal breakdown with calories/macros (#12) */}
              {event._isMealPlan && (
                <div className="mt-4 p-4 bg-orange-50 rounded-lg border-2 border-orange-200">
                  <h4 className="text-sm font-semibold text-orange-900 mb-3">Fuel Plan — {event.title}</h4>
                  {planMeals === null ? (
                    <div className="text-sm text-gray-500">Loading meals…</div>
                  ) : planMeals.length === 0 ? (
                    <div className="text-sm text-gray-500">No meals recorded on this plan.</div>
                  ) : (
                    <>
                      {(() => {
                        const tot = planMeals.reduce((t, m) => ({
                          calories: t.calories + (Number(m.calories) || 0),
                          protein_g: t.protein_g + (Number(m.protein_g) || 0),
                          carbs_g: t.carbs_g + (Number(m.carbs_g) || 0),
                          fat_g: t.fat_g + (Number(m.fat_g) || 0),
                        }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
                        return (
                          <div className="grid grid-cols-4 gap-2 mb-3 text-center">
                            {[['Calories', Math.round(tot.calories)], ['Protein', `${Math.round(tot.protein_g)}g`], ['Carbs', `${Math.round(tot.carbs_g)}g`], ['Fat', `${Math.round(tot.fat_g)}g`]].map(([l, v]) => (
                              <div key={l} className="bg-white rounded-md py-1.5 border border-orange-200">
                                <div className="text-sm font-bold text-gray-900">{v}</div>
                                <div className="text-[10px] text-orange-700 uppercase tracking-wide">{l}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      <div className="space-y-2">
                        {planMeals.map((m, i) => (
                          <div key={i} className="bg-white rounded-md p-2.5 border border-orange-100">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-medium text-gray-900">{m.name}</div>
                              {m.meal_type && <span className="text-[10px] text-orange-700 capitalize">{m.meal_type}</span>}
                            </div>
                            <div className="flex flex-wrap gap-x-3 text-xs text-gray-500 mt-0.5">
                              {m.calories != null && <span>{Math.round(m.calories)} kcal</span>}
                              {m.protein_g != null && <span>P {Math.round(m.protein_g)}g</span>}
                              {m.carbs_g != null && <span>C {Math.round(m.carbs_g)}g</span>}
                              {m.fat_g != null && <span>F {Math.round(m.fat_g)}g</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {event.notes && (() => {
                const { general, exercises } = parseExerciseNotes(event.notes);
                return (
                  <div className="mt-4 space-y-3">
                    {general && (
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="text-xs font-semibold text-gray-600 mb-1">Notes</div>
                        <div className="text-sm text-gray-900 whitespace-pre-wrap break-words">{general}</div>
                      </div>
                    )}
                    {exercises.length > 0 && (
                      <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                        <div className="text-xs font-semibold text-blue-700 mb-2">Exercises</div>
                        <div className="space-y-2">
                          {exercises.map((ex, i) => (
                            <div key={i} className="bg-white rounded-md p-2.5 border border-blue-100 flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-gray-900 break-words">{ex.name}</div>
                                {/* #321: was a non-wrapping `flex items-center gap-2` with no label
                                    on sets/reps — rest and load ran off the card at 375px, and a
                                    reps-only exercise rendered nothing (`sets && reps ? … : sets`). */}
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
                                  <ExternalLink size={14} />
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {!general && exercises.length === 0 && (
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="text-xs font-semibold text-gray-600 mb-1">Notes</div>
                        <div className="text-sm text-gray-900 whitespace-pre-wrap break-words">{event.notes}</div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* #277: RSVP. Renders itself as null unless this is a shared
                  team practice / game / lifting event (team_ids set,
                  player_id null). Players see Going / Not going / Maybe plus
                  the headcount; staff see the full roster split and the
                  Nudge non-responders button. */}
              {!event._isMealPlan && (
                <EventRsvpSection
                  event={event}
                  source="schedule_events"
                  userId={userId}
                  userRole={userRole}
                />
              )}

              <div className="flex space-x-3 pt-4 border-t border-gray-200">
                <button
                  onClick={onClose}
                  className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium hover:bg-gray-50 transition"
                >
                  Close
                </button>
                {!event._isMealPlan && canManage && (
                  <>
                    <button
                      onClick={() => setEditing(true)}
                      className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-blue-700 transition flex items-center justify-center space-x-2"
                    >
                      <Edit2 size={16} />
                      <span>Edit</span>
                    </button>
                    <button
                      onClick={() => {
                        console.log('DELETE BUTTON CLICKED!');
                        setConfirmDelete(true); // Show custom confirm modal
                      }}
                      disabled={deleting}
                      className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-red-700 transition disabled:opacity-50 flex items-center justify-center space-x-2"
                    >
                      <Trash2 size={16} />
                      <span>{deleting ? 'Deleting...' : 'Delete'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Custom Delete Confirmation Modal */}
        {confirmDelete && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 rounded-lg">
            {/* #347 QA: this confirmation has no scroll of its own, so a very
                long event title used to push its Cancel/Delete buttons off the
                bottom of the screen. Capped and scrollable, with the title
                clamped; Escape dismisses this layer too. */}
            <div className="bg-white rounded-lg p-6 max-w-sm mx-4 max-h-[90vh] overflow-y-auto">
              <h3 className="text-lg font-bold text-gray-900 mb-4">Confirm Delete</h3>
              <p className="text-gray-700 mb-6">
                Are you sure you want to delete this {event.event_type}?
                <br />
                {/* No `block` class here: Tailwind's .block beats .line-clamp-3's
                    display:-webkit-box (same specificity, later in the sheet),
                    which silently disabled the clamp and let a long title push
                    Cancel/Delete off the screen. The clamp supplies its own
                    block-level box, so mt-2 still applies. */}
                <span className="font-semibold mt-2 break-words line-clamp-3" title={event.title || event.opponent || undefined}>"{event.title || event.opponent}"</span>
              </p>
              <p className="text-sm text-red-600 mb-4">This action cannot be undone.</p>
              <div className="flex space-x-3">
                <button
                  onClick={() => {
                    console.log('❌ User cancelled delete via custom modal');
                    setConfirmDelete(false);
                  }}
                  className="flex-1 border border-gray-300 text-gray-700 py-2 px-4 rounded-lg font-medium hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    console.log('✅ User confirmed delete via custom modal');
                    setConfirmDelete(false);
                    handleDelete();
                  }}
                  className="flex-1 bg-red-600 text-white py-2 px-4 rounded-lg font-medium hover:bg-red-700 transition"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// FACILITY EVENT COLOR PALETTE
// ============================================

const FACILITY_EVENT_COLORS = [
  { key: 'teal',   label: 'Teal',   month: 'bg-teal-100 text-teal-700 border-teal-200',     week: 'border-l-4 border-teal-500 bg-teal-50',     lane: 'bg-teal-100 border border-teal-300 text-teal-900',     detail: 'bg-gradient-to-br from-teal-50 to-teal-100 border-2 border-teal-200',     dot: 'bg-teal-500' },
  { key: 'blue',   label: 'Blue',   month: 'bg-sky-100 text-sky-700 border-sky-200',        week: 'border-l-4 border-sky-500 bg-sky-50',       lane: 'bg-sky-100 border border-sky-300 text-sky-900',        detail: 'bg-gradient-to-br from-sky-50 to-sky-100 border-2 border-sky-200',        dot: 'bg-sky-500' },
  { key: 'purple', label: 'Purple', month: 'bg-purple-100 text-purple-700 border-purple-200', week: 'border-l-4 border-purple-500 bg-purple-50', lane: 'bg-purple-100 border border-purple-300 text-purple-900', detail: 'bg-gradient-to-br from-purple-50 to-purple-100 border-2 border-purple-200', dot: 'bg-purple-500' },
  { key: 'pink',   label: 'Pink',   month: 'bg-pink-100 text-pink-700 border-pink-200',     week: 'border-l-4 border-pink-500 bg-pink-50',     lane: 'bg-pink-100 border border-pink-300 text-pink-900',     detail: 'bg-gradient-to-br from-pink-50 to-pink-100 border-2 border-pink-200',     dot: 'bg-pink-500' },
  { key: 'red',    label: 'Red',    month: 'bg-red-100 text-red-700 border-red-200',        week: 'border-l-4 border-red-500 bg-red-50',       lane: 'bg-red-100 border border-red-300 text-red-900',        detail: 'bg-gradient-to-br from-red-50 to-red-100 border-2 border-red-200',        dot: 'bg-red-500' },
  { key: 'orange', label: 'Orange', month: 'bg-orange-100 text-orange-700 border-orange-200', week: 'border-l-4 border-orange-500 bg-orange-50', lane: 'bg-orange-100 border border-orange-300 text-orange-900', detail: 'bg-gradient-to-br from-orange-50 to-orange-100 border-2 border-orange-200', dot: 'bg-orange-500' },
  { key: 'yellow', label: 'Yellow', month: 'bg-yellow-100 text-yellow-700 border-yellow-200', week: 'border-l-4 border-yellow-500 bg-yellow-50', lane: 'bg-yellow-100 border border-yellow-300 text-yellow-900', detail: 'bg-gradient-to-br from-yellow-50 to-yellow-100 border-2 border-yellow-200', dot: 'bg-yellow-500' },
  { key: 'green',  label: 'Green',  month: 'bg-green-100 text-green-700 border-green-200',  week: 'border-l-4 border-green-500 bg-green-50',   lane: 'bg-green-100 border border-green-300 text-green-900',  detail: 'bg-gradient-to-br from-green-50 to-green-100 border-2 border-green-200',  dot: 'bg-green-500' },
  { key: 'gray',   label: 'Gray',   month: 'bg-gray-100 text-gray-700 border-gray-200',     week: 'border-l-4 border-gray-500 bg-gray-50',     lane: 'bg-gray-100 border border-gray-300 text-gray-900',     detail: 'bg-gradient-to-br from-gray-50 to-gray-100 border-2 border-gray-200',     dot: 'bg-gray-500' },
];

// Public booking types (#229). Each Type maps to a fixed event color; the color
// picker is hidden when creating a Public Booking. `value` is stored in
// facility_events.booking_type.
const PUBLIC_BOOKING_TYPES = [
  { value: 'Cage Rental', label: 'Cage Rental', color: 'teal' },
  { value: 'NBP+ Strength & Conditioning', label: 'NBP+ Strength & Conditioning', color: 'orange' },
  { value: 'NBP+ Hitting Session', label: 'NBP+ Hitting Session', color: 'blue' },
  { value: 'NBP+ Pitching/Throwing Session', label: 'NBP+ Pitching/Throwing Session', color: 'red' },
  { value: 'NBP+ Fielding Session', label: 'NBP+ Fielding Session', color: 'yellow' },
  { value: 'Camps', label: 'Camps', color: 'green' },
  { value: 'Assessment', label: 'Assessment', color: 'purple' },
  { value: 'Biomechanics Assessment', label: 'Biomechanics Assessment', color: 'pink' },
];
const bookingTypeColor = (t) => (PUBLIC_BOOKING_TYPES.find(x => x.value === t)?.color) || 'teal';

function getFacilityColorClasses(colorKey, variant = 'month') {
  const c = FACILITY_EVENT_COLORS.find(x => x.key === colorKey) || FACILITY_EVENT_COLORS[0];
  return c[variant];
}

const PLAYER_OVERLAY_PALETTE = [
  { month: 'bg-sky-100 text-sky-700 border-sky-300',        week: 'border-l-4 border-sky-500 bg-sky-50',       dot: 'bg-sky-500' },
  { month: 'bg-rose-100 text-rose-700 border-rose-300',     week: 'border-l-4 border-rose-500 bg-rose-50',     dot: 'bg-rose-500' },
  { month: 'bg-amber-100 text-amber-800 border-amber-300',  week: 'border-l-4 border-amber-500 bg-amber-50',   dot: 'bg-amber-500' },
  { month: 'bg-violet-100 text-violet-700 border-violet-300', week: 'border-l-4 border-violet-500 bg-violet-50', dot: 'bg-violet-500' },
  { month: 'bg-emerald-100 text-emerald-700 border-emerald-300', week: 'border-l-4 border-emerald-500 bg-emerald-50', dot: 'bg-emerald-500' },
  { month: 'bg-pink-100 text-pink-700 border-pink-300',     week: 'border-l-4 border-pink-500 bg-pink-50',     dot: 'bg-pink-500' },
  { month: 'bg-cyan-100 text-cyan-700 border-cyan-300',     week: 'border-l-4 border-cyan-500 bg-cyan-50',     dot: 'bg-cyan-500' },
  { month: 'bg-orange-100 text-orange-700 border-orange-300', week: 'border-l-4 border-orange-500 bg-orange-50', dot: 'bg-orange-500' },
];

// ============================================
// ADD FACILITY EVENT PANEL
// ============================================

function AddFacilityEventPanel({ date, onClose, onSuccess, mode = 'org' }) {
  const isPublicMode = mode === 'public';
  const LANE_OPTIONS = ['Lane 1', 'Lane 2', 'Lane 3', 'Lane 4', 'Lane 5', 'Lane 6', 'Lane 7', 'Turf Field', 'Main Weight Room', 'Top Weight Room', 'Speed & Agility'];

  const prefill = (() => {
    if (date && typeof date === 'object' && !(date instanceof Date)) {
      return { date: date.date, startTime: date.startTime, endTime: date.endTime, lane: date.lane };
    }
    if (date instanceof Date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return { date: `${y}-${m}-${d}` };
    }
    if (typeof date === 'string' && date !== 'new') return { date };
    return {};
  })();

  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState(prefill.date || fmtLocalDate(new Date()));
  const [startTime, setStartTime] = useState(prefill.startTime || '09:00');
  const [endTime, setEndTime] = useState(prefill.endTime || '10:00');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [lanes, setLanes] = useState(prefill.lane ? [prefill.lane] : []);
  const [recurrence, setRecurrence] = useState('none');
  const [customRule, setCustomRule] = useState({ freq: 'weekly', interval: 1, byDay: [], endType: 'never', count: 10, until: '' });
  const [color, setColor] = useState('teal');
  const [loading, setLoading] = useState(false);
  const [athleteId, setAthleteId] = useState('');
  const [coachIds, setCoachIds] = useState([]);
  const [teamIds, setTeamIds] = useState([]);
  const [athletes, setAthletes] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [teams, setTeams] = useState([]);
  // Public booking (#229): in public mode this event is exposed on /book, its
  // Type drives the color, and it carries a price + capacity.
  const [bookingType, setBookingType] = useState(PUBLIC_BOOKING_TYPES[0].value);
  const [publicPrice, setPublicPrice] = useState('');
  const [publicCapacity, setPublicCapacity] = useState(1);

  useEffect(() => {
    (async () => {
      const [aRes, cRes, tRes] = await Promise.all([
        // #437: paged — the athlete directory is within ~50 rows of the 1,000-row clamp.
        readAllPages(() => supabase.from('users').select('id, full_name').eq('role', 'player').order('full_name').order('id')),
        supabase.from('users').select('id, full_name').in('role', ['admin', 'coach']).order('full_name'),
        supabase.from('teams').select('id, name').order('name'),
      ]);
      if (aRes.error) console.error('AddFacilityEventPanel: athletes query failed:', aRes.error);
      if (cRes.error) console.error('AddFacilityEventPanel: coaches query failed:', cRes.error);
      if (tRes.error) console.error('AddFacilityEventPanel: teams query failed:', tRes.error);
      setAthletes(aRes.rows);
      setCoaches(cRes.data || []);
      setTeams(tRes.data || []);
    })();
  }, []);

  const handleSave = async () => {
    if (!title.trim()) return alert('Title is required');
    if (isPublicMode && !bookingType?.startsWith('NBP+') && !(parseFloat(publicPrice) > 0)) return alert('Enter a price for public booking');
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const isRecurring = recurrence !== 'none';
      let recurrenceRule = null;
      if (isRecurring) {
        if (recurrence === 'custom') {
          const r = { ...customRule };
          if (r.endType === 'never') { delete r.count; delete r.until; }
          else if (r.endType === 'count') { delete r.until; }
          else if (r.endType === 'until') { delete r.count; }
          recurrenceRule = r;
        } else {
          recurrenceRule = { freq: recurrence, interval: 1, endType: 'never' };
        }
      }
      const { error } = await supabase.from('facility_events').insert({
        title: title.trim(), description: description || null, event_date: eventDate,
        start_time: startTime || null, end_time: endTime || null, location: location || null,
        is_recurring: isRecurring, recurrence_rule: recurrenceRule, created_by: user?.id,
        lanes: lanes.length > 0 ? lanes : null,
        athlete_id: isPublicMode ? null : (athleteId || null),
        coach_id: coachIds[0] || null,
        coach_ids: coachIds.length > 0 ? coachIds : null,
        // Unlike coach_ids, this column is NOT NULL DEFAULT '{}' — send [] when
        // nothing is selected, never null (#287).
        team_ids: teamIds,
        color: isPublicMode ? bookingTypeColor(bookingType) : color,
        is_public: isPublicMode,
        booking_type: isPublicMode ? bookingType : null,
        public_price_cents: isPublicMode ? (parseFloat(publicPrice) >= 0 ? Math.round(parseFloat(publicPrice) * 100) : null) : null,
        public_capacity: isPublicMode ? (parseInt(publicCapacity) || 1) : 1,
      });
      if (error) throw error;
      onSuccess();
    } catch (err) {
      alert('Error creating event: ' + formatUserError(err));
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${isPublicMode ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
              {isPublicMode ? 'Public Booking' : 'Organization Event'}
            </span>
          </div>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add title" className="w-full text-2xl font-medium text-gray-900 placeholder-gray-400 border-0 border-b-2 border-gray-200 focus:border-teal-500 focus:outline-none pb-2 mb-6" autoFocus />
          <div className="flex items-center space-x-3 mb-4">
            <CalendarIcon size={20} className="text-gray-400" />
            <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
            <span className="text-gray-400">to</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          </div>
          <div className="flex items-center space-x-3 mb-4">
            <Repeat size={20} className="text-gray-400" />
            <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="custom">Custom...</option>
            </select>
          </div>
          {recurrence === 'custom' && (
            <div className="ml-8 mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
              <div className="flex items-center space-x-3">
                <span className="text-sm text-gray-700">Every</span>
                <input type="number" min="1" value={customRule.interval} onChange={(e) => setCustomRule({...customRule, interval: parseInt(e.target.value) || 1})} className="w-16 px-2 py-1 border border-gray-300 rounded text-sm" />
                <select value={customRule.freq} onChange={(e) => setCustomRule({...customRule, freq: e.target.value})} className="px-2 py-1 border border-gray-300 rounded text-sm">
                  <option value="daily">day(s)</option><option value="weekly">week(s)</option><option value="monthly">month(s)</option><option value="yearly">year(s)</option>
                </select>
              </div>
              {customRule.freq === 'weekly' && (
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-700">On:</span>
                  {['SU','MO','TU','WE','TH','FR','SA'].map(day => (
                    <button key={day} type="button" onClick={() => { const days = customRule.byDay || []; setCustomRule({...customRule, byDay: days.includes(day) ? days.filter(d => d !== day) : [...days, day]}); }}
                      className={`w-8 h-8 rounded-full text-xs font-medium ${(customRule.byDay || []).includes(day) ? 'bg-teal-600 text-white' : 'bg-gray-200 text-gray-600'}`}>{day.charAt(0)}</button>
                  ))}
                </div>
              )}
              <div className="flex items-center space-x-3">
                <span className="text-sm text-gray-700">Ends:</span>
                <select value={customRule.endType} onChange={(e) => setCustomRule({...customRule, endType: e.target.value})} className="px-2 py-1 border border-gray-300 rounded text-sm">
                  <option value="never">Never</option><option value="count">After</option><option value="until">On date</option>
                </select>
                {customRule.endType === 'count' && <><input type="number" min="1" value={customRule.count} onChange={(e) => setCustomRule({...customRule, count: parseInt(e.target.value) || 1})} className="w-16 px-2 py-1 border border-gray-300 rounded text-sm" /><span className="text-sm text-gray-700">occurrences</span></>}
                {customRule.endType === 'until' && <input type="date" value={customRule.until} onChange={(e) => setCustomRule({...customRule, until: e.target.value})} className="px-2 py-1 border border-gray-300 rounded text-sm" />}
              </div>
            </div>
          )}
          <div className="flex items-center space-x-3 mb-4">
            <MapPin size={20} className="text-gray-400" />
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          </div>
          <div className="flex items-start space-x-3 mb-4">
            <AlignLeft size={20} className="text-gray-400 mt-2" />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add description" rows="3" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          </div>
          {!isPublicMode && (
            <div className="flex items-center space-x-3 mb-4">
              <User size={20} className="text-gray-400 flex-shrink-0" />
              <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
                <option value="">Athlete (optional)</option>
                {athletes.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
              </select>
            </div>
          )}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Coaches</label>
            <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
              {coaches.map(c => (
                <label key={c.id} className="flex items-center space-x-2 text-sm py-0.5">
                  <input type="checkbox" checked={coachIds.includes(c.id)} onChange={(e) => {
                    setCoachIds(e.target.checked ? [...coachIds, c.id] : coachIds.filter(id => id !== c.id));
                  }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                  <span className="text-gray-700 truncate">{c.full_name}</span>
                </label>
              ))}
            </div>
          </div>
          {/* #287: multi-select is required, not optional — one facility event
              routinely belongs to several teams (an age band spans two ages,
              each with a League and a Tournament team). */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Teams</label>
            <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
              {teams.map(t => (
                <label key={t.id} className="flex items-center space-x-2 text-sm py-0.5">
                  <input type="checkbox" checked={teamIds.includes(t.id)} onChange={(e) => {
                    setTeamIds(e.target.checked ? [...teamIds, t.id] : teamIds.filter(id => id !== t.id));
                  }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                  <span className="text-gray-700 truncate">{t.name}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">Assigned teams see this event on their team schedule.</p>
          </div>
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">Reserved Lanes</label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {LANE_OPTIONS.map(lane => (
                <label key={lane} className="flex items-center space-x-2 text-sm">
                  <input type="checkbox" checked={lanes.includes(lane)} onChange={(e) => {
                    setLanes(e.target.checked ? [...lanes, lane] : lanes.filter(l => l !== lane));
                  }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                  <span className="text-gray-700">{lane}</span>
                </label>
              ))}
            </div>
          </div>
          {!isPublicMode && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Event Color</label>
              <div className="flex flex-wrap gap-2">
                {FACILITY_EVENT_COLORS.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key)}
                    title={c.label}
                    className={`w-8 h-8 rounded-full ${c.dot} ${color === c.key ? 'ring-2 ring-offset-2 ring-gray-800' : ''}`}
                  />
                ))}
              </div>
            </div>
          )}
          {isPublicMode && (
            <div className="mb-6 border border-gray-200 rounded-lg p-3 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select value={bookingType} onChange={(e) => setBookingType(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
                  {PUBLIC_BOOKING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div className="flex items-center space-x-2 mt-1.5">
                  <span className={`w-3.5 h-3.5 rounded-full ${(FACILITY_EVENT_COLORS.find(c => c.key === bookingTypeColor(bookingType)) || FACILITY_EVENT_COLORS[0]).dot}`} />
                  <span className="text-xs text-gray-400">Type sets the event color</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Price (USD)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" min="0" step="0.01" value={publicPrice} onChange={(e) => setPublicPrice(e.target.value)} placeholder="0.00" className="w-full pl-6 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
                  <input type="number" min="1" value={publicCapacity} onChange={(e) => setPublicCapacity(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
              </div>
              <p className="text-xs text-gray-400">Outside customers can book & pay for this on the public /book page. Each occurrence of a recurring event is separately bookable.</p>
            </div>
          )}
          <div className="flex justify-end space-x-3">
            <button onClick={onClose} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition text-sm font-medium">Cancel</button>
            <button onClick={handleSave} disabled={loading} className="px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition text-sm font-medium disabled:opacity-50">{loading ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// FACILITY EVENT DETAIL
// ============================================

// #310: Postgres 42703 ("column does not exist") — what a write against
// athlete_ids looks like before its migration has been run. Detected
// specifically so that case gets an actionable message instead of falling
// through to formatUserError's generic fallback.
function isMissingColumnError(err, column) {
  if (!err) return false;
  if (err.code === '42703') return true;
  const msg = err.message || err.error_description || '';
  return new RegExp(`column .*${column}.* does not exist`, 'i').test(msg);
}

function FacilityEventDetail({ event, userId, userRole, onClose, onUpdate, onDelete, coaches = [] }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ title: event.title, description: event.description || '', event_date: event.event_date || '', start_time: event.start_time || '', end_time: event.end_time || '', location: event.location || '', color: event.color || 'teal', is_public: !!event.is_public, booking_type: event.booking_type || PUBLIC_BOOKING_TYPES[0].value, public_price: event.public_price_cents != null ? (event.public_price_cents / 100).toFixed(2) : '', public_capacity: event.public_capacity || 1 });

  const isStaff = userRole === 'admin' || userRole === 'coach';
  const isPlayer = userRole === 'player';
  const eventMasterId = event._master_id || event.id;
  const occurrenceDate = event.event_date;

  // #347: the SERIES row this popup is showing an occurrence of, and the
  // series date that occurrence stands for. eventMasterId above resolves to
  // the child's own id for an already-modified occurrence — right for editing
  // that one row, wrong for anything series-wide — so Save/Delete use these.
  const seriesMasterId = event._master_id || event.recurrence_parent_id || event.id;
  const seriesDate = event.original_date || event.event_date;
  const isRecurringOccurrence = !!(event._is_virtual || event.is_recurring || event.recurrence_parent_id);

  // #287: team assignment. Teams are readable by every authenticated role
  // (same query the Team calendar's fetchTeams uses), so names resolve for
  // players viewing the modal too.
  const [teams, setTeams] = useState([]);
  const [editingTeams, setEditingTeams] = useState(false);
  const [teamDraft, setTeamDraft] = useState(event.team_ids || []);
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamRecurrencePrompt, setTeamRecurrencePrompt] = useState(false);

  // #320: coach(es) and athlete reassignment on an existing event, same
  // pattern as team assignment above. Athletes aren't passed in as a prop
  // (unlike `coaches`, which the parent already fetches org-wide) — the
  // top-level `players` state in Schedule.js is coach-team-scoped, which
  // would wrongly hide athletes outside a coach's own teams, so this fetches
  // its own org-wide list, same query AddFacilityEventPanel uses.
  const [athletes, setAthletes] = useState([]);
  const [editingCoach, setEditingCoach] = useState(false);
  const [coachDraft, setCoachDraft] = useState(event.coach_ids || (event.coach_id ? [event.coach_id] : []));
  const [coachSaving, setCoachSaving] = useState(false);
  const [coachRecurrencePrompt, setCoachRecurrencePrompt] = useState(false);
  const [editingAthlete, setEditingAthlete] = useState(false);
  const [athleteDraft, setAthleteDraft] = useState(event.athlete_id || '');
  const [athleteSaving, setAthleteSaving] = useState(false);
  const [athleteRecurrencePrompt, setAthleteRecurrencePrompt] = useState(false);

  // #310: MULTIPLE players on this event (athlete_ids, uuid[]) — additive
  // to the single athlete_id field above, which is untouched and keeps
  // working exactly as it does today. Reuses the `athletes` list already
  // fetched above for the single-select dropdown.
  const [editingPlayers, setEditingPlayers] = useState(false);
  const [playersDraft, setPlayersDraft] = useState(event.athlete_ids || []);
  const [playersSaving, setPlayersSaving] = useState(false);
  const [playersRecurrencePrompt, setPlayersRecurrencePrompt] = useState(false);
  const [showCreatePlayer, setShowCreatePlayer] = useState(false);

  // #313: remove a single lane from a multi-lane event, leaving the rest of
  // the event intact. laneRecurrencePrompt holds the lane code pending a
  // one-vs-series choice (null = no prompt open).
  const [laneDeleting, setLaneDeleting] = useState(false);
  const [laneRecurrencePrompt, setLaneRecurrencePrompt] = useState(null);

  // #347: one-vs-series prompts for the popup's own Save and Delete buttons.
  // Every other write in this component already had one; these two did not,
  // and quietly rewrote/destroyed the whole series instead.
  const [savePrompt, setSavePrompt] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  // #347: the assigned-players roster overlay (Cordell's request).
  const [showPlayerList, setShowPlayerList] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: teamData, error: teamError } = await supabase.from('teams').select('id, name').order('name');
      if (teamError) console.error('FacilityEventDetail: teams query failed:', teamError);
      setTeams(teamData || []);
      // #347: the athlete directory is ~950 rows and is only ever used by the
      // staff-only assign/edit pickers and the assigned-players list. A player
      // opening any facility event used to download the whole thing.
      if (!isStaff) return;
      // #437: paged past the 1,000-row clamp.
      const { rows: athleteData, error: athleteError } = await readAllPages(() =>
        supabase.from('users').select('id, full_name').eq('role', 'player').order('full_name').order('id'));
      if (athleteError) console.error('FacilityEventDetail: athletes query failed:', athleteError);
      setAthletes(athleteData);
    })();
  }, [isStaff]);

  // #347: full_name ONLY. Do not join player_profiles or select email / phone /
  // date_of_birth / parent fields here — that exposure must not be widened.
  const assignedPlayerNames = useMemo(
    () => (event.athlete_ids || [])
      .map(id => athletes.find(a => a.id === id)?.full_name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    [event.athlete_ids, athletes],
  );

  const applyTeamAssignment = async (choice) => {
    setTeamRecurrencePrompt(false);
    setTeamSaving(true);
    try {
      if (choice === 'one') {
        // Single occurrence of a recurring series: write/update a per-occurrence
        // exception row, same find-or-create the #285 lane-move uses. is_exception
        // MUST be false — true means hidden/cancelled (scheduleUtils line 91), and
        // would make this occurrence vanish instead of getting a team.
        // #347: find-or-create and the field list are now shared
        // (scheduleUtils.upsertFacilityException); the list this used to spell
        // out dropped is_public / public_price_cents / public_capacity /
        // booking_type / is_non_team_activity / created_by every time.
        const error = await upsertFacilityException(supabase, event, eventMasterId, occurrenceDate, { team_ids: teamDraft });
        if (error) throw error;
      } else {
        // 'all' — and the plain non-recurring case. Children (per-occurrence
        // exception rows) are updated too so an already-modified occurrence
        // follows the series; on a non-recurring event that update matches
        // nothing and is a no-op.
        const { error } = await supabase.from('facility_events').update({ team_ids: teamDraft }).eq('id', eventMasterId);
        if (error) throw error;
        const { error: childError } = await supabase.from('facility_events').update({ team_ids: teamDraft }).eq('recurrence_parent_id', eventMasterId);
        if (childError) throw childError;
      }
      onUpdate();
    } catch (err) {
      alert('Error assigning teams: ' + formatUserError(err));
    } finally {
      setTeamSaving(false);
    }
  };

  const handleTeamSave = () => {
    if (event.is_recurring) { setTeamRecurrencePrompt(true); return; }
    applyTeamAssignment('all');
  };

  // #320: same one-occurrence-vs-series find-or-create as applyTeamAssignment
  // above — reused, not reinvented, per the #279/#287 exception model.
  const applyCoachAssignment = async (choice) => {
    setCoachRecurrencePrompt(false);
    setCoachSaving(true);
    const patch = { coach_ids: coachDraft.length > 0 ? coachDraft : null, coach_id: coachDraft[0] || null };
    try {
      if (choice === 'one') {
        // #347: shared find-or-create + full-row copy — see applyTeamAssignment.
        const error = await upsertFacilityException(supabase, event, eventMasterId, occurrenceDate, patch);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('facility_events').update(patch).eq('id', eventMasterId);
        if (error) throw error;
        const { error: childError } = await supabase.from('facility_events').update(patch).eq('recurrence_parent_id', eventMasterId);
        if (childError) throw childError;
      }
      onUpdate();
    } catch (err) {
      alert('Error assigning coach(es): ' + formatUserError(err));
    } finally {
      setCoachSaving(false);
    }
  };

  const handleCoachSave = () => {
    if (event.is_recurring) { setCoachRecurrencePrompt(true); return; }
    applyCoachAssignment('all');
  };

  const applyAthleteAssignment = async (choice) => {
    setAthleteRecurrencePrompt(false);
    setAthleteSaving(true);
    const patch = { athlete_id: athleteDraft || null };
    try {
      if (choice === 'one') {
        // #347: shared find-or-create + full-row copy — see applyTeamAssignment.
        const error = await upsertFacilityException(supabase, event, eventMasterId, occurrenceDate, patch);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('facility_events').update(patch).eq('id', eventMasterId);
        if (error) throw error;
        const { error: childError } = await supabase.from('facility_events').update(patch).eq('recurrence_parent_id', eventMasterId);
        if (childError) throw childError;
      }
      onUpdate();
    } catch (err) {
      alert('Error assigning athlete: ' + formatUserError(err));
    } finally {
      setAthleteSaving(false);
    }
  };

  const handleAthleteSave = () => {
    if (event.is_recurring) { setAthleteRecurrencePrompt(true); return; }
    applyAthleteAssignment('all');
  };

  // #310: same one-occurrence-vs-series find-or-create as team/coach/athlete
  // above — reused, not reinvented, per the #279/#287 exception model.
  // athlete_id is kept in sync with athlete_ids[0], the same way
  // applyCoachAssignment above keeps coach_id in sync with coach_ids[0].
  const applyPlayersAssignment = async (choice) => {
    setPlayersRecurrencePrompt(false);
    setPlayersSaving(true);
    const patch = { athlete_ids: playersDraft, athlete_id: playersDraft[0] || null };
    try {
      if (choice === 'one') {
        // #347: shared find-or-create + full-row copy — see applyTeamAssignment.
        const error = await upsertFacilityException(supabase, event, eventMasterId, occurrenceDate, patch);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('facility_events').update(patch).eq('id', eventMasterId);
        if (error) throw error;
        const { error: childError } = await supabase.from('facility_events').update(patch).eq('recurrence_parent_id', eventMasterId);
        if (childError) throw childError;
      }
      onUpdate();
    } catch (err) {
      // #310: athlete_ids doesn't exist until the pending migration
      // (20260812_facility_events_athlete_ids.sql) is run — degrade to a
      // clear, specific message instead of a generic error or a crash.
      if (isMissingColumnError(err, 'athlete_ids')) {
        alert('Adding multiple players needs a database update that has not been applied yet. Ask an admin to run the pending migration, then try again.');
      } else {
        alert('Error adding players: ' + formatUserError(err));
      }
    } finally {
      setPlayersSaving(false);
    }
  };

  const handlePlayersSave = () => {
    if (event.is_recurring) { setPlayersRecurrencePrompt(true); return; }
    applyPlayersAssignment('all');
  };

  // #313: remove one lane from event.lanes, leaving the rest of the event
  // (and any other assigned lanes) intact. This is an edit to the `lanes`
  // field, not a deletion, so it follows #287's one-vs-whole-series
  // exception pattern above (team/coach/athlete) rather than #279's
  // delete-the-occurrence path. "This and future" is deliberately absent —
  // same reasoning as team/coach/athlete above: splitting the series into
  // two masters is a separate, bigger piece of work than removing a lane.
  const applyLaneDelete = async (choice, lane) => {
    setLaneRecurrencePrompt(null);
    setLaneDeleting(true);
    try {
      if (choice === 'one') {
        // #347: shared find-or-create + full-row copy — see applyTeamAssignment.
        // Unlike the other five callers the patch depends on the row being
        // written: an existing child keeps its OWN lanes minus this one (it may
        // have been moved to different lanes by #289), a new child starts from
        // the master's.
        const { data: existingException, error: findError } = await supabase
          .from('facility_events')
          .select('id, lanes')
          .eq('recurrence_parent_id', eventMasterId)
          .eq('original_date', occurrenceDate)
          .maybeSingle();
        if (findError) throw findError;
        const baseLanes = existingException ? (existingException.lanes || []) : (event.lanes || []);
        const error = await upsertFacilityException(supabase, event, eventMasterId, occurrenceDate, { lanes: baseLanes.filter(l => l !== lane) });
        if (error) throw error;
      } else {
        // 'all' — and the plain non-recurring case. Unlike team/coach/athlete
        // above, which blindly overwrite every child with the same new
        // value, this FILTERS each row's own lanes rather than replacing
        // them: a child occurrence independently moved to different lanes
        // (#289) keeps its own lanes minus this one, instead of being reset
        // back to whatever the master's set is.
        const { error } = await supabase.from('facility_events').update({ lanes: (event.lanes || []).filter(l => l !== lane) }).eq('id', eventMasterId);
        if (error) throw error;
        const { data: children, error: childFetchError } = await supabase.from('facility_events').select('id, lanes').eq('recurrence_parent_id', eventMasterId);
        if (childFetchError) throw childFetchError;
        for (const child of children || []) {
          if ((child.lanes || []).includes(lane)) {
            const { error: childError } = await supabase.from('facility_events').update({ lanes: (child.lanes || []).filter(l => l !== lane) }).eq('id', child.id);
            if (childError) throw childError;
          }
        }
      }
      onUpdate();
    } catch (err) {
      alert('Error removing lane: ' + formatUserError(err));
    } finally {
      setLaneDeleting(false);
    }
  };

  const handleLaneDelete = (lane) => {
    if ((event.lanes || []).length <= 1) {
      // Least-surprising choice (#313): refuse rather than silently deleting
      // the whole event out from under someone who only meant to remove one
      // lane. The explicit Delete action (context menu) already covers
      // removing the event entirely.
      alert('This is the last lane on this event. To remove the event entirely, use Delete instead.');
      return;
    }
    if (event.is_recurring) { setLaneRecurrencePrompt(lane); return; }
    applyLaneDelete('all', lane);
  };

  // Sign-ups lock 12h before the event starts (mirrors the #233 cancel cutoff).
  const SIGNUP_CUTOFF_MS = 12 * 60 * 60 * 1000;
  const eventStartAt = new Date(`${occurrenceDate}T${(event.start_time || '00:00').slice(0, 5)}:00`);
  const signupsClosed = Date.now() > eventStartAt.getTime() - SIGNUP_CUTOFF_MS;

  // Public guest bookings (#229) for this specific occurrence.
  const [guestBookings, setGuestBookings] = useState([]);
  const [refundingId, setRefundingId] = useState(null);

  const fetchGuestBookings = async () => {
    if (!isStaff || !event.is_public) return;
    const { data } = await supabase
      .from('public_bookings')
      .select('id, guest_name, guest_email, guest_phone, notes, status, amount_cents, created_at')
      .eq('source_type', 'facility_event')
      .eq('source_id', eventMasterId)
      .eq('occurrence_date', occurrenceDate)
      .in('status', ['pending_payment', 'confirmed'])
      .order('created_at', { ascending: true });
    setGuestBookings(data || []);
  };

  const handleRefund = async (bookingId) => {
    if (!window.confirm('Cancel this booking and refund the customer?')) return;
    setRefundingId(bookingId);
    try {
      const { data, error } = await supabase.functions.invoke('public-booking-refund', { body: { booking_id: bookingId } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await fetchGuestBookings();
    } catch (err) {
      alert('Refund failed: ' + formatUserError(err));
    } finally {
      setRefundingId(null);
    }
  };

  const [signups, setSignups] = useState([]);
  const [mySignup, setMySignup] = useState(null);
  const [mySignupIds, setMySignupIds] = useState([]);
  const [signupNotes, setSignupNotes] = useState('');
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupsLoading, setSignupsLoading] = useState(true);

  // #347 follow-up: sign-ups must be keyed on the SERIES and the series date,
  // not on whichever facility_events row happens to render this date.
  // eventMasterId is the master id on a normal (virtual) occurrence but the
  // CHILD row's own id once that date has been individually edited, so athletes
  // who signed up before a coach edited that date were keyed to the master and
  // then silently vanished from the roster after the edit. seriesMasterId +
  // seriesDate is the one key every occurrence of a series agrees on, whether
  // or not that date has been edited, so that is what new sign-ups are written
  // against below.
  //
  // Reads still have to find the rows written under the old key. There are
  // exactly two shapes in the table:
  //   (master id, series date)      — a normal/virtual occurrence. Also the new key.
  //   (this child row's id, any date) — written while this date was an edited
  //       child row. Its event_date is whatever the child's date was at the
  //       time, which is NOT the series date if the date itself had been moved,
  //       and could be an older date still if it was moved more than once — so
  //       the child id is matched on any date rather than on a guessed one.
  // The child row for THIS date is `event.id`: expandRecurringEvents renders
  // the child in place of the virtual occurrence, so a date has at most one
  // child and it is the row this popup was opened on. That is why no lookup of
  // the series' other children is needed here, and why sign-ups belonging to a
  // DIFFERENT date of the same series can never leak into this roster.
  const ownChildRowId = (!event._is_virtual && event.recurrence_parent_id) ? event.id : null;
  const signupEventIds = [...new Set([seriesMasterId, ownChildRowId].filter(Boolean))];
  const signupEventIdsKey = signupEventIds.join(',');
  const signupMatchesOccurrence = (row) => (
    row.event_id === seriesMasterId
      ? row.event_date === seriesDate
      : row.event_id === ownChildRowId
  );

  const fetchSignups = async () => {
    setSignupsLoading(true);
    // One query for both roles; players are narrowed to their own row by RLS
    // and by the user_id filter, staff get the whole roster. Keeping it to one
    // shape is what makes the roster, the count beside it and the athlete's own
    // "You're signed up" impossible to disagree with.
    let query = supabase
      .from('event_signups')
      .select(isStaff
        ? 'id, notes, created_at, user_id, event_id, event_date, users:user_id(id, full_name, avatar_url)'
        : 'id, notes, created_at, user_id, event_id, event_date')
      .order('created_at', { ascending: true });
    // QA: the master branch MUST be bounded to this date in the QUERY, not just
    // filtered afterwards. Asking for every sign-up in the series pulls back a
    // year of rows to render one popup, and once a series passes PostgREST's
    // row cap the rows that get cut are the current ones — the roster then
    // reads "No sign ups yet" while athletes really are signed up. That is the
    // exact bug this change exists to fix, re-armed at scale.
    if (ownChildRowId) {
      query = query.or(
        `and(event_id.eq.${seriesMasterId},event_date.eq.${seriesDate}),event_id.eq.${ownChildRowId}`
      );
    } else {
      query = query.eq('event_id', seriesMasterId).eq('event_date', seriesDate);
    }
    if (!isStaff) query = query.eq('user_id', userId);
    const { data, error } = await query;
    const rows = error ? [] : (data || []).filter(signupMatchesOccurrence);
    // An athlete can hold both an old child-keyed row and a new master-keyed
    // one (the unique index is per event_id, so nothing stopped that). That is
    // one person signed up, not two — dedupe by athlete so the list and the
    // number next to it stay honest.
    const byUser = new Map();
    rows.forEach(r => { if (!byUser.has(r.user_id)) byUser.set(r.user_id, r); });
    // On a read error leave the previous roster alone rather than blanking it
    // to a confident "No sign ups yet" that isn't true.
    if (isStaff && !error) setSignups([...byUser.values()]);
    const mine = rows.filter(r => r.user_id === userId);
    setMySignup(mine[0] || null);
    setMySignupIds(mine.map(r => r.id));
    setSignupsLoading(false);
  };

  useEffect(() => {
    fetchSignups();
    fetchGuestBookings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signupEventIdsKey, seriesDate, eventMasterId, occurrenceDate]);

  const handleSignup = async () => {
    if (signupsClosed) { alert('Sign-ups are closed — they close 12 hours before the event starts.'); return; }
    setSignupLoading(true);
    try {
      const { error } = await supabase.from('event_signups').insert({
        // The stable key: the series row and the date of the series this
        // occurrence stands for. Editing this date later cannot move it.
        event_id: seriesMasterId,
        event_date: seriesDate,
        user_id: userId,
        notes: signupNotes.trim() || null,
      });
      // 23505 = the athlete already has a row under this exact key (a stale
      // popup, or a double click). Nothing is wrong and nothing is lost, so
      // say so plainly and refresh rather than showing a database error.
      if (error && error.code === '23505') {
        await fetchSignups();
        alert("You're already signed up for this event.");
        return;
      }
      if (error) throw error;
      setSignupNotes('');
      await fetchSignups();
    } catch (err) {
      alert('Error signing up: ' + formatUserError(err));
    } finally {
      setSignupLoading(false);
    }
  };

  const handleCancelSignup = async () => {
    if (signupsClosed) { alert('Sign-ups are locked within 12 hours of the event and can no longer be changed.'); return; }
    // Cancels every row this athlete holds for this occurrence, not just one.
    // An athlete carrying both an old child-keyed row and a new master-keyed
    // one would otherwise still read as signed up after cancelling.
    const ids = mySignupIds.length > 0 ? mySignupIds : (mySignup ? [mySignup.id] : []);
    if (ids.length === 0) return;
    if (!window.confirm('Cancel your sign up for this event?')) return;
    setSignupLoading(true);
    try {
      const { error } = await supabase.from('event_signups').delete().in('id', ids);
      if (error) throw error;
      await fetchSignups();
    } catch (err) {
      alert('Error: ' + formatUserError(err));
    } finally {
      setSignupLoading(false);
    }
  };

  // #347: this update used to run `.eq('id', eventMasterId)` unconditionally.
  // On a recurring event eventMasterId is the SERIES row, so changing the time
  // on one Tuesday silently moved every Tuesday, with no warning. It now goes
  // through the same one-vs-series prompt every other write in this component
  // already had.
  const applySave = async (choice) => {
    setSavePrompt(false);
    setLoading(true);
    try {
      const patch = {
        title: formData.title, description: formData.description || null,
        event_date: formData.event_date || null,
        start_time: formData.start_time || null, end_time: formData.end_time || null,
        location: formData.location || null,
        color: formData.is_public ? bookingTypeColor(formData.booking_type) : (formData.color || null),
        is_public: formData.is_public,
        booking_type: formData.is_public ? formData.booking_type : null,
        public_price_cents: formData.is_public ? Math.round(parseFloat(formData.public_price) * 100) : null,
        public_capacity: formData.is_public ? (parseInt(formData.public_capacity) || 1) : 1,
      };
      if (choice === 'one') {
        const error = await upsertFacilityException(supabase, event, seriesMasterId, seriesDate, patch);
        if (error) throw error;
      } else {
        // #347: the form was seeded with THIS occurrence's date. Writing it
        // back to the master unchanged would drag the series' start date onto
        // the occurrence the user happened to open, shifting every date in the
        // series — so only send event_date when it was actually edited.
        if (isRecurringOccurrence && formData.event_date === (event.event_date || '')) delete patch.event_date;
        const { error } = await supabase.from('facility_events').update(patch).eq('id', seriesMasterId);
        if (error) throw error;
      }
      onUpdate();
    } catch (err) { alert('Error: ' + formatUserError(err)); } finally { setLoading(false); }
  };

  const handleSave = () => {
    if (formData.is_public && !formData.booking_type?.startsWith('NBP+') && !(parseFloat(formData.public_price) > 0)) return alert('Enter a price for public booking');
    if (isRecurringOccurrence) { setSavePrompt(true); return; }
    applySave('all');
  };

  // #347: this was `.delete().eq('id', eventMasterId)` for every event, and on
  // a recurring occurrence eventMasterId is the SERIES row. Because
  // facility_events_recurrence_parent_id_fkey and event_signups_event_id_fkey
  // are both ON DELETE CASCADE, deleting one Tuesday destroyed every
  // occurrence, every per-occurrence edit and every athlete sign-up. This is
  // the only Delete affordance Lanes view has, so it has to offer the same
  // this-one / this-and-future / all choice the Month/Week right-click does.
  const applyDelete = async (choice) => {
    setDeletePrompt(false);
    try {
      let error;
      if (choice === 'one') {
        error = await deleteFacilityOccurrence(supabase, event, seriesMasterId, seriesDate);
      } else if (choice === 'future') {
        // #347 QA: picked on the series' FIRST date, "this and future" leaves
        // nothing behind — it is a whole-series delete. deleteFacilityFuture
        // will not escalate without this confirm, and hands back
        // DELETE_CANCELLED (not an error) if the user backs out.
        const result = await deleteFacilityFuture(
          supabase, seriesMasterId, seriesDate,
          (master) => confirmWholeFacilitySeriesDelete(seriesMasterId, master, WHOLE_SERIES_FROM_FUTURE_LEAD),
        );
        if (result === DELETE_CANCELLED) return;
        error = result;
      } else {
        if (!(await confirmWholeFacilitySeriesDelete(seriesMasterId, null, WHOLE_SERIES_LEAD))) return;
        error = await deleteFacilitySeries(supabase, seriesMasterId);
      }
      if (error) throw error;
      onDelete();
    } catch (err) { alert('Error: ' + formatUserError(err)); }
  };

  const handleDelete = () => {
    if (isRecurringOccurrence) { setDeletePrompt(true); return; }
    if (!window.confirm('Delete this event?')) return;
    (async () => {
      try {
        const { error } = await supabase.from('facility_events').delete().eq('id', eventMasterId);
        if (error) throw error;
        onDelete();
      } catch (err) { alert('Error: ' + formatUserError(err)); }
    })();
  };

  const headerColorKey = (editing ? formData.color : event.color) || 'teal';
  const headerPalette = FACILITY_EVENT_COLORS.find(c => c.key === headerColorKey) || FACILITY_EVENT_COLORS[0];
  const headerBg = headerPalette.detail;

  // #347: the popup had no way out. It is `fixed`, so the page behind it can't
  // scroll, and with a long roster the header X went off the top of the screen
  // while Close/Edit/Delete went off the bottom — a reload was the only escape.
  // Escape and a backdrop click now close it; both confirm first if there are
  // unsaved edits in the form.
  const anyNestedModalOpen = teamRecurrencePrompt || coachRecurrencePrompt || athleteRecurrencePrompt
    || playersRecurrencePrompt || !!laneRecurrencePrompt || showCreatePlayer
    || savePrompt || deletePrompt || showPlayerList;

  const requestClose = () => {
    if (editing && !window.confirm('Discard your unsaved changes to this event?')) return;
    onClose();
  };

  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      // Let whatever is stacked on top own the key press.
      if (anyNestedModalOpen) return;
      if (editing && !window.confirm('Discard your unsaved changes to this event?')) return;
      onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [anyNestedModalOpen, editing, onClose]);

  // #347: Escape for the assigned-players overlay stacked on top.
  useEffect(() => {
    if (!showPlayerList) return undefined;
    const onEsc = (e) => { if (e.key === 'Escape') setShowPlayerList(false); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [showPlayerList]);

  // Only close on a backdrop click whose gesture also STARTED on the backdrop,
  // so dragging a text selection out of the card doesn't dismiss it.
  const backdropMouseDown = useRef(false);

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current) requestClose(); }}
    >
      {/* #347 QA: overflow-hidden keeps the card's own box honest, and the title
          is clamped to two lines (full text on hover). Without both, a long
          title grew the header past the card and pushed Close/Edit/Delete off
          the bottom of the screen — the bug the height cap was added to fix. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className={`${headerBg} p-6 rounded-t-lg flex-shrink-0`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start space-x-3 min-w-0">
              <span className={`w-3 h-3 rounded-full ${headerPalette.dot} mt-1.5 flex-shrink-0`} />
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-700 mb-1">Facility Event</div>
                <h3 className="text-xl font-bold text-gray-900 line-clamp-2 break-words" title={event.title}>{event.title}</h3>
              </div>
            </div>
            <button onClick={requestClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
          </div>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {editing ? (
            <div className="space-y-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Title</label><input type="text" value={formData.title} onChange={(e) => setFormData({...formData, title: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Date</label><input type="date" value={formData.event_date} onChange={(e) => setFormData({...formData, event_date: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label><input type="time" value={formData.start_time} onChange={(e) => setFormData({...formData, start_time: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">End Time</label><input type="time" value={formData.end_time} onChange={(e) => setFormData({...formData, end_time: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
              </div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Location</label><input type="text" value={formData.location} onChange={(e) => setFormData({...formData, location: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Description</label><textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} rows="3" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
              <div className="flex items-center space-x-2">
                <input id="isPublicEdit" type="checkbox" checked={formData.is_public} onChange={(e) => setFormData({ ...formData, is_public: e.target.checked })} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                <label htmlFor="isPublicEdit" className="text-sm font-medium text-gray-700">Open for public booking</label>
              </div>
              {!formData.is_public && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                  <div className="flex flex-wrap gap-2">
                    {FACILITY_EVENT_COLORS.map(c => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setFormData({ ...formData, color: c.key })}
                        title={c.label}
                        className={`w-8 h-8 rounded-full ${c.dot} ${formData.color === c.key ? 'ring-2 ring-offset-2 ring-gray-800' : ''}`}
                      />
                    ))}
                  </div>
                </div>
              )}
              {formData.is_public && (
                <div className="border border-gray-200 rounded-lg p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Public Booking</div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                    <select value={formData.booking_type} onChange={(e) => setFormData({ ...formData, booking_type: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
                      {PUBLIC_BOOKING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <div className="flex items-center space-x-2 mt-1.5">
                      <span className={`w-3.5 h-3.5 rounded-full ${(FACILITY_EVENT_COLORS.find(c => c.key === bookingTypeColor(formData.booking_type)) || FACILITY_EVENT_COLORS[0]).dot}`} />
                      <span className="text-xs text-gray-400">Type sets the event color</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Price (USD)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                        <input type="number" min="0" step="0.01" value={formData.public_price} onChange={(e) => setFormData({ ...formData, public_price: e.target.value })} placeholder="0.00" className="w-full pl-6 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Capacity</label>
                      <input type="number" min="1" value={formData.public_capacity} onChange={(e) => setFormData({ ...formData, public_capacity: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center space-x-3 text-sm"><CalendarIcon size={16} className="text-gray-400" /><span>{new Date(event.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
              {(event.start_time || event.end_time) && <div className="flex items-center space-x-3 text-sm"><Clock size={16} className="text-gray-400" /><span>{formatTimeDisplay(event.start_time)}{event.end_time ? ` - ${formatTimeDisplay(event.end_time)}` : ''}</span></div>}
              {event.location && <div className="flex items-center space-x-3 text-sm min-w-0"><MapPin size={16} className="text-gray-400 flex-shrink-0" /><span className="min-w-0 break-words">{event.location}</span></div>}
              {event.is_recurring && <div className="flex items-center space-x-3 text-sm"><Repeat size={16} className="text-gray-400" /><span className="text-gray-500">Recurring event</span></div>}
              {event.is_public && <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-sm"><span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Public booking</span>{event.booking_type && <span className="text-gray-700 font-medium">{event.booking_type}</span>}{event.public_price_cents != null && <span className="text-gray-500">${(event.public_price_cents / 100).toFixed(2)} · capacity {event.public_capacity || 1}</span>}</div>}
              {event.description && <div className="mt-3 p-3 bg-gray-50 rounded-lg text-sm text-gray-900 break-words">{event.description}</div>}
              {/* #320: athlete assignment — shown to everyone, editable by staff. */}
              {(() => {
                const athleteName = athletes.find(a => a.id === event.athlete_id)?.full_name || event.athlete?.full_name || '';
                if (!athleteName && !isStaff) return null;
                return (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5">
                        <User size={14} className="text-gray-400" />
                        <span className="text-gray-700">
                          Athlete:{' '}
                          {athleteName
                            ? <span className="font-medium text-gray-900">{athleteName}</span>
                            : <span className="text-gray-400 italic">none assigned</span>}
                        </span>
                      </div>
                      {isStaff && !editingAthlete && (
                        <button onClick={() => { setAthleteDraft(event.athlete_id || ''); setEditingAthlete(true); }} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                          {athleteName ? 'Edit athlete' : 'Assign athlete'}
                        </button>
                      )}
                    </div>
                    {editingAthlete && (
                      <div className="mt-2 space-y-2">
                        <select value={athleteDraft} onChange={(e) => setAthleteDraft(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
                          <option value="">No athlete</option>
                          {athletes.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                        </select>
                        <div className="flex justify-end space-x-2">
                          <button onClick={() => setEditingAthlete(false)} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                          <button onClick={handleAthleteSave} disabled={athleteSaving} className="px-3 py-1.5 text-xs bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition disabled:opacity-50">
                            {athleteSaving ? 'Saving…' : 'Save athlete'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* #320: coach(es) assignment — shown to everyone, editable by staff. */}
              {(() => {
                const coachNames = (event.coach_ids || []).map(cid => coaches.find(c => c.id === cid)?.full_name).filter(Boolean);
                if (!coachNames.length && event.coach?.full_name) coachNames.push(event.coach.full_name);
                if (!coachNames.length && !isStaff) return null;
                return (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5">
                        <UserCheck size={14} className="text-gray-400" />
                        <span className="text-gray-700">
                          {coachNames.length === 1 ? 'Coach' : 'Coaches'}:{' '}
                          {coachNames.length > 0
                            ? <span className="font-medium text-gray-900">{coachNames.join(', ')}</span>
                            : <span className="text-gray-400 italic">none assigned</span>}
                        </span>
                      </div>
                      {isStaff && !editingCoach && (
                        <button onClick={() => { setCoachDraft(event.coach_ids || (event.coach_id ? [event.coach_id] : [])); setEditingCoach(true); }} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                          {coachNames.length > 0 ? 'Edit coach(es)' : 'Assign coach(es)'}
                        </button>
                      )}
                    </div>
                    {editingCoach && (
                      <div className="mt-2 space-y-2">
                        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
                          {coaches.map(c => (
                            <label key={c.id} className="flex items-center space-x-2 text-sm py-0.5">
                              <input type="checkbox" checked={coachDraft.includes(c.id)} onChange={(e) => {
                                setCoachDraft(e.target.checked ? [...coachDraft, c.id] : coachDraft.filter(id => id !== c.id));
                              }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                              <span className="text-gray-700 truncate">{c.full_name}</span>
                            </label>
                          ))}
                        </div>
                        <div className="flex justify-end space-x-2">
                          <button onClick={() => setEditingCoach(false)} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                          <button onClick={handleCoachSave} disabled={coachSaving} className="px-3 py-1.5 text-xs bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition disabled:opacity-50">
                            {coachSaving ? 'Saving…' : 'Save coach(es)'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* #287: team assignment — shown to everyone, editable by staff. */}
              {(() => {
                const teamNames = (event.team_ids || []).map(tid => teams.find(t => t.id === tid)?.name).filter(Boolean);
                if (teamNames.length === 0 && !isStaff) return null;
                return (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5">
                        <Users size={14} className="text-gray-400" />
                        <span className="text-gray-700">
                          {teamNames.length === 1 ? 'Team' : 'Teams'}:{' '}
                          {teamNames.length > 0
                            ? <span className="font-medium text-gray-900">{teamNames.join(', ')}</span>
                            : <span className="text-gray-400 italic">none assigned</span>}
                        </span>
                      </div>
                      {isStaff && !editingTeams && (
                        <button onClick={() => { setTeamDraft(event.team_ids || []); setEditingTeams(true); }} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                          {teamNames.length > 0 ? 'Edit teams' : 'Assign teams'}
                        </button>
                      )}
                    </div>
                    {editingTeams && (
                      <div className="mt-2 space-y-2">
                        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
                          {teams.map(t => (
                            <label key={t.id} className="flex items-center space-x-2 text-sm py-0.5">
                              <input type="checkbox" checked={teamDraft.includes(t.id)} onChange={(e) => {
                                setTeamDraft(e.target.checked ? [...teamDraft, t.id] : teamDraft.filter(id => id !== t.id));
                              }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                              <span className="text-gray-700 truncate">{t.name}</span>
                            </label>
                          ))}
                        </div>
                        <div className="flex justify-end space-x-2">
                          <button onClick={() => setEditingTeams(false)} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                          <button onClick={handleTeamSave} disabled={teamSaving} className="px-3 py-1.5 text-xs bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition disabled:opacity-50">
                            {teamSaving ? 'Saving…' : 'Save teams'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* #310: MULTIPLE players on this event — additive to the
                  single Athlete field above, which is unchanged. Reuses the
                  `athletes` list already fetched for that field. */}
              {(() => {
                const playerCount = (event.athlete_ids || []).length;
                if (playerCount === 0 && !isStaff) return null;
                return (
                  <div className="text-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5">
                        <Users size={14} className="text-gray-400" />
                        <span className="text-gray-700">
                          Players:{' '}
                          {/* #347 (Cordell): the roster used to be inlined as a
                              comma list, which is what made this card thousands
                              of pixels tall. Staff get a count that opens a
                              scroll-safe list; a player only ever sees the
                              count, never other players' names. */}
                          {playerCount === 0
                            ? <span className="text-gray-400 italic">none added</span>
                            : isStaff
                              ? <button onClick={() => setShowPlayerList(true)} className="text-xs text-teal-600 hover:text-teal-700 font-medium underline underline-offset-2">{playerCount} assigned</button>
                              : <span className="font-medium text-gray-900">{playerCount}</span>}
                        </span>
                      </div>
                      {isStaff && !editingPlayers && (
                        <button onClick={() => { setPlayersDraft(event.athlete_ids || []); setEditingPlayers(true); }} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                          {playerCount > 0 ? 'Edit players' : 'Add player'}
                        </button>
                      )}
                    </div>
                    {editingPlayers && (
                      <div className="mt-2 space-y-2">
                        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
                          {athletes.map(a => (
                            <label key={a.id} className="flex items-center space-x-2 text-sm py-0.5">
                              <input type="checkbox" checked={playersDraft.includes(a.id)} onChange={(e) => {
                                setPlayersDraft(e.target.checked ? [...playersDraft, a.id] : playersDraft.filter(id => id !== a.id));
                              }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                              <span className="text-gray-700 truncate">{a.full_name}</span>
                            </label>
                          ))}
                        </div>
                        <button type="button" onClick={() => setShowCreatePlayer(true)} className="text-xs text-teal-600 hover:text-teal-700 font-medium">
                          + New player
                        </button>
                        <div className="flex justify-end space-x-2">
                          <button onClick={() => setEditingPlayers(false)} className="px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                          <button onClick={handlePlayersSave} disabled={playersSaving} className="px-3 py-1.5 text-xs bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition disabled:opacity-50">
                            {playersSaving ? 'Saving…' : 'Save players'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* #313: per-lane removal, staff only — leaves the rest of the
                  event (and its other lanes) intact. Only shown for events
                  actually occupying more than one lane; nothing to remove
                  from a single-lane event via this control. */}
              {isStaff && (event.lanes || []).length > 1 && (
                <div className="text-sm">
                  <div className="flex items-center space-x-1.5 mb-1.5">
                    <LayoutGrid size={14} className="text-gray-400" />
                    <span className="text-gray-700">Lanes:</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {event.lanes.map(lane => (
                      <span key={lane} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                        {lane}
                        <button
                          onClick={() => handleLaneDelete(lane)}
                          disabled={laneDeleting}
                          title={`Remove ${lane} from this event`}
                          className="text-gray-400 hover:text-red-600 disabled:opacity-50 rounded-full p-0.5"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* #277: RSVP for team-tagged facility events — this is where a
                  team lifting session booked into a weight room lands. Renders
                  as null when the event has no team assigned (a lane rental,
                  a lesson), so ordinary facility bookings are unaffected. */}
              <EventRsvpSection
                event={event}
                source="facility_events"
                userId={userId}
                userRole={userRole}
              />

              {isPlayer && (
                <div className="pt-4 border-t border-gray-200">
                  {signupsLoading ? (
                    <p className="text-sm text-gray-500">Loading…</p>
                  ) : mySignup ? (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center space-x-2 text-green-700 text-sm font-semibold">
                        <Check size={16} />
                        <span>You're signed up</span>
                      </div>
                      {mySignup.notes && <p className="text-xs text-gray-700 whitespace-pre-wrap">Notes: {mySignup.notes}</p>}
                      {signupsClosed ? (
                        <p className="text-xs text-gray-500">Sign-ups are locked within 12 hours of the event.</p>
                      ) : (
                        <button
                          onClick={handleCancelSignup}
                          disabled={signupLoading}
                          className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                        >
                          {signupLoading ? 'Cancelling…' : 'Cancel sign up'}
                        </button>
                      )}
                    </div>
                  ) : signupsClosed ? (
                    <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                      <span>Sign-ups are closed — they close 12 hours before the event starts.</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-gray-900">Would you like to sign up for this event?</p>
                      <textarea
                        value={signupNotes}
                        onChange={(e) => setSignupNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 text-sm"
                      />
                      <div className="flex space-x-2">
                        <button
                          onClick={onClose}
                          className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition text-sm"
                        >
                          No
                        </button>
                        <button
                          onClick={handleSignup}
                          disabled={signupLoading}
                          className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition disabled:opacity-50 text-sm"
                        >
                          {signupLoading ? 'Signing up…' : 'Yes, sign me up'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isStaff && (
                <div className="pt-4 border-t border-gray-200">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Sign ups {signups.length > 0 && <span className="ml-1 text-gray-700">({signups.length})</span>}
                  </h4>
                  {signupsLoading ? (
                    <p className="text-sm text-gray-500">Loading…</p>
                  ) : signups.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">No sign ups yet.</p>
                  ) : (
                    <ul className="space-y-2 max-h-40 overflow-y-auto">
                      {signups.map(s => (
                        <li key={s.id} className="flex items-start space-x-2 bg-gray-50 rounded-lg p-2">
                          {s.users?.avatar_url ? (
                            <img src={s.users.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0"><User size={14} className="text-gray-500" /></div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{s.users?.full_name || 'Unknown'}</p>
                            {s.notes && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{s.notes}</p>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {isStaff && event.is_public && (
                <div className="pt-4 border-t border-gray-200">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Public bookings {guestBookings.length > 0 && <span className="ml-1 text-gray-700">({guestBookings.length})</span>}
                  </h4>
                  {guestBookings.length === 0 ? (
                    <p className="text-sm text-gray-500 italic">No public bookings yet.</p>
                  ) : (
                    <ul className="space-y-2 max-h-48 overflow-y-auto">
                      {guestBookings.map(b => (
                        <li key={b.id} className="bg-gray-50 rounded-lg p-2.5">
                          <div className="flex items-start justify-between">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{b.guest_name}</p>
                              <p className="text-xs text-gray-500 truncate">{b.guest_email}{b.guest_phone ? ` · ${b.guest_phone}` : ''}</p>
                              {b.notes && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{b.notes}</p>}
                            </div>
                            <span className={`ml-2 flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${b.status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                              {b.status === 'confirmed' ? 'Paid' : 'Pending'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between mt-1.5">
                            <span className="text-xs text-gray-500">${(b.amount_cents / 100).toFixed(2)}</span>
                            <button onClick={() => handleRefund(b.id)} disabled={refundingId === b.id} className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50">
                              {refundingId === b.id ? 'Processing…' : (b.status === 'confirmed' ? 'Cancel & refund' : 'Cancel')}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

            </div>
          )}
        </div>
        {/* #347: the action row is a SIBLING of the scrolling body, not the last
            thing inside it (match WorkoutDetailModal). On a big event — a
            139-player RSVP roster makes this card ~3,000px tall — Close / Edit /
            Delete used to render below the viewport of a `fixed` overlay that
            cannot be scrolled to. Both modes get a row so the buttons are
            always reachable. */}
        <div className="border-t border-gray-200 p-4 flex space-x-3 flex-shrink-0">
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
              <button onClick={handleSave} disabled={loading} className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition disabled:opacity-50">{loading ? 'Saving...' : 'Save'}</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Close</button>
              {isStaff && (
                <>
                  <button onClick={() => setEditing(true)} className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition flex items-center justify-center space-x-1"><Edit2 size={16} /><span>Edit</span></button>
                  <button onClick={handleDelete} className="flex-1 bg-red-600 text-white py-2 rounded-lg hover:bg-red-700 transition flex items-center justify-center space-x-1"><Trash2 size={16} /><span>Delete</span></button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {/* #287: same three-option control shipped for #279, minus "this and
          future" — see PR notes on why a series split is unsafe here. Renders
          after the card so it paints on top. */}
      {teamRecurrencePrompt && (
        <RecurrenceDecisionModal
          title="Assign teams on a recurring event"
          message="Apply this team assignment to just this occurrence, or to the whole series?"
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={applyTeamAssignment}
          onClose={() => setTeamRecurrencePrompt(false)}
        />
      )}
      {/* #320: same recurrence pattern as teams above — reused, not reinvented. */}
      {coachRecurrencePrompt && (
        <RecurrenceDecisionModal
          title="Reassign coach(es) on a recurring event"
          message="Apply this coach change to just this occurrence, or to the whole series?"
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={applyCoachAssignment}
          onClose={() => setCoachRecurrencePrompt(false)}
        />
      )}
      {athleteRecurrencePrompt && (
        <RecurrenceDecisionModal
          title="Reassign athlete on a recurring event"
          message="Apply this athlete change to just this occurrence, or to the whole series?"
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={applyAthleteAssignment}
          onClose={() => setAthleteRecurrencePrompt(false)}
        />
      )}
      {playersRecurrencePrompt && (
        <RecurrenceDecisionModal
          title="Add players on a recurring event"
          message="Apply this player change to just this occurrence, or to the whole series?"
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={applyPlayersAssignment}
          onClose={() => setPlayersRecurrencePrompt(false)}
        />
      )}
      {/* #310: reuses AdminSettings.js's CreateUserModal rather than a second
          signup form. callerRole="coach" locks its role dropdown to Player
          regardless of who's actually viewing this event (its "Coaches can
          only create player accounts" hint text is a known, harmless
          mismatch when an admin is the one using it here). */}
      {showCreatePlayer && (
        <CreateUserModal
          teams={teams}
          callerRole="coach"
          onClose={() => setShowCreatePlayer(false)}
          onSuccess={(newId, newName) => {
            setShowCreatePlayer(false);
            setAthletes(prev => [...prev, { id: newId, full_name: newName }].sort((a, b) => a.full_name.localeCompare(b.full_name)));
            setPlayersDraft(prev => [...prev, newId]);
          }}
        />
      )}
      {laneRecurrencePrompt && (
        <RecurrenceDecisionModal
          title="Remove a lane on a recurring event"
          message={`Remove ${laneRecurrencePrompt} from just this occurrence, or from the whole series?`}
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={(choice) => applyLaneDelete(choice, laneRecurrencePrompt)}
          onClose={() => setLaneRecurrencePrompt(null)}
        />
      )}
      {/* #347: Save on a recurring event used to rewrite the whole series with
          no warning at all. Same control as the five above. */}
      {savePrompt && (
        <RecurrenceDecisionModal
          title="Edit a recurring event"
          message="Apply these changes to just this occurrence, or to every occurrence in the series?"
          actionLabel="Apply to"
          allowOne={true}
          allowFuture={false}
          onPick={applySave}
          onClose={() => setSavePrompt(false)}
        />
      )}
      {/* #347: Delete on a recurring event used to cascade the entire series —
          every occurrence, every per-occurrence edit, every sign-up — from a
          single "Delete this event?" confirm. "This and future" is offered
          here (unlike the field-level prompts above) because it is a delete:
          it just caps recurrence_rule.until, no series split needed. */}
      {deletePrompt && (
        <RecurrenceDecisionModal
          title="Delete a recurring event"
          message="This event repeats. Delete just this day, this day and everything after it, or the whole series?"
          actionLabel="Delete"
          allowOne={true}
          allowFuture={true}
          onPick={applyDelete}
          onClose={() => setDeletePrompt(false)}
        />
      )}
      {/* #347 (Cordell): who is actually assigned to this event. No new query —
          the names come from the athletes directory already loaded for the edit
          picker. full_name only, staff only. */}
      {showPlayerList && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={() => setShowPlayerList(false)}
        >
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-gray-200 p-4 flex items-center justify-between flex-shrink-0">
              <h3 className="text-sm font-semibold text-gray-900">Assigned players ({assignedPlayerNames.length})</h3>
              <button onClick={() => setShowPlayerList(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 min-h-0">
              {assignedPlayerNames.length === 0 ? (
                <p className="text-sm text-gray-500 italic">No players assigned.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {assignedPlayerNames.map((name, i) => (
                    <li key={`${name}-${i}`} className="py-2 text-sm text-gray-900">{name}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-gray-200 p-4 flex-shrink-0">
              <button onClick={() => setShowPlayerList(false)} className="w-full border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// COACH SLOTS WEEK VIEW
// ============================================

// #233↔#235: when a coach marks a player Present/Late for a session, consume one
// session from their active package/bundle (soonest-expiring first) and log it in
// store_session_usage tied to the reservation. Marking No-show/Cancelled/unmarking
// releases the previously-consumed session. Monthly packages (remaining_qty null)
// are never decremented.
//
// #306: the body of this now lives in sessionUsage.js, so the staff
// cancellation-review screen shares it instead of keeping a second copy of the
// package ledger. The deliberate swallow stays HERE and only here — marking a
// player present must not fail because their package is in an odd state, which
// has been true since #233. The review screen calls applySessionUsage directly
// and puts what it did on screen, because there giving the session back IS the
// action being asked for.
async function syncReservationSessionUsage(res, attended, markerId) {
  if (!res) return;
  const result = await applySessionUsage({
    reservationId: res.id,
    playerId: res.player_id,
    usedOn: res.slot_date,
    consume: !!attended,
    actorId: markerId,
    note: 'Attended training session',
  });
  if (!result.ok) console.error('Session-usage sync failed:', result.message);
}

const ATTENDANCE_OPTIONS = [
  { value: 'present', label: 'Present', cls: 'bg-green-600' },
  { value: 'late', label: 'Late', cls: 'bg-amber-500' },
  { value: 'no_show', label: 'No-show', cls: 'bg-red-600' },
  { value: 'cancelled', label: 'Cancelled', cls: 'bg-gray-500' },
];

// #452: `coachesById` switches this to a multi-coach grid (the athlete Private
// Lessons tab): each card resolves its own coach from slot.coach_id and shows
// the coach's name. Without it, `coach` is the single coach, as before.
function CoachSlotsWeekView({ selectedDate, slots, reservations, publicBookings = [], bookedCounts = {}, coach, coachesById = null, userId, userRole, canManage, onAddSlot, onReserve, onConfirm, onDecline, onMarkAttendance, selecting, selectedIds, onToggleSelect, onEventContextMenu, onSlotDrop, onMessageCoach }) {
  const startOfWeek = new Date(selectedDate);
  startOfWeek.setDate(selectedDate.getDate() - selectedDate.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const weekDays = [];
  for (let i = 0; i < 7; i++) { const d = new Date(startOfWeek); d.setDate(startOfWeek.getDate() + i); weekDays.push(d); }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const coachFor = (slot) => (coachesById ? (coachesById[slot.coach_id] || { id: slot.coach_id, full_name: 'Coach' }) : coach);
  // Any staff member can SEE who's booked in any coach's slots; managing the
  // reservations (confirm/decline/attendance) stays with the slot's coach + admin.
  const isStaffViewer = userRole === 'admin' || userRole === 'coach';
  // Player bookings close 12h before the session starts (mirrors the #233 cancel cutoff).
  const RESERVE_CUTOFF_MS = 12 * 60 * 60 * 1000;
  const isBookingClosed = (slot, dateStr) =>
    Date.now() > new Date(`${dateStr}T${(slot.start_time || '00:00').slice(0, 5)}:00`).getTime() - RESERVE_CUTOFF_MS;
  const formatLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const formatTime = (time) => {
    if (!time) return '';
    const [h, m] = time.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  };
  const getEndTime = (startTime, mins) => {
    if (!startTime) return '';
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + mins;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-x-auto">
      <div className="grid grid-cols-7 divide-x divide-gray-200 min-w-[840px]">
        {weekDays.map((date, idx) => {
          const dateStr = formatLocal(date);
          const daySlots = slots.filter(s => s.slot_date === dateStr);
          const isToday = date.getTime() === today.getTime();
          return (
            <div
              key={idx}
              className="min-h-[400px] bg-white"
              onDragOver={(e) => { if (canManage && onSlotDrop && !selecting) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
              onDrop={(e) => {
                if (!canManage || !onSlotDrop || selecting) return;
                e.preventDefault();
                const slotId = e.dataTransfer.getData('application/x-slot-id');
                // #292: which occurrence date was grabbed — a repeating slot's
                // expanded entries all share the master's id, so the id alone
                // can't identify the dragged date.
                const grabbedDate = e.dataTransfer.getData('application/x-slot-date');
                if (slotId) onSlotDrop(slotId, dateStr, grabbedDate);
              }}
            >
              <div
                className={`p-3 border-b border-gray-200 text-center ${isToday ? 'bg-teal-50' : 'bg-gray-50'} ${canManage && !selecting ? 'cursor-pointer hover:bg-teal-100 transition' : ''}`}
                onClick={canManage && !selecting ? () => onAddSlot(dateStr) : undefined}
                title={canManage && !selecting ? 'Click to add a training slot' : undefined}
              >
                <div className="text-xs font-medium text-gray-600">{date.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                <div className={`text-lg font-semibold ${isToday ? 'text-teal-600' : 'text-gray-900'}`}>{date.getDate()}</div>
                {canManage && <div className="text-[10px] text-teal-700 mt-0.5">+ Add slot</div>}
              </div>
              <div className="p-2 space-y-2">
                {daySlots.map((slot, si) => {
                  const slotRes = reservations.filter(r => r.slot_id === slot.id && r.slot_date === dateStr && r.status !== 'cancelled');
                  const activeSlotRes = slotRes.filter(r => r.status === 'pending' || r.status === 'confirmed');
                  const pubRes = publicBookings.filter(b => b.source_id === slot.id && b.occurrence_date === dateStr);
                  // #428: `bookedCounts` comes from the SECURITY DEFINER RPC and
                  // is correct for every viewer; the local filter only sees what
                  // RLS lets this user read (an athlete: their own row), so it
                  // is a floor, never the truth. Take the larger of the two so a
                  // just-made booking shows before the counts refetch.
                  const rpcBooked = bookedCounts[`${slot.id}|${dateStr}`];
                  const bookedCount = Math.max(rpcBooked ?? 0, activeSlotRes.length + pubRes.length);
                  const isBooked = bookedCount >= (slot.max_players || 1);
                  const userRes = slotRes.find(r => r.player_id === userId);
                  const endTime = getEndTime(slot.start_time, slot.duration_minutes);
                  const isSel = selecting && selectedIds && selectedIds.has(String(slot.id));
                  const slotCoach = coachFor(slot);
                  const isOwnSlots = slotCoach.id === userId;
                  const canManageRes = isOwnSlots || userRole === 'admin';
                  return (
                    <div
                      key={`${slot.id}-${si}`}
                      draggable={canManage && !selecting && !!onSlotDrop}
                      onDragStart={(e) => {
                        if (!canManage || selecting || !onSlotDrop) return;
                        e.stopPropagation();
                        e.dataTransfer.setData('application/x-slot-id', String(slot.id));
                        // #292: virtual occurrences are draggable now — the drop
                        // handler needs the grabbed date to know WHICH occurrence
                        // moved (mirrors #280's x-event-source-lane).
                        e.dataTransfer.setData('application/x-slot-date', String(slot.slot_date));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={(e) => { if (selecting && onToggleSelect) { e.stopPropagation(); onToggleSelect({ ...slot, slot_date: dateStr, id: slot.id }); } }}
                      onContextMenu={(e) => { if (onEventContextMenu && canManage) { e.preventDefault(); e.stopPropagation(); onEventContextMenu({ ...slot, slot_date: dateStr }, e); } }}
                      className={`p-2 rounded-lg border text-xs ${isBooked ? 'bg-gray-100 border-gray-200' : 'bg-teal-50 border-teal-200'} ${isSel ? 'ring-2 ring-blue-500' : ''} ${canManage && !selecting ? 'cursor-grab' : ''}`}
                    >
                      <div className="font-semibold text-gray-900">{formatTime(slot.start_time)} - {formatTime(endTime)}</div>
                      <div className="text-gray-500">{slot.duration_minutes} min</div>
                      {coachesById && <div className="font-medium text-indigo-700 mt-0.5 truncate">{slotCoach.full_name}</div>}
                      {slot.notes && <div className="text-gray-500 mt-1 truncate">{slot.notes}</div>}
                      {isStaffViewer && slotRes.map(res => (
                        <div key={res.id} className="mt-2 p-2 bg-white rounded border">
                          <div className="font-medium text-gray-900">{res.users?.full_name}</div>
                          {res.player_note && <div className="text-gray-500 mt-1">{res.player_note}</div>}
                          <div className={`inline-block px-2 py-0.5 rounded-full text-xs mt-1 ${res.status === 'confirmed' ? 'bg-green-100 text-green-700' : res.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>{res.status}</div>
                          {canManageRes && res.status === 'pending' && (
                            <div className="flex space-x-1 mt-2">
                              <button onClick={() => onConfirm(res.id)} className="flex-1 bg-green-600 text-white py-1 rounded text-xs hover:bg-green-700">Confirm</button>
                              <button onClick={() => onDecline(res.id)} className="flex-1 bg-red-600 text-white py-1 rounded text-xs hover:bg-red-700">Decline</button>
                            </div>
                          )}
                          {canManageRes && res.status === 'confirmed' && onMarkAttendance && (
                            <div className="mt-2 pt-2 border-t border-gray-100">
                              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Attendance</div>
                              <div className="flex flex-wrap gap-1">
                                {ATTENDANCE_OPTIONS.map(opt => (
                                  <button
                                    key={opt.value}
                                    onClick={() => onMarkAttendance(res.id, opt.value)}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${res.attendance === opt.value ? `${opt.cls} text-white` : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                      {isStaffViewer && pubRes.map((b, bi) => (
                        <div key={`pub-${bi}`} className="mt-2 p-2 bg-white rounded border border-blue-100">
                          <div className="font-medium text-gray-900">{b.guest_name}</div>
                          <div className={`inline-block px-2 py-0.5 rounded-full text-xs mt-1 ${b.status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                            {b.status === 'confirmed' ? 'Confirmed (public)' : 'Payment pending (public)'}
                          </div>
                        </div>
                      ))}
                      {!isOwnSlots && userRole === 'player' && !userRes && !isBooked && (
                        isBookingClosed(slot, dateStr) ? (
                          <div className="mt-1 text-xs text-gray-400">Booking closed</div>
                        ) : (
                          <button onClick={() => onReserve({ ...slot, slot_date: dateStr })} className="mt-2 w-full bg-teal-600 text-white py-1 rounded text-xs hover:bg-teal-700 transition">Reserve</button>
                        )
                      )}
                      {userRes && <div className={`mt-1 text-xs font-medium ${userRes.status === 'confirmed' ? 'text-green-600' : userRes.status === 'pending' ? 'text-yellow-600' : 'text-red-600'}`}>{userRes.status === 'confirmed' ? 'Confirmed' : userRes.status === 'pending' ? 'Pending' : 'Declined'}</div>}
                      {/* #407: a booked athlete can message the coach about this session
                          (sick, running late, need to reschedule) right from the card. */}
                      {userRole === 'player' && userRes && (userRes.status === 'pending' || userRes.status === 'confirmed') && onMessageCoach && (
                        <button
                          onClick={() => onMessageCoach({ coachId: slot.coach_id || slotCoach.id, coachName: slotCoach.full_name, date: dateStr, startTime: slot.start_time, title: slot.notes })}
                          className="mt-1.5 w-full border border-teal-600 text-teal-700 py-1 rounded text-xs font-medium hover:bg-teal-50 transition touch-manipulation"
                        >
                          Message coach
                        </button>
                      )}
                      {!isOwnSlots && isBooked && !userRes && <div className="mt-1 text-xs text-gray-400">Fully booked</div>}
                    </div>
                  );
                })}
                {daySlots.length === 0 && (
                  canManage ? (
                    <button onClick={() => onAddSlot(dateStr)} className="w-full text-center py-4 text-gray-400 text-xs border border-dashed border-gray-200 rounded-lg hover:border-teal-400 hover:text-teal-600 transition">+ Add slot</button>
                  ) : (
                    <div className="text-center py-4 text-gray-400 text-xs">No slots</div>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================
// CREATE SLOT PANEL
// ============================================

// #298: store_products kinds shown in the slot picker, and their group labels.
// 'package' = the recurring monthly memberships; 'lesson' = the one-on-one and
// small-group packs. Both are attachable to a session; see PRODUCT_KINDS_NOTE.
const SLOT_PRODUCT_KINDS = ['package', 'lesson'];
const PRODUCT_KIND_GROUPS = [
  { kind: 'package', label: 'Monthly / Recurring' },
  { kind: 'lesson', label: 'Lesson & Class Packages' },
];

// #298: coaches whose products are titled with a different form of their name
// than their user row carries. Key = the exact users.full_name; value = the
// extra product-name prefixes that also mean that coach.
//
// DO NOT "fix" these by renaming the products instead. store_products.name is
// overwritten from Square on every catalogue sync — see the update patch in
// supabase/functions/square-catalog-sync/index.ts, which writes `name` in place
// on each run — so a rename made in the database is reverted the next time the
// sync runs. The rename would have to happen in Square itself; until it does,
// this map is the correct place to reconcile the two spellings.
const COACH_PRODUCT_NAME_ALIASES = {
  // users.full_name is "Joshua Sale"; the three lesson packs are titled
  // "Josh Sale ...".
  'Joshua Sale': ['Josh Sale'],
};

// #298: some products are named after the coach who runs them ("Micah Yonamine
// 10 Pack of One on One lessons"). Those may only be attached to that coach's
// own sessions. Ownership is decided by NAME MATCHING — the business owner's
// explicit choice — so it is EXPECTED TO BREAK when a product spells a coach's
// name differently from their user row and no alias above covers it.
//
// The coach's name must be a PREFIX of the product name, not merely present
// somewhere inside it. Verified against the live catalogue: every genuinely
// coach-owned product leads with the coach's name. Substring matching caused a
// real regression — the pseudo-coach account "Strength and Conditioning "
// claimed all eight "NBP Strength & Conditioning ..." programs (they contain
// both words but start with "NBP"), which would have hidden org-wide products
// from every other coach. Prefix matching fixes that with no exclusion list.
//
// Known consequence, accepted: the two "Copy of Adam Cimber Submarine Pitching
// Academy Remote ..." products no longer match Adam Cimber, because they lead
// with "Copy of". They are treated as unowned and shown to everyone — the
// fail-open direction.
//
// Fails OPEN by design: a product matching no coach is shown to everyone. That
// is the safe direction — an over-restrictive rule would silently hide a pack a
// coach needs, which is harder to notice than an extra option in the list.
//
// Requires BOTH a first and a last name token, so a single-word coach account
// cannot match half the catalogue. Pure and side-effect free so it can be
// unit-tested later.
export function coachOwningProduct(productName, coachFullNames) {
  const name = String(productName || '').trim().toLowerCase();
  if (!name) return null;
  for (const full of coachFullNames || []) {
    // Coach rows in this database carry stray leading/trailing spaces.
    const trimmed = String(full || '').trim();
    if (trimmed.split(/\s+/).filter(Boolean).length < 2) continue; // need first AND last
    const candidates = [trimmed, ...(COACH_PRODUCT_NAME_ALIASES[trimmed] || [])];
    if (candidates.some(c => name.startsWith(String(c).trim().toLowerCase()))) return full;
  }
  return null;
}

// A product is pickable when nobody owns it, or when its owner is the coach
// this slot belongs to. Comparison is on trimmed, case-insensitive full names
// because coach rows in this database carry stray leading/trailing spaces.
export function isProductVisibleToCoach(productName, selectedCoachName, coachFullNames) {
  const owner = coachOwningProduct(productName, coachFullNames);
  if (!owner) return true;
  const norm = (s) => String(s || '').trim().toLowerCase();
  return norm(owner) === norm(selectedCoachName);
}

function CreateSlotPanel({ onClose, onSuccess, coachId, coachName, initialDate, existingSlot }) {
  const isEdit = !!existingSlot;
  const initialDateStr = existingSlot?.slot_date || initialDate || fmtLocalDate(new Date());
  const initialDow = new Date(initialDateStr + 'T00:00:00').getDay();
  const [slotDate, setSlotDate] = useState(initialDateStr);
  const [startTime, setStartTime] = useState(existingSlot?.start_time || '09:00');
  const [duration, setDuration] = useState(existingSlot?.duration_minutes || 60);
  const [autoConfirm, setAutoConfirm] = useState(existingSlot?.auto_confirm || false);
  const [repeatWeekly, setRepeatWeekly] = useState(existingSlot?.repeat_weekly || false);
  const [repeatEndDate, setRepeatEndDate] = useState(existingSlot?.repeat_end_date || '');
  // When creating: default to the weekday of slotDate. When editing: locked to existing weekday.
  const [repeatDows, setRepeatDows] = useState(() => new Set([initialDow]));
  const [maxPlayers, setMaxPlayers] = useState(existingSlot?.max_players || 1);
  const [notes, setNotes] = useState(existingSlot?.notes || '');
  // #434: optional facility lanes — with any set, the lesson also renders in the Lanes grid.
  const [lanes, setLanes] = useState(existingSlot?.lanes || []);
  const [loading, setLoading] = useState(false);
  // Public booking (#229): let outside customers book & pay for this session.
  const [isPublic, setIsPublic] = useState(existingSlot?.is_public || false);
  const [publicPrice, setPublicPrice] = useState(existingSlot?.public_price_cents != null ? (existingSlot.public_price_cents / 100).toFixed(2) : '');
  // Subscription session (#244): tie the slot to a Square subscription/package
  // product so subscribers can join. Products come from store_products.
  const [isSubscriptionSession, setIsSubscriptionSession] = useState(existingSlot?.is_subscription_session || false);
  // #306: 'sc' | 'skills' | '' (not set → the weekly-allowance check falls
  // back to the coach's S&C skill tag, as before the column existed).
  const [sessionType, setSessionType] = useState(existingSlot?.session_type || '');
  // #249: a session can accept MULTIPLE subscription/package plans, stored as a
  // uuid[] (mirrors team_ids). store_product_id stays as primary/legacy = ids[0].
  const [storeProductIds, setStoreProductIds] = useState(
    existingSlot?.store_product_ids?.length ? existingSlot.store_product_ids
      : (existingSlot?.store_product_id ? [existingSlot.store_product_id] : [])
  );
  const [subProducts, setSubProducts] = useState([]);
  // #298: full names of every coach, used to decide which coach-named products
  // this slot may attach (see coachOwningProduct above).
  const [coachNames, setCoachNames] = useState([]);
  // #298: shown when picking a product of one kind clears a selection of the
  // other — a session accepts memberships OR lesson packs, never a mix.
  const [kindSwitchNote, setKindSwitchNote] = useState(null);

  // The kind currently selected, derived from the UNFILTERED product list so
  // an already-attached product still counts even if the coach filter would
  // hide it (e.g. editing another coach's slot).
  const selectedKind = (() => {
    const first = subProducts.find(p => storeProductIds.includes(p.id));
    return first ? first.kind : null;
  })();

  const toggleProduct = (id) => {
    const product = subProducts.find(p => p.id === id);
    setStoreProductIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      // Several products of the SAME kind can be combined. Picking the other
      // kind replaces the selection rather than erroring (#298).
      if (product && selectedKind && product.kind !== selectedKind) {
        const from = PRODUCT_KIND_GROUPS.find(g => g.kind === selectedKind)?.label || selectedKind;
        const to = PRODUCT_KIND_GROUPS.find(g => g.kind === product.kind)?.label || product.kind;
        setKindSwitchNote(`A session uses either monthly memberships or lesson packages, not both — your ${from} selection was replaced with this ${to} one.`);
        return [id];
      }
      setKindSwitchNote(null);
      return [...prev, id];
    });
  };

  useEffect(() => {
    (async () => {
      const [{ data: products, error: productsError }, { data: coaches, error: coachesError }] = await Promise.all([
        supabase
          .from('store_products')
          .select('id, name, price_cents, recurring, kind')
          .in('kind', SLOT_PRODUCT_KINDS)
          .eq('active', true)
          .order('sort_order'),
        supabase.from('users').select('full_name').eq('role', 'coach'),
      ]);
      if (productsError) console.error('CreateSlotPanel: store_products query failed:', productsError);
      if (coachesError) console.error('CreateSlotPanel: coach names query failed:', coachesError);
      setSubProducts(products || []);
      setCoachNames((coaches || []).map(c => c.full_name).filter(Boolean));
    })();
  }, []);

  // Keep the slot's own weekday selected when slotDate changes.
  useEffect(() => {
    if (isEdit) return;
    const dow = new Date(slotDate + 'T00:00:00').getDay();
    setRepeatDows(prev => prev.has(dow) ? prev : new Set([...prev, dow]));
  }, [slotDate, isEdit]);

  const toggleDow = (dow) => {
    setRepeatDows(prev => {
      const next = new Set(prev);
      if (next.has(dow)) next.delete(dow); else next.add(dow);
      return next;
    });
  };

  const firstDateOnOrAfter = (fromDateStr, targetDow) => {
    const d = new Date(fromDateStr + 'T00:00:00');
    const offset = (targetDow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + offset);
    return fmtLocalDate(d);
  };

  const handleSave = async () => {
    // #249: allow $0 (free) sessions — reject only blank / negative / non-numeric.
    if (isPublic && !(parseFloat(publicPrice) >= 0)) return alert('Enter a price for public booking (0 for free)');
    if (isSubscriptionSession && storeProductIds.length === 0) return alert('Choose at least one package or membership for this session');
    const publicFields = {
      is_public: isPublic,
      public_price_cents: isPublic ? Math.round(parseFloat(publicPrice) * 100) : null,
      is_subscription_session: isSubscriptionSession,
      // #249: accept N plans. Keep store_product_id = ids[0] as primary/legacy.
      store_product_ids: isSubscriptionSession ? storeProductIds : [],
      store_product_id: isSubscriptionSession ? (storeProductIds[0] || null) : null,
      session_type: sessionType || null,
      lanes,
    };
    setLoading(true);
    try {
      if (isEdit) {
        const payload = {
          coach_id: coachId, slot_date: slotDate, start_time: startTime, duration_minutes: duration,
          auto_confirm: autoConfirm, repeat_weekly: repeatWeekly,
          repeat_end_date: repeatWeekly && repeatEndDate ? repeatEndDate : null, max_players: maxPlayers, notes: notes || null,
          ...publicFields,
        };
        const { error } = await supabase.from('training_slots').update(payload).eq('id', existingSlot.id);
        if (error) throw error;
      } else if (repeatWeekly && repeatDows.size > 1) {
        // Create one master slot per selected weekday, anchored to the first occurrence on/after slotDate.
        const baseDow = new Date(slotDate + 'T00:00:00').getDay();
        const rows = [...repeatDows].sort().map(dow => ({
          coach_id: coachId,
          slot_date: dow === baseDow ? slotDate : firstDateOnOrAfter(slotDate, dow),
          start_time: startTime,
          duration_minutes: duration,
          auto_confirm: autoConfirm,
          repeat_weekly: true,
          repeat_end_date: repeatEndDate || null,
          max_players: maxPlayers,
          notes: notes || null,
          ...publicFields,
        }));
        const { error } = await supabase.from('training_slots').insert(rows);
        if (error) throw error;
      } else {
        const payload = {
          coach_id: coachId, slot_date: slotDate, start_time: startTime, duration_minutes: duration,
          auto_confirm: autoConfirm, repeat_weekly: repeatWeekly,
          repeat_end_date: repeatWeekly && repeatEndDate ? repeatEndDate : null, max_players: maxPlayers, notes: notes || null,
          ...publicFields,
        };
        const { error } = await supabase.from('training_slots').insert(payload);
        if (error) throw error;
      }
      onSuccess();
    } catch (err) { alert('Error ' + (isEdit ? 'updating' : 'creating') + ' slot: ' + formatUserError(err)); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* The card is capped to the viewport and laid out as a column: header and
          footer are fixed-height, the body between them scrolls. Without this the
          card grew to its content height and the Cancel / Create Slot footer ran
          off the bottom of the screen with no scrollable ancestor to reach it —
          on a 740px-tall window, expanding the package picker put the buttons at
          y≈872-914 and the slot could not be saved at all. min-h-0 on the body is
          load-bearing: a flex child defaults to min-height:auto, so without it the
          body refuses to shrink and its content escapes the card's max-height
          instead of scrolling inside it. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          {/* #347 QA sweep: the coach's name is free text and this header does
              not shrink, so it is kept to one line — otherwise a long name grows
              the header and pushes the Cancel / Create Slot footer past the
              card's max-h and off the bottom of the screen. */}
          <h3 className="text-xl font-bold text-gray-900 truncate" title={coachName || undefined}>{isEdit ? 'Edit' : 'Create'} Training Slot{coachName ? ` for ${coachName}` : ''}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
        </div>
        <div className="p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Date</label><input type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Duration</label><select value={duration} onChange={(e) => setDuration(parseInt(e.target.value))} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"><option value={30}>30 min</option><option value={45}>45 min</option><option value={60}>60 min</option><option value={90}>90 min</option></select></div>
          </div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Max Players</label><input type="number" min="1" max="50" value={maxPlayers} onChange={(e) => setMaxPlayers(parseInt(e.target.value) || 1)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Lanes <span className="font-normal text-gray-400">(optional)</span></label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {LANES.map(lane => (
                <label key={lane} className="flex items-center space-x-2 text-sm">
                  <input type="checkbox" checked={lanes.includes(lane)} onChange={(e) => {
                    setLanes(e.target.checked ? LANES.filter(l => l === lane || lanes.includes(l)) : lanes.filter(l => l !== lane));
                  }} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                  <span className="text-gray-700">{lane}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1">With a lane set, this lesson also shows in the Lanes grid so staff can see which lanes are free (#434).</p>
          </div>
          <div className="flex items-center space-x-3"><input type="checkbox" id="autoConfirm" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} className="rounded" /><label htmlFor="autoConfirm" className="text-sm text-gray-700">Auto-confirm reservations</label></div>
          <div className="flex items-center space-x-3"><input type="checkbox" id="repeatWeekly" checked={repeatWeekly} onChange={(e) => setRepeatWeekly(e.target.checked)} className="rounded" /><label htmlFor="repeatWeekly" className="text-sm text-gray-700">Repeat weekly</label></div>
          {repeatWeekly && (
            <>
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Days of week</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((label, dow) => {
                      const selected = repeatDows.has(dow);
                      return (
                        <button
                          type="button"
                          key={dow}
                          onClick={() => toggleDow(dow)}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                            selected ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">First occurrence of each weekday on/after the start date becomes the master slot.</p>
                </div>
              )}
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Repeat until</label><input type="date" value={repeatEndDate} onChange={(e) => setRepeatEndDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
            </>
          )}
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g., Hitting session, Pitching mechanics" rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          <div className="border border-gray-200 rounded-lg p-3">
            <label className="flex items-center space-x-2 text-sm font-medium text-gray-700">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
              <span>Available for public booking</span>
            </label>
            {isPublic && (
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Price per session (USD)</label>
                <div className="relative max-w-[160px]">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="number" min="0" step="0.01" value={publicPrice} onChange={(e) => setPublicPrice(e.target.value)} placeholder="0.00" className="w-full pl-6 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
                <p className="text-xs text-gray-400 mt-1.5">Outside customers can book this session on the public /book page (up to Max Players spots). Enter <span className="font-medium">0</span> for a free session — guests are confirmed instantly with no payment.</p>
              </div>
            )}
          </div>
          {/* #306: which weekly allowance pot this session draws from. */}
          <div className="border border-gray-200 rounded-lg p-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Session type</label>
            <select value={sessionType} onChange={(e) => setSessionType(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
              <option value="">Not set — counted by the coach&apos;s skills</option>
              <option value="sc">Strength &amp; Conditioning</option>
              <option value="skills">Skills (hitting, pitching, fielding, catching, base running, throwing)</option>
            </select>
            <p className="text-xs text-gray-400 mt-1.5">Weekly package allowances count S&amp;C and skills sessions separately (e.g. &ldquo;4 S&amp;C + 1 skills a week&rdquo;).</p>
          </div>
          <div className="border border-gray-200 rounded-lg p-3">
            <label className="flex items-center space-x-2 text-sm font-medium text-gray-700">
              <input type="checkbox" checked={isSubscriptionSession} onChange={(e) => setIsSubscriptionSession(e.target.checked)} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
              <span>Package / membership required</span>
            </label>
            {isSubscriptionSession && (
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Which packages / plans? (accept one or more)</label>
                {subProducts.length === 0 ? (
                  <p className="text-xs text-amber-600 mt-1.5">No active products found. Add them in the Store (Work Portal) or sync from Square.</p>
                ) : (
                  <div className="space-y-3 max-h-64 overflow-y-auto border border-gray-200 rounded-lg p-2">
                    {PRODUCT_KIND_GROUPS.map(group => {
                      // An already-selected product stays visible even if the
                      // coach filter would hide it — otherwise editing another
                      // coach's slot would silently keep a pick you can't see
                      // or remove (#298).
                      const groupProducts = subProducts.filter(p =>
                        p.kind === group.kind
                        && (storeProductIds.includes(p.id) || isProductVisibleToCoach(p.name, coachName, coachNames))
                      );
                      if (groupProducts.length === 0) return null;
                      return (
                        <div key={group.kind}>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">{group.label}</div>
                          <div className="space-y-1.5">
                            {groupProducts.map(p => (
                              <label key={p.id} className="flex items-center space-x-2 text-sm text-gray-700 cursor-pointer">
                                <input type="checkbox" checked={storeProductIds.includes(p.id)} onChange={() => toggleProduct(p.id)} className="w-4 h-4 text-teal-600 border-gray-300 rounded focus:ring-teal-500" />
                                <span>{p.name}{p.price_cents != null ? ` — $${(p.price_cents / 100).toFixed(2)}${p.recurring ? '/mo' : ''}` : ''}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {kindSwitchNote && (
                  <p className="text-xs text-amber-600 mt-1.5">{kindSwitchNote}</p>
                )}
                <p className="text-xs text-gray-400 mt-1.5">Athletes with an active package or plan on any selected option can join this session.</p>
              </div>
            )}
          </div>
        </div>
        {/* Outside the scrolling body so it stays on screen at any window height. */}
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition disabled:opacity-50">{loading ? (isEdit ? 'Updating...' : 'Creating...') : (isEdit ? 'Update Slot' : 'Create Slot')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// RESERVE SLOT MODAL
// ============================================

function ReserveSlotModal({ slot, coach, onClose, onSuccess }) {
  const [playerNote, setPlayerNote] = useState('');
  const [loading, setLoading] = useState(false);
  // #305: reason is set when the gate has something to say — 'none' |
  // 'expired' | 'no_sessions' (pkg is null for those three) | 'paused' (pkg
  // IS set: the athlete holds a matching subscription but it is paused in
  // Square, so they may book, with a warning). Picks the banner below.
  const [pkgCheck, setPkgCheck] = useState({ checking: true, pkg: null, reason: null });
  // #244/#249: names of the subscription plan(s) this session accepts (if any).
  const [subNames, setSubNames] = useState([]);
  // #276: the player's held purchases (reused for the weekly-cap check) and the
  // pending over-cap warning, if any.
  const [ownedPurchases, setOwnedPurchases] = useState([]);
  const [capWarning, setCapWarning] = useState(null);

  // #305: the product(s) this specific session was tagged with (CreateSlotPanel
  // / BulkTagSessions). Matching is by id against THIS list, never by name or
  // product kind — a session with nothing attached (is_subscription_session
  // false, the pre-#311-tagging default) is NOT gated, so this stays exactly
  // as permissive as it always was for the rare untagged slot.
  const requiredProductIds = slot?.store_product_ids?.length ? slot.store_product_ids : (slot?.store_product_id ? [slot.store_product_id] : []);
  // 🔴 #305 GATE MODE — 'off' | 'warn' | 'block'.
  //
  //   'off'   — nothing but the informational banners (how it shipped in Aug).
  //   'warn'  — the gate RUNS: the athlete sees the specific refusal reason
  //             and staff get a booking_package_flags row, but the Reserve
  //             button stays live and the booking goes through. Zero lockouts.
  //   'block' — the full "no package, no booking" rule. Reserve is disabled
  //             and the attempt is flagged as blocked.
  //
  // Why 'warn' and not 'block' (Trevor, 2026-09-23): measured against the
  // LIVE database that day, 'block' would have refused 50 of the last 80
  // real bookings (14 athletes). Not because the rule is wrong — 162
  // lesson-pack purchases held by 116 athletes still sit at status 'pending'
  // (paid by Square invoice or at the desk, never reconciled), so the gate
  // cannot see that those athletes own anything. Even counting pending and
  // paused purchases as held, 24 bookings (8 athletes) would still have been
  // refused. 'warn' gets the flags flowing to staff so the pending pile gets
  // worked down against real attempts, and flipping to 'block' later is this
  // one constant. Re-measure before flipping.
  //
  // Paused subscriptions (status 'past_due' — every writer maps it from
  // Square PAUSED, it does not mean money is owed) count as HELD in every
  // mode, with a warning banner and a flag, so a family taking the season
  // off is never silently locked out.
  const BOOKING_GATE_MODE = 'warn';
  const gateActive = BOOKING_GATE_MODE !== 'off' && !!slot?.is_subscription_session && requiredProductIds.length > 0;
  const gateBlocks = BOOKING_GATE_MODE === 'block' && gateActive;
  // Kept under its old name for the JSX below: "the gate has an opinion about
  // this athlete on this slot" — true in warn AND block mode.
  const gated = gateActive;
  // Stable, primitive form of requiredProductIds for effect dependency arrays
  // below — the array itself is a new reference every render.
  const requiredProductIdsKey = requiredProductIds.join(',');

  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const today = new Date().toISOString();
        // Fetch unfiltered by validity (unlike the old query) so a matching-
        // but-expired or matching-but-empty package can be told apart from
        // holding no matching package at all, for the refusal message.
        const { data } = await supabase
          .from('store_purchases')
          .select('id, product_id, product_name_snapshot, remaining_qty, product_kind, expires_at')
          .eq('user_id', user.id)
          .in('product_kind', ['package', 'bundle', 'lesson'])
          // 'past_due' is Square PAUSED (see PKG_STATUS_LABELS in WorkStore.js),
          // fetched so a paused holder can be told apart from a non-holder.
          .in('status', ['active', 'paid', 'past_due']);
        const all = data || [];
        const isLive = (p) => p.status === 'active' || p.status === 'paid';
        const purchases = all.filter(isLive);
        const paused = all.filter(p => p.status === 'past_due');
        // #276: the weekly-cap check needs the player's live (unexpired)
        // packages. #305's query above deliberately does NOT filter on expiry
        // so it can tell "expired" apart from "never had one", so filter here.
        setOwnedPurchases(purchases.filter(p => !p.expires_at || p.expires_at > today));
        // remaining_qty === null means "uncounted". For a recurring monthly
        // package that is true unlimited. For a one-time purchase it usually
        // means no session count was ever set (a plain single lesson, not a
        // pack) — UNLESS the product is really a weekly programme that Square
        // exported as a one-time item ("NBP 3x A Week Training" is kind
        // 'lesson' in the catalogue). Those are allowances, not buckets, and
        // bookingCaps.js already reads the frequency off the name for the
        // weekly cap — the same rule is reused here so the two agree.
        const hasSessionsLeft = (p) => {
          if (p.remaining_qty !== null) return p.remaining_qty > 0;
          return p.product_kind === 'package' || weeklyFrequencyFromName(p.product_name_snapshot) !== null;
        };
        const notExpired = (p) => !p.expires_at || p.expires_at > today;

        if (requiredProductIds.length > 0) {
          // #305 (Q7 — "the package has to match the session size"): matched
          // against the specific products attached to THIS slot, not a
          // name-guess or a kind-guess. A cage-rental purchase's product_id
          // is never in requiredProductIds (SLOT_PRODUCT_KINDS only allows
          // attaching 'package'/'lesson' products to a slot in the first
          // place), so it simply never matches here — no special-case needed.
          //
          // #276/#310 (Trevor, 2026-08-13): "if the title of the two packages
          // says the same name before the (frequency of charge) is listed then
          // it is the same package in reality." Square exported the same real
          // package more than once — sessions are tagged with the bare
          // "NBP 2x A Week Training" while every player actually bought
          // "NBP 2x A Week Training (MONTHLY price)". So the id test is widened
          // to a package-FAMILY test. This can only ever match MORE purchases
          // than the id test alone, never fewer, so it cannot lock anybody out.
          let requiredNames = [];
          try {
            const { data: prodRows } = await supabase
              .from('store_products').select('id, name').in('id', requiredProductIds);
            requiredNames = (prodRows || []).map(r => r.name).filter(Boolean);
          } catch { /* fall back to id-only matching below */ }

          const matchesSlot = (p) =>
            (p.product_id && requiredProductIds.includes(p.product_id)) ||
            requiredNames.some(n => sameFamily(n, p.product_name_snapshot));
          const matching = purchases.filter(matchesSlot);
          const valid = matching.find(p => hasSessionsLeft(p) && notExpired(p));
          if (valid) {
            setPkgCheck({ checking: false, pkg: valid, reason: null });
            return;
          }
          // No live match. A PAUSED match still counts as held (Trevor,
          // 2026-09-23: "book with a warning") — the athlete may reserve, the
          // banner says the subscription is paused, and staff get a flag.
          const pausedMatch = paused.find(p => matchesSlot(p) && hasSessionsLeft(p) && notExpired(p));
          if (pausedMatch) {
            setPkgCheck({ checking: false, pkg: pausedMatch, reason: 'paused' });
            return;
          }
          let reason;
          if (matching.length === 0) reason = 'none';
          else if (matching.some(p => !notExpired(p))) reason = 'expired';
          else reason = 'no_sessions';
          setPkgCheck({ checking: false, pkg: null, reason });
        } else {
          // Not gated — this slot has no product attached. Preserve the
          // original, pre-#305 behaviour exactly: informational only, never
          // blocks the reservation.
          const valid = purchases.find(p => hasSessionsLeft(p) && notExpired(p));
          setPkgCheck({ checking: false, pkg: valid || null, reason: null });
        }
      } catch {
        setPkgCheck({ checking: false, pkg: null, reason: null });
      }
    })();
  }, [requiredProductIdsKey, slot?.is_subscription_session]);

  useEffect(() => {
    const ids = requiredProductIds;
    if (!slot?.is_subscription_session || ids.length === 0) { setSubNames([]); return; }
    (async () => {
      const { data } = await supabase.from('store_products').select('name').in('id', ids);
      // #276/#305: same package, different Square billing frequency. A slot can
      // be tagged with two rows that are the same real package ("X" and
      // "X (MONTHLY price)"); show the base name once instead of listing both.
      const seen = new Set();
      const labels = [];
      (data || []).forEach(d => {
        const label = familyLabel(d.name);
        const key = familyKey(d.name);
        if (!label || seen.has(key)) return;
        seen.add(key);
        labels.push(label);
      });
      setSubNames(labels);
    })();
  }, [slot?.is_subscription_session, slot?.store_product_id, slot?.store_product_ids]);

  // #305: flag the attempt so staff can see it (Cordell's Q8 — "an athlete
  // without a package should be flagged"). In-app only — never touches
  // #281's parked email send path. Best-effort: failures are swallowed, same
  // as syncReservationSessionUsage already does for package errors — this is
  // a side note for staff, never something that should interrupt or alarm
  // the player trying to book.
  //
  // "The gate has a complaint" = no matching package, OR the match is a
  // paused subscription. When it does:
  //   block mode, no package  → flagged 'blocked' the moment the modal opens
  //                             (there will be no reservation row to find).
  //   otherwise               → flagged 'booked' only once the reservation
  //                             actually lands (see handleReserve), so a
  //                             player who opens the modal and closes it is
  //                             not reported as having booked anything.
  const gateComplaint = gated && !pkgCheck.checking && (!pkgCheck.pkg || pkgCheck.reason === 'paused');
  const flagAttempt = async (outcome) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from('booking_package_flags').insert({
        player_id: user.id,
        slot_id: slot.id,
        slot_date: slot.slot_date,
        coach_id: slot.coach_id || coach?.id || null,
        outcome,
        reason: pkgCheck.reason,
      });
    } catch (e) {
      console.error('booking_package_flags insert failed (migration pending?):', e);
    }
  };
  const flaggedRef = useRef(false);
  useEffect(() => {
    if (flaggedRef.current) return;
    if (gateBlocks && gateComplaint && !pkgCheck.pkg) {
      flaggedRef.current = true;
      flagAttempt('blocked');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateBlocks, gateComplaint, pkgCheck.pkg]);

  const formatTime = (time) => {
    if (!time) return '';
    const [h, m] = time.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  };

  // Bookings close 12h before the session starts (mirrors the #233 cancel cutoff).
  const RESERVE_CUTOFF_MS = 12 * 60 * 60 * 1000;
  const slotStartAt = new Date(`${slot.slot_date}T${(slot.start_time || '00:00').slice(0, 5)}:00`);
  const bookingClosed = Date.now() > slotStartAt.getTime() - RESERVE_CUTOFF_MS;

  // #276: before writing the reservation, check the athlete's weekly allowance.
  // A warning is a confirmation step, not a block — `force` is the second pass
  // after they choose "Book anyway".
  const handleReserve = async (force = false) => {
    if (bookingClosed) { alert('Booking is closed — reservations close 12 hours before the session starts.'); return; }
    // #305: server-side belt for the button's own disabled state below —
    // this is a client-side gate, same tier as the cutoff check just above
    // it (no RLS/DB-level enforcement exists for either one today).
    if (gateBlocks && !pkgCheck.pkg) { alert('You need an active package for this session before you can reserve it.'); return; }
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!force) {
        const warning = await checkWeeklyBookingCap({
          playerId: user.id,
          self: true,
          slotDate: slot.slot_date,
          slotId: slot.id,
          slotSessionType: slot.session_type ?? null,
          slotCoach: coach,
          slotCoachId: slot.coach_id,
          purchases: ownedPurchases,
        });
        if (warning) { setCapWarning(warning); setLoading(false); return; }
      }
      // #428: count through the SECURITY DEFINER RPC. Counting the two tables
      // directly ran under THIS athlete's RLS (own rows only / staff only)
      // and returned 0 for every session they had not booked yet, so a full
      // session never looked full. The DB trigger below is the real gate;
      // this check just gives a clean early message.
      const maxPlayers = slot.max_players || 1;
      const { data: countRows, error: countErr } = await supabase.rpc('slot_booked_counts', {
        p_slot_ids: [slot.id], p_start: slot.slot_date, p_end: slot.slot_date,
      });
      if (countErr) throw countErr;
      const booked = (countRows || []).reduce((n, c) => n + (c.booked || 0), 0);
      if (booked >= maxPlayers) { alert('This session is now fully booked.'); setLoading(false); return; }
      const status = slot.auto_confirm ? 'confirmed' : 'pending';
      const { error } = await supabase.from('slot_reservations').insert({
        slot_id: slot.id, player_id: user.id, slot_date: slot.slot_date, status,
        player_note: playerNote || null, confirmed_at: slot.auto_confirm ? new Date().toISOString() : null
      });
      // P0428 = slot_reservations_capacity_guard: someone else took the last
      // spot between the count above and this insert.
      if (error && (error.code === 'P0428' || /fully booked/i.test(error.message || ''))) {
        alert('This session is now fully booked.'); onSuccess(); return;
      }
      if (error) throw error;
      // #305 warn mode: the booking went through without (or with a paused)
      // package — tell staff. After the insert, so a failed reservation is
      // never reported as a booking.
      if (gateComplaint && !flaggedRef.current) {
        flaggedRef.current = true;
        await flagAttempt('booked');
      }
      alert(slot.auto_confirm ? 'Reservation confirmed!' : 'Reservation submitted! Waiting for coach confirmation.');
      onSuccess();
    } catch (err) { alert('Error: ' + formatUserError(err)); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350 (Cordell, live): this card had no height cap and no scroll of its
          own. The backdrop is `fixed`, so the page behind it cannot scroll
          either, and `items-center` centred an over-tall card so it ran off
          BOTH edges of the screen. On a phone the package banner, the note box
          and the Reserve button were simply unreachable and the booking could
          not be completed at all. Same fix as CreateSlotPanel /
          EventDetailModal / FacilityEventDetail: cap the card, lay it out as a
          column, scroll the middle, and keep the footer buttons outside the
          scrolling body so they are on screen at every window height.
          overflow-hidden makes the cap authoritative; min-h-0 on the body is
          load-bearing, because a flex child's default min-height:auto would
          otherwise let the content push past the cap instead of scrolling
          inside it.
          Deliberately NO Escape / backdrop-close here: this modal holds what
          the parent typed into "What would you like to work on?", and a stray
          click on the dimmed area must not throw that away. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between gap-3 flex-shrink-0">
          <h3 className="text-xl font-bold text-gray-900 min-w-0 break-words">Reserve Training Slot</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div className="bg-teal-50 rounded-lg p-4">
            {/* #350: coach name, title and slot note are all free text. Without
                break-words one long unbroken value stretches this card wider
                than a phone screen and the page scrolls sideways. */}
            <div className="text-sm font-semibold text-teal-900 break-words">{coach?.full_name}</div>
            {coach?.title && <div className="text-xs text-teal-600 break-words">{coach.title}</div>}
            {coach?.skills && coach.skills.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {coach.skills.map(s => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-white text-teal-700 border border-teal-200">{s}</span>
                ))}
              </div>
            )}
            <div className="mt-2 text-sm text-gray-700">
              <div>{new Date(slot.slot_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
              <div>{formatTime(slot.start_time)} - {slot.duration_minutes} min</div>
            </div>
            {slot.notes && <div className="mt-2 text-xs text-gray-500 break-words whitespace-pre-wrap">{slot.notes}</div>}
          </div>
          {slot.is_subscription_session && (
            <div className="flex items-start space-x-2 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 text-sm text-teal-800">
              <ClipboardList size={16} className="mt-0.5 shrink-0 text-teal-600" />
              <span>{subNames.length ? <>Included with: <span className="font-medium">{subNames.join(', ')}</span>.</> : 'Package or membership required.'}</span>
            </div>
          )}
          {!pkgCheck.checking && (
            pkgCheck.pkg && pkgCheck.reason === 'paused' ? (
              // #305: a matching subscription exists but Square has it paused.
              // Held, bookable, flagged — never a lockout.
              <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                <span>Your <span className="font-medium">{pkgCheck.pkg.product_name_snapshot}</span> subscription is currently paused. You can still reserve this session — reach out to the front desk to resume it.</span>
              </div>
            ) : pkgCheck.pkg ? (
              <div className="flex items-start space-x-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800">
                <Check size={16} className="mt-0.5 shrink-0 text-green-600" />
                <span>
                  <span className="font-medium">Payment confirmed</span> — {pkgCheck.pkg.remaining_qty === null ? 'Monthly package' : `${pkgCheck.pkg.remaining_qty} session${pkgCheck.pkg.remaining_qty !== 1 ? 's' : ''} remaining`} on <span className="font-medium">{pkgCheck.pkg.product_name_snapshot}</span>.
                </span>
              </div>
            ) : gated ? (
              // #305: this session has a specific package attached — no
              // match means no booking, not a warning. Explains what's
              // needed rather than just disabling the button.
              <div className="flex items-start space-x-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                <span>
                  {pkgCheck.reason === 'expired'
                    ? <>Your {subNames.length ? <span className="font-medium">{subNames.join(', ')}</span> : 'package'} has expired. Renew it before reserving this session.</>
                    : pkgCheck.reason === 'no_sessions'
                    ? <>Your {subNames.length ? <span className="font-medium">{subNames.join(', ')}</span> : 'package'} has no sessions left. Purchase more before reserving this session.</>
                    : <>This session requires {subNames.length ? <span className="font-medium">{subNames.join(' or ')}</span> : 'a specific package'}. You don't currently have one — reach out to arrange payment before reserving.</>}
                  {!gateBlocks && (
                    // warn mode: say plainly that the button still works, so
                    // nobody reads the banner as a refusal and gives up.
                    <> You can still reserve this session today — if you&apos;ve already paid, no action is needed and we&apos;ll sort it out on our end.</>
                  )}
                </span>
              </div>
            ) : (
              // #341: this read "No active package found. Please ensure payment
              // has been arranged before reserving this slot." — an accusation
              // aimed at the athlete, at the worst possible moment. The query
              // above filters status in ('active','paid'), and every one of the
              // 130 lesson-pack purchases in production sits at 'pending' with
              // paid_at NULL because store_webhook_events has been empty since
              // June 2026, so this banner fires for pack holders who HAVE paid.
              // Reworded to state only what the portal knows about itself.
              // This branch is the UNGATED slot (nothing attached), so it is
              // informational in every gate mode — nothing about who may
              // reserve moves here.
              <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                <span>We don&apos;t have a package confirmed on your account for this session. You can still reserve it — if you&apos;ve already paid or have a pack, no action is needed and we&apos;ll sort it out on our end.</span>
              </div>
            )
          )}
          <div><label className="block text-sm font-medium text-gray-700 mb-1">What would you like to work on? (optional)</label><textarea value={playerNote} onChange={(e) => setPlayerNote(e.target.value)} placeholder="e.g., I want to work on my swing mechanics" rows="3" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          {slot.auto_confirm && <div className="flex items-center space-x-2 text-sm text-green-600"><Check size={16} /><span>This slot auto-confirms reservations</span></div>}
          {bookingClosed && (
            <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
              <span>Booking is closed — reservations close 12 hours before the session starts.</span>
            </div>
          )}
        </div>
        {/* #350: outside the scrolling body, so Reserve is on screen at any
            window height instead of running off the bottom of the phone. */}
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
          <button onClick={() => handleReserve(false)} disabled={loading || bookingClosed || pkgCheck.checking || (gateBlocks && !pkgCheck.pkg)} className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition disabled:opacity-50">{loading ? 'Reserving...' : 'Reserve'}</button>
        </div>
      </div>
      {/* #276: over the weekly allowance — a warning, not a block. */}
      {capWarning && (
        <BookingCapWarningModal
          message={capWarning}
          onCancel={() => setCapWarning(null)}
          onProceed={() => { setCapWarning(null); handleReserve(true); }}
        />
      )}
    </div>
  );
}

// ============================================
// PLAYER ADD GAME MODAL — players self-upload games to their schedule
// ============================================

function PlayerAddGameModal({ userId, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    title: '',
    event_date: fmtLocalDate(new Date()),
    event_time: '',
    event_end_time: '',
    location: '',
    address: '',
    notes: '',
  });
  const [timeTBD, setTimeTBD] = useState(false);
  // #190: repeat options. 'none' (default), 'weekly', 'biweekly', 'monthly'.
  const [repeat, setRepeat] = useState('none');
  const [repeatEnd, setRepeatEnd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const buildOccurrenceDates = (startDateStr, freq, endDateStr) => {
    if (freq === 'none' || !endDateStr) return [startDateStr];
    const start = new Date(startDateStr + 'T00:00:00');
    const end = new Date(endDateStr + 'T00:00:00');
    if (end < start) return [startDateStr];
    const stepDays = freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : 0;
    const stepMonths = freq === 'monthly' ? 1 : 0;
    const out = [];
    const cap = 104; // hard cap so a wrong end date can't insert thousands
    let d = new Date(start);
    while (d <= end && out.length < cap) {
      out.push(fmtLocalDate(d));
      if (stepDays) d.setDate(d.getDate() + stepDays);
      else if (stepMonths) d.setMonth(d.getMonth() + stepMonths);
      else break;
    }
    return out;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    if (repeat !== 'none' && !repeatEnd) {
      setError('Pick a "Repeat until" date to use a repeating game.');
      setLoading(false);
      return;
    }
    const dates = buildOccurrenceDates(formData.event_date, repeat, repeatEnd);
    const baseRow = {
      title: formData.title,
      opponent: formData.title,
      event_type: 'game',
      event_time: timeTBD ? null : (formData.event_time || null),
      event_end_time: timeTBD ? null : (formData.event_end_time || null),
      location: formData.location || null,
      address: formData.address || null,
      notes: formData.notes || null,
      player_id: userId,
      team_id: null,
      training_program_id: null,
      meal_plan_id: null,
    };
    const rows = dates.map(d => ({ ...baseRow, event_date: d }));
    const { error: insertError } = await supabase.from('schedule_events').insert(rows);
    if (insertError) { setError(insertError.message); setLoading(false); return; }
    setLoading(false);
    onSuccess();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350 sweep: same shape as ReserveSlotModal, and the same bug — this
          form is ~700px tall, so with no height cap and no scroll of its own
          the "Add to Schedule" button sat below the bottom of a phone screen
          and the game could not be saved. The <form> is the flex column so the
          submit button can stay in a footer outside the scrolling fields and
          still submit the form. No Escape / backdrop-close: this modal holds a
          half-typed game. */}
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between gap-3 flex-shrink-0">
          <h3 className="text-xl font-bold text-gray-900 min-w-0 break-words">Add a Game to My Schedule</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title / Opponent *</label>
            <input
              type="text"
              required
              placeholder="e.g., vs. Hawks"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
              <input
                type="date"
                required
                value={formData.event_date}
                onChange={(e) => setFormData({ ...formData, event_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Time {!timeTBD && '*'}</label>
              <input
                type="time"
                required={!timeTBD}
                disabled={timeTBD}
                value={timeTBD ? '' : formData.event_time}
                onChange={(e) => setFormData({ ...formData, event_time: e.target.value })}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
              <input
                type="time"
                disabled={timeTBD}
                value={timeTBD ? '' : formData.event_end_time}
                onChange={(e) => setFormData({ ...formData, event_end_time: e.target.value })}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={timeTBD}
                  onChange={(e) => setTimeTBD(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Time TBD</span>
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
            <input
              type="text"
              placeholder="e.g., Smith Park Field 3"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <input
              type="text"
              placeholder="Full address"
              value={formData.address}
              onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              rows={3}
              placeholder="Anything else (tournament name, uniform, etc.)"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="border-t border-gray-200 pt-3">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-gray-700">
              <Repeat size={16} className="text-gray-400" />
              <span>Repeat</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <select
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="none">Does not repeat</option>
                  <option value="weekly">Every week</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Every month</option>
                </select>
              </div>
              <div>
                <input
                  type="date"
                  value={repeatEnd}
                  onChange={(e) => setRepeatEnd(e.target.value)}
                  disabled={repeat === 'none'}
                  min={formData.event_date}
                  placeholder="Repeat until"
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${repeat === 'none' ? 'bg-gray-100 text-gray-400' : ''}`}
                />
              </div>
            </div>
            {repeat !== 'none' && (
              <p className="text-xs text-gray-500 mt-1">Creates one game per occurrence between the start date and "Repeat until" (max 104 occurrences).</p>
            )}
          </div>
        </div>
        {/* Outside the scrolling fields so it stays on screen at any height. */}
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
          <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
          <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Saving...' : 'Add to Schedule'}</button>
        </div>
        </form>
      </div>
    </div>
  );
}
