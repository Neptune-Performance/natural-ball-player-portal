// WooCommerce order webhook -> store_purchases.
//
// The public site (thenaturalballplayer.com) sells NBP products through
// WooCommerce. Its native order webhooks (topics order.created, order.updated,
// order.deleted) POST the standard WooCommerce order JSON here, unchanged.
//
// Auth: X-WC-Webhook-Signature = base64(HMAC-SHA256(raw body, secret)), the
// secret being the one typed into WooCommerce -> Settings -> Advanced ->
// Webhooks, stored here as WOOCOMMERCE_WEBHOOK_SECRET. verify_jwt=false in
// config.toml (WooCommerce has no Supabase JWT).
//
// Idempotency is by state, not by delivery: one store_purchases row per Woo
// line item (unique woo_line_item_id), so any number of deliveries of the same
// order converge on the same rows. X-WC-Webhook-Delivery-ID is only logged.
//
// Order status -> effect:
//   processing, completed        -> each mapped line item becomes a paid
//                                   purchase (athlete account created + invited
//                                   when the email is new)
//   refunded                     -> that order's purchases -> 'refunded'
//   cancelled, trash, deleted    -> that order's purchases -> 'canceled'
//   pending, on-hold, failed,    -> logged only (abandoned checkouts must not
//   checkout-draft                  create accounts)
//
// WooCommerce does not retry a failed delivery and disables a webhook after 5
// consecutive failures, so every business-level outcome (unmapped product,
// ignored status) answers 200 and is flagged in woo_orders.needs_review. Only a
// bad signature (401), an unreadable body (400) or a real server fault (500)
// is non-2xx.
//
// ?dry_run=1: verify, parse, resolve and report what WOULD happen; no writes,
// no account, no email. This is the studio's test endpoint.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeExpiresAt } from "../_shared/packageExpiry.ts";

const APP_URL = "https://www.thenatural-app.com";
const FROM = "NBP Portal <noreply@thenatural-app.com>";
const NEW_USER_TEAM_NAME = "New Users";
const RECURRING_ACCESS_DAYS = 31;
const ATHLETE_EMAIL_KEYS = ["nbp_athlete_email", "_nbp_athlete_email"];
const ATHLETE_NAME_KEYS = ["nbp_athlete_name", "_nbp_athlete_name"];

const PAID_STATUSES = ["processing", "completed"];
const REVOKE_STATUSES: Record<string, string> = {
  refunded: "refunded",
  cancelled: "canceled",
  trash: "canceled",
  deleted: "canceled",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) =>
  json({ ok: false, error: { code, message } }, status);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  const secret = Deno.env.get("WOOCOMMERCE_WEBHOOK_SECRET");
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(b64, signature.trim());
}

function metaValue(order: any, keys: string[]): string {
  for (const m of order?.meta_data || []) {
    if (keys.includes(m?.key) && typeof m.value === "string" && m.value.trim()) return m.value.trim();
  }
  return "";
}

function plausibleEmail(s: string): boolean {
  if (!s || s.includes(" ")) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const domain = s.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

// ilike treats _ and % as wildcards; an email can contain _.
const ilikeExact = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function toCents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

// date_paid_gmt is "YYYY-MM-DDTHH:MM:SS" with no zone.
function paidAtIso(order: any): string {
  const raw = order?.date_paid_gmt || order?.date_completed_gmt;
  if (typeof raw === "string" && raw) {
    const d = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

async function sendWelcomeEmail(service: any, email: string, name: string, products: string[]): Promise<string | null> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return "RESEND_API_KEY not configured";
  const { data, error } = await service.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${APP_URL}/?type=recovery` },
  });
  if (error) return `generateLink: ${error.message}`;
  const link = data?.properties?.action_link;
  if (!link) return "generateLink returned no link";

  const first = (name || "").split(" ")[0] || "there";
  const list = products.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const html = `<p>Hi ${escapeHtml(first)},</p>
<p>Thanks for your purchase from The Natural Ball Player. We've created your NBP Portal account so you can book sessions, see your schedule and follow your training:</p>
<ul>${list}</ul>
<p><a href="${link}">Set your password and log in</a></p>
<p>This link expires soon. If it has, go to <a href="${APP_URL}">${APP_URL}</a>, choose "Forgot password" and enter ${escapeHtml(email)}.</p>`;
  const text = `Hi ${first},\n\nThanks for your purchase from The Natural Ball Player. We've created your NBP Portal account:\n${products.map((p) => `- ${p}`).join("\n")}\n\nSet your password and log in: ${link}\n\nIf the link has expired, go to ${APP_URL}, choose "Forgot password" and enter ${email}.`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject: "Your NBP Portal account is ready", html, text }),
  });
  if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}

