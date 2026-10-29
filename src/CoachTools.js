import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { scheduleProgramEvents } from './programScheduling';
import { Plus, Calendar, Dumbbell, Utensils, TrendingUp, Target, X, Trash2, ChevronDown, ChevronUp, ChevronRight, Users, User, Play, ExternalLink, Clock, Check, XCircle, Edit2, Phone, Link, Search, Eye, EyeOff, GripVertical, ClipboardList, FileText, RotateCcw, Activity, AlertTriangle } from 'lucide-react';
import AssessmentTrends from './AssessmentTrends';
import { formatUserError } from './errorMessage';
import { buildSlotExceptionMap, getSlotDateException, collectMovedSlots } from './scheduleUtils';
import { LANES } from './Schedule';
import { useModalTracking, trackAction } from './usage';
import { useExerciseVideos } from './exerciseVideos';
import ExerciseNameInput from './ExerciseNameInput';
import { metricsByGroup } from './assessmentMetrics';
import { EXTERNAL_STAT_SOURCES, EXTERNAL_STATS_BUCKET, sourceInfo, sourceName } from './externalStatsSources';
import { REGISTRATION_SITES, REGISTRATIONS_BUCKET, hasRegistrationProof } from './registrationSites';

// Format a Date to local YYYY-MM-DD (avoids toISOString UTC drift)
const fmtLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

