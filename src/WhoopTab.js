import React, { useState, useEffect, useCallback } from 'react';
import { supabase, supabaseUrl } from './supabaseClient';
import { Activity, RefreshCw, Link2, Unlink } from 'lucide-react';
import { BAND_CLASS, BAND_HEX, BAND_LEGEND, BASELINE_DAYS, cycleBands, sleepBands, bandWorkoutStrain, bandAsleep } from './whoopBands';
import { fmtLocalDate } from './scheduleUtils';
import WhoopCommunityCodeCard from './WhoopCommunityCode';

// ---- Readiness algorithm ----

// Static time-in-bed scoring (linear interpolation between breakpoints)
function timeInBedScore(ms) {
  if (ms == null) return null;
  const hours = ms / 3_600_000;
  const breakpoints = [
    [5, 0.10],
    [6, 0.40],
    [7, 0.60],
    [8, 0.80],
    [9, 0.92],
    [10, 1.00],
  ];
  if (hours < 5) return 0.10;
  if (hours >= 10) return 1.00;
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [h1, s1] = breakpoints[i];
    const [h2, s2] = breakpoints[i + 1];
    if (hours >= h1 && hours < h2) {
      const t = (hours - h1) / (h2 - h1);
      return s1 + t * (s2 - s1);
    }
  }
  return 1.00;
}

const READINESS_METRICS = [
  { key: 'time_in_bed', weight: 2.0, extract: (_, s) => s?.total_duration_ms ?? null, static: true },
  { key: 'sleep_consistency', weight: 1.75, extract: (_, s) => s?.sleep_consistency ?? null },
  { key: 'time_asleep', weight: 1.5, extract: (_, s) => (s?.total_duration_ms != null && s?.awake_duration_ms != null) ? s.total_duration_ms - s.awake_duration_ms : null },
  { key: 'sleep_efficiency', weight: 1.25, extract: (_, s) => s?.sleep_efficiency ?? null },
  { key: 'deep_sleep', weight: 1.0, extract: (_, s) => s?.sws_duration_ms ?? null },
  { key: 'rem_sleep', weight: 0.75, extract: (_, s) => s?.rem_duration_ms ?? null },
  { key: 'light_sleep', weight: 0.5, extract: (_, s) => s?.light_duration_ms ?? null },
  { key: 'hrv', weight: 0.5, extract: (c, _) => c?.hrv_rmssd ?? null },
];

function computeReadiness(todayCycle, todaySleep, allCycles, allSleep) {
  if (!todayCycle && !todaySleep) return null;
  if (allCycles.length < 3 && allSleep.length < 3) return null;

  const sleepByDate = new Map(allSleep.map(s => [s.sleep_date, s]));
  const cycleByDate = new Map(allCycles.map(c => [c.cycle_date, c]));

  const allDates = new Set();
  allCycles.forEach(c => allDates.add(c.cycle_date));
  allSleep.forEach(s => allDates.add(s.sleep_date));

  let weightedSum = 0;
  let weightSum = 0;

  for (const metric of READINESS_METRICS) {
    const todayVal = metric.extract(todayCycle, todaySleep);
    if (todayVal === null) continue;

    let percentile;
    if (metric.static && metric.key === 'time_in_bed') {
      // Use static scoring table instead of percentile rank
      percentile = timeInBedScore(todayVal);
    } else {
      const historical = [];
      for (const date of allDates) {
        const c = cycleByDate.get(date) ?? null;
        const s = sleepByDate.get(date) ?? null;
        const v = metric.extract(c, s);
        if (v !== null) historical.push(v);
      }
      if (historical.length === 0) continue;

      historical.sort((a, b) => a - b);
      const countBelow = historical.filter(v => v <= todayVal).length;
      percentile = countBelow / historical.length;
    }

    weightedSum += percentile * metric.weight;
    weightSum += metric.weight;
  }

  if (weightSum === 0) return null;
  const raw = (weightedSum / weightSum) * 100;
  return Math.round(Math.max(1, Math.min(100, raw)));
}

function readinessState(score) {
  if (score === null) return null;
  if (score >= 67) return 'green';
  if (score >= 34) return 'yellow';
  return 'red';
}

// ---- Circular Gauge ----

function CircularGauge({ value, max, color, label, display, size = 90 }) {
  const strokeW = 6;
  const radius = (size - strokeW) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value !== null ? Math.min(value / max, 1) : 0;
  const offset = circumference * (1 - pct);

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90 absolute inset-0">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e5e7eb" strokeWidth={strokeW} />
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={value !== null ? color : '#d1d5db'}
            strokeWidth={strokeW} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            className="transition-all duration-700 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold text-gray-900 leading-none">{display}</span>
        </div>
      </div>
      <span className="text-[10px] text-gray-500 mt-1">{label}</span>
    </div>
  );
}

