import { reservationsForDate, facilityEventsForDate } from './todaySchedule';

// The #502 report, rebuilt from the athlete's real rows on Tue 2026-11-24:
// two confirmed bookings from EARLIER Tuesdays on a weekly 5:00 PM slot, and
// the lesson the family was actually waiting on (3:00 PM, still pending).
const tue5pm = { id: 'slot-5pm', slot_date: '2026-10-06', start_time: '17:00:00', repeat_weekly: true, repeat_end_date: '2026-11-30', recurrence_parent_id: null, is_exception: false };
const tue3pm = { id: 'slot-3pm', slot_date: '2026-10-13', start_time: '15:00:00', repeat_weekly: true, repeat_end_date: '2026-12-01', recurrence_parent_id: null, is_exception: false };
const res = (id, status, slot_date, slot) => ({ id, status, slot_date, slot_id: slot.id, training_slots: slot });

describe('reservationsForDate (#502)', () => {
  const rows = [
    res('r-nov3', 'confirmed', '2026-11-03', tue5pm),
    res('r-nov17', 'confirmed', '2026-11-17', tue5pm),
    res('r-nov24', 'pending', '2026-11-24', tue3pm),
    res('r-nov24-cancelled', 'cancelled', '2026-11-24', tue3pm),
  ];

  test('only the booking dated today shows, at its own time', () => {
    const today = reservationsForDate(rows, [], '2026-11-24');
    expect(today.map(r => r.id)).toEqual(['r-nov24']);
    expect(today[0].training_slots.start_time).toBe('15:00:00');
  });

  test('past bookings on the same weekday never reappear', () => {
    expect(reservationsForDate(rows, [], '2026-12-01')).toEqual([]);
  });

  test('a confirmed booking shows on its date', () => {
    expect(reservationsForDate(rows, [], '2026-11-17').map(r => r.id)).toEqual(['r-nov17']);
  });

  test('declined and cancelled bookings are left out', () => {
    const declined = [res('d', 'declined', '2026-11-24', tue3pm)];
    expect(reservationsForDate(declined, [], '2026-11-24')).toEqual([]);
  });

  test('a date the coach removed is hidden', () => {
    const tombstone = { id: 't1', recurrence_parent_id: 'slot-3pm', original_date: '2026-11-24', is_exception: true };
    expect(reservationsForDate(rows, [tombstone], '2026-11-24')).toEqual([]);
    // A tombstone for another date does not hide today.
    const other = { ...tombstone, original_date: '2026-11-17' };
    expect(reservationsForDate(rows, [other], '2026-11-24').map(r => r.id)).toEqual(['r-nov24']);
  });

  test('a moved occurrence (child row, not a tombstone) shows on its new date', () => {
    const moved = { id: 'child', slot_date: '2026-11-25', start_time: '16:00:00', recurrence_parent_id: 'slot-3pm', original_date: '2026-11-24', is_exception: false };
    const r = [res('r-moved', 'confirmed', '2026-11-25', moved)];
    expect(reservationsForDate(r, [], '2026-11-25').map(x => x.id)).toEqual(['r-moved']);
    // The exception row for the ORIGINAL date is not a tombstone, so it must
    // not hide anything on that date either.
    expect(reservationsForDate(rows, [moved], '2026-11-24').map(x => x.id)).toEqual(['r-nov24']);
  });

  test('a booking joined to a tombstone child is hidden', () => {
    const dead = { id: 'dead', slot_date: '2026-11-24', recurrence_parent_id: 'slot-3pm', original_date: '2026-11-24', is_exception: true };
    expect(reservationsForDate([res('x', 'confirmed', '2026-11-24', dead)], [], '2026-11-24')).toEqual([]);
  });

  test('empty and missing inputs', () => {
    expect(reservationsForDate(null, null, '2026-11-24')).toEqual([]);
    expect(reservationsForDate([{ id: 'no-slot', status: 'confirmed', slot_date: '2026-11-24', training_slots: null }], [], '2026-11-24')).toEqual([]);
  });
});

describe('facilityEventsForDate (#502)', () => {
  const weeklySat = { id: 'm1', title: 'Assessment', event_date: '2026-10-03', start_time: '09:00:00', is_recurring: true, recurrence_parent_id: null, recurrence_rule: { freq: 'weekly', interval: 1, byDay: ['SA'], until: '2026-11-28', endType: 'until' } };
  const multiDay = { id: 'm2', title: 'NBP+ Hitting', event_date: '2026-11-02', start_time: '16:00:00', is_recurring: true, recurrence_parent_id: null, recurrence_rule: { freq: 'weekly', interval: 1, byDay: ['MO', 'TU', 'TH', 'FR'], endType: 'never' } };

  test('a weekly series shows on its day and stops after its end date', () => {
    expect(facilityEventsForDate([], [weeklySat], [], '2026-11-28').map(e => e.title)).toEqual(['Assessment']);
    // The old weekday match kept showing this forever.
    expect(facilityEventsForDate([], [weeklySat], [], '2026-12-05')).toEqual([]);
    expect(facilityEventsForDate([], [weeklySat], [], '2026-11-27')).toEqual([]);
  });

  test('a series on several weekdays shows on each of them', () => {
    // 2026-11-24 is a Tuesday; the master started on a Monday, so the old
    // weekday match never showed the Tuesday / Thursday / Friday sessions.
    expect(facilityEventsForDate([], [multiDay], [], '2026-11-24').map(e => e.title)).toEqual(['NBP+ Hitting']);
    expect(facilityEventsForDate([], [multiDay], [], '2026-11-25')).toEqual([]); // Wednesday
  });

  test('a cancelled occurrence is hidden', () => {
    const tomb = { id: 'x1', recurrence_parent_id: 'm1', original_date: '2026-11-28', event_date: '2026-11-28', is_exception: true, is_recurring: false };
    expect(facilityEventsForDate([], [weeklySat], [tomb], '2026-11-28')).toEqual([]);
    // ...even when the tombstone row also arrives in the one-off list.
    expect(facilityEventsForDate([tomb], [weeklySat], [tomb], '2026-11-28')).toEqual([]);
  });

  test('an edited occurrence replaces the series copy, once', () => {
    const edited = { id: 'x2', title: 'Assessment (moved to 10)', recurrence_parent_id: 'm1', original_date: '2026-11-28', event_date: '2026-11-28', start_time: '10:00:00', is_exception: false, is_recurring: false };
    const out = facilityEventsForDate([edited], [weeklySat], [edited], '2026-11-28');
    expect(out).toHaveLength(1);
    expect(out[0].start_time).toBe('10:00:00');
  });

  test('an occurrence moved to another day leaves its original day', () => {
    const moved = { id: 'x3', title: 'Assessment', recurrence_parent_id: 'm1', original_date: '2026-11-28', event_date: '2026-11-29', start_time: '09:00:00', is_exception: false, is_recurring: false };
    expect(facilityEventsForDate([], [weeklySat], [moved], '2026-11-28')).toEqual([]);
    expect(facilityEventsForDate([moved], [weeklySat], [moved], '2026-11-29').map(e => e.id)).toEqual(['x3']);
  });

  test('one-off events pass through', () => {
    const one = { id: 'o1', title: 'Roland Johnston Assessment', event_date: '2026-11-24', start_time: '13:00:00', is_recurring: false, recurrence_parent_id: null };
    expect(facilityEventsForDate([one], [], [], '2026-11-24').map(e => e.id)).toEqual(['o1']);
    expect(facilityEventsForDate(null, null, null, '2026-11-24')).toEqual([]);
  });
});
