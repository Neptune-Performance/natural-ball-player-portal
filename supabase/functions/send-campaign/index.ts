// Issue #281 Phase 2 — the campaign blast sender.
//
// This is the only irreversible action in the application: it emails real
// families. Every design choice below is a safety property. Do not simplify.
//
//   - ADMIN ONLY (send-email allows coach; this does not).
//   - The request identifies recipients by campaign_id and NOTHING else. The
//     list is read server-side from email_campaign_recipients. Accepting
//     addresses from the browser would turn any admin session into an open
//     relay — that is why this function exists separately from send-email,
//     whose single-recipient anti-injection guard stays untouched.
//   - IDEMPOTENT AT TWO LEVELS:
//       (a) only rows still 'pending' are ever sent, so re-invoking sends
//           nothing and a double-click cannot double-send;
//       (b) every call to Resend carries an Idempotency-Key derived from
//           the recipient row id, so even if we lose the response and try
//           again, Resend returns the original message instead of sending
//           a second copy. (a) alone is not enough — (a) protects against
//           us knowing we already sent; (b) protects against us NOT knowing.
//   - A send we did not get an answer for is recorded 'unknown', never
//     'failed'. 'failed' is retryable and 'unknown' deliberately is not.
//     Marking a timeout as 'failed' is the single most likely way to email
//     a family twice.
//   - Results are written per batch AS THE SEND PROGRESSES, never only at
//     the end, and a failure to write results ABORTS the run rather than
//     carrying on over a lost write.
//   - Blacklisted addresses are marked 'skipped' — recorded, not dropped.
//   - The recipient snapshot is verified against the count the admin
//     confirmed (email_campaigns.recipient_count). Mismatch = stop, send
//     nothing, report.
//   - Every message carries List-Unsubscribe + List-Unsubscribe-Post, so
//     mail clients show a native one-click unsubscribe next to our name.
//     That is the cheapest protection there is against someone reaching for
//     "Report spam" instead — and on a new domain, complaints are what
//     burns you. It only works because the unsubscribe endpoint does its
//     work on POST; see the note at the top of ../unsubscribe/index.ts.
//   - Reads are PAGINATED, not .range(0, 9999). PostgREST silently clamps a
//     wide range to the project's db-max-rows (default 1000) and returns a
//     short list with no error. The blacklist read is the dangerous one:
//     a silently-truncated blacklist emails people who opted out.
//   - Resend limits verified 2026-08-22 (resend.com/docs/api-reference):
//     batch endpoint takes up to 100 emails per call; the documented rate
//     limit is 10 requests/second per team, shared with transactional mail.
//     We pace well under it and honour retry-after on 429.
//   - Wall clock: work is chunked and self-limiting. If time runs out with
//     rows still pending, the function returns { resume: true } and the
//     client re-invokes; idempotency makes resumption safe.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

const BATCH_SIZE = 100;              // Resend batch endpoint maximum
const BATCH_PAUSE_MS = 350;          // ~3 req/s including the write round-trip — well under the documented 10/s
const TIME_BUDGET_MS = 60_000;       // return { resume: true } past this; edge wall clock is ~150s, leave room
const PAGE = 1000;                   // paginated read size — must be <= db-max-rows

// 🔴 The address campaigns come from: the app's own domain, the same one the
// transactional mail uses, on Trevor's decision of 2026-10-31. Campaigns used to
// send from admin@thenaturalballplayer.com (Cordell's choice on #281), until that
// domain's Resend records vanished from its Hostinger DNS between 2026-10-24 and
// 2026-10-28 and Resend refused every send as "domain is not verified".
// Replies still go to the business inbox; those two domains differ by one word
// and have been confused before, so keep FROM and REPLY_TO as they are.
const FROM = "The Natural Ballplayer <noreply@thenatural-app.com>";
const REPLY_TO = "admin@thenaturalballplayer.com";
const SITE_URL = "https://www.thenaturalballplayer.com";
// The app's own domain — where the unsubscribe confirmation page lives.
// NOT the same as SITE_URL above; see the two-domain note on #281.
const APP_URL = "https://www.thenatural-app.com";

// CAN-SPAM requires a physical postal address in commercial email.
// Supplied by Cordell on #281, 2026-08-22. This is the facility's own
// business address and belongs in the footer of every campaign.
const POSTAL_ADDRESS = "The Natural Ballplayer &middot; 13424 NE 126th Pl, Kirkland, WA 98034";

