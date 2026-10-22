import React, { useState, useRef, useEffect } from 'react';
import { Bell, MessageSquare, Clock, Plane, ArrowLeftRight, Briefcase, Home, CreditCard, Trash2, AlertTriangle, Activity, CalendarPlus, HeartPulse, ClipboardList, Dumbbell, X } from 'lucide-react';
import { supabase } from './supabaseClient';
import { formatUserError } from './errorMessage';
import { PAYMENT_DUE_NOTICES_ENABLED } from './useNotifications';

// #307: a purchase that was actually paid for must never be deleted — that
// destroys the record that money came in and takes its session-usage history
// with it (store_session_usage.purchase_id is ON DELETE CASCADE). Paid
// purchases are refunded in Square, not deleted here. Same list
// PackagesModal.js:123 uses; duplicated rather than imported so this function
// carries its own guard wherever it is called from. Keep the two in step.
const DELETABLE_STATUSES = ['pending', 'canceled', 'failed'];

// #316: shared by App.js and WorkPortal.js — both render this bell and both
// need to delete a pending payment the same way. Was previously copy-pasted
// verbatim in both files; extracted here so there's one implementation.
//
// store_purchases_delete_admin (the RLS policy) is admin-only. A DELETE a
// non-admin isn't allowed to make returns NO error and ZERO rows — Postgres
// just matches nothing. Checking only `error` therefore lies: it looks
// successful. The .select('id') + length check below is load-bearing —
// don't simplify it away to a plain `if (error)`, or a coach-gated delete
// (should that ever come back) goes silent again.
export async function deletePendingPayment(purchaseId, productName, onSuccess) {
  // Read the purchase's own status instead of trusting the screen it was
  // clicked from. Today's only caller passes pending rows, but nothing in the
  // signature says so, and that stops being true the moment payments go live.
  const { data: purchase, error: readError } = await supabase
    .from('store_purchases')
    .select('status, paid_at')
    .eq('id', purchaseId)
    .maybeSingle();
  if (readError) { alert('Could not check this payment: ' + formatUserError(readError)); return; }
  if (!purchase) { alert('That payment could not be found. Refresh the page and try again.'); return; }
  if (purchase.paid_at || !DELETABLE_STATUSES.includes(purchase.status)) {
    alert('This purchase is no longer waiting for payment, so it cannot be deleted here. Handle it in Square instead.');
    return;
  }

  // #341: every row that reaches this function is status='pending' with no
  // paid_at (that's the only thing useMainPortalCounts selects), and pending
  // currently means "Square never told us" rather than "unpaid" — no payment
  // webhook has ever been delivered, so paid_at is NULL even on purchases
  // Cordell has confirmed were paid. The caution is therefore unconditional
  // here, unlike PackagesModal.deletePackage which can check hasPaymentDate.
  // Wording deliberately mirrors that screen's so the two tell one story.
  const unpaidWarning = '\n\nThis purchase has no payment confirmed in the portal. Square payment confirmations are not currently syncing, so it may still have been paid. Check Square before continuing.';
  if (!window.confirm(`Delete the pending payment for "${productName}"? This cannot be undone.${unpaidWarning}`)) return;
  // The same guard repeated as filters, so a purchase that gets paid between
  // the check above and this delete is left alone by the database itself.
  const { data, error } = await supabase
    .from('store_purchases')
    .delete()
    .eq('id', purchaseId)
    .is('paid_at', null)
    .in('status', DELETABLE_STATUSES)
    .select('id');
  if (error) { alert('Error deleting payment: ' + formatUserError(error)); return; }
  if (!data || data.length === 0) {
    alert('Nothing was deleted — you may not have permission to remove this payment, or it was paid in the meantime.');
    return;
  }
  onSuccess?.();
}

// #408: mark a facility-event assignment notice as seen. Writing a row here IS
// the dismissal — absence of a row is what the bell reads as "new".
//
// ignoreDuplicates: true is load-bearing, not a tidiness flag. It emits
// ON CONFLICT DO NOTHING, which needs only INSERT rights; a plain upsert emits
// ON CONFLICT DO UPDATE and needs an UPDATE policy that
// facility_event_notice_reads deliberately does not have (a dismissal is a
// fact with nothing to amend). Double-dismissing therefore keeps the first
// dismissed_at, which is the truer timestamp anyway.
export async function dismissEventAssignment(eventId, userId, onSuccess) {
  const { error } = await supabase
    .from('facility_event_notice_reads')
    .upsert({ event_id: eventId, user_id: userId }, { onConflict: 'event_id,user_id', ignoreDuplicates: true });
  // Deliberately quiet: this fires on a plain click-through to the calendar,
  // and an alert() would put a dialog between a coach and the event they were
  // trying to open. The notice simply reappears next refresh if the write
  // failed, which is the safe direction to fail in.
  if (error) { console.error('Could not dismiss event notice:', error); return; }
  onSuccess?.();
}