// Mirrors signup's player creation: users row, player_profiles row, "New
// Users" team so coaches see the new athlete. No password: the welcome email
// carries a set-password link.
async function createAthlete(service: any, email: string, fullName: string, phone: string | null, parentEmail: string | null) {
  const { data: created, error } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName, role: "player" },
  });
  if (error) throw new Error(`auth createUser: ${error.message}`);
  const id = created.user.id;

  const undo = async () => {
    await service.from("team_members").delete().eq("user_id", id);
    await service.from("player_profiles").delete().eq("user_id", id);
    await service.from("users").delete().eq("id", id);
    await service.auth.admin.deleteUser(id);
  };
  try {
    const { error: uErr } = await service.from("users").insert({
      id, email, full_name: fullName, role: "player", phone, parent1_email: parentEmail,
    });
    if (uErr) throw new Error(`users insert: ${uErr.message}`);
    const { error: pErr } = await service.from("player_profiles").insert({ user_id: id, signup_intent: "training" });
    if (pErr) throw new Error(`player_profiles insert: ${pErr.message}`);
    const { data: team } = await service.from("teams").select("id").eq("name", NEW_USER_TEAM_NAME).maybeSingle();
    if (team?.id) {
      const { error: tErr } = await service.from("team_members").insert({ team_id: team.id, user_id: id, role: "player" });
      if (tErr) console.error("woocommerce-webhook: New Users team add failed:", tErr.message);
    }
  } catch (e) {
    try { await undo(); } catch (u) { console.error("woocommerce-webhook: rollback failed:", (u as Error).message); }
    throw e;
  }
  return id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "POST only");

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const raw = await req.text();
  const signature = req.headers.get("x-wc-webhook-signature");

  // WooCommerce pings the URL with a form body `webhook_id=N` when the webhook
  // is saved; it must get a 2xx or the webhook can't be activated.
  if (raw.startsWith("webhook_id=")) return json({ ok: true, action: "ping" });

  if (!(await verifySignature(raw, signature))) return fail(401, "invalid_signature", "X-WC-Webhook-Signature did not verify");

  let order: any;
  try { order = JSON.parse(raw); } catch { return fail(400, "invalid_json", "Body is not JSON"); }

  const topic = req.headers.get("x-wc-webhook-topic") || "";
  const deliveryId = req.headers.get("x-wc-webhook-delivery-id");
  const orderId = Number(order?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return fail(400, "missing_order_id", "Payload has no order id");
  if (topic && !topic.startsWith("order.")) return json({ ok: true, order_id: orderId, action: "ignored", reason: `topic ${topic}` });

  const status = topic === "order.deleted" ? "deleted" : String(order.status || "").toLowerCase();
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const billingEmail = String(order?.billing?.email || "").trim().toLowerCase();
  const metaAthleteEmail = metaValue(order, ATHLETE_EMAIL_KEYS).toLowerCase();
  const athleteEmail = plausibleEmail(metaAthleteEmail) ? metaAthleteEmail : billingEmail;

  const logOrder = async (fields: Record<string, unknown>) => {
    if (dryRun) return;
    const row: Record<string, unknown> = {
      woo_order_id: orderId,
      status,
      last_topic: topic || null,
      last_delivery_id: deliveryId,
      updated_at: new Date().toISOString(),
      ...fields,
    };
    // order.deleted carries only {id}; keep the last full payload.
    if (status !== "deleted") {
      row.payload = order;
      row.woo_order_number = order.number != null ? String(order.number) : null;
      row.billing_email = billingEmail || null;
      row.athlete_email = athleteEmail || null;
    }
    const { error } = await service.from("woo_orders").upsert(row, { onConflict: "woo_order_id" });
    if (error) console.error("woocommerce-webhook: woo_orders log failed:", error.message);
  };

  try {
    // ---- Refund / cancel: revoke everything this order granted. ----
    if (REVOKE_STATUSES[status]) {
      const newStatus = REVOKE_STATUSES[status];
      let revoked: any[] = [];
      if (dryRun) {
        const { data, error } = await service.from("store_purchases").select("id")
          .eq("woo_order_id", orderId).in("status", ["paid", "active", "pending"]);
        if (error) throw error;
        revoked = data || [];
      } else {
        const { data, error } = await service.from("store_purchases")
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq("woo_order_id", orderId).in("status", ["paid", "active", "pending"])
          .select("id");
        if (error) throw error;
        revoked = data || [];
      }
      const result = revoked.map((r) => ({ purchase_id: r.id, result: newStatus }));
      await logOrder({ result });
      return json({ ok: true, dry_run: dryRun, order_id: orderId, action: "revoked", status: newStatus, purchases: result });
    }

    // ---- Not paid yet (or failed): log only. ----
    if (!PAID_STATUSES.includes(status)) {
      await logOrder({});
      return json({ ok: true, dry_run: dryRun, order_id: orderId, action: "ignored", reason: `order status ${status || "unknown"}` });
    }

    // ---- Paid. ----
    const lines: any[] = Array.isArray(order.line_items) ? order.line_items : [];
    const productIds = [...new Set(lines.map((l) => Number(l.product_id)).filter((n) => n > 0))];
    const { data: maps, error: mapErr } = productIds.length
      ? await service.from("woo_product_map").select("woo_product_id, woo_variation_id, store_product_id, access_days").in("woo_product_id", productIds)
      : { data: [], error: null };
    if (mapErr) throw mapErr;
    const mapFor = (pid: number, vid: number) =>
      (maps || []).find((m: any) => Number(m.woo_product_id) === pid && Number(m.woo_variation_id) === vid)
      || (maps || []).find((m: any) => Number(m.woo_product_id) === pid && Number(m.woo_variation_id) === 0)
      || null;

    const storeIds = [...new Set((maps || []).map((m: any) => m.store_product_id))];
    const { data: products, error: prodErr } = storeIds.length
      ? await service.from("store_products").select("id, name, kind, bundle_qty, recurring").in("id", storeIds)
      : { data: [], error: null };
    if (prodErr) throw prodErr;
    const productById = new Map((products || []).map((p: any) => [p.id, p]));

    const resolved = lines.map((l) => {
      const map = mapFor(Number(l.product_id), Number(l.variation_id || 0));
      return { line: l, map, product: map ? productById.get(map.store_product_id) : null };
    });
    const mapped = resolved.filter((r) => r.product);
    const unmapped = resolved.filter((r) => !r.product);
    const review: string[] = [];
    if (unmapped.length) review.push(`unmapped products: ${unmapped.map((r) => `${r.line.name} (#${r.line.product_id}${r.line.variation_id ? `/${r.line.variation_id}` : ""})`).join(", ")}`);
    if (Array.isArray(order.refunds) && order.refunds.length) review.push("order has a partial refund; access left in place");

    const lineResults: any[] = unmapped.map((r) => ({
      line_item_id: r.line.id, product_id: r.line.product_id, variation_id: r.line.variation_id || 0, result: "unmapped",
    }));

    if (!mapped.length) {
      await logOrder({ needs_review: true, review_reason: review.join("; ") || "no line items", result: lineResults });
      return json({ ok: true, dry_run: dryRun, order_id: orderId, action: "processed", user: null, lines: lineResults, needs_review: true });
    }

    if (!plausibleEmail(athleteEmail)) {
      await logOrder({ needs_review: true, review_reason: "no usable email on the order", result: lineResults });
      return json({ ok: true, dry_run: dryRun, order_id: orderId, action: "processed", user: null, lines: lineResults, needs_review: true });
    }

    // Identify (or create) the athlete.
    const { data: existing, error: userErr } = await service.from("users")
      .select("id, role").ilike("email", ilikeExact(athleteEmail)).limit(1);
    if (userErr) throw userErr;
    let userId: string | null = existing?.[0]?.id ?? null;
    let userCreated = false;
    if (!userId) {
      const billingName = [order?.billing?.first_name, order?.billing?.last_name].filter(Boolean).join(" ").trim();
      const fullName = metaValue(order, ATHLETE_NAME_KEYS) || billingName || athleteEmail;
      const parentEmail = athleteEmail !== billingEmail && plausibleEmail(billingEmail) ? billingEmail : null;
      if (!dryRun) {
        try {
          userId = await createAthlete(service, athleteEmail, fullName, order?.billing?.phone || null, parentEmail);
        } catch (e) {
          // Most likely an auth account with no public.users row (#166). Staff
          // resolve it; answering 200 keeps the webhook alive.
          const msg = (e as Error).message;
          await logOrder({ needs_review: true, review_reason: `account creation failed: ${msg}`, result: lineResults });
          return json({ ok: true, order_id: orderId, action: "processed", user: null, lines: lineResults, needs_review: true, review_reason: msg });
        }
      }
      userCreated = true;
    }

    // Purchases: one row per line item.
    const lineIds = mapped.map((r) => Number(r.line.id));
    const { data: already, error: exErr } = await service.from("store_purchases")
      .select("id, woo_line_item_id, status").in("woo_line_item_id", lineIds);
    if (exErr) throw exErr;
    const byLine = new Map((already || []).map((p: any) => [Number(p.woo_line_item_id), p]));
    const paidAt = paidAtIso(order);

    for (const { line, map, product } of mapped) {
      const lineId = Number(line.id);
      const base = { line_item_id: lineId, product_id: line.product_id, variation_id: line.variation_id || 0, store_product_id: product.id, store_product_name: product.name };
      const prior = byLine.get(lineId);
      if (prior) {
        if (["paid", "active"].includes(prior.status)) {
          lineResults.push({ ...base, result: "already_recorded", purchase_id: prior.id });
          continue;
        }
        // A refunded/cancelled order put back to completed by the store.
        if (!dryRun) {
          const { error } = await service.from("store_purchases")
            .update({ status: "paid", paid_at: paidAt, updated_at: new Date().toISOString() }).eq("id", prior.id);
          if (error) throw error;
        }
        lineResults.push({ ...base, result: "reactivated", purchase_id: prior.id });
        continue;
      }

      const qty = Math.max(1, Number(line.quantity) || 1);
      const expiresAt = map.access_days
        ? new Date(new Date(paidAt).getTime() + map.access_days * 86400000).toISOString()
        : computeExpiresAt(product.bundle_qty, new Date(paidAt))
          ?? (product.recurring ? new Date(new Date(paidAt).getTime() + RECURRING_ACCESS_DAYS * 86400000).toISOString() : null);
      const row = {
        user_id: userId,
        product_id: product.id,
        product_kind: product.kind,
        product_name_snapshot: product.name,
        amount_cents: toCents(line.total),
        status: "paid",
        paid_at: paidAt,
        expires_at: expiresAt,
        remaining_qty: product.bundle_qty != null ? product.bundle_qty * qty : null,
        woo_order_id: orderId,
        woo_line_item_id: lineId,
        metadata: {
          source: "woocommerce",
          paid_at_source: "woocommerce",
          woo_order_id: orderId,
          woo_order_number: order.number ?? null,
          woo_product_id: line.product_id,
          woo_variation_id: line.variation_id || 0,
          woo_product_name: line.name,
          woo_customer_id: order.customer_id || null,
          quantity: qty,
          billing_email: billingEmail || null,
        },
      };
      if (dryRun) {
        lineResults.push({ ...base, result: "would_create", expires_at: expiresAt, remaining_qty: row.remaining_qty, amount_cents: row.amount_cents });
        continue;
      }
      // ignoreDuplicates: a concurrent delivery of the same order may have just
      // inserted this line; then it is already recorded.
      const { data: ins, error: insErr } = await service.from("store_purchases")
        .upsert(row, { onConflict: "woo_line_item_id", ignoreDuplicates: true }).select("id");
      if (insErr) throw insErr;
      lineResults.push({ ...base, result: ins?.length ? "created" : "already_recorded", purchase_id: ins?.[0]?.id ?? null });
    }

    let emailError: string | null = null;
    if (userCreated && !dryRun && userId) {
      emailError = await sendWelcomeEmail(service, athleteEmail, metaValue(order, ATHLETE_NAME_KEYS) || order?.billing?.first_name || "", mapped.map((r) => r.product.name));
      if (emailError) review.push(`welcome email failed: ${emailError}`);
    }

    await logOrder({
      user_id: userId,
      user_created: userCreated,
      needs_review: review.length > 0,
      review_reason: review.length ? review.join("; ") : null,
      result: lineResults,
    });

    return json({
      ok: true,
      dry_run: dryRun,
      order_id: orderId,
      action: "processed",
      user: { id: userId, email: athleteEmail, created: userCreated },
      lines: lineResults,
      needs_review: review.length > 0,
    });
  } catch (err) {
    console.error("woocommerce-webhook: handler error:", (err as Error).message);
    return fail(500, "internal_error", (err as Error).message);
  }
});