// Local part per RFC 5322 atext — the previous pattern rejected apostrophes,
// which are common in family names (o'brien@...).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

// Two different unsubscribe URLs, on purpose — do not collapse them.
//
// The FOOTER LINK a human clicks goes to the app, because the page a person
// sees has to be a real web page. Supabase Edge Functions rewrite text/html
// to text/plain, so a confirmation page served from the function arrives as
// raw source code. It shipped that way once; see src/UnsubscribePage.js.
function unsubscribePageUrl(token: string): string {
  return `${APP_URL}/unsubscribe?token=${token}`;
}

// The LIST-UNSUBSCRIBE HEADER points at the function itself, because Gmail
// and Yahoo POST to it directly and want a machine endpoint, not a page.
// That is RFC 8058 one-click, and it is the exit most people actually use.
function unsubscribeApiUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl}/functions/v1/unsubscribe?token=${token}`;
}

// Stable across resumes: derived only from ids that never change.
async function idemKey(parts: string[]): Promise<string> {
  const buf = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function campaignHtml(bodyHtml: string, unsubUrl: string): string {
  // Table-wrapped rather than styling <body>: Outlook's Word engine ignores
  // max-width and margin:0 auto on body, and Gmail rewrites the body tag, so
  // a body-styled email renders edge-to-edge in exactly the clients most of
  // this list uses.
  const postal = POSTAL_ADDRESS ? `${POSTAL_ADDRESS}<br>` : "";
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
${styleImages(bodyHtml)}
</td></tr>
<tr><td style="padding:0 28px 28px;">
<hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;">
<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#9ca3af;text-align:center;">
<a href="${SITE_URL}" style="color:#6b7280;">thenaturalballplayer.com</a><br>
${postal}<a href="${unsubUrl}" style="color:#6b7280;">Unsubscribe from these emails</a>
</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// #480: library images are full-size uploads. An inline max-width (Gmail
// drops <style> in some clients) keeps each one inside the 600px column. An
// <img> that already has a style is left alone.
function styleImages(html: string): string {
  return html.replace(/<img\b(?![^>]*\bstyle=)([^>]*)>/gi,
    '<img$1 style="max-width:100%;height:auto;display:block;border:0;margin:8px 0;">');
}

function htmlToText(html: string): string {
  return html
    // Drop these WITH their contents. Stripping only the tags leaves the CSS
    // rules as visible plaintext, which is both unreadable and a spam signal.
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    // Keep the destination of links — "Register here" with no URL is useless
    // to anyone reading the plain-text part.
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    // Numeric entities first — rich-text editors emit &#39; and &rsquo; for
    // every apostrophe, and leaving them raw is what puts "Don&#39;t" in
    // front of a parent.
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&(quot|apos|lsquo|rsquo|ldquo|rdquo|mdash|ndash|hellip);/gi, (_m, n) =>
      ({ quot: '"', apos: "'", lsquo: "‘", rsquo: "’", ldquo: "“",
         rdquo: "”", mdash: "—", ndash: "–", hellip: "…" } as Record<string, string>)[n.toLowerCase()] || _m)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // &amp; LAST, or &amp;lt; double-decodes into a stray "<".
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing authorization header" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json(401, { error: "Invalid token" });

    // ADMIN only. Deliberately stricter than send-email's admin+coach:
    // emailing the whole list is not a coach-level action. Note the table's
    // RLS allows coaches to COMPOSE — this is the gate that stops them
    // sending, so it is load-bearing, not belt-and-braces.
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: userData, error: roleError } = await serviceClient
      .from("users").select("role").eq("id", user.id).single();
    if (roleError || !userData || userData.role !== "admin") {
      return json(403, { error: "Unauthorized: admin only" });
    }

    const { campaignId, retryFailed } = await req.json();
    if (!campaignId || typeof campaignId !== "string") {
      return json(400, { error: "campaignId is required" });
    }

    const { data: campaign, error: campaignError } = await serviceClient
      .from("email_campaigns")
      .select("id, subject, body_html, recipient_count, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (campaignError) return json(500, { error: `Failed to load campaign: ${campaignError.message}` });
    if (!campaign) return json(404, { error: "Campaign not found" });
    if (!campaign.subject || !campaign.body_html) {
      return json(400, { error: "Campaign has no subject or body — nothing sent." });
    }

    // Retry-failed: flip ONLY failed rows back to pending. 'sent', 'skipped'
    // and 'unknown' rows are never touched, so retrying cannot re-email
    // anyone and cannot re-send to an address whose outcome we are unsure of.
    if (retryFailed === true) {
      const { error: retryError } = await serviceClient
        .from("email_campaign_recipients")
        .update({ status: "pending", error: null })
        .eq("campaign_id", campaignId)
        .eq("status", "failed");
      if (retryError) return json(500, { error: `Failed to reset failed recipients: ${retryError.message}` });
    }

    // --- Paginated reads. PostgREST clamps an over-wide .range() to
    // db-max-rows and returns a SHORT LIST WITH NO ERROR, so a single wide
    // read is a silent-truncation bug waiting to happen. ---
    const readAll = async <T>(
      table: string, cols: string, apply: (q: any) => any,
    ): Promise<{ rows: T[]; error: string | null }> => {
      const out: T[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await apply(
          serviceClient.from(table).select(cols),
        ).range(from, from + PAGE - 1);
        if (error) return { rows: out, error: error.message };
        const page = (data || []) as T[];
        out.push(...page);
        if (page.length < PAGE) break;
      }
      return { rows: out, error: null };
    };

    type Row = { id: string; email: string; status: string; unsubscribe_token: string };
    const { rows: allRows, error: rowsError } = await readAll<Row>(
      "email_campaign_recipients", "id, email, status, unsubscribe_token",
      (q) => q.eq("campaign_id", campaignId).order("id"),
    );
    if (rowsError) {
      return json(500, {
        error: `Failed to load recipients: ${rowsError}. ` +
          `(If this mentions unsubscribe_token, run 20260822_email_campaigns_phase2.sql first — ` +
          `campaign email must not go out without unsubscribe links.)`,
      });
    }

    // The snapshot must match the count the admin literally typed to
    // confirm. If it doesn't, someone changed something — send NOTHING.
    if (allRows.length !== campaign.recipient_count) {
      return json(409, {
        error: `Recipient snapshot (${allRows.length}) does not match the confirmed count ` +
          `(${campaign.recipient_count}). Nothing was sent.`,
      });
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json(500, { error: "Email service not configured" });

    await serviceClient.from("email_campaigns")
      .update({ status: "sending" }).eq("id", campaignId);

    // Blacklist — mark matches 'skipped' BEFORE sending, recorded not dropped.
    // Re-read on every invocation so an unsubscribe that lands mid-send is
    // honoured on the next pass.
    const { rows: blacklistRows, error: blacklistError } = await readAll<{ email: string }>(
      "email_blacklist", "email", (q) => q.order("email"),
    );
    if (blacklistError) {
      await serviceClient.from("email_campaigns").update({ status: "failed" }).eq("id", campaignId);
      return json(500, { error: `Failed to load blacklist: ${blacklistError}. Nothing was sent.` });
    }
    const blacklist = new Set(blacklistRows.map((r) => (r.email || "").toLowerCase().trim()));

    // Normalise once, then use the same value for validation, blacklist
    // matching and the actual To: field. The old code trimmed for the
    // blacklist but sent the raw value, so " a@b.com" dodged the blacklist
    // AND failed validation.
    const norm = (r: Row) => (r.email || "").trim().toLowerCase();

    const pendingAll = allRows.filter((r) => r.status === "pending");
    const toSkip = pendingAll.filter((r) => blacklist.has(norm(r)));
    if (toSkip.length > 0) {
      const { error: skipError } = await serviceClient
        .from("email_campaign_recipients")
        .update({ status: "skipped", error: "unsubscribed" })
        .in("id", toSkip.map((r) => r.id));
      if (skipError) {
        await serviceClient.from("email_campaigns").update({ status: "failed" }).eq("id", campaignId);
        return json(500, { error: `Could not record skipped recipients: ${skipError.message}. Nothing was sent.` });
      }
    }
    const skipIds = new Set(toSkip.map((r) => r.id));
    const queue = pendingAll.filter((r) => !skipIds.has(r.id));

    const startedAt = Date.now();
    let resume = false;
    let aborted: string | null = null;

    // A write we cannot make is fatal. Carrying on past a lost write is how
    // a row stays 'pending' after its email went out — and then gets sent
    // again on the next pass.
    const markRows = async (ids: string[], fields: Record<string, unknown>): Promise<boolean> => {
      if (ids.length === 0) return true;
      for (let from = 0; from < ids.length; from += 200) {
        const { error } = await serviceClient
          .from("email_campaign_recipients").update(fields).in("id", ids.slice(from, from + 200));
        if (error) {
          console.error("send-campaign: FATAL — failed to record results:", error.message);
          aborted = `Could not record who was emailed (${error.message}). Stopped to avoid sending twice.`;
          return false;
        }
      }
      return true;
    };

    const payloadFor = (row: Row) => {
      const unsub = unsubscribePageUrl(row.unsubscribe_token);
      const unsubApi = unsubscribeApiUrl(supabaseUrl, row.unsubscribe_token);
      return {
        from: FROM,
        reply_to: REPLY_TO,
        to: [norm(row)],
        subject: campaign.subject,
        html: campaignHtml(campaign.body_html, unsub),
        text: htmlToText(campaign.body_html) + `\n\n---\nUnsubscribe: ${unsub}`,
        headers: {
          // RFC 2369 requires the angle brackets. RFC 8058 one-click needs
          // both headers AND a POST-handling endpoint — we have both.
          "List-Unsubscribe": `<${unsubApi}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    };

    // Single send. Idempotency-Key is keyed on the recipient row, which is
    // stable forever — so a retry after a lost response returns the original
    // message id instead of sending a second copy.
    const sendOne = async (row: Row): Promise<"sent" | "failed" | "unknown"> => {
      let res: Response;
      try {
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": await idemKey([campaignId, row.id]),
          },
          body: JSON.stringify(payloadFor(row)),
        });
      } catch (netErr) {
        // We never learned whether this went out. NOT 'failed' — failed is
        // retryable and retrying an email that already sent is the one
        // outcome we cannot take back.
        await markRows([row.id], { status: "unknown", error: `no response: ${(netErr as Error).message}` });
        return "unknown";
      }
      let data: { id?: string; message?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (res.ok && data.id) {
        await markRows([row.id], { status: "sent", provider_message_id: data.id, sent_at: new Date().toISOString() });
        return "sent";
      }
      if (res.status >= 500) {
        await markRows([row.id], { status: "unknown", error: `provider ${res.status}` });
        return "unknown";
      }
      // A 4xx is a definite refusal — safe to call failed and safe to retry.
      await markRows([row.id], { status: "failed", error: data.message || `Resend status ${res.status}` });
      return "failed";
    };

    const backoffMs = (res: Response): number => {
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30_000);
      const reset = Number(res.headers.get("ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, 30_000);
      return 2000;
    };

    for (let i = 0; i < queue.length && !aborted; i += BATCH_SIZE) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { resume = true; break; }
      const chunk = queue.slice(i, i + BATCH_SIZE);

      // Malformed addresses fail up front — never handed to Resend, and never
      // allowed to poison a batch of 99 valid ones.
      const invalidSet = new Set(
        chunk.filter((r) => {
          const a = norm(r);
          return !a || a.length > 254 || /[\r\n,;<>]/.test(a) || !EMAIL_RE.test(a);
        }).map((r) => r.id),
      );
      if (invalidSet.size > 0) {
        if (!await markRows([...invalidSet], { status: "failed", error: "invalid email address" })) break;
      }
      const valid = chunk.filter((r) => !invalidSet.has(r.id));
      if (valid.length === 0) continue;

      // Content-derived key: stable if this exact set of rows is retried,
      // and unaffected by the queue shrinking between invocations (which is
      // why a key based on the batch INDEX would have been wrong).
      const batchKey = await idemKey([campaignId, "batch", ...valid.map((r) => r.id)]);

      let batchRes: Response;
      try {
        batchRes = await fetch("https://api.resend.com/emails/batch", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": batchKey,
          },
          body: JSON.stringify(valid.map(payloadFor)),
        });
      } catch (netErr) {
        // The batch may or may not have gone out. Record 'unknown' and stop —
        // a human reconciles this against the Resend dashboard.
        await markRows(valid.map((r) => r.id), { status: "unknown", error: `no response: ${(netErr as Error).message}` });
        aborted = "Lost the connection to the email provider mid-send. Some of this batch may have gone out — " +
          "check the Resend dashboard before retrying.";
        break;
      }

      if (batchRes.status === 429) {
        // Rate limited or out of quota: nothing in this chunk was sent.
        await batchRes.body?.cancel();
        // Degrading to one-by-one here would MULTIPLY our request rate at
        // exactly the moment we are being told to slow down. Back off and
        // let the resume path retry the same batch instead.
        await new Promise((r) => setTimeout(r, backoffMs(batchRes)));
        resume = true;
        break;
      }

      if (!batchRes.ok) {
        // Whole-batch rejection (e.g. one bad payload item 422s the call).
        // Retry the chunk one-by-one so a single bad address cannot take
        // down 99 good ones, and each failure records ITS own error.
        await batchRes.body?.cancel();
        for (const row of valid) {
          if (aborted) break;
          if (Date.now() - startedAt > TIME_BUDGET_MS) { resume = true; break; }
          await sendOne(row);
          await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        }
        if (resume || aborted) break;
        continue;
      }

      // Success. Resend documents that each entry in `data` corresponds to
      // the email at the same index in the request — but verify the LENGTH
      // before relying on it. Without this check, a parse failure on a 2xx
      // response marks 100 delivered emails as 'failed', and one Retry click
      // sends them all again.
      let batchData: { data?: Array<{ id?: string }> } = {};
      let parseFailed = false;
      try { batchData = await batchRes.json(); } catch { parseFailed = true; }
      const ids = Array.isArray(batchData.data) ? batchData.data : [];

      if (parseFailed || ids.length !== valid.length) {
        await markRows(valid.map((r) => r.id), {
          status: "unknown",
          error: `provider accepted the batch but returned ${parseFailed ? "an unreadable response" : `${ids.length} ids for ${valid.length} emails`}`,
        });
        aborted = "The email provider accepted a batch but did not confirm each message. " +
          "These are marked 'unknown' — check the Resend dashboard before retrying, so nobody is emailed twice.";
        break;
      }

      // Two grouped writes instead of 100 sequential ones. The old per-row
      // loop was ~100 round-trips per batch and was the main reason the run
      // kept hitting the time budget and handing off to a resume the browser
      // had to drive.
      const nowIso = new Date().toISOString();
      const sentIds: string[] = [];
      const noIdIds: string[] = [];
      valid.forEach((row, j) => (ids[j]?.id ? sentIds : noIdIds).push(row.id));

      // provider_message_id differs per row, so those go one at a time —
      // but only for rows that actually succeeded, and only after we know
      // the response was well-formed.
      for (let j = 0; j < valid.length; j++) {
        const providerId = ids[j]?.id;
        if (!providerId) continue;
        if (!await markRows([valid[j].id], {
          status: "sent", provider_message_id: providerId, sent_at: nowIso,
        })) break;
      }
      if (aborted) break;
      if (noIdIds.length > 0) {
        if (!await markRows(noIdIds, { status: "unknown", error: "no provider id for this message" })) break;
      }

      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }

    // Final tallies from the database — the source of truth, not our counters.
    const { rows: finalRows } = await readAll<{ status: string }>(
      "email_campaign_recipients", "status", (q) => q.eq("campaign_id", campaignId).order("id"),
    );
    const tally = { sent: 0, failed: 0, skipped: 0, pending: 0, unknown: 0 };
    finalRows.forEach((r) => {
      if (r.status in tally) tally[r.status as keyof typeof tally]++;
    });

    if (!resume && !aborted) {
      // 'partial' matters: a 480-sent / 480-failed campaign reporting as
      // 'sent' is a lie told to the person deciding whether to resend.
      const status = tally.sent === 0 && (tally.failed > 0 || tally.unknown > 0)
        ? "failed"
        : (tally.failed > 0 || tally.unknown > 0 || tally.pending > 0)
          ? "partial"
          : "sent";
      await serviceClient.from("email_campaigns").update({
        status,
        // Only claim a completion time if nothing is still outstanding.
        ...(tally.pending === 0 ? { sent_at: new Date().toISOString() } : {}),
      }).eq("id", campaignId);
    }

    return json(200, { success: !aborted, resume: resume && !aborted, aborted, ...tally });
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
});