function fmtMoney(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function fmtSlotTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function NotificationBell({ currentPortal, mainCounts, workCounts, onJump, userRole, onDeletePayment, needsWhoop, onOpenWhoop, onDismissEventAssignment, onOpenAthletePt, onDismissPtNotice, onDismissAllPtNotices, onOpenWeeklyReminder, onDismissWeeklyReminder, onOpenWhoopNudge, onDismissWhoopNudge, checkinOpenCount = 0, onOpenCheckin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const total =
    (mainCounts?.unreadMessages || 0)
    + (mainCounts?.pendingSlots?.length || 0)
    // #341: excluded while PAYMENT_DUE_NOTICES_ENABLED is off, or the badge
    // would advertise notifications the panel below deliberately doesn't render.
    // #429: on again; the hook only returns rows isPayablePurchase() accepts.
    + (PAYMENT_DUE_NOTICES_ENABLED ? (mainCounts?.pendingPayments?.length || 0) : 0)
    + (mainCounts?.packageFlags?.length || 0)
    // #408: facility events this coach was tagged on and hasn't dismissed.
    + (mainCounts?.eventAssignments?.length || 0)
    // #402: PT entries logged on this coach/admin's athletes, not yet seen.
    + (mainCounts?.ptVisitNotices?.length || 0)
    // #438: this week's stats/PT check-in, until the athlete clears it.
    + (mainCounts?.weeklyReminders?.length || 0)
    + (mainCounts?.whoopNudges?.length || 0)
    + (checkinOpenCount > 0 ? 1 : 0)
    // #224: the WHOOP nudge counts as one. It clears itself the moment the
    // athlete connects — useWhoopNudge only ever sets this when the server
    // says `connected === false`, so there is no state to reset by hand.
    + (needsWhoop && onOpenWhoop ? 1 : 0)
    + (workCounts?.unreadMessages || 0)
    + (workCounts?.pendingHours?.length || 0)
    + (workCounts?.pendingTimeOff?.length || 0);

  const jump = (portal, view) => {
    setOpen(false);
    onJump?.(portal, view);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition"
      >
        <Bell size={22} />
        {total > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <h4 className="font-semibold text-gray-900 text-sm">Notifications</h4>
            <span className="text-xs text-gray-500">{total} new</span>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {total === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-500">No new notifications</div>
            )}

            {/* #224: WHOOP not connected. Players only, and only when the
                server has positively said so — see useWhoopNudge. Placed first
                because it is the one item here the athlete can act on in
                fifteen seconds, and because the summer outage means a lot of
                athletes believe they already did it. */}
            {needsWhoop && onOpenWhoop && (
              <button
                onClick={() => { setOpen(false); onOpenWhoop(); }}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><Activity size={16} className="text-emerald-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">Connect your WHOOP</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Your recovery, sleep and strain aren't syncing yet, so your programming
                      isn't using them. Tap to link it.
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Connected it before and still seeing this? Linking was broken until
                      1 September — please connect again.
                    </p>
                  </div>
                  {currentPortal !== 'main' && <PortalTag kind="main" />}
                </div>
              </button>
            )}

            {/* Main portal notifications */}
            {(mainCounts?.pendingSlots || []).map(req => (
              <button
                key={`main-slot-${req.id}`}
                onClick={() => jump('main', 'coach-tools')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><Clock size={16} className="text-yellow-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{req.users?.full_name || 'A player'}</span> requested a training session
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {(req.slot_date || req.slot?.slot_date) && fmtDate(req.slot_date || req.slot.slot_date)}
                      {req.slot?.start_time && ` at ${fmtSlotTime(req.slot.start_time)}`}
                    </p>
                  </div>
                  {currentPortal !== 'main' && <PortalTag kind="main" />}
                </div>
              </button>
            ))}

            {/* #305 (Q8): a player booked (warn mode) or was blocked (block
                mode) without a matching package — flagged so a coach can
                follow up. `outcome` / `reason` arrive once migration
                20260923_booking_package_flags_outcome has run; older rows
                read as blocked. */}
            {(mainCounts?.packageFlags || []).map(flag => (
              <button
                key={`main-pkg-flag-${flag.id}`}
                onClick={() => jump('main', 'coach-tools')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><AlertTriangle size={16} className="text-red-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{flag.users?.full_name || 'A player'}</span>{' '}
                      {flag.reason === 'paused'
                        ? 'booked with a paused subscription'
                        : flag.outcome === 'booked'
                          ? (flag.reason === 'expired' ? 'booked with an expired package'
                            : flag.reason === 'no_sessions' ? 'booked with no sessions left'
                            : 'booked without a package')
                          : 'tried to book without a package'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {flag.slot_date && fmtDate(flag.slot_date)}
                    </p>
                  </div>
                  {currentPortal !== 'main' && <PortalTag kind="main" />}
                </div>
              </button>
            ))}

            {/* #408: "when I tag a coach for creating a facility event it does
                not notify the coach". Clicking opens the calendar AND dismisses
                the notice — the click is the acknowledgement, so there's no
                separate "mark as read" to hunt for. The X dismisses without
                navigating, for a coach clearing the bell on their way past. */}
            {(mainCounts?.eventAssignments || []).map(ev => (
              <div
                key={`main-event-assign-${ev.id}`}
                className="w-full flex items-start hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <button
                  onClick={() => { onDismissEventAssignment?.(ev.id); jump('main', 'schedule'); }}
                  className="flex-1 text-left px-4 py-3 min-w-0"
                >
                  <div className="flex items-start space-x-3">
                    <div className="mt-0.5"><CalendarPlus size={16} className="text-blue-500" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">
                        You were added to <span className="font-medium">{ev.title || 'a facility event'}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {/* A repeating series shows its rule, not its start date — the
                            start is often weeks past and reads as stale/wrong. */}
                        {ev.is_recurring
                          ? 'Repeating event'
                          : (ev.event_date ? fmtDate(ev.event_date) : '')}
                        {ev.start_time && ` at ${fmtSlotTime(ev.start_time)}`}
                      </p>
                    </div>
                    {currentPortal !== 'main' && <PortalTag kind="main" />}
                  </div>
                </button>
                <button
                  onClick={() => onDismissEventAssignment?.(ev.id)}
                  title="Dismiss"
                  className="px-3 py-3 text-gray-400 hover:text-gray-700 transition shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            {/* #402: a PT entry was logged for one of this coach's athletes
                (facility-wide for an admin). The copy is deliberately only a
                name and a date. `pt_visits` holds minors' health data —
                pain_level, body_area, content, exercises — and none of it is
                fetched, let alone rendered; a coach who needs the detail opens
                the athlete's Physical Therapy tab, where the existing RLS and
                the existing screen decide what they see. Clicking dismisses
                and navigates, as with #408; the X dismisses in place. */}
            {/* #462: today's lift / session check-in, until every item is
                answered and every "doing" item is marked completed. */}
            {checkinOpenCount > 0 && onOpenCheckin && (
              <button
                onClick={() => { setOpen(false); onOpenCheckin(); }}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><Dumbbell size={16} className="text-blue-600" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 font-medium">Today's check-in</p>
                    <p className="text-xs text-gray-600 mt-0.5">{checkinOpenCount} lift or session{checkinOpenCount === 1 ? '' : 's'} today to check in or mark completed</p>
                  </div>
                  {currentPortal !== 'main' && <PortalTag kind="main" />}
                </div>
              </button>
            )}
            {/* #443: WHOOP coaching nudges (lift intensity, zone 5 time,
                pre-game strain, sleep, fuelling). Click-through opens the
                athlete's WHOOP tab and clears it; the X just clears it.
                Warnings (zone 5, pre-game) are amber; the rest are plain. */}
            {(mainCounts?.whoopNudges || []).map(n => (
              <div
                key={`main-whoop-nudge-${n.id}`}
                className="w-full flex items-start hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <button
                  onClick={() => {
                    onDismissWhoopNudge?.(n.id);
                    setOpen(false);
                    if (onOpenWhoopNudge) onOpenWhoopNudge();
                    else jump('main', 'profile');
                  }}
                  className="flex-1 text-left px-4 py-3 min-w-0"
                >
                  <div className="flex items-start space-x-3">
                    <div className="mt-0.5">
                      {n.severity === 'warning'
                        ? <AlertTriangle size={16} className="text-amber-600" />
                        : <Activity size={16} className="text-emerald-600" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 font-medium">{n.title}</p>
                      <p className="text-xs text-gray-600 mt-0.5">{n.body}</p>
                      <p className="text-xs text-gray-400 mt-0.5">WHOOP · opens your WHOOP tab</p>
                    </div>
                    {currentPortal !== 'main' && <PortalTag kind="main" />}
                  </div>
                </button>
                <button
                  onClick={() => onDismissWhoopNudge?.(n.id)}
                  title="Dismiss"
                  className="px-3 py-3 text-gray-400 hover:text-gray-700 transition shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {/* #438: the weekly stats / PT check-in. Click-through opens the
                athlete's own Stats tab and clears it; the X just clears it. */}
            {(mainCounts?.weeklyReminders || []).map(r => (
              <div
                key={`main-weekly-${r.id}`}
                className="w-full flex items-start hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <button
                  onClick={() => {
                    onDismissWeeklyReminder?.(r.id);
                    setOpen(false);
                    if (onOpenWeeklyReminder) onOpenWeeklyReminder();
                    else jump('main', 'profile');
                  }}
                  className="flex-1 text-left px-4 py-3 min-w-0"
                >
                  <div className="flex items-start space-x-3">
                    <div className="mt-0.5"><ClipboardList size={16} className="text-blue-600" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">
                        Weekly check-in: <span className="font-medium">update your game stats</span> and let your coach know about any PT or injury news
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">Week of {fmtDate(r.week_start)} · opens your Stats tab</p>
                    </div>
                    {currentPortal !== 'main' && <PortalTag kind="main" />}
                  </div>
                </button>
                <button
                  onClick={() => onDismissWeeklyReminder?.(r.id)}
                  title="Dismiss"
                  className="px-3 py-3 text-gray-400 hover:text-gray-700 transition shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            {(mainCounts?.ptVisitNotices || []).map(visit => (
              <div
                key={`main-pt-visit-${visit.id}`}
                className="w-full flex items-start hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <button
                  onClick={() => {
                    onDismissPtNotice?.(visit.id);
                    setOpen(false);
                    if (onOpenAthletePt) onOpenAthletePt(visit.player_id);
                    else jump('main', 'manage-athletes');
                  }}
                  className="flex-1 text-left px-4 py-3 min-w-0"
                >
                  <div className="flex items-start space-x-3">
                    <div className="mt-0.5"><HeartPulse size={16} className="text-rose-500" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">
                        New physical therapy entry for <span className="font-medium">{visit.playerName || 'an athlete'}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {/* visit_date is a Postgres `date`. fmtDate pins it to
                            local midnight — never toISOString().slice(0,10),
                            which prints a day early in the US. */}
                        {visit.visit_date ? `Visit ${fmtDate(visit.visit_date)}` : 'Open the athlete’s Physical Therapy tab'}
                      </p>
                    </div>
                    {currentPortal !== 'main' && <PortalTag kind="main" />}
                  </div>
                </button>
                <button
                  onClick={() => onDismissPtNotice?.(visit.id)}
                  title="Dismiss"
                  className="px-3 py-3 text-gray-400 hover:text-gray-700 transition shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            {/* An admin sees these facility-wide, so a busy PT week can arrive
                as a stack. One click clears the lot rather than an X each. */}
            {(mainCounts?.ptVisitNotices?.length || 0) > 1 && onDismissAllPtNotices && (
              <button
                onClick={() => onDismissAllPtNotices()}
                className="w-full text-right px-4 py-2 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                Dismiss {mainCounts.ptVisitNotices.length} physical therapy notices
              </button>
            )}

            {/* #341: the whole payment block — notice, checkout link and the
                admin delete button that hangs off it — is behind
                PAYMENT_DUE_NOTICES_ENABLED (defined in useNotifications.js —
                off 2026-08-16 → on again 2026-09-26 for #429; every pending
                row with a checkout_url is a real bill, see isPayablePurchase).
                This
                used to read "Payment due: … tap to
                complete payment" over a live Square checkout_url; with the
                payment webhook never firing, that told athletes who HAD paid
                that they owed money and gave them one click to pay twice.
                useMainPortalCounts also returns an empty list while the flag is
                off, so this map has nothing to iterate either way — the guard
                stays so the two can't drift apart. While it's off, the admin
                delete path for an unconfirmed purchase is PackagesModal
                (Packages screen), which carries the same Square caution; who
                may delete is unchanged (RLS: store_purchases_delete_admin).
                The copy below is what shows when the flag goes back on: it
                states only what we can evidence — that no confirmation has
                reached us — and never asserts a debt. */}
            {PAYMENT_DUE_NOTICES_ENABLED && (mainCounts?.pendingPayments || []).map(pay => (
              <div key={`main-pay-${pay.id}`} className="flex items-stretch border-b border-gray-100">
                <a
                  href={pay.checkout_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                  className="flex-1 text-left px-4 py-3 hover:bg-gray-50 transition"
                >
                  <div className="flex items-start space-x-3">
                    <div className="mt-0.5"><CreditCard size={16} className="text-gray-400" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">
                        Payment not confirmed: <span className="font-medium">{pay.product_name_snapshot}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {fmtMoney(pay.amount_cents)} · we haven't received a confirmation for this yet
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Already paid? You're all set — no action needed. If not, tap to finish checkout.
                      </p>
                    </div>
                    {currentPortal !== 'main' && <PortalTag kind="main" />}
                  </div>
                </a>
                {/* #316: matches store_purchases_delete_admin (RLS) — admin only.
                    Coaches used to see this button too and it silently no-op'd. */}
                {userRole === 'admin' && onDeletePayment && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeletePayment(pay.id, pay.product_name_snapshot); }}
                    className="px-3 text-gray-400 hover:text-red-600 hover:bg-red-50 transition flex items-center"
                    title="Delete this unconfirmed payment — check Square first (#341)"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}

            {(mainCounts?.unreadMessages > 0) && (
              <button
                onClick={() => jump('main', 'messages')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><MessageSquare size={16} className="text-blue-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{mainCounts.unreadMessages} unread message{mainCounts.unreadMessages !== 1 ? 's' : ''}</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">in your conversations</p>
                  </div>
                  {currentPortal !== 'main' && <PortalTag kind="main" />}
                </div>
              </button>
            )}

            {/* Work portal notifications */}
            {(workCounts?.unreadMessages > 0) && (
              <button
                onClick={() => jump('work', 'work-messages')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><MessageSquare size={16} className="text-indigo-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{workCounts.unreadMessages} unread Work message{workCounts.unreadMessages !== 1 ? 's' : ''}</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">in channels and DMs</p>
                  </div>
                  {currentPortal !== 'work' && <PortalTag kind="work" />}
                </div>
              </button>
            )}

            {(workCounts?.pendingHours || []).slice(0, 5).map(h => (
              <button
                key={`work-hr-${h.id}`}
                onClick={() => jump('work', 'work-admin-hours')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><Clock size={16} className="text-yellow-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{h.submitter?.full_name || 'A coach'}</span> submitted {Number(h.hours_decimal).toFixed(2)} hrs
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">on {fmtDate(h.work_date)}</p>
                  </div>
                  {currentPortal !== 'work' && <PortalTag kind="work" />}
                </div>
              </button>
            ))}

            {(workCounts?.pendingTimeOff || []).slice(0, 5).map(t => (
              <button
                key={`work-to-${t.id}`}
                onClick={() => jump('work', 'work-admin-time-off')}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="mt-0.5"><Plane size={16} className="text-yellow-500" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{t.submitter?.full_name || 'A coach'}</span> requested {(t.type || 'time off').toUpperCase()}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{fmtDate(t.start_date)}{t.end_date !== t.start_date && ` – ${fmtDate(t.end_date)}`}</p>
                  </div>
                  {currentPortal !== 'work' && <PortalTag kind="work" />}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PortalTag({ kind }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex items-center space-x-1 flex-shrink-0 ${
      kind === 'work' ? 'bg-indigo-800 text-indigo-50' : 'bg-blue-100 text-blue-700'
    }`}>
      {kind === 'work' ? <Briefcase size={10} /> : <Home size={10} />}
      <ArrowLeftRight size={9} />
    </span>
  );
}
