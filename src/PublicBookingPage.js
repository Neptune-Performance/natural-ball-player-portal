// Public, no-login facility booking page (#229). Reachable at /book by anyone
// (rendered in App.js before the auth gate). Outside customers browse the
// facility resources and coach sessions that staff have marked "public" +
// priced, then book & pay via Square. A paid booking shows on the staff
// Schedule calendar and can be canceled/refunded there.
//
// This page never authenticates. It talks only to the public edge functions
// (public-availability, public-book-checkout), which do all writes server-side.

import React, { useState, useEffect, useRef } from 'react';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabaseClient';
import { Calendar as CalendarIcon, Clock, MapPin, User, Dumbbell, CheckCircle, ArrowLeft, Loader2, ChevronLeft, ChevronRight, ChevronDown, Check, X, LogIn } from 'lucide-react';

const fnUrl = (name) => `${supabaseUrl}/functions/v1/${name}`;
const fnHeaders = {
  'Content-Type': 'application/json',
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${supabaseAnonKey}`,
};

const money = (cents) => (cents ? `$${(cents / 100).toFixed(2)}` : 'Free');

// Prefix the event title with its booking Type when one is set (facility events
// carry booking_type; coach sessions don't).
const eventLabel = (s) => (s && s.booking_type ? `${s.booking_type} — ${s.title}` : (s ? s.title : ''));

const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const timeDisplay = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
};

const dateDisplay = (d) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

const MONTH_LABEL = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Saturated bar backgrounds keyed by the event's color (facility_events.color /
// the booking Type color). Used for the month-grid event bars.
const TYPE_BAR = {
  teal: 'bg-teal-600', blue: 'bg-sky-700', purple: 'bg-purple-700', pink: 'bg-pink-600',
  red: 'bg-red-700', orange: 'bg-orange-600', yellow: 'bg-yellow-600', green: 'bg-green-600', gray: 'bg-gray-700',
};
const barColor = (c) => TYPE_BAR[c] || TYPE_BAR.teal;

// Compact time like "11a", "4:45p".
const shortTime = (t) => {
  if (!t) return '';
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
};

const MONTH_MAX_PER_DAY = 7; // events shown per day before "View More"

// Facility booking types offered in the Facility filter dropdown. Must match
// the staff-side PUBLIC_BOOKING_TYPES values in Schedule.js (facility_events.booking_type).
const FACILITY_TYPES = [
  'Cage Rental',
  'NBP+ Strength & Conditioning',
  'NBP+ Hitting Session',
  'NBP+ Pitching/Throwing Session',
  'NBP+ Fielding Session',
  'Camps',
  'Assessment',
  'Biomechanics Assessment',
];

// Weeks (arrays of Date) covering the calendar month of `anchor`, padded to
// full Sun–Sat weeks.
function buildMonthGrid(anchor) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cur = new Date(year, month, 1 - first.getDay()); // back up to Sunday
  const weeks = [];
  while (cur <= last || cur.getDay() !== 0) {
    const week = [];
    for (let i = 0; i < 7; i++) { week.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(week);
    if (weeks.length > 6) break;
  }
  return weeks;
}

function buildWeekDays(anchor) {
  const start = new Date(anchor);
  start.setDate(anchor.getDate() - anchor.getDay());
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}

// Stable wrapper — defined outside the component so its identity never changes
// between renders (an inline component would cause full remounts on every
// state update, re-firing autoFocus and resetting focus to the first field).
function BookingWrap({ embedded, wide, signedIn, children }) {
  if (embedded) return <div className={`${wide ? 'max-w-7xl' : 'max-w-3xl'} mx-auto`}>{children}</div>;
  return (
    <Shell wide={wide} signedIn={signedIn}>
      <div className={`${wide ? 'max-w-7xl' : 'max-w-3xl'} mx-auto`}>{children}</div>
    </Shell>
  );
}

// Props:
//   embedded  — render without the outer page Shell (for use inside the logged-in
//               public mini-portal); also suppresses the welcome popup.
//   prefill   — { name, email, phone } to pre-populate the booking form for a
//               known (logged-in) public user.
//   facilityOnly — #452: list facility times only (NBP+ blocks, assessments,
//                  cages). Used by the athlete Schedule → Facility tab: athletes
//                  book coach lessons through the portal's own Reserve flow
//                  (package gate, coach confirm), never this guest checkout.
export default function PublicBookingPage({ embedded = false, prefill = null, facilityOnly = false }) {
  const params = new URLSearchParams(window.location.search);
  const returnedBooking = params.get('booking');
  const todayStr = fmtLocal(new Date());

  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState(facilityOnly ? 'resource' : 'all'); // all | resource | coach_session
  const [typeFilter, setTypeFilter] = useState([]); // highlighted facility booking_types; empty = All
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef(null);
  const [view, setView] = useState('month'); // month | week | today | list
  const [viewDate, setViewDate] = useState(() => new Date()); // month/week anchor
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [dayModal, setDayModal] = useState(null); // date string when a day's overflow is expanded
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({
    name: prefill?.name || '', email: prefill?.email || '', phone: prefill?.phone || '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [freeBooked, setFreeBooked] = useState(false); // #249: inline confirm for $0 sessions
  const [showWelcome, setShowWelcome] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  // Close the Facility type dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!typeMenuOpen) return;
    const onDown = (e) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(e.target)) setTypeMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [typeMenuOpen]);

  const loadAvailability = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch(fnUrl('public-availability'), {
        method: 'POST',
        headers: fnHeaders,
        body: JSON.stringify({ days: 120 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load availability');
      setSlots(data.slots || []);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!returnedBooking) loadAvailability();
    else setLoading(false);
  }, [returnedBooking]);

  // Track whether the visitor has an active session (drives the header
  // Sign In / Account button) and show the once-per-browser welcome popup to
  // logged-out first-timers. Skipped when embedded in the logged-in portal.
  useEffect(() => {
    if (embedded) return;
    let seen = false;
    try { seen = localStorage.getItem('nbp_book_welcome_seen') === '1'; } catch {}
    supabase.auth.getSession().then(({ data }) => {
      const hasSession = !!data?.session;
      setSignedIn(hasSession);
      if (!hasSession && !seen && !returnedBooking) setShowWelcome(true);
    }).catch(() => { if (!seen && !returnedBooking) setShowWelcome(true); });
  }, [embedded, returnedBooking]);

  const dismissWelcome = () => {
    try { localStorage.setItem('nbp_book_welcome_seen', '1'); } catch {}
    setShowWelcome(false);
  };

  const handleBook = async () => {
    if (!form.name.trim()) return setSubmitError('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setSubmitError('Please enter a valid email.');
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(fnUrl('public-book-checkout'), {
        method: 'POST',
        headers: fnHeaders,
        body: JSON.stringify({
          source_type: selected.source_type,
          source_id: selected.source_id,
          occurrence_date: selected.occurrence_date,
          guest_name: form.name,
          guest_email: form.email,
          guest_phone: form.phone,
          notes: form.notes,
          return_url: window.location.origin,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not start checkout');
      // #249: free session — no Square redirect, booking is already confirmed.
      if (data.free) { setFreeBooked(true); setSubmitting(false); return; }
      window.location.href = data.checkout_url;
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(false);
    }
  };

  const closeBooking = () => { setSelected(null); setFreeBooked(false); setSubmitError(''); };

  // --- Post-payment confirmation --------------------------------------------
  if (returnedBooking) {
    return (
      <Shell signedIn={signedIn}>
        <div className="max-w-md mx-auto text-center py-16">
          <CheckCircle size={56} className="mx-auto text-green-500 mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Thank you!</h1>
          <p className="text-gray-600 mb-6">
            If your payment went through, your booking is confirmed and our staff can see it.
            A receipt has been emailed to you by Square.
          </p>
          <a href="/book" className="inline-block px-5 py-2.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition font-medium">
            Book another time
          </a>
        </div>
      </Shell>
    );
  }

  const openBooking = (s) => { setSelected(s); setSubmitError(''); setFreeBooked(false); };

  const visible = slots.filter((s) => {
    if (filter !== 'all' && s.kind !== filter) return false;
    // Facility type highlight: only constrains facility resources; empty = All.
    if (filter === 'resource' && typeFilter.length > 0 && !typeFilter.includes(s.booking_type)) return false;
    return true;
  });
  // Group by date.
  const byDate = {};
  visible.forEach((s) => { (byDate[s.occurrence_date] = byDate[s.occurrence_date] || []).push(s); });
  const allDates = Object.keys(byDate).sort();

  // Month/week navigation.
  const shiftMonth = (delta) => {
    const d = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1);
    setViewDate(d);
    // Keep the selected day sensible: today if we're on the current month, else the 1st.
    setSelectedDate(todayStr.slice(0, 7) === fmtLocal(d).slice(0, 7) ? todayStr : fmtLocal(d));
  };
  const shiftWeek = (delta) => {
    const d = new Date(viewDate);
    d.setDate(d.getDate() + delta * 7);
    setViewDate(d);
  };

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading availability…
        </div>
      );
    }
    if (loadError) {
      return (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
          {loadError}
          <button onClick={loadAvailability} className="ml-3 underline">Retry</button>
        </div>
      );
    }

    if (view === 'list') {
      if (allDates.length === 0) return <EmptyState />;
      return (
        <div className="space-y-6">
          {allDates.map((date) => (
            <div key={date}>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{dateDisplay(date)}</h2>
              <div className="space-y-2">
                {byDate[date].map((s) => <SlotCard key={s.key} s={s} onClick={() => openBooking(s)} />)}
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (view === 'today') {
      const daySlots = byDate[todayStr] || [];
      return (
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{dateDisplay(todayStr)}</h2>
          {daySlots.length === 0
            ? <EmptyState label="No open times today. Try Week or Month." />
            : <div className="space-y-2">{daySlots.map((s) => <SlotCard key={s.key} s={s} onClick={() => openBooking(s)} />)}</div>}
        </div>
      );
    }

    if (view === 'week') {
      const days = buildWeekDays(viewDate);
      const rangeLabel = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      return (
        <div>
          <CalNav label={rangeLabel} onPrev={() => shiftWeek(-1)} onNext={() => shiftWeek(1)} />
          <div className="grid grid-cols-7 gap-1.5 mb-5">
            {days.map((d) => {
              const ds = fmtLocal(d);
              const count = (byDate[ds] || []).length;
              return <DayPill key={ds} d={d} ds={ds} count={count} selected={ds === selectedDate} isToday={ds === todayStr} onSelect={() => setSelectedDate(ds)} />;
            })}
          </div>
          <DayPanel date={selectedDate} daySlots={byDate[selectedDate] || []} onOpen={openBooking} />
        </div>
      );
    }

    // Month (default) — full grid with each day's events listed as colored bars.
    const weeks = buildMonthGrid(viewDate);
    const curMonth = viewDate.getMonth();
    return (
      <div>
        <CalNav label={MONTH_LABEL(viewDate)} onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)} />
        <div className="grid grid-cols-7 text-center text-xs font-semibold text-gray-500 border-b border-gray-200">
          {DOW.map((d) => <div key={d} className="py-1.5">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 border-l border-t border-gray-200">
          {weeks.flat().map((d) => {
            const ds = fmtLocal(d);
            const items = byDate[ds] || [];
            const inMonth = d.getMonth() === curMonth;
            return (
              <div key={ds} className={`border-r border-b border-gray-200 min-h-[128px] p-1 align-top ${!inMonth ? 'bg-gray-50' : ds === todayStr ? 'bg-amber-50' : 'bg-white'}`}>
                <div className={`text-right text-sm px-1 mb-0.5 ${inMonth ? 'text-gray-500' : 'text-gray-300'} ${ds === todayStr ? 'font-bold text-amber-700' : ''}`}>{d.getDate()}</div>
                <div className="space-y-0.5">
                  {items.slice(0, MONTH_MAX_PER_DAY).map((s) => <EventBar key={s.key} s={s} onClick={() => openBooking(s)} />)}
                  {items.length > MONTH_MAX_PER_DAY && (
                    <button onClick={() => setDayModal(ds)} className="w-full text-center text-[11px] text-gray-500 hover:text-gray-800 py-0.5">
                      View More
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <BookingWrap embedded={embedded} wide={view === 'month'} signedIn={signedIn}>
      {showWelcome && <WelcomePopup onClose={dismissWelcome} />}
      <div>
        {!embedded && <h1 className="text-3xl font-bold text-gray-900 mb-1">Book Facility Time</h1>}
        {!embedded && <p className="text-gray-600 mb-5">Reserve a resource or a session with one of our coaches.</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          {/* View switcher */}
          <div className="inline-flex bg-gray-200 rounded-lg p-0.5">
            {[
              { key: 'list', label: 'List' },
              { key: 'today', label: 'Today' },
              { key: 'week', label: 'Week' },
              { key: 'month', label: 'Month' },
            ].map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition ${
                  view === v.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {/* Kind filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            {!facilityOnly && <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                filter === 'all' ? 'bg-teal-600 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
              }`}
            >
              All
            </button>}
            <div className="relative" ref={typeMenuRef}>
              <button
                onClick={() => { setFilter('resource'); setTypeMenuOpen((o) => !o); }}
                className={`flex items-center px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  filter === 'resource' ? 'bg-teal-600 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                Facility{typeFilter.length > 0 ? ` (${typeFilter.length})` : ''}
                <ChevronDown size={14} className={`ml-1 transition-transform ${typeMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {typeMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1">
                  <button
                    onClick={() => setTypeFilter([])}
                    className={`w-full flex items-center justify-between text-left px-3 py-2 text-sm ${
                      typeFilter.length === 0 ? 'bg-teal-50 text-teal-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    All
                    {typeFilter.length === 0 && <Check size={14} />}
                  </button>
                  {FACILITY_TYPES.map((t) => {
                    const on = typeFilter.includes(t);
                    return (
                      <button
                        key={t}
                        onClick={() => setTypeFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                        className={`w-full flex items-center justify-between text-left px-3 py-2 text-sm ${
                          on ? 'bg-teal-50 text-teal-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {t}
                        {on && <Check size={14} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {!facilityOnly && <button
              onClick={() => setFilter('coach_session')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                filter === 'coach_session' ? 'bg-teal-600 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
              }`}
            >
              Private Lesson Availability
            </button>}
          </div>
        </div>

        {renderBody()}
      </div>

      {/* Day overflow modal (from month "View More") */}
      {dayModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40 p-4" onClick={() => setDayModal(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-900">{dateDisplay(dayModal)}</h3>
                <button onClick={() => setDayModal(null)} className="text-gray-400 hover:text-gray-600"><ArrowLeft size={18} /></button>
              </div>
              <div className="space-y-2">
                {(byDate[dayModal] || []).map((s) => (
                  <SlotCard key={s.key} s={s} onClick={() => { setDayModal(null); openBooking(s); }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Booking form modal */}
      {selected && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          {/* #350: capped height + a scrolling body, with the pay button in a
              footer that is a SIBLING of that body. A long event title used to
              grow this card past the screen, and because the overlay is
              `fixed` the page behind it cannot scroll — "Continue to payment"
              went off the bottom with no way to reach it. The title is clamped
              to two lines (full text on hover) so the header can never grow
              past the cap and clip the rest of the card. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
            {freeBooked ? (
              <>
                <div className="p-6 text-center overflow-y-auto flex-1 min-h-0">
                  <CheckCircle size={48} className="mx-auto text-green-500 mb-3" />
                  <h3 className="text-xl font-bold text-gray-900 mb-1">You're booked!</h3>
                  <p className="text-sm text-gray-600">This free session is confirmed. We've got you down for {dateDisplay(selected.occurrence_date)}{selected.start_time ? ` at ${timeDisplay(selected.start_time)}` : ''}.</p>
                </div>
                <div className="border-t border-gray-200 p-4 flex-shrink-0">
                  <button onClick={closeBooking} className="w-full bg-teal-600 text-white py-2.5 rounded-lg hover:bg-teal-700 transition font-medium">Done</button>
                </div>
              </>
            ) : (
            <>
            <div className="px-6 pt-6 pb-4 flex-shrink-0">
              <button onClick={closeBooking} className="flex items-center text-sm text-gray-500 hover:text-gray-700 mb-4">
                <ArrowLeft size={16} className="mr-1" /> Back
              </button>
              <h3 className="text-xl font-bold text-gray-900 line-clamp-2 break-words" title={eventLabel(selected)}>{eventLabel(selected)}</h3>
            </div>
            <div className="px-6 pb-4 overflow-y-auto flex-1 min-h-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600 mb-1">
                <span className="flex items-center"><CalendarIcon size={14} className="mr-1" />{dateDisplay(selected.occurrence_date)}</span>
                {selected.start_time && <span className="flex items-center"><Clock size={14} className="mr-1" />{timeDisplay(selected.start_time)}{selected.end_time ? `–${timeDisplay(selected.end_time)}` : ''}</span>}
                {selected.coach_name && <span className="flex items-center"><User size={14} className="mr-1" />{selected.coach_name}</span>}
              </div>
              <div className="text-lg font-bold text-gray-900 mb-4">{money(selected.price_cents)}</div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full name *</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" autoFocus />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
                </div>
              </div>

              {submitError && <p className="text-sm text-red-600 mt-3">{submitError}</p>}
            </div>
            <div className="border-t border-gray-200 px-6 py-4 flex-shrink-0">
              <button onClick={handleBook} disabled={submitting} className="w-full bg-teal-600 text-white py-2.5 rounded-lg hover:bg-teal-700 transition font-medium disabled:opacity-50 flex items-center justify-center">
                {submitting
                  ? <><Loader2 size={18} className="animate-spin mr-2" /> {selected.price_cents ? 'Redirecting to payment…' : 'Booking…'}</>
                  : (selected.price_cents ? `Continue to payment · ${money(selected.price_cents)}` : 'Reserve · Free')}
              </button>
              <p className="text-xs text-gray-400 text-center mt-2">{selected.price_cents ? "You'll pay securely via Square. No account needed." : 'No payment needed — you\'re confirmed instantly.'}</p>
            </div>
            </>
            )}
          </div>
        </div>
      )}
    </BookingWrap>
  );
}

// Welcome popup shown once to first-time, logged-out visitors of /book.
function WelcomePopup({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350: capped so a short window (a phone held sideways) can still
          reach the buttons. The X stays pinned to the card while the text
          scrolls under it. */}
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden relative">
        <button onClick={onClose} className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 z-10" aria-label="Close">
          <X size={20} />
        </button>
        <div className="text-center p-6 overflow-y-auto flex-1 min-h-0">
          <div className="text-4xl mb-3">⚾</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Welcome to the Natural Ball Player</h2>
          <p className="text-gray-600 text-sm mb-6">
            Welcome to the scheduling page of the Natural Ball Player. If you have not
            logged in, please do so now — or create an account to book and track your sessions.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <a
              href="/"
              className="flex-1 px-4 py-2.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition font-medium text-sm text-center"
            >
              Log in
            </a>
            <a
              href="/?signup=public"
              className="flex-1 px-4 py-2.5 bg-white text-teal-700 border border-teal-300 rounded-lg hover:bg-teal-50 transition font-medium text-sm text-center"
            >
              Create an account
            </a>
          </div>
          <button onClick={onClose} className="mt-4 text-xs text-gray-400 hover:text-gray-600">
            Continue browsing without an account
          </button>
        </div>
      </div>
    </div>
  );
}

function SlotCard({ s, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between bg-white border border-gray-200 rounded-lg p-4 hover:border-teal-400 hover:shadow-sm transition text-left"
    >
      <div className="flex items-start space-x-3 min-w-0">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.kind === 'coach_session' ? 'bg-indigo-50 text-indigo-600' : 'bg-teal-50 text-teal-600'}`}>
          {s.kind === 'coach_session' ? <Dumbbell size={18} /> : <MapPin size={18} />}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 truncate">{eventLabel(s)}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 mt-0.5">
            {s.start_time && <span className="flex items-center"><Clock size={12} className="mr-1" />{timeDisplay(s.start_time)}{s.end_time ? `–${timeDisplay(s.end_time)}` : ''}</span>}
            {s.coach_name && <span className="flex items-center"><User size={12} className="mr-1" />{s.coach_name}</span>}
            {s.location && <span className="flex items-center"><MapPin size={12} className="mr-1" />{s.location}</span>}
            {s.remaining > 1 && <span>{s.remaining} spots left</span>}
          </div>
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <div className="font-bold text-gray-900">{money(s.price_cents)}</div>
        <div className="text-xs text-teal-600 font-medium">Book →</div>
      </div>
    </button>
  );
}

// A colored event bar in the month grid: dark time chip + tinted title.
function EventBar({ s, onClick }) {
  return (
    <button
      onClick={onClick}
      title={`${eventLabel(s)} · ${timeDisplay(s.start_time)} · ${money(s.price_cents)}`}
      className={`flex w-full rounded overflow-hidden text-white text-[11px] leading-tight ${barColor(s.color)} hover:opacity-90 transition`}
    >
      <span className="px-1 py-0.5 bg-black/30 font-semibold whitespace-nowrap">{shortTime(s.start_time)}</span>
      <span className="px-1 py-0.5 flex-1 truncate text-left">{eventLabel(s)}</span>
    </button>
  );
}

// The list of slots for a single selected day (used by Week + Month views).
function DayPanel({ date, daySlots, onOpen }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{dateDisplay(date)}</h2>
      {daySlots.length === 0
        ? <p className="text-sm text-gray-400 italic py-4">No open times this day.</p>
        : <div className="space-y-2">{daySlots.map((s) => <SlotCard key={s.key} s={s} onClick={() => onOpen(s)} />)}</div>}
    </div>
  );
}

// A single day button in the Week strip.
function DayPill({ d, ds, count, selected, isToday, onSelect }) {
  return (
    <button
      onClick={() => count > 0 && onSelect()}
      disabled={count === 0}
      className={`rounded-lg py-2 flex flex-col items-center transition ${
        selected ? 'bg-teal-600 text-white'
          : count > 0 ? 'bg-teal-50 text-gray-900 hover:bg-teal-100 cursor-pointer'
          : 'bg-gray-50 text-gray-300 cursor-default'
      }`}
    >
      <span className="text-[10px] uppercase">{DOW[d.getDay()]}</span>
      <span className={`text-base font-semibold ${isToday && !selected ? 'text-teal-600' : ''}`}>{d.getDate()}</span>
      <span className={`text-[10px] leading-none ${selected ? 'text-teal-100' : count > 0 ? 'text-teal-600' : 'text-transparent'}`}>{count > 0 ? count : '·'}</span>
    </button>
  );
}

function CalNav({ label, onPrev, onNext }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <button onClick={onPrev} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600"><ChevronLeft size={20} /></button>
      <span className="font-semibold text-gray-900">{label}</span>
      <button onClick={onNext} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600"><ChevronRight size={20} /></button>
    </div>
  );
}

function EmptyState({ label = 'No open times right now. Please check back soon.' }) {
  return (
    <div className="text-center py-16 text-gray-500">
      <CalendarIcon size={40} className="mx-auto mb-3 text-gray-300" />
      {label}
    </div>
  );
}

function Shell({ children, wide, signedIn }) {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200">
        <div className={`${wide ? 'max-w-7xl' : 'max-w-3xl'} mx-auto px-4 py-4 flex items-center justify-between`}>
          <div className="flex items-center space-x-2">
            <img src="/naturals-diamond.png" alt="The Naturals" className="w-8 h-8 object-contain" />
            <span className="font-bold text-gray-900">Natural Ball Player</span>
          </div>
          <a
            href="/"
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
              signedIn
                ? 'bg-white text-teal-700 border border-teal-300 hover:bg-teal-50'
                : 'bg-teal-600 text-white hover:bg-teal-700'
            }`}
          >
            {signedIn ? <><User size={16} /> My Account</> : <><LogIn size={16} /> Sign In</>}
          </a>
        </div>
      </header>
      <main className="px-4 py-8">{children}</main>
    </div>
  );
}
