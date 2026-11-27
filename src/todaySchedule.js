// #502 — what "today" means on the athlete dashboard's Today's Schedule card.
//
// A parent reported the schedule "showing Central time instead of Pacific":
// their lesson was at 3:00 PM and the dashboard said 5:00 PM (twice). Nothing
// was converting time zones — session times are plain clock times and print
// as stored. The card was listing the wrong sessions:
//
//   * a slot_reservations row is ONE occurrence of a weekly slot (#455), dated
//     by its own slot_date. The card ignored that date and showed every
//     confirmed booking on any weekly slot that falls on today's weekday, so a
//     booking from three weeks ago reappeared every week at its old time;
//   * pending bookings were left out, so the lesson the family was actually
//     waiting on (3:00 PM) was not there to contradict the stale 5:00 PM rows.
//
// These helpers are pure so the rule can be tested without a database.
import { expandRecurringEvents } from './scheduleUtils';

/**
 * The athlete's sessions for one date.
 * @param reservations slot_reservations rows with their `training_slots` join
 * @param tombstones   training_slots child rows (recurrence_parent_id,
 *                     original_date, is_exception) standing in for that date
 * @param dateStr      'YYYY-MM-DD'
 */
export function reservationsForDate(reservations, tombstones, dateStr) {
  const cancelled = new Set(
    (tombstones || [])
      .filter(t => t.is_exception === true && t.original_date === dateStr && t.recurrence_parent_id)
      .map(t => t.recurrence_parent_id)
  );
  return (reservations || []).filter(r => {
    const slot = r.training_slots;
    if (!slot) return false;
    if (r.status !== 'confirmed' && r.status !== 'pending') return false;
    // The reservation's own date decides. (Every row has one; the slot's start
    // date is only a fallback for a row that somehow lacks it.)
    if ((r.slot_date || slot.slot_date) !== dateStr) return false;
    // Joined to a tombstone child: that occurrence was cancelled (#279).
    if (slot.recurrence_parent_id && slot.is_exception !== false) return false;
    // A series date the coach (or the autoclean) removed for this day.
    if (cancelled.has(slot.id)) return false;
    return true;
  });
}

/**
 * The athlete's facility events for one date: one-off rows on that date,
 * recurring masters expanded by their real recurrence_rule (interval, byDay,
 * until, count) with per-occurrence exceptions honoured — a tombstoned date is
 * hidden and an edited occurrence replaces the master's copy.
 * @param oneOffs    non-recurring rows already filtered to dateStr
 * @param masters    recurring master rows (recurrence_parent_id null)
 * @param exceptions child rows of those masters
 * @param dateStr    'YYYY-MM-DD'
 */
export function facilityEventsForDate(oneOffs, masters, exceptions, dateStr) {
  const day = new Date(`${dateStr}T12:00:00`);
  const expanded = expandRecurringEvents(masters || [], exceptions || [], day, day)
    .filter(e => e.event_date === dateStr);
  const out = [];
  const seen = new Set();
  for (const e of [...(oneOffs || []), ...expanded]) {
    if (!e || e.is_exception === true) continue;
    // Virtual occurrences carry a synthetic `${masterId}_${index}` id.
    const key = e._master_id || e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