export default function CoachTools({ userRole, userId, onNavigateToProfile }) {
  // #469: ?view=tasks (coach task emails) hands off 'tasks' via sessionStorage.
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const t = sessionStorage.getItem('nbp_coachtools_tab');
      if (t) { sessionStorage.removeItem('nbp_coachtools_tab'); return t; }
    } catch {}
    return 'schedule';
  });
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchTeams(); fetchPlayers(); }, []);

  const fetchTeams = async () => {
    const { data, error } = await supabase.from('teams').select('*').order('name');
    if (!error) setTeams(data);
    setLoading(false);
  };

  const fetchPlayers = async () => {
    // #437: paged past the 1,000-row clamp.
    const { rows, error } = await readAllPages(() => supabase
      .from('users')
      .select('id, full_name, email, player_profiles!player_profiles_user_id_fkey(position, jersey_number, level), team_members(team_id, teams(name, team_type))')
      .or('role.eq.player,secondary_role.eq.player')
      .order('full_name')
      .order('id'));
    if (!error) setPlayers(rows);
  };

  if (loading) {
    return (<div className="flex items-center justify-center py-12"><p className="text-gray-600">Loading...</p></div>);
  }

  const tabs = [
    { key: 'schedule', icon: Calendar, label: 'Schedule' },
    { key: 'stats', icon: TrendingUp, label: 'Player Stats' },
    { key: 'registrations', icon: FileText, label: 'Registrations' },
    { key: 'whoop', icon: Activity, label: 'WHOOP' },
    { key: 'benchmarks', icon: Target, label: 'Assessments' },
    { key: 'slots', icon: Clock, label: 'Training Slots' },
    { key: 'tasks', icon: ClipboardList, label: 'My Tasks' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Coach Tools</h2>
        <p className="text-gray-600 mt-1">Manage schedules, stats, and training programs</p>
      </div>
      <div className="bg-white rounded-lg shadow">
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8 px-6 overflow-x-auto">
            {tabs.map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`py-4 px-1 border-b-2 font-medium text-sm transition whitespace-nowrap ${activeTab === tab.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                <tab.icon size={16} className="inline mr-2" />{tab.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="p-6">
          {activeTab === 'schedule' && <ScheduleTab teams={teams} />}
          {activeTab === 'stats' && <PlayerStatsTab players={players} onNavigateToProfile={onNavigateToProfile} />}
          {activeTab === 'registrations' && <RegistrationsTab players={players} onNavigateToProfile={onNavigateToProfile} />}
          {activeTab === 'whoop' && <WhoopConnectionsTab players={players} onNavigateToProfile={onNavigateToProfile} />}
          {activeTab === 'benchmarks' && <AssessmentsTab players={players} userId={userId} />}
          {activeTab === 'slots' && <TrainingSlotsTab userId={userId} />}
          {activeTab === 'tasks' && <MyTasksTab userId={userId} />}
        </div>
      </div>
    </div>
  );
}

/* ============================================
   SCHEDULE TAB
   ============================================ */

function ScheduleTab({ teams }) {
  const [showForm, setShowForm] = useState(false);
  const [events, setEvents] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTeam, setFilterTeam] = useState('All');
  const [filterType, setFilterType] = useState('All');
  const [filterTimeframe, setFilterTimeframe] = useState('upcoming');
  useEffect(() => { fetchEvents(); }, []);

  const fetchEvents = async () => {
    // Team events: either legacy team_id is set, OR team_ids[] is non-empty
    const { data, error } = await supabase
      .from('schedule_events')
      .select('*, teams(name)')
      .or('team_id.not.is.null,team_ids.not.is.null')
      .is('player_id', null) // Exclude player-specific events
      .order('event_date', { ascending: true });
    if (error) { console.error('Error fetching team events:', error); return; }
    // Drop rows where team_ids is an empty array (PostgREST's not-null check passes those)
    setEvents((data || []).filter(e => e.team_id || (Array.isArray(e.team_ids) && e.team_ids.length > 0)));
  };

  const handleDeleteEvent = async (eventId) => {
    if (!window.confirm('Are you sure you want to delete this event?')) return;
    const { error } = await supabase.from('schedule_events').delete().eq('id', eventId);
    if (error) {
      console.error('Error deleting event:', error);
      alert('Error deleting event: ' + formatUserError(error));
    } else {
      fetchEvents();
    }
  };

  const teamNameById = Object.fromEntries((teams || []).map(t => [t.id, t.name]));
  const teamIdsFor = (ev) => {
    const ids = Array.isArray(ev.team_ids) && ev.team_ids.length > 0 ? ev.team_ids : (ev.team_id ? [ev.team_id] : []);
    return ids;
  };

  const todayStr = fmtLocalDate(new Date());
  const filteredEvents = events.filter(ev => {
    if (filterTeam !== 'All' && !teamIdsFor(ev).includes(filterTeam)) return false;
    if (filterType !== 'All' && ev.event_type !== filterType) return false;
    if (filterTimeframe === 'upcoming' && ev.event_date < todayStr) return false;
    if (filterTimeframe === 'past' && ev.event_date >= todayStr) return false;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const teamNames = teamIdsFor(ev).map(id => teamNameById[id]).filter(Boolean).join(' ');
      const haystack = [
        ev.title, ev.opponent, ev.location, ev.address, ev.notes,
        teamNames, ev.event_type
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const filterSelectClass = "px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">Schedule Events</h3>
        <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
          <Plus size={18} /><span>Add Event</span>
        </button>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search title, opponent, location, notes..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)} className={filterSelectClass}>
          <option value="All">All teams</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={filterSelectClass}>
          <option value="All">All types</option>
          <option value="practice">Practice</option>
          <option value="game">Game</option>
          <option value="tryout">Tryout</option>
        </select>
        <select value={filterTimeframe} onChange={(e) => setFilterTimeframe(e.target.value)} className={filterSelectClass}>
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="all">All time</option>
        </select>
        {(searchQuery || filterTeam !== 'All' || filterType !== 'All' || filterTimeframe !== 'upcoming') && (
          <button
            onClick={() => { setSearchQuery(''); setFilterTeam('All'); setFilterType('All'); setFilterTimeframe('upcoming'); }}
            className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1"
          >
            Reset
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{filteredEvents.length} of {events.length}</span>
      </div>
      <div className="space-y-2">
        {filteredEvents.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-sm">No events match these filters.</div>
        )}
        {filteredEvents.map(event => (
          <div key={event.id} className="bg-gray-50 rounded-lg p-4 flex justify-between items-center">
            <div>
              <div className="flex items-center space-x-3">
                <span className="font-semibold text-gray-900">{event.title || event.opponent}</span>
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                  event.event_type === 'game' ? 'bg-slate-100 text-slate-700' :
                  event.event_type === 'practice' ? 'bg-green-100 text-green-700' :
                  event.event_type === 'workout' ? 'bg-orange-100 text-orange-700' :
                  event.event_type === 'tryout' ? 'bg-amber-100 text-amber-700' :
                  event.event_type === 'meal' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-700'
                }`}>{event.event_type}</span>
                {event.is_optional && <span className="px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">Optional - RSVP</span>}
              </div>
              <div className="text-sm text-gray-600 mt-1">
                {new Date(event.event_date + 'T00:00:00').toLocaleDateString()}
                {event.event_time
                  ? ` • ${event.event_time}${event.event_end_time ? `–${event.event_end_time}` : ''}`
                  : ' • TBD'}
                {event.location && ` • ${event.location}`}
                {event.recurrence_rule && ` • ${event.recurrence_rule.charAt(0).toUpperCase() + event.recurrence_rule.slice(1)}`}
              </div>
              {(() => {
                const ids = teamIdsFor(event);
                if (ids.length === 0) return null;
                const names = ids.map(id => teamNameById[id]).filter(Boolean);
                if (names.length === 0) return null;
                return <div className="text-xs text-gray-500 mt-1">{names.length > 1 ? 'Teams' : 'Team'}: {names.join(', ')}</div>;
              })()}
              {event.lanes && event.lanes.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {event.lanes.map(lane => (
                    <span key={lane} className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">{lane}</span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => handleDeleteEvent(event.id)}
              className="text-gray-400 hover:text-red-600 transition ml-4 flex-shrink-0"
              title="Delete event"
            >
              <Trash2 size={18} />
            </button>
          </div>
        ))}
      </div>
      {showForm && <CreateScheduleModal teams={teams} onClose={() => setShowForm(false)} onSuccess={() => { setShowForm(false); fetchEvents(); }} />}
    </div>
  );
}

function generateRecurrenceDates(startDate, rule, interval, endDate, customUnit, customDays) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  if (isNaN(start) || isNaN(end) || end < start) return [startDate];

  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Custom + weekly + specific weekdays: walk day-by-day, push days that match the selected weekdays,
  // and skip ahead by (interval - 1) weeks at the end of each week.
  const weekdayPicker = rule === 'custom' && customUnit === 'weeks' && Array.isArray(customDays) && customDays.length > 0;
  if (weekdayPicker) {
    const n = Math.max(1, parseInt(interval) || 1);
    const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const allowed = new Set(customDays);
    let cur = new Date(start);
    // Track week boundaries by counting Sunday crossings (DST-safe)
    let weekNum = 0;
    let safety = 0;
    while (cur <= end && safety < 2000) {
      // Detect new week when we hit Sunday (after the first iteration)
      if (safety > 0 && cur.getDay() === 0) weekNum++;

      if (allowed.has(dayCodes[cur.getDay()]) && weekNum % n === 0) {
        dates.push(fmt(cur));
      }
      cur.setDate(cur.getDate() + 1);
      safety++;
    }
    return dates;
  }

  const step = (d) => {
    if (rule === 'daily') d.setDate(d.getDate() + 1);
    else if (rule === 'weekly') d.setDate(d.getDate() + 7);
    else if (rule === 'biweekly') d.setDate(d.getDate() + 14);
    else if (rule === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (rule === 'custom') {
      const n = Math.max(1, parseInt(interval) || 1);
      if (customUnit === 'weeks') d.setDate(d.getDate() + 7 * n);
      else if (customUnit === 'months') d.setMonth(d.getMonth() + n);
      else d.setDate(d.getDate() + n);
    }
  };
  let cur = new Date(start);
  let safety = 0;
  while (cur <= end && safety < 2000) {
    dates.push(fmt(cur));
    step(cur);
    safety++;
  }
  return dates;
}

function CreateScheduleModal({ teams, onClose, onSuccess }) {
  // Reuse Schedule's LANES rather than keeping a fourth copy of the list. The
  // facility went from 14 lanes to 7 (#67/#68) but this dropdown kept offering
  // Lane 8-14: those events saved fine and were then silently dropped by the
  // Lanes grid, which only buckets the lanes in LANES. Import means it can't
  // drift again — LANES in Schedule.js is the one source of truth.
  const LANE_OPTIONS = LANES;
  const [formData, setFormData] = useState({ team_id: '', event_type: 'practice', opponent: '', event_date: '', event_time: '', event_end_time: '', location: '', address: '', home_away: null, is_optional: false, notes: '', lanes: [] });
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
  const [timeTBD, setTimeTBD] = useState(false);
  const [recurrence, setRecurrence] = useState('none');
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('');
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState('weeks');
  const [customDays, setCustomDays] = useState([]);
  const [locationSuggestions, setLocationSuggestions] = useState([]);
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchSuggestions = async () => {
      const { data } = await supabase.from('schedule_events').select('location, address');
      if (!data) return;
      const locs = [...new Set(data.map(r => r.location).filter(Boolean))].sort();
      const addrs = [...new Set(data.map(r => r.address).filter(Boolean))].sort();
      setLocationSuggestions(locs);
      setAddressSuggestions(addrs);
    };
    fetchSuggestions();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    if (selectedTeamIds.length === 0) {
      setError('Please select at least one team.');
      setLoading(false);
      return;
    }
    const { team_id: _ignored, ...rest } = formData;
    const baseShared = {
      ...rest,
      team_id: selectedTeamIds[0],
      team_ids: selectedTeamIds,
      event_time: timeTBD ? null : (formData.event_time || null),
      event_end_time: timeTBD ? null : (formData.event_end_time || null),
      home_away: formData.event_type === 'game' ? formData.home_away : null,
      lanes: formData.lanes.length > 0 ? formData.lanes : null,
    };

    if (recurrence === 'none') {
      const { error: insertError } = await supabase.from('schedule_events').insert(baseShared);
      if (insertError) { setError(insertError.message); setLoading(false); return; }
      setLoading(false);
      const teamWord = selectedTeamIds.length > 1 ? `${selectedTeamIds.length} teams` : '1 team';
      alert(`Created event for ${teamWord}!`);
      onSuccess();
      return;
    }

    if (!recurrenceEndDate) {
      setError('Please select an end date for the recurring event.');
      setLoading(false);
      return;
    }

    const dates = generateRecurrenceDates(formData.event_date, recurrence, customInterval, recurrenceEndDate, customUnit, customDays);
    if (dates.length === 0) { setError('No occurrences generated.'); setLoading(false); return; }

    const parentRow = {
      ...baseShared,
      event_date: dates[0],
      recurrence_rule: recurrence,
      recurrence_interval: recurrence === 'custom' ? parseInt(customInterval) || 1 : null,
      recurrence_end_date: recurrenceEndDate,
    };
    const { data: parent, error: parentErr } = await supabase.from('schedule_events').insert(parentRow).select('id').single();
    if (parentErr) { setError(parentErr.message); setLoading(false); return; }
    let totalCreated = 1;

    if (dates.length > 1) {
      const children = dates.slice(1).map(d => ({
        ...baseShared,
        event_date: d,
        recurrence_parent_id: parent.id,
      }));
      const { error: childErr } = await supabase.from('schedule_events').insert(children);
      if (childErr) { setError(childErr.message); setLoading(false); return; }
      totalCreated += children.length;
    }

    setLoading(false);
    const teamWord = selectedTeamIds.length > 1 ? `${selectedTeamIds.length} teams` : '1 team';
    alert(`Created ${totalCreated} occurrence${totalCreated !== 1 ? 's' : ''} for ${teamWord}!`);
    onSuccess();
  };

  const recurrenceNeedsEnd = recurrence !== 'none';
  const customUnitLabel = customUnit === 'days' ? 'day' : customUnit === 'weeks' ? 'week' : 'month';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Add Schedule Event</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <datalist id="schedule-location-suggestions">
            {locationSuggestions.map(l => <option key={l} value={l} />)}
          </datalist>
          <datalist id="schedule-address-suggestions">
            {addressSuggestions.map(a => <option key={a} value={a} />)}
          </datalist>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Team(s) *</label>
              <div className="border border-gray-300 rounded-lg p-2 max-h-32 overflow-y-auto bg-white">
                {teams.length === 0 && <p className="text-xs text-gray-500 px-2 py-1">No teams available</p>}
                {teams.map(team => (
                  <label key={team.id} className="flex items-center space-x-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedTeamIds.includes(team.id)}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedTeamIds([...selectedTeamIds, team.id]);
                        else setSelectedTeamIds(selectedTeamIds.filter(id => id !== team.id));
                      }}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-900">{team.name}</span>
                  </label>
                ))}
              </div>
              {selectedTeamIds.length > 0 && (
                <p className="text-xs text-gray-500 mt-1">{selectedTeamIds.length} team{selectedTeamIds.length > 1 ? 's' : ''} selected — {selectedTeamIds.length > 1 ? 'one shared event will be created and shown to all selected teams' : 'one event will be created'}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Event Type *</label>
              <select value={formData.event_type} onChange={(e) => setFormData({...formData, event_type: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="practice">Practice</option>
                <option value="game">Game</option>
                <option value="tryout">Tryout</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">{formData.event_type === 'game' ? 'Opponent' : 'Event Name'} *</label>
              <input type="text" required placeholder={formData.event_type === 'game' ? 'e.g., Hawks Academy' : 'e.g., Team Practice'} value={formData.opponent} onChange={(e) => setFormData({...formData, opponent: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Date *</label>
              <input type="date" required value={formData.event_date} onChange={(e) => setFormData({...formData, event_date: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Start Time {!timeTBD && '*'}</label>
              <input
                type="time"
                required={!timeTBD}
                disabled={timeTBD}
                value={timeTBD ? '' : formData.event_time}
                onChange={(e) => setFormData({...formData, event_time: e.target.value})}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">End Time</label>
              <input
                type="time"
                disabled={timeTBD}
                value={timeTBD ? '' : formData.event_end_time}
                onChange={(e) => setFormData({...formData, event_end_time: e.target.value})}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${timeTBD ? 'bg-gray-100 text-gray-400' : ''}`}
              />
            </div>
            <div className="col-span-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={timeTBD}
                  onChange={(e) => setTimeTBD(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-gray-700">Time TBD (e.g. tournament — set later)</span>
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Repeats</label>
              <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            {recurrence === 'custom' && (
              <div className="col-span-2 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Repeat every</label>
                  <div className="flex items-center space-x-2">
                    <input type="number" min="1" value={customInterval} onChange={(e) => setCustomInterval(e.target.value)} className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="days">day{customInterval > 1 ? 's' : ''}</option>
                      <option value="weeks">week{customInterval > 1 ? 's' : ''}</option>
                      <option value="months">month{customInterval > 1 ? 's' : ''}</option>
                    </select>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Every {customInterval} {customUnitLabel}{customInterval > 1 ? 's' : ''}</p>
                </div>
                {customUnit === 'weeks' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Repeat on</label>
                    <div className="flex space-x-2">
                      {[
                        { code: 'SU', label: 'S' },
                        { code: 'MO', label: 'M' },
                        { code: 'TU', label: 'T' },
                        { code: 'WE', label: 'W' },
                        { code: 'TH', label: 'T' },
                        { code: 'FR', label: 'F' },
                        { code: 'SA', label: 'S' },
                      ].map(d => {
                        const active = customDays.includes(d.code);
                        return (
                          <button
                            key={d.code}
                            type="button"
                            onClick={() => setCustomDays(active ? customDays.filter(c => c !== d.code) : [...customDays, d.code])}
                            className={`w-9 h-9 rounded-full text-xs font-semibold transition ${active ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'}`}
                            title={d.code}
                          >
                            {d.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Leave empty to repeat on the same weekday as the start date.</p>
                  </div>
                )}
              </div>
            )}
            {recurrenceNeedsEnd && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">Ends On *</label>
                <input type="date" required value={recurrenceEndDate} onChange={(e) => setRecurrenceEndDate(e.target.value)} min={formData.event_date || undefined} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Location *</label>
              <input type="text" required list="schedule-location-suggestions" autoComplete="off" placeholder="e.g., Home Field" value={formData.location} onChange={(e) => setFormData({...formData, location: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Address</label>
              <input type="text" list="schedule-address-suggestions" autoComplete="off" placeholder="Full address" value={formData.address} onChange={(e) => setFormData({...formData, address: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {formData.event_type === 'game' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Home/Away</label>
                <select value={formData.home_away || ''} onChange={(e) => setFormData({...formData, home_away: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Not specified</option><option value="home">Home</option><option value="away">Away</option>
                </select>
              </div>
            )}
            <div className="col-span-2">
              <label className="flex items-center space-x-2">
                <input type="checkbox" checked={formData.is_optional} onChange={(e) => setFormData({...formData, is_optional: e.target.checked})} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" />
                <span className="text-sm font-medium text-gray-700">Optional Event (players can RSVP)</span>
              </label>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Reserved Lanes</label>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {LANE_OPTIONS.map(lane => (
                  <label key={lane} className="flex items-center space-x-2 text-sm">
                    <input type="checkbox" checked={formData.lanes.includes(lane)} onChange={(e) => {
                      const updated = e.target.checked ? [...formData.lanes, lane] : formData.lanes.filter(l => l !== lane);
                      setFormData({...formData, lanes: updated});
                    }} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" />
                    <span className="text-gray-700">{lane}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
              <textarea value={formData.notes} onChange={(e) => setFormData({...formData, notes: e.target.value})} rows="3" placeholder="Additional information..." className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Creating...' : 'Create Event'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================
   ROSTER TAB
   ============================================ */

const PROGRAM_OPTIONS = ['Pitching', 'Hitting', 'Pitching/Hitting', 'Strength', 'Meals', 'Rehab', 'Throwing', 'Catching', 'Infield', 'Outfield', 'No Program'];
const FOLDER_OPTIONS = ['No Folder', 'Warmup', 'In-Season', 'Off-Season', 'Recovery', 'Assessment', 'Body Builder', 'Cardio', 'High School', 'Youth', 'Youth Weighted', 'College', 'Pro', 'Submarine', 'Eccentric', 'Football', 'Soccer', 'Basketball', 'Cricket'];
const SUPER_SET_OPTIONS = ['', ...['A','B','C','D','E','F','G'].flatMap(l => [1,2,3,4,5].map(n => `${l}${n}`))];
const LEVEL_OPTIONS =['Independent', 'Affiliate', 'High School', 'Professional', 'College', 'Youth', 'Pro - D', 'Pro - ND', '9U', '10U', '11U', '12U', '13U', '14U', '15U', '16U', '17U', '18U', 'AAA', 'AA', 'A+', 'A', 'MLB', 'Complex', 'NPB', 'KBO', 'MiLB', 'No Level'];
const STATUS_OPTIONS = ['On-Site', 'Remote', 'Active', 'Inactive', 'Archived'];

const LEVEL_COLORS = {
  'Professional': 'bg-teal-600 text-white',
  'High School': 'bg-orange-500 text-white',
  'College': 'bg-amber-500 text-white',
  'Youth': 'bg-yellow-500 text-white',
  'Independent': 'bg-blue-500 text-white',
  'Affiliate': 'bg-indigo-500 text-white',
  'MiLB': 'bg-emerald-500 text-white',
  'MLB': 'bg-red-600 text-white',
};

const STATUS_COLORS = {
  'Active': 'bg-green-500 text-white',
  'Remote': 'bg-orange-500 text-white',
  'Inactive': 'bg-gray-500 text-white',
  'On-Site': 'bg-blue-500 text-white',
  'Archived': 'bg-red-500 text-white',
};

function RosterTab({ userRole, userId, teams, onNavigateToProfile, onRefreshPlayers }) {
  const [rosterPlayers, setRosterPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTeam, setFilterTeam] = useState('All');
  const [filterTrainer, setFilterTrainer] = useState('All');
  const [filterProgram, setFilterProgram] = useState('All');
  const [filterLevel, setFilterLevel] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [filterSubStatus, setFilterSubStatus] = useState('All');
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [teamCoachMap, setTeamCoachMap] = useState({});

  useEffect(() => { fetchRosterPlayers(); fetchTeamCoaches(); }, []);

  const fetchRosterPlayers = async () => {
    setLoading(true);
    // #437: paged past the 1,000-row clamp.
    const { rows: data, error } = await readAllPages(() => supabase
      .from('users')
      .select('id, full_name, phone, avatar_url, player_profiles!player_profiles_user_id_fkey(id, position, jersey_number, grade, bats, throws, program, level, status, sub_status), team_members(team_id, teams(name))')
      .eq('role', 'player')
      .order('full_name')
      .order('id'));

    if (error) { console.error(error); setLoading(false); return; }

    let filtered = data;
    if (userRole === 'coach') {
      const { data: coachTeams } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
      const teamIds = (coachTeams || []).map(t => t.team_id);
      filtered = filtered.filter(p => p.team_members?.some(tm => teamIds.includes(tm.team_id)));
    }
    setRosterPlayers(filtered);
    setLoading(false);
  };

  const fetchTeamCoaches = async () => {
    const { data } = await supabase
      .from('team_members')
      .select('team_id, users(full_name)')
      .eq('role', 'coach');
    const map = {};
    (data || []).forEach(row => {
      const name = row.users?.full_name;
      if (!name) return;
      if (!map[row.team_id]) map[row.team_id] = [];
      if (!map[row.team_id].includes(name)) map[row.team_id].push(name);
    });
    setTeamCoachMap(map);
  };

  const handleInlineUpdate = async (playerId, field, value) => {
    const player = rosterPlayers.find(p => p.id === playerId);
    const profileId = player?.player_profiles?.[0]?.id;
    if (!profileId) return;
    const { error } = await supabase.from('player_profiles').update({ [field]: value }).eq('id', profileId);
    if (error) {
      alert('Update failed: ' + formatUserError(error));
      return;
    }
    setRosterPlayers(prev => prev.map(p =>
      p.id === playerId ? { ...p, player_profiles: [{ ...p.player_profiles[0], [field]: value }] } : p
    ));
  };

  const handleRemoveFromTeam = async (playerId, teamId) => {
    if (!window.confirm('Remove this player from the team?')) return;
    await supabase.from('team_members').delete().eq('user_id', playerId).eq('team_id', teamId);
    fetchRosterPlayers();
  };

  const handleEditSave = async () => {
    const profileId = editingPlayer?.player_profiles?.[0]?.id;
    if (!profileId) return;
    const { error } = await supabase.from('player_profiles').update({
      position: editForm.position || null,
      jersey_number: editForm.jersey_number || null,
      grade: editForm.grade || null,
      bats: editForm.bats || null,
      throws: editForm.throws || null,
    }).eq('id', profileId);
    if (!error) {
      fetchRosterPlayers();
      setEditingPlayer(null);
    }
  };

  const splitName = (fullName) => {
    const parts = (fullName || '').trim().split(/\s+/);
    return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
  };

  const getTrainer = (player) => {
    const teamIds = (player.team_members || []).map(tm => tm.team_id);
    const names = [];
    teamIds.forEach(tid => {
      if (teamCoachMap[tid]) names.push(...teamCoachMap[tid]);
    });
    return [...new Set(names)].join(', ') || '';
  };

  const allTrainerNames = [...new Set(Object.values(teamCoachMap).flat())].sort();
  const allTeamNames = [...new Set(
    rosterPlayers.flatMap(p => (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean))
  )].sort();

  const displayPlayers = rosterPlayers.filter(p => {
    const profile = p.player_profiles?.[0] || {};
    const teamNames = (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean);
    const trainerName = getTrainer(p);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!p.full_name.toLowerCase().includes(q)) return false;
    }
    if (filterTeam !== 'All' && !teamNames.includes(filterTeam)) return false;
    if (filterTrainer !== 'All' && !trainerName.includes(filterTrainer)) return false;
    if (filterProgram !== 'All' && profile.program !== filterProgram) return false;
    if (filterLevel !== 'All' && profile.level !== filterLevel) return false;
    if (filterStatus !== 'All' && profile.status !== filterStatus) return false;
    if (filterSubStatus !== 'All' && (profile.sub_status || '') !== filterSubStatus) return false;
    return true;
  });

  const BadgeSelect = ({ value, options, colors, onChange, placeholder }) => {
    const color = value && colors[value] ? colors[value] : '';
    return (
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className={`px-2 py-1 rounded text-xs font-medium border-0 cursor-pointer appearance-none pr-5 ${color || 'bg-gray-100 text-gray-600'}`}
        style={value && colors[value] ? {
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='white' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 4px center',
        } : {
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%236b7280' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 4px center',
        }}
      >
        <option value="">{placeholder || '—'}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  };

  const filterSelectClass = "w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-gray-700";

  if (loading) return <div className="text-gray-600">Loading roster...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-3">
          <h3 className="text-2xl font-bold text-gray-900">Manage Athletes</h3>
          <span className="bg-orange-500 text-white px-3 py-1 rounded-lg text-sm font-bold">
            {rosterPlayers.length}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            {/* Filter Row */}
            <tr className="bg-gray-50 border-b border-gray-200">
              <th colSpan={2} className="px-3 py-2 text-left">
                <div className="relative">
                  <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search for an Athlete..."
                    className="w-full pl-7 pr-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </th>
              <th className="px-2 py-2">
                <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {allTeamNames.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </th>
              <th className="px-2 py-2">
                <select value={filterTrainer} onChange={(e) => setFilterTrainer(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {allTrainerNames.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </th>
              <th className="px-2 py-2">
                <select value={filterProgram} onChange={(e) => setFilterProgram(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {PROGRAM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </th>
              <th className="px-2 py-2">
                <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {LEVEL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </th>
              <th className="px-2 py-2">
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </th>
              <th className="px-2 py-2">
                <select value={filterSubStatus} onChange={(e) => setFilterSubStatus(e.target.value)} className={filterSelectClass}>
                  <option value="All">All</option>
                  {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </th>
              <th className="px-2 py-2"></th>
            </tr>
            {/* Column Headers */}
            <tr className="border-b border-gray-200 bg-white">
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">First Name</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Last Name</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Team</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Trainer</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Program</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Level</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Status</th>
              <th className="text-left py-3 px-3 font-semibold text-gray-500 text-xs uppercase tracking-wider">Sub Status</th>
              <th className="py-3 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {displayPlayers.map(player => {
              const profile = player.player_profiles?.[0] || {};
              const { firstName, lastName } = splitName(player.full_name);
              const teamNames = (player.team_members || []).map(tm => tm.teams?.name).filter(Boolean);
              const trainerName = getTrainer(player);

              return (
                <tr key={player.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-3">
                    <button
                      onClick={() => onNavigateToProfile && onNavigateToProfile(player.id)}
                      className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {firstName}
                    </button>
                  </td>
                  <td className="py-3 px-3 font-semibold text-gray-900">{lastName}</td>
                  <td className="py-3 px-3 text-gray-600 text-xs">{teamNames.join(', ') || '—'}</td>
                  <td className="py-3 px-3 text-gray-600 text-xs">{trainerName || '—'}</td>
                  <td className="py-3 px-3">
                    <select
                      value={profile.program || ''}
                      onChange={(e) => handleInlineUpdate(player.id, 'program', e.target.value)}
                      className="px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                    >
                      <option value="">—</option>
                      {PROGRAM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="py-3 px-3">
                    <BadgeSelect
                      value={profile.level}
                      options={LEVEL_OPTIONS}
                      colors={LEVEL_COLORS}
                      onChange={(val) => handleInlineUpdate(player.id, 'level', val)}
                    />
                  </td>
                  <td className="py-3 px-3">
                    <BadgeSelect
                      value={profile.status}
                      options={STATUS_OPTIONS}
                      colors={STATUS_COLORS}
                      onChange={(val) => handleInlineUpdate(player.id, 'status', val)}
                    />
                  </td>
                  <td className="py-3 px-3">
                    <BadgeSelect
                      value={profile.sub_status}
                      options={STATUS_OPTIONS}
                      colors={STATUS_COLORS}
                      onChange={(val) => handleInlineUpdate(player.id, 'sub_status', val)}
                    />
                  </td>
                  <td className="py-3 px-2">
                    <button
                      onClick={() => {
                        setEditingPlayer(player);
                        setEditForm({
                          position: profile.position || '',
                          jersey_number: profile.jersey_number || '',
                          grade: profile.grade || '',
                          bats: profile.bats || '',
                          throws: profile.throws || '',
                        });
                      }}
                      className="text-gray-500 hover:text-blue-600 transition"
                      title="Edit info"
                    >
                      <Edit2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {displayPlayers.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <Users size={40} className="mx-auto mb-3 text-gray-300" />
            <p>No athletes found matching your filters.</p>
          </div>
        )}
      </div>

      {/* Edit Player Info Modal */}
      {editingPlayer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          {/* #350: capped with a scrolling body so Cancel/Save stay on screen
              on a short window. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg font-bold text-gray-900">Edit Player Info</h3>
              <button onClick={() => setEditingPlayer(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Position</label>
                <input type="text" value={editForm.position} onChange={(e) => setEditForm({...editForm, position: e.target.value})} placeholder="e.g., SS, RHP" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Jersey Number</label>
                <input type="text" value={editForm.jersey_number} onChange={(e) => setEditForm({...editForm, jersey_number: e.target.value})} placeholder="e.g., 7" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Grade</label>
                <input type="text" value={editForm.grade} onChange={(e) => setEditForm({...editForm, grade: e.target.value})} placeholder="e.g., Senior, 2026" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bats</label>
                  <select value={editForm.bats} onChange={(e) => setEditForm({...editForm, bats: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">—</option><option value="Right">R</option><option value="Left">L</option><option value="Switch">S</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Throws</label>
                  <select value={editForm.throws} onChange={(e) => setEditForm({...editForm, throws: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">—</option><option value="Right">R</option><option value="Left">L</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
              <button onClick={() => setEditingPlayer(null)} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg text-sm hover:bg-gray-50 transition">Cancel</button>
              <button onClick={handleEditSave} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 transition">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================
   TRAINING PROGRAMS TAB
   ============================================ */

/* #321 — the expanded workout-template exercise list, readable at 375px.
 *
 * 9cd7b47 wrapped this 7-column table in `overflow-x-auto`, which only means
 * the columns are still crushed and Rest/Load now sit off-screen to the right
 * where nobody discovers them. Below sm we render the same rows as stacked
 * cards with a label on every number instead; the table is untouched at sm+.
 * Presentation only — same `exercises` array, same fields.
 */
function WorkoutExerciseList({ exercises }) {
  const metric = (label, value) => (
    <span key={label} className="inline-flex items-baseline gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <span className={`font-semibold tabular-nums ${value ? 'text-gray-900' : 'text-gray-400'}`}>{value || '—'}</span>
    </span>
  );
  return (
    <>
      {/* Portrait phone: stacked cards */}
      <div className="sm:hidden space-y-2">
        {exercises.map((ex, i) => (
          <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white">
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold text-gray-900 break-words min-w-0 flex-1">{ex.name}</div>
              {ex.link && (
                <a href={ex.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-50 text-blue-600 text-xs font-medium hover:bg-blue-100 flex-shrink-0">
                  <Link size={12} />Link
                </a>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {metric('Sets', ex.sets)}
              {metric('Reps', ex.reps)}
              {metric('Rest', ex.rest)}
              {metric('Load', ex.load)}
            </div>
            {(ex.superSet || ex.super_set) && (
              <div className="mt-1.5 text-xs text-gray-500">
                Super set <span className="font-semibold text-gray-900">{ex.superSet || ex.super_set}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tablet/desktop: original table, unchanged */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-max">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="pb-2">Exercise</th><th className="pb-2">Sets</th><th className="pb-2">Reps</th><th className="pb-2">Rest</th><th className="pb-2">Load</th><th className="pb-2">Link</th><th className="pb-2">Super Set</th>
            </tr>
          </thead>
          <tbody>
            {exercises.map((ex, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-2 text-gray-900">{ex.name}</td>
                <td className="py-2 text-gray-600">{ex.sets || '—'}</td>
                <td className="py-2 text-gray-600">{ex.reps || '—'}</td>
                <td className="py-2 text-gray-600">{ex.rest || '—'}</td>
                <td className="py-2 text-gray-600">{ex.load || '—'}</td>
                <td className="py-2">{ex.link ? <a href={ex.link} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700"><Link size={14} /></a> : '—'}</td>
                <td className="py-2 text-gray-600">{ex.superSet || ex.super_set || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function TrainingTab({ teams, players }) {
  const [trainingSubTab, setTrainingSubTab] = useState('programs');
  const [programs, setPrograms] = useState([]);
  const [workoutTemplates, setWorkoutTemplates] = useState([]);
  const [showCreateProgram, setShowCreateProgram] = useState(false);
  const [showCreateWorkout, setShowCreateWorkout] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [selectedProgram, setSelectedProgram] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedWorkout, setExpandedWorkout] = useState(null);
  const [editingWorkout, setEditingWorkout] = useState(null);
  const [editingProgram, setEditingProgram] = useState(null);
  const [workoutViewMode, setWorkoutViewMode] = useState('list');
  const [expandedPrograms, setExpandedPrograms] = useState(new Set());
  const [workoutSearch, setWorkoutSearch] = useState('');
  const [programSearch, setProgramSearch] = useState('');

  useEffect(() => { fetchPrograms(); fetchWorkoutTemplates(); }, []);

  const fetchPrograms = async () => {
    const { data, error } = await supabase
      .from('training_programs')
      .select(`
        *,
        training_days(
          id, day_number, title, notes,
          training_exercises(id, category, name, description, sets, reps, weight, video_url, image_url, sort_order, rest, load, super_set)
        ),
        training_program_assignments(
          id, player_id, team_id, start_date, end_date,
          users:player_id(full_name),
          teams:team_id(name)
        )
      `)
      .order('created_at', { ascending: false });
    if (!error) setPrograms(data);
    setLoading(false);
  };

  const fetchWorkoutTemplates = async () => {
    const { data, error } = await supabase
      .from('workout_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error) setWorkoutTemplates(data || []);
  };

  const handleDeleteProgram = async (programId) => {
    if (!window.confirm('Delete this training program and all its days/exercises?')) return;
    const { error } = await supabase.from('training_programs').delete().eq('id', programId);
    if (!error) fetchPrograms();
  };

  const handleDeleteWorkout = async (workoutId) => {
    if (!window.confirm('Delete this workout template?')) return;
    const { error } = await supabase.from('workout_templates').delete().eq('id', workoutId);
    if (!error) fetchWorkoutTemplates();
  };

  if (loading) return <div className="text-gray-600">Loading training programs...</div>;

  return (
    <div className="space-y-4">
      <div className="flex space-x-2">
        <button onClick={() => setTrainingSubTab('workouts')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${trainingSubTab === 'workouts' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Individual Workouts ({workoutTemplates.length})</button>
        <button onClick={() => setTrainingSubTab('programs')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${trainingSubTab === 'programs' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Training Programs ({programs.length})</button>
      </div>

      {trainingSubTab === 'workouts' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-3">
              <h3 className="text-lg font-semibold text-gray-900">Individual Workouts</h3>
              <div className="flex bg-gray-100 rounded-full p-0.5">
                <button onClick={() => setWorkoutViewMode('list')} className={`px-3 py-1 rounded-full text-xs font-medium transition ${workoutViewMode === 'list' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:text-gray-900'}`}>List</button>
                <button onClick={() => setWorkoutViewMode('byProgram')} className={`px-3 py-1 rounded-full text-xs font-medium transition ${workoutViewMode === 'byProgram' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:text-gray-900'}`}>By Program</button>
              </div>
            </div>
            <button onClick={() => setShowCreateWorkout(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
              <Plus size={18} /><span>Create Workout</span>
            </button>
          </div>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={workoutSearch}
              onChange={(e) => setWorkoutSearch(e.target.value)}
              placeholder="Search workouts..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {workoutTemplates.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Dumbbell size={40} className="mx-auto mb-3 text-gray-300" />
              <p>No workout templates yet. Create your first workout to get started!</p>
            </div>
          ) : workoutViewMode === 'list' ? (
            <div className="space-y-3">
              {workoutTemplates.filter(wt => !workoutSearch || wt.name?.toLowerCase().includes(workoutSearch.toLowerCase()) || wt.program?.toLowerCase().includes(workoutSearch.toLowerCase()) || wt.folder?.toLowerCase().includes(workoutSearch.toLowerCase())).map(wt => {
                const exercises = wt.exercises || [];
                return (
                  <div key={wt.id} className="bg-gray-50 rounded-lg p-4">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center space-x-3">
                          <span className="font-semibold text-gray-900">{wt.name}</span>
                          {wt.program && wt.program !== 'No Program' && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">{wt.program}</span>
                          )}
                          {wt.folder && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">{wt.folder}</span>}
                        </div>
                        <p className="text-sm text-gray-500 mt-1">{exercises.length} exercise{exercises.length !== 1 ? 's' : ''}</p>
                        {wt.notes && <p className="text-xs text-gray-400 mt-1">{wt.notes}</p>}
                      </div>
                      <div className="flex items-center space-x-2 ml-4">
                        <button onClick={() => setEditingWorkout(wt)} className="text-gray-400 hover:text-blue-600 transition" title="Edit"><Edit2 size={16} /></button>
                        <button onClick={() => setExpandedWorkout(expandedWorkout === wt.id ? null : wt.id)} className="text-gray-400 hover:text-gray-600 transition">
                          {expandedWorkout === wt.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                        </button>
                        <button onClick={() => handleDeleteWorkout(wt.id)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={16} /></button>
                      </div>
                    </div>
                    {expandedWorkout === wt.id && exercises.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <WorkoutExerciseList exercises={exercises} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {Object.entries(
                workoutTemplates.filter(wt => !workoutSearch || wt.name?.toLowerCase().includes(workoutSearch.toLowerCase()) || wt.program?.toLowerCase().includes(workoutSearch.toLowerCase()) || wt.folder?.toLowerCase().includes(workoutSearch.toLowerCase())).reduce((groups, wt) => {
                  const program = (!wt.program || wt.program === 'No Program') ? 'Uncategorized' : wt.program;
                  if (!groups[program]) groups[program] = [];
                  groups[program].push(wt);
                  return groups;
                }, {})
              )
                .sort(([a], [b]) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b))
                .map(([program, workouts]) => {
                  const sorted = [...workouts].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                  const isExpanded = expandedPrograms.has(program);
                  return (
                    <div key={program} className="border border-gray-200 rounded-lg overflow-hidden">
                      <button
                        onClick={() => setExpandedPrograms(prev => {
                          const next = new Set(prev);
                          if (next.has(program)) next.delete(program); else next.add(program);
                          return next;
                        })}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition"
                      >
                        <div className="flex items-center space-x-2">
                          {isExpanded ? <ChevronDown size={18} className="text-gray-500" /> : <ChevronRight size={18} className="text-gray-500" />}
                          <span className="font-semibold text-gray-900">{program}</span>
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">{sorted.length}</span>
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-gray-200 bg-gray-50/50 p-3 space-y-3">
                          {sorted.map(wt => {
                            const exercises = wt.exercises || [];
                            return (
                              <div key={wt.id} className="bg-gray-50 rounded-lg p-4">
                                <div className="flex justify-between items-start">
                                  <div className="flex-1">
                                    <div className="flex items-center space-x-3">
                                      <span className="font-semibold text-gray-900">{wt.name}</span>
                                      {wt.folder && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">{wt.folder}</span>}
                                    </div>
                                    <p className="text-sm text-gray-500 mt-1">{exercises.length} exercise{exercises.length !== 1 ? 's' : ''}</p>
                                    {wt.notes && <p className="text-xs text-gray-400 mt-1">{wt.notes}</p>}
                                  </div>
                                  <div className="flex items-center space-x-2 ml-4">
                                    <button onClick={() => setEditingWorkout(wt)} className="text-gray-400 hover:text-blue-600 transition" title="Edit"><Edit2 size={16} /></button>
                                    <button onClick={() => setExpandedWorkout(expandedWorkout === wt.id ? null : wt.id)} className="text-gray-400 hover:text-gray-600 transition">
                                      {expandedWorkout === wt.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                                    </button>
                                    <button onClick={() => handleDeleteWorkout(wt.id)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={16} /></button>
                                  </div>
                                </div>
                                {expandedWorkout === wt.id && exercises.length > 0 && (
                                  <div className="mt-3 pt-3 border-t border-gray-200">
                                    <WorkoutExerciseList exercises={exercises} />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}

          {(showCreateWorkout || editingWorkout) && (
            <CreateWorkoutTemplateModal
              onClose={() => { setShowCreateWorkout(false); setEditingWorkout(null); }}
              onSuccess={() => { setShowCreateWorkout(false); setEditingWorkout(null); fetchWorkoutTemplates(); }}
              editingWorkout={editingWorkout}
            />
          )}
        </div>
      )}

      {trainingSubTab === 'programs' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Training Programs</h3>
            <button onClick={() => setShowCreateProgram(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
              <Plus size={18} /><span>Create Program</span>
            </button>
          </div>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={programSearch}
              onChange={(e) => setProgramSearch(e.target.value)}
              placeholder="Search programs..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {programs.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Dumbbell size={40} className="mx-auto mb-3 text-gray-300" />
              <p>No training programs yet. Create your first program to get started!</p>
            </div>
          ) : (
            <div className="space-y-4">
              {programs.filter(p => !programSearch || p.name?.toLowerCase().includes(programSearch.toLowerCase()) || p.description?.toLowerCase().includes(programSearch.toLowerCase())).map(program => (
                <TrainingProgramCard
                  key={program.id}
                  program={program}
                  onDelete={handleDeleteProgram}
                  onAssign={() => { setSelectedProgram(program); setShowAssign(true); }}
                  onEdit={() => setEditingProgram(program)}
                  onRefresh={fetchPrograms}
                />
              ))}
            </div>
          )}

          {(showCreateProgram || editingProgram) && (
            <CreateTrainingProgramModal
              onClose={() => { setShowCreateProgram(false); setEditingProgram(null); }}
              onSuccess={() => { setShowCreateProgram(false); setEditingProgram(null); fetchPrograms(); }}
              editingProgram={editingProgram}
            />
          )}

          {showAssign && selectedProgram && (
            <AssignTrainingProgramModal
              program={selectedProgram}
              teams={teams}
              players={players}
              onClose={() => { setShowAssign(false); setSelectedProgram(null); }}
              onSuccess={() => { setShowAssign(false); setSelectedProgram(null); fetchPrograms(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ---- TRAINING PROGRAM CARD ---- */

// Aligned with ProgramLibrarySidebar FOLDER_COLORS and Schedule CATEGORY_BAR (#179).
const categoryColors = {
  hitting: 'bg-teal-500 text-white',
  pitching: 'bg-green-500 text-white',
  fielding: 'bg-green-500 text-white',
  conditioning: 'bg-yellow-500 text-white',
  recovery: 'bg-purple-500 text-white',
  other: 'bg-gray-500 text-white',
};

/* QA 2026-08-15: the expanded card rendered exercises by looping over this list
 * of categories and skipping anything else, so an exercise whose category was
 * NULL, differently cased, or any value outside the list vanished from the card
 * while still being counted in the "N exercises" header — the coach saw
 * "4 exercises" and three rows. Categories are now normalised (blank or missing
 * reads as "other", the bucket that already exists for exactly this), and a
 * category this list doesn't know about is rendered after the known ones rather
 * than dropped. */
const KNOWN_EXERCISE_CATEGORIES = ['hitting', 'pitching', 'fielding', 'conditioning', 'recovery', 'other'];

function exerciseCategory(exercise) {
  return String(exercise?.category || '').trim().toLowerCase() || 'other';
}

function TrainingProgramCard({ program, onDelete, onAssign, onEdit, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [showAddDay, setShowAddDay] = useState(false);
  const [showAddExercise, setShowAddExercise] = useState(null); // day_id

  const days = (program.training_days || []).sort((a, b) => a.day_number - b.day_number);
  const assignments = program.training_program_assignments || [];
  const totalExercises = days.reduce((sum, day) => sum + (day.training_exercises?.length || 0), 0);

  // Get unique categories across all exercises (normalised, so a NULL category
  // shows as "other" instead of an unstyled empty chip).
  const allCategories = [...new Set(days.flatMap(d => (d.training_exercises || []).map(exerciseCategory)))];

  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="flex items-center space-x-3">
            <span className="font-semibold text-gray-900 text-lg">{program.name}</span>
            {program.duration_weeks && <span className="text-xs text-gray-500">{program.duration_weeks} weeks</span>}
          </div>
          {program.description && <p className="text-sm text-gray-600 mt-1">{program.description}</p>}
          {/* QA 2026-08-15: both rows now wrap. The category pills ran off the
              right edge on a phone, and adding the "other" bucket made it one
              pill worse. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm">
            <span className="text-gray-500">{days.length} days &bull; {totalExercises} exercises</span>
            <div className="flex flex-wrap gap-1">
              {allCategories.map(cat => (
                <span key={cat} className={`px-2 py-0.5 rounded-full text-xs font-medium ${categoryColors[cat] || categoryColors.other}`}>{cat}</span>
              ))}
            </div>
          </div>
          {assignments.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {assignments.map(a => (
                <span key={a.id} className="inline-flex items-center px-2 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
                  {a.teams ? <><Users size={12} className="mr-1" />{a.teams.name}</> : a.users ? <><User size={12} className="mr-1" />{a.users.full_name}</> : null}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center space-x-2 ml-4">
          <button onClick={onAssign} className="text-blue-600 hover:text-blue-800 text-sm font-medium transition">Assign</button>
          <button onClick={onEdit} className="text-gray-400 hover:text-blue-600 transition" title="Edit"><Edit2 size={16} /></button>
          <button onClick={() => setExpanded(!expanded)} className="text-gray-400 hover:text-gray-600 transition">{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
          <button onClick={() => onDelete(program.id)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={16} /></button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-200 space-y-4">
          {days.map(day => {
            const exercises = (day.training_exercises || []).sort((a, b) => a.sort_order - b.sort_order);
            // Group exercises by (normalised) category. Known categories keep
            // their usual order; anything unexpected renders after them so it
            // can never be dropped — see KNOWN_EXERCISE_CATEGORIES above.
            const grouped = {};
            exercises.forEach(ex => {
              const cat = exerciseCategory(ex);
              if (!grouped[cat]) grouped[cat] = [];
              grouped[cat].push(ex);
            });
            const dayCategories = [
              ...KNOWN_EXERCISE_CATEGORIES.filter(cat => grouped[cat]),
              ...Object.keys(grouped).filter(cat => !KNOWN_EXERCISE_CATEGORIES.includes(cat)).sort(),
            ];

            return (
              <div key={day.id} className="bg-white rounded-lg p-4 border border-gray-200">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <h5 className="font-semibold text-gray-900">Day {day.day_number}{day.title ? `: ${day.title}` : ''}</h5>
                    {day.notes && <p className="text-xs text-gray-500 mt-0.5">{day.notes}</p>}
                  </div>
                  <button onClick={() => setShowAddExercise(day.id)} className="text-blue-600 hover:text-blue-800 text-sm font-medium flex items-center space-x-1">
                    <Plus size={14} /><span>Add Exercise</span>
                  </button>
                </div>

                {exercises.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No exercises yet</p>
                ) : (
                  <div className="space-y-3">
                    {dayCategories.map(cat => {
                      return (
                        <div key={cat}>
                          <h6 className="text-xs font-semibold uppercase tracking-wide mb-1.5">
                            <span className={`px-2 py-0.5 rounded-full ${categoryColors[cat] || categoryColors.other}`}>{cat}</span>
                          </h6>
                          <div className="space-y-2">
                            {grouped[cat].map(ex => (
                              <ExerciseRow key={ex.id} exercise={ex} onRefresh={onRefresh} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {showAddExercise === day.id && (
                  <AddExerciseModal
                    dayId={day.id}
                    currentCount={exercises.length}
                    onClose={() => setShowAddExercise(null)}
                    onSuccess={() => { setShowAddExercise(null); onRefresh(); }}
                  />
                )}
              </div>
            );
          })}

          <button onClick={() => setShowAddDay(true)} className="w-full border-2 border-dashed border-gray-300 rounded-lg py-3 text-gray-500 hover:text-blue-600 hover:border-blue-300 transition flex items-center justify-center space-x-2">
            <Plus size={18} /><span>Add Day {days.length + 1}</span>
          </button>

          {showAddDay && (
            <AddDayModal
              programId={program.id}
              nextDayNumber={days.length + 1}
              onClose={() => setShowAddDay(false)}
              onSuccess={() => { setShowAddDay(false); onRefresh(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ---- EXERCISE ROW ---- */

/* #321 — Sets / Reps / Rest / Load, readable on a 375px phone.
 *
 * Same helper as the ones in Profile.js and Schedule.js (kept local, this repo
 * has no shared component module). Labelled chips that WRAP instead of
 * truncating, and always an em-dash for a value that was never programmed, so
 * a blank is never mistaken for a layout bug. Presentation only.
 *
 * QA 2026-08-15: added here because the #321 pass missed this screen — see the
 * comment in ExerciseRow below.
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

function ExerciseRow({ exercise, onRefresh }) {
  const handleDelete = async () => {
    if (!window.confirm(`Delete "${exercise.name}"?`)) return;
    await supabase.from('training_exercises').delete().eq('id', exercise.id);
    onRefresh();
  };

  return (
    <div className="flex items-start justify-between py-2 px-3 bg-gray-50 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center space-x-2">
          <span className="font-medium text-gray-900 text-sm">{exercise.name}</span>
          {exercise.video_url && (
            <a href={exercise.video_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="Watch demo">
              <Play size={14} />
            </a>
          )}
          {exercise.image_url && (
            <a href={exercise.image_url} target="_blank" rel="noopener noreferrer" className="text-green-500 hover:text-green-700" title="View image">
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        {exercise.description && <p className="text-xs text-gray-500 mt-0.5">{exercise.description}</p>}
        {/* QA 2026-08-15: the #321 pass never reached this screen. The "not set"
            placeholder was guarded on EVERY field being empty, so an exercise
            with sets 3 / reps 10 and no rest or load rendered byte-for-byte as
            it did before the fix, with nothing to say those two were never
            programmed. The labelling disagreed with the rest of the app too
            ("4 sets" but "Rest: 2:00"). Now the same ExerciseMetrics chips used
            on every other surface, which print an em-dash per unset field.
            `weight` is the legacy column for `load` — same field to a coach. */}
        <ExerciseMetrics
          className="mt-1"
          sets={exercise.sets}
          reps={exercise.reps}
          load={exercise.load || exercise.weight}
          rest={exercise.rest}
        />
      </div>
      <button onClick={handleDelete} className="text-gray-400 hover:text-red-600 transition ml-2"><Trash2 size={14} /></button>
    </div>
  );
}

/* ---- CREATE TRAINING PROGRAM MODAL ---- */

function CreateTrainingProgramModal({ onClose, onSuccess, editingProgram }) {
  useModalTracking('CreateTrainingProgramModal');
  const [name, setName] = useState(editingProgram?.name || '');
  const [notes, setNotes] = useState(editingProgram?.description || '');
  const [tabs, setTabs] = useState(() => {
    if (editingProgram?.training_days?.length > 0) {
      const days = [...editingProgram.training_days].sort((a, b) => a.day_number - b.day_number);
      return days.map(day => ({
        tabName: day.title || `Day ${day.day_number}`,
        dayId: day.id,
        notes: day.notes || '',
        exercises: (day.training_exercises || [])
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(ex => ({ name: ex.name || '', sets: ex.sets ? String(ex.sets) : '', reps: ex.reps || '', rest: ex.rest || '', load: ex.load || '', link: ex.video_url || '', category: ex.category || 'hitting', superSet: ex.super_set || '' }))
          .concat([]).length > 0
          ? (day.training_exercises || []).sort((a, b) => a.sort_order - b.sort_order).map(ex => ({ name: ex.name || '', sets: ex.sets ? String(ex.sets) : '', reps: ex.reps || '', rest: ex.rest || '', load: ex.load || '', link: ex.video_url || '', category: ex.category || 'hitting', superSet: ex.super_set || '' }))
          : [{ name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }]
      }));
    }
    return [{ tabName: 'Day 1', exercises: [{ name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }] }];
  });
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const activeTab = tabs[activeTabIndex] || tabs[0];
  const { videos: exerciseVideos, loading: exerciseVideosLoading } = useExerciseVideos();

  const addTab = () => {
    const newTabs = [...tabs, { tabName: `Day ${tabs.length + 1}`, exercises: [{ name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }] }];
    setTabs(newTabs);
    setActiveTabIndex(newTabs.length - 1);
  };

  const cloneTab = () => {
    const cloned = JSON.parse(JSON.stringify(activeTab));
    cloned.tabName = `${activeTab.tabName} (Copy)`;
    delete cloned.dayId;
    const newTabs = [...tabs, cloned];
    setTabs(newTabs);
    setActiveTabIndex(newTabs.length - 1);
  };

  const deleteTab = () => {
    if (tabs.length <= 1) return;
    const newTabs = tabs.filter((_, i) => i !== activeTabIndex);
    setTabs(newTabs);
    setActiveTabIndex(Math.min(activeTabIndex, newTabs.length - 1));
  };

  const updateExercise = (exIndex, field, value) => {
    const newTabs = [...tabs];
    newTabs[activeTabIndex] = {
      ...newTabs[activeTabIndex],
      exercises: newTabs[activeTabIndex].exercises.map((ex, i) =>
        i === exIndex ? { ...ex, [field]: value } : ex
      )
    };
    setTabs(newTabs);
  };

  // Applies more than one field at once in a single setTabs call. Needed for
  // picking a video suggestion (name + link together) - two separate
  // updateExercise calls in the same handler would both read the same stale
  // `tabs` closure and the second call would silently clobber the first.
  const updateExerciseFields = (exIndex, patch) => {
    const newTabs = [...tabs];
    newTabs[activeTabIndex] = {
      ...newTabs[activeTabIndex],
      exercises: newTabs[activeTabIndex].exercises.map((ex, i) =>
        i === exIndex ? { ...ex, ...patch } : ex
      )
    };
    setTabs(newTabs);
  };

  const addExercise = () => {
    const newTabs = [...tabs];
    newTabs[activeTabIndex] = {
      ...newTabs[activeTabIndex],
      exercises: [...newTabs[activeTabIndex].exercises, { name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }]
    };
    setTabs(newTabs);
  };

  const removeExercise = (exIndex) => {
    const newTabs = [...tabs];
    const exercises = newTabs[activeTabIndex].exercises;
    if (exercises.length <= 1) return;
    newTabs[activeTabIndex] = {
      ...newTabs[activeTabIndex],
      exercises: exercises.filter((_, i) => i !== exIndex)
    };
    setTabs(newTabs);
  };

  const handleSave = async () => {
    trackAction('save_training_program');
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    const { data: { user } } = await supabase.auth.getUser();

    if (editingProgram) {
      // Update existing program
      const { error: updateErr } = await supabase.from('training_programs')
        .update({ name, description: notes || null })
        .eq('id', editingProgram.id);
      if (updateErr) { setError(updateErr.message); setLoading(false); return; }

      // Delete old days (cascades to exercises)
      await supabase.from('training_days').delete().eq('program_id', editingProgram.id);

      // Insert new days and exercises
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const { data: dayData, error: dayErr } = await supabase.from('training_days').insert({
          program_id: editingProgram.id, day_number: i + 1, title: tab.tabName || null, notes: tab.notes || null
        }).select('id').single();
        if (dayErr) { setError(dayErr.message); setLoading(false); return; }

        const rawExercises = tab.exercises.filter(ex => ex.name.trim());
        const withSS = rawExercises.filter(ex => ex.superSet);
        const withoutSS = rawExercises.filter(ex => !ex.superSet);
        withSS.sort((a, b) => a.superSet.localeCompare(b.superSet));
        const exercises = [...withSS, ...withoutSS];
        if (exercises.length > 0) {
          const { error: exErr } = await supabase.from('training_exercises').insert(
            exercises.map((ex, j) => ({
              day_id: dayData.id, category: ex.category || 'hitting', name: ex.name,
              sets: ex.sets ? parseInt(ex.sets) : null, reps: ex.reps || null, rest: ex.rest || null, load: ex.load || null,
              video_url: ex.link || null, sort_order: j, super_set: ex.superSet || null
            }))
          );
          if (exErr) { setError(exErr.message); setLoading(false); return; }
        }
      }
      onSuccess();
    } else {
      // Create new program
      const { data: progData, error: progErr } = await supabase.from('training_programs').insert({
        name, description: notes || null, created_by: user?.id
      }).select('id').single();
      if (progErr) { setError(progErr.message); setLoading(false); return; }

      // Insert days and exercises
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const { data: dayData, error: dayErr } = await supabase.from('training_days').insert({
          program_id: progData.id, day_number: i + 1, title: tab.tabName || null, notes: tab.notes || null
        }).select('id').single();
        if (dayErr) { setError(dayErr.message); setLoading(false); return; }

        const rawExercises = tab.exercises.filter(ex => ex.name.trim());
        const withSS = rawExercises.filter(ex => ex.superSet);
        const withoutSS = rawExercises.filter(ex => !ex.superSet);
        withSS.sort((a, b) => a.superSet.localeCompare(b.superSet));
        const exercises = [...withSS, ...withoutSS];
        if (exercises.length > 0) {
          const { error: exErr } = await supabase.from('training_exercises').insert(
            exercises.map((ex, j) => ({
              day_id: dayData.id, category: ex.category || 'hitting', name: ex.name,
              sets: ex.sets ? parseInt(ex.sets) : null, reps: ex.reps || null, rest: ex.rest || null, load: ex.load || null,
              video_url: ex.link || null, sort_order: j, super_set: ex.superSet || null
            }))
          );
          if (exErr) { setError(exErr.message); setLoading(false); return; }
        }
      }
      onSuccess();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="text-center py-5 border-b border-gray-200">
          <h3 className="text-2xl font-bold text-gray-900">Workout</h3>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}

          {/* Tab Controls */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex space-x-2">
              <button type="button" onClick={addTab} className="px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 transition">Add tab</button>
              <button type="button" onClick={cloneTab} className="px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 transition">Clone tab</button>
            </div>
            <button type="button" onClick={deleteTab} disabled={tabs.length <= 1} className="px-4 py-1.5 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-50 transition disabled:opacity-40 disabled:cursor-not-allowed">Delete tab</button>
          </div>

          {/* Tab Selector */}
          {tabs.length > 1 && (
            <div className="flex space-x-1 mb-4 border-b border-gray-200 overflow-x-auto">
              {tabs.map((tab, i) => (
                <button key={i} type="button" onClick={() => setActiveTabIndex(i)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition whitespace-nowrap ${i === activeTabIndex ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {tab.tabName}
                </button>
              ))}
            </div>
          )}

          {/* Form Fields */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 space-y-4">
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Workout Name</label>
              <input type="text" placeholder="Workout Name" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Workout Notes</label>
              <input type="text" placeholder="Workout Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
            </div>

            {/* Exercises — #321: 4c36043f fixed the byte-identical table in the
                sibling CreateWorkoutTemplateModal and flagged this one as having the
                same bug. It does: a bare 9-column table with no breakpoint handling,
                so on a 375px phone every Sets/Reps/Rest/Load input is compressed to a
                sliver showing one character. Same fix — labelled stacked cards below
                sm, the original table untouched at sm+. */}
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-2">Exercises</label>

              {/* Portrait phone: stacked cards */}
              <div className="sm:hidden space-y-3">
                {activeTab.exercises.map((ex, i) => (
                  <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-500 pt-2">#{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <ExerciseNameInput
                          value={ex.name}
                          onChange={(name) => updateExercise(i, 'name', name)}
                          onPick={({ name, video_url }) => updateExerciseFields(i, ex.link ? { name } : { name, link: video_url })}
                          hasLink={!!ex.link}
                          videos={exerciseVideos}
                          loading={exerciseVideosLoading}
                        />
                      </div>
                      <button type="button" onClick={() => removeExercise(i)} className="text-gray-400 hover:text-red-600 transition flex-shrink-0 pt-2"><Trash2 size={14} /></button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[['Sets', 'sets', '1'], ['Reps', 'reps', 'Reps'], ['Rest', 'rest', 'Rest'], ['Load', 'load', 'Load']].map(([label, field, ph]) => (
                        <div key={field}>
                          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5">{label}</label>
                          <input type="text" placeholder={ph} value={ex[field] || ''} onChange={(e) => updateExercise(i, field, e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5">Link</label>
                      <div className="flex space-x-1">
                        <input type="text" placeholder="Link" value={ex.link} onChange={(e) => updateExercise(i, 'link', e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                        <select value={ex.category || 'hitting'} onChange={(e) => updateExercise(i, 'category', e.target.value)} className="px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white flex-shrink-0">
                          <option value="hitting">Hitting</option>
                          <option value="pitching">Pitching</option>
                          <option value="fielding">Fielding</option>
                          <option value="conditioning">Conditioning</option>
                          <option value="recovery">Recovery</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-0.5">Super Set</label>
                      <select value={ex.superSet || ''} onChange={(e) => updateExercise(i, 'superSet', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
                        {SUPER_SET_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt || '—'}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={addExercise} className="w-full flex items-center justify-center gap-1.5 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:text-green-600 hover:border-green-400 transition">
                  <Plus size={16} /> Add exercise
                </button>
              </div>

              {/* Tablet/desktop: original table, unchanged */}
              <table className="hidden sm:table w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-700 border-b border-gray-300">
                    <th className="pb-2 w-8"></th>
                    <th className="pb-2 pr-2">Name</th>
                    <th className="pb-2 pr-2 w-16 text-center">Sets</th>
                    <th className="pb-2 pr-2 w-20 text-center">Reps</th>
                    <th className="pb-2 pr-2 w-16 text-center">Rest</th>
                    <th className="pb-2 pr-2 w-16 text-center">Load</th>
                    <th className="pb-2 pr-2 text-center">Link</th>
                    <th className="pb-2 pr-2 w-20 text-center">Super Set</th>
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeTab.exercises.map((ex, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="py-2">
                        <button type="button" onClick={addExercise} className="text-gray-400 hover:text-green-600 transition"><Plus size={16} /></button>
                      </td>
                      <td className="py-2 pr-2">
                        <ExerciseNameInput
                          value={ex.name}
                          onChange={(name) => updateExercise(i, 'name', name)}
                          onPick={({ name, video_url }) => updateExerciseFields(i, ex.link ? { name } : { name, link: video_url })}
                          hasLink={!!ex.link}
                          videos={exerciseVideos}
                          loading={exerciseVideosLoading}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="1" value={ex.sets} onChange={(e) => updateExercise(i, 'sets', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Reps" value={ex.reps} onChange={(e) => updateExercise(i, 'reps', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Rest" value={ex.rest || ''} onChange={(e) => updateExercise(i, 'rest', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Load" value={ex.load || ''} onChange={(e) => updateExercise(i, 'load', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex space-x-1">
                          <input type="text" placeholder="Link" value={ex.link} onChange={(e) => updateExercise(i, 'link', e.target.value)} className="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                          <select value={ex.category || 'hitting'} onChange={(e) => updateExercise(i, 'category', e.target.value)} className="px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
                            <option value="hitting">Hitting</option>
                            <option value="pitching">Pitching</option>
                            <option value="fielding">Fielding</option>
                            <option value="conditioning">Conditioning</option>
                            <option value="recovery">Recovery</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <select value={ex.superSet || ''} onChange={(e) => updateExercise(i, 'superSet', e.target.value)} className="w-full px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center">
                          {SUPER_SET_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt || '—'}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2">
                        <button type="button" onClick={() => removeExercise(i)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer Buttons */}
        <div className="border-t border-gray-200 px-6 py-4 flex justify-end space-x-3">
          <button type="button" onClick={onClose} className="px-5 py-2 border border-gray-300 text-gray-700 rounded font-medium hover:bg-gray-50 transition text-sm">Close</button>
          <button type="button" onClick={handleSave} disabled={loading || !name.trim()} className="px-6 py-2 bg-green-600 text-white rounded font-semibold hover:bg-green-700 transition text-sm disabled:opacity-50">
            {loading ? 'Saving...' : (editingProgram ? 'Save changes' : 'Save program')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- ADD DAY MODAL ---- */

function AddDayModal({ programId, nextDayNumber, onClose, onSuccess }) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const { error: insertError } = await supabase.from('training_days').insert({
      program_id: programId, day_number: nextDayNumber, title: title || null, notes: notes || null
    });
    if (insertError) { setError(insertError.message); setLoading(false); } else { onSuccess(); }
  };

  return (
    <div className="bg-white rounded-lg border-2 border-blue-200 p-4 mt-2">
      <form onSubmit={handleSubmit} className="space-y-3">
        <h5 className="font-semibold text-gray-900">Add Day {nextDayNumber}</h5>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Day Title (optional)</label>
          <input type="text" placeholder="e.g., Upper Body, Hitting Focus" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
          <input type="text" placeholder="e.g., Light warmup before starting" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm" />
        </div>
        <div className="flex space-x-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 transition">Cancel</button>
          <button type="submit" disabled={loading} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Adding...' : 'Add Day'}</button>
        </div>
      </form>
    </div>
  );
}

/* ---- ADD EXERCISE MODAL ---- */

function AddExerciseModal({ dayId, currentCount, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    category: 'hitting', name: '', description: '', sets: '', reps: '', weight: '', video_url: '', image_url: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const { error: insertError } = await supabase.from('training_exercises').insert({
      day_id: dayId, category: formData.category, name: formData.name,
      description: formData.description || null,
      sets: formData.sets ? parseInt(formData.sets) : null,
      reps: formData.reps || null, weight: formData.weight || null,
      video_url: formData.video_url || null, image_url: formData.image_url || null,
      sort_order: currentCount
    });
    if (insertError) { setError(insertError.message); setLoading(false); } else { onSuccess(); }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Add Exercise</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Category *</label>
            <select value={formData.category} onChange={(e) => setFormData({...formData, category: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="hitting">Hitting</option>
              <option value="pitching">Pitching</option>
              <option value="fielding">Fielding</option>
              <option value="conditioning">Conditioning</option>
              <option value="recovery">Recovery</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Exercise Name *</label>
            <input type="text" required placeholder="e.g., Tee Work, Long Toss, Squats" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <textarea placeholder="Instructions or notes for this exercise..." value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Sets</label>
              <input type="number" min="1" placeholder="e.g., 3" value={formData.sets} onChange={(e) => setFormData({...formData, sets: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Reps</label>
              <input type="text" placeholder="e.g., 10, 8-12" value={formData.reps} onChange={(e) => setFormData({...formData, reps: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Weight</label>
              <input type="text" placeholder="e.g., 135 lbs, BW" value={formData.weight} onChange={(e) => setFormData({...formData, weight: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Video URL</label>
            <input type="url" placeholder="https://youtube.com/watch?v=..." value={formData.video_url} onChange={(e) => setFormData({...formData, video_url: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Image URL</label>
            <input type="url" placeholder="https://example.com/image.jpg" value={formData.image_url} onChange={(e) => setFormData({...formData, image_url: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Adding...' : 'Add Exercise'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---- ASSIGN TRAINING PROGRAM MODAL ---- */

function AssignTrainingProgramModal({ program, teams, players, onClose, onSuccess }) {
  useModalTracking('AssignTrainingProgramModal');
  const [assignType, setAssignType] = useState('team');
  const [teamId, setTeamId] = useState('');
  const [selectedPlayerIds, setSelectedPlayerIds] = useState([]);
  const [levelFilter, setLevelFilter] = useState('All');
  const [playerSearch, setPlayerSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [scheduleOnCalendar, setScheduleOnCalendar] = useState(true);
  // Default to weekday programming (Mon-Fri)
  const [weekdays, setWeekdays] = useState([false, true, true, true, true, true, false]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const toggleWeekday = (idx) => {
    setWeekdays(prev => prev.map((v, i) => i === idx ? !v : v));
  };

  const playerLevel = (p) => {
    const prof = Array.isArray(p.player_profiles) ? p.player_profiles[0] : p.player_profiles;
    return prof?.level || '';
  };

  const availableLevels = [...new Set(players.map(playerLevel).filter(Boolean))].sort();

  const filteredPlayers = players.filter(p => {
    if (levelFilter !== 'All' && playerLevel(p) !== levelFilter) return false;
    const q = playerSearch.trim().toLowerCase();
    if (q && !(p.full_name || '').toLowerCase().includes(q)) return false;
    return true;
  });

  const togglePlayer = (id) => {
    setSelectedPlayerIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const selectAllFiltered = () => {
    const ids = filteredPlayers.map(p => p.id);
    const allSelected = ids.every(id => selectedPlayerIds.includes(id));
    if (allSelected) {
      setSelectedPlayerIds(prev => prev.filter(id => !ids.includes(id)));
    } else {
      setSelectedPlayerIds(prev => [...new Set([...prev, ...ids])]);
    }
  };

  // #393: a generated program (day_anchor 'weekday') lays itself out from the
  // Monday on/after the start date by its own day numbers — the coach's
  // weekday ticks don't apply. Hand-built programs keep the round-robin.
  const isWeekdayProgram = program?.day_anchor === 'weekday';

  // #439: the shared writer in programScheduling.js — the same one the
  // generators use when they assign, so a program lands identically here.
  const generateWorkoutEvents = async ({ teamId, playerIds }) => {
    if (!scheduleOnCalendar || !startDate || !endDate) return { count: 0 };
    if (!isWeekdayProgram && !weekdays.some(Boolean)) return { count: 0 };
    return scheduleProgramEvents({
      programId: program.id, programName: program.name, dayAnchor: program?.day_anchor,
      playerIds, teamId, startDate, endDate, weekdays,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');

    // Validate calendar inputs before any DB writes so we don't silently no-op
    if (scheduleOnCalendar) {
      if (!startDate || !endDate) {
        setError('Please pick a start and end date, or turn off "Add to calendar".');
        setLoading(false); return;
      }
      if (endDate < startDate) {
        setError('End date must be on or after start date.');
        setLoading(false); return;
      }
      if (!isWeekdayProgram && !weekdays.some(Boolean)) {
        setError('Please pick at least one weekday, or turn off "Add to calendar".');
        setLoading(false); return;
      }
    }

    const { data: { user } } = await supabase.auth.getUser();

    // Track inserted assignment IDs so we can roll back if event generation fails
    const insertedAssignmentIds = [];
    const rollback = async () => {
      if (insertedAssignmentIds.length === 0) return;
      await supabase.from('training_program_assignments').delete().in('id', insertedAssignmentIds);
    };

    try {
      if (assignType === 'team') {
        if (!teamId) { setError('Please select a team.'); setLoading(false); return; }
        const { data: inserted, error: insertError } = await supabase
          .from('training_program_assignments')
          .insert({
            program_id: program.id,
            team_id: teamId,
            player_id: null,
            start_date: startDate || null,
            end_date: endDate || null,
            assigned_by: user?.id,
          })
          .select('id');
        if (insertError) { setError(insertError.message); setLoading(false); return; }
        (inserted || []).forEach(r => insertedAssignmentIds.push(r.id));

        const { count } = await generateWorkoutEvents({ teamId });
        if (count > 0) alert(`Assigned program. Added ${count} workout${count === 1 ? '' : 's'} to the calendar.`);
        onSuccess();
        return;
      }

      if (selectedPlayerIds.length === 0) {
        setError('Please select at least one player.');
        setLoading(false);
        return;
      }

      // Process players in batches of 5 to avoid overwhelming the API
      const PLAYER_BATCH = 5;
      let totalCount = 0;
      for (let i = 0; i < selectedPlayerIds.length; i += PLAYER_BATCH) {
        const batch = selectedPlayerIds.slice(i, i + PLAYER_BATCH);
        const rows = batch.map(pid => ({
          program_id: program.id,
          player_id: pid,
          team_id: null,
          start_date: startDate || null,
          end_date: endDate || null,
          assigned_by: user?.id,
        }));
        const { data: inserted, error: insertError } = await supabase
          .from('training_program_assignments')
          .insert(rows)
          .select('id');
        if (insertError) { setError(insertError.message); await rollback(); setLoading(false); return; }
        (inserted || []).forEach(r => insertedAssignmentIds.push(r.id));

        const { count } = await generateWorkoutEvents({ playerIds: batch });
        totalCount += (count || 0);
      }
      if (totalCount > 0) alert(`Assigned program. Added ${totalCount} workout${totalCount === 1 ? '' : 's'} to the calendar.`);
      onSuccess();
    } catch (err) {
      await rollback();
      setError(err.message || String(err));
      setLoading(false);
    }
  };

  const allFilteredSelected = filteredPlayers.length > 0 && filteredPlayers.every(p => selectedPlayerIds.includes(p.id));

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-xl font-bold text-gray-900">Assign Program</h3>
            <p className="text-sm text-gray-600 mt-1">{program.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Assign To</label>
            <div className="flex space-x-2">
              <button type="button" onClick={() => setAssignType('team')} className={`flex-1 flex items-center justify-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium transition ${assignType === 'team' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                <Users size={16} /><span>Team</span>
              </button>
              <button type="button" onClick={() => setAssignType('players')} className={`flex-1 flex items-center justify-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium transition ${assignType === 'players' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                <User size={16} /><span>Players</span>
              </button>
            </div>
          </div>
          {assignType === 'team' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Select Team *</label>
              <select required value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Choose a team</option>
                {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-end justify-between gap-2">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Players *</label>
                  <p className="text-xs text-gray-500">{selectedPlayerIds.length} selected of {players.length}</p>
                </div>
                <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                  <option value="All">All levels</option>
                  {availableLevels.map(lvl => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              </div>
              <input
                type="text"
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                placeholder="Search players..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button type="button" onClick={selectAllFiltered} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                {allFilteredSelected ? 'Deselect' : 'Select'} all {filteredPlayers.length} {levelFilter !== 'All' ? `at ${levelFilter}` : 'shown'}
              </button>
              <div className="border border-gray-200 rounded-lg max-h-60 overflow-y-auto bg-white">
                {filteredPlayers.length === 0 && (
                  <p className="text-sm text-gray-500 p-3 text-center">No players match.</p>
                )}
                {filteredPlayers.map(p => {
                  const lvl = playerLevel(p);
                  return (
                    <label key={p.id} className="flex items-center space-x-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0">
                      <input
                        type="checkbox"
                        checked={selectedPlayerIds.includes(p.id)}
                        onChange={() => togglePlayer(p.id)}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-900 flex-1 truncate">{p.full_name}</span>
                      {lvl && <span className="text-xs text-gray-500">{lvl}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Start Date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">End Date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduleOnCalendar}
                onChange={(e) => setScheduleOnCalendar(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-900">Add to calendar over date range</span>
            </label>
            {scheduleOnCalendar && isWeekdayProgram && (
              <p className="mt-3 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg p-2">
                This program was generated with its own training days (day 1 = Monday). It will start on the Monday on or after the start date, keep its rest-day spacing, and repeat until the end date. <span className="font-medium">Weekday picks don't apply.</span>
              </p>
            )}
            {scheduleOnCalendar && !isWeekdayProgram && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1.5">Repeat on:</p>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_LABELS.map((label, i) => (
                    <button
                      type="button"
                      key={label}
                      onClick={() => toggleWeekday(i)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${weekdays[i] ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">Cycles through the program's days; if days run out, it loops back to Day 1.</p>
              </div>
            )}
          </div>
          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">
              {loading ? 'Assigning...' : assignType === 'team' ? 'Assign Program' : `Assign to ${selectedPlayerIds.length || ''} player${selectedPlayerIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---- CREATE WORKOUT TEMPLATE MODAL ---- */

function CreateWorkoutTemplateModal({ onClose, onSuccess, editingWorkout }) {
  useModalTracking('CreateWorkoutTemplateModal');
  const [name, setName] = useState(editingWorkout?.name || '');
  const [program, setProgram] = useState(editingWorkout?.program || 'Pitching');
  const [folder, setFolder] = useState(editingWorkout?.folder || 'No Folder');
  const [notes, setNotes] = useState(editingWorkout?.notes || '');
  const [tabs, setTabs] = useState(() => {
    if (editingWorkout?.exercises?.length > 0) {
      const exs = editingWorkout.exercises;
      if (exs[0].tab) {
        const tabMap = {};
        exs.forEach(ex => {
          const tabName = ex.tab || 'Tab 1';
          if (!tabMap[tabName]) tabMap[tabName] = [];
          tabMap[tabName].push({ name: ex.name || '', sets: ex.sets || '', reps: ex.reps || '', rest: ex.rest || '', load: ex.load || '', link: ex.link || '', category: ex.category || 'hitting', superSet: ex.superSet || '' });
        });
        return Object.entries(tabMap).map(([tabName, exercises]) => ({ tabName, exercises }));
      }
      return [{ tabName: 'Tab 1', exercises: exs.map(ex => ({ name: ex.name || '', sets: ex.sets || '', reps: ex.reps || '', rest: ex.rest || '', load: ex.load || '', link: ex.link || '', category: ex.category || 'hitting', superSet: ex.superSet || '' })) }];
    }
    return [{ tabName: 'Tab 1', exercises: [{ name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }] }];
  });
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const safeIndex = Math.min(activeTabIndex, tabs.length - 1);
  const activeTab = tabs[safeIndex] || tabs[0];
  const { videos: exerciseVideos, loading: exerciseVideosLoading } = useExerciseVideos();

  const addTab = () => {
    const newTabs = [...tabs, { tabName: `Tab ${tabs.length + 1}`, exercises: [{ name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }] }];
    setTabs(newTabs);
    setActiveTabIndex(newTabs.length - 1);
  };

  const cloneTab = () => {
    const cloned = JSON.parse(JSON.stringify(activeTab));
    cloned.tabName = `${activeTab.tabName} (Copy)`;
    const newTabs = [...tabs, cloned];
    setTabs(newTabs);
    setActiveTabIndex(newTabs.length - 1);
  };

  const deleteTab = () => {
    if (tabs.length <= 1) return;
    const newIndex = safeIndex === 0 ? 0 : safeIndex - 1;
    const newTabs = tabs.filter((_, i) => i !== safeIndex);
    setActiveTabIndex(newIndex);
    setTabs(newTabs);
  };

  const updateExercise = (exIndex, field, value) => {
    const newTabs = [...tabs];
    newTabs[safeIndex] = {
      ...newTabs[safeIndex],
      exercises: newTabs[safeIndex].exercises.map((ex, i) =>
        i === exIndex ? { ...ex, [field]: value } : ex
      )
    };
    setTabs(newTabs);
  };

  // See the identical helper in CreateTrainingProgramModal for why this
  // exists: picking a video suggestion needs to set name + link atomically.
  const updateExerciseFields = (exIndex, patch) => {
    const newTabs = [...tabs];
    newTabs[safeIndex] = {
      ...newTabs[safeIndex],
      exercises: newTabs[safeIndex].exercises.map((ex, i) =>
        i === exIndex ? { ...ex, ...patch } : ex
      )
    };
    setTabs(newTabs);
  };

  const addExercise = () => {
    const newTabs = [...tabs];
    newTabs[safeIndex] = {
      ...newTabs[safeIndex],
      exercises: [...newTabs[safeIndex].exercises, { name: '', sets: '1', reps: '', link: '', category: 'hitting', superSet: '' }]
    };
    setTabs(newTabs);
  };

  const removeExercise = (exIndex) => {
    const newTabs = [...tabs];
    const exercises = newTabs[safeIndex].exercises;
    if (exercises.length <= 1) return;
    newTabs[safeIndex] = {
      ...newTabs[safeIndex],
      exercises: exercises.filter((_, i) => i !== exIndex)
    };
    setTabs(newTabs);
  };

  const handleSave = async () => {
    trackAction('save_workout_template');
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const rawExercises = tabs.flatMap(tab =>
      tab.exercises.filter(ex => ex.name.trim()).map(ex => ({ ...ex, tab: tab.tabName }))
    );
    // Sort exercises: group by super set alphabetically, unassigned exercises keep original order at end
    const withSuperSet = rawExercises.filter(ex => ex.superSet);
    const withoutSuperSet = rawExercises.filter(ex => !ex.superSet);
    withSuperSet.sort((a, b) => a.superSet.localeCompare(b.superSet));
    const allExercises = [...withSuperSet, ...withoutSuperSet];

    if (editingWorkout) {
      const { error: updateError } = await supabase.from('workout_templates')
        .update({ name, program: program || null, folder: folder === 'No Folder' ? null : folder, notes: notes || null, exercises: allExercises })
        .eq('id', editingWorkout.id);
      if (updateError) { setError(updateError.message); setLoading(false); } else { onSuccess(); }
    } else {
      const { error: insertError } = await supabase.from('workout_templates').insert({
        name, program: program || null, folder: folder === 'No Folder' ? null : folder, notes: notes || null, exercises: allExercises, created_by: user?.id,
      });
      if (insertError) { setError(insertError.message); setLoading(false); } else { onSuccess(); }
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="text-center py-5 border-b border-gray-200">
          <h3 className="text-2xl font-bold text-gray-900">Workout</h3>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}

          {/* Tab Controls */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex space-x-2">
              <button type="button" onClick={addTab} className="px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 transition">Add tab</button>
              <button type="button" onClick={cloneTab} className="px-4 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 transition">Clone tab</button>
            </div>
            <button type="button" onClick={deleteTab} disabled={tabs.length <= 1} className="px-4 py-1.5 border border-gray-300 text-gray-700 text-sm font-medium rounded hover:bg-gray-50 transition disabled:opacity-40 disabled:cursor-not-allowed">Delete tab</button>
          </div>

          {/* Tab Selector */}
          {tabs.length > 1 && (
            <div className="flex space-x-1 mb-4 border-b border-gray-200">
              {tabs.map((tab, i) => (
                <button key={i} type="button" onClick={() => setActiveTabIndex(i)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition ${i === safeIndex ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {tab.tabName}
                </button>
              ))}
            </div>
          )}

          {/* Form Fields */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 space-y-4">
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Workout Name</label>
              <input type="text" required placeholder="Workout Name" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Program:</label>
              <select value={program} onChange={(e) => setProgram(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                {PROGRAM_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Folder</label>
              <select value={folder} onChange={(e) => setFolder(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                {FOLDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-1">Workout Notes</label>
              <input type="text" placeholder="Workout Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" />
            </div>

            {/* Exercises — #321 follow-up: this table has no responsive
                handling at all below sm (640px), so on a portrait phone the
                browser compresses every <input> in the Sets/Reps/Rest/Load
                columns down to a sliver, clipping their values to a single
                visible character. Below sm, stack each exercise as a
                labelled card instead of shrinking a 9-column table — a
                4-column numeric grid plus a URL field has no business being
                a table at 390px. Desktop (sm+) keeps the exact table it had. */}
            <div>
              <label className="block text-sm font-bold text-gray-900 mb-2">Exercises</label>

              {/* Portrait phone: stacked cards */}
              <div className="sm:hidden space-y-3">
                {activeTab.exercises.map((ex, i) => (
                  <div key={i} className="border border-gray-200 rounded-lg p-3 bg-white space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-500 pt-2">#{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <ExerciseNameInput
                          value={ex.name}
                          onChange={(name) => updateExercise(i, 'name', name)}
                          onPick={({ name, video_url }) => updateExerciseFields(i, ex.link ? { name } : { name, link: video_url })}
                          hasLink={!!ex.link}
                          videos={exerciseVideos}
                          loading={exerciseVideosLoading}
                        />
                      </div>
                      <button type="button" onClick={() => removeExercise(i)} className="text-gray-400 hover:text-red-600 transition flex-shrink-0 pt-2"><Trash2 size={14} /></button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Sets</label>
                        <input type="text" placeholder="1" value={ex.sets} onChange={(e) => updateExercise(i, 'sets', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Reps</label>
                        <input type="text" placeholder="Reps" value={ex.reps} onChange={(e) => updateExercise(i, 'reps', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Rest</label>
                        <input type="text" placeholder="Rest" value={ex.rest || ''} onChange={(e) => updateExercise(i, 'rest', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Load</label>
                        <input type="text" placeholder="Load" value={ex.load || ''} onChange={(e) => updateExercise(i, 'load', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Link</label>
                      <div className="flex space-x-1">
                        <input type="text" placeholder="Link" value={ex.link} onChange={(e) => updateExercise(i, 'link', e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                        <select value={ex.category || 'hitting'} onChange={(e) => updateExercise(i, 'category', e.target.value)} className="px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white flex-shrink-0">
                          <option value="hitting">Hitting</option>
                          <option value="pitching">Pitching</option>
                          <option value="fielding">Fielding</option>
                          <option value="conditioning">Conditioning</option>
                          <option value="recovery">Recovery</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Super Set</label>
                      <select value={ex.superSet || ''} onChange={(e) => updateExercise(i, 'superSet', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
                        {SUPER_SET_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt || '—'}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
                <button type="button" onClick={addExercise} className="w-full flex items-center justify-center gap-1.5 py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:text-green-600 hover:border-green-400 transition">
                  <Plus size={16} /> Add exercise
                </button>
              </div>

              {/* Tablet/desktop: original table, unchanged */}
              <table className="hidden sm:table w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-700 border-b border-gray-300">
                    <th className="pb-2 w-8"></th>
                    <th className="pb-2 pr-2">Name</th>
                    <th className="pb-2 pr-2 w-16 text-center">Sets</th>
                    <th className="pb-2 pr-2 w-20 text-center">Reps</th>
                    <th className="pb-2 pr-2 w-16 text-center">Rest</th>
                    <th className="pb-2 pr-2 w-16 text-center">Load</th>
                    <th className="pb-2 pr-2 text-center">Link</th>
                    <th className="pb-2 pr-2 w-20 text-center">Super Set</th>
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeTab.exercises.map((ex, i) => (
                    <tr key={i} className="border-b border-gray-100">
                      <td className="py-2">
                        <button type="button" onClick={addExercise} className="text-gray-400 hover:text-green-600 transition"><Plus size={16} /></button>
                      </td>
                      <td className="py-2 pr-2">
                        <ExerciseNameInput
                          value={ex.name}
                          onChange={(name) => updateExercise(i, 'name', name)}
                          onPick={({ name, video_url }) => updateExerciseFields(i, ex.link ? { name } : { name, link: video_url })}
                          hasLink={!!ex.link}
                          videos={exerciseVideos}
                          loading={exerciseVideosLoading}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="1" value={ex.sets} onChange={(e) => updateExercise(i, 'sets', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Reps" value={ex.reps} onChange={(e) => updateExercise(i, 'reps', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Rest" value={ex.rest || ''} onChange={(e) => updateExercise(i, 'rest', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <input type="text" placeholder="Load" value={ex.load || ''} onChange={(e) => updateExercise(i, 'load', e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center" />
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex space-x-1">
                          <input type="text" placeholder="Link" value={ex.link} onChange={(e) => updateExercise(i, 'link', e.target.value)} className="flex-1 px-2 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white" />
                          <select value={ex.category || 'hitting'} onChange={(e) => updateExercise(i, 'category', e.target.value)} className="px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white">
                            <option value="hitting">Hitting</option>
                            <option value="pitching">Pitching</option>
                            <option value="fielding">Fielding</option>
                            <option value="conditioning">Conditioning</option>
                            <option value="recovery">Recovery</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <select value={ex.superSet || ''} onChange={(e) => updateExercise(i, 'superSet', e.target.value)} className="w-full px-1 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white text-center">
                          {SUPER_SET_OPTIONS.map(opt => (
                            <option key={opt} value={opt}>{opt || '—'}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2">
                        <button type="button" onClick={() => removeExercise(i)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Footer Buttons */}
        <div className="border-t border-gray-200 px-6 py-4 flex justify-end space-x-3">
          <button type="button" onClick={onClose} className="px-5 py-2 border border-gray-300 text-gray-700 rounded font-medium hover:bg-gray-50 transition text-sm">Close</button>
          <button type="button" onClick={handleSave} disabled={loading || !name.trim()} className="px-6 py-2 bg-green-600 text-white rounded font-semibold hover:bg-green-700 transition text-sm disabled:opacity-50">
            {loading ? 'Saving...' : (editingWorkout ? 'Save changes' : 'Save workout')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================
   MEALS TAB (unchanged from previous)
   ============================================ */

export function MealsTab({ teams, players }) {
  const [mealsSubTab, setMealsSubTab] = useState('meals');
  const [meals, setMeals] = useState([]);
  const [mealPlans, setMealPlans] = useState([]);
  const [showCreateMeal, setShowCreateMeal] = useState(false);
  const [showCreatePlan, setShowCreatePlan] = useState(false);
  const [showAssignPlan, setShowAssignPlan] = useState(false);
  const [selectedPlanForAssign, setSelectedPlanForAssign] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchMeals(); fetchMealPlans(); }, []);

  const fetchMeals = async () => {
    const { data, error } = await supabase.from('meals').select('*').order('meal_type').order('name');
    if (!error) setMeals(data); setLoading(false);
  };

  const fetchMealPlans = async () => {
    const { data, error } = await supabase.from('meal_plans')
      .select('*, meal_plan_items(id, sort_order, meal_id, meals(*)), meal_plan_assignments(id, player_id, team_id, start_date, end_date, users:player_id(full_name), teams:team_id(name))')
      .order('created_at', { ascending: false });
    if (!error) setMealPlans(data);
  };

  const handleDeleteMeal = async (mealId) => {
    if (!window.confirm('Delete this meal?')) return;
    const { error } = await supabase.from('meals').delete().eq('id', mealId);
    if (!error) { fetchMeals(); fetchMealPlans(); }
  };

  const handleDeletePlan = async (planId) => {
    if (!window.confirm('Delete this meal plan?')) return;
    const { error } = await supabase.from('meal_plans').delete().eq('id', planId);
    if (!error) fetchMealPlans();
  };

  if (loading) return <div className="text-gray-600">Loading meals...</div>;

  return (
    <div className="space-y-4">
      <div className="flex space-x-2">
        <button onClick={() => setMealsSubTab('meals')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${mealsSubTab === 'meals' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Individual Meals ({meals.length})</button>
        <button onClick={() => setMealsSubTab('plans')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${mealsSubTab === 'plans' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>Meal Plans ({mealPlans.length})</button>
      </div>

      {mealsSubTab === 'meals' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Individual Meals</h3>
            <button onClick={() => setShowCreateMeal(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"><Plus size={18} /><span>Add Meal</span></button>
          </div>
          {meals.length === 0 ? (
            <div className="text-center py-8 text-gray-500"><Utensils size={40} className="mx-auto mb-3 text-gray-300" /><p>No meals created yet.</p></div>
          ) : (
            <div className="space-y-2">
              {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
                const typeMeals = meals.filter(m => m.meal_type === type);
                if (typeMeals.length === 0) return null;
                return (<div key={type}><h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 mt-4">{type} ({typeMeals.length})</h4>{typeMeals.map(meal => <MealCard key={meal.id} meal={meal} onDelete={handleDeleteMeal} />)}</div>);
              })}
            </div>
          )}
          {showCreateMeal && <CreateMealModal onClose={() => setShowCreateMeal(false)} onSuccess={() => { setShowCreateMeal(false); fetchMeals(); }} />}
        </div>
      )}

      {mealsSubTab === 'plans' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Meal Plans</h3>
            <button onClick={() => setShowCreatePlan(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2" disabled={meals.length === 0}><Plus size={18} /><span>Create Plan</span></button>
          </div>
          {meals.length === 0 && <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded text-sm">Create some individual meals first.</div>}
          {mealPlans.length === 0 ? (
            <div className="text-center py-8 text-gray-500"><Utensils size={40} className="mx-auto mb-3 text-gray-300" /><p>No meal plans yet.</p></div>
          ) : (
            <div className="space-y-4">{mealPlans.map(plan => <MealPlanCard key={plan.id} plan={plan} onDelete={handleDeletePlan} onAssign={() => { setSelectedPlanForAssign(plan); setShowAssignPlan(true); }} />)}</div>
          )}
          {showCreatePlan && <CreateMealPlanModal meals={meals} onClose={() => setShowCreatePlan(false)} onSuccess={() => { setShowCreatePlan(false); fetchMealPlans(); }} />}
          {showAssignPlan && selectedPlanForAssign && <AssignMealPlanModal plan={selectedPlanForAssign} teams={teams} players={players} onClose={() => { setShowAssignPlan(false); setSelectedPlanForAssign(null); }} onSuccess={() => { setShowAssignPlan(false); setSelectedPlanForAssign(null); fetchMealPlans(); }} />}
        </div>
      )}
    </div>
  );
}

function MealCard({ meal, onDelete }) {
  const colors = { breakfast: 'bg-yellow-100 text-yellow-700', lunch: 'bg-green-100 text-green-700', dinner: 'bg-blue-100 text-blue-700', snack: 'bg-purple-100 text-purple-700' };
  return (
    <div className="bg-gray-50 rounded-lg p-4 flex justify-between items-start mb-2">
      <div className="flex-1">
        <div className="flex items-center space-x-3"><span className="font-semibold text-gray-900">{meal.name}</span><span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[meal.meal_type]}`}>{meal.meal_type}</span></div>
        {meal.description && <p className="text-sm text-gray-600 mt-1">{meal.description}</p>}
        <div className="flex items-center space-x-4 mt-2 text-sm text-gray-500">
          {meal.calories && <span>{meal.calories} cal</span>}{meal.protein_g && <span>P: {meal.protein_g}g</span>}{meal.carbs_g && <span>C: {meal.carbs_g}g</span>}{meal.fat_g && <span>F: {meal.fat_g}g</span>}
        </div>
      </div>
      <button onClick={() => onDelete(meal.id)} className="text-gray-400 hover:text-red-600 transition ml-4"><Trash2 size={16} /></button>
    </div>
  );
}

function MealPlanCard({ plan, onDelete, onAssign }) {
  const [expanded, setExpanded] = useState(false);
  const items = plan.meal_plan_items || [];
  const assignments = plan.meal_plan_assignments || [];
  const totals = items.reduce((acc, item) => { const m = item.meals; if (m) { acc.calories += m.calories || 0; acc.protein += parseFloat(m.protein_g) || 0; acc.carbs += parseFloat(m.carbs_g) || 0; acc.fat += parseFloat(m.fat_g) || 0; } return acc; }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const grouped = {}; items.forEach(item => { if (item.meals) { const t = item.meals.meal_type; if (!grouped[t]) grouped[t] = []; grouped[t].push(item.meals); } });

  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="flex items-center space-x-3"><span className="font-semibold text-gray-900 text-lg">{plan.name}</span><span className="text-xs text-gray-500">{items.length} meals</span></div>
          {plan.description && <p className="text-sm text-gray-600 mt-1">{plan.description}</p>}
          <div className="flex items-center space-x-4 mt-2 text-sm font-medium">
            <span className="text-orange-600">{totals.calories} cal</span><span className="text-blue-600">P: {totals.protein.toFixed(1)}g</span><span className="text-green-600">C: {totals.carbs.toFixed(1)}g</span><span className="text-yellow-600">F: {totals.fat.toFixed(1)}g</span>
          </div>
          {assignments.length > 0 && <div className="flex flex-wrap gap-2 mt-2">{assignments.map(a => <span key={a.id} className="inline-flex items-center px-2 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">{a.teams ? <><Users size={12} className="mr-1" />{a.teams.name}</> : a.users ? <><User size={12} className="mr-1" />{a.users.full_name}</> : null}</span>)}</div>}
        </div>
        <div className="flex items-center space-x-2 ml-4">
          <button onClick={onAssign} className="text-blue-600 hover:text-blue-800 text-sm font-medium transition">Assign</button>
          <button onClick={() => setExpanded(!expanded)} className="text-gray-400 hover:text-gray-600 transition">{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
          <button onClick={() => onDelete(plan.id)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={16} /></button>
        </div>
      </div>
      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
          {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
            if (!grouped[type]) return null;
            return (<div key={type}><h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{type}</h5>{grouped[type].map(meal => <div key={meal.id} className="flex justify-between items-center py-1 px-2 text-sm"><span className="text-gray-900">{meal.name}</span><span className="text-gray-500">{meal.calories && `${meal.calories} cal`}{meal.protein_g && ` Â· P:${meal.protein_g}g`}{meal.carbs_g && ` Â· C:${meal.carbs_g}g`}{meal.fat_g && ` Â· F:${meal.fat_g}g`}</span></div>)}</div>);
          })}
        </div>
      )}
    </div>
  );
}

function CreateMealModal({ onClose, onSuccess }) {
  const [formData, setFormData] = useState({ name: '', description: '', meal_type: 'breakfast', calories: '', protein_g: '', carbs_g: '', fat_g: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('meals').insert({ name: formData.name, description: formData.description || null, meal_type: formData.meal_type, calories: formData.calories ? parseInt(formData.calories) : null, protein_g: formData.protein_g ? parseFloat(formData.protein_g) : null, carbs_g: formData.carbs_g ? parseFloat(formData.carbs_g) : null, fat_g: formData.fat_g ? parseFloat(formData.fat_g) : null, created_by: user?.id });
    if (err) { setError(err.message); setLoading(false); } else { onSuccess(); }
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between"><h3 className="text-xl font-bold text-gray-900">Add Meal</h3><button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button></div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Meal Name *</label><input type="text" required placeholder="e.g., Grilled Chicken & Rice" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Description</label><textarea placeholder="Optional details..." value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Meal Type *</label><select value={formData.meal_type} onChange={(e) => setFormData({...formData, meal_type: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="breakfast">Breakfast</option><option value="lunch">Lunch</option><option value="dinner">Dinner</option><option value="snack">Snack</option></select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Calories</label><input type="number" placeholder="550" value={formData.calories} onChange={(e) => setFormData({...formData, calories: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Protein (g)</label><input type="number" step="0.1" placeholder="40" value={formData.protein_g} onChange={(e) => setFormData({...formData, protein_g: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Carbs (g)</label><input type="number" step="0.1" placeholder="60" value={formData.carbs_g} onChange={(e) => setFormData({...formData, carbs_g: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Fat (g)</label><input type="number" step="0.1" placeholder="15" value={formData.fat_g} onChange={(e) => setFormData({...formData, fat_g: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          </div>
          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Creating...' : 'Add Meal'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateMealPlanModal({ meals, onClose, onSuccess }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedMealIds, setSelectedMealIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const toggleMeal = (id) => setSelectedMealIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  const selected = meals.filter(m => selectedMealIds.includes(m.id));
  const totals = selected.reduce((acc, m) => { acc.calories += m.calories || 0; acc.protein += parseFloat(m.protein_g) || 0; acc.carbs += parseFloat(m.carbs_g) || 0; acc.fat += parseFloat(m.fat_g) || 0; return acc; }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const handleSubmit = async (e) => {
    e.preventDefault(); if (selectedMealIds.length === 0) { setError('Select at least one meal'); return; }
    setLoading(true); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const { data: plan, error: pErr } = await supabase.from('meal_plans').insert({ name, description: description || null, created_by: user?.id }).select().single();
    if (pErr) { setError(pErr.message); setLoading(false); return; }
    const items = selectedMealIds.map((id, i) => ({ meal_plan_id: plan.id, meal_id: id, sort_order: i }));
    const { error: iErr } = await supabase.from('meal_plan_items').insert(items);
    if (iErr) { setError(iErr.message); setLoading(false); } else { onSuccess(); }
  };

  const typeColors = { breakfast: 'border-yellow-300 bg-yellow-50', lunch: 'border-green-300 bg-green-50', dinner: 'border-blue-300 bg-blue-50', snack: 'border-purple-300 bg-purple-50' };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between z-10"><h3 className="text-xl font-bold text-gray-900">Create Meal Plan</h3><button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button></div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Plan Name *</label><input type="text" required placeholder="e.g., Game Day Nutrition" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Description</label><textarea placeholder="What is this plan for?" value={description} onChange={(e) => setDescription(e.target.value)} rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          {selectedMealIds.length > 0 && (
            <div className="bg-gray-100 rounded-lg p-3 flex items-center justify-between text-sm font-medium">
              <span className="text-gray-700">{selectedMealIds.length} meals</span>
              <div className="flex space-x-4"><span className="text-orange-600">{totals.calories} cal</span><span className="text-blue-600">P: {totals.protein.toFixed(1)}g</span><span className="text-green-600">C: {totals.carbs.toFixed(1)}g</span><span className="text-yellow-600">F: {totals.fat.toFixed(1)}g</span></div>
            </div>
          )}
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Select Meals *</label>
            <div className="space-y-4">
              {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
                const tm = meals.filter(m => m.meal_type === type); if (tm.length === 0) return null;
                return (<div key={type}><h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{type}</h5><div className="space-y-2">{tm.map(meal => (
                  <label key={meal.id} className={`flex items-center justify-between p-3 rounded-lg border-2 cursor-pointer transition ${selectedMealIds.includes(meal.id) ? typeColors[type] : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center space-x-3"><input type="checkbox" checked={selectedMealIds.includes(meal.id)} onChange={() => toggleMeal(meal.id)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" /><div><span className="font-medium text-gray-900">{meal.name}</span>{meal.description && <p className="text-xs text-gray-500">{meal.description}</p>}</div></div>
                    <div className="text-xs text-gray-500 text-right">{meal.calories && <div>{meal.calories} cal</div>}{meal.protein_g && <div>P:{meal.protein_g}g C:{meal.carbs_g}g F:{meal.fat_g}g</div>}</div>
                  </label>
                ))}</div></div>);
              })}
            </div>
          </div>
          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading || selectedMealIds.length === 0} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Creating...' : 'Create Plan'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssignMealPlanModal({ plan, teams, players, onClose, onSuccess }) {
  const [assignType, setAssignType] = useState('team');
  const [teamId, setTeamId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    const { data: { user } } = await supabase.auth.getUser();
    const { error: err } = await supabase.from('meal_plan_assignments').insert({ meal_plan_id: plan.id, player_id: assignType === 'player' ? playerId : null, team_id: assignType === 'team' ? teamId : null, start_date: startDate || null, end_date: endDate || null, assigned_by: user?.id });
    if (err) { setError(err.message); setLoading(false); } else { onSuccess(); }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350: capped, with the plan name clamped to two lines so a long name
          cannot grow the header past the cap and clip the form below it. The
          buttons stay inside the <form> (Assign Plan is the submit) but sit in
          a footer outside the scrolling area. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-start justify-between gap-3 flex-shrink-0"><div className="min-w-0"><h3 className="text-xl font-bold text-gray-900">Assign Meal Plan</h3><p className="text-sm text-gray-600 mt-1 line-clamp-2 break-words" title={plan.name}>{plan.name}</p></div><button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button></div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          <div><label className="block text-sm font-medium text-gray-700 mb-2">Assign To</label>
            <div className="flex space-x-2">
              <button type="button" onClick={() => setAssignType('team')} className={`flex-1 flex items-center justify-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium transition ${assignType === 'team' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}><Users size={16} /><span>Team</span></button>
              <button type="button" onClick={() => setAssignType('player')} className={`flex-1 flex items-center justify-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium transition ${assignType === 'player' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}><User size={16} /><span>Player</span></button>
            </div>
          </div>
          {assignType === 'team' ? (
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Select Team *</label><select required value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">Choose a team</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          ) : (
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Select Player *</label><select required value={playerId} onChange={(e) => setPlayerId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">Choose a player</option>{players.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-2">Start Date</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-2">End Date</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          </div>
        </div>
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
          <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
          <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">{loading ? 'Assigning...' : 'Assign Plan'}</button>
        </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================
   TRAINING SLOTS TAB
   ============================================ */

function TrainingSlotsTab({ userId }) {
  const [slots, setSlots] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchSlots(); }, [userId]);

  const formatTime = (time) => {
    if (!time) return '';
    const [h, m] = time.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  };

  const fetchSlots = async () => {
    setLoading(true);
    const { data: slotData, error } = await supabase
      .from('training_slots')
      .select('*')
      .eq('coach_id', userId)
      .order('slot_date', { ascending: true });
    if (error) { console.error(error); setLoading(false); return; }

    // Expand recurring slots into individual occurrence dates within a 90-day window
    // so the coach sees sessions listed under the actual booked date, not just the
    // master creation date.
    const today = new Date();
    const windowStart = new Date(today); windowStart.setDate(today.getDate() - 30);
    const windowEnd = new Date(today); windowEnd.setDate(today.getDate() + 60);
    const expanded = [];
    const slotExceptionMap = buildSlotExceptionMap(slotData);
    (slotData || []).forEach(slot => {
      if (slot.recurrence_parent_id) return;
      if (slot.repeat_weekly) {
        const slotStart = new Date(slot.slot_date + 'T00:00:00');
        const endDate = slot.repeat_end_date ? new Date(slot.repeat_end_date + 'T00:00:00') : windowEnd;
        let current = new Date(slotStart);
        while (current <= endDate && current <= windowEnd) {
          const dateStr = fmtLocalDate(current);
          // #292: ANY exception skips the date — tombstoned dates are gone,
          // moved dates render from their child row below.
          if (current >= windowStart && !getSlotDateException(slotExceptionMap, slot.id, dateStr)) {
            expanded.push({ ...slot, slot_date: dateStr });
          }
          current.setDate(current.getDate() + 7);
        }
      } else if (!getSlotDateException(slotExceptionMap, slot.id, slot.slot_date)) {
        expanded.push(slot);
      }
    });
    // #292: moved occurrences are real sessions on their own date (unfiltered
    // by the window, matching how this list treats non-recurring rows).
    collectMovedSlots(slotData).forEach(slot => expanded.push(slot));
    setSlots(expanded);

    const slotIds = (slotData || []).map(s => s.id);
    if (slotIds.length > 0) {
      const { data: resData } = await supabase
        .from('slot_reservations')
        .select('*, users:player_id(full_name, email)')
        .in('slot_id', slotIds);
      setReservations(resData || []);
    } else {
      setReservations([]);
    }
    setLoading(false);
  };

  const handleConfirm = async (reservationId) => {
    await supabase.from('slot_reservations').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', reservationId);
    fetchSlots();
  };

  const handleDecline = async (reservationId) => {
    await supabase.from('slot_reservations').update({ status: 'declined' }).eq('id', reservationId);
    fetchSlots();
  };

  const handleDeleteSlot = async (slotId) => {
    if (!window.confirm('Delete this training slot and all its reservations?')) return;
    await supabase.from('slot_reservations').delete().eq('slot_id', slotId);
    await supabase.from('training_slots').delete().eq('id', slotId);
    fetchSlots();
  };

  const handleCreateSlot = async (formData) => {
    const { error } = await supabase.from('training_slots').insert({
      coach_id: userId,
      slot_date: formData.slotDate,
      start_time: formData.startTime,
      duration_minutes: formData.duration,
      auto_confirm: formData.autoConfirm,
      is_recurring: formData.repeatWeekly,
      repeat_weekly: formData.repeatWeekly,
      repeat_end_date: formData.repeatWeekly && formData.repeatEndDate ? formData.repeatEndDate : null,
      max_players: formData.maxPlayers,
      notes: formData.notes || null
    });
    if (error) { alert('Error creating slot: ' + formatUserError(error)); return; }
    setShowCreateForm(false);
    fetchSlots();
  };

  if (loading) return <div className="text-gray-600">Loading training slots...</div>;

  // Group slots by date
  const slotsByDate = {};
  slots.forEach(slot => {
    if (!slotsByDate[slot.slot_date]) slotsByDate[slot.slot_date] = [];
    slotsByDate[slot.slot_date].push(slot);
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">Training Slots</h3>
        <button onClick={() => setShowCreateForm(true)} className="bg-teal-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-teal-700 transition flex items-center space-x-2">
          <Plus size={18} /><span>Create Slot</span>
        </button>
      </div>

      {slots.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <Clock size={40} className="mx-auto mb-3 text-gray-300" />
          <p>No training slots yet. Create your first slot to allow players to book sessions!</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(slotsByDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, dateSlots]) => (
            <div key={date}>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">
                {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </h4>
              <div className="space-y-3">
                {dateSlots.map(slot => {
                  const slotReservations = reservations.filter(r => r.slot_id === slot.id && r.slot_date === slot.slot_date);
                  return (
                    <div key={`${slot.id}-${slot.slot_date}`} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center space-x-3">
                            <span className="font-medium text-gray-900">{formatTime(slot.start_time)}</span>
                            <span className="text-sm text-gray-500">{slot.duration_minutes} min</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-100 text-teal-700">Max {slot.max_players} player{slot.max_players > 1 ? 's' : ''}</span>
                            {slot.auto_confirm && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Auto-confirm</span>}
                            {slot.repeat_weekly && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Weekly</span>}
                          </div>
                          {slot.notes && <p className="text-sm text-gray-500 mt-1">{slot.notes}</p>}
                        </div>
                        <button onClick={() => handleDeleteSlot(slot.id)} className="text-gray-400 hover:text-red-600 transition"><Trash2 size={16} /></button>
                      </div>
                      {slotReservations.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
                          {slotReservations.map(res => (
                            <div key={res.id} className="flex items-center justify-between text-sm">
                              <div className="flex items-center space-x-2">
                                <span className="font-medium text-gray-900">{res.users?.full_name || 'Unknown'}</span>
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                  res.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                                  res.status === 'declined' ? 'bg-red-100 text-red-700' :
                                  'bg-yellow-100 text-yellow-700'
                                }`}>{res.status}</span>
                                {res.player_note && <span className="text-gray-400 text-xs">"{res.player_note}"</span>}
                              </div>
                              {res.status === 'pending' && (
                                <div className="flex items-center space-x-2">
                                  <button onClick={() => handleConfirm(res.id)} className="text-green-600 hover:text-green-800 transition" title="Confirm"><Check size={18} /></button>
                                  <button onClick={() => handleDecline(res.id)} className="text-red-600 hover:text-red-800 transition" title="Decline"><XCircle size={18} /></button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateForm && (
        <CreateSlotForm
          onClose={() => setShowCreateForm(false)}
          onSave={handleCreateSlot}
        />
      )}
    </div>
  );
}

function CreateSlotForm({ onClose, onSave }) {
  const [slotDate, setSlotDate] = useState(fmtLocalDate(new Date()));
  const [startTime, setStartTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [repeatWeekly, setRepeatWeekly] = useState(false);
  const [repeatEndDate, setRepeatEndDate] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(1);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    await onSave({ slotDate, startTime, duration, autoConfirm, repeatWeekly, repeatEndDate, maxPlayers, notes });
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350: eight fields is about 750px of form. Uncapped, "Create Slot"
          sat below the bottom of a `fixed` overlay on a 1280x700 laptop and on
          every phone, so a coach could not publish a slot at all. The fields
          scroll now; Cancel and Create Slot live in a footer outside the
          scroll area. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Create Training Slot</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={24} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Date</label><input type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Duration</label><select value={duration} onChange={(e) => setDuration(parseInt(e.target.value))} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"><option value={30}>30 min</option><option value={45}>45 min</option><option value={60}>60 min</option><option value={90}>90 min</option></select></div>
          </div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Max Players</label><input type="number" min="1" max="50" value={maxPlayers} onChange={(e) => setMaxPlayers(parseInt(e.target.value) || 1)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
          <div className="flex items-center space-x-3"><input type="checkbox" id="ctAutoConfirm" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} className="rounded" /><label htmlFor="ctAutoConfirm" className="text-sm text-gray-700">Auto-confirm reservations</label></div>
          <div className="flex items-center space-x-3"><input type="checkbox" id="ctRepeatWeekly" checked={repeatWeekly} onChange={(e) => setRepeatWeekly(e.target.checked)} className="rounded" /><label htmlFor="ctRepeatWeekly" className="text-sm text-gray-700">Repeat weekly</label></div>
          {repeatWeekly && <div><label className="block text-sm font-medium text-gray-700 mb-1">Repeat until</label><input type="date" value={repeatEndDate} onChange={(e) => setRepeatEndDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>}
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g., Hitting session, Pitching mechanics" rows="2" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" /></div>
        </div>
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
          <button onClick={handleSubmit} disabled={loading} className="flex-1 bg-teal-600 text-white py-2 rounded-lg hover:bg-teal-700 transition disabled:opacity-50">{loading ? 'Creating...' : 'Create Slot'}</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================
   ASSESSMENTS TAB
   ============================================ */

function AssessmentsTab({ players, userId }) {
  const [subTab, setSubTab] = useState('templates');
  const [templates, setTemplates] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showFillModal, setShowFillModal] = useState(null);
  const [showViewModal, setShowViewModal] = useState(null);
  const [showEditModal, setShowEditModal] = useState(null);
  // #456: { template, playerId } for "Reassess" (a NEW blank submission for
  // the same athlete + template), and { template, playerName, submissions }
  // for the trend view.
  const [reassess, setReassess] = useState(null);
  const [trendsFor, setTrendsFor] = useState(null);

  useEffect(() => { fetchTemplates(); fetchSubmissions(); }, []);

  const fetchTemplates = async () => {
    const { data, error } = await supabase
      .from('assessment_templates')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error) setTemplates(data || []);
    setLoading(false);
  };

  // #437: there are 1,000+ submissions (1,023 on 2026-10-22), past the
  // PostgREST row cap, so page through them.
  const fetchSubmissions = async () => {
    const { rows, error } = await readAllPages(() => supabase
      .from('assessment_submissions')
      .select('*, assessment_templates(name), player:users!assessment_submissions_player_id_fkey(full_name), assessor:users!assessment_submissions_assessed_by_fkey(full_name)')
      .order('created_at', { ascending: false })
      .order('id'));
    if (error) console.error('assessment submissions fetch failed:', error);
    setSubmissions(rows);
  };

  const submissionsFor = (playerId, templateId) =>
    submissions.filter(x => x.player_id === playerId && x.template_id === templateId);

  const handleDeleteTemplate = async (id) => {
    if (!window.confirm('Delete this assessment template and all its submissions?')) return;
    const { error } = await supabase.from('assessment_templates').delete().eq('id', id);
    if (!error) { fetchTemplates(); fetchSubmissions(); }
  };

  const handleToggleStatus = async (template) => {
    const newStatus = template.status === 'active' ? 'hidden' : 'active';
    const { error } = await supabase.from('assessment_templates').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', template.id);
    if (!error) fetchTemplates();
  };

  const handleDeleteSubmission = async (id) => {
    if (!window.confirm('Delete this completed assessment?')) return;
    const { error } = await supabase.from('assessment_submissions').delete().eq('id', id);
    if (!error) fetchSubmissions();
  };

  if (loading) return <div className="text-gray-600">Loading assessments...</div>;

  return (
    <div className="space-y-4">
      <div className="flex space-x-2">
        <button onClick={() => setSubTab('templates')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${subTab === 'templates' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
          Assessment Templates ({templates.length})
        </button>
        <button onClick={() => setSubTab('completed')} className={`px-4 py-2 rounded-lg text-sm font-medium transition ${subTab === 'completed' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
          Completed Assessments ({submissions.length})
        </button>
      </div>

      {subTab === 'templates' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Assessment Templates</h3>
            <button onClick={() => { setEditingTemplate(null); setShowCreateTemplate(true); }} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
              <Plus size={18} /><span>Create Assessment</span>
            </button>
          </div>
          {templates.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <ClipboardList size={40} className="mx-auto mb-3 text-gray-300" />
              <p>No assessment templates yet. Create your first assessment to get started!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map(t => (
                <div key={t.id} className="bg-gray-50 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <span className="font-semibold text-gray-900">{t.name}</span>
                        {t.short_name && <span className="text-sm text-gray-500">({t.short_name})</span>}
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {t.status === 'active' ? 'Active' : 'Hidden'}
                        </span>
                        {t.show_to_athlete && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Visible to Athletes</span>}
                      </div>
                      <p className="text-sm text-gray-500 mt-1">{(t.schema || []).length} element{(t.schema || []).length !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      <button onClick={() => handleToggleStatus(t)} className="text-gray-400 hover:text-gray-600 transition" title={t.status === 'active' ? 'Hide' : 'Show'}>
                        {t.status === 'active' ? <Eye size={16} /> : <EyeOff size={16} />}
                      </button>
                      <button onClick={() => setShowFillModal(t)} className="text-gray-400 hover:text-green-600 transition" title="Fill Out">
                        <FileText size={16} />
                      </button>
                      <button onClick={() => { setEditingTemplate(t); setShowCreateTemplate(true); }} className="text-gray-400 hover:text-blue-600 transition" title="Edit">
                        <Edit2 size={16} />
                      </button>
                      <button onClick={() => handleDeleteTemplate(t.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === 'completed' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Completed Assessments</h3>
            {templates.filter(t => t.status === 'active').length > 0 && (
              <button onClick={() => setShowFillModal(templates.find(t => t.status === 'active'))} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
                <Plus size={18} /><span>New Assessment</span>
              </button>
            )}
          </div>
          {submissions.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText size={40} className="mx-auto mb-3 text-gray-300" />
              <p>No completed assessments yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {submissions.map(s => (
                <div key={s.id} className="bg-gray-50 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <span className="font-semibold text-gray-900">{s.player?.full_name || 'Unknown Player'}</span>
                        <span className="text-sm text-gray-500">—</span>
                        <span className="text-sm text-gray-700">{s.assessment_templates?.name || 'Unknown Template'}</span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        {s.assessment_date} &middot; Assessed by {s.assessor?.full_name || 'Unknown'}
                      </p>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      {(() => {
                        const template = templates.find(t => t.id === s.template_id);
                        const history = submissionsFor(s.player_id, s.template_id);
                        return (
                          <>
                            {template && (
                              <button onClick={() => setReassess({ template, playerId: s.player_id })} className="text-gray-400 hover:text-green-600 transition" title="Reassess (new blank form; this one is kept)">
                                <RotateCcw size={16} />
                              </button>
                            )}
                            {template && history.length >= 2 && (
                              <button onClick={() => setTrendsFor({ template, playerName: s.player?.full_name, submissions: history })} className="text-gray-400 hover:text-blue-600 transition" title={`Trends across ${history.length} assessments`}>
                                <TrendingUp size={16} />
                              </button>
                            )}
                          </>
                        );
                      })()}
                      <button onClick={() => setShowViewModal(s)} className="text-gray-400 hover:text-blue-600 transition" title="View">
                        <Eye size={16} />
                      </button>
                      <button onClick={() => setShowEditModal(s)} className="text-gray-400 hover:text-blue-600 transition" title="Edit this assessment (to record a new one, use Reassess)">
                        <Edit2 size={16} />
                      </button>
                      <button onClick={() => handleDeleteSubmission(s.id)} className="text-gray-400 hover:text-red-600 transition" title="Delete">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showCreateTemplate && (
        <CreateAssessmentTemplateModal
          editingTemplate={editingTemplate}
          onClose={() => { setShowCreateTemplate(false); setEditingTemplate(null); }}
          onSuccess={() => { setShowCreateTemplate(false); setEditingTemplate(null); fetchTemplates(); }}
        />
      )}

      {showFillModal && (
        <FillAssessmentModal
          template={showFillModal}
          templates={templates.filter(t => t.status === 'active')}
          players={players}
          userId={userId}
          onClose={() => setShowFillModal(null)}
          onSuccess={() => { setShowFillModal(null); fetchSubmissions(); }}
        />
      )}

      {reassess && (
        <FillAssessmentModal
          template={reassess.template}
          templates={[reassess.template]}
          players={players}
          userId={userId}
          initialPlayerId={reassess.playerId}
          onClose={() => setReassess(null)}
          onSuccess={() => { setReassess(null); fetchSubmissions(); }}
        />
      )}

      {trendsFor && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="border-b border-gray-200 p-6 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-xl font-bold text-gray-900">{trendsFor.template.name} trends</h3>
                <p className="text-sm text-gray-500">{trendsFor.playerName || 'Athlete'} · {trendsFor.submissions.length} assessments</p>
              </div>
              <button onClick={() => setTrendsFor(null)} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <AssessmentTrends schema={trendsFor.template.schema || []} submissions={trendsFor.submissions} />
            </div>
          </div>
        </div>
      )}

      {showViewModal && (
        <ViewAssessmentModal
          submission={showViewModal}
          onClose={() => setShowViewModal(null)}
        />
      )}

      {showEditModal && (
        <FillAssessmentModal
          template={templates.find(t => t.id === showEditModal.template_id) || null}
          templates={templates}
          players={players}
          userId={userId}
          editingSubmission={showEditModal}
          onClose={() => setShowEditModal(null)}
          onSuccess={() => { setShowEditModal(null); fetchSubmissions(); }}
        />
      )}
    </div>
  );
}

/* ============================================
   CREATE / EDIT ASSESSMENT TEMPLATE MODAL
   ============================================ */

const ELEMENT_TYPES = [
  { type: 'table', label: 'Table', icon: '⊞' },
  { type: 'text_field', label: 'Text Field', icon: '⊟' },
  { type: 'text_area', label: 'Text Area', icon: '☰' },
  { type: 'combo_box', label: 'ComboBox', icon: '▾' },
  { type: 'date', label: 'Date', icon: '◷' },
  { type: 'notes', label: 'Notes', icon: '✎' },
];

function CreateAssessmentTemplateModal({ editingTemplate, onClose, onSuccess }) {
  const [name, setName] = useState(editingTemplate?.name || '');
  const [shortName, setShortName] = useState(editingTemplate?.short_name || '');
  const [showToAthlete, setShowToAthlete] = useState(editingTemplate?.show_to_athlete ?? true);
  const [elements, setElements] = useState(() => {
    if (editingTemplate?.schema?.length > 0) return editingTemplate.schema;
    return [];
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addElement = (type) => {
    const id = 'el_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const base = { id, type, label: '', sort_order: elements.length };
    if (type === 'table') {
      base.columns = ['Column 1'];
      base.rows = ['Row 1'];
    }
    if (type === 'combo_box') {
      base.options = ['Option 1'];
    }
    setElements([...elements, base]);
  };

  const updateElement = (index, updates) => {
    setElements(elements.map((el, i) => i === index ? { ...el, ...updates } : el));
  };

  const removeElement = (index) => {
    setElements(elements.filter((_, i) => i !== index));
  };

  const moveElement = (index, direction) => {
    const newElements = [...elements];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newElements.length) return;
    [newElements[index], newElements[targetIndex]] = [newElements[targetIndex], newElements[index]];
    newElements.forEach((el, i) => el.sort_order = i);
    setElements(newElements);
  };

  const handleSave = async () => {
    trackAction('save_assessment_template');
    if (!name.trim()) { setError('Name is required'); return; }
    setLoading(true);
    setError('');

    const payload = {
      name: name.trim(),
      short_name: shortName.trim() || null,
      show_to_athlete: showToAthlete,
      schema: elements.map((el, i) => ({ ...el, sort_order: i })),
      updated_at: new Date().toISOString(),
    };

    let result;
    if (editingTemplate) {
      result = await supabase.from('assessment_templates').update(payload).eq('id', editingTemplate.id);
    } else {
      result = await supabase.from('assessment_templates').insert({ ...payload, status: 'active' });
    }

    if (result.error) {
      setError(result.error.message);
      setLoading(false);
    } else {
      onSuccess();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">{editingTemplate ? 'Edit Assessment Template' : 'Create Assessment Template'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar - element type buttons */}
          <div className="w-48 border-r border-gray-200 p-4 space-y-2 shrink-0 bg-gray-50">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Add Element</p>
            {ELEMENT_TYPES.map(et => (
              <button key={et.type} onClick={() => addElement(et.type)}
                className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition flex items-center space-x-2">
                <span>{et.icon}</span><span>{et.label}</span>
              </button>
            ))}
          </div>
          {/* Right side - form */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {error && <div className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">{error}</div>}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hitting Assessment"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Short Name</label>
                <input type="text" value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="e.g. Hit Assess"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <input type="checkbox" id="showToAthlete" checked={showToAthlete} onChange={(e) => setShowToAthlete(e.target.checked)} className="rounded" />
              <label htmlFor="showToAthlete" className="text-sm text-gray-700">Show to Athlete</label>
            </div>

            {/* Elements list */}
            <div className="space-y-3">
              <p className="text-sm font-semibold text-gray-700">{elements.length === 0 ? 'No elements added yet — click an element type on the left to get started.' : `${elements.length} Element${elements.length !== 1 ? 's' : ''}`}</p>
              {elements.map((el, i) => (
                <div key={el.id} className="border border-gray-200 rounded-lg p-4 bg-white space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-medium text-gray-400 uppercase bg-gray-100 px-2 py-0.5 rounded">{ELEMENT_TYPES.find(et => et.type === el.type)?.label || el.type}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <button onClick={() => moveElement(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-600 disabled:opacity-30 p-1"><ChevronUp size={16} /></button>
                      <button onClick={() => moveElement(i, 1)} disabled={i === elements.length - 1} className="text-gray-400 hover:text-gray-600 disabled:opacity-30 p-1"><ChevronDown size={16} /></button>
                      <button onClick={() => removeElement(i)} className="text-gray-400 hover:text-red-600 p-1"><Trash2 size={16} /></button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Label</label>
                    <input type="text" value={el.label} onChange={(e) => updateElement(i, { label: e.target.value })} placeholder="Element label"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>

                  {/* Scalar fields can be tagged with a canonical metric so program generators auto-fill from this value */}
                  {(el.type === 'text_field' || el.type === 'combo_box') && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        Maps to metric <span className="text-gray-400 font-normal">(optional — lets S&amp;C / throwing / hitting / nutrition generators auto-fill from this field)</span>
                      </label>
                      <select value={el.metric_key || ''} onChange={(e) => updateElement(i, { metric_key: e.target.value || undefined })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">— none —</option>
                        {metricsByGroup().map(g => (
                          <optgroup key={g.group} label={g.group}>
                            {g.items.map(m => (
                              <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ''}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Table-specific: columns and rows */}
                  {el.type === 'table' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Columns</label>
                        {(el.columns || []).map((col, ci) => (
                          <div key={ci} className="flex items-center space-x-1 mb-1">
                            <input type="text" value={col} onChange={(e) => {
                              const newCols = [...el.columns]; newCols[ci] = e.target.value; updateElement(i, { columns: newCols });
                            }} className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <button onClick={() => updateElement(i, { columns: el.columns.filter((_, j) => j !== ci) })} className="text-gray-400 hover:text-red-500"><X size={14} /></button>
                          </div>
                        ))}
                        <button onClick={() => updateElement(i, { columns: [...(el.columns || []), `Column ${(el.columns || []).length + 1}`] })}
                          className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ Add Column</button>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Rows</label>
                        {(el.rows || []).map((row, ri) => (
                          <div key={ri} className="flex items-center space-x-1 mb-1">
                            <input type="text" value={row} onChange={(e) => {
                              const newRows = [...el.rows]; newRows[ri] = e.target.value; updateElement(i, { rows: newRows });
                            }} className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <button onClick={() => updateElement(i, { rows: el.rows.filter((_, j) => j !== ri) })} className="text-gray-400 hover:text-red-500"><X size={14} /></button>
                          </div>
                        ))}
                        <button onClick={() => updateElement(i, { rows: [...(el.rows || []), `Row ${(el.rows || []).length + 1}`] })}
                          className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ Add Row</button>
                      </div>
                    </div>
                  )}

                  {/* ComboBox-specific: options */}
                  {el.type === 'combo_box' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Options</label>
                      {(el.options || []).map((opt, oi) => (
                        <div key={oi} className="flex items-center space-x-1 mb-1">
                          <input type="text" value={opt} onChange={(e) => {
                            const newOpts = [...el.options]; newOpts[oi] = e.target.value; updateElement(i, { options: newOpts });
                          }} className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => updateElement(i, { options: el.options.filter((_, j) => j !== oi) })} className="text-gray-400 hover:text-red-500"><X size={14} /></button>
                        </div>
                      ))}
                      <button onClick={() => updateElement(i, { options: [...(el.options || []), `Option ${(el.options || []).length + 1}`] })}
                        className="text-xs text-blue-600 hover:text-blue-800 mt-1">+ Add Option</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="border-t border-gray-200 p-6 flex space-x-3 shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="flex-1 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50">
            {loading ? 'Saving...' : editingTemplate ? 'Update Template' : 'Create Template'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================
   FILL ASSESSMENT MODAL
   ============================================ */

function FillAssessmentModal({ template, templates, players, userId, editingSubmission, initialPlayerId, onClose, onSuccess }) {
  useModalTracking('FillAssessmentModal');
  const [selectedTemplate, setSelectedTemplate] = useState(
    editingSubmission ? (templates.find(t => t.id === editingSubmission.template_id) || template) : template
  );
  const [playerId, setPlayerId] = useState(editingSubmission?.player_id || initialPlayerId || '');
  const [assessmentDate, setAssessmentDate] = useState(editingSubmission?.assessment_date || fmtLocalDate(new Date()));
  const [responses, setResponses] = useState(editingSubmission?.responses || {});
  const [notes, setNotes] = useState(editingSubmission?.notes || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');

  const schema = selectedTemplate?.schema || [];

  const filteredPlayers = players.filter(p =>
    p.full_name?.toLowerCase().includes(playerSearch.toLowerCase())
  );

  const updateResponse = (elementId, value) => {
    setResponses({ ...responses, [elementId]: value });
  };

  const updateTableCell = (elementId, row, col, value) => {
    const tableData = responses[elementId] || {};
    const rowData = tableData[row] || {};
    setResponses({
      ...responses,
      [elementId]: { ...tableData, [row]: { ...rowData, [col]: value } }
    });
  };

  const handleSave = async () => {
    trackAction(editingSubmission ? 'edit_assessment' : 'submit_assessment');
    if (!playerId) { setError('Please select a player'); return; }
    setLoading(true);
    setError('');

    const payload = {
      template_id: selectedTemplate.id,
      player_id: playerId,
      assessment_date: assessmentDate,
      responses,
      notes: notes.trim() || null,
    };
    const { error: saveError } = editingSubmission
      ? await supabase.from('assessment_submissions').update(payload).eq('id', editingSubmission.id)
      : await supabase.from('assessment_submissions').insert({ ...payload, assessed_by: userId });

    if (saveError) {
      setError(saveError.message);
      setLoading(false);
    } else {
      onSuccess();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between shrink-0">
          <h3 className="text-xl font-bold text-gray-900">{editingSubmission ? 'Edit Assessment' : initialPlayerId ? 'Reassess' : 'Fill Out Assessment'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && <div className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">{error}</div>}
          {editingSubmission && (
            <div className="bg-amber-50 text-amber-800 px-4 py-2 rounded-lg text-sm">
              This corrects the {editingSubmission.assessment_date} assessment. To record a new one, close this and use Reassess so the earlier numbers are kept for trends.
            </div>
          )}

          {/* Template selector */}
          {templates.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Assessment Template</label>
              <select value={selectedTemplate?.id || ''} onChange={(e) => { setSelectedTemplate(templates.find(t => t.id === e.target.value)); setResponses({}); }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Player *</label>
              <input type="text" value={playerSearch} onChange={(e) => setPlayerSearch(e.target.value)} placeholder="Search players..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-1" />
              <select value={playerId} onChange={(e) => setPlayerId(e.target.value)} size={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">-- Select Player --</option>
                {filteredPlayers.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Assessment Date</label>
              <input type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          {/* Render schema elements */}
          {[...schema].sort((a, b) => a.sort_order - b.sort_order).map(el => (
            <div key={el.id} className="space-y-1">
              <label className="block text-sm font-semibold text-gray-800">{el.label || el.type}</label>

              {el.type === 'text_field' && (
                <input type="text" value={responses[el.id] || ''} onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}

              {(el.type === 'text_area' || el.type === 'notes') && (
                <textarea value={responses[el.id] || ''} onChange={(e) => updateResponse(el.id, e.target.value)} rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}

              {el.type === 'combo_box' && (
                <select value={responses[el.id] || ''} onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">-- Select --</option>
                  {(el.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              )}

              {el.type === 'date' && (
                <input type="date" value={responses[el.id] || ''} onChange={(e) => updateResponse(el.id, e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}

              {el.type === 'table' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-300">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border border-gray-300 px-3 py-2 text-left text-xs font-medium text-gray-600"></th>
                        {(el.columns || []).map(col => (
                          <th key={col} className="border border-gray-300 px-3 py-2 text-left text-xs font-medium text-gray-600">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(el.rows || []).map(row => (
                        <tr key={row}>
                          <td className="border border-gray-300 px-3 py-2 font-medium text-gray-700 bg-gray-50">{row}</td>
                          {(el.columns || []).map(col => (
                            <td key={col} className="border border-gray-300 px-1 py-1">
                              <input type="text" value={(responses[el.id]?.[row]?.[col]) || ''} onChange={(e) => updateTableCell(el.id, row, col, e.target.value)}
                                className="w-full px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 rounded" />
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

          {/* General notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Any additional notes..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="border-t border-gray-200 p-6 flex space-x-3 shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Cancel</button>
          <button onClick={handleSave} disabled={loading} className="flex-1 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-50">
            {loading ? 'Saving...' : 'Save Assessment'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================
   VIEW ASSESSMENT MODAL (Read-only)
   ============================================ */

function ViewAssessmentModal({ submission, onClose }) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTemplate = async () => {
      if (submission.template_id) {
        const { data } = await supabase.from('assessment_templates').select('*').eq('id', submission.template_id).single();
        if (data) setTemplate(data);
      }
      setLoading(false);
    };
    fetchTemplate();
  }, [submission.template_id]);

  const schema = template?.schema || [];
  const responses = submission.responses || {};

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-xl font-bold text-gray-900">{template?.name || 'Assessment'}</h3>
            <p className="text-sm text-gray-500 mt-1">
              {submission.player?.full_name || 'Unknown Player'} &middot; {submission.assessment_date} &middot; Assessed by {submission.assessor?.full_name || 'Unknown'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loading ? (
            <div className="text-gray-600">Loading...</div>
          ) : (
            <>
              {[...schema].sort((a, b) => a.sort_order - b.sort_order).map(el => (
                <div key={el.id} className="space-y-1">
                  <label className="block text-sm font-semibold text-gray-800">{el.label || el.type}</label>

                  {(el.type === 'text_field' || el.type === 'text_area' || el.type === 'notes') && (
                    <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">{responses[el.id] || <span className="text-gray-400 italic">No response</span>}</p>
                  )}

                  {el.type === 'combo_box' && (
                    <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">{responses[el.id] || <span className="text-gray-400 italic">No selection</span>}</p>
                  )}

                  {el.type === 'date' && (
                    <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">{responses[el.id] || <span className="text-gray-400 italic">No date</span>}</p>
                  )}

                  {el.type === 'table' && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border border-gray-300">
                        <thead>
                          <tr className="bg-gray-100">
                            <th className="border border-gray-300 px-3 py-2 text-left text-xs font-medium text-gray-600"></th>
                            {(el.columns || []).map(col => (
                              <th key={col} className="border border-gray-300 px-3 py-2 text-left text-xs font-medium text-gray-600">{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(el.rows || []).map(row => (
                            <tr key={row}>
                              <td className="border border-gray-300 px-3 py-2 font-medium text-gray-700 bg-gray-50">{row}</td>
                              {(el.columns || []).map(col => (
                                <td key={col} className="border border-gray-300 px-3 py-2 text-gray-700">
                                  {responses[el.id]?.[row]?.[col] || '—'}
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

              {submission.notes && (
                <div>
                  <label className="block text-sm font-semibold text-gray-800">Additional Notes</label>
                  <p className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg">{submission.notes}</p>
                </div>
              )}
            </>
          )}
        </div>
        <div className="border-t border-gray-200 p-6 shrink-0">
          <button onClick={onClose} className="w-full border border-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-50 transition">Close</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================
   MY TASKS TAB (Coach view)
   ============================================ */

function MyTasksTab({ userId }) {
  const [tasks, setTasks] = useState([]);
  const [filterStatus, setFilterStatus] = useState('active');
  const [loading, setLoading] = useState(true);

  const fetchTasks = async () => {
    const { data, error } = await supabase
      .from('coach_tasks')
      .select('*, assigner:assigned_by(full_name)')
      .eq('assigned_to', userId)
      .order('created_at', { ascending: false });
    if (error) console.error('Error fetching tasks:', error);
    else setTasks(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchTasks(); }, []);

  const updateStatus = async (taskId, newStatus) => {
    const updates = { status: newStatus, updated_at: new Date().toISOString() };
    if (newStatus === 'completed') updates.completed_at = new Date().toISOString();
    else updates.completed_at = null;
    const { error } = await supabase.from('coach_tasks').update(updates).eq('id', taskId);
    if (error) alert('Error updating task: ' + formatUserError(error));
    else fetchTasks();
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const isOverdue = (task) => task.due_date && task.due_date < todayStr && task.status !== 'completed';

  const filtered = tasks.filter(t => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'active') return t.status !== 'completed';
    return t.status === filterStatus;
  });

  const priorityColors = { low: 'bg-gray-100 text-gray-700', medium: 'bg-blue-100 text-blue-700', high: 'bg-orange-100 text-orange-700', urgent: 'bg-red-100 text-red-700' };
  const statusColors = { pending: 'bg-yellow-100 text-yellow-700', in_progress: 'bg-blue-100 text-blue-700', completed: 'bg-green-100 text-green-700' };
  const frequencyColors = { daily: 'bg-purple-100 text-purple-700', weekly: 'bg-indigo-100 text-indigo-700', monthly: 'bg-teal-100 text-teal-700', 'one-time': 'bg-gray-100 text-gray-700' };
  const statusLabels = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };

  if (loading) return <p className="text-gray-600 py-8 text-center">Loading tasks...</p>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">My Tasks</h3>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="active">Active</option>
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No tasks assigned yet.</p>
      ) : (
        <div className="grid gap-3">
          {filtered.map(task => (
            <div key={task.id} className={`border rounded-lg p-4 ${isOverdue(task) ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-semibold text-gray-900">{task.title}</h4>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[task.status]}`}>{statusLabels[task.status]}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityColors[task.priority]}`}>{task.priority}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${frequencyColors[task.frequency]}`}>{task.frequency}</span>
                    {isOverdue(task) && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Overdue</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                    {task.assigner?.full_name && <span>Assigned by: {task.assigner.full_name}</span>}
                    {task.due_date && <span className="flex items-center gap-1"><Calendar size={14} /> Due: {task.due_date}</span>}
                  </div>
                  {task.description && <p className="text-sm text-gray-600 mt-1">{task.description}</p>}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  {task.status === 'pending' && (
                    <button onClick={() => updateStatus(task.id, 'in_progress')} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Start</button>
                  )}
                  {task.status === 'in_progress' && (
                    <button onClick={() => updateStatus(task.id, 'completed')} className="px-3 py-1 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">Complete</button>
                  )}
                  {task.status === 'completed' && (
                    <button onClick={() => updateStatus(task.id, 'pending')} className="px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">Reopen</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// #421: Player Stats — staff roster of athlete-uploaded external stats
// (GameChanger / Perfect Game / MaxPreps / PBR / other). Athletes add
// entries on their own profile's Stats tab (ExternalStatsTab); this view
// lists every athlete's uploads, newest first, with search and a source
// filter, and jumps to the athlete's profile to manage them.
// =====================================================================
function PlayerStatsTab({ players, onNavigateToProfile }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('all');
  const [showMissing, setShowMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('external_stats')
        .select('*, player:player_id(id, full_name, email)')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) console.error('Error loading external stats:', error);
      setRows(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const openFile = async (row) => {
    const { data, error } = await supabase.storage.from(EXTERNAL_STATS_BUCKET).createSignedUrl(row.file_url, 600);
    if (error || !data) { alert('Could not open that file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (source !== 'all' && r.source !== source) return false;
    if (!q) return true;
    const hay = [r.player?.full_name, r.player?.email, r.title, r.season, r.notes, sourceName(r)].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  // Group by athlete, keeping the newest-first order of first appearance.
  const groups = [];
  const byPlayer = new Map();
  for (const r of filtered) {
    const pid = r.player_id;
    if (!byPlayer.has(pid)) {
      const g = { player: r.player || { id: pid, full_name: 'Unknown athlete' }, items: [] };
      byPlayer.set(pid, g);
      groups.push(g);
    }
    byPlayer.get(pid).items.push(r);
  }

  const withStats = new Set(rows.map(r => r.player_id));
  const missing = (players || []).filter(p => !withStats.has(p.id) && (!q || (p.full_name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)));

  const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">External Stats</h3>
        <p className="text-sm text-gray-600 mt-0.5">
          Profile links and stat exports athletes have shared from GameChanger, Perfect Game, MaxPreps, PBR and elsewhere.
          Athletes add these on their own profile under <span className="font-medium">Stats</span>; you can add or edit on any athlete's profile too.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search athlete, title, season..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[{ value: 'all', label: 'All sources' }, ...EXTERNAL_STAT_SOURCES].map(s => (
            <button
              key={s.value}
              onClick={() => setSource(s.value)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${source === s.value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span><span className="font-semibold text-gray-900">{withStats.size}</span> athlete{withStats.size === 1 ? '' : 's'} with stats</span>
        <span><span className="font-semibold text-gray-900">{rows.length}</span> upload{rows.length === 1 ? '' : 's'}</span>
        <button onClick={() => setShowMissing(v => !v)} className="text-blue-600 hover:underline">
          {showMissing ? 'Hide' : 'Show'} {missing.length} athlete{missing.length === 1 ? '' : 's'} without stats
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : groups.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <FileText size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">{rows.length === 0 ? 'No athlete has uploaded external stats yet.' : 'Nothing matches that search.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.player.id} className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => onNavigateToProfile && onNavigateToProfile(g.player.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition text-left"
              >
                <div className="flex items-center space-x-2 min-w-0">
                  <User size={16} className="text-gray-400 flex-shrink-0" />
                  <span className="font-medium text-gray-900 truncate">{g.player.full_name}</span>
                  <span className="text-xs text-gray-500">{g.items.length} upload{g.items.length === 1 ? '' : 's'}</span>
                </div>
                <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />
              </button>
              <div className="divide-y divide-gray-100">
                {g.items.map(r => {
                  const info = sourceInfo(r.source);
                  return (
                    <div key={r.id} className="px-4 py-3 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${info.color}`}>{sourceName(r)}</span>
                          {r.season && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{r.season}</span>}
                          <span className="text-xs text-gray-400">{fmt(r.created_at)}</span>
                        </div>
                        {r.title && <p className="text-sm text-gray-900 mt-1">{r.title}</p>}
                        {r.notes && <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{r.notes}</p>}
                      </div>
                      <div className="flex flex-wrap gap-2 flex-shrink-0">
                        {r.profile_url && (
                          <a href={r.profile_url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50">
                            <ExternalLink size={13} /><span>Open profile</span>
                          </a>
                        )}
                        {r.file_url && (
                          <button onClick={() => openFile(r)} title={r.file_name || 'Download'}
                            className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50">
                            <FileText size={13} /><span className="truncate max-w-[180px]">{r.file_name || 'File'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {showMissing && (
        <div className="border border-gray-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-900 mb-2">Athletes without external stats</h4>
          {missing.length === 0 ? (
            <p className="text-sm text-gray-500">Everyone has shared something.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {missing.map(p => (
                <button key={p.id} onClick={() => onNavigateToProfile && onNavigateToProfile(p.id)}
                  className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 text-xs hover:bg-gray-200 transition">
                  {p.full_name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================
   WHOOP TAB (#467) — who has linked WHOOP and who hasn't
   ============================================ */
// A connection whose newest WHOOP cycle is older than this reads as stale:
// still linked, but the band hasn't sent data (not worn, dead, or revoked).
const WHOOP_STALE_DAYS = 3;

function WhoopConnectionsTab({ players, onNavigateToProfile }) {
  const [status, setStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [show, setShow] = useState('not_connected');
  const [nbpPlusOnly, setNbpPlusOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // whoop_tokens holds encrypted OAuth tokens and is not client-readable;
      // the staff-gated RPC returns connection status only.
      const { data, error } = await supabase.rpc('whoop_connection_status');
      if (cancelled) return;
      if (error) console.error('Error loading WHOOP connections:', error);
      setStatus(Object.fromEntries((data || []).map(r => [r.user_id, r])));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const todayStr = new Date().toISOString().slice(0, 10);
  const daysSince = (dateStr) => Math.round((new Date(todayStr + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
  const stateOf = (s) => {
    if (!s) return 'not_connected';
    if (s.last_sync_error || !s.last_cycle_date || daysSince(s.last_cycle_date) > WHOOP_STALE_DAYS) return 'stale';
    return 'connected';
  };

  const isNbpPlus = (p) => (p.team_members || []).some(tm => tm.teams?.team_type === 'training');
  const teamNames = Array.from(new Set((players || []).flatMap(p => (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean)))).sort();

  const scoped = (players || []).filter(p => {
    if (nbpPlusOnly && !isNbpPlus(p)) return false;
    if (teamFilter !== 'all' && !(p.team_members || []).some(tm => tm.teams?.name === teamFilter)) return false;
    return true;
  });
  const counts = { connected: 0, stale: 0, not_connected: 0 };
  scoped.forEach(p => { counts[stateOf(status[p.id])] += 1; });

  const q = search.trim().toLowerCase();
  const list = scoped.map(p => ({ player: p, s: status[p.id] || null, state: stateOf(status[p.id]), teams: (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean) }))
    .filter(item => {
      if (show === 'connected' && item.state === 'not_connected') return false;
      if (show === 'not_connected' && item.state !== 'not_connected') return false;
      if (show === 'stale' && item.state !== 'stale') return false;
      if (!q) return true;
      return (item.player.full_name || '').toLowerCase().includes(q) || (item.player.email || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (a.player.full_name || '').localeCompare(b.player.full_name || ''));

  const fmt = (v) => new Date(v.length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const STATE_CHIP = {
    connected: { cls: 'bg-green-50 text-green-700', icon: Check, label: 'Connected' },
    stale: { cls: 'bg-amber-50 text-amber-700', icon: AlertTriangle, label: 'No recent data' },
    not_connected: { cls: 'bg-gray-100 text-gray-600', icon: XCircle, label: 'Not connected' },
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">WHOOP Connections</h3>
        <p className="text-sm text-gray-600 mt-0.5">
          Which athletes have linked a WHOOP. Athletes connect theirs from the <span className="font-medium">WHOOP</span> tab on their profile.
          "No recent data" = linked, but nothing synced in the last {WHOOP_STALE_DAYS} days or the last sync failed.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search athlete..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All teams</option>
          {teamNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select
          value={show}
          onChange={(e) => setShow(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="not_connected">Not connected</option>
          <option value="connected">Connected</option>
          <option value="stale">No recent data</option>
          <option value="all">Everyone</option>
        </select>
        <label className="inline-flex items-center space-x-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={nbpPlusOnly} onChange={(e) => setNbpPlusOnly(e.target.checked)} className="rounded" />
          <span>NBP+ only</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span><span className="font-semibold text-gray-900">{counts.connected + counts.stale}</span> of {scoped.length} connected</span>
        {counts.stale > 0 && <span><span className="font-semibold text-amber-700">{counts.stale}</span> with no recent data</span>}
        <span><span className="font-semibold text-gray-900">{counts.not_connected}</span> not connected</span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : list.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <Activity size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No athletes match.</p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="hidden md:grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-2 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>Athlete</span><span>Status</span><span>Connected</span><span>Latest data</span>
          </div>
          <div className="divide-y divide-gray-100">
            {list.map(({ player, s, state, teams }) => {
              const chip = STATE_CHIP[state];
              const ChipIcon = chip.icon;
              return (
                <div key={player.id} className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr_1fr] gap-2 px-4 py-3 items-center">
                  <button
                    onClick={() => onNavigateToProfile && onNavigateToProfile(player.id)}
                    className="flex items-center space-x-2 min-w-0 text-left hover:text-blue-600"
                  >
                    <User size={16} className="text-gray-400 flex-shrink-0" />
                    <span className="font-medium text-gray-900 truncate">{player.full_name}</span>
                    {teams.length > 0 && <span className="text-xs text-gray-400 truncate hidden lg:inline">{teams.join(', ')}</span>}
                  </button>
                  <div>
                    <span className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium ${chip.cls}`} title={s?.last_sync_error || undefined}>
                      <ChipIcon size={12} /><span>{chip.label}</span>
                    </span>
                  </div>
                  <span className="text-sm text-gray-600"><span className="md:hidden text-xs text-gray-500 mr-1">Connected</span>{s ? fmt(s.connected_at) : '—'}</span>
                  <span className="text-sm text-gray-600"><span className="md:hidden text-xs text-gray-500 mr-1">Latest data</span>{s?.last_cycle_date ? fmt(s.last_cycle_date) : '—'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// #447: Coach Tools → Registrations. Every athlete with their Perfect Game and
// Top Tier status side by side, so a coach can clear the gaps before a
// tournament instead of finding out at the gate. Reads player_registrations
// (staff see all rows) and joins it to the roster the parent already loaded.
function RegistrationsTab({ players, onNavigateToProfile }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [onlyMissing, setOnlyMissing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // #437: 2 rows per athlete at most, but page anyway so the roster can grow.
      const { rows: data, error } = await readAllPages(() => supabase
        .from('player_registrations')
        .select('id, player_id, site, profile_url, file_url, file_name, notes, updated_at')
        .order('player_id')
        .order('id'));
      if (cancelled) return;
      if (error) console.error('Error loading registrations:', error);
      setRows(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const openFile = async (row) => {
    const { data, error } = await supabase.storage.from(REGISTRATIONS_BUCKET).createSignedUrl(row.file_url, 600);
    if (error || !data) { alert('Could not open that file.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  // player_id → { site → row }
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, {});
    byPlayer.get(r.player_id)[r.site] = r;
  }

  const teamNames = Array.from(new Set((players || []).flatMap(p => (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean)))).sort();

  const q = search.trim().toLowerCase();
  const list = (players || []).map(p => {
    const regs = byPlayer.get(p.id) || {};
    const status = {};
    REGISTRATION_SITES.forEach(s => { status[s.value] = hasRegistrationProof(regs[s.value]) ? regs[s.value] : null; });
    const missingCount = REGISTRATION_SITES.filter(s => !status[s.value]).length;
    return { player: p, status, missingCount, teams: (p.team_members || []).map(tm => tm.teams?.name).filter(Boolean) };
  }).filter(item => {
    if (onlyMissing && item.missingCount === 0) return false;
    if (teamFilter !== 'all' && !item.teams.includes(teamFilter)) return false;
    if (!q) return true;
    return (item.player.full_name || '').toLowerCase().includes(q) || (item.player.email || '').toLowerCase().includes(q);
  }).sort((a, b) => b.missingCount - a.missingCount || (a.player.full_name || '').localeCompare(b.player.full_name || ''));

  const total = (players || []).length;
  const complete = (players || []).filter(p => {
    const regs = byPlayer.get(p.id) || {};
    return REGISTRATION_SITES.every(s => hasRegistrationProof(regs[s.value]));
  }).length;

  const fmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Tournament Registrations</h3>
        <p className="text-sm text-gray-600 mt-0.5">
          Perfect Game and Top Tier registration proof per athlete. Athletes add theirs under
          <span className="font-medium"> Records → Registration</span> on their profile; you can add or fix any athlete's from their profile too.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search athlete..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All teams</option>
          {teamNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <label className="inline-flex items-center space-x-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} className="rounded" />
          <span>Only missing</span>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span><span className="font-semibold text-gray-900">{complete}</span> of {total} athletes fully registered</span>
        <span><span className="font-semibold text-gray-900">{total - complete}</span> missing at least one</span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : list.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <FileText size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">{onlyMissing ? 'Nobody matching is missing a registration.' : 'No athletes match that search.'}</p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="hidden md:grid grid-cols-[1fr_1fr_1fr] gap-2 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>Athlete</span>
            {REGISTRATION_SITES.map(s => <span key={s.value}>{s.label}</span>)}
          </div>
          <div className="divide-y divide-gray-100">
            {list.map(({ player, status, teams }) => (
              <div key={player.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr] gap-2 px-4 py-3 items-center">
                <button
                  onClick={() => onNavigateToProfile && onNavigateToProfile(player.id)}
                  className="flex items-center space-x-2 min-w-0 text-left hover:text-blue-600"
                >
                  <User size={16} className="text-gray-400 flex-shrink-0" />
                  <span className="font-medium text-gray-900 truncate">{player.full_name}</span>
                  {teams.length > 0 && <span className="text-xs text-gray-400 truncate hidden lg:inline">{teams.join(', ')}</span>}
                </button>
                {REGISTRATION_SITES.map(s => {
                  const r = status[s.value];
                  return (
                    <div key={s.value} className="flex items-center flex-wrap gap-1.5">
                      <span className="md:hidden text-xs text-gray-500 w-20">{s.label}</span>
                      {r ? (
                        <>
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                            <Check size={12} /><span>{fmt(r.updated_at)}</span>
                          </span>
                          {r.profile_url && (
                            <a href={r.profile_url} target="_blank" rel="noopener noreferrer" title="Open profile"
                              className="p-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"><ExternalLink size={13} /></a>
                          )}
                          {r.file_url && (
                            <button onClick={() => openFile(r)} title={r.file_name || 'Open file'}
                              className="p-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"><FileText size={13} /></button>
                          )}
                        </>
                      ) : (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                          <XCircle size={12} /><span>Missing</span>
                        </span>
                      )}
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
