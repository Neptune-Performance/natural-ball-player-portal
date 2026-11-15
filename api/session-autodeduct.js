// #491: take ended sessions off numbered lesson packs.
//
// Vercel Cron hits this hourly (vercel.json: "20 * * * *") with
// `Authorization: Bearer $CRON_SECRET`. It calls the SECURITY DEFINER
// function auto_deduct_ended_sessions() with the service-role key: every
// confirmed slot_reservations row whose session has ended, that was not
// marked No-show / Cancelled and has no usage row yet, takes one session from
// the athlete's soonest-expiring counted pack (migration
// 20261114_auto_deduct_ended_sessions.sql has the full rule).
//
// Also callable by hand with a staff Supabase JWT:
//   curl -X POST "https://www.thenatural-app.com/api/session-autodeduct?dry_run=1" \
//     -H "Authorization: Bearer <staff access token>"
// `?dry_run=1` reports what WOULD be deducted and writes nothing;
// `?user_id=<uuid>` restricts the run to one athlete.
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

  const q = req.query || {};
  const dryRun = !!q.dry_run && String(q.dry_run) !== "0";

  const { data, error } = await service.rpc("auto_deduct_ended_sessions", {
    p_dry_run: dryRun,
    p_player: q.user_id ? String(q.user_id) : null,
  });
  if (error) return jsonRes(res, 502, { via: authz.via, error: error.message });

  const rows = data || [];
  return jsonRes(res, 200, {
    via: authz.via,
    dry_run: dryRun,
    deducted: rows.length,
    athletes: new Set(rows.map((r) => r.player_id)).size,
    sessions: rows,
  });
};

module.exports.config = { maxDuration: 60 };
