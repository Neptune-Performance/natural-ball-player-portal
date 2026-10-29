// #469: morning coach task digest.
//
// Vercel Cron hits this at 14:00 AND 15:00 UTC every day (vercel.json). The
// `coach-task-notify` edge function only sends on the tick that is at/after
// 7am facility time (America/Los_Angeles) — 14:00 UTC in PDT, 15:00 UTC in
// PST — and its unique log key makes the other tick a no-op, so coaches get
// the digest at 7am year-round without editing the cron at each DST switch.
//
// Like weekly-reminders it does no work itself: it calls the edge function
// with the service-role key (the function holds RESEND_API_KEY and, later,
// the TWILIO_* secrets). Auth = CRON_SECRET or a staff Supabase JWT.
// Passes ?dry_run=1 / ?user_id= / ?limit= / ?force=1 through:
//   curl -X POST "https://www.thenatural-app.com/api/coach-task-digest?dry_run=1" \
//     -H "Authorization: Bearer <staff access token>"
//
// Env (Vercel): SUPABASE_URL (or REACT_APP_SUPABASE_URL),
// SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || "https://cjilkqzifyhssbsiqgfu.supabase.co";

function jsonRes(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// True if the caller is authorized (cron secret or an admin/coach JWT).
async function authorize(req, service) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false };
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return { ok: true, via: "cron" };
  const { data: { user } = {}, error } = await service.auth.getUser(token);
  if (error || !user) return { ok: false };
  const { data: row } = await service.from("users").select("role").eq("id", user.id).single();
  if (row && (row.role === "admin" || row.role === "coach")) return { ok: true, via: "manual", userId: user.id };
  return { ok: false };
}

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") return jsonRes(res, 405, { error: "Method not allowed" });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return jsonRes(res, 500, { error: "SUPABASE_SERVICE_ROLE_KEY not configured" });
  const service = createClient(SUPABASE_URL, serviceKey);

  const authz = await authorize(req, service);
  if (!authz.ok) return jsonRes(res, 401, { error: "Unauthorized" });

  const qs = new URLSearchParams({ action: "daily" });
  const q = req.query || {};
  if (q.dry_run) qs.set("dry_run", String(q.dry_run));
  if (q.user_id) qs.set("user_id", String(q.user_id));
  if (q.limit) qs.set("limit", String(q.limit));
  if (q.force) qs.set("force", String(q.force));
  const url = `${SUPABASE_URL}/functions/v1/coach-task-notify?${qs}`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ via: authz.via, triggered_by: authz.userId || null }),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return jsonRes(res, r.ok ? 200 : 502, { via: authz.via, upstream_status: r.status, ...body });
  } catch (e) {
    return jsonRes(res, 502, { error: `coach-task-notify edge function unreachable: ${e.message}` });
  }
};

module.exports.config = { maxDuration: 60 };
