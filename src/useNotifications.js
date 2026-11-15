import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';
// #408: local-midnight date string. Deliberately the shared helper rather than
// toISOString().slice(0,10) — that's UTC, so from 2pm HST onward it reports
// tomorrow and silently drops today's events out of the "still live" window.
import { fmtLocalDate } from './scheduleUtils';

// #341 KILL SWITCH — was `false` from 2026-08-16 until #429 (2026-09-26).
//
// ON as of #429. The condition below was met: square-webhook was proven live
// on 2026-08-19 (portal checkout created 21:42, paid 21:45, no human), and by
// 2026-09-26 store_webhook_events held 3,172 rows with 15 purchases carrying a
// square_payment_id, the latest paid 2026-09-25. Meanwhile athletes assigned a
// package had NO way to pay it (Cordell: "losing thousands of dollars daily").
//
// Every pay link in the app goes through isPayablePurchase() below. #429
// first shipped with a date gate (PAYMENT_LINK_SAFE_SINCE = 2026-08-19, the
// day the webhook was proven live) on the theory that older 'pending' rows
// might already have been paid in Square with nobody told. Cordell checked:
// as of 2026-09-26 ALL 163 pending rows (135 pre-webhook, 117 athletes,
// oldest 2026-06-16) are genuinely unpaid, and their square.link URLs still
// resolve to live checkouts. So the gate is gone — pending + checkout_url is
// the whole rule. If a paid-but-pending batch ever turns up again, staff
// reconcile it (Work Portal → Store → Purchases), which flips status and
// removes the link; don't reintroduce a date.
//
// The original rationale, kept for the record. With the flag on, the
// athlete-facing "you still owe us" nudges come back:
// the NotificationBell row and the StoreModal "My Purchases" pay link, both of
// which point at a LIVE Square checkout_url. Measured against the LIVE database
// on 2026-08-16: `store_webhook_events` holds ZERO rows — Square's payment
// webhook has never delivered a single event since the store went up in June
// 2026 — so `paid_at` and `square_payment_id` are NULL on ALL 130 lesson-pack
// purchases and every one of them sits at status='pending' with a live
// checkout_url still attached.
//
// status='pending' therefore means "Square never told us", NOT "the athlete
// owes money". Cordell has confirmed that several of these were in fact paid in
// Square. With this on, an athlete who already paid is shown a red badge
// telling them a payment is due and is handed a one-click link that charges
// their card a second time. That is real money out of a real customer, so this
// stays off — the nudge is worth less than one double charge.
//
// THE ONE CONDITION FOR FLIPPING IT ON: Square payment confirmations verified
// arriving end to end — `store_webhook_events` receiving rows for new payments
// AND `paid_at` populating on the matching store_purchases. Nothing else counts;
// a fixed webhook subscription that has not yet been observed writing those two
// things is not evidence. Until then pending is unfalsifiable and we must not
// bill on it. See also the #305 BOOKING_GATE_ENABLED switch in Schedule.js,
// which is off for the same root cause (the same 130 pending purchases).
//
// When it does go back on, the copy must NOT return to "Payment due" — see the
// wording in NotificationBell.js / StoreModal.js, which states only what we can
// evidence ("Payment not confirmed") and tells an athlete who already paid that
// no action is needed.
export const PAYMENT_DUE_NOTICES_ENABLED = true;

// #429: the ONE rule for "may we show this athlete a pay link". Every consumer
// (NotificationBell, StoreModal, PackagesModal) uses this rather than testing
// status/checkout_url itself, so the rule cannot drift between them.
export function isPayablePurchase(p) {
  if (!PAYMENT_DUE_NOTICES_ENABLED) return false;
  return !!(p && p.status === 'pending' && p.checkout_url);
}

