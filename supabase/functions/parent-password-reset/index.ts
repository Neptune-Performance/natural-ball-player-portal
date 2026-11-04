// #481: "Forgot password" for a parent typing THEIR email.
//
// Athlete accounts log in with the athlete's email, but families often type
// the parent email on file (users.parent1_email / parent2_email). Supabase's
// /recover answers 200 and sends nothing for an email with no auth account
// (anti-enumeration), so those families saw "check your email" and got
// nothing. On 2026-11-03/04 four of five /recover calls were exactly that.
//
// The login form still calls supabase.auth.resetPasswordForEmail (covers an
// email that IS a login) and also calls this. Here: every athlete whose
// parent1_email / parent2_email matches gets a recovery link, all in ONE email
// to that parent, naming the athlete and their login email. Athletes whose
// own login email IS the typed email are skipped (Supabase already sent).
//
// verify_jwt=false (logged-out browser). Always answers { ok: true } so it
// can't be used to probe which emails are on file. Mail only ever goes to the
// parent address already on the athlete's record. Throttle: an athlete whose
// recovery link went out in the last 60s is skipped (auth.users
// recovery_sent_at, stamped by generateLink), mirroring smtp_max_frequency.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight, isAllowedOrigin } from "../_shared/cors.ts";

const APP_URL = "https://www.thenatural-app.com";
const FROM = "NBP Portal <noreply@thenatural-app.com>";
const MAX_ATHLETES = 6;
const THROTTLE_MS = 60_000;

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  const ok = () => new Response(JSON.stringify({ ok: true }), { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  let body: any = {};
  try { body = await req.json(); } catch { return ok(); }
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) return ok();

  // Redirect back to the origin the request came from when it's ours (so
  // the old vercel.app host keeps working), else production.
  const origin = req.headers.get("Origin") || "";
  const base = isAllowedOrigin(origin) ? origin : APP_URL;
  const redirectTo = `${base}/?type=recovery`;

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) { console.error("RESEND_API_KEY not configured"); return ok(); }
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ilike with no wildcards = case-insensitive equality (parent emails are
  // stored as typed); escape the LIKE metacharacters an email can contain.
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const byId = new Map<string, any>();
  for (const col of ["parent1_email", "parent2_email"]) {
    const { data, error } = await service
      .from("users")
      .select("id, email, full_name")
      .ilike(col, pattern)
      .limit(MAX_ATHLETES);
    if (error) { console.error("lookup:", col, error.message); continue; }
    for (const row of data || []) byId.set(row.id, row);
  }
  const athletes = [...byId.values()]
    .sort((x, y) => String(x.full_name).localeCompare(String(y.full_name)))
    .slice(0, MAX_ATHLETES);

  const links: { name: string; login: string; link: string }[] = [];
  for (const a of athletes) {
    const login = String(a.email || "").trim().toLowerCase();
    if (!login || login === email) continue;
    const { data: au } = await service.auth.admin.getUserById(a.id);
    const sentAt = au?.user?.recovery_sent_at ? Date.parse(au.user.recovery_sent_at) : 0;
    if (sentAt && Date.now() - sentAt < THROTTLE_MS) continue;
    const { data, error: linkErr } = await service.auth.admin.generateLink({
      type: "recovery",
      email: login,
      options: { redirectTo },
    });
    const link = data?.properties?.action_link;
    if (linkErr || !link) { console.error("generateLink", a.id, linkErr?.message); continue; }
    links.push({ name: a.full_name || login, login, link });
  }
  if (!links.length) return ok();

  const items = links.map((l) => `<li style="margin-bottom:12px"><strong>${escapeHtml(l.name)}</strong> (logs in as ${escapeHtml(l.login)})<br><a href="${l.link}">Reset ${escapeHtml(l.name.split(" ")[0])}'s password</a></li>`).join("");
  const html = `<p>Hi,</p>
<p>Someone asked to reset a password on the NBP Portal using ${escapeHtml(email)}. That address is the parent email on file for the athlete account${links.length > 1 ? "s" : ""} below. Athlete accounts log in with the athlete's own email, shown next to each name.</p>
<ul>${items}</ul>
<p>These links expire soon. If you didn't ask for this, you can ignore this email; nothing changes until a link is used.</p>`;
  const text = `Someone asked to reset a password on the NBP Portal using ${email}. That address is the parent email on file for:\n\n${links.map((l) => `${l.name} (logs in as ${l.login})\n${l.link}`).join("\n\n")}\n\nThese links expire soon. If you didn't ask for this, ignore this email.`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject: "Natural Ball Player - Reset your athlete's password", html, text }),
  });
  if (!res.ok) console.error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  else console.log(`sent ${links.length} link(s)`);
  return ok();
});
