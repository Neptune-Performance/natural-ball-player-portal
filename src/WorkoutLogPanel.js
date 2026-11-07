// #475: weight + reps entry for one athlete's workout, outside the calendar
// modal. Used by the Coach Tools Lift Entry sheet (one panel per athlete on
// the floor) and by staff on the athlete's profile Lift Log. Same rows, same
// save-on-blur boxes as WorkoutDetailModal; created_by records who typed it.

import React, { useState, useEffect } from 'react';
import ExerciseLogInput from './ExerciseLogInput';
import {
  loadWorkoutExercises, fetchWorkoutLogs, fetchLastLogs, commitExerciseLog,
  exerciseNameKey, canLogWorkout,
} from './exerciseLogs';

export default function WorkoutLogPanel({ event, playerId, userId, onLogsChange }) {
  const [exercises, setExercises] = useState([]);
  const [logs, setLogs] = useState({});
  const [lastLogs, setLastLogs] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const canLog = canLogWorkout(event);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { exercises: ex } = await loadWorkoutExercises(event);
        const [mine, last] = ex.length > 0
          ? await Promise.all([
              fetchWorkoutLogs(event.id, playerId),
              fetchLastLogs(playerId, ex.map(e => exerciseNameKey(e.name)), event.event_date, event.id),
            ])
          : [{}, {}];
        if (cancelled) return;
        setExercises(ex);
        setLogs(mine);
        setLastLogs(last);
      } catch (err) {
        console.error('Error loading workout for lift entry:', err);
        if (!cancelled) setError('Could not load this workout.');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [event, playerId]);

  const saveLog = async (ex, weightText, repsText) => {
    const key = String(ex.id);
    const existing = logs[key];
    const row = await commitExerciseLog({ event, playerId, exercise: ex, weightText, repsText, existing, createdBy: userId });
    setLogs(prev => {
      const next = { ...prev };
      if (row) next[key] = row; else delete next[key];
      return next;
    });
    if (onLogsChange) onLogsChange((row && !existing) ? 1 : (!row && existing) ? -1 : 0);
  };

  if (loading) return <div className="py-4 text-sm text-gray-500">Loading workout…</div>;
  if (error) return <div className="py-4 text-sm text-red-600">{error}</div>;
  if (exercises.length === 0) return <div className="py-4 text-sm text-gray-400">No exercises in this workout.</div>;

  return (
    <div className="divide-y divide-gray-100">
      {exercises.map((ex) => {
        const target = [ex.sets && ex.reps ? `${ex.sets}×${ex.reps}` : (ex.sets || ex.reps), ex.load || ex.weight].filter(Boolean).join(' · ');
        return (
          <div key={ex.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-2">
            <div className="min-w-0 sm:w-56 sm:flex-shrink-0">
              <div className="flex items-center gap-1.5">
                {ex.super_set && (
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase flex-shrink-0">
                    {ex.super_set}
                  </span>
                )}
                <span className="font-medium text-gray-900 text-sm break-words">{ex.name}</span>
              </div>
              {target && <div className="text-xs text-gray-500 mt-0.5 tabular-nums">{target}</div>}
            </div>
            {canLog ? (
              <ExerciseLogInput
                compact
                log={logs[String(ex.id)]}
                last={lastLogs[exerciseNameKey(ex.name)]}
                onSave={(w, r) => saveLog(ex, w, r)}
              />
            ) : (
              <div className="text-xs text-gray-400 sm:pt-2">Opens on the day of the workout</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