// #224 — Cordell asked for this in as many words: "Can you get a notification
// system to remind athletes who dont have their whoop connected to connect so
// we can start synching that data."
//
// It matters more than it looks. Measured against the live database on
// 2026-09-02: 20 of 976 athletes have a WHOOP linked. Most of that gap is not
// disinterest — WHOOP linking was silently broken from early June to 31 August
// (zero tokens created in that window; see the #394 investigation), so an
// athlete who tried over the summer clicked through, came back, and got
// nothing. They have no way of knowing it failed. This is what tells them.
//
// WHERE THE ANSWER COMES FROM. `users.whoop_connected` — the SAME column the
// whoop edge function itself treats as the source of truth (whoop/index.ts:479
// -483), and the same one it clears on disconnect (:324). A player can read
// their own row: the users SELECT policy is `id = auth.uid() OR
// get_user_is_staff()`.
//
// The first version of this asked the edge function instead, because
// `whoop_tokens` has RLS enabled with zero policies and the browser can never
// read it. That was true but beside the point — the flag we actually need is on
// the user's own row. Worse, that version depended on `getSession()` having a
// token at App mount and returned silently when it did not, with no retry and
// no log, so on a fresh sign-in it did nothing and said nothing. A plain
// PostgREST read is cheaper (one indexed row, not a function invocation on
// every player page load) and has no such ordering trap.
//
// IT FAILS CLOSED, AND THAT DIRECTION IS LOAD-BEARING. The nudge shows only
// when the read SUCCEEDS and the flag is not true. An error, a missing row, an
// unhydrated session — all leave it hidden, and all log. Getting this backwards
// would tell an athlete who IS connected to go and connect again, which is
// precisely the confusion #394 was about. A missed nudge costs nothing; a false
// one costs trust.
export function useWhoopNudge(userId, userRole) {
  const [needsWhoop, setNeedsWhoop] = useState(false);

  useEffect(() => {
    // Players only. Staff have no athlete data of their own to sync, and a
    // coach nagged on every page load is how a notification bell starts being
    // ignored.
    if (!userId || userRole !== 'player') {
      setNeedsWhoop(false);
      return;
    }
    let cancelled = false;

    const check = async () => {
      const { data, error } = await supabase
        .from('users')
        .select('whoop_connected')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        console.error('Whoop nudge: could not read whoop_connected (nudge stays hidden):', error.message);
        return false;
      }
      if (!data) {
        // RLS returning zero rows for your own id means the session was not
        // ready. Not an error to PostgREST, which is why this is logged
        // separately — a silent empty result is how the first version failed.
        console.warn('Whoop nudge: no user row returned yet (session not ready?)');
        return false;
      }
      if (!cancelled && data.whoop_connected !== true) setNeedsWhoop(true);
      return true;
    };

    (async () => {
      const ok = await check();
      // One retry. On a fresh sign-in the auth session can still be hydrating
      // when App mounts; without this the check runs once, too early, and never
      // runs again because neither dependency changes afterwards.
      if (!ok && !cancelled) {
        setTimeout(() => { if (!cancelled) check(); }, 1500);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, userRole]);

  return needsWhoop;
}

// ---------------------------------------------------------------------------
// #402 — tell a coach (and the admins) when a PT entry lands on one of their
// athletes. Cordell: "Coaches / admins currently don't see or know when a
// player has input anything into the physical therapy section."
//
// WHAT THIS ACTUALLY NOTIFIES ON, WHICH IS NOT QUITE WHAT THE ISSUE SAYS.
// Measured against the live database 2026-09-21: `pt_visits` INSERT/UPDATE/
// DELETE are staff-only ("staff insert pt visits" etc., all
// `get_user_role() = ANY ('admin','coach')`), and a player's only policy is
// `view own pt visits` (SELECT, `player_id = auth.uid()`). An athlete
// therefore CANNOT write a PT row today — every one of the 2 rows in the
// table was created by an admin. So this notifies on "a PT entry was logged
// for this athlete", by whoever logged it, which is the real event behind the
// request. If athlete-entered PT is ever added, this picks it up unchanged.
//
// SCOPE. PT visits only. The issue's second sentence ("any update on a
// players profile") would notify on every profile field in the app; that is a
// separate piece of work and is deliberately not built here.
//
// WHY THE READ MARKER IS IN localStorage AND NOT A TABLE. The count itself is
// derived — it is just `pt_visits` rows newer than a marker, the same shape as
// unread messages. The only thing that needs storing is the marker. There is
// no general-purpose per-user "last seen" table in this database (checked:
// the only *_reads tables are `message_reads`, `work_message_reads` and
// `facility_event_notice_reads`, all bound to their own feature's FK), so a
// server-side marker means new DDL — a table, three policies and a GRANT —
// that cannot be applied from here and would leave the feature dead on
// arrival until someone ran it. `nbp_book_welcome_seen` (PublicBookingPage)
// and the ExerciseVideoGaps exclusion list are the existing precedent for a
// per-browser "seen" marker in this app. The cost is real and is stated in the
// report: the marker is per browser, so a coach who uses a laptop and a phone
// dismisses the same notice twice.
//
// IT FAILS CLOSED IN EVERY DIRECTION THAT MATTERS. This table holds minors'
// health data. Every path that cannot positively establish both "this row is
// new to me" and "this athlete is mine" renders NOTHING: storage unreadable,
// roster lookup errored, visit query errored — all set an empty list and log.
// The first run on a browser records the marker and shows nothing at all,
// rather than dumping the backlog. And the query never asks for `pain_level`,
// `body_area`, `content` or `exercises` — the clinical columns are not
// fetched, so they cannot leak into the bell even by a later rendering
// mistake. Athlete name and date are the whole payload.
export const PT_NOTICE_LOOKBACK_DAYS = 30;
const PT_NOTICE_LIMIT = 50;
const PT_NOTICE_STORAGE_PREFIX = 'nbp.ptVisitNotices.v1.';

function ptNoticeStorageKey(userId) {
  return `${PT_NOTICE_STORAGE_PREFIX}${userId}`;
}

// { since: ISO string | null, dismissed: string[], available: boolean }.
// `available: false` means storage is unusable (private mode, blocked site
// data). We cannot record a dismissal in that state, so the caller shows
// nothing rather than nagging a coach with a notice they can never clear.
export function readPtNoticeMarker(userId) {
  if (!userId) return { since: null, dismissed: [], available: false };
  try {
    const raw = window.localStorage.getItem(ptNoticeStorageKey(userId));
    if (!raw) return { since: null, dismissed: [], available: true };
    const parsed = JSON.parse(raw);
    return {
      since: typeof parsed?.since === 'string' ? parsed.since : null,
      dismissed: Array.isArray(parsed?.dismissed) ? parsed.dismissed.filter(v => typeof v === 'string') : [],
      available: true,
    };
  } catch {
    return { since: null, dismissed: [], available: false };
  }
}

export function writePtNoticeMarker(userId, marker) {
  if (!userId) return false;
  try {
    window.localStorage.setItem(ptNoticeStorageKey(userId), JSON.stringify({
      since: marker?.since || null,
      dismissed: Array.isArray(marker?.dismissed) ? marker.dismissed : [],
    }));
    return true;
  } catch {
    return false;
  }
}

// Dismissing one notice. Quiet on failure for the same reason
// dismissEventAssignment is: this fires on a plain click-through to the
// athlete's profile, and an alert() would put a dialog between a coach and the
// thing they were trying to open. The notice simply comes back next refresh.
export function dismissPtVisitNotice(visitId, userId, onSuccess) {
  if (!visitId || !userId) return;
  const marker = readPtNoticeMarker(userId);
  if (!marker.available) {
    console.error('PT notices: browser storage unavailable, cannot record dismissal');
    return;
  }
  if (marker.dismissed.includes(visitId)) { onSuccess?.(); return; }
  const ok = writePtNoticeMarker(userId, {
    // A dismissal before the marker has ever been written would otherwise
    // leave `since` null and re-trigger the first-run path, wiping it.
    since: marker.since || new Date().toISOString(),
    dismissed: [...marker.dismissed, visitId],
  });
  if (!ok) { console.error('PT notices: could not record dismissal'); return; }
  onSuccess?.();
}

// "Mark all as read": move the high-water mark to now and drop the per-id
// list, which is then redundant — everything it held is now behind `since`.
export function markAllPtVisitNoticesSeen(userId, onSuccess) {
  if (!userId) return;
  const ok = writePtNoticeMarker(userId, { since: new Date().toISOString(), dismissed: [] });
  if (!ok) { console.error('PT notices: could not mark notices seen'); return; }
  onSuccess?.();
}

// Which athletes count as this coach's. Reuses the resolution the app already
// uses everywhere else (Profile.js `fetchCoachAthletes`): explicit
// `player_profiles.trainer_id` assignment, plus every player on a team the
// coach belongs to. Returns a Set, or null if any read failed — null means
// "we don't know", and the caller shows nothing rather than guessing.
//
// The Set is a membership test against `pt_visits.player_id`, so there is
// deliberately no `users.role = 'player'` filter on the team members: a coach
// id in the set can only match a row if someone logged a PT visit against a
// coach, and the extra query to exclude that costs more than it is worth.
//
// NOTE the direction of the filtering. The roster is NOT sent to PostgREST as
// an `.in()` list — measured on the live database, the largest coach roster
// derives to 642 athletes, which is a ~24KB URL. The visits are fetched first
// (a small, bounded query) and intersected here in the browser instead.
async function fetchCoachAthleteIds(coachId) {
  const { data: assigned, error: assignedError } = await supabase
    .from('player_profiles')
    .select('user_id')
    .eq('trainer_id', coachId);
  if (assignedError) {
    console.error('PT notices: could not read assigned athletes (notices stay hidden):', assignedError.message);
    return null;
  }

  const { data: myTeams, error: myTeamsError } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', coachId);
  if (myTeamsError) {
    console.error('PT notices: could not read coach teams (notices stay hidden):', myTeamsError.message);
    return null;
  }

  const ids = new Set((assigned || []).map(r => r.user_id).filter(Boolean));
  const teamIds = [...new Set((myTeams || []).map(r => r.team_id).filter(Boolean))];
  if (teamIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .from('team_members')
      .select('user_id')
      .in('team_id', teamIds);
    if (membersError) {
      console.error('PT notices: could not read team rosters (notices stay hidden):', membersError.message);
      return null;
    }
    (members || []).forEach(m => {
      if (m.user_id && m.user_id !== coachId) ids.add(m.user_id);
    });
  }
  return ids;
}

async function fetchWorkDmThreadIdsForUser(userId) {
  const [asUserA, asUserB] = await Promise.all([
    supabase.from('work_dm_threads').select('id').eq('user_a_id', userId),
    supabase.from('work_dm_threads').select('id').eq('user_b_id', userId),
  ]);
  if (asUserA.error) throw asUserA.error;
  if (asUserB.error) throw asUserB.error;
  return Array.from(new Set([...(asUserA.data || []).map(row => row.id), ...(asUserB.data || []).map(row => row.id)]));
}

// Counts and details for the Main Portal: unread chat messages + (coach/admin) pending slot reservations.
// #408: is a facility event still live — i.e. worth telling a coach they've
// been added to it? A one-off counts if it hasn't happened yet. A repeating
// event counts while its rule is still running, which is NOT what its own
// event_date says: that's the series START, so an active Monday series that
// began in August has an event_date six weeks in the past. Reading the rule
// instead is the difference between notifying on live series and notifying
// on none of them.
//
// recurrence_rule shape, from the live table: { freq, interval, byDay[],
// endType: 'never' | 'until', until: 'YYYY-MM-DD' }. Anything unrecognised
// is treated as live — a coach seeing one notice too many is a smaller
// failure than the silence #408 was filed about.
function isFacilityEventLive(ev, todayStr) {
  if (!ev) return false;
  if (!ev.is_recurring) return (ev.event_date || '') >= todayStr;
  const rule = ev.recurrence_rule || {};
  if (rule.endType === 'until' && rule.until) return rule.until >= todayStr;
  return true;
}

// #402 — the unseen PT visits this coach/admin should know about. Returns a
// (possibly empty) array; it never throws and never returns a partial guess.
// Every failure path returns [] and logs, because the alternative — showing a
// coach a notice about an athlete who may not be theirs — is the one outcome
// that is worse than silence.
//
// A coach is not told about a PT entry they wrote themselves, the same way
// unread messages skip your own (`neq('sender_id', userId)` above).
async function fetchPtVisitNotices(userId, userRole) {
  if (!userId || (userRole !== 'coach' && userRole !== 'admin')) return [];

  const marker = readPtNoticeMarker(userId);
  if (!marker.available) {
    console.error('PT notices: browser storage unavailable, notices stay hidden');
    return [];
  }
  if (!marker.since) {
    // First run on this browser. Record "from now on" and show nothing —
    // otherwise every historical PT entry arrives at once, which is exactly
    // the un-backfilled flood #408 had to guard against.
    writePtNoticeMarker(userId, { since: new Date().toISOString(), dismissed: [] });
    return [];
  }

  // Clamp the window. A marker from months ago (a coach back off a long
  // break) must not produce a wall of notices; 30 days is as far back as
  // anything here is still worth acting on.
  const sinceMs = Date.parse(marker.since);
  const floorMs = Math.max(
    Number.isNaN(sinceMs) ? 0 : sinceMs,
    Date.now() - PT_NOTICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  // Clinical columns are deliberately absent from this select — see the
  // block comment above. created_at (timestamptz) is what "new" is measured
  // on; visit_date is a `date` and is only ever formatted for display.
  const { data: visits, error: visitsError } = await supabase
    .from('pt_visits')
    .select('id, player_id, visit_date, created_at, created_by')
    .gt('created_at', new Date(floorMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(PT_NOTICE_LIMIT);
  if (visitsError) {
    console.error('PT notices: could not read pt_visits (notices stay hidden):', visitsError.message);
    return [];
  }

  const rows = visits || [];

  // Keep the dismissed list from growing forever: anything no longer in the
  // window can never come back, so it no longer needs remembering.
  const visibleIds = new Set(rows.map(v => v.id));
  const keptDismissed = marker.dismissed.filter(id => visibleIds.has(id));
  if (keptDismissed.length !== marker.dismissed.length) {
    writePtNoticeMarker(userId, { since: marker.since, dismissed: keptDismissed });
  }

  const dismissed = new Set(keptDismissed);
  const candidates = rows.filter(v => v.created_by !== userId && !dismissed.has(v.id));
  if (candidates.length === 0) return [];

  // Admins are facility-wide — Cordell asked for "their coaches and the
  // admins", and an admin is not scoped to a roster anywhere else in this
  // app. A coach is scoped to their own athletes.
  let mine = candidates;
  if (userRole !== 'admin') {
    const athleteIds = await fetchCoachAthleteIds(userId);
    if (!athleteIds) return [];
    mine = candidates.filter(v => athleteIds.has(v.player_id));
  }
  if (mine.length === 0) return [];

  // Simple select, not an embed: a join whose embedded table is RLS-blocked
  // comes back as `users: null` with a 200, which looks like a nameless
  // athlete rather than a failure. `mine` is capped by PT_NOTICE_LIMIT, so
  // this `.in()` list is small.
  const playerIds = [...new Set(mine.map(v => v.player_id).filter(Boolean))];
  const { data: people, error: peopleError } = await supabase
    .from('users')
    .select('id, full_name')
    .in('id', playerIds);
  if (peopleError) {
    console.error('PT notices: could not read athlete names (notices stay hidden):', peopleError.message);
    return [];
  }
  const nameById = new Map((people || []).map(p => [p.id, p.full_name]));
  return mine.map(v => ({ ...v, playerName: nameById.get(v.player_id) || null }));
}

// #438: Monday of the week containing `d`, local time, as YYYY-MM-DD — the
// same key the weekly-reminders edge function writes (facility time; the
// athlete's browser is in the same timezone for all practical purposes, and a
// one-day skew at the edges only delays the bell item, never duplicates it).
export function weekStartFor(d = new Date()) {
  const m = new Date(d);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return fmtLocalDate(m);
}

// #438: the athlete clears this week's reminder from the bell. Own-row UPDATE
// under RLS; the cron never un-dismisses, so once cleared it stays cleared.
// #443: the athlete clears a WHOOP nudge from the bell. Own-row UPDATE under
// RLS (whoop_nudges_update_own); the rules never re-insert a dismissed row
// because the (athlete, kind, source_key) unique key still exists.
export async function dismissWhoopNudge(nudgeId, onSuccess) {
  if (!nudgeId) return;
  const { error } = await supabase
    .from('whoop_nudges')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', nudgeId);
  if (error) { console.error('WHOOP nudge dismiss failed:', error); return; }
  onSuccess?.();
}

export async function dismissWeeklyReminder(reminderId, onSuccess) {
  if (!reminderId) return;
  const { error } = await supabase
    .from('weekly_reminders')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', reminderId);
  if (error) { console.error('Weekly reminder dismiss failed:', error); return; }
  onSuccess?.();
}

export function useMainPortalCounts(userId, userRole) {
  const [unreadMessages, setUnreadMessages] = useState(0);
  // #438: this week's undismissed stats/PT reminder rows for the signed-in
  // athlete (one, in practice). Written by the weekly-reminders cron.
  const [weeklyReminders, setWeeklyReminders] = useState([]);
  // #443: undismissed WHOOP coaching nudges for the signed-in athlete, newest
  // first. Written server-side by the whoop edge function after each sync.
  const [whoopNudges, setWhoopNudges] = useState([]);
  const [pendingSlots, setPendingSlots] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [packageFlags, setPackageFlags] = useState([]);
  const [eventAssignments, setEventAssignments] = useState([]);
  const [ptVisitNotices, setPtVisitNotices] = useState([]);
  // #492: NBP+ agreements signed with a custom monthly price that NBP has not
  // countersigned yet. Admins only — the price is theirs to approve.
  const [agreementSignoffs, setAgreementSignoffs] = useState([]);

  const refresh = useCallback(async () => {
    if (!userId) return;

    // Pending payments assigned to / started by this user (#213). Surfaces a
    // nudge that links straight to Square checkout.
    //
    // #341: gated on PAYMENT_DUE_NOTICES_ENABLED (see the block at the top of
    // this file). While it's off we don't even ASK for these rows: an
    // unrendered checkout_url is still a live "charge me again" URL sitting in
    // the client, and NotificationBell sums this array into its unread badge —
    // so leaving it empty is also what stops the bell reading "1 new" with
    // nothing underneath it. The consumers gate on the flag too; this is the
    // belt to their braces, not a substitute for it.
    if (PAYMENT_DUE_NOTICES_ENABLED) {
      try {
        const { data: pays } = await supabase
          .from('store_purchases')
          .select('id, product_name_snapshot, amount_cents, checkout_url, created_at')
          .eq('user_id', userId)
          .eq('status', 'pending')
          .not('checkout_url', 'is', null)
          .order('created_at', { ascending: false })
          .limit(10);
        setPendingPayments((pays || []).filter(isPayablePurchase));
      } catch (e) { console.error('Pending payments error:', e); }
    } else {
      setPendingPayments([]);
    }

    // #438: the row the cron wrote for this week, if the athlete hasn't
    // cleared it. RLS scopes to own rows; the user_id filter is belt-and-braces.
    // Fails to EMPTY so a missing table (migration pending) never takes the
    // rest of the bell down.
    try {
      const { data: wr, error: wrErr } = await supabase
        .from('weekly_reminders')
        .select('id, week_start, kind, sent_at, created_at')
        .eq('user_id', userId)
        .eq('week_start', weekStartFor())
        .is('dismissed_at', null)
        .limit(3);
      if (wrErr) throw wrErr;
      setWeeklyReminders(wr || []);
    } catch (e) {
      console.error('Weekly reminders error (migration pending?):', e);
      setWeeklyReminders([]);
    }

    // #443: own undismissed WHOOP nudges. Players only — staff have no WHOOP
    // of their own and the rows are keyed on the athlete. Fails to EMPTY so a
    // missing table never takes the rest of the bell down.
    if (userRole === 'player') {
      try {
        const { data: wn, error: wnErr } = await supabase
          .from('whoop_nudges')
          .select('id, kind, severity, title, body, occurred_on, created_at')
          .eq('athlete_id', userId)
          .is('dismissed_at', null)
          .order('created_at', { ascending: false })
          .limit(8);
        if (wnErr) throw wnErr;
        setWhoopNudges(wn || []);
      } catch (e) {
        console.error('WHOOP nudges error (migration pending?):', e);
        setWhoopNudges([]);
      }
    } else {
      setWhoopNudges([]);
    }

    try {
      const { data: pRows } = await supabase.from('conversation_participants').select('conversation_id').eq('user_id', userId);
      const convIds = (pRows || []).map(p => p.conversation_id);
      if (convIds.length > 0) {
        const { data: msgs } = await supabase.from('messages').select('id').in('conversation_id', convIds).neq('sender_id', userId);
        const ids = (msgs || []).map(m => m.id);
        if (ids.length > 0) {
          const { data: reads } = await supabase.from('message_reads').select('message_id').eq('user_id', userId).in('message_id', ids);
          const readSet = new Set((reads || []).map(r => r.message_id));
          setUnreadMessages(ids.filter(id => !readSet.has(id)).length);
        } else setUnreadMessages(0);
      } else setUnreadMessages(0);
    } catch (e) { console.error('Main unread error:', e); }

    if (userRole === 'coach' || userRole === 'admin') {
      try {
        const { data: slots } = await supabase.from('training_slots').select('id, slot_date, start_time').eq('coach_id', userId);
        const slotIds = (slots || []).map(s => s.id);
        if (slotIds.length > 0) {
          const { data: pending } = await supabase
            .from('slot_reservations')
            .select('id, slot_id, slot_date, users:player_id(full_name)')
            .in('slot_id', slotIds)
            .eq('status', 'pending');
          const detailed = (pending || []).map(p => ({ ...p, slot: slots.find(s => s.id === p.slot_id) }));
          setPendingSlots(detailed);
        } else setPendingSlots([]);
      } catch (e) { console.error('Pending slots error:', e); }

      // #305 (Q8): players blocked from booking for lack of a matching
      // package, flagged from ReserveSlotModal. Scoped to coach_id = userId
      // same as pendingSlots above — a coach sees flags for their own
      // slots; an admin sees flags for slots where THEY are the coach on
      // record, not a facility-wide list (matches the existing pattern
      // here rather than inventing a separate admin-only view).
      try {
        const { data: flags } = await supabase
          .from('booking_package_flags')
          .select('id, player_id, slot_id, slot_date, created_at, outcome, reason, users:player_id(full_name)')
          .eq('coach_id', userId)
          .order('created_at', { ascending: false })
          .limit(10);
        setPackageFlags(flags || []);
      } catch (e) {
        // #305: booking_package_flags doesn't exist until its migration
        // (20260812_booking_package_flags.sql) runs.
        console.error('Package flags error (migration pending?):', e);
        setPackageFlags([]);
      }

      // #408: "when I tag a coach on a facility event it does not notify the
      // coach". coach_ids already recorded the assignment; nothing ever told
      // them. A notice is an assignment with no dismissal row against it.
      //
      // Masters and standalone rows only (recurrence_parent_id IS NULL): a
      // coach is added to a SERIES, so one notice covers it. Without this
      // filter every moved/cancelled occurrence child — which carries its own
      // copy of coach_ids — would notify all over again, weekly.
      try {
        const todayStr = fmtLocalDate(new Date());
        const { data: assigned } = await supabase
          .from('facility_events')
          .select('id, title, event_date, start_time, is_recurring, recurrence_rule')
          .contains('coach_ids', [userId])
          .is('recurrence_parent_id', null)
          .order('event_date', { ascending: true })
          .limit(200);
        const live = (assigned || []).filter(ev => isFacilityEventLive(ev, todayStr));
        if (live.length === 0) {
          setEventAssignments([]);
        } else {
          // Ask only about the events we'd actually show. RLS already scopes
          // this table to own rows, so the user_id filter is belt-and-braces
          // rather than the thing keeping other coaches' rows out.
          const { data: dismissed } = await supabase
            .from('facility_event_notice_reads')
            .select('event_id')
            .eq('user_id', userId)
            .in('event_id', live.map(ev => ev.id));
          const seen = new Set((dismissed || []).map(r => r.event_id));
          setEventAssignments(live.filter(ev => !seen.has(ev.id)));
        }
      } catch (e) {
        // facility_event_notice_reads doesn't exist until its migration
        // (20260910_facility_event_notice_reads.sql) runs. Fail to EMPTY, not
        // to "everything is unread" — the un-backfilled state would hand
        // Cordell 109 notices for events he created himself.
        console.error('Event assignments error (migration pending?):', e);
        setEventAssignments([]);
      }

      // #402: PT entries logged against this staff member's athletes that
      // they have not seen yet. fetchPtVisitNotices never throws and returns
      // [] on every failure; the try/catch is belt-and-braces so a surprise
      // here cannot take the rest of the bell down with it.
      try {
        setPtVisitNotices(await fetchPtVisitNotices(userId, userRole));
      } catch (e) {
        console.error('PT notices error (notices stay hidden):', e);
        setPtVisitNotices([]);
      }

      // #492: custom-price agreements waiting for NBP's sign-off. Clears
      // itself when an admin or coach countersigns.
      if (userRole === 'admin') {
        try {
          const { data: custom, error: customErr } = await supabase
            .from('nbp_plus_agreements')
            .select('id, user_id, athlete_name, term_months, custom_monthly_cents, athlete_signed_at')
            .not('custom_monthly_cents', 'is', null)
            .is('nbp_signed_at', null)
            .order('athlete_signed_at', { ascending: false })
            .limit(20);
          if (customErr) throw customErr;
          setAgreementSignoffs(custom || []);
        } catch (e) {
          console.error('Agreement sign-off notices error:', e);
          setAgreementSignoffs([]);
        }
      } else {
        setAgreementSignoffs([]);
      }
    } else {
      setPendingSlots([]);
      setPackageFlags([]);
      setEventAssignments([]);
      setPtVisitNotices([]);
      setAgreementSignoffs([]);
    }
  }, [userId, userRole]);

  useEffect(() => {
    refresh();
    // Scope channel names by userId so two simultaneous mounts of the same
    // hook (portal swap mid-flight, multi-tab) don't collide on a shared
    // channel and trigger double-processing.
    const ch1 = supabase.channel(`main-notif-messages-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, refresh).subscribe();
    const ch2 = supabase.channel(`main-notif-slots-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'slot_reservations' }, refresh).subscribe();
    const ch3 = supabase.channel(`main-notif-reads-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'message_reads' }, refresh).subscribe();
    const ch4 = supabase.channel(`main-notif-payments-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'store_purchases' }, refresh).subscribe();
    const ch5 = supabase.channel(`main-notif-pkg-flags-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'booking_package_flags' }, refresh).subscribe();
    // #408: watch facility_events so being tagged lands in the bell without a
    // reload — the whole complaint was that nothing told the coach. UPDATE
    // matters as much as INSERT here: the reported case is being added to an
    // event that already exists, which is an UPDATE to coach_ids.
    const ch6 = supabase.channel(`main-notif-facility-events-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'facility_events' }, refresh).subscribe();
    // #402. BE AWARE: this is a no-op today and is here for the day it isn't.
    // Checked against the live database 2026-09-21 — `supabase_realtime`
    // publishes only messages, message_reads, slot_reservations,
    // staff_announcements, staff_hour_entries, staff_schedule_events,
    // staff_schedule_assignments, staff_time_off_requests, work_messages,
    // work_message_reads and work_dm_threads. `pt_visits` is not in it (nor
    // are facility_events, booking_package_flags or store_purchases, so ch4,
    // ch5 and ch6 above are already dead in the same way). Until someone runs
    // `ALTER PUBLICATION supabase_realtime ADD TABLE pt_visits;`, a PT notice
    // lands on the next refresh — a page load, a portal swap, or any message
    // or reservation event — not the instant it is written.
    const ch7 = supabase.channel(`main-notif-pt-visits-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'pt_visits' }, refresh).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); supabase.removeChannel(ch4); supabase.removeChannel(ch5); supabase.removeChannel(ch6); supabase.removeChannel(ch7); };
  }, [refresh, userId]);

  return { unreadMessages, pendingSlots, pendingPayments, packageFlags, eventAssignments, ptVisitNotices, agreementSignoffs, weeklyReminders, whoopNudges, refresh };
}

// Counts and details for the Work Portal: unread work messages + (admin) pending hours + pending time off.
export function useWorkPortalCounts(userId, userRole) {
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [pendingHours, setPendingHours] = useState([]);
  const [pendingTimeOff, setPendingTimeOff] = useState([]);

  const refresh = useCallback(async () => {
    if (!userId || (userRole !== 'admin' && userRole !== 'coach')) {
      setUnreadMessages(0);
      setPendingHours([]);
      setPendingTimeOff([]);
      return;
    }

    // Unread work messages
    try {
      const [chRes, dmIds, readsRes] = await Promise.all([
        supabase.from('work_channels').select('id'),
        fetchWorkDmThreadIdsForUser(userId),
        supabase.from('work_message_reads').select('channel_id, dm_thread_id, last_read_at').eq('user_id', userId),
      ]);
      const channelIds = (chRes.data || []).map(c => c.id);
      const readsByChannel = {}, readsByDm = {};
      (readsRes.data || []).forEach(r => {
        if (r.channel_id) readsByChannel[r.channel_id] = r.last_read_at;
        else if (r.dm_thread_id) readsByDm[r.dm_thread_id] = r.last_read_at;
      });
      let count = 0;
      if (channelIds.length > 0) {
        const { data } = await supabase.from('work_messages').select('channel_id, created_at, sender_id').in('channel_id', channelIds);
        (data || []).forEach(m => {
          if (m.sender_id === userId) return;
          const lr = readsByChannel[m.channel_id];
          if (!lr || new Date(m.created_at) > new Date(lr)) count++;
        });
      }
      if (dmIds.length > 0) {
        const { data } = await supabase.from('work_messages').select('dm_thread_id, created_at, sender_id').in('dm_thread_id', dmIds);
        (data || []).forEach(m => {
          if (m.sender_id === userId) return;
          const lr = readsByDm[m.dm_thread_id];
          if (!lr || new Date(m.created_at) > new Date(lr)) count++;
        });
      }
      setUnreadMessages(count);
    } catch (e) { console.error('Work unread error:', e); }

    if (userRole === 'admin') {
      try {
        const [hRes, tRes] = await Promise.all([
          supabase.from('staff_hour_entries').select('id, work_date, hours_decimal, submitter:user_id(full_name)').eq('status', 'pending').order('work_date', { ascending: false }).limit(10),
          supabase.from('staff_time_off_requests').select('id, type, start_date, end_date, submitter:user_id(full_name)').eq('status', 'pending').order('start_date', { ascending: false }).limit(10),
        ]);
        setPendingHours(hRes.data || []);
        setPendingTimeOff(tRes.data || []);
      } catch (e) { console.error('Work pending error:', e); }
    } else {
      setPendingHours([]);
      setPendingTimeOff([]);
    }
  }, [userId, userRole]);

  useEffect(() => {
    refresh();
    const ch1 = supabase.channel(`work-notif-messages-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'work_messages' }, refresh).subscribe();
    const ch2 = supabase.channel(`work-notif-reads-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'work_message_reads' }, refresh).subscribe();
    const ch3 = supabase.channel(`work-notif-hours-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'staff_hour_entries' }, refresh).subscribe();
    const ch4 = supabase.channel(`work-notif-time-off-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'staff_time_off_requests' }, refresh).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); supabase.removeChannel(ch4); };
  }, [refresh, userId]);

  return { unreadMessages, pendingHours, pendingTimeOff, refresh };
}
