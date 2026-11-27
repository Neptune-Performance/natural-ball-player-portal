// #496 — the "3 things to work on" views on the Player Card (staff only).
// What is recommended, and why, lives in src/playerFocus.js (the config);
// this file (FocusAreas.js, named apart from it on purpose: macOS file names
// are case-insensitive, so a PlayerFocus.js would BE playerFocus.js) only
// draws it: the list itself, the hover pop-up over a skill bar, and the
// coach's top-3 card under the Player Card.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, PlayCircle, Target } from 'lucide-react';
import { TAG_LABELS, FOCUS_COUNT } from './playerFocus';

// Full class strings so Tailwind keeps them.
const TAG_DARK = {
  priority: 'bg-red-500 text-white',
  develop: 'bg-orange-400 text-orange-950',
  sharpen: 'bg-emerald-400 text-emerald-950',
  flagged: 'bg-fuchsia-300 text-fuchsia-950',
  baseline: 'bg-white/15 text-white/80',
};
const TAG_LIGHT = {
  priority: 'bg-red-100 text-red-700',
  develop: 'bg-orange-100 text-orange-800',
  sharpen: 'bg-emerald-100 text-emerald-800',
  flagged: 'bg-fuchsia-100 text-fuchsia-800',
  baseline: 'bg-gray-100 text-gray-600',
};

function DrillLine({ drill, dark }) {
  const muted = dark ? 'text-white/60' : 'text-gray-500';
  const strong = dark ? 'text-white/90' : 'text-gray-800';
  const link = dark ? 'text-brand-cream hover:text-white underline decoration-white/30' : 'text-blue-700 hover:text-blue-900 underline decoration-blue-300';

  if (drill.kind === 'habit') {
    return <li className={`flex gap-1.5 ${strong}`}><span className={muted}>•</span><span>{drill.name}</span></li>;
  }
  if (drill.kind === 'video') {
    return (
      <li className="flex items-start gap-1.5">
        <PlayCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${drill.url ? (dark ? 'text-brand-cream' : 'text-blue-600') : muted}`} />
        {drill.url ? (
          <a href={drill.url} target="_blank" rel="noopener noreferrer" className={link} title="Open the drill video">{drill.name}</a>
        ) : (
          <span className={strong}>{drill.name}</span>
        )}
      </li>
    );
  }
  // 'check': corrective drills for one mechanical cause.
  return (
    <li className="flex items-start gap-1.5">
      <Target className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${muted}`} />
      <span>
        {drill.forDeficiency && <span className={muted}>If you see “{drill.forDeficiency}”: </span>}
        <span className={strong}>{drill.name}</span>
        {drill.url && (
          <a href={drill.url} target="_blank" rel="noopener noreferrer" className={`ml-1 inline-flex items-center gap-0.5 whitespace-nowrap ${link}`} title={drill.linkLabel || 'Source'}>
            source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </span>
    </li>
  );
}

/**
 * The numbered list. `showCategory` adds the skill name (used by the top-3
 * card, where the three items are three different skills).
 */
export function FocusList({ items, empty, dark = false, showCategory = false }) {
  const muted = dark ? 'text-white/60' : 'text-gray-500';
  if (!items || items.length === 0) {
    return <p className={`text-xs ${muted}`}>{empty || 'Nothing to recommend yet.'}</p>;
  }
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={item.id} className="flex gap-2.5">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-black ${dark ? 'bg-white/15 text-white' : 'bg-brand-ink text-brand-cream'}`}>{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`text-sm font-semibold ${dark ? 'text-white' : 'text-gray-900'}`}>{item.title}</span>
              {item.tag && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${(dark ? TAG_DARK : TAG_LIGHT)[item.tag] || ''}`}>
                  {TAG_LABELS[item.tag] || item.tag}
                </span>
              )}
              {showCategory && <span className={`text-[10px] font-semibold uppercase tracking-wider ${muted}`}>{item.categoryLabel}</span>}
            </div>
            <p className={`mt-0.5 text-[11px] ${muted}`}>
              {item.detail}{item.basis ? ` · ${item.basis}` : ''}
            </p>
            {item.drills.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-xs">
                {item.drills.map((d, j) => <DrillLine key={j} drill={d} dark={dark} />)}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const POPOVER_WIDTH = 348;

/**
 * Pop-up shown while the pointer is over a skill bar. It is rendered in a
 * portal with fixed positioning because the card clips its own overflow.
 * `anchor` is the bar's bounding rect at the moment it was hovered.
 */
export function FocusPopover({ anchor, label, entry, onEnter, onLeave, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(POPOVER_WIDTH, vw - 16);
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, vw - width - 8));
    const height = ref.current ? ref.current.offsetHeight : 320;
    const below = vh - anchor.bottom - 12;
    const above = anchor.top - 12;
    // Prefer below the bar; go above when it does not fit and there is more room there.
    if (height <= below || below >= above) setPos({ left, width, top: anchor.bottom + 8, maxHeight: Math.max(160, below) });
    else setPos({ left, width, bottom: vh - anchor.top + 8, maxHeight: Math.max(160, above) });
  }, [anchor, entry]);

  // A fixed pop-up would drift off its bar when the page scrolls, so close it
  // (scrolling inside the pop-up itself is fine).
  useEffect(() => {
    const onScroll = (e) => { if (!ref.current || !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (!anchor || !entry) return null;
  const style = pos
    ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }
    : { left: -9999, top: 0, width: POPOVER_WIDTH, visibility: 'hidden' };

  return createPortal(
    <div
      ref={ref} role="tooltip" style={style}
      onMouseEnter={onEnter} onMouseLeave={onLeave}
      className="fixed z-[90] overflow-y-auto rounded-xl bg-brand-900 p-3.5 text-white shadow-2xl ring-1 ring-white/20"
    >
      <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.16em] text-brand-cream">
        {label} · {entry.items.length > 0 ? `${Math.min(FOCUS_COUNT, entry.items.length)} to work on` : 'focus areas'}
      </p>
      <FocusList items={entry.items} empty={entry.empty} dark />
    </div>,
    document.body
  );
}

/** The coach's cross-skill summary under the Player Card. */
export function CoachFocusCard({ top, name }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Target className="h-4 w-4 text-brand-500" /> Top {FOCUS_COUNT} to work on{name ? ` with ${name.split(/\s+/)[0]}` : ''}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            The weakest area in each of this athlete's lowest skills, from their assessment, lifting and tracking numbers and any Mechanics notes. Only coaches see this. Hover or tap a skill bar on the card for that skill's own three.
          </p>
        </div>
      </div>
      <div className="mt-3">
        <FocusList
          items={top} showCategory
          empty="There are no graded numbers or Mechanics notes on file yet, so there is nothing to rank. An assessment is the fastest way to get focus areas."
        />
      </div>
    </div>
  );
}
