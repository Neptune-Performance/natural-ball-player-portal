// #469: tell coaches about their tasks (Admin Settings → Coach Tasks).
//
// Two actions:
//   ?action=assigned&task_id=<uuid>[,<uuid>...]  (or body {task_ids: [...]})
//       Called by the admin's browser right after a task is inserted or
//       reassigned (src/coachTaskNotify.js). One message per task to its
//       assignee.
//   ?action=daily
//       Called by api/coach-task-digest.js (Vercel cron) every morning. One
//       message per coach listing what's on their plate today; coaches with
//       nothing are skipped.
//
// Channels (see CHANNELS below): email through Resend now; SMS through Twilio
// as soon as TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are
// set as function secrets. A channel that isn't configured is simply not
// used — it writes no log rows and is never an error. A configured channel
// with no address on file (no email / no usable phone) logs 'skipped'.
//
// Idempotency: every message is a coach_task_notifications row, upserted as
// 'pending' with ignoreDuplicates on (coach_id, kind, channel, dedupe_key),
// and only rows still 'pending' are sent. A retried cron, a second cron tick
// in the same day, or a double-clicked Assign can't double-send.
//
// Keeps verify_jwt=true: callers are the service-role key (cron, a valid
// project JWT) or a signed-in staff user.
//
// Testing: ?dry_run=1 (report what would go out, write nothing),
// ?user_id=<coach uuid> (restrict to one coach), ?limit=N (coaches, daily),
// ?force=1 (daily: ignore the 7am facility-time gate).

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const FROM = "NBP Portal <noreply@thenatural-app.com>";
const REPLY_TO = "admin@thenaturalballplayer.com";
const APP_URL = "https://www.thenatural-app.com";
const TASKS_URL = `${APP_URL}/?view=tasks`;
const POSTAL_ADDRESS = "The Natural Ballplayer &middot; 13424 NE 126th Pl, Kirkland, WA 98034";
const FACILITY_TZ = Deno.env.get("FACILITY_TIMEZONE") || "America/Los_Angeles";
// The cron fires at 14:00 and 15:00 UTC; only the tick at/after this local
// hour sends, so the digest lands at 7am facility time in both PDT and PST
// (the other tick is a no-op thanks to the unique key / the gate).
const DIGEST_HOUR = 7;
const SMS_MAX_CHARS = 600;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type Task = {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  frequency: string | null;
  status: string;
  priority: string | null;
  due_date: string | null;
};
type Coach = { id: string; full_name: string | null; email: string | null; phone: string | null };
type Message = { subject: string; heading: string; intro: string; sections: { label: string; tasks: Task[] }[] };
type Channel = "email" | "sms";

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

// ---- dates (facility time) ----------------------------------------------------
function facilityNow(): { date: string; hour: number; dow: number; dom: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return { date, hour: Number(get("hour")), dow, dom: Number(get("day")) };
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

// ---- formatting ---------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function firstName(full: string | null): string {
  return (full || "").trim().split(/\s+/)[0] || "Coach";
}

function bySort(a: Task, b: Task): number {
  const p = (PRIORITY_RANK[a.priority || "medium"] ?? 2) - (PRIORITY_RANK[b.priority || "medium"] ?? 2);
  if (p) return p;
  return (a.due_date || "9999").localeCompare(b.due_date || "9999") || a.title.localeCompare(b.title);
}

function taskMeta(t: Task): string {
  const bits: string[] = [];
  if (t.priority && t.priority !== "medium") bits.push(t.priority);
  if (t.frequency === "daily") bits.push(t.due_date ? `daily through ${prettyDate(t.due_date)}` : "daily");
  else if (t.due_date) bits.push(`due ${prettyDate(t.due_date)}`);
  else if (t.frequency && t.frequency !== "one-time") bits.push(t.frequency);
  return bits.join(" · ");
}

