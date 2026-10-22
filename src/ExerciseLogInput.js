// #460: the "Weight used" box on each exercise in WorkoutDetailModal. Saves on
// blur (or Enter); clearing the weight removes the entry. `last` is the most
// recent earlier entry for the same movement, shown as a hint.

import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { formatUserError } from './errorMessage';
import { formatWeight } from './exerciseLogs';

const shortDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function ExerciseLogInput({ log, last, onSave, compact = false }) {
  const [weight, setWeight] = useState(log ? String(Number(log.weight)) : '');
  const [reps, setReps] = useState(log?.reps_done || '');
  const [status, setStatus] = useState(null); // 'saving' | 'saved' | error text

  useEffect(() => {
    setWeight(log ? String(Number(log.weight)) : '');
    setReps(log?.reps_done || '');
  }, [log]);

  const commit = async () => {
    const savedWeight = log ? String(Number(log.weight)) : '';
    const savedReps = log?.reps_done || '';
    if (weight.trim() === savedWeight && reps.trim() === savedReps) return;
    if (!weight.trim() && reps.trim() && !log) { setStatus('Enter the weight too'); return; }
    setStatus('saving');
    try {
      await onSave(weight, reps);
      setStatus('saved');
    } catch (err) {
      setStatus(err?.message && !err.code ? err.message : formatUserError(err));
    }
  };

  const onKeyDown = (e) => { if (e.key === 'Enter') e.currentTarget.blur(); };
  const error = status && status !== 'saving' && status !== 'saved' ? status : null;
  const lastHint = last ? `Last: ${formatWeight(last)}${last.reps_done ? ` × ${last.reps_done}` : ''} · ${shortDate(last.event_date)}` : null;

  return (
    <div className={compact ? '' : 'mt-2 pt-2 border-t border-gray-100'}>
      <div className="flex items-center gap-2">
        {!compact && <span className="text-xs font-medium text-gray-600 w-20 flex-shrink-0">Weight used</span>}
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={weight}
            onChange={(e) => { setWeight(e.target.value); setStatus(null); }}
            onBlur={commit}
            onKeyDown={onKeyDown}
            placeholder={last ? String(Number(last.weight)) : '0'}
            aria-label="Weight used (lb)"
            className={`${compact ? 'w-20' : 'w-24'} pl-2 pr-7 py-1.5 border rounded-md text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500 ${error ? 'border-red-400' : 'border-gray-300'}`}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">lb</span>
        </div>
        <input
          type="text"
          value={reps}
          onChange={(e) => { setReps(e.target.value); setStatus(null); }}
          onBlur={commit}
          onKeyDown={onKeyDown}
          placeholder="Reps"
          maxLength={40}
          aria-label="Reps done (optional)"
          className={`${compact ? 'w-16' : 'w-20'} px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
        />
        {status === 'saving' && <span className="text-xs text-gray-400">Saving…</span>}
        {status === 'saved' && <Check size={14} className="text-green-600 flex-shrink-0" aria-label="Saved" />}
      </div>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
      {lastHint && <div className={`text-xs text-gray-500 mt-1`}>{lastHint}</div>}
    </div>
  );
}
