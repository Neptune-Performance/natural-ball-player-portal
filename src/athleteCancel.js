// #477: an athlete cancels their own lesson / session.
//
// Cordell: clients should be able to cancel directly when they know 5+ days
// ahead, so coaches stop removing athletes by hand from a "please cancel me"
// message. The rule:
//
//   5+ days before the start  -> the athlete cancels themselves, and it is
//                                FREE: cancel_reason = 'athlete_early', which
//                                the Cancellations review screen treats as
//                                settled (no session deducted, not in the
//                                "needs review" list). Staff can still flip it.
//   inside 5 days             -> no self-cancel; the athlete messages the coach
//                                (#407) and staff handle it as before.
//
// Before #477 the window was 12 hours and every athlete cancel counted against
// the package ('athlete_cancelled'). Both entry points — the My Schedule
// session modal and the coach's slot card under Schedule -> Facility — go
// through this file so the rule cannot drift between them.

import { supabase } from './supabaseClient';
import { CANCEL_REASON_EARLY } from './cancelReasons';

export const SELF_CANCEL_NOTICE_DAYS = 5;
const NOTICE_MS = SELF_CANCEL_NOTICE_DAYS * 24 * 60 * 60 * 1000;

export const SELF_CANCEL_RULE_TEXT =
  `You can cancel a session yourself up to ${SELF_CANCEL_NOTICE_DAYS} days before it starts, and it won't use a session from your package.`;
export const SELF_CANCEL_CLOSED_TEXT =
  `Self-cancelling closes ${SELF_CANCEL_NOTICE_DAYS} days before the session. Message your coach if you can't make it.`;

export function sessionStart(dateStr, startTime) {
  return new Date(`${dateStr}T${(startTime || '00:00').slice(0, 5)}:00`);
}

export function canSelfCancel(dateStr, startTime, now = Date.now()) {
  return now <= sessionStart(dateStr, startTime).getTime() - NOTICE_MS;
}

/**
 * Cancel the athlete's own pending/confirmed reservation on one occurrence.
 * Re-checks the window at the moment of the write (a modal can sit open past
 * the cutoff). Throws with a message fit to show the athlete.
 */
export async function cancelOwnReservation({ slotId, slotDate, startTime, userId }) {
  if (!canSelfCancel(slotDate, startTime)) {
    throw new Error(SELF_CANCEL_CLOSED_TEXT);
  }
  const { data: resRow, error: findErr } = await supabase
    .from('slot_reservations')
    .select('id')
    .eq('slot_id', slotId)
    .eq('slot_date', slotDate)
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
      cancel_reason: CANCEL_REASON_EARLY,
      cancel_reason_by: userId,
      cancel_reason_at: now,
    })
    .eq('id', resRow.id)
    .select('id');
  if (updErr) throw updErr;
  // A refused write comes back as success with zero rows, so an empty array
  // here is a failure that would otherwise show as "cancelled!" while the
  // athlete is still on the roster.
  if (!updated || updated.length === 0) {
    throw new Error('Nothing was saved — the cancellation was refused. You are still booked in, so please tell your coach directly.');
  }
  return resRow.id;
}