function emailHtml(name: string, m: Message): string {
  const sections = m.sections.filter((s) => s.tasks.length).map((s) => `
<p style="margin:20px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;">${escapeHtml(s.label)}</p>
${s.tasks.map((t) => {
    const meta = taskMeta(t);
    const urgent = t.priority === "urgent" || t.priority === "high";
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
<tr><td style="padding:12px 14px;background:${urgent ? "#fff7ed" : "#f9fafb"};border-radius:8px;border-left:4px solid ${urgent ? "#f97316" : "#2563eb"};">
<p style="margin:0;font-weight:700;">${escapeHtml(t.title)}</p>
${meta ? `<p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${escapeHtml(meta)}</p>` : ""}
${t.description ? `<p style="margin:6px 0 0;font-size:14px;color:#374151;white-space:pre-line;">${escapeHtml(t.description)}</p>` : ""}
</td></tr></table>`;
  }).join("\n")}`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:8px;">
<tr><td style="padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">
<p style="margin:0 0 16px;font-size:20px;font-weight:700;">${escapeHtml(m.heading)}</p>
<p style="margin:0;">Hi ${escapeHtml(name)} — ${escapeHtml(m.intro)}</p>
${sections}
<p style="margin:24px 0 0;"><a href="${TASKS_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;">Open My Tasks</a></p>
</td></tr>
<tr><td style="padding:0 28px 28px;">
<hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;">
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#9ca3af;text-align:center;">
You're getting this because tasks are assigned to you in the NBP Portal. Mark them done under Coach Tools → My Tasks.<br>
${POSTAL_ADDRESS}
</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function emailText(name: string, m: Message): string {
  const body = m.sections.filter((s) => s.tasks.length).map((s) =>
    `${s.label.toUpperCase()}\n${s.tasks.map((t) => {
      const meta = taskMeta(t);
      return `- ${t.title}${meta ? ` (${meta})` : ""}${t.description ? `\n  ${t.description.replace(/\n/g, "\n  ")}` : ""}`;
    }).join("\n")}`).join("\n\n");
  return `Hi ${name} — ${m.intro}\n\n${body}\n\nOpen My Tasks: ${TASKS_URL}\n\nThe Natural Ballplayer · 13424 NE 126th Pl, Kirkland, WA 98034`;
}

function smsText(m: Message): string {
  const lines = [m.heading];
  for (const s of m.sections) {
    if (!s.tasks.length) continue;
    if (m.sections.length > 1) lines.push(`${s.label}:`);
    for (const t of s.tasks) {
      const meta = taskMeta(t);
      lines.push(`• ${t.title}${meta ? ` (${meta})` : ""}`);
    }
  }
  const tail = `\n${TASKS_URL}`;
  let body = lines.join("\n");
  if (body.length + tail.length > SMS_MAX_CHARS) body = `${body.slice(0, SMS_MAX_CHARS - tail.length - 2)}…`;
  return body + tail;
}

// US-centric E.164: 10 digits → +1XXXXXXXXXX, 11 starting with 1 → +1…,
// an explicit +<8–15 digits> is kept. Anything else is unusable (null).
export function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ---- channels -------------------------------------------------------------------
type SendResult = { ok: boolean; id?: string | null; error?: string };
type ChannelImpl = {
  destination: (c: Coach) => string | null;
  missingReason: string;
  send: (to: string, name: string, m: Message, tags: Record<string, string>) => Promise<SendResult>;
};

function buildChannels(): Partial<Record<Channel, ChannelImpl>> {
  const out: Partial<Record<Channel, ChannelImpl>> = {};

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey) {
    out.email = {
      destination: (c) => (c.email && c.email.trim() ? c.email.trim().toLowerCase() : null),
      missingReason: "no email on file",
      send: async (to, name, m, tags) => {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: FROM, to: [to], reply_to: REPLY_TO, subject: m.subject,
              html: emailHtml(name, m), text: emailText(name, m),
              tags: Object.entries(tags).map(([k, v]) => ({ name: k, value: v.replace(/[^A-Za-z0-9_-]/g, "_") })),
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok) return { ok: true, id: body?.id ?? null };
          return { ok: false, error: body?.message || body?.error || `Resend HTTP ${res.status}` };
        } catch (e) {
          return { ok: false, error: (e as Error).message || "network error" };
        }
      },
    };
  }

  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const auth = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (sid && auth && from) {
    out.sms = {
      destination: (c) => toE164(c.phone),
      missingReason: "no usable phone number on file",
      send: async (to, _name, m) => {
        try {
          const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(`${sid}:${auth}`)}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: to, From: from, Body: smsText(m) }).toString(),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok) return { ok: true, id: body?.sid ?? null };
          return { ok: false, error: body?.message || `Twilio HTTP ${res.status}` };
        } catch (e) {
          return { ok: false, error: (e as Error).message || "network error" };
        }
      },
    };
  }
  return out;
}

// ---- messages -------------------------------------------------------------------
function assignedMessage(t: Task): Message {
  return {
    subject: `New task: ${t.title}`,
    heading: `New task: ${t.title}`,
    intro: "you've been assigned a new task in the NBP Portal.",
    sections: [{ label: t.frequency === "daily" ? "Every day" : "Task", tasks: [t] }],
  };
}

// What belongs in a coach's digest for `today` (YYYY-MM-DD, facility time):
//   Today     — daily tasks (a daily task's due_date is its END date: past it,
//               the task has run its course and is left out); non-daily tasks
//               due today; weekly tasks with no due date on Mondays; monthly
//               tasks with no due date on the 1st.
//   Overdue   — non-daily tasks whose due date has passed.
//   Coming up — non-daily tasks due in the next 6 days (context only: a
//               coach with ONLY upcoming tasks gets no message).
// Completed tasks never appear.
function digestFor(tasks: Task[], today: string, dow: number, dom: number): Message | null {
  const weekOut = addDays(today, 6);
  const todayList: Task[] = [];
  const overdue: Task[] = [];
  const upcoming: Task[] = [];
  for (const t of tasks) {
    if (t.status === "completed") continue;
    if (t.frequency === "daily") {
      if (!t.due_date || t.due_date >= today) todayList.push(t);
    } else if (t.due_date) {
      if (t.due_date < today) overdue.push(t);
      else if (t.due_date === today) todayList.push(t);
      else if (t.due_date <= weekOut) upcoming.push(t);
    } else if ((t.frequency === "weekly" && dow === 1) || (t.frequency === "monthly" && dom === 1)) {
      todayList.push(t);
    }
  }
  if (!todayList.length && !overdue.length) return null;
  const n = todayList.length + overdue.length;
  return {
    subject: `Your tasks for ${prettyDate(today)} (${n})`,
    heading: `Tasks for ${prettyDate(today)}`,
    intro: `here's what's on your plate today${overdue.length ? `, including ${overdue.length} overdue` : ""}.`,
    sections: [
      { label: "Overdue", tasks: overdue.sort(bySort) },
      { label: "Today", tasks: todayList.sort(bySort) },
      { label: "Coming up this week", tasks: upcoming.sort(bySort) },
    ],
  };
}

// ---- delivery -------------------------------------------------------------------
type Plan = { coach: Coach; message: Message; kind: "assigned" | "daily"; task_id: string | null; digest_date: string | null; task_count: number };

async function deliver(service: SupabaseClient, plans: Plan[], channels: Partial<Record<Channel, ChannelImpl>>) {
  const tally: Record<string, number> = { sent: 0, failed: 0, skipped: 0, already_done: 0 };
  const errors: string[] = [];
  const { data: blRows } = await service.from("email_blacklist").select("email");
  const blacklist = new Set((blRows || []).map((r: { email: string }) => (r.email || "").toLowerCase().trim()));

  for (const plan of plans) {
    for (const [channel, impl] of Object.entries(channels) as [Channel, ChannelImpl][]) {
      const dest = impl.destination(plan.coach);
      const blocked = channel === "email" && dest && blacklist.has(dest);
      const initial = !dest
        ? { status: "skipped", error: impl.missingReason }
        : blocked ? { status: "skipped", error: "unsubscribed" } : { status: "pending", error: null };

      const { data: inserted, error: upErr } = await service.from("coach_task_notifications")
        .upsert({
          coach_id: plan.coach.id, kind: plan.kind, task_id: plan.task_id, digest_date: plan.digest_date,
          channel, destination: dest, task_count: plan.task_count, ...initial,
        }, { onConflict: "coach_id,kind,channel,dedupe_key", ignoreDuplicates: true })
        .select("id, status");
      if (upErr) { errors.push(`${plan.coach.id}/${channel}: ${upErr.message}`); tally.failed++; continue; }

      // ignoreDuplicates returns no row when one already existed — but a row
      // left 'pending' by a crashed earlier run should still go out.
      let row = inserted?.[0] as { id: string; status: string } | undefined;
      if (!row) {
        let q = service.from("coach_task_notifications").select("id, status")
          .eq("coach_id", plan.coach.id).eq("kind", plan.kind).eq("channel", channel);
        q = plan.kind === "assigned" ? q.eq("task_id", plan.task_id!) : q.eq("digest_date", plan.digest_date!);
        const { data: existing } = await q.maybeSingle();
        if (!existing || existing.status !== "pending") { tally.already_done++; continue; }
        row = existing;
      }
      if (row.status !== "pending") { tally.skipped++; continue; }

      const res = await impl.send(dest!, firstName(plan.coach.full_name), plan.message,
        { kind: `coach_task_${plan.kind}`, ...(plan.digest_date ? { day: plan.digest_date } : {}) });
      await service.from("coach_task_notifications").update(res.ok
        ? { status: "sent", sent_at: new Date().toISOString(), provider_id: res.id || null, error: null }
        : { status: "failed", error: (res.error || "send failed").slice(0, 500) }).eq("id", row.id);
      if (res.ok) tally.sent++;
      else { tally.failed++; errors.push(`${plan.coach.full_name || plan.coach.id}/${channel}: ${res.error}`); }
    }
  }
  return { tally, errors: errors.slice(0, 20) };
}

function preview(plans: Plan[], channels: Partial<Record<Channel, ChannelImpl>>) {
  return plans.map((p) => ({
    coach_id: p.coach.id,
    name: p.coach.full_name,
    kind: p.kind,
    task_count: p.task_count,
    channels: Object.fromEntries((Object.entries(channels) as [Channel, ChannelImpl][])
      .map(([ch, impl]) => [ch, impl.destination(p.coach) ? "ready" : impl.missingReason])),
    tasks: p.message.sections.flatMap((s) => s.tasks.map((t) => `${s.label}: ${t.title}`)),
  }));
}

// ---- handler --------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = createClient(supabaseUrl, serviceKey);

  // ---- auth: service role (cron) or a staff user (assign / hand-run) ----------
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
  const action = url.searchParams.get("action") || "";
  const dryRun = ["1", "true"].includes(url.searchParams.get("dry_run") || "");
  const force = ["1", "true"].includes(url.searchParams.get("force") || "");
  const onlyUserId = url.searchParams.get("user_id");
  const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
  const body = await req.json().catch(() => ({}));

  const channels = buildChannels();
  const channelState = { email: channels.email ? "on" : "not_configured", sms: channels.sms ? "on" : "not_configured" };
  const TASK_COLS = "id, title, description, assigned_to, frequency, status, priority, due_date";

  async function loadCoaches(ids: string[]): Promise<Map<string, Coach>> {
    const map = new Map<string, Coach>();
    if (!ids.length) return map;
    const { data } = await service.from("users").select("id, full_name, email, phone").in("id", ids);
    for (const c of (data || []) as Coach[]) map.set(c.id, c);
    return map;
  }

  if (action === "assigned") {
    const ids = [
      ...(url.searchParams.get("task_id") || "").split(","),
      ...(Array.isArray(body?.task_ids) ? body.task_ids : []),
    ].map((s: string) => String(s).trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return json(req, { error: "task_id required" }, 400);

    const { data: tasksRaw, error: tErr } = await service.from("coach_tasks").select(TASK_COLS).in("id", ids);
    if (tErr) return json(req, { error: `could not load tasks: ${tErr.message}` }, 500);
    let tasks = ((tasksRaw || []) as Task[]).filter((t) => t.assigned_to && t.status !== "completed");
    if (onlyUserId) tasks = tasks.filter((t) => t.assigned_to === onlyUserId);
    const coaches = await loadCoaches([...new Set(tasks.map((t) => t.assigned_to))]);
    const plans: Plan[] = tasks.filter((t) => coaches.has(t.assigned_to)).map((t) => ({
      coach: coaches.get(t.assigned_to)!, message: assignedMessage(t), kind: "assigned",
      task_id: t.id, digest_date: null, task_count: 1,
    }));

    if (dryRun) return json(req, { ok: true, dry_run: true, via, action, channels: channelState, plans: preview(plans, channels) });
    const { tally, errors } = await deliver(service, plans, channels);
    return json(req, { ok: true, via, action, channels: channelState, tasks: plans.length, ...tally, errors });
  }

  if (action === "daily") {
    const now = facilityNow();
    if (!force && !dryRun && now.hour < DIGEST_HOUR) {
      return json(req, { ok: true, via, action, skipped: `before ${DIGEST_HOUR}:00 ${FACILITY_TZ} (local hour ${now.hour})`, digest_date: now.date });
    }

    let q = service.from("coach_tasks").select(TASK_COLS).neq("status", "completed").not("assigned_to", "is", null);
    if (onlyUserId) q = q.eq("assigned_to", onlyUserId);
    const { data: tasksRaw, error: tErr } = await q.order("id").limit(5000);
    if (tErr) return json(req, { error: `could not load tasks: ${tErr.message}` }, 500);

    const byCoach = new Map<string, Task[]>();
    for (const t of (tasksRaw || []) as Task[]) {
      if (!byCoach.has(t.assigned_to)) byCoach.set(t.assigned_to, []);
      byCoach.get(t.assigned_to)!.push(t);
    }
    const coaches = await loadCoaches([...byCoach.keys()]);
    let plans: Plan[] = [];
    for (const [coachId, list] of byCoach) {
      const coach = coaches.get(coachId);
      if (!coach) continue;
      const message = digestFor(list, now.date, now.dow, now.dom);
      if (!message) continue;
      const count = message.sections.filter((s) => s.label !== "Coming up this week").reduce((n, s) => n + s.tasks.length, 0);
      plans.push({ coach, message, kind: "daily", task_id: null, digest_date: now.date, task_count: count });
    }
    plans.sort((a, b) => (a.coach.full_name || "").localeCompare(b.coach.full_name || ""));
    if (limit) plans = plans.slice(0, limit);

    if (dryRun) return json(req, { ok: true, dry_run: true, via, action, digest_date: now.date, channels: channelState, coaches: plans.length, plans: preview(plans, channels) });
    const { tally, errors } = await deliver(service, plans, channels);
    return json(req, { ok: true, via, action, digest_date: now.date, channels: channelState, coaches: plans.length, ...tally, errors });
  }

  return json(req, { error: "action must be 'assigned' or 'daily'" }, 400);
});
