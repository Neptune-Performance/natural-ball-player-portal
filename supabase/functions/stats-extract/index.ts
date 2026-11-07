// #483 / #487: read stats out of screenshots with Claude vision. Nothing is
// saved here: the browser shows the extracted rows in an editable table and a
// person checks them before saving (src/TrackmanScreenshotImport.js,
// src/SeasonStatsImport.js).
//
// POST { mode, player_id, paths: string[] }
//   mode 'trackman_session'  staff only. paths in the trackman-screenshots
//                            bucket. Returns per-pitch or per-pitch-type rows.
//   mode 'game_stats'        the athlete themself or staff. paths in the
//                            external-stats bucket. Returns season lines
//                            (hitting / pitching / fielding).
// Every path must sit in the athlete's own folder ("<player_id>/...").
//
// Secret: ANTHROPIC_API_KEY (answers { error: 'not_configured' } when unset).
// Optional STATS_EXTRACT_MODEL overrides the model.
//
// verify_jwt=true: callers are signed-in users of the app.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { corsHeaders, preflight } from "../_shared/cors.ts";

const MODEL = Deno.env.get("STATS_EXTRACT_MODEL") || "claude-sonnet-5-5";
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // API limit per image
const BUCKET: Record<string, string> = {
  trackman_session: "trackman-screenshots",
  game_stats: "external-stats",
};
const MEDIA_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};
const SUPPORTED_MEDIA = new Set(Object.values(MEDIA_BY_EXT));

// ---- JSON schemas (strict structured output: every key required, nullable
// where the screen may not show it) -----------------------------------------
const num = { type: ["number", "null"] };
const int = { type: ["integer", "null"] };
const str = { type: ["string", "null"] };

function obj(props: Record<string, unknown>) {
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
}

const TRACKMAN_ROW = obj({
  pitch_type: { type: "string" },
  pitch_no: int,
  count: int,
  velo: num,
  velo_max: num,
  spin_rate: num,
  spin_axis: num,
  tilt: str,
  induced_vert_break: num,
  horz_break: num,
  vert_break: num,
  extension: num,
  rel_height: num,
  rel_side: num,
  vert_appr_angle: num,
  horz_appr_angle: num,
  zone_speed: num,
  eff_velocity: num,
  strike_pct: num,
  pitch_call: str,
});

const TRACKMAN_SCHEMA = obj({
  format: { type: "string", enum: ["per_pitch", "per_pitch_type"] },
  session_date: str,
  session_type: str,
  pitcher_name: str,
  rows: { type: "array", items: TRACKMAN_ROW },
  notes: { type: "string" },
});

const SEASON_LINE = obj({
  category: { type: "string", enum: ["hitting", "pitching", "fielding"] },
  season: { type: "string" },
  season_year: int,
  team: str,
  games: int,
  pa: int, ab: int, r: int, h: int, doubles: int, triples: int, hr: int, rbi: int,
  bb: int, so: int, hbp: int, sf: int, sb: int, cs: int,
  avg: num, obp: num, slg: num, ops: num,
  ip: num, bf: int, pitches: int, er: int, era: num, whip: num, baa: num, w: int, l: int, sv: int,
  tc: int, po: int, a: int, e: int, dp: int, fpct: num,
  extras: { type: "array", items: obj({ label: { type: "string" }, value: { type: "string" } }) },
});

const GAME_SCHEMA = obj({
  athlete_name_seen: str,
  lines: { type: "array", items: SEASON_LINE },
  notes: { type: "string" },
});

const TRACKMAN_PROMPT = (athlete: string) => `These are screenshots or photos of a Trackman pitching session for ${athlete || "one pitcher"}.
Read every pitch-data row you can see and return them.

- If the screen lists individual pitches (pitch numbers, one row per pitch), use format "per_pitch": one row per pitch, pitch_no from the screen, count null.
- If it lists one line per pitch type (averages / a session summary), use format "per_pitch_type": one row per pitch type, count = number of pitches of that type if shown, velo = average velocity, velo_max = max velocity if shown.
- If both a summary and a pitch list are visible, return the pitch list (per_pitch).
- If several screenshots overlap (scrolling), do not return the same pitch twice.
- pitch_type: use these codes when the type is recognisable: FB (four-seam fastball / fastball), SI (sinker / two-seam), CT (cutter), SL (slider / sweeper), CB (curveball / knuckle curve / slurve), CH (changeup), SP (splitter). Otherwise copy the screen's label.
- Units: mph, rpm, inches for breaks, feet for extension / release height / side, degrees for angles, percent (0-100) for strike %.
- spin_axis is degrees; tilt is the clock string (e.g. "1:15").
- session_date as YYYY-MM-DD only if a date is visible; otherwise null.
- Use null for anything not shown. Never estimate or invent a number.
- notes: anything a coach should double-check (blurry digits, cut-off columns), or "".`;

