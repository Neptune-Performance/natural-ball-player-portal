// #479: read a public Google Doc / Sheet that an athlete linked as External
// Stats, so its numbers can feed the Player Card. The browser can't fetch
// docs.google.com itself (no CORS), so this returns the plain-text export and
// the client parses it with the same code it uses for CSV/XLSX files.
//
// verify_jwt=true (called from the logged-in app). Fixed host + path shapes
// only (no open proxy): docs.google.com/document/d/<id> -> txt export,
// docs.google.com/spreadsheets/d/<id> -> csv export of the linked tab (gid).
// A doc that isn't shared "anyone with the link" comes back as Google's HTML
// sign-in page; that answers { error: 'not_public' }.

import { corsHeaders, preflight } from "../_shared/cors.ts";

const MAX_BYTES = 2_000_000;
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

function exportUrl(raw: string): { url: string; kind: "doc" | "sheet" } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/^\/(document|spreadsheets)\/d\/([^/]+)/);
  if (!m || !ID_RE.test(m[2])) return null;
  if (m[1] === "document") return { url: `https://docs.google.com/document/d/${m[2]}/export?format=txt`, kind: "doc" };
  const gid = (u.searchParams.get("gid") || u.hash.match(/gid=(\d+)/)?.[1] || "0").replace(/\D/g, "") || "0";
  return { url: `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=csv&gid=${gid}`, kind: "sheet" };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return reply({ error: "bad_request" }, 400); }
  const target = exportUrl(String(body?.url || ""));
  if (!target) return reply({ error: "unsupported" });

  let res: Response;
  try {
    res = await fetch(target.url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return reply({ error: "fetch_failed", detail: String(err).slice(0, 200) });
  }
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("text/html")) {
    await res.body?.cancel();
    return reply({ error: res.status === 404 ? "not_found" : "not_public" });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return reply({ error: "too_large" });
  const text = new TextDecoder().decode(buf).replace(/^﻿/, "");
  return reply({ kind: target.kind, text });
});
