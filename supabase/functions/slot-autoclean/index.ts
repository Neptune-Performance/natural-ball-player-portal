// #470: auto-remove unbooked coach sessions 6 hours before they start.
//
// Cordell: "remove those sessions 6 hours before their start time if no one
// has booked them so they are not hanging onto schedule for a late signup."
//
// Called hourly by api/slot-autoclean.js (Vercel cron) with the service-role
// key. Keeps verify_jwt=true like weekly-reminders: the service-role key IS a
// valid project JWT, so it passes the gateway, and the handler then insists on
// the service_role claim (or a staff user's JWT, for hand-runs).
//
// One run:
//   1. Expand every training_slots occurrence on facility-today and
//      facility-tomorrow (the 6h window can cross midnight) with the SAME rules
//      every other reader uses (src/scheduleUtils.js buildSlotExceptionMap /
//      getSlotDateException / collectMovedSlots; public-availability):
//        - weekly masters + one-off slots, skipping any date that has ANY
//          exception child row (tombstone or #292 move);
//        - #292 moved children (is_exception=false) on their own slot_date;
//        - tombstones (is_exception=true) never.
//   2. Keep occurrences that start in (now, now + 6h] facility time.
//   3. Drop any with a live booking — slot_booked_counts(), the one counter
//      for capacity (#428): pending/confirmed slot_reservations +
//      pending_payment/confirmed public_bookings. A moved child is also
//      checked under its master + original_date, to be safe.
//   4. Cancel the rest exactly the way the calendar's "Delete → this one"
//      does (deleteVirtualOccurrence in Schedule.js), marked with
//      auto_removed_at / auto_removed_reason:
//        - series date or one-off → INSERT a tombstone child
//          (one-offs: keyed on their own id; every reader honours it, and it
//          avoids a DELETE that would cascade away reservation history);
//        - moved child → UPDATE it to is_exception = true (it already is the
//          exception row for its series date; the unique index forbids a
//          second one).
//      Unlike the manual delete it does NOT touch slot_reservations: there
//      are no live ones by construction, and declined / cancelled rows keep
//      their #306 cancel_reason history.
//   5. Re-count bookings for what was just removed; if one slipped in between
//      steps 3 and 4, undo that removal. (Athletes and /book both stop taking
//      bookings 12h before start, so this is belt-and-braces.)
//
// Re-running is harmless: a removed occurrence is no longer expanded, and a
// duplicate tombstone insert hits the unique index (23505) and is skipped.
//
// Query params: ?dry_run=1 (report what WOULD be removed, write nothing),
// ?limit=N (remove at most N), ?hours=H (window, default 6, 1–24),
// ?coach_id=<uuid> (restrict to one coach).
//
// Env: FACILITY_TIMEZONE (default America/Los_Angeles — the facility is in
// Kirkland, WA). NOTE _shared/availability.ts defaults to America/Chicago and
// that secret is not set, so its occurrenceStartMs is NOT used here.
// SLOT_AUTOCLEAN_EXCLUDE_COACH_IDS: comma-separated coach user ids to never
// touch (e.g. the "NBP+ Strength and Conditioning" group-session account) —
// unset = every coach.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { trainingSlotOccurrences } from "../_shared/availability.ts";

const FACILITY_TZ = Deno.env.get("FACILITY_TIMEZONE") || "America/Los_Angeles";
const DEFAULT_HOURS = 6;
const REASON = "unbooked_6h";
const PAGE = 1000;

type Slot = {
  id: string;
  coach_id: string;
  slot_date: string;
  start_time: string;
  duration_minutes: number | null;
  repeat_weekly: boolean | null;
  repeat_end_date: string | null;
  recurrence_parent_id: string | null;
  original_date: string | null;
  is_exception: boolean | null;
  is_public: boolean | null;
  is_subscription_session: boolean | null;
  store_product_ids: string[] | null;
  max_players: number | null;
  notes: string | null;
  session_type: string | null;
};

