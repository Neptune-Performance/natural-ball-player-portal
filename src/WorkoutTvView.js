import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minimize2, Minus, Plus } from 'lucide-react';

// #493: full-screen view of one workout for the weight-room TV.
//
// Cordell casts a laptop or iPad to the TV and the workout card only showed
// six exercises at a time inside a small scrolling box. This takes over the
// whole screen (and asks the browser for real full screen where it is
// allowed — iPhone Safari is not, the view still fills the window there),
// lays every exercise out in columns, and shrinks the text until the whole
// workout fits without scrolling. A− / A+ override the automatic size.
//
// Read-only on purpose: no weight boxes, no video links. Logging stays on the
// normal card.

const MAX_PX = 34;
const MIN_PX = 11;

// groups: [{ key, label, bar, exercises: [{ id, name, sets, reps, load, rest, super_set, description }] }]
export default function WorkoutTvView({ title, subtitle, notes, groups, onClose }) {
  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  const [px, setPx] = useState(MAX_PX);
  const [auto, setAuto] = useState(true);
  const [fitTick, setFitTick] = useState(0);
  const enteredFullscreen = useRef(false);

  // Real full screen when the browser allows it. Leaving it (Esc, or the
  // browser's own control) closes this view too.
  useEffect(() => {
    const el = rootRef.current;
    const request = el && (el.requestFullscreen || el.webkitRequestFullscreen);
    if (request) {
      Promise.resolve(request.call(el))
        .then(() => { enteredFullscreen.current = true; })
        .catch(() => {});
    }
    const onChange = () => {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (!active && enteredFullscreen.current) onClose();
      setFitTick(t => t + 1);
    };
    const onResize = () => setFitTick(t => t + 1);
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      window.removeEventListener('resize', onResize);
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (active && exit) Promise.resolve(exit.call(document)).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A resize (or entering full screen) restarts the fit from the top size.
  useEffect(() => {
    if (auto) setPx(MAX_PX);
  }, [fitTick, auto]);

  // Auto-fit: step the text down until nothing overflows the screen.
  useLayoutEffect(() => {
    if (!auto) return;
    const body = bodyRef.current;
    if (!body) return;
    const overflows = body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1;
    if (overflows && px > MIN_PX) setPx(px - 1);
  }, [px, auto, fitTick, groups]);

  const bump = (d) => {
    setAuto(false);
    setPx(v => Math.max(MIN_PX, Math.min(60, v + d)));
  };

  const count = groups.reduce((n, g) => n + g.exercises.length, 0);
  // More exercises → more columns, so each line stays as large as possible.
  const columns = count > 16 ? 3 : count > 7 ? 2 : 1;

  return (
    <div ref={rootRef} className="fixed inset-0 z-[80] bg-gray-950 text-white flex flex-col" style={{ fontSize: `${px}px` }}>
      <div className="flex items-center justify-between gap-4 px-6 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="min-w-0">
          <div className="font-bold truncate" style={{ fontSize: '1.15em', lineHeight: 1.2 }}>{title}</div>
          {subtitle && <div className="text-gray-400 truncate" style={{ fontSize: '0.6em' }}>{subtitle}</div>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 text-sm">
          <button onClick={() => bump(-2)} className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700" title="Smaller text" aria-label="Smaller text"><Minus size={18} /></button>
          <button onClick={() => bump(2)} className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700" title="Larger text" aria-label="Larger text"><Plus size={18} /></button>
          {!auto && (
            <button onClick={() => setAuto(true)} className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700" title="Fit the whole workout on screen">Fit</button>
          )}
          <button onClick={onClose} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700" title="Exit full screen (Esc)">
            <Minimize2 size={18} /> Exit
          </button>
        </div>
      </div>

      <div ref={bodyRef} className={`flex-1 min-h-0 px-6 py-4 ${auto ? 'overflow-hidden' : 'overflow-auto'}`}>
        {notes && (
          <div className="mb-3 text-gray-300 whitespace-pre-wrap" style={{ fontSize: '0.6em' }}>{notes}</div>
        )}
        {count === 0 ? (
          <div className="text-gray-500 text-center py-10" style={{ fontSize: '0.8em' }}>No exercises in this workout.</div>
        ) : (
          <div style={{ columnCount: columns, columnGap: '2em' }}>
            {groups.map(g => (
              <div key={g.key} className="mb-[0.7em]">
                <div className="flex items-center mb-[0.25em]" style={{ breakAfter: 'avoid' }}>
                  <div className={`w-[0.25em] h-[0.9em] rounded-sm mr-[0.4em] ${g.bar}`} />
                  <div className="font-bold uppercase tracking-wide text-gray-300" style={{ fontSize: '0.6em' }}>{g.label}</div>
                </div>
                {g.exercises.map((ex, i) => (
                  <div
                    key={ex.id || i}
                    className="flex items-baseline justify-between gap-[0.8em] border-b border-gray-800 py-[0.18em]"
                    style={{ breakInside: 'avoid' }}
                  >
                    <div className="min-w-0 flex items-baseline">
                      {ex.super_set && (
                        <span className="mr-[0.4em] px-[0.35em] rounded bg-indigo-500 text-white font-bold uppercase flex-shrink-0" style={{ fontSize: '0.6em' }}>
                          {ex.super_set}
                        </span>
                      )}
                      <span className="font-semibold break-words" style={{ lineHeight: 1.15 }}>{ex.name}</span>
                    </div>
                    <div className="flex items-baseline gap-[0.7em] flex-shrink-0 text-right tabular-nums" style={{ fontSize: '0.85em' }}>
                      <span className="font-bold text-emerald-300 whitespace-nowrap">
                        {ex.sets || '—'} × {ex.reps || '—'}
                      </span>
                      {(ex.load || ex.weight) && <span className="text-amber-300 whitespace-nowrap">{ex.load || ex.weight}</span>}
                      {ex.rest && <span className="text-gray-400 whitespace-nowrap" style={{ fontSize: '0.8em' }}>rest {ex.rest}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