// ---- Stat Pill ----

function StatPill({ label, value, unit, band = null }) {
  return (
    <div className={`${band ? BAND_CLASS[band] : 'bg-gray-50'} rounded-lg px-3 py-2 text-center min-w-[70px]`}>
      <div className="text-sm font-semibold text-gray-900">
        {value}
        {unit && <span className="text-[10px] text-gray-400 ml-0.5">{unit}</span>}
      </div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

// ---- Sleep Stage Bar ----

function SleepStageBar({ sleep }) {
  const totalMs = sleep.total_duration_ms || 0;
  if (totalMs === 0) return null;

  const stages = [
    { label: 'REM', ms: sleep.rem_duration_ms || 0, color: 'bg-cyan-500' },
    { label: 'Deep', ms: sleep.sws_duration_ms || 0, color: 'bg-cyan-700' },
    { label: 'Light', ms: sleep.light_duration_ms || 0, color: 'bg-cyan-300' },
    { label: 'Awake', ms: sleep.awake_duration_ms || 0, color: 'bg-gray-300' },
  ];

  const msToHours = (ms) => {
    const hours = ms / 3_600_000;
    if (hours < 1) return `${Math.round(ms / 60_000)}m`;
    return `${hours.toFixed(1)}h`;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-gray-500">Sleep Stages</h4>
        <span className="text-[10px] text-gray-400">{msToHours(totalMs)} total</span>
      </div>
      <div className="flex rounded-full overflow-hidden h-3 mb-2">
        {stages.map(s => {
          const pct = (s.ms / totalMs) * 100;
          if (pct < 1) return null;
          return <div key={s.label} className={`${s.color}`} style={{ width: `${pct}%` }} />;
        })}
      </div>
      <div className="flex gap-3 justify-center flex-wrap">
        {stages.map(s => (
          <div key={s.label} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${s.color}`} />
            <span className="text-[10px] text-gray-500">{s.label} {msToHours(s.ms)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Metric Trend (simple SVG chart) ----

function MetricTrend({ data, color, title, unit = '', chartType = 'line', referenceLines = [], height = 140 }) {
  const values = data.map(d => d.value).filter(v => v !== null);
  if (values.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h4 className="text-xs font-medium text-gray-500 mb-2">{title}</h4>
        <p className="text-[10px] text-gray-400 text-center py-6">No data</p>
      </div>
    );
  }

  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padding = 10;
  const chartW = 280;
  const chartH = height - 40;

  const points = data
    .map((d, i) => {
      if (d.value === null) return null;
      const x = padding + (i / (data.length - 1 || 1)) * (chartW - 2 * padding);
      const y = chartH - padding - ((d.value - min) / range) * (chartH - 2 * padding);
      return { x, y, value: d.value };
    })
    .filter(Boolean);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 cursor-pointer hover:border-gray-300 transition">
      <div className="flex items-baseline justify-between mb-1">
        <h4 className="text-xs font-medium text-gray-500">{title}</h4>
        <span className="text-xs font-semibold" style={{ color }}>
          avg {Math.round(avg)}{unit}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} className="overflow-visible">
        {referenceLines.map((rl, i) => {
          const y = chartH - padding - ((rl.y - min) / range) * (chartH - 2 * padding);
          return (
            <line key={i} x1={padding} y1={y} x2={chartW - padding} y2={y}
              stroke={rl.color} strokeWidth="0.5" strokeDasharray="3,3" opacity="0.6" />
          );
        })}
        {chartType === 'line' ? (
          <>
            <polyline
              points={points.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={color} />
            ))}
          </>
        ) : (
          points.map((p, i) => {
            const barW = Math.max(2, (chartW - 2 * padding) / data.length - 2);
            return (
              <rect key={i} x={p.x - barW / 2} y={p.y} width={barW} height={chartH - padding - p.y}
                fill={color} opacity="0.7" rx="1" />
            );
          })
        )}
      </svg>
    </div>
  );
}

// ---- Data Tables ----

function msToHM(ms) {
  if (!ms) return '\u2014';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// #457: a table value on its red/yellow/green band (whoopBands.js); null band = neutral.
function Banded({ band, children }) {
  if (!band) return children;
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${BAND_CLASS[band]}`}>{children}</span>;
}

function StateBadge({ state }) {
  const colors = state === 'green'
    ? 'bg-green-100 text-green-700'
    : state === 'yellow'
    ? 'bg-yellow-100 text-yellow-700'
    : 'bg-red-100 text-red-700';
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors}`}>{state || '\u2014'}</span>;
}

function CyclesTable({ cycles, sleep, history }) {
  const sorted = [...cycles].sort((a, b) => b.cycle_date.localeCompare(a.cycle_date));
  const sleepByDate = new Map(sleep.map(s => [s.sleep_date, s]));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500 border-b border-gray-200">
            <th className="text-left py-2 px-2 font-medium">Date</th>
            <th className="text-center py-2 px-2 font-medium">Prepare</th>
            <th className="text-right py-2 px-2 font-medium">Recovery</th>
            <th className="text-center py-2 px-2 font-medium">State</th>
            <th className="text-right py-2 px-2 font-medium">HRV</th>
            <th className="text-right py-2 px-2 font-medium">RHR</th>
            <th className="text-right py-2 px-2 font-medium">Strain</th>
            <th className="text-right py-2 px-2 font-medium">SpO2</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(c => {
            const matchingSleep = sleepByDate.get(c.cycle_date) ?? null;
            const readiness = computeReadiness(c, matchingSleep, cycles, sleep);
            const rState = readinessState(readiness);
            const rColors = rState === 'green' ? 'bg-teal-100 text-teal-700' : rState === 'yellow' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700';
            const b = cycleBands(c, history);
            return (
              <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                <td className="py-2 px-2 text-gray-700">{c.cycle_date}</td>
                <td className="py-2 px-2 text-center">
                  {readiness !== null ? <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${rColors}`}>{readiness}%</span> : '\u2014'}
                </td>
                <td className="py-2 px-2 text-right font-medium">{c.recovery_score !== null ? <Banded band={b.recovery}>{Math.round(c.recovery_score)}%</Banded> : '\u2014'}</td>
                <td className="py-2 px-2 text-center"><StateBadge state={c.recovery_state} /></td>
                <td className="py-2 px-2 text-right text-gray-600">{c.hrv_rmssd !== null ? <Banded band={b.hrv}>{Math.round(c.hrv_rmssd)}</Banded> : '\u2014'}</td>
                <td className="py-2 px-2 text-right text-gray-600">{c.resting_heart_rate !== null ? <Banded band={b.rhr}>{Math.round(c.resting_heart_rate)}</Banded> : '\u2014'}</td>
                <td className="py-2 px-2 text-right text-gray-600">{c.strain_score !== null ? <Banded band={b.strain}>{Number(c.strain_score).toFixed(1)}</Banded> : '\u2014'}</td>
                <td className="py-2 px-2 text-right text-gray-600">{c.spo2_pct !== null ? <Banded band={b.spo2}>{Number(c.spo2_pct).toFixed(0)}%</Banded> : '\u2014'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="text-center text-gray-400 text-xs py-8">No cycle data</p>}
      {sorted.length > 0 && <p className="text-[10px] text-gray-400 mt-2 px-2">{BAND_LEGEND}</p>}
    </div>
  );
}

function SleepTable({ sleep, history }) {
  const sorted = [...sleep].sort((a, b) => b.sleep_date.localeCompare(a.sleep_date));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500 border-b border-gray-200">
            <th className="text-left py-2 px-2 font-medium">Date</th>
            <th className="text-right py-2 px-2 font-medium">Score</th>
            <th className="text-right py-2 px-2 font-medium">Duration</th>
            <th className="text-right py-2 px-2 font-medium">Efficiency</th>
            <th className="text-right py-2 px-2 font-medium">REM</th>
            <th className="text-right py-2 px-2 font-medium">Deep</th>
            <th className="text-right py-2 px-2 font-medium">Light</th>
            <th className="text-right py-2 px-2 font-medium">Awake</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => {
            const b = sleepBands(s, history);
            return (
              <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                <td className="py-2 px-2 text-gray-700">{s.sleep_date}</td>
                <td className="py-2 px-2 text-right font-medium">{s.sleep_score !== null ? <Banded band={b.score}>{Math.round(s.sleep_score)}%</Banded> : '\u2014'}</td>
                {/* Duration is time in bed; its band is time ASLEEP (in bed minus awake), same as the sleep_short nudge. */}
                <td className="py-2 px-2 text-right text-gray-600"><Banded band={b.asleep}>{msToHM(s.total_duration_ms)}</Banded></td>
                <td className="py-2 px-2 text-right text-gray-600">{s.sleep_efficiency !== null ? <Banded band={b.efficiency}>{Math.round(s.sleep_efficiency)}%</Banded> : '\u2014'}</td>
                <td className="py-2 px-2 text-right text-gray-600"><Banded band={b.rem}>{msToHM(s.rem_duration_ms)}</Banded></td>
                <td className="py-2 px-2 text-right text-gray-600"><Banded band={b.deep}>{msToHM(s.sws_duration_ms)}</Banded></td>
                <td className="py-2 px-2 text-right text-gray-600">{msToHM(s.light_duration_ms)}</td>
                <td className="py-2 px-2 text-right text-gray-600"><Banded band={b.awake}>{msToHM(s.awake_duration_ms)}</Banded></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="text-center text-gray-400 text-xs py-8">No sleep data</p>}
      {sorted.length > 0 && <p className="text-[10px] text-gray-400 mt-2 px-2">Green = good, yellow = watch, red = needs attention. Duration is coloured by time asleep (8 h+ green, under 7 h red); REM and deep by their share of sleep.</p>}
    </div>
  );
}

function WorkoutsTable({ workouts }) {
  const sorted = [...workouts].sort((a, b) => b.workout_date.localeCompare(a.workout_date));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-gray-500 border-b border-gray-200">
            <th className="text-left py-2 px-2 font-medium">Date</th>
            <th className="text-left py-2 px-2 font-medium">Sport</th>
            <th className="text-right py-2 px-2 font-medium">Strain</th>
            <th className="text-right py-2 px-2 font-medium">Avg HR</th>
            <th className="text-right py-2 px-2 font-medium">Max HR</th>
            <th className="text-right py-2 px-2 font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(w => (
            <tr key={w.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
              <td className="py-2 px-2 text-gray-700">{w.workout_date}</td>
              <td className="py-2 px-2 text-gray-900">{w.sport_name || 'Activity'}</td>
              <td className="py-2 px-2 text-right text-gray-600">{w.strain_score !== null ? <Banded band={bandWorkoutStrain(w.strain_score)}>{Number(w.strain_score).toFixed(1)}</Banded> : '\u2014'}</td>
              <td className="py-2 px-2 text-right text-gray-600">{w.average_heart_rate !== null ? Math.round(w.average_heart_rate) : '\u2014'}</td>
              <td className="py-2 px-2 text-right text-gray-600">{w.max_heart_rate !== null ? Math.round(w.max_heart_rate) : '\u2014'}</td>
              <td className="py-2 px-2 text-right text-gray-600">{msToHM(w.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <p className="text-center text-gray-400 text-xs py-8">No workout data</p>}
    </div>
  );
}

// ---- Main WhoopTab Component ----

export default function WhoopTab({ userId, userRole, loggedInUserId, athleteName }) {
  // #394: this tab is shown BOTH on your own profile and on an athlete's
  // profile when staff open it. The data call is already target-aware
  // (`target_user_id=${userId}`), but the not-connected screen was not: it told
  // a coach looking at an athlete to "link YOUR WHOOP account", and its button
  // calls ?action=connect, which the edge function scopes to the CALLER. So a
  // coach clicking it would have linked their own WHOOP from the athlete's
  // page. That is what Cordell reported: he opened JW Grose's WHOOP tab and was
  // asked to connect his own.
  //
  // `loggedInUserId` may be undefined if some future caller forgets to pass it.
  // Defaulting to "this is me" keeps the old behaviour rather than hiding the
  // connect button from a player on their own profile, which would be worse.
  const isSelf = loggedInUserId == null || loggedInUserId === userId;
  const [connected, setConnected] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [sleep, setSleep] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  // #457: the range plus BASELINE_DAYS more, used only for personal baselines.
  const [historyCycles, setHistoryCycles] = useState([]);
  const [historySleep, setHistorySleep] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [range, setRange] = useState(30);
  const [selectedDate, setSelectedDate] = useState(fmtLocalDate(new Date()));
  const [selectedGraph, setSelectedGraph] = useState('recovery');
  const [dataSubTab, setDataSubTab] = useState('cycles');

  const functionUrl = `${supabaseUrl}/functions/v1/whoop`;

  const getAuthHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Authorization': `Bearer ${session?.access_token}`,
      'Content-Type': 'application/json',
    };
  };

  const fetchData = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const to = fmtLocalDate(new Date());
      const from = fmtLocalDate(new Date(Date.now() - range * 86_400_000));
      const historyFrom = fmtLocalDate(new Date(Date.now() - (range + BASELINE_DAYS) * 86_400_000));
      const res = await fetch(
        `${functionUrl}?action=data&target_user_id=${userId}&from=${historyFrom}&to=${to}`,
        { headers }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Surface re-auth required from the edge function so the user knows
        // to re-connect rather than seeing stale data.
        if (body.includes('WHOOP_REAUTH_REQUIRED')) {
          setConnected(false);
          throw new Error('Whoop session expired. Please reconnect.');
        }
        throw new Error(`Whoop fetch failed: ${res.status}`);
      }
      const data = await res.json();
      setConnected(data.connected);
      const allCycles = data.cycles || [];
      const allSleep = data.sleep || [];
      setHistoryCycles(allCycles);
      setHistorySleep(allSleep);
      setCycles(allCycles.filter((c) => c.cycle_date >= from));
      setSleep(allSleep.filter((x) => x.sleep_date >= from));
      setWorkouts((data.workouts || []).filter((w) => w.workout_date >= from));
    } catch (err) {
      console.error('Whoop fetch error:', err);
    }
    setLoading(false);
  }, [range, userId, functionUrl]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-sync if stale
  useEffect(() => {
    if (!connected || cycles.length === 0) return;
    const latest = cycles[cycles.length - 1];
    const age = Date.now() - new Date(latest.created_at).getTime();
    if (age > 3_600_000) {
      handleSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const handleConnect = async () => {
    const headers = await getAuthHeaders();
    const res = await fetch(`${functionUrl}?action=connect`, { headers });
    if (!res.ok) {
      alert('Could not start WHOOP connect. Try again in a moment.');
      return;
    }
    const data = await res.json();
    // Validate the redirect URL belongs to WHOOP's OAuth server so a
    // compromised edge function couldn't redirect users to an attacker page.
    try {
      const u = new URL(data.url);
      if (u.protocol !== 'https:' || !/(^|\.)whoop\.com$/i.test(u.host)) {
        throw new Error('Unexpected redirect host');
      }
      window.location.href = u.toString();
    } catch {
      alert('Could not start WHOOP connect — invalid redirect URL.');
    }
  };

  // #394 follow-up. This action IS correctly targeted — it sends
  // `target_user_id` and the edge function enforces who may disconnect whom —
  // but the old wording ("Disconnect WHOOP?") never said WHOSE. On an athlete's
  // page, where the surrounding screen is full of that athlete's data, a member
  // of staff could reasonably read it as being about their own account. It
  // unlinks the athlete and deletes their cached recovery data, and only the
  // athlete can put it back. Say so before, not after.
  const handleDisconnect = async () => {
    const who = isSelf
      ? 'Disconnect your WHOOP account?'
      : `Disconnect ${athleteName ? `${athleteName}'s` : "this athlete's"} WHOOP account? This unlinks THEIR account, not yours.`;
    const consequence = isSelf
      ? ' Your cached recovery, sleep and strain data will be removed, and you will need to link it again.'
      : ' Their cached recovery, sleep and strain data will be removed, and only they can link it again — from their own login.';
    if (!window.confirm(who + consequence)) return;
    const headers = await getAuthHeaders();
    await fetch(`${functionUrl}?action=disconnect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_user_id: userId }),
    });
    setConnected(false);
    setCycles([]);
    setSleep([]);
    setWorkouts([]);
    setHistoryCycles([]);
    setHistorySleep([]);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const headers = await getAuthHeaders();
      await fetch(`${functionUrl}?action=sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ target_user_id: userId }),
      });
      await fetchData();
    } catch (err) {
      console.error('Sync error:', err);
    }
    setSyncing(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-3 border-gray-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  // #394: staff looking at somebody else get told the truth and given no
  // button, because there is no button that could do what they want — only the
  // athlete can authorise their own WHOOP account.
  if (!connected && !isSelf) {
    return (
      <div className="max-w-md mx-auto py-12 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-4 mx-auto">
          <Activity size={28} />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          This athlete hasn't connected WHOOP
        </h3>
        <p className="text-sm text-gray-500 mb-2">
          There is no WHOOP account linked to them, so there is no recovery, sleep or strain
          data to show yet.
        </p>
        <p className="text-sm text-gray-500">
          Only the athlete can link it, from their own login: <span className="font-medium
          text-gray-700">Profile &rarr; Whoop &rarr; Connect WHOOP Account</span>. Ask them to
          do that and their data will appear here.
        </p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="max-w-md mx-auto py-12 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-4 mx-auto">
          <Activity size={28} />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Connect WHOOP</h3>
        <p className="text-sm text-gray-500 mb-6">
          Link your WHOOP account to track recovery, sleep, and strain data.
        </p>
        <button
          onClick={handleConnect}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition text-sm inline-flex items-center gap-2"
        >
          <Link2 size={16} />
          Connect WHOOP Account
        </button>
        <p className="text-sm text-gray-500 mt-4">
          Don't have a WHOOP?{' '}
          <a href="https://join.whoop.com/thenatural" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">
            Get a free WHOOP + one month free
          </a>
        </p>
        <div className="mt-6 text-left">
          <WhoopCommunityCodeCard />
        </div>
      </div>
    );
  }

  // Date navigation
  const today = fmtLocalDate(new Date());
  const cycleDates = cycles.map(c => c.cycle_date).sort();
  const todayCycle = cycles.find(c => c.cycle_date === selectedDate) || null;
  const todaySleep = sleep.find(s => s.sleep_date === selectedDate) || null;

  const hasPrev = cycleDates.length > 0 && cycleDates[0] < selectedDate;
  const hasNext = cycleDates.length > 0 && cycleDates[cycleDates.length - 1] > selectedDate;

  const handlePrevDay = () => {
    const idx = cycleDates.indexOf(selectedDate);
    if (idx > 0) setSelectedDate(cycleDates[idx - 1]);
    else {
      const earlier = cycleDates.filter(d => d < selectedDate);
      if (earlier.length > 0) setSelectedDate(earlier[earlier.length - 1]);
    }
  };

  const handleNextDay = () => {
    const idx = cycleDates.indexOf(selectedDate);
    if (idx >= 0 && idx < cycleDates.length - 1) setSelectedDate(cycleDates[idx + 1]);
    else {
      const later = cycleDates.filter(d => d > selectedDate);
      if (later.length > 0) setSelectedDate(later[0]);
    }
  };

  const displayDate = (() => {
    if (selectedDate === today) return 'Today';
    const d = new Date(selectedDate + 'T12:00:00');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (selectedDate === fmtLocalDate(yesterday)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  })();

  // Prepare score
  const prepareScore = computeReadiness(todayCycle, todaySleep, cycles, sleep);
  const prepareState = readinessState(prepareScore);
  const prepareColor = prepareState === 'green' ? '#14b8a6' : prepareState === 'yellow' ? '#eab308' : prepareState === 'red' ? '#ef4444' : '#6b7280';

  const recoveryScore = todayCycle?.recovery_score ?? null;
  const recoveryColor = todayCycle?.recovery_state === 'green' ? '#22c55e' : todayCycle?.recovery_state === 'yellow' ? '#eab308' : '#ef4444';
  // #457: bands for the rest of today's numbers (personal baselines from the loaded history).
  const todayCycleBands = cycleBands(todayCycle, historyCycles);
  const todaySleepBands = sleepBands(todaySleep, historySleep);
  const sleepScore = todaySleep?.sleep_score ?? null;
  const totalHours = todaySleep?.total_duration_ms ? (todaySleep.total_duration_ms / 3_600_000).toFixed(1) : null;
  const strainScore = todayCycle?.strain_score ? Number(todayCycle.strain_score) : null;
  const kilojoules = todayCycle?.kilojoule ? Number(todayCycle.kilojoule) : null;
  const calories = kilojoules !== null ? Math.round(kilojoules * 0.239006) : null;

  // Graph data builders
  const sleepByDate = new Map(sleep.map(s => [s.sleep_date, s]));

  const getGraphData = () => {
    switch (selectedGraph) {
      case 'prepare':
        return {
          data: cycles.map(c => {
            const ms = sleepByDate.get(c.cycle_date) ?? null;
            return { date: c.cycle_date, value: computeReadiness(c, ms, cycles, sleep) };
          }),
          color: '#14b8a6', title: 'Prepare', unit: '%',
          referenceLines: [{ y: 67, color: '#22c55e' }, { y: 34, color: '#ef4444' }],
        };
      case 'recovery':
        return {
          data: cycles.map(c => ({ date: c.cycle_date, value: c.recovery_score })),
          color: '#22c55e', title: 'Recovery', unit: '%',
          referenceLines: [{ y: 67, color: '#22c55e' }, { y: 34, color: '#ef4444' }],
        };
      case 'hrv':
        return { data: cycles.map(c => ({ date: c.cycle_date, value: c.hrv_rmssd })), color: '#3b82f6', title: 'HRV', unit: 'ms' };
      case 'strain':
        return { data: cycles.map(c => ({ date: c.cycle_date, value: c.strain_score })), color: '#f59e0b', title: 'Strain', chartType: 'bar' };
      case 'sleep_score':
        return { data: sleep.map(s => ({ date: s.sleep_date, value: s.sleep_score })), color: '#8b5cf6', title: 'Sleep Score', unit: '%' };
      case 'sleep_duration':
        return { data: sleep.map(s => ({ date: s.sleep_date, value: s.total_duration_ms ? +(s.total_duration_ms / 3_600_000).toFixed(2) : null })), color: '#8b5cf6', title: 'Sleep Duration', unit: 'hrs', chartType: 'bar' };
      case 'rhr':
        return { data: cycles.map(c => ({ date: c.cycle_date, value: c.resting_heart_rate })), color: '#ef4444', title: 'Resting HR', unit: 'bpm' };
      case 'calories':
        return { data: cycles.map(c => ({ date: c.cycle_date, value: c.kilojoule ? Math.round(Number(c.kilojoule) / 4.184) : null })), color: '#f97316', title: 'Calories', unit: 'kcal', chartType: 'bar' };
      default:
        return { data: cycles.map(c => ({ date: c.cycle_date, value: c.recovery_score })), color: '#22c55e', title: 'Recovery', unit: '%' };
    }
  };

  const GRAPHS = [
    { key: 'prepare', label: 'Prepare' },
    { key: 'recovery', label: 'Recovery' },
    { key: 'hrv', label: 'HRV' },
    { key: 'strain', label: 'Strain' },
    { key: 'sleep_score', label: 'Sleep Score' },
    { key: 'sleep_duration', label: 'Sleep Duration' },
    { key: 'rhr', label: 'Resting HR' },
    { key: 'calories', label: 'Calories' },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {['overview', 'graphs', 'data'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition capitalize ${
                  activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WhoopCommunityCodeCard compact />
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            {[7, 14, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setRange(d)}
                className={`px-2 py-1 rounded-md text-xs font-medium transition ${
                  range === d ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs text-gray-600 transition disabled:opacity-50 inline-flex items-center gap-1"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Refresh'}
          </button>
          <button
            onClick={handleDisconnect}
            className="px-3 py-1.5 bg-gray-100 hover:bg-red-50 hover:text-red-600 rounded-lg text-xs text-gray-500 transition inline-flex items-center gap-1"
          >
            <Unlink size={12} />
            Disconnect
          </button>
        </div>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* Today Hero */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-center gap-3 mb-4">
              <button onClick={handlePrevDay} disabled={!hasPrev}
                className="p-1 rounded text-gray-400 hover:text-gray-700 disabled:opacity-25">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <h3 className="text-xs font-medium text-gray-500 min-w-[100px] text-center">{displayDate}</h3>
              <button onClick={handleNextDay} disabled={!hasNext}
                className="p-1 rounded text-gray-400 hover:text-gray-700 disabled:opacity-25">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>

            {/* Gauges */}
            <div className="flex justify-center gap-4 sm:gap-6 mb-4 flex-wrap">
              <CircularGauge value={prepareScore} max={100} color={prepareColor} label="Prepare" display={prepareScore !== null ? `${prepareScore}%` : '\u2014'} />
              <CircularGauge value={recoveryScore} max={100} color={recoveryColor} label="Recovery" display={recoveryScore !== null ? `${Math.round(recoveryScore)}%` : '\u2014'} />
              <CircularGauge value={sleepScore} max={100} color={BAND_HEX[todaySleepBands.score] || '#3b82f6'} label={totalHours ? `${totalHours}h sleep` : 'Sleep'} display={sleepScore !== null ? `${Math.round(sleepScore)}%` : '\u2014'} />
              <CircularGauge value={strainScore} max={21} color={BAND_HEX[todayCycleBands.strain] || '#f97316'} label="Strain" display={strainScore !== null ? strainScore.toFixed(1) : '\u2014'} />
              <CircularGauge value={calories} max={4000} color="#f97316" label="Calories" display={calories !== null ? `${calories}` : '\u2014'} />
            </div>

            {/* Stat pills */}
            <div className="flex justify-center gap-2 flex-wrap mb-3">
              <StatPill label="Time in Bed" value={todaySleep?.total_duration_ms ? (todaySleep.total_duration_ms / 3_600_000).toFixed(1) : '\u2014'} unit="hrs" band={bandAsleep(todaySleep)} />
              <StatPill label="HRV" value={todayCycle?.hrv_rmssd != null ? `${Math.round(todayCycle.hrv_rmssd)}` : '\u2014'} unit="ms" band={todayCycleBands.hrv} />
              <StatPill label="RHR" value={todayCycle?.resting_heart_rate != null ? `${Math.round(todayCycle.resting_heart_rate)}` : '\u2014'} unit="bpm" band={todayCycleBands.rhr} />
              <StatPill label="SpO2" value={todayCycle?.spo2_pct != null ? `${Number(todayCycle.spo2_pct).toFixed(0)}` : '\u2014'} unit="%" band={todayCycleBands.spo2} />
              {todayCycle?.skin_temp_celsius != null && (
                <StatPill label="Skin Temp" value={Number(todayCycle.skin_temp_celsius).toFixed(1)} unit="\u00b0C" band={todayCycleBands.skinTemp} />
              )}
              {todaySleep?.respiratory_rate != null && (
                <StatPill label="Resp Rate" value={Number(todaySleep.respiratory_rate).toFixed(1)} unit="rpm" band={todaySleepBands.resp} />
              )}
            </div>

            <p className="text-center text-[10px] text-gray-400 mb-3">{BAND_LEGEND}</p>

            {/* Sleep stage bar */}
            {todaySleep && (
              <div className="border-t border-gray-100 pt-3">
                <SleepStageBar sleep={todaySleep} />
              </div>
            )}
          </div>

          {/* Trend charts row */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div onClick={() => { setSelectedGraph('prepare'); setActiveTab('graphs'); }}>
              <MetricTrend
                data={cycles.map(c => {
                  const ms = sleepByDate.get(c.cycle_date) ?? null;
                  return { date: c.cycle_date, value: computeReadiness(c, ms, cycles, sleep) };
                })}
                color="#14b8a6" title="Prepare" unit="%"
                referenceLines={[{ y: 67, color: '#22c55e' }, { y: 34, color: '#ef4444' }]}
              />
            </div>
            <div onClick={() => { setSelectedGraph('recovery'); setActiveTab('graphs'); }}>
              <MetricTrend
                data={cycles.map(c => ({ date: c.cycle_date, value: c.recovery_score }))}
                color="#22c55e" title="Recovery" unit="%"
                referenceLines={[{ y: 67, color: '#22c55e' }, { y: 34, color: '#ef4444' }]}
              />
            </div>
            <div onClick={() => { setSelectedGraph('hrv'); setActiveTab('graphs'); }}>
              <MetricTrend data={cycles.map(c => ({ date: c.cycle_date, value: c.hrv_rmssd }))} color="#3b82f6" title="HRV" unit="ms" />
            </div>
            <div onClick={() => { setSelectedGraph('strain'); setActiveTab('graphs'); }}>
              <MetricTrend data={cycles.map(c => ({ date: c.cycle_date, value: c.strain_score }))} color="#f59e0b" title="Strain" chartType="bar" />
            </div>
          </div>

          {/* Recent workouts */}
          {workouts.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h4 className="text-xs font-medium text-gray-500 mb-3">Recent Workouts</h4>
              <div className="space-y-2">
                {[...workouts].sort((a, b) => b.workout_date.localeCompare(a.workout_date)).slice(0, 10).map(w => (
                  <div key={w.id} className="flex items-center justify-between text-xs py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 w-16">{w.workout_date.slice(5)}</span>
                      <span className="font-medium text-gray-900">{w.sport_name || 'Activity'}</span>
                    </div>
                    <div className="flex items-center gap-3 text-gray-500">
                      {w.strain_score && <span>Strain: {Number(w.strain_score).toFixed(1)}</span>}
                      {w.average_heart_rate && <span>{Math.round(w.average_heart_rate)} bpm</span>}
                      <span>{msToHM(w.duration_ms)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Graphs Tab */}
      {activeTab === 'graphs' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {GRAPHS.map(g => (
              <button
                key={g.key}
                onClick={() => setSelectedGraph(g.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                  selectedGraph === g.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500 hover:text-gray-700'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <MetricTrend {...getGraphData()} height={300} />
        </div>
      )}

      {/* Data Tab */}
      {activeTab === 'data' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 mb-4 w-fit">
            {[
              { key: 'cycles', label: 'Cycles', count: cycles.length },
              { key: 'sleep', label: 'Sleep', count: sleep.length },
              { key: 'workouts', label: 'Workouts', count: workouts.length },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setDataSubTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                  dataSubTab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
                <span className="ml-1.5 text-[10px] text-gray-400">{t.count}</span>
              </button>
            ))}
          </div>
          {dataSubTab === 'cycles' && <CyclesTable cycles={cycles} sleep={sleep} history={historyCycles} />}
          {dataSubTab === 'sleep' && <SleepTable sleep={sleep} history={historySleep} />}
          {dataSubTab === 'workouts' && <WorkoutsTable workouts={workouts} />}
        </div>
      )}
    </div>
  );
}
