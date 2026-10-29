import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Plus, X, Edit2, Trash2, MapPin, Building, UserCheck, Repeat, CheckSquare, Copy, Globe, Lock, Users as UsersIcon } from 'lucide-react';
import { readAllPages } from './readAllPages';
import { fmtLocalDate, generateOccurrenceDates, expandRecurringEvents, buildSlotExceptionMap, getSlotDateException, collectMovedSlots } from './scheduleUtils';
import CalendarContextMenu from './CalendarContextMenu';
import RecurrenceDecisionModal from './RecurrenceDecisionModal';
import CopyToPickerModal from './CopyToPickerModal';
import { formatUserError } from './errorMessage';

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatTimeFromTS(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatTimeFromHHMM(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function dateToInputValue(iso) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60 * 1000).toISOString().slice(0, 16);
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECURRENCE_DAY_CODES = ['SU','MO','TU','WE','TH','FR','SA'];

function expandStaffRecurring(masters, exceptions, rangeStart, rangeEnd) {
  const exMap = {};
  exceptions.forEach(ex => {
    const key = `${ex.recurrence_parent_id}_${ex.original_date || ex.event_date}`;
    exMap[key] = ex;
  });
  const expanded = [];
  masters.forEach(master => {
    if (!master.recurrence_rule) return;
    const dates = generateOccurrenceDates(master.event_date, master.recurrence_rule, rangeStart, rangeEnd);
    const masterStart = new Date(master.start_at);
    const masterEnd = new Date(master.end_at);
    const timeOfDayStart = masterStart.getHours() * 3600000 + masterStart.getMinutes() * 60000 + masterStart.getSeconds() * 1000;
    const durationMs = masterEnd - masterStart;
    dates.forEach((date, index) => {
      const dateStr = fmtLocalDate(date);
      const exKey = `${master.id}_${dateStr}`;
      if (exMap[exKey]) {
        const ex = exMap[exKey];
        if (ex.is_cancelled) return;
        expanded.push({ ...ex, _is_virtual: false, _master_id: master.id, _occurrence_date: dateStr });
      } else {
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const occStart = new Date(dayStart.getTime() + timeOfDayStart);
        const occEnd = new Date(occStart.getTime() + durationMs);
        expanded.push({
          ...master,
          id: `${master.id}_${index}`,
          event_date: dateStr,
          start_at: occStart.toISOString(),
          end_at: occEnd.toISOString(),
          _is_virtual: true,
          _master_id: master.id,
          _occurrence_index: index,
          _occurrence_date: dateStr,
        });
      }
    });
  });
  return expanded;
}

export default function WorkSchedule({ userId, userRole }) {
  const isAdmin = userRole === 'admin';
  const canManage = userRole === 'admin' || userRole === 'coach';
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [staffEvents, setStaffEvents] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [facilityEvents, setFacilityEvents] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);

  const [viewMode, setViewMode] = useState('week');
  const [selectedDay, setSelectedDay] = useState(() => new Date());

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState([]);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [recurrencePrompt, setRecurrencePrompt] = useState(null);
  const [copyToPicker, setCopyToPicker] = useState(null);
  const selectedIds = useMemo(() => new Set(selectedEvents.map((e) => String(e.id))), [selectedEvents]);
  const toggleSelect = (ev) => setSelectedEvents((arr) => {
    const sid = String(ev.id);
    return arr.some((e) => String(e.id) === sid) ? arr.filter((e) => String(e.id) !== sid) : [...arr, ev];
  });
  const exitSelectMode = () => { setSelecting(false); setSelectedEvents([]); };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const startStr = fmtLocalDate(weekStart);
    const endStr = fmtLocalDate(addDays(weekStart, 6));

    const [staffNonRec, staffMasters, staffEx, asgRes, facNonRec, facMasters, facEx, staffRes] = await Promise.all([
      supabase.from('staff_schedule_events').select('*').eq('is_recurring', false).is('recurrence_parent_id', null).gte('event_date', startStr).lte('event_date', endStr).order('start_at'),
      supabase.from('staff_schedule_events').select('*').eq('is_recurring', true).is('recurrence_parent_id', null),
      supabase.from('staff_schedule_events').select('*').not('recurrence_parent_id', 'is', null).gte('event_date', startStr).lte('event_date', endStr),
      supabase.from('staff_schedule_assignments').select('id, event_id, user_id, role, user:user_id(full_name, avatar_url)'),
      supabase.from('facility_events').select('*').eq('is_recurring', false).is('recurrence_parent_id', null).gte('event_date', startStr).lte('event_date', endStr),
      supabase.from('facility_events').select('*').eq('is_recurring', true).is('recurrence_parent_id', null),
      supabase.from('facility_events').select('*').not('recurrence_parent_id', 'is', null).gte('event_date', startStr).lte('event_date', endStr),
      supabase.from('users').select('id, full_name, avatar_url, role').in('role', ['admin', 'coach']).order('full_name'),
    ]);

    const expandedStaff = expandStaffRecurring(staffMasters.data || [], staffEx.data || [], weekStart, addDays(weekStart, 6));
    setStaffEvents([...(staffNonRec.data || []), ...expandedStaff]);

    if (asgRes.error) console.error(asgRes.error); else setAssignments(asgRes.data || []);
    if (staffRes.error) console.error(staffRes.error); else setStaff(staffRes.data || []);

    const expandedFac = expandRecurringEvents(facMasters.data || [], facEx.data || [], weekStart, addDays(weekStart, 6));
    setFacilityEvents([...(facNonRec.data || []), ...expandedFac]);

    setLoading(false);
  }, [weekStart]);

  useEffect(() => {
    fetchAll();
    const ch1 = supabase.channel('work-sched-events').on('postgres_changes', { event: '*', schema: 'public', table: 'staff_schedule_events' }, () => fetchAll()).subscribe();
    const ch2 = supabase.channel('work-sched-asg').on('postgres_changes', { event: '*', schema: 'public', table: 'staff_schedule_assignments' }, () => fetchAll()).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [fetchAll]);

  const goPrev = () => {
    if (viewMode === 'day') {
      const nd = addDays(selectedDay, -1);
      setSelectedDay(nd);
      if (fmtLocalDate(nd) < fmtLocalDate(weekStart)) setWeekStart(startOfWeek(nd));
    } else {
      setWeekStart(addDays(weekStart, -7));
    }
  };
  const goNext = () => {
    if (viewMode === 'day') {
      const nd = addDays(selectedDay, 1);
      setSelectedDay(nd);
      if (fmtLocalDate(nd) > fmtLocalDate(addDays(weekStart, 6))) setWeekStart(startOfWeek(nd));
    } else {
      setWeekStart(addDays(weekStart, 7));
    }
  };
  const goToday = () => {
    setWeekStart(startOfWeek(new Date()));
    setSelectedDay(new Date());
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const deleteStaffSeries = async (event) => {
    const masterId = event._master_id || event.recurrence_parent_id || event.id;
    await supabase.from('staff_schedule_events').delete().eq('recurrence_parent_id', masterId);
    return (await supabase.from('staff_schedule_events').delete().eq('id', masterId)).error;
  };
  const deleteStaffOccurrence = async (event) => {
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
  };
  const deleteStaffFuture = async (event) => {
    const masterId = event._master_id || event.recurrence_parent_id || event.id;
    const cutoff = new Date(event.event_date + 'T00:00:00');
    cutoff.setDate(cutoff.getDate() - 1);
    const until = fmtLocalDate(cutoff);
    const { data: master } = await supabase.from('staff_schedule_events').select('recurrence_rule, event_date').eq('id', masterId).single();
    if (!master) return null;
    if (master.event_date && master.event_date > until) return await deleteStaffSeries(event);
    const rule = { ...(master.recurrence_rule || {}), until };
    return (await supabase.from('staff_schedule_events').update({ recurrence_rule: rule }).eq('id', masterId)).error;
  };
  const handleStaffDelete = (event) => {
    const recurring = !!(event._is_virtual || event.is_recurring || event.recurrence_parent_id);
    if (!recurring) {
      if (!window.confirm('Delete this event?')) return;
      (async () => {
        const id = event._master_id || event.id;
        const { error } = await supabase.from('staff_schedule_events').delete().eq('id', id);
        if (error) { alert('Failed to delete: ' + formatUserError(error)); return; }
        fetchAll();
      })();
      return;
    }
    setRecurrencePrompt({ event, onPick: async (choice) => {
      setRecurrencePrompt(null);
      let err;
      if (choice === 'one') err = await deleteStaffOccurrence(event);
      else if (choice === 'future') err = await deleteStaffFuture(event);
      else err = await deleteStaffSeries(event);
      if (err) { alert('Failed to delete: ' + formatUserError(err)); return; }
      fetchAll();
    } });
  };
  const handleStaffDuplicate = async (event) => {
    const newDateStr = window.prompt('Duplicate to which date? (YYYY-MM-DD)', event.event_date);
    if (!newDateStr) return;
    const id = event._master_id || event.id;
    const { data: src } = await supabase.from('staff_schedule_events').select('*').eq('id', id).single();
    if (!src) return;
    const clone = { ...src };
    delete clone.id; delete clone.created_at; delete clone.updated_at;
    clone.is_recurring = false;
    clone.recurrence_parent_id = null;
    clone.recurrence_rule = null;
    clone.original_date = null;
    clone.event_date = newDateStr;
    if (src.start_at && src.end_at) {
      const oldStart = new Date(src.start_at);
      const newStart = new Date(newDateStr + 'T00:00:00');
      newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
      const dur = new Date(src.end_at) - new Date(src.start_at);
      clone.start_at = newStart.toISOString();
      clone.end_at = new Date(newStart.getTime() + dur).toISOString();
    }
    const { error } = await supabase.from('staff_schedule_events').insert(clone);
    if (error) { alert('Failed to duplicate: ' + formatUserError(error)); return; }
    fetchAll();
  };
  const handleStaffCopyTo = async (event) => {
    const list = staff;
    const opts = (list || []).map((u) => ({ id: u.id, label: u.full_name }));
    setCopyToPicker({ options: opts, title: 'Assign copy of event to staff', actionLabel: 'Create + assign', onPick: async (ids) => {
      const masterId = event._master_id || event.id;
      const { data: src } = await supabase.from('staff_schedule_events').select('*').eq('id', masterId).single();
      if (!src) { alert('Could not load the event to copy.'); setCopyToPicker(null); return; }
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
      fetchAll();
    } });
  };
  const buildStaffMenu = (event) => [
    { label: 'Edit', icon: <Edit2 size={14} />, onClick: () => { setEditing(event); setShowForm(true); } },
    { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => handleStaffDuplicate(event) },
    { label: 'Copy to...', icon: <Copy size={14} />, onClick: () => handleStaffCopyTo(event) },
    { divider: true },
    { label: 'Delete', icon: <Trash2 size={14} />, onClick: () => handleStaffDelete(event), danger: true },
  ];
  const openStaffMenu = (event, e) => setCtxMenu({ x: e.clientX, y: e.clientY, items: buildStaffMenu(event) });
  const bulkStaffDelete = async () => {
    if (selectedEvents.length === 0) return;
    if (!window.confirm(`Delete ${selectedEvents.length} selected event(s)?`)) return;
    let failed = 0;
    for (const ev of selectedEvents) {
      const id = ev._master_id || ev.id;
      try {
        if (ev._is_virtual) {
          await deleteStaffOccurrence(ev);
        } else {
          const { error } = await supabase.from('staff_schedule_events').delete().eq('id', id);
          if (error) throw error;
        }
      } catch (err) {
        failed++;
        console.error('Bulk staff delete failed for event', id, err);
      }
    }
    if (failed > 0) {
      alert(`${selectedEvents.length - failed} deleted, ${failed} failed. Refresh to see current state.`);
    }
    exitSelectMode();
    fetchAll();
  };
  const onStaffDrop = async (eventId, newDate) => {
    const ev = staffEvents.find((e) => String(e.id) === String(eventId));
    if (!ev || ev._is_virtual || ev.event_date === newDate) return;
    const oldStart = new Date(ev.start_at);
    const newStart = new Date(newDate + 'T00:00:00');
    newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
    const dur = new Date(ev.end_at) - new Date(ev.start_at);
    const { error } = await supabase.from('staff_schedule_events').update({
      event_date: newDate,
      start_at: newStart.toISOString(),
      end_at: new Date(newStart.getTime() + dur).toISOString(),
    }).eq('id', ev.id);
    if (error) { alert('Failed to move event: ' + formatUserError(error)); return; }
    fetchAll();
  };

  const assignmentsByEvent = assignments.reduce((acc, a) => {
    (acc[a.event_id] = acc[a.event_id] || []).push(a);
    return acc;
  }, {});

  const getEventAssignments = (ev) => {
    const realId = ev._master_id || ev.id;
    return assignmentsByEvent[realId] || [];
  };

  const myAssignedEventIds = new Set(assignments.filter(a => a.user_id === userId).map(a => a.event_id));
  const isMyAssigned = (ev) => {
    const realId = ev._master_id || ev.id;
    return myAssignedEventIds.has(realId);
  };

  const eventsByDay = (date) => {
    const dayStr = fmtLocalDate(date);
    const items = [];
    staffEvents
      .filter(e => (e.event_date || fmtLocalDate(new Date(e.start_at))) === dayStr)
      .forEach(e => items.push({ kind: 'staff', e, time: e.start_at }));
    facilityEvents
      .filter(f => f.event_date === dayStr)
      .forEach(f => items.push({ kind: 'facility', e: f, time: f.start_time || '00:00' }));
    items.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    return items;
  };

  const staffHoursByDay = (date) => {
    const dayStr = fmtLocalDate(date);
    const totals = {};
    staffEvents
      .filter(e => (e.event_date || fmtLocalDate(new Date(e.start_at))) === dayStr)
      .forEach(e => {
        const hours = Math.max(0, (new Date(e.end_at) - new Date(e.start_at)) / 3600000);
        const evAssigns = getEventAssignments(e);
        evAssigns.forEach(a => {
          const key = a.user_id;
          if (!totals[key]) totals[key] = { name: a.user?.full_name || 'Unknown', hours: 0 };
          totals[key].hours += hours;
        });
      });
    return Object.values(totals).sort((a, b) => a.name.localeCompare(b.name));
  };

  const weekRangeLabel = (() => {
    const a = weekStart;
    const b = addDays(weekStart, 6);
    const sameMonth = a.getMonth() === b.getMonth();
    const opts = { month: 'short', day: 'numeric' };
    return `${a.toLocaleDateString('en-US', opts)} – ${b.toLocaleDateString('en-US', { ...opts, month: sameMonth ? undefined : 'short', year: 'numeric' })}`;
  })();

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center space-x-2">
          <button onClick={goPrev} className="p-2 hover:bg-gray-100 rounded-lg" title="Previous week"><ChevronLeft size={18} /></button>
          <button onClick={goToday} className="px-3 py-1.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 rounded-lg">Today</button>
          <button onClick={goNext} className="p-2 hover:bg-gray-100 rounded-lg" title="Next week"><ChevronRight size={18} /></button>
          <h3 className="text-lg font-semibold text-gray-900 ml-2">
            {viewMode === 'day'
              ? selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
              : weekRangeLabel}
          </h3>
        </div>
        <div className="flex items-center space-x-3">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('week')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${viewMode === 'week' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
            >
              Week
            </button>
            <button
              onClick={() => { setViewMode('day'); setSelectedDay(new Date()); }}
              className={`px-3 py-1 text-xs font-medium rounded-md transition ${viewMode === 'day' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
            >
              Day
            </button>
            {canManage && (
              <button
                onClick={() => { setViewMode('coaches'); exitSelectMode(); }}
                className={`px-3 py-1 text-xs font-medium rounded-md transition ${viewMode === 'coaches' ? 'bg-white shadow text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}
              >
                All Coaches
              </button>
            )}
          </div>
          {viewMode !== 'coaches' && (
            <div className="hidden md:flex items-center space-x-3 text-xs text-gray-600">
              <span className="flex items-center space-x-1"><span className="w-3 h-3 rounded bg-indigo-500 inline-block" /><span>Staff</span></span>
              <span className="flex items-center space-x-1"><span className="w-3 h-3 rounded bg-purple-500 inline-block" /><span>Facility</span></span>
              <span className="flex items-center space-x-1"><UserCheck size={12} className="text-indigo-600" /><span>Assigned to you</span></span>
            </div>
          )}
          {canManage && viewMode !== 'coaches' && (
            <button
              onClick={() => { if (selecting) exitSelectMode(); else setSelecting(true); }}
              className={`flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium transition ${selecting ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            >
              <CheckSquare size={16} />
              <span>{selecting ? 'Done' : 'Select'}</span>
            </button>
          )}
          {canManage && viewMode !== 'coaches' && (
            <button
              onClick={() => { setEditing(null); setShowForm(true); }}
              className="flex items-center space-x-2 bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition text-sm font-medium"
            >
              <Plus size={16} />
              <span>New event</span>
            </button>
          )}
        </div>
      </div>
      {selecting && selectedEvents.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 px-3 flex items-center justify-between">
          <span className="text-sm text-blue-900 font-medium">{selectedEvents.length} selected</span>
          <div className="flex items-center space-x-2">
            <button onClick={bulkStaffDelete} className="bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-red-700 transition flex items-center space-x-1">
              <Trash2 size={14} /><span>Delete</span>
            </button>
            <button onClick={exitSelectMode} className="bg-gray-200 text-gray-700 px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-300 transition">Cancel</button>
          </div>
        </div>
      )}

      {viewMode === 'coaches' ? (
        <CoachAvailabilityWeek weekStart={weekStart} isAdmin={isAdmin} />
      ) : loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">Loading...</div>
      ) : viewMode === 'day' ? (
        <DailyTimeline
          day={selectedDay}
          staffEvents={staffEvents}
          facilityEvents={facilityEvents}
          staff={staff}
          assignments={assignments}
          assignmentsByEvent={assignmentsByEvent}
          myAssignedEventIds={myAssignedEventIds}
          getEventAssignments={getEventAssignments}
          isMyAssigned={isMyAssigned}
          onSelectEvent={setSelectedEvent}
          canManage={canManage}
          onClickSlot={(slotDay, hour, minute, staffId) => {
            const d = new Date(slotDay);
            d.setHours(hour, minute, 0, 0);
            const endD = new Date(d.getTime() + 3600000);
            setEditing({ _prefill: true, start_at: d.toISOString(), end_at: endD.toISOString(), _prefillStaff: staffId });
            setShowForm(true);
          }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
          {days.map((day, idx) => {
            const items = eventsByDay(day);
            const isToday = fmtLocalDate(day) === fmtLocalDate(new Date());
            const dayStr = fmtLocalDate(day);
            return (
              <div
                key={idx}
                className={`bg-white rounded-lg shadow min-h-[120px] flex flex-col ${isToday ? 'ring-2 ring-indigo-300' : ''}`}
                onDragOver={(e) => { if (canManage && !selecting) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                onDrop={(e) => {
                  if (!canManage || selecting) return;
                  e.preventDefault();
                  const id = e.dataTransfer.getData('application/x-staff-event-id');
                  if (id) onStaffDrop(id, dayStr);
                }}
              >
                <div className={`p-2 border-b ${isToday ? 'bg-indigo-50' : 'bg-gray-50'}`}>
                  <p className="text-xs font-medium text-gray-500 uppercase">{DAY_LABELS[day.getDay()]}</p>
                  <p className={`text-lg font-bold ${isToday ? 'text-indigo-700' : 'text-gray-900'}`}>{day.getDate()}</p>
                </div>
                <div className="p-2 space-y-1.5 flex-1">
                  {items.length === 0 && <p className="text-xs text-gray-300 text-center py-3">—</p>}
                  {items.map((it, i) => {
                    if (it.kind === 'facility') {
                      return (
                        <div key={`f-${it.e.id}-${i}`} className="rounded-md p-2 bg-purple-50 border-l-2 border-purple-400 text-xs cursor-default">
                          <div className="flex items-center space-x-1 text-purple-700 font-medium">
                            <Building size={11} />
                            <span className="truncate flex-1">{it.e.title || 'Facility event'}</span>
                          </div>
                          {it.e.start_time && (
                            <p className="text-purple-600 mt-0.5">
                              {formatTimeFromHHMM(it.e.start_time)}
                              {it.e.end_time && ` – ${formatTimeFromHHMM(it.e.end_time)}`}
                            </p>
                          )}
                          {it.e.location && <p className="text-gray-600 truncate">{it.e.location}</p>}
                        </div>
                      );
                    }
                    const assigned = isMyAssigned(it.e);
                    const eventAssigns = getEventAssignments(it.e);
                    const isSel = selecting && selectedIds.has(String(it.e.id));
                    return (
                      <button
                        key={`s-${it.e.id}`}
                        draggable={canManage && !selecting && !it.e._is_virtual}
                        onDragStart={(e) => {
                          if (!canManage || selecting || it.e._is_virtual) return;
                          e.stopPropagation();
                          e.dataTransfer.setData('application/x-staff-event-id', String(it.e.id));
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => { if (selecting && canManage) toggleSelect(it.e); else setSelectedEvent(it.e); }}
                        onContextMenu={(e) => { if (!canManage) return; e.preventDefault(); e.stopPropagation(); openStaffMenu(it.e, e); }}
                        className={`w-full text-left rounded-md p-2 border-l-2 text-xs hover:shadow-sm transition ${
                          assigned ? 'bg-indigo-100 border-indigo-600' : 'bg-indigo-50 border-indigo-400'
                        } ${isSel ? 'ring-2 ring-blue-500' : ''} ${canManage && !selecting && !it.e._is_virtual ? 'cursor-grab' : ''}`}
                      >
                        <div className="flex items-center space-x-1 text-indigo-700 font-medium">
                          {assigned && <UserCheck size={11} />}
                          {(it.e._is_virtual || it.e.is_recurring) && <Repeat size={10} className="text-indigo-400 flex-shrink-0" />}
                          <span className="truncate flex-1">{it.e.title}</span>
                        </div>
                        <p className="text-indigo-600 mt-0.5">
                          {formatTimeFromTS(it.e.start_at)} – {formatTimeFromTS(it.e.end_at)}
                        </p>
                        {it.e.location && <p className="text-gray-600 truncate">{it.e.location}</p>}
                        {eventAssigns.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {eventAssigns.slice(0, 4).map(a => (
                              <span
                                key={a.id}
                                className="inline-flex items-center bg-white text-indigo-700 px-1.5 py-0.5 rounded border border-indigo-200 truncate max-w-[88px] text-[10px]"
                                title={a.user?.full_name || 'Unknown'}
                              >
                                {(a.user?.full_name || '?').split(' ')[0]}
                              </span>
                            ))}
                            {eventAssigns.length > 4 && (
                              <span className="text-[10px] text-gray-500 self-center">+{eventAssigns.length - 4}</span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const summary = staffHoursByDay(day);
                  if (summary.length === 0) return null;
                  return (
                    <div className="border-t border-gray-100 px-2 py-1.5 bg-gray-50/60">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Staff hours</p>
                      <div className="space-y-0.5">
                        {summary.map(s => (
                          <div key={s.name} className="flex items-center justify-between text-[11px] text-gray-700">
                            <span className="truncate pr-1">{s.name}</span>
                            <span className="font-semibold tabular-nums">{(Math.round(s.hours * 10) / 10).toString().replace(/\.0$/, '')}h</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          assignments={getEventAssignments(selectedEvent)}
          canManage={canManage}
          onClose={() => setSelectedEvent(null)}
          onEdit={(editEvent) => { setEditing(editEvent || selectedEvent); setShowForm(true); setSelectedEvent(null); }}
          onDeleted={() => { setSelectedEvent(null); fetchAll(); }}
        />
      )}

      {showForm && (
        <EventFormModal
          editing={editing}
          staff={staff}
          existingAssignments={editing ? getEventAssignments(editing) : []}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); fetchAll(); }}
          createdBy={userId}
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

function DailyTimeline({ day, staffEvents, facilityEvents, staff, assignments, assignmentsByEvent, myAssignedEventIds, getEventAssignments, isMyAssigned, onSelectEvent, canManage, onClickSlot }) {
  const dayStr = fmtLocalDate(day);
  const START_HOUR = 6;
  const END_HOUR = 22;
  const TOTAL_HOURS = END_HOUR - START_HOUR;
  const HOURS = Array.from({ length: TOTAL_HOURS }, (_, i) => START_HOUR + i);
  const TOTAL_MINUTES = TOTAL_HOURS * 60;
  const ROW_HEIGHT = 40;
  const STAFF_COL_WIDTH = 140;

  const dayStaffEvents = staffEvents.filter(e => (e.event_date || fmtLocalDate(new Date(e.start_at))) === dayStr);
  const dayFacilityEvents = facilityEvents.filter(f => f.event_date === dayStr);

  const staffWithEvents = {};
  dayStaffEvents.forEach(ev => {
    const evAssigns = getEventAssignments(ev);
    if (evAssigns.length === 0) {
      const key = '__unassigned__';
      if (!staffWithEvents[key]) staffWithEvents[key] = { name: 'Unassigned', avatar_url: null, events: [] };
      staffWithEvents[key].events.push(ev);
    } else {
      evAssigns.forEach(a => {
        const key = a.user_id;
        if (!staffWithEvents[key]) staffWithEvents[key] = { name: a.user?.full_name || 'Unknown', avatar_url: a.user?.avatar_url, events: [] };
        staffWithEvents[key].events.push(ev);
      });
    }
  });

  const staffRows = staff.map(s => ({
    id: s.id,
    name: s.full_name,
    avatar_url: s.avatar_url,
    events: staffWithEvents[s.id]?.events || [],
  }));

  const scheduledCount = staffRows.filter(r => r.events.length > 0).length;
  const unscheduledCount = staffRows.length - scheduledCount;

  const getPosition = (startISO, endISO) => {
    const s = new Date(startISO);
    const e = new Date(endISO);
    const startMin = s.getHours() * 60 + s.getMinutes();
    const endMin = e.getHours() * 60 + e.getMinutes();
    const clampedStart = Math.max(0, startMin - START_HOUR * 60);
    const clampedEnd = Math.min(TOTAL_MINUTES, endMin - START_HOUR * 60);
    const left = (clampedStart / TOTAL_MINUTES) * 100;
    const width = Math.max(2, ((clampedEnd - clampedStart) / TOTAL_MINUTES) * 100);
    return { left: left + '%', width: width + '%' };
  };

  const getTotalHours = (events) => {
    const total = events.reduce((sum, ev) => sum + (new Date(ev.end_at) - new Date(ev.start_at)), 0);
    return Math.round((total / 3600000) * 10) / 10;
  };

  const isToday = fmtLocalDate(day) === fmtLocalDate(new Date());
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowLeft = ((nowMin - START_HOUR * 60) / TOTAL_MINUTES) * 100;
  const showNowLine = isToday && nowMin >= START_HOUR * 60 && nowMin <= END_HOUR * 60;

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ minWidth: STAFF_COL_WIDTH + TOTAL_HOURS * 60 }}>
          {/* Header row with time labels */}
          <div className="flex border-b border-gray-200 bg-gray-50 sticky top-0 z-10">
            <div className="flex-shrink-0 p-2 text-xs font-semibold text-gray-500 border-r border-gray-200" style={{ width: STAFF_COL_WIDTH }}>Staff</div>
            <div className="flex-1 flex relative">
              {HOURS.map(h => (
                <div key={h} className="text-center text-[11px] font-medium text-gray-500 border-r border-gray-100 py-2" style={{ width: (100 / TOTAL_HOURS) + '%' }}>
                  {h % 12 || 12}{h >= 12 ? 'p' : 'a'}
                </div>
              ))}
            </div>
          </div>

          {/* Staff rows */}
          {staffRows.map(row => {
            const totalH = getTotalHours(row.events);
            return (
              <div key={row.id} className="flex border-b border-gray-100 group hover:bg-gray-50/50">
                {/* Staff info cell */}
                <div className="flex-shrink-0 border-r border-gray-200 px-2 flex items-center space-x-1.5" style={{ width: STAFF_COL_WIDTH, height: ROW_HEIGHT }}>
                  {row.avatar_url ? (
                    <img src={row.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-6 h-6 bg-indigo-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                      {row.name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-gray-800 truncate leading-tight">{row.name.split(' ')[0]}</div>
                    {totalH > 0 && <div className="text-[10px] text-gray-400 leading-tight">{totalH}h</div>}
                  </div>
                </div>

                {/* Timeline cell */}
                <div
                  className={`flex-1 relative ${canManage ? 'cursor-pointer' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                  onClick={canManage ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = (e.clientX - rect.left) / rect.width;
                    const clickMin = Math.round((pct * TOTAL_MINUTES + START_HOUR * 60) / 15) * 15;
                    const clickHour = Math.floor(clickMin / 60);
                    const clickMinute = clickMin % 60;
                    onClickSlot && onClickSlot(day, clickHour, clickMinute, row.id);
                  } : undefined}
                >
                  {/* Vertical hour grid lines */}
                  {HOURS.map(h => (
                    <div key={h} className="absolute top-0 bottom-0 border-l border-gray-100" style={{ left: ((h - START_HOUR) / TOTAL_HOURS * 100) + '%' }} />
                  ))}

                  {/* Event blocks */}
                  {row.events.map(ev => {
                    const pos = getPosition(ev.start_at, ev.end_at);
                    const assigned = isMyAssigned(ev);
                    const durationH = (new Date(ev.end_at) - new Date(ev.start_at)) / 3600000;
                    return (
                      <button
                        key={ev.id}
                        onClick={() => onSelectEvent(ev)}
                        className={`absolute top-1 bottom-1 rounded-md px-1.5 flex items-center text-[10px] overflow-hidden hover:shadow-md transition z-[5] ${
                          assigned ? 'bg-indigo-200 border border-indigo-400 text-indigo-800' : 'bg-indigo-100 border border-indigo-300 text-indigo-700'
                        }`}
                        style={{ left: pos.left, width: pos.width, minWidth: 24 }}
                        title={`${ev.title} (${Math.round(durationH * 10) / 10}h)`}
                      >
                        <span className="font-medium truncate">{ev.title}</span>
                        <span className="ml-1 text-indigo-500 truncate hidden sm:inline">
                          {formatTimeFromTS(ev.start_at)} – {formatTimeFromTS(ev.end_at)}
                        </span>
                      </button>
                    );
                  })}

                  {/* Now line (vertical) */}
                  {showNowLine && (
                    <div className="absolute top-0 bottom-0 z-20 pointer-events-none flex flex-col items-center" style={{ left: nowLeft + '%' }}>
                      <div className="w-2 h-2 bg-red-500 rounded-full -mt-1" />
                      <div className="w-0.5 flex-1 bg-red-500" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary footer */}
      <div className="border-t border-gray-200 p-3 bg-gray-50 flex items-center justify-between text-xs text-gray-600">
        <div className="flex items-center space-x-4">
          <span className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 rounded bg-indigo-500 inline-block" />
            <span>{scheduledCount} scheduled</span>
          </span>
          <span className="text-gray-400">{unscheduledCount} unscheduled</span>
        </div>
        {dayFacilityEvents.length > 0 && (
          <div className="flex items-center space-x-1 text-purple-600">
            <Building size={12} />
            <span>{dayFacilityEvents.length} facility event{dayFacilityEvents.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EventDetailModal({ event, assignments, canManage, onClose, onEdit, onDeleted }) {
  const [showRecurringChoice, setShowRecurringChoice] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const isRecurring = event._is_virtual || event.is_recurring || event.recurrence_parent_id;
  const masterId = event._master_id || (event.recurrence_parent_id ? event.recurrence_parent_id : event.id);
  const occurrenceDate = event._occurrence_date || event.event_date;

  const handleDelete = async () => {
    if (!isRecurring) {
      if (!window.confirm(`Delete "${event.title}"?`)) return;
      const { error } = await supabase.from('staff_schedule_events').delete().eq('id', event.id);
      if (error) { alert('Delete failed: ' + formatUserError(error)); return; }
      onDeleted();
      return;
    }
    setShowRecurringChoice('delete');
  };

  const handleDeleteThis = async () => {
    setDeleting(true);
    const { error } = await supabase.from('staff_schedule_events').insert({
      title: event.title,
      start_at: event.start_at,
      end_at: event.end_at,
      event_date: occurrenceDate,
      recurrence_parent_id: masterId,
      original_date: occurrenceDate,
      is_cancelled: true,
      is_recurring: false,
    });
    if (error) { alert('Delete failed: ' + formatUserError(error)); setDeleting(false); return; }
    onDeleted();
  };

  const handleDeleteFuture = async () => {
    setDeleting(true);
    const dayBefore = fmtLocalDate(addDays(new Date(occurrenceDate + 'T12:00:00'), -1));
    // If this read fails we must stop. Writing an end date onto an empty
    // repeat pattern produces a rule with no frequency, which expands to no
    // occurrences at all — the whole series would vanish from the calendar.
    const { data: master, error: readError } = await supabase
      .from('staff_schedule_events').select('recurrence_rule').eq('id', masterId).single();
    if (readError || !master?.recurrence_rule) {
      alert('Could not read the repeat pattern for this event, so nothing was deleted. Refresh and try again.');
      setDeleting(false);
      return;
    }
    const updatedRule = { ...master.recurrence_rule, endType: 'until', until: dayBefore };
    const { error: updateError } = await supabase.from('staff_schedule_events').update({ recurrence_rule: updatedRule }).eq('id', masterId);
    if (updateError) { alert('Delete failed: ' + formatUserError(updateError)); setDeleting(false); return; }
    const { error: deleteError } = await supabase.from('staff_schedule_events').delete().not('recurrence_parent_id', 'is', null).eq('recurrence_parent_id', masterId).gte('event_date', occurrenceDate);
    if (deleteError) { alert('Some later copies of this event could not be removed: ' + formatUserError(deleteError)); setDeleting(false); return; }
    onDeleted();
  };

  const handleEditChoice = (mode) => {
    const editEvent = { ...event, _editMode: mode, _master_id: masterId, _occurrence_date: occurrenceDate };
    if (mode === 'future') {
      editEvent.recurrence_rule = event.recurrence_rule;
    }
    onEdit(editEvent);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center space-x-2">
            <h3 className="text-lg font-semibold text-gray-900">{event.title}</h3>
            {isRecurring && <Repeat size={14} className="text-gray-400" />}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center space-x-2 text-sm text-gray-700">
            <CalendarIcon size={16} className="text-gray-400" />
            <span>
              {new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
              {' · '}{formatTimeFromTS(event.start_at)} – {formatTimeFromTS(event.end_at)}
            </span>
          </div>
          {event.location && (
            <div className="flex items-center space-x-2 text-sm text-gray-700">
              <MapPin size={16} className="text-gray-400" />
              <span>{event.location}</span>
            </div>
          )}
          {isRecurring && (
            <div className="flex items-center space-x-2 text-sm text-gray-500">
              <Repeat size={14} className="text-gray-400" />
              <span>Recurring event</span>
            </div>
          )}
          {event.description && (
            <div className="text-sm text-gray-700 whitespace-pre-wrap">{event.description}</div>
          )}
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase mb-2">Assigned staff ({assignments.length})</p>
            {assignments.length === 0 ? (
              <p className="text-sm text-gray-500">No one assigned.</p>
            ) : (
              <div className="space-y-1.5">
                {assignments.map(a => (
                  <div key={a.id} className="flex items-center space-x-2 text-sm">
                    {a.user?.avatar_url ? (
                      <img src={a.user.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                    ) : (
                      <div className="w-6 h-6 bg-indigo-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                        {a.user?.full_name?.charAt(0) || '?'}
                      </div>
                    )}
                    <span className="text-gray-900">{a.user?.full_name || 'Unknown'}</span>
                    {a.role && <span className="text-xs text-gray-500">· {a.role}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {showRecurringChoice && (
          <div className="px-4 pb-4">
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3">
              <p className="text-sm font-medium text-gray-900">
                {showRecurringChoice === 'delete' ? 'Delete recurring event' : 'Edit recurring event'}
              </p>
              <div className="space-y-2">
                <button
                  onClick={() => showRecurringChoice === 'delete' ? handleDeleteThis() : handleEditChoice('this')}
                  disabled={deleting}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-white transition disabled:opacity-50"
                >
                  This event only
                </button>
                <button
                  onClick={() => showRecurringChoice === 'delete' ? handleDeleteFuture() : handleEditChoice('future')}
                  disabled={deleting}
                  className="w-full text-left px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-white transition disabled:opacity-50"
                >
                  This and all future events
                </button>
              </div>
              <button onClick={() => setShowRecurringChoice(null)} className="text-xs text-gray-500 hover:text-gray-700">
                Cancel
              </button>
            </div>
          </div>
        )}

        {canManage && !showRecurringChoice && (
          <div className="flex justify-end space-x-2 p-4 border-t bg-gray-50">
            <button
              onClick={handleDelete}
              className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition flex items-center space-x-1"
            >
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
            <button
              onClick={() => {
                if (isRecurring) { setShowRecurringChoice('edit'); return; }
                onEdit();
              }}
              className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition flex items-center space-x-1"
            >
              <Edit2 size={14} />
              <span>Edit</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EventFormModal({ editing, staff, existingAssignments, onClose, onSaved, createdBy }) {
  const isPrefill = editing?._prefill;
  const editRealId = editing && !editing._is_virtual && !editing._editMode && !isPrefill ? editing.id : null;

  const [title, setTitle] = useState(isPrefill ? '' : (editing?.title || ''));
  const [description, setDescription] = useState(isPrefill ? '' : (editing?.description || ''));
  const [startAt, setStartAt] = useState(editing ? dateToInputValue(editing.start_at) : '');
  const [endAt, setEndAt] = useState(editing ? dateToInputValue(editing.end_at) : '');
  const [location, setLocation] = useState(isPrefill ? '' : (editing?.location || ''));
  const [assignedIds, setAssignedIds] = useState(
    isPrefill && editing._prefillStaff ? [editing._prefillStaff] : existingAssignments.map(a => a.user_id)
  );
  const [saving, setSaving] = useState(false);

  const existingRule = editing?.recurrence_rule;
  const inferRecurrence = () => {
    if (!existingRule) return 'none';
    if (existingRule.freq === 'daily' && (existingRule.interval || 1) === 1 && existingRule.endType === 'never') return 'daily';
    if (existingRule.freq === 'weekly' && (existingRule.interval || 1) === 1 && (!existingRule.byDay || existingRule.byDay.length === 0) && existingRule.endType === 'never') return 'weekly';
    if (existingRule.freq === 'monthly' && (existingRule.interval || 1) === 1 && existingRule.endType === 'never') return 'monthly';
    return 'custom';
  };
  const showRecurrence = !editing || isPrefill || (!editing._editMode);
  const [recurrence, setRecurrence] = useState(!isPrefill && editing?.is_recurring ? inferRecurrence() : 'none');
  const [customRule, setCustomRule] = useState(existingRule || { freq: 'weekly', interval: 1, byDay: [], endType: 'never', count: 10, until: '' });

  const toggleAssign = (id) => {
    setAssignedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const buildRecurrenceRule = () => {
    if (recurrence === 'none') return null;
    if (recurrence === 'custom') {
      // Strip the fields that don't apply to the chosen end type, so a "Never"/"On date"
      // rule doesn't carry a stale count:10 that caps expansion at 10 occurrences.
      const r = { ...customRule };
      if (r.endType === 'never') { delete r.count; delete r.until; }
      else if (r.endType === 'count') { delete r.until; }
      else if (r.endType === 'until') { delete r.count; }
      return r;
    }
    const rule = { freq: recurrence, interval: 1, endType: 'never' };
    if (recurrence === 'weekly') {
      const startDate = new Date(startAt);
      if (!isNaN(startDate)) {
        rule.byDay = [RECURRENCE_DAY_CODES[startDate.getDay()]];
      }
    }
    return rule;
  };

  const handleSave = async () => {
    if (!title.trim()) { alert('Title is required.'); return; }
    if (!startAt || !endAt) { alert('Start and end times are required.'); return; }
    if (new Date(endAt) < new Date(startAt)) { alert('End time must be on or after start time.'); return; }
    setSaving(true);

    const startDate = new Date(startAt);
    const eventDate = fmtLocalDate(startDate);
    const isRecurring = recurrence !== 'none';
    const recurrenceRule = buildRecurrenceRule();

    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      start_at: startDate.toISOString(),
      end_at: new Date(endAt).toISOString(),
      location: location.trim() || null,
      event_date: eventDate,
    };

    if (editing?._editMode === 'this') {
      const masterId = editing._master_id || editing.id;
      const occDate = editing._occurrence_date || editing.event_date;
      const { data, error } = await supabase
        .from('staff_schedule_events')
        .insert({
          ...payload,
          recurrence_parent_id: masterId,
          original_date: occDate,
          is_recurring: false,
          recurrence_rule: null,
          created_by: createdBy,
        })
        .select('id')
        .single();
      if (error) { alert('Save failed: ' + formatUserError(error)); setSaving(false); return; }
      await syncAssignments(data.id, true);
      setSaving(false);
      onSaved();
      return;
    }

    if (editing?._editMode === 'future') {
      const masterId = editing._master_id || editing.id;
      const occDate = editing._occurrence_date || editing.event_date;
      const dayBefore = fmtLocalDate(addDays(new Date(occDate + 'T12:00:00'), -1));
      // Same trap as handleDeleteFuture: an end date written onto an empty
      // repeat pattern leaves a rule with no frequency, and the whole existing
      // series disappears from the calendar. Stop rather than write that.
      if (!editing.recurrence_rule) {
        alert('The repeat pattern for this event is missing, so it was not changed. Open the original repeating event and edit it there.');
        setSaving(false);
        return;
      }
      const { error: capError } = await supabase.from('staff_schedule_events').update({
        recurrence_rule: { ...editing.recurrence_rule, endType: 'until', until: dayBefore },
      }).eq('id', masterId);
      if (capError) { alert('Save failed: ' + formatUserError(capError)); setSaving(false); return; }
      const { error: trimError } = await supabase.from('staff_schedule_events').delete().not('recurrence_parent_id', 'is', null).eq('recurrence_parent_id', masterId).gte('event_date', occDate);
      if (trimError) { alert('Save failed: ' + formatUserError(trimError)); setSaving(false); return; }

      const { data, error } = await supabase
        .from('staff_schedule_events')
        .insert({
          ...payload,
          is_recurring: isRecurring,
          recurrence_rule: recurrenceRule,
          created_by: createdBy,
        })
        .select('id')
        .single();
      if (error) { alert('Save failed: ' + formatUserError(error)); setSaving(false); return; }
      await syncAssignments(data.id, true);
      setSaving(false);
      onSaved();
      return;
    }

    let eventId = editRealId;

    if (showRecurrence) {
      payload.is_recurring = isRecurring;
      payload.recurrence_rule = recurrenceRule;
    }

    if (editRealId) {
      const { error } = await supabase.from('staff_schedule_events').update(payload).eq('id', editRealId);
      if (error) { alert('Save failed: ' + formatUserError(error)); setSaving(false); return; }
    } else {
      const { data, error } = await supabase
        .from('staff_schedule_events')
        .insert({ ...payload, created_by: createdBy })
        .select('id')
        .single();
      if (error) { alert('Save failed: ' + formatUserError(error)); setSaving(false); return; }
      eventId = data.id;
    }

    // editRealId => updating an existing row (diff against its own assignments);
    // otherwise it's a brand-new insert (empty baseline).
    await syncAssignments(eventId, !editRealId);
    setSaving(false);
    onSaved();
  };

  const syncAssignments = async (eventId, isNewRow = false) => {
    // For a freshly-inserted row (single-occurrence / future edits create a new event
    // id) there are no assignments in the DB yet. Diffing against the MASTER's
    // assignments would make toAdd empty (nothing inserted) and toRemove delete the
    // master's rows. Treat a new row as having an empty baseline.
    const baseAssignments = isNewRow ? [] : existingAssignments;
    const existingIds = baseAssignments.map(a => a.user_id);
    const toAdd = assignedIds.filter(id => !existingIds.includes(id));
    const toRemove = baseAssignments.filter(a => !assignedIds.includes(a.user_id));
    if (toAdd.length > 0) {
      await supabase.from('staff_schedule_assignments').insert(toAdd.map(uid => ({ event_id: eventId, user_id: uid })));
    }
    if (toRemove.length > 0) {
      await supabase.from('staff_schedule_assignments').delete().in('id', toRemove.map(a => a.id));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold text-gray-900">
            {editing?._editMode === 'this' ? 'Edit this occurrence' : editing?._editMode === 'future' ? 'Edit this & future' : (editing && !isPrefill) ? 'Edit event' : 'New staff event'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. All-staff meeting" className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start</label>
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End</label>
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Location (optional)</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          {showRecurrence && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Repeat</label>
                <div className="flex items-center space-x-2">
                  <Repeat size={16} className="text-gray-400" />
                  <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="none">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="custom">Custom...</option>
                  </select>
                </div>
              </div>
              {recurrence === 'custom' && (
                <div className="ml-6 p-3 bg-gray-50 rounded-lg space-y-3 border border-gray-200">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-700">Every</span>
                    <input type="number" min="1" value={customRule.interval} onChange={(e) => setCustomRule({ ...customRule, interval: parseInt(e.target.value) || 1 })} className="w-16 px-2 py-1 border border-gray-300 rounded text-sm" />
                    <select value={customRule.freq} onChange={(e) => setCustomRule({ ...customRule, freq: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-sm">
                      <option value="daily">day(s)</option>
                      <option value="weekly">week(s)</option>
                      <option value="monthly">month(s)</option>
                    </select>
                  </div>
                  {customRule.freq === 'weekly' && (
                    <div className="flex items-center space-x-1.5">
                      <span className="text-sm text-gray-700">On:</span>
                      {RECURRENCE_DAY_CODES.map(day => (
                        <button key={day} type="button" onClick={() => { const days = customRule.byDay || []; setCustomRule({ ...customRule, byDay: days.includes(day) ? days.filter(d => d !== day) : [...days, day] }); }}
                          className={`w-8 h-8 rounded-full text-xs font-medium transition ${(customRule.byDay || []).includes(day) ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}
                        >{day.charAt(0)}</button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-700">Ends:</span>
                    <select value={customRule.endType} onChange={(e) => setCustomRule({ ...customRule, endType: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-sm">
                      <option value="never">Never</option>
                      <option value="count">After</option>
                      <option value="until">On date</option>
                    </select>
                    {customRule.endType === 'count' && (
                      <>
                        <input type="number" min="1" value={customRule.count} onChange={(e) => setCustomRule({ ...customRule, count: parseInt(e.target.value) || 1 })} className="w-16 px-2 py-1 border border-gray-300 rounded text-sm" />
                        <span className="text-sm text-gray-700">occurrences</span>
                      </>
                    )}
                    {customRule.endType === 'until' && (
                      <input type="date" value={customRule.until} onChange={(e) => setCustomRule({ ...customRule, until: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-sm" />
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assign staff</label>
            <div className="border border-gray-300 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100">
              {staff.map(s => (
                <label key={s.id} className="flex items-center space-x-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={assignedIds.includes(s.id)} onChange={() => toggleAssign(s.id)} className="rounded" />
                  <span className="text-sm text-gray-900">{s.full_name}</span>
                  <span className="text-xs text-gray-500">({s.role})</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1">{assignedIds.length} selected</p>
          </div>
        </div>
        <div className="flex justify-end space-x-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:text-gray-900 transition">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50">
            {saving ? 'Saving...' : (editing && !isPrefill) ? 'Save changes' : 'Create event'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// ALL-COACHES AVAILABILITY (training_slots) — week matrix + bulk public toggle
// ============================================
function formatSlotTime(time) {
  if (!time) return '';
  const [h, m] = time.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function formatPriceCents(cents) {
  if (cents == null) return '';
  const d = cents / 100;
  return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

function CoachAvailabilityWeek({ weekStart, isAdmin }) {
  const [slots, setSlots] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const wkStart = new Date(weekStart); wkStart.setHours(0, 0, 0, 0);
    const wkEnd = addDays(wkStart, 6);
    const startStr = fmtLocalDate(wkStart);
    const endStr = fmtLocalDate(wkEnd);

    const [slotRes, coachRes, resvRes] = await Promise.all([
      // #470: slot-autoclean adds ~15 tombstone rows a day; page past the
      // 1,000-row PostgREST cap (#437).
      readAllPages(() => supabase.from('training_slots').select('*').order('id')).then(({ rows, error }) => ({ data: rows, error })),
      supabase.from('users').select('id, full_name, avatar_url').in('role', ['admin', 'coach']).order('full_name'),
      supabase.from('slot_reservations').select('id, slot_id, slot_date, status').gte('slot_date', startStr).lte('slot_date', endStr).neq('status', 'cancelled'),
    ]);
    if (slotRes.error) console.error('WorkSchedule fetchData: training_slots query failed:', slotRes.error);

    const raw = slotRes.data || [];
    const slotExceptionMap = buildSlotExceptionMap(raw);
    const expanded = [];
    raw.forEach(slot => {
      if (slot.recurrence_parent_id) return;
      if (slot.repeat_weekly) {
        const slotStart = new Date(slot.slot_date + 'T00:00:00');
        const endDate = slot.repeat_end_date ? new Date(slot.repeat_end_date + 'T00:00:00') : wkEnd;
        let current = new Date(slotStart);
        while (current <= endDate && current <= wkEnd) {
          const dateStr = fmtLocalDate(current);
          // #292: ANY exception skips the date — tombstoned dates are gone,
          // moved dates render from their child row below.
          if (current >= wkStart && !getSlotDateException(slotExceptionMap, slot.id, dateStr)) {
            expanded.push({ ...slot, slot_date: dateStr });
          }
          current.setDate(current.getDate() + 7);
        }
      } else if (slot.slot_date >= startStr && slot.slot_date <= endStr && !getSlotDateException(slotExceptionMap, slot.id, slot.slot_date)) {
        expanded.push(slot);
      }
    });
    // #292: moved occurrences are real sessions on their own date.
    collectMovedSlots(raw).forEach(slot => {
      if (slot.slot_date >= startStr && slot.slot_date <= endStr) {
        expanded.push(slot);
      }
    });

    setSlots(expanded);
    setCoaches(coachRes.data || []);
    setReservations(resvRes.data || []);
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const exitSelect = () => { setSelecting(false); setSelectedIds(new Set()); };
  const toggleSelect = (slotId) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(slotId)) next.delete(slotId); else next.add(slotId);
    return next;
  });

  const bookedCount = (slotId, dateStr) =>
    reservations.filter(r => r.slot_id === slotId && r.slot_date === dateStr).length;

  // Coaches that actually have slots this week
  const coachesWithSlots = coaches.filter(c => slots.some(s => s.coach_id === c.id));

  const applyPublic = async (makePublic) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    let payload;
    if (makePublic) {
      const input = window.prompt(`Public price per session (USD) — applied to all ${ids.length} selected session(s):`, '');
      if (input === null) return;
      const cents = Math.round(parseFloat(input) * 100);
      if (isNaN(cents) || cents < 0) { alert('Enter a valid price (e.g. 40).'); return; }
      payload = { is_public: true, public_price_cents: cents };
    } else {
      if (!window.confirm(`Remove ${ids.length} selected session(s) from public bookings?`)) return;
      payload = { is_public: false };
    }
    setBusy(true);
    const { error } = await supabase.from('training_slots').update(payload).in('id', ids);
    setBusy(false);
    if (error) { alert('Update failed: ' + formatUserError(error)); return; }
    exitSelect();
    fetchData();
  };

  if (loading) {
    return <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">Loading coach availability...</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center space-x-3 text-xs text-gray-600">
          <span className="flex items-center space-x-1"><Globe size={12} className="text-green-600" /><span>Public (bookable)</span></span>
          <span className="flex items-center space-x-1"><Lock size={12} className="text-gray-400" /><span>Private</span></span>
        </div>
        {isAdmin && (
          <button
            onClick={() => { if (selecting) exitSelect(); else setSelecting(true); }}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-sm font-medium transition ${selecting ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            <CheckSquare size={15} />
            <span>{selecting ? 'Done selecting' : 'Select sessions'}</span>
          </button>
        )}
      </div>

      {isAdmin && selecting && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 px-3 flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm text-blue-900 font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center space-x-2">
            <button onClick={() => applyPublic(true)} disabled={busy || selectedIds.size === 0} className="bg-green-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-green-700 transition flex items-center space-x-1 disabled:opacity-50">
              <Globe size={14} /><span>Make public</span>
            </button>
            <button onClick={() => applyPublic(false)} disabled={busy || selectedIds.size === 0} className="bg-gray-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-700 transition flex items-center space-x-1 disabled:opacity-50">
              <Lock size={14} /><span>Make private</span>
            </button>
            <button onClick={exitSelect} className="bg-gray-200 text-gray-700 px-3 py-1.5 rounded text-sm font-medium hover:bg-gray-300 transition">Cancel</button>
          </div>
        </div>
      )}

      {coachesWithSlots.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          <UsersIcon size={28} className="mx-auto text-gray-300 mb-2" />
          No coach sessions scheduled this week.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <div className="min-w-[900px]">
            {/* Header */}
            <div className="grid border-b border-gray-200 bg-gray-50 sticky top-0 z-10" style={{ gridTemplateColumns: '150px repeat(7, 1fr)' }}>
              <div className="p-2 text-xs font-semibold text-gray-500 border-r border-gray-200">Coach</div>
              {days.map((d, i) => {
                const isToday = fmtLocalDate(d) === fmtLocalDate(new Date());
                return (
                  <div key={i} className={`p-2 text-center border-r border-gray-100 ${isToday ? 'bg-indigo-50' : ''}`}>
                    <div className="text-[11px] font-medium text-gray-500 uppercase">{DAY_LABELS[d.getDay()]}</div>
                    <div className={`text-sm font-bold ${isToday ? 'text-indigo-700' : 'text-gray-900'}`}>{d.getDate()}</div>
                  </div>
                );
              })}
            </div>

            {/* Coach rows */}
            {coachesWithSlots.map(coach => (
              <div key={coach.id} className="grid border-b border-gray-100" style={{ gridTemplateColumns: '150px repeat(7, 1fr)' }}>
                <div className="border-r border-gray-200 px-2 py-2 flex items-center space-x-1.5">
                  {coach.avatar_url ? (
                    <img src={coach.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-6 h-6 bg-teal-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">{coach.full_name?.charAt(0) || '?'}</div>
                  )}
                  <span className="text-xs font-medium text-gray-800 truncate">{coach.full_name}</span>
                </div>
                {days.map((d, di) => {
                  const dateStr = fmtLocalDate(d);
                  const daySlots = slots
                    .filter(s => s.coach_id === coach.id && s.slot_date === dateStr)
                    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
                  return (
                    <div key={di} className="border-r border-gray-100 p-1 space-y-1 min-h-[52px]">
                      {daySlots.map((slot, si) => {
                        const isSel = selectedIds.has(slot.id);
                        const booked = bookedCount(slot.id, dateStr);
                        const isPublic = !!slot.is_public;
                        return (
                          <button
                            key={`${slot.id}-${si}`}
                            onClick={() => { if (selecting && isAdmin) toggleSelect(slot.id); }}
                            className={`w-full text-left rounded-md px-1.5 py-1 border text-[11px] transition ${
                              isPublic ? 'bg-green-50 border-green-300' : 'bg-gray-50 border-gray-200'
                            } ${isSel ? 'ring-2 ring-blue-500' : ''} ${selecting && isAdmin ? 'cursor-pointer hover:border-blue-400' : 'cursor-default'}`}
                            title={isPublic ? `Public${slot.public_price_cents != null ? ' · ' + formatPriceCents(slot.public_price_cents) : ''}` : 'Private'}
                          >
                            <div className="flex items-center space-x-1">
                              {isPublic ? <Globe size={10} className="text-green-600 flex-shrink-0" /> : <Lock size={10} className="text-gray-400 flex-shrink-0" />}
                              <span className="font-semibold text-gray-900 truncate">{formatSlotTime(slot.start_time)}</span>
                            </div>
                            <div className="flex items-center justify-between text-gray-500 mt-0.5">
                              <span>{slot.duration_minutes}m</span>
                              {isPublic && slot.public_price_cents != null && <span className="text-green-700 font-medium">{formatPriceCents(slot.public_price_cents)}</span>}
                            </div>
                            <div className="text-[10px] text-gray-400">{booked}/{slot.max_players || 1} booked</div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
