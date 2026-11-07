// #484: catch up on past check-ins. Every lift, practice, game and booked
// session since BACKLOG_START counts as scheduled, and nothing is assumed
// done, so this is where the athlete marks past items completed (or missed).
// Grouped by date, newest first, with "Mark all completed" per day. Rendered
// inside CheckinModal ("Catch up" tab) and as its own modal from the profile
// completion pill (CheckinCatchUpModal).
import React, { useEffect, useMemo, useState } from 'react';
import { X, CheckCircle, Loader } from 'lucide-react';
import { fetchCatchUpItems, needsCatchUp, saveCheckin, saveCheckins, BACKLOG_START } from './athleteCheckins';
import { CategoryIcon, CategoryBadge, fmtTime } from './checkinUi';
import { formatUserError } from './errorMessage';

const DAYS_PER_PAGE = 14;

function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function CheckinCatchUp({ userId, onChanged }) {
  const [items, setItems] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [dayLimit, setDayLimit] = useState(DAYS_PER_PAGE);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchCatchUpItems(userId)
      .then(rows => { if (!cancelled) setItems(rows); })
      .catch(e => { if (!cancelled) setLoadError(formatUserError(e)); });
    return () => { cancelled = true; };
  }, [userId]);

  const days = useMemo(() => {
    const byDate = new Map();
    (items || []).forEach(it => {
      if (!byDate.has(it.item_date)) byDate.set(it.item_date, []);
      byDate.get(it.item_date).push(it);
    });
    return [...byDate.entries()]
      .map(([date, list]) => ({ date, list, open: list.filter(needsCatchUp) }))
      .filter(d => showAll || d.open.length > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [items, showAll]);

  const openTotal = useMemo(() => (items || []).filter(needsCatchUp).length, [items]);
  const doneTotal = useMemo(() => (items || []).filter(it => it.checkin?.completed_at).length, [items]);

  const applyRows = (rows) => {
    const byKey = new Map(rows.map(r => [`${r.item_type}:${r.item_id}:${r.item_date}`, r]));
    setItems(prev => prev.map(it => byKey.get(`${it.item_type}:${it.item_id}:${it.item_date}`)
      ? { ...it, checkin: byKey.get(`${it.item_type}:${it.item_id}:${it.item_date}`) } : it));
    onChanged?.();
  };

  const saveOne = async (item, patch) => {
    const key = `${item.item_type}:${item.item_id}:${item.item_date}`;
    setBusy(key); setError(null);
    try { applyRows([await saveCheckin(userId, item, patch)]); }
    catch (e) { setError(formatUserError(e)); }
    finally { setBusy(null); }
  };

  const completeDay = async (day) => {
    setBusy(`day:${day.date}`); setError(null);
    try { applyRows(await saveCheckins(userId, day.open, { intent: 'doing', completed_at: new Date().toISOString() })); }
    catch (e) { setError(formatUserError(e)); }
    finally { setBusy(null); }
  };

  if (loadError) return <p className="px-5 py-6 text-sm text-red-600">{loadError}</p>;
  if (items === null) {
    return <div className="px-5 py-8 flex items-center justify-center text-sm text-gray-500"><Loader size={16} className="animate-spin mr-2" /> Loading your schedule…</div>;
  }

  const visible = days.slice(0, dayLimit);
  return (
    <div>
      <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-600">
          {openTotal > 0
            ? <><span className="font-semibold text-gray-900">{openTotal}</span> past item{openTotal === 1 ? '' : 's'} since {fmtDay(BACKLOG_START)} still to check off · {doneTotal} completed</>
            : <>All caught up · {doneTotal} completed since {fmtDay(BACKLOG_START)}</>}
        </p>
        <label className="text-xs text-gray-600 flex items-center gap-1 shrink-0 cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={e => { setShowAll(e.target.checked); setDayLimit(DAYS_PER_PAGE); }} />
          Show checked days
        </label>
      </div>

      {visible.length === 0 && <p className="px-5 py-6 text-sm text-gray-500">{items.length === 0 ? 'Nothing on your schedule before today.' : 'Nothing left to catch up on.'}</p>}

      {visible.map(day => (
        <div key={day.date} className="border-b border-gray-100">
          <div className="px-5 pt-3 pb-1 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800">{fmtDay(day.date)}</p>
            {day.open.length > 0 && (
              <button
                disabled={!!busy}
                onClick={() => completeDay(day)}
                className="text-xs font-medium px-2.5 py-1 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                {busy === `day:${day.date}` ? 'Saving…' : day.open.length === day.list.length ? 'Mark all completed' : `Mark ${day.open.length} left completed`}
              </button>
            )}
          </div>
          <ul className="px-5 pb-3 space-y-2">
            {day.list.map(item => {
              const key = `${item.item_type}:${item.item_id}:${item.item_date}`;
              const c = item.checkin;
              const rowBusy = busy === key || busy === `day:${day.date}`;
              return (
                <li key={key} className="flex items-center gap-2">
                  <CategoryIcon type={item.item_type} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 truncate">{item.title}</p>
                    <p className="text-xs text-gray-500 flex items-center gap-1.5">
                      <CategoryBadge type={item.item_type} />
                      {fmtTime(item.time) && <span>{fmtTime(item.time)}</span>}
                    </p>
                  </div>
                  {c?.completed_at ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700"><CheckCircle size={14} /> Done</span>
                      <button disabled={rowBusy} onClick={() => saveOne(item, { completed_at: null })} className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50">Undo</button>
                    </span>
                  ) : c?.intent === 'skipping' ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-gray-500">Missed</span>
                      <button disabled={rowBusy} onClick={() => saveOne(item, { intent: null })} className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50">Undo</button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 shrink-0">
                      <button disabled={rowBusy} onClick={() => saveOne(item, { intent: 'doing', completed_at: new Date().toISOString() })} className="text-xs font-medium px-2 py-1 rounded-lg border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-50">Completed</button>
                      <button disabled={rowBusy} onClick={() => saveOne(item, { intent: 'skipping', completed_at: null })} className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50">Missed</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {days.length > dayLimit && (
        <div className="px-5 py-3 text-center">
          <button onClick={() => setDayLimit(n => n + DAYS_PER_PAGE)} className="text-sm text-blue-700 hover:underline">Show earlier days ({days.length - dayLimit} more)</button>
        </div>
      )}
      {error && <p className="px-5 pb-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// Standalone modal, opened from the athlete's own profile completion pill.
export default function CheckinCatchUpModal({ userId, onClose, onChanged }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Catch up</h3>
            <p className="text-sm text-gray-500 mt-0.5">Check off the lifts, practices, games and sessions you've already done.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 ml-3" title="Close"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto flex-1"><CheckinCatchUp userId={userId} onChanged={onChanged} /></div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-800 text-sm font-medium hover:bg-gray-200">Done</button>
        </div>
      </div>
    </div>
  );
}