type Candidate = {
  kind: "series" | "oneoff" | "moved";
  slot: Slot;            // the row whose id the bookings are keyed on
  date: string;          // occurrence date (facility-local)
  masterId: string;      // series master (= slot.id for series / one-off)
  seriesDate: string;    // the series date this occurrence stands for
  startMs: number;
};

const SLOT_COLS =
  "id, coach_id, slot_date, start_time, duration_minutes, repeat_weekly, repeat_end_date, recurrence_parent_id, original_date, is_exception, is_public, is_subscription_session, store_product_ids, max_players, notes, session_type";

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function decodeJwtRole(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

// Facility-local calendar date for an instant, as YYYY-MM-DD.
function facilityDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: FACILITY_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Facility-local wall clock (date + HH:MM[:SS]) → epoch ms. Same two-pass DST
// correction as _shared/availability.ts occurrenceStartMs, but with this
// function's timezone.
function facilityStartMs(dateStr: string, timeStr: string | null): number {
  const t = (timeStr || "00:00").slice(0, 5);
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi);
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

// PostgREST clamps every response at 1,000 rows (#437) — page through.
// deno-lint-ignore no-explicit-any
async function readAll(build: () => any): Promise<{ rows: Slot[]; error: string | null }> {
  const out: Slot[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { rows: out, error: error.message };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows: out, error: null };
}

// "slotId_date" → live booking count, via the canonical capacity RPC.
async function bookedMap(service: SupabaseClient, ids: string[], start: string, end: string) {
  const map = new Map<string, number>();
  if (!ids.length) return { map, error: null as string | null };
  const { data, error } = await service.rpc("slot_booked_counts", { p_slot_ids: ids, p_start: start, p_end: end });
  if (error) return { map, error: error.message };
  for (const r of data || []) map.set(`${r.slot_id}_${r.slot_date}`, Number(r.booked) || 0);
  return { map, error: null };
}

function isBooked(map: Map<string, number>, c: Candidate): boolean {
  if ((map.get(`${c.slot.id}_${c.date}`) || 0) > 0) return true;
  // Moved child: a booking still keyed on the series date would be a #292
  // repoint that didn't happen — count it rather than strand it.
  if (c.kind === "moved" && (map.get(`${c.masterId}_${c.seriesDate}`) || 0) > 0) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST" && req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = createClient(supabaseUrl, serviceKey);

  // ---- auth: service role (cron) or a staff user (hand-run) ----------------
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json(req, { error: "Missing authorization header" }, 401);
  let via = "service";
  if (token !== serviceKey && decodeJwtRole(token) !== "service_role") {
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json(req, { error: "Unauthorized" }, 401);
    const { data: me } = await service.from("users").select("role").eq("id", user.id).maybeSingle();
    if (!me || !["admin", "coach"].includes(me.role)) return json(req, { error: "Unauthorized: staff only" }, 403);
    via = `staff:${user.id}`;
  }

  const url = new URL(req.url);
  const dryRun = ["1", "true"].includes(url.searchParams.get("dry_run") || "");
  const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
  const hoursRaw = parseFloat(url.searchParams.get("hours") || "");
  const hours = Number.isFinite(hoursRaw) ? Math.min(24, Math.max(1, hoursRaw)) : DEFAULT_HOURS;
  const onlyCoach = url.searchParams.get("coach_id");
  const excluded = new Set(
    (Deno.env.get("SLOT_AUTOCLEAN_EXCLUDE_COACH_IDS") || "").split(",").map((s) => s.trim()).filter(Boolean),
  );

  const nowMs = Date.now();
  const windowEndMs = nowMs + hours * 3600_000;
  const today = facilityDate(nowMs);
  const lastDay = facilityDate(windowEndMs); // today or tomorrow
  const dates = today === lastDay ? [today] : [today, lastDay];

  // ---- 1. rows ---------------------------------------------------------------
  // Masters + one-offs that could have an occurrence on `dates`. Ended series
  // are filtered below (two .or() filters can't be combined here).
  const mastersRes = await readAll(() => {
    let q = service.from("training_slots").select(SLOT_COLS)
      .is("recurrence_parent_id", null)
      .lte("slot_date", lastDay)
      .or(`repeat_weekly.eq.true,slot_date.gte.${today}`)
      .order("id");
    if (onlyCoach) q = q.eq("coach_id", onlyCoach);
    return q;
  });
  if (mastersRes.error) return json(req, { error: `training_slots masters query failed: ${mastersRes.error}` }, 500);

  // Every exception child for those dates — by series date (skips) and by own
  // date (moved occurrences).
  const dateList = dates.join(",");
  const childRes = await readAll(() => {
    let q = service.from("training_slots").select(SLOT_COLS)
      .not("recurrence_parent_id", "is", null)
      .or(`original_date.in.(${dateList}),slot_date.in.(${dateList})`)
      .order("id");
    if (onlyCoach) q = q.eq("coach_id", onlyCoach);
    return q;
  });
  if (childRes.error) return json(req, { error: `training_slots exceptions query failed: ${childRes.error}` }, 500);

  const exceptionKeys = new Set<string>();
  for (const c of childRes.rows) {
    if (c.recurrence_parent_id && c.original_date) exceptionKeys.add(`${c.recurrence_parent_id}_${c.original_date}`);
  }

  // ---- 2. expand + window ------------------------------------------------------
  // availability.ts works on runtime-local (UTC) Date objects at T12:00, so a
  // [first 00:00, last 23:59] range picks out exactly these calendar dates.
  const rangeStart = new Date(`${today}T00:00:00`);
  const rangeEnd = new Date(`${lastDay}T23:59:59`);
  const candidates: Candidate[] = [];
  for (const m of mastersRes.rows) {
    if (m.repeat_weekly && m.repeat_end_date && m.repeat_end_date < today) continue;
    for (const date of trainingSlotOccurrences({ ...m, repeat_weekly: !!m.repeat_weekly }, rangeStart, rangeEnd)) {
      if (exceptionKeys.has(`${m.id}_${date}`)) continue; // tombstoned or moved away
      candidates.push({
        kind: m.repeat_weekly ? "series" : "oneoff",
        slot: m, date, masterId: m.id, seriesDate: date,
        startMs: facilityStartMs(date, m.start_time),
      });
    }
  }
  for (const c of childRes.rows) {
    if (c.is_exception !== false) continue; // tombstone: never an occurrence
    if (!dates.includes(c.slot_date)) continue;
    candidates.push({
      kind: "moved", slot: c, date: c.slot_date,
      masterId: c.recurrence_parent_id!, seriesDate: c.original_date || c.slot_date,
      startMs: facilityStartMs(c.slot_date, c.start_time),
    });
  }

  const inWindow = candidates.filter((c) => c.startMs > nowMs && c.startMs <= windowEndMs);
  const skippedExcluded = inWindow.filter((c) => excluded.has(c.slot.coach_id)).length;
  const considered = inWindow.filter((c) => !excluded.has(c.slot.coach_id));

  // ---- 3. bookings ---------------------------------------------------------------
  const idSet = new Set<string>();
  for (const c of considered) { idSet.add(c.slot.id); idSet.add(c.masterId); }
  const ids = [...idSet];
  const booked = await bookedMap(service, ids, today, lastDay);
  if (booked.error) return json(req, { error: `slot_booked_counts failed: ${booked.error}` }, 500);

  let toRemove = considered.filter((c) => !isBooked(booked.map, c)).sort((a, b) => a.startMs - b.startMs);
  const keptBooked = considered.length - toRemove.length;
  if (limit) toRemove = toRemove.slice(0, limit);

  // Coach names for the report.
  const coachIds = [...new Set(toRemove.map((c) => c.slot.coach_id))];
  const coachNames = new Map<string, string>();
  if (coachIds.length) {
    const { data: coaches } = await service.from("users").select("id, full_name").in("id", coachIds);
    for (const u of coaches || []) coachNames.set(u.id, u.full_name);
  }
  const describe = (c: Candidate) => ({
    kind: c.kind,
    slot_id: c.slot.id,
    master_id: c.masterId,
    date: c.date,
    start_time: (c.slot.start_time || "").slice(0, 5),
    starts_in_min: Math.round((c.startMs - nowMs) / 60000),
    coach: coachNames.get(c.slot.coach_id) || c.slot.coach_id,
    notes: c.slot.notes,
    max_players: c.slot.max_players,
    is_public: !!c.slot.is_public,
  });

  const summary = {
    ok: true, via, dry_run: dryRun, timezone: FACILITY_TZ, hours,
    now: new Date(nowMs).toISOString(), dates,
    occurrences_on_dates: candidates.length,
    in_window: inWindow.length,
    skipped_excluded_coach: skippedExcluded,
    kept_booked: keptBooked,
  };

  if (dryRun) {
    return json(req, { ...summary, would_remove: toRemove.length, occurrences: toRemove.map(describe) });
  }

  // ---- 4. remove ------------------------------------------------------------------
  const stampedAt = new Date().toISOString();
  type Done = { c: Candidate; rowId: string; undo: "delete" | "unflip" };
  const done: Done[] = [];
  const failed: Array<Record<string, unknown>> = [];
  let alreadyGone = 0;

  for (const c of toRemove) {
    if (c.kind === "moved") {
      const { data, error } = await service.from("training_slots")
        .update({ is_exception: true, auto_removed_at: stampedAt, auto_removed_reason: REASON })
        .eq("id", c.slot.id).eq("is_exception", false)
        .select("id");
      if (error) { failed.push({ ...describe(c), error: error.message }); continue; }
      if (!data || !data.length) { alreadyGone++; continue; }
      done.push({ c, rowId: c.slot.id, undo: "unflip" });
      continue;
    }
    // Same shape as deleteVirtualOccurrence (Schedule.js), + the #470 stamp.
    const s = c.slot;
    const { data, error } = await service.from("training_slots").insert({
      recurrence_parent_id: c.masterId,
      original_date: c.date,
      slot_date: c.date,
      is_exception: true,
      repeat_weekly: false,
      coach_id: s.coach_id,
      start_time: s.start_time,
      duration_minutes: s.duration_minutes,
      is_public: s.is_public,
      is_subscription_session: s.is_subscription_session,
      store_product_ids: s.store_product_ids,
      auto_removed_at: stampedAt,
      auto_removed_reason: REASON,
    }).select("id").single();
    if (error) {
      // 23505: an exception for this date appeared since step 1 — a coach
      // deleted or moved it meanwhile. Nothing to do.
      if (error.code === "23505") { alreadyGone++; continue; }
      failed.push({ ...describe(c), error: error.message });
      continue;
    }
    done.push({ c, rowId: data.id, undo: "delete" });
  }

  // ---- 5. race re-check -------------------------------------------------------------
  let undone = 0;
  if (done.length) {
    const recheckIds = [...new Set(done.flatMap((d) => [d.c.slot.id, d.c.masterId]))];
    const again = await bookedMap(service, recheckIds, today, lastDay);
    if (again.error) {
      failed.push({ error: `post-removal re-check failed (removals kept): ${again.error}` });
    } else {
      for (const d of [...done]) {
        if (!isBooked(again.map, d.c)) continue;
        const { error } = d.undo === "delete"
          ? await service.from("training_slots").delete().eq("id", d.rowId)
          : await service.from("training_slots")
            .update({ is_exception: false, auto_removed_at: null, auto_removed_reason: null }).eq("id", d.rowId);
        if (error) { failed.push({ ...describe(d.c), error: `booked mid-run; undo failed: ${error.message}` }); continue; }
        done.splice(done.indexOf(d), 1);
        undone++;
      }
    }
  }

  return json(req, {
    ...summary,
    removed: done.length,
    already_gone: alreadyGone,
    undone_booked_mid_run: undone,
    failed: failed.length,
    failures: failed.slice(0, 20),
    occurrences: done.map((d) => ({ ...describe(d.c), exception_row_id: d.rowId })),
  }, failed.length && !done.length ? 500 : 200);
});
