// Recurrence expansion for public booking availability. Ported from the client
// helper src/scheduleUtils.js so the public-availability edge function computes
// the SAME occurrence dates the staff calendar shows. Keep the two in sync.

export function fmtLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Rule = {
  freq?: string;
  interval?: number;
  byDay?: string[];
  count?: number;
  until?: string;
};

// Occurrence dates for a facility_events recurrence_rule within [rangeStart, rangeEnd].
export function generateOccurrenceDates(
  startDate: string,
  rule: Rule | null,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  const dates: Date[] = [];
  if (!rule || !rule.freq) return dates;
  const start = new Date(startDate + "T12:00:00");
  const interval = rule.interval || 1;
  const maxCount = rule.count || 365;
  const until = rule.until ? new Date(rule.until + "T23:59:59") : null;
  const current = new Date(start);
  let count = 0;
  while (count < maxCount) {
    if (until && current > until) break;
    if (current > rangeEnd) break;
    if (current >= rangeStart && current <= rangeEnd) dates.push(new Date(current));
    switch (rule.freq) {
      case "daily":
        current.setDate(current.getDate() + interval);
        break;
      case "weekly":
        if (rule.byDay && rule.byDay.length > 0) {
          const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
          const startOfWeek = (d: Date) => {
            const s = new Date(d);
            s.setDate(s.getDate() - s.getDay());
            s.setHours(0, 0, 0, 0);
            return s;
          };
          const baseWeek = startOfWeek(start);
          let guard = 0;
          const maxSteps = 7 * interval + 7;
          do {
            current.setDate(current.getDate() + 1);
            guard++;
            const inByDay = rule.byDay.includes(dayCodes[current.getDay()]);
            const weekIdx = Math.round(
              (startOfWeek(current).getTime() - baseWeek.getTime()) / (7 * 86400000),
            );
            if (inByDay && weekIdx % interval === 0) break;
          } while (guard < maxSteps);
        } else {
          current.setDate(current.getDate() + 7 * interval);
        }
        break;
      case "monthly":
        current.setMonth(current.getMonth() + interval);
        break;
      case "yearly":
        current.setFullYear(current.getFullYear() + interval);
        break;
      default:
        return dates;
    }
    count++;
  }
  return dates;
}

// All occurrence date strings for one facility_event (recurring or single) that
// fall within [rangeStart, rangeEnd] and are not before `todayStr`.
export function facilityEventOccurrences(
  ev: { event_date: string; is_recurring?: boolean; recurrence_rule?: Rule | null },
  rangeStart: Date,
  rangeEnd: Date,
): string[] {
  if (ev.is_recurring && ev.recurrence_rule) {
    return generateOccurrenceDates(ev.event_date, ev.recurrence_rule, rangeStart, rangeEnd)
      .map(fmtLocalDate);
  }
  // Single event: include only if it lands in range.
  const d = new Date(ev.event_date + "T12:00:00");
  if (d >= rangeStart && d <= rangeEnd) return [ev.event_date];
  return [];
}

// All occurrence date strings for a weekly-recurring (or single) training_slot.
export function trainingSlotOccurrences(
  slot: { slot_date: string; repeat_weekly?: boolean; repeat_end_date?: string | null },
  rangeStart: Date,
  rangeEnd: Date,
): string[] {
  const first = new Date(slot.slot_date + "T12:00:00");
  if (!slot.repeat_weekly) {
    if (first >= rangeStart && first <= rangeEnd) return [slot.slot_date];
    return [];
  }
  const out: string[] = [];
  const end = slot.repeat_end_date ? new Date(slot.repeat_end_date + "T23:59:59") : null;
  const cur = new Date(first);
  let guard = 0;
  while (guard < 400) {
    guard++;
    if (cur > rangeEnd) break;
    if (end && cur > end) break;
    if (cur >= rangeStart && cur <= rangeEnd) out.push(fmtLocalDate(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return out;
}

// end time = start + duration (minutes), as HH:MM.
export function addMinutes(startTime: string, mins: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Occurrence start as epoch ms. Event/slot times are stored as facility-local
// wall clock with no zone, while edge functions run in UTC — so convert via the
// facility IANA timezone.
// #502: the default was America/Chicago, and FACILITY_TIMEZONE has never been
// set, so every public-booking cutoff was computed two hours early (a 3:00 PM
// Kirkland session was treated as 3:00 PM Central = 1:00 PM Pacific). The
// facility is in Kirkland, WA; this now matches every other function's default.
const FACILITY_TZ = Deno.env.get("FACILITY_TIMEZONE") || "America/Los_Angeles";

export function occurrenceStartMs(dateStr: string, timeStr?: string | null): number {
  const t = (timeStr || "00:00").slice(0, 5);
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Start from the UTC guess, then correct by the offset Intl reports for that
  // instant; a second pass settles instants that straddle a DST transition.
  let ts = wallUtc;
  for (let i = 0; i < 2; i++) {
    const parts: Record<string, string> = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: FACILITY_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ts)).forEach((p) => { parts[p.type] = p.value; });
    const asIf = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    ts += wallUtc - asIf;
  }
  return ts;
}
