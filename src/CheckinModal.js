// #462: today's check-in. Opened automatically once a day on login (App.js)
// and again from the bell's "Today's check-in" item. Per item: "Doing it" /
// "Not today", then "Mark completed". See athleteCheckins.js.
import React, { useState } from 'react';
import { X, Dumbbell, CalendarClock, CheckCircle } from 'lucide-react';
import { saveCheckin } from './athleteCheckins';
import { formatUserError } from './errorMessage';

function fmtTime(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

export default function CheckinModal({ userId, items, onChange, onClose }) {
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);

  const save = async (item, patch) => {
    const key = `${item.item_type}:${item.item_id}`;
    setBusyKey(key);
    setError(null);
    try {
      const row = await saveCheckin(userId, item, patch);
      onChange?.(items.map(it => (it.item_type === item.item_type && it.item_id === item.item_id ? { ...it, checkin: row } : it)));
    } catch (e) {
      setError(formatUserError(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Today's check-in</h3>
            <p className="text-sm text-gray-500 mt-0.5">Let your coaches know what you're doing today, then mark each one completed when you're done.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 ml-3" title="Close"><X size={20} /></button>
        </div>

        <div className="divide-y divide-gray-100">
          {items.length === 0 && <p className="px-5 py-6 text-sm text-gray-500">Nothing on your calendar today.</p>}
          {items.map(item => {
            const key = `${item.item_type}:${item.item_id}`;
            const busy = busyKey === key;
            const c = item.checkin;
            const Icon = item.item_type === 'workout' ? Dumbbell : CalendarClock;
            return (
              <div key={key} className="px-5 py-4">
                <div className="flex items-start space-x-3">
                  <Icon size={18} className="text-blue-600 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.title}</p>
                    <p className="text-xs text-gray-500 capitalize">{[item.detail, fmtTime(item.time)].filter(Boolean).join(' · ')}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {c?.completed_at ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-green-700"><CheckCircle size={16} /> Completed</span>
                      <button disabled={busy} onClick={() => save(item, { completed_at: null })} className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50">Undo</button>
                    </>
                  ) : c?.intent === 'doing' ? (
                    <>
                      <button disabled={busy} onClick={() => save(item, { completed_at: new Date().toISOString() })} className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50">Mark completed</button>
                      <button disabled={busy} onClick={() => save(item, { intent: 'skipping' })} className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-50">Not today</button>
                    </>
                  ) : (
                    <>
                      <button disabled={busy} onClick={() => save(item, { intent: 'doing' })} className={`px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 ${c?.intent === 'skipping' ? 'border border-blue-600 text-blue-700 hover:bg-blue-50' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>Doing it</button>
                      {c?.intent === 'skipping'
                        ? <span className="text-sm text-gray-500 self-center">Not today</span>
                        : <button disabled={busy} onClick={() => save(item, { intent: 'skipping' })} className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-50">Not today</button>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="px-5 pb-2 text-sm text-red-600">{error}</p>}
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-800 text-sm font-medium hover:bg-gray-200">Done</button>
        </div>
      </div>
    </div>
  );
}