const GAME_PROMPT = (athlete: string) => `These are screenshots of baseball stats for ${athlete || "one athlete"}, usually from GameChanger (also Perfect Game, MaxPreps, PBR or a team site).
Return one line per season per category (hitting, pitching, fielding) per team.

- Only this athlete's numbers. If a screen is a team table, use only the row for ${athlete || "the athlete"}; if you cannot tell which row is theirs, return nothing for that screen and say so in notes.
- season: the season label as shown ("2025", "Spring 2025", "2024 Summer - 16U"). season_year: its 4-digit year, else null.
- team: the team name if shown, else null.
- Career / total rows that just add up the seasons above them: skip them.
- Hitting: games, pa, ab, r, h, doubles (2B), triples (3B), hr, rbi, bb, so (K), hbp, sf, sb, cs, avg, obp, slg, ops.
- Pitching: h, bb, so, hbp mean allowed. ip in baseball notation exactly as shown (12.1 = 12 and 1/3). bf (batters faced), pitches (#P), er, era, whip, baa, w, l, sv.
- Fielding: tc, po, a, e, dp, fpct.
- Rates as decimals (.345 -> 0.345, ERA 2.10 -> 2.1).
- Any other visible stat with no field (e.g. QAB, BABIP, K-L, CS%) goes in extras as label/value text.
- Use null for anything not shown. Never compute, estimate or invent a number.
- notes: anything to double-check, or "".`;

// ---- helpers ---------------------------------------------------------------
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return reply({
      error: "not_configured",
      message: "Screenshot reading is not set up yet: the ANTHROPIC_API_KEY secret is missing on the stats-extract function.",
    }, 503);
  }

  let body: any = {};
  try { body = await req.json(); } catch { return reply({ error: "bad_request" }, 400); }
  const mode = String(body?.mode || "");
  const playerId = String(body?.player_id || "");
  const paths: string[] = Array.isArray(body?.paths) ? body.paths.map(String) : [];
  if (!BUCKET[mode]) return reply({ error: "bad_mode" }, 400);
  if (!/^[0-9a-f-]{36}$/i.test(playerId)) return reply({ error: "bad_player" }, 400);
  if (!paths.length || paths.length > MAX_IMAGES) return reply({ error: "bad_paths", message: `Send 1 to ${MAX_IMAGES} images.` }, 400);
  for (const p of paths) {
    if (!p.startsWith(`${playerId}/`) || p.includes("..")) return reply({ error: "bad_paths" }, 400);
  }

  // ---- auth: who is calling, and may they read this athlete? -------------
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: authData, error: authErr } = await service.auth.getUser(token);
  const caller = authData?.user;
  if (authErr || !caller) return reply({ error: "unauthorized" }, 401);
  const { data: me } = await service.from("users").select("role").eq("id", caller.id).maybeSingle();
  const isStaff = me?.role === "admin" || me?.role === "coach";
  if (mode === "trackman_session" && !isStaff) return reply({ error: "forbidden" }, 403);
  if (mode === "game_stats" && !isStaff && caller.id !== playerId) return reply({ error: "forbidden" }, 403);

  const { data: athlete } = await service.from("users").select("full_name").eq("id", playerId).maybeSingle();
  const athleteName = athlete?.full_name || "";

  // ---- images -------------------------------------------------------------
  const images: Anthropic.Beta.BetaImageBlockParam[] = [];
  for (const p of paths) {
    const { data: blob, error } = await service.storage.from(BUCKET[mode]).download(p);
    if (error || !blob) return reply({ error: "download_failed", message: `Could not read ${p.split("/").pop()}.` }, 400);
    const ext = (p.split(".").pop() || "").toLowerCase();
    const media = SUPPORTED_MEDIA.has(blob.type) ? blob.type : MEDIA_BY_EXT[ext];
    if (!media) return reply({ error: "unsupported_image", message: `${p.split("/").pop()} is not a PNG, JPEG or WebP image.` }, 400);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return reply({ error: "image_too_large", message: `${p.split("/").pop()} is over 5 MB.` }, 400);
    images.push({
      type: "image",
      source: { type: "base64", media_type: media as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: toBase64(bytes) },
    });
  }

  // ---- Claude ---------------------------------------------------------------
  const client = new Anthropic({ apiKey });
  const isTrackman = mode === "trackman_session";
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // On a policy decline, the API retries on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: isTrackman ? TRACKMAN_SCHEMA : GAME_SCHEMA },
      },
      system: "You transcribe sports statistics from screenshots into structured data for a baseball training facility. Accuracy matters more than completeness: copy numbers exactly as shown and leave anything unreadable null.",
      messages: [{
        role: "user",
        content: [...images, { type: "text", text: isTrackman ? TRACKMAN_PROMPT(athleteName) : GAME_PROMPT(athleteName) }],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return reply({ error: "not_configured", message: "The ANTHROPIC_API_KEY secret was rejected. Check the key." }, 503);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return reply({ error: "busy", message: "The screenshot reader is busy. Try again in a minute." }, 503);
    }
    if (err instanceof Anthropic.BadRequestError) {
      return reply({ error: "rejected", message: `The images could not be read: ${err.message}`.slice(0, 400) }, 400);
    }
    if (err instanceof Anthropic.APIError) {
      return reply({ error: "upstream", message: `Screenshot reader error (${err.status ?? "network"}). Try again.` }, 502);
    }
    return reply({ error: "upstream", message: String(err).slice(0, 300) }, 502);
  }

  if (response.stop_reason === "refusal") {
    return reply({ error: "refused", message: "The screenshot reader declined these images. Enter the numbers by hand." }, 422);
  }
  if (response.stop_reason === "max_tokens") {
    return reply({ error: "too_long", message: "Too much data in one go. Send fewer screenshots at a time." }, 422);
  }
  const text = response.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return reply({ error: "bad_output", message: "The screenshot reader returned something unreadable. Try again." }, 502);
  }
  return reply({ mode, model: response.model, result: parsed });
});
