// #484: shared bits for the check-in modal and the catch-up list — one icon
// and one coloured label per category (Lift / Practice / Game / Session).
import React from 'react';
import { Dumbbell, Users, Trophy, CalendarClock } from 'lucide-react';
import { CHECKIN_CATEGORIES } from './athleteCheckins';

const STYLE = {
  workout: { Icon: Dumbbell, icon: 'text-blue-600', badge: 'bg-blue-50 text-blue-700' },
  practice: { Icon: Users, icon: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700' },
  game: { Icon: Trophy, icon: 'text-amber-600', badge: 'bg-amber-50 text-amber-700' },
  session: { Icon: CalendarClock, icon: 'text-purple-600', badge: 'bg-purple-50 text-purple-700' },
};

export function CategoryIcon({ type, size = 16, className = '' }) {
  const s = STYLE[type] || STYLE.workout;
  return <s.Icon size={size} className={`${s.icon} shrink-0 ${className}`} />;
}

export function CategoryBadge({ type }) {
  const s = STYLE[type] || STYLE.workout;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${s.badge}`}>
      {CHECKIN_CATEGORIES[type]?.label || type}
    </span>
  );
}

export function fmtTime(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}
