import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';
import {
  Video, Search, AlertTriangle, CheckCircle2, Loader2, Download, X, Ban,
  ExternalLink, Check, RefreshCw, Info, Undo2, Lock, ShieldAlert,
} from 'lucide-react';
import { formatUserError } from './errorMessage';
import { classifyWriteOutcome } from './writeOutcome';
import {
  normalizeExerciseName,
  buildGapReport,
  MATCH_TIERS,
  NO_MATCH_TIER,
  CLASSIFICATION_LABELS,
} from './exerciseVideoMatch';

/*
 * Issue #170 — "AI Agent To Find Hyperlinks For All Videos".
 *
 * What Cordell asked for was an agent that finds every missing movement link
 * and inserts it. What the data actually supports is narrower and this screen
 * says so out loud:
 *
 *   - 2,876 of 8,008 workout_templates.exercises entries have an empty `link`,
 *     across ~1,116 distinct names. 211 of 275 training_exercises rows have an
 *     empty `video_url` (different column name, same problem).
 *   - exercise_videos (1,275 rows) was BUILT FROM entries that already had a
 *     link. So an exact-name backfill matches literally nothing: everything
 *     still missing is missing precisely because it is not in the library.
 *   - Roughly 1,046 of those names are plausible movements; the rest are pitch
 *     sequences, count drills and coaching prose that must NEVER be given a
 *     video.
 *   - There is no YouTube API key on this project (requested, never provided),
 *     so this tool cannot source a video that does not already exist. It will
 *     not pretend otherwise.
 *
 * So the deliverable is: the exact gaps, ranked, each with the best library
 * candidate and a confidence score, and a hard count of the ones that need a
 * video filmed or found. The matcher is deliberately willing to return nothing
 * — a wrong instructional video on a youth baseball movement is worse than a
 * blank one.
 *
 * Nothing is written until "Apply changes" is pressed and confirmed.
 */

const STAFF_ROLES = new Set(['admin', 'coach']);

// PostgREST caps a select at 1,000 rows. workout_templates and exercise_videos
// are both plausibly over that, so every read is paged. (exerciseVideos.js does
// a bare .select() on the same 1,275-row table and silently truncates — worth
// fixing there separately; not this file's to touch.)
const PAGE_SIZE = 1000;

// Templates are updated one row at a time (each is a read-modify-write of its
// own JSONB array), but re-read in batches of this size.
const READ_BATCH_SIZE = 50;
const WRITE_BATCH_SIZE = 100;

// How many gap rows to render before "show more". 1,100 rows of nested
// suggestion buttons is a slow first paint for no benefit.
const VISIBLE_STEP = 100;

// Per-browser only. There is no table for "this name will never have a video"
// and this screen will not invent one or ship DDL, so the exclusion list lives
// in localStorage and the UI says so plainly.
const EXCLUSION_STORAGE_KEY = 'nbp.exerciseVideoGaps.excludedNames.v1';

// ---------------------------------------------------------------------------
// Local video-URL validation.
//
// Same rules as the Knowledge Base (https only; a small host allowlist; the URL
// must match a known video-link shape) but a deliberate local copy — importing
// from KnowledgeBase.js would couple this screen to a file being edited
// elsewhere. Unlike the KB, nothing here is iframed: workout `link` and
// training_exercises.video_url render as plain anchors, so the original URL is
// what gets stored, not an embed URL.
// ---------------------------------------------------------------------------

const VIDEO_HOST_ALLOWLIST = new Set([
  'youtube.com', 'www.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be',
  'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
  'loom.com', 'www.loom.com',
]);

const YOUTUBE_ID_RE = /^[\w-]{6,20}$/;
const VIMEO_ID_RE = /^\d{5,12}$/;
const VIMEO_HASH_RE = /^[A-Za-z0-9]{6,20}$/;
const LOOM_ID_RE = /^[A-Za-z0-9]{8,64}$/;

export const VIDEO_URL_HELP =
  'Accepted: youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/… or /live/…, vimeo.com/123456789, or loom.com/share/… . https only.';

/** @returns {{ ok: true, url: string } | { ok: false, reason: string }} */
export function validateVideoUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, reason: 'Paste a video link first.' };

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That isn't a valid URL." };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'The link must start with https://.' };

  const host = u.host.toLowerCase();
  if (!VIDEO_HOST_ALLOWLIST.has(host)) {
    return { ok: false, reason: `${host} is not an accepted video host. ${VIDEO_URL_HELP}` };
  }

  const segments = u.pathname.split('/').filter(Boolean);
  const bad = { ok: false, reason: `That link is not a recognised video address. ${VIDEO_URL_HELP}` };

  if (host === 'youtu.be') {
    return segments.length === 1 && YOUTUBE_ID_RE.test(segments[0]) ? { ok: true, url: trimmed } : bad;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return id && YOUTUBE_ID_RE.test(id) ? { ok: true, url: trimmed } : bad;
    }
    const kind = segments[0];
    if (segments.length === 2 && (kind === 'shorts' || kind === 'live' || kind === 'embed')) {
      return YOUTUBE_ID_RE.test(segments[1]) ? { ok: true, url: trimmed } : bad;
    }
    return bad;
  }
  if (host === 'player.vimeo.com') {
    return segments.length === 2 && segments[0] === 'video' && VIMEO_ID_RE.test(segments[1])
      ? { ok: true, url: trimmed } : bad;
  }
  if (host.endsWith('vimeo.com')) {
    if (!segments.length || !VIMEO_ID_RE.test(segments[0])) return bad;
    if (segments.length === 1) return { ok: true, url: trimmed };
    if (segments.length === 2 && VIMEO_HASH_RE.test(segments[1])) return { ok: true, url: trimmed };
    return bad;
  }
  if (host.endsWith('loom.com')) {
    if (segments.length !== 2) return bad;
    if (segments[0] !== 'share' && segments[0] !== 'embed') return bad;
    return LOOM_ID_RE.test(segments[1]) ? { ok: true, url: trimmed } : bad;
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Row-level security: workout_templates.
//
// Measured on the live database BEFORE #388:
//     UPDATE  qual: (created_by = auth.uid())  with_check: (created_by = auth.uid())
//
// 868 of 872 templates belong to one admin, 3 have created_by = NULL, 1 belongs
// to a second admin. Owner-only UPDATE against 872 templates with 2 owners means
// no admin and no coach can edit a template they did not create — which is what
// Cordell hit in #388, and why this screen used to refuse most of the list.
//
// supabase/migrations/20260902_workout_templates_staff_write.sql adds a second,
// permissive UPDATE policy:
//     USING / WITH CHECK  public.get_user_role() IN ('admin', 'coach')
// Permissive policies for the same command are OR-ed, so the owner-only rule is
// untouched and staff simply gain the write. DELETE is deliberately NOT widened.
//
// THIS FILE CANNOT VERIFY THE MIGRATION HAS BEEN RUN. If it has not, an UPDATE
// still comes back 200/204 with NO error and NO rows — PostgREST does not
// consider "the policy matched nothing" an error. Reporting that as success is
// the exact silent-failure class that has already cost this project a two-day
// production outage, so this screen never infers success from the absence of an
// error. Every write asks for .select('id') back and ZERO RETURNED ROWS IS A
// BLOCK, reported as "not saved" with the migration named as the likely cause.
// ---------------------------------------------------------------------------

export const OWNERSHIP = {
  EDITABLE: 'editable',   // created_by === me — the owner-only policy allows it
  STAFF: 'staff_write',   // someone else made it, but I am admin/coach — allowed
                          // by the #388 staff policy, and proved after the write
  OTHER: 'other_owner',   // someone else made it and I am not staff — refused
  ORPHAN: 'no_owner',     // created_by IS NULL and I am not staff — refused
  UNKNOWN: 'unknown',     // we could not resolve the current user; attempt and prove
};

export const RLS_PLAIN_SENTENCE =
  'A workout template belongs to whoever created it. Admins and coaches can also edit templates they did not create, which relies on the #388 staff-write policy being present in the database.';

// Shown when the database returns zero rows for an update this screen expected
// to be allowed. The overwhelmingly likely cause is the #388 migration.
export const MIGRATION_MISSING_SENTENCE =
  "That didn't save. The database is still refusing this change; the #388 migration (supabase/migrations/20260902_workout_templates_staff_write.sql) may not have been run yet.";

// What a Supabase write ACTUALLY did, given the response. The body moved to
// writeOutcome.js when #306 needed the same guarantee on a different table —
// this screen's behaviour is unchanged, and the re-export keeps the name
// importable from here for anything that already relied on it.
export { classifyWriteOutcome };

// ---------------------------------------------------------------------------
// Data access — every read is SELECT only, and every error is surfaced.
//
// This codebase has a documented production bug caused by ignoring a Supabase
// `error` and treating a failed query as an empty result. Here fetchAllRows
// THROWS, load() catches into loadError, and the screen renders the error
// instead of the report. "0 gaps found" must never be the way a failed query
// looks.
// ---------------------------------------------------------------------------

async function fetchAllRows(table, columns, orderColumn) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderColumn)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

function readExclusions() {
  try {
    const raw = window.localStorage.getItem(EXCLUSION_STORAGE_KEY);
    if (!raw) return { keys: [], available: true };
    const parsed = JSON.parse(raw);
    return { keys: Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [], available: true };
  } catch {
    // Private mode / storage disabled. The screen still works; exclusions just
    // do not survive a reload, and the note in the UI says so.
    return { keys: [], available: false };
  }
}

function writeExclusions(keys) {
  try {
    window.localStorage.setItem(EXCLUSION_STORAGE_KEY, JSON.stringify(Array.from(keys)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers. Tailwind only keeps class names it can see as complete
// literal strings, so these are full static strings, never interpolated.
// ---------------------------------------------------------------------------

const TIER_STYLES = {
  high: 'bg-green-100 text-green-800 border-green-200',
  review: 'bg-amber-100 text-amber-800 border-amber-200',
  weak: 'bg-orange-100 text-orange-800 border-orange-200',
  [NO_MATCH_TIER]: 'bg-gray-100 text-gray-600 border-gray-200',
};

const TIER_LABELS = {
  high: MATCH_TIERS.high.label,
  review: MATCH_TIERS.review.label,
  weak: MATCH_TIERS.weak.label,
  [NO_MATCH_TIER]: 'No suitable match',
};

const CLASSIFICATION_STYLES = {
  movement: 'bg-blue-50 text-blue-700 border-blue-200',
  pitch_sequence: 'bg-purple-50 text-purple-700 border-purple-200',
  count_drill: 'bg-purple-50 text-purple-700 border-purple-200',
  location_drill: 'bg-purple-50 text-purple-700 border-purple-200',
  prose: 'bg-gray-50 text-gray-600 border-gray-200',
};

const CLASSIFICATION_OPTIONS = [
  { value: 'all', label: 'All classifications' },
  { value: 'movement', label: 'Movements only' },
  { value: 'non_movement', label: 'Prescriptions (never need a video)' },
  { value: 'pitch_sequence', label: 'Pitch sequences' },
  { value: 'count_drill', label: 'Count drills' },
  { value: 'location_drill', label: 'Location drills' },
  { value: 'prose', label: 'Coaching prose' },
];

const TIER_OPTIONS = [
  { value: 'all', label: 'All confidence levels' },
  { value: 'high', label: `${MATCH_TIERS.high.label} (≥ ${MATCH_TIERS.high.min})` },
  { value: 'review', label: `${MATCH_TIERS.review.label} (≥ ${MATCH_TIERS.review.min})` },
  { value: 'weak', label: `${MATCH_TIERS.weak.label} (≥ ${MATCH_TIERS.weak.min})` },
  { value: NO_MATCH_TIER, label: 'No match — needs a video that does not exist' },
];

const EMPTY_ROWS = [];

const pct = (score) => `${Math.round(score * 100)}%`;
// Pluralise properly: 'entry' -> 'entries', not 'entryies'. Callers pass the
// singular; an explicit plural form can be given as the third argument.
const plural = (n, word, pluralForm) => {
  if (n === 1) return `${n.toLocaleString()} ${word}`;
  const many = pluralForm
    || (/[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`);
  return `${n.toLocaleString()} ${many}`;
};

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function StatCard({ value, label, detail, tone = 'default' }) {
  const tones = {
    default: 'border-gray-200 bg-white',
    good: 'border-green-200 bg-green-50',
    warn: 'border-amber-200 bg-amber-50',
    bad: 'border-red-200 bg-red-50',
    muted: 'border-gray-200 bg-gray-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone] || tones.default}`}>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-sm font-medium text-gray-700 mt-0.5">{label}</p>
      {/* gray-600, not gray-500: these cards sit on tinted red/amber/green
          backgrounds where gray-500 measures 4.42:1, just under AA. */}
      {detail && <p className="text-xs text-gray-600 mt-1 leading-snug">{detail}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function ExerciseVideoGaps({ userRole }) {
  const isStaff = STAFF_ROLES.has(userRole);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [programRows, setProgramRows] = useState([]);
  const [library, setLibrary] = useState([]);

  const [computing, setComputing] = useState(false);
  const [report, setReport] = useState(null);

  const initialExclusions = useMemo(() => readExclusions(), []);
  const [excluded, setExcluded] = useState(() => new Set(initialExclusions.keys));
  const [storageAvailable] = useState(initialExclusions.available);

  const [classificationFilter, setClassificationFilter] = useState('movement');
  const [tierFilter, setTierFilter] = useState('all');
  const [folderFilter, setFolderFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);

  // key -> { action: 'link' | 'exclude', url, matchName, displayName, occurrences, templateCount, programCount }
  const [staged, setStaged] = useState({});
  const [manualUrls, setManualUrls] = useState({});
  const [manualErrors, setManualErrors] = useState({});

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [applyResult, setApplyResult] = useState(null);

  // --- load ---------------------------------------------------------------
  const load = useCallback(async () => {
    if (!isStaff) { setLoading(false); return; }
    setLoading(true);
    setLoadError('');
    setApplyResult(null);
    try {
      // Who am I? workout_templates.created_by is compared against this to work
      // out, BEFORE anything is staged, which templates this user can actually
      // write to. A null user id is not fatal — ownership just becomes UNKNOWN
      // and every write is attempted and then proved.
      const { data: authData, error: authErr } = await supabase.auth.getUser();
      if (authErr) console.error('Could not resolve the current user:', authErr);
      setCurrentUserId(authData?.user?.id || null);

      const [templateRows, exerciseRows, videoRows] = await Promise.all([
        fetchAllRows('workout_templates', 'id, name, folder, exercises, created_by', 'id'),
        fetchAllRows('training_exercises', 'id, name, video_url, day_id', 'id'),
        fetchAllRows('exercise_videos', 'name, name_key, video_url', 'name_key'),
      ]);
      setTemplates(templateRows);
      setProgramRows(exerciseRows);
      setLibrary(videoRows);
    } catch (e) {
      console.error('Exercise video gap analysis failed to load:', e);
      setLoadError(formatUserError(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [isStaff]);

  useEffect(() => { load(); }, [load]);

  // --- who can write what --------------------------------------------------
  // #388: the rule is "I created it OR I am staff", not "I created it". Only
  // admins and coaches reach this screen at all, so in practice every owned
  // template is now writable; OTHER and UNKNOWN survive as the honest answer if
  // isStaff is ever false here.
  const templateOwnership = useMemo(() => {
    const map = new Map();
    templates.forEach((t) => {
      const owner = t.created_by || null;
      // #458: the staff-write policy (live since #388) has no created_by
      // condition, so staff can save ownerless templates too.
      if (!owner) map.set(t.id, isStaff ? OWNERSHIP.STAFF : OWNERSHIP.ORPHAN);
      else if (currentUserId && owner === currentUserId) map.set(t.id, OWNERSHIP.EDITABLE);
      else if (isStaff) map.set(t.id, OWNERSHIP.STAFF);
      else if (!currentUserId) map.set(t.id, OWNERSHIP.UNKNOWN);
      else map.set(t.id, OWNERSHIP.OTHER);
    });
    return map;
  }, [templates, currentUserId, isStaff]);

  // --- collect the raw gaps ------------------------------------------------
  const gaps = useMemo(() => {
    const out = [];
    templates.forEach((t) => {
      const list = Array.isArray(t.exercises) ? t.exercises : [];
      list.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        const name = String(item.name || '').trim();
        if (!name) return;
        if (String(item.link || '').trim()) return; // already linked
        out.push({
          name,
          source: 'template',
          folder: t.folder || 'Uncategorised templates',
          templateId: t.id,
          templateName: t.name || '(untitled template)',
          index,
          ownership: templateOwnership.get(t.id) || OWNERSHIP.UNKNOWN,
        });
      });
    });
    programRows.forEach((row) => {
      const name = String(row.name || '').trim();
      if (!name) return;
      if (String(row.video_url || '').trim()) return;
      out.push({
        name,
        source: 'program',
        folder: 'Assigned programs',
        exerciseId: row.id,
        dayId: row.day_id,
        // training_exercises is governed by the "Coaches can…" policies, not by
        // ownership — but the write is still proved rather than assumed.
        ownership: OWNERSHIP.EDITABLE,
      });
    });
    return out;
  }, [templates, programRows, templateOwnership]);

  // --- compute the report --------------------------------------------------
  // Yielded through a timeout so React paints the "Matching…" state first: the
  // full run is a few hundred milliseconds on a mid-range laptop, which is long
  // enough to drop frames if it happens inline during render.
  useEffect(() => {
    if (!isStaff || loading || loadError) return undefined;
    setComputing(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      const built = buildGapReport(gaps, library, { excludedKeys: excluded, limit: 3 });
      if (cancelled) return;
      setReport(built);
      setComputing(false);
    }, 0);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [gaps, library, excluded, loading, loadError, isStaff]);

  // Stable identity when there is no report yet, so the memos below don't
  // recompute on every render against a fresh [].
  const rows = useMemo(() => (report ? report.rows : EMPTY_ROWS), [report]);
  const summary = report ? report.summary : null;

  const folders = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => r.folders.forEach((f) => set.add(f)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Facility-wide picture of what this user is actually allowed to write.
  const ownershipStats = useMemo(() => {
    let editableEntries = 0;
    let staffEntries = 0;
    let otherEntries = 0;
    let orphanEntries = 0;
    let unknownEntries = 0;
    let programEntries = 0;
    const editableTemplates = new Set();
    const staffTemplates = new Set();
    const otherTemplates = new Set();
    const orphanTemplates = new Set();
    gaps.forEach((g) => {
      if (g.source !== 'template') { programEntries += 1; return; }
      if (g.ownership === OWNERSHIP.OTHER) { otherEntries += 1; otherTemplates.add(g.templateId); }
      else if (g.ownership === OWNERSHIP.ORPHAN) { orphanEntries += 1; orphanTemplates.add(g.templateId); }
      else if (g.ownership === OWNERSHIP.UNKNOWN) { unknownEntries += 1; editableTemplates.add(g.templateId); }
      // #388: not mine, but I am staff. Attemptable, and proved after the write.
      else if (g.ownership === OWNERSHIP.STAFF) {
        staffEntries += 1;
        editableTemplates.add(g.templateId);
        staffTemplates.add(g.templateId);
      } else { editableEntries += 1; editableTemplates.add(g.templateId); }
    });
    const attemptableEntries = editableEntries + staffEntries + unknownEntries;
    return {
      editableEntries,
      staffEntries,
      staffTemplates: staffTemplates.size,
      unknownEntries,
      attemptableEntries,
      otherEntries,
      orphanEntries,
      programEntries,
      blockedEntries: otherEntries + orphanEntries,
      editableTemplates: editableTemplates.size,
      otherTemplates: otherTemplates.size,
      orphanTemplates: orphanTemplates.size,
      // Nothing in any template is writable by this user. The Apply button must
      // not pretend otherwise.
      noTemplateAccess: attemptableEntries === 0 && (otherEntries + orphanEntries) > 0,
      ownerUnknown: !currentUserId,
    };
  }, [gaps, currentUserId]);

  // Per gap-row: how many of its occurrences this user can actually write.
  const rowWritability = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => {
      let templateWritable = 0;
      let blockedOther = 0;
      let blockedOrphan = 0;
      let programEntries = 0;
      (row.refs || []).forEach((ref) => {
        if (ref.source !== 'template') { programEntries += 1; return; }
        if (ref.ownership === OWNERSHIP.OTHER) blockedOther += 1;
        else if (ref.ownership === OWNERSHIP.ORPHAN) blockedOrphan += 1;
        else templateWritable += 1;
      });
      map.set(row.key, {
        templateWritable,
        blockedOther,
        blockedOrphan,
        programEntries,
        writableTotal: templateWritable + programEntries,
        blockedTotal: blockedOther + blockedOrphan,
      });
    });
    return map;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (classificationFilter === 'movement' && !row.isMovement) return false;
      if (classificationFilter === 'non_movement' && row.isMovement) return false;
      if (classificationFilter !== 'all'
        && classificationFilter !== 'movement'
        && classificationFilter !== 'non_movement'
        && row.classification !== classificationFilter) return false;
      if (tierFilter !== 'all' && row.tier !== tierFilter) return false;
      if (folderFilter !== 'all' && !row.folders.includes(folderFilter)) return false;
      if (q && !row.displayName.toLowerCase().includes(q) && !row.normalized.includes(q)) return false;
      return true;
    });
  }, [rows, classificationFilter, tierFilter, folderFilter, search]);

  useEffect(() => { setVisibleCount(VISIBLE_STEP); },
    [classificationFilter, tierFilter, folderFilter, search]);

  // --- staging -------------------------------------------------------------
  const stageLink = useCallback((row, url, matchName) => {
    const check = validateVideoUrl(url);
    if (!check.ok) {
      setManualErrors((prev) => ({ ...prev, [row.key]: check.reason }));
      return;
    }
    setManualErrors((prev) => { const next = { ...prev }; delete next[row.key]; return next; });
    const w = rowWritability.get(row.key);
    setStaged((prev) => ({
      ...prev,
      [row.key]: {
        action: 'link',
        url: check.url,
        matchName: matchName || 'pasted link',
        displayName: row.displayName,
        occurrences: row.occurrences,
        templateCount: row.templateCount,
        programCount: row.programCount,
        // Split at stage time so the sticky bar can never claim to be about to
        // write entries that RLS will refuse.
        writableEntries: w ? w.writableTotal : row.occurrences,
        blockedEntries: w ? w.blockedTotal : 0,
        writableTemplateEntries: w ? w.templateWritable : row.templateCount,
        programEntries: w ? w.programEntries : row.programCount,
      },
    }));
  }, [rowWritability]);

  const stageExclude = useCallback((row) => {
    setStaged((prev) => ({
      ...prev,
      [row.key]: {
        action: 'exclude',
        displayName: row.displayName,
        occurrences: row.occurrences,
        templateCount: row.templateCount,
        programCount: row.programCount,
      },
    }));
  }, []);

  const unstage = useCallback((key) => {
    setStaged((prev) => { const next = { ...prev }; delete next[key]; return next; });
  }, []);

  const stagedStats = useMemo(() => {
    const entries = Object.entries(staged);
    let linkNames = 0;
    let templateEntries = 0;
    let programEntries = 0;
    let blockedEntries = 0;
    let fullyBlockedNames = 0;
    let excludeNames = 0;
    let excludeEntries = 0;
    entries.forEach(([, item]) => {
      if (item.action === 'link') {
        linkNames += 1;
        templateEntries += item.writableTemplateEntries || 0;
        programEntries += item.programEntries || 0;
        blockedEntries += item.blockedEntries || 0;
        if ((item.writableEntries || 0) === 0) fullyBlockedNames += 1;
      } else {
        excludeNames += 1;
        excludeEntries += item.occurrences;
      }
    });
    return {
      total: entries.length,
      linkNames,
      // Counts below are WRITABLE entries only — blockedEntries is reported
      // alongside, never folded in.
      templateEntries,
      programEntries,
      linkEntries: templateEntries + programEntries,
      blockedEntries,
      fullyBlockedNames,
      excludeNames,
      excludeEntries,
    };
  }, [staged]);

  // --- apply (the only mutating code in this file) -------------------------
  const applyChanges = useCallback(async () => {
    setApplying(true);
    setApplyResult(null);
    setConfirmOpen(false);

    const linkStagings = Object.entries(staged).filter(([, s]) => s.action === 'link');
    const excludeKeys = Object.entries(staged).filter(([, s]) => s.action === 'exclude').map(([k]) => k);
    const urlByKey = new Map(linkStagings.map(([k, s]) => [k, s.url]));

    // Which template rows and which program rows could possibly be touched —
    // and which of them the owner-only UPDATE policy will refuse outright.
    // Those are skipped rather than fired off: a request that comes back
    // 200-with-zero-rows tells the user nothing, and counting it as a write
    // would be a lie.
    const candidateTemplateIds = new Set();
    // Templates this account does not own but expects to write because it is
    // staff (#388). If one of these comes back with zero rows, the staff policy
    // is missing rather than the ownership check being wrong.
    const staffOverrideTemplateIds = new Set();
    const candidateProgramIds = [];
    const blockedOtherTemplates = new Set();
    const blockedOrphanTemplates = new Set();
    let templateEntriesBlockedOther = 0;
    let templateEntriesBlockedOrphan = 0;
    gaps.forEach((gap) => {
      const key = normalizeExerciseName(gap.name);
      if (!urlByKey.has(key)) return;
      if (gap.source !== 'template') { candidateProgramIds.push(gap.exerciseId); return; }
      if (gap.ownership === OWNERSHIP.OTHER) {
        templateEntriesBlockedOther += 1;
        blockedOtherTemplates.add(gap.templateId);
        return;
      }
      if (gap.ownership === OWNERSHIP.ORPHAN) {
        templateEntriesBlockedOrphan += 1;
        blockedOrphanTemplates.add(gap.templateId);
        return;
      }
      if (gap.ownership === OWNERSHIP.STAFF) staffOverrideTemplateIds.add(gap.templateId);
      candidateTemplateIds.add(gap.templateId);
    });

    const templateIds = Array.from(candidateTemplateIds);
    const failures = [];
    const blockedUnexpectedTemplates = new Set();
    let templatesUpdated = 0;
    let templateEntriesWritten = 0;
    let templateEntriesBlockedUnexpected = 0;
    let templateEntriesBlockedStaffPolicy = 0;
    let programRowsWritten = 0;
    let programRowsBlocked = 0;

    const totalSteps = templateIds.length + Math.ceil(candidateProgramIds.length / WRITE_BATCH_SIZE) + 1;
    let done = 0;
    setProgress({ done: 0, total: totalSteps });
    const tick = () => { done += 1; setProgress({ done, total: totalSteps }); };

    try {
      // --- workout_templates: read-modify-write each JSONB array -----------
      // Re-read immediately before writing rather than trusting the copy loaded
      // when the screen opened — a coach may have edited a template in the
      // meantime, and this must never clobber their change.
      for (let i = 0; i < templateIds.length; i += READ_BATCH_SIZE) {
        const batch = templateIds.slice(i, i + READ_BATCH_SIZE);
        const { data: fresh, error: readErr } = await supabase
          .from('workout_templates')
          .select('id, name, exercises')
          .in('id', batch);
        if (readErr) {
          console.error('Re-reading workout templates failed:', readErr);
          failures.push({ what: `${batch.length} workout template(s)`, message: formatUserError(readErr) });
          batch.forEach(tick);
          continue;
        }
        const returned = fresh || [];
        // A template deleted between load and now simply is not in `fresh`.
        // Tick for the missing ones so the bar still reaches 100%.
        if (returned.length < batch.length) {
          for (let k = returned.length; k < batch.length; k += 1) tick();
        }
        for (const tpl of returned) {
          const list = Array.isArray(tpl.exercises) ? tpl.exercises : [];
          let changed = 0;
          const next = list.map((item) => {
            if (!item || typeof item !== 'object') return item;
            // Idempotent and non-destructive: an entry that already has a link
            // is left exactly as it is, so re-running writes nothing.
            if (String(item.link || '').trim()) return item;
            const url = urlByKey.get(normalizeExerciseName(item.name || ''));
            if (!url) return item;
            changed += 1;
            return { ...item, link: url };
          });
          if (changed === 0) { tick(); continue; }
          // .select('id') is what makes this honest: without it a policy-refused
          // UPDATE is indistinguishable from a successful one.
          const { data: updated, error: updErr } = await supabase
            .from('workout_templates')
            .update({ exercises: next })
            .eq('id', tpl.id)
            .select('id');
          const outcome = classifyWriteOutcome({ error: updErr, data: updated, expected: 1 });
          if (outcome.outcome === 'errored') {
            console.error('Updating workout template failed:', tpl.id, updErr);
            failures.push({ what: `template "${tpl.name || tpl.id}"`, message: formatUserError(updErr) });
          } else if (outcome.outcome === 'blocked') {
            // We believed this one was writable and the database disagreed.
            // Never report it as written. If it was a staff-override template,
            // the #388 policy is the thing that is missing.
            console.warn('Update refused by row-level security (0 rows) for template', tpl.id);
            blockedUnexpectedTemplates.add(tpl.id);
            templateEntriesBlockedUnexpected += changed;
            if (staffOverrideTemplateIds.has(tpl.id)) templateEntriesBlockedStaffPolicy += changed;
          } else {
            templatesUpdated += 1;
            templateEntriesWritten += changed;
          }
          tick();
        }
      }

      // --- training_exercises: plain column update -------------------------
      for (let i = 0; i < candidateProgramIds.length; i += WRITE_BATCH_SIZE) {
        const batch = candidateProgramIds.slice(i, i + WRITE_BATCH_SIZE);
        const { data: fresh, error: readErr } = await supabase
          .from('training_exercises')
          .select('id, name, video_url')
          .in('id', batch);
        if (readErr) {
          console.error('Re-reading training exercises failed:', readErr);
          failures.push({ what: `${batch.length} assigned program row(s)`, message: formatUserError(readErr) });
          tick();
          continue;
        }
        // Group still-empty rows by the URL they should get, so each URL is one
        // update statement rather than one per row.
        const byUrl = new Map();
        (fresh || []).forEach((row) => {
          if (String(row.video_url || '').trim()) return; // never overwrite
          const url = urlByKey.get(normalizeExerciseName(row.name || ''));
          if (!url) return;
          const bucket = byUrl.get(url);
          if (bucket) bucket.push(row.id);
          else byUrl.set(url, [row.id]);
        });
        for (const [url, ids] of byUrl) {
          // Same proof here. training_exercises is governed by the "Coaches
          // can…" policies rather than by ownership, so this should always come
          // back full — but it costs one column to know instead of assume.
          const { data: updatedRows, error: updErr } = await supabase
            .from('training_exercises')
            .update({ video_url: url })
            .in('id', ids)
            .select('id');
          const outcome = classifyWriteOutcome({ error: updErr, data: updatedRows, expected: ids.length });
          if (outcome.outcome === 'errored') {
            console.error('Updating training exercises failed:', updErr);
            failures.push({ what: `${ids.length} assigned program row(s)`, message: formatUserError(updErr) });
          } else {
            if (outcome.blocked > 0) {
              console.warn('Row-level security refused', outcome.blocked, 'training_exercises row(s)');
            }
            programRowsWritten += outcome.written;
            programRowsBlocked += outcome.blocked;
          }
        }
        tick();
      }

      // --- exclusions (localStorage only, never the database) --------------
      let exclusionsSaved = true;
      if (excludeKeys.length > 0) {
        const nextExcluded = new Set(excluded);
        excludeKeys.forEach((k) => nextExcluded.add(k));
        exclusionsSaved = writeExclusions(nextExcluded);
        setExcluded(nextExcluded);
      }
      tick();

      setStaged({});

      // Reload FIRST so the numbers on screen are the database's numbers, not
      // ours — load() clears applyResult, so the banner is set after it, never
      // before. (DuplicateProducts.js hit exactly this and says so too.)
      await load();

      const templateEntriesBlocked =
        templateEntriesBlockedOther + templateEntriesBlockedOrphan + templateEntriesBlockedUnexpected;
      const templatesBlocked =
        blockedOtherTemplates.size + blockedOrphanTemplates.size + blockedUnexpectedTemplates.size;

      setApplyResult({
        // "ok" means everything staged actually landed. A blocked write is not
        // an error, but it is emphatically not a success either.
        ok: failures.length === 0 && templateEntriesBlocked === 0 && programRowsBlocked === 0,
        templatesUpdated,
        templateEntriesWritten,
        templateEntriesBlockedOther,
        templateEntriesBlockedOrphan,
        templateEntriesBlockedUnexpected,
        templateEntriesBlockedStaffPolicy,
        templateEntriesBlocked,
        templatesBlocked,
        programRowsWritten,
        programRowsBlocked,
        excludedNames: excludeKeys.length,
        exclusionsSaved,
        failures,
      });
    } catch (e) {
      console.error('Applying exercise video links failed:', e);
      setApplyResult({
        ok: false,
        templatesUpdated,
        templateEntriesWritten,
        templateEntriesBlockedOther,
        templateEntriesBlockedOrphan,
        templateEntriesBlockedUnexpected,
        templateEntriesBlockedStaffPolicy,
        templateEntriesBlocked:
          templateEntriesBlockedOther + templateEntriesBlockedOrphan + templateEntriesBlockedUnexpected,
        templatesBlocked:
          blockedOtherTemplates.size + blockedOrphanTemplates.size + blockedUnexpectedTemplates.size,
        programRowsWritten,
        programRowsBlocked,
        excludedNames: 0,
        exclusionsSaved: true,
        failures: [...failures, { what: 'the run', message: formatUserError(e) }],
      });
    } finally {
      setApplying(false);
      setProgress({ done: 0, total: 0 });
    }
  }, [staged, gaps, excluded, load]);

  const restoreExclusions = useCallback(() => {
    writeExclusions([]);
    setExcluded(new Set());
  }, []);

  // --- CSV -----------------------------------------------------------------
  // Hand-rolled: papaparse / xlsx are not dependencies of this project and this
  // does not justify adding one.
  const exportCsv = useCallback(() => {
    if (!report) return;
    const headers = [
      'name', 'normalized_name', 'occurrences', 'template_entries', 'program_entries',
      'folders', 'classification', 'needs_a_new_video',
      'best_match', 'best_match_score', 'best_match_tier', 'best_match_url',
      'second_match', 'second_match_score',
    ];
    const body = report.rows.map((row) => {
      const first = row.matches[0];
      const second = row.matches[1];
      const needsNew = row.isMovement && (!first || first.tier === 'weak') ? 'yes' : 'no';
      return [
        row.displayName,
        row.normalized,
        row.occurrences,
        row.templateCount,
        row.programCount,
        row.folders.join(' | '),
        CLASSIFICATION_LABELS[row.classification] || row.classification,
        needsNew,
        first ? first.name : '',
        first ? first.score.toFixed(3) : '',
        first ? first.tier : NO_MATCH_TIER,
        first ? first.video_url : '',
        second ? second.name : '',
        second ? second.score.toFixed(3) : '',
      ].map(csvCell).join(',');
    });
    const csv = [headers.join(','), ...body].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `exercise-video-gaps-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [report]);

  // --- render --------------------------------------------------------------

  if (!isStaff) {
    return (
      <div className="bg-white rounded-lg shadow border border-gray-200 p-8 text-center">
        <AlertTriangle size={28} className="text-amber-500 mx-auto mb-2" />
        <p className="text-sm text-gray-600">This tool is available to coaches and admins only.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-500 flex items-center justify-center gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading workouts, programs and the video library…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Could not load the exercise data, so no gap report can be shown.</p>
          <p className="mt-1">{loadError}</p>
          <p className="mt-1 text-xs text-red-600">
            This is a failed query, not an empty result — do not read it as “no missing videos”.
          </p>
          <button
            type="button"
            onClick={load}
            className="mt-2 inline-flex items-center gap-1 text-red-800 underline focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
          >
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (computing || !summary) {
    return (
      <div className="text-center py-12 text-gray-500 flex items-center justify-center gap-2" role="status">
        <Loader2 size={16} className="animate-spin" />
        <span>Matching {gaps.length.toLocaleString()} unlinked entries against {library.length.toLocaleString()} library videos…</span>
      </div>
    );
  }

  const visibleRows = filteredRows.slice(0, visibleCount);
  const coveragePossible = summary.coverableHighNames + summary.needsReviewNames;

  return (
    <div className="space-y-6 pb-28">
      {/* ---------------- headline ---------------- */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Video size={22} className="text-blue-600 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Missing exercise videos</h2>
              <p className="text-sm text-gray-600 mt-1 max-w-3xl">
                Every workout entry and assigned-program row with no video link, grouped by movement
                and matched against the {summary.librarySize.toLocaleString()}-video library.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <Download size={14} /> Export CSV ({summary.distinctNames.toLocaleString()} names)
            </button>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <RefreshCw size={14} /> Reload
            </button>
          </div>
        </div>

        <div className="grid gap-3 mt-5 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            value={summary.totalOccurrences.toLocaleString()}
            label="Entries with no video link"
            detail={`${summary.templateOccurrences.toLocaleString()} in workout templates · ${summary.programOccurrences.toLocaleString()} in assigned programs`}
          />
          <StatCard
            value={summary.distinctNames.toLocaleString()}
            label="Distinct names behind them"
            detail={`${summary.movementNames.toLocaleString()} look like real movements · ${summary.nonMovementNames.toLocaleString()} are prescriptions that should never have a video`}
          />
          <StatCard
            tone="good"
            value={summary.coverableHighNames.toLocaleString()}
            label="Fillable from the library now"
            detail={`${MATCH_TIERS.high.label.toLowerCase()} (≥ ${MATCH_TIERS.high.min}) — covers ${plural(summary.coverableHighOccurrences, 'entry')}. A further ${summary.needsReviewNames.toLocaleString()} need a human to confirm.`}
          />
          <StatCard
            tone="bad"
            value={summary.needsNewVideoNames.toLocaleString()}
            label="Need a video that does not exist"
            detail={`Nothing in the library is close enough. Someone has to film or find these — ${plural(summary.needsNewVideoOccurrences, 'entry')} depend on them.`}
          />
        </div>

        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 flex items-start gap-2">
          <Info size={15} className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p>
              <span className="font-semibold">The honest version of #170:</span> the video library was
              built from entries that already had a link, so an exact-name backfill matches nothing at
              all. Of {summary.distinctNames.toLocaleString()} unlinked names, the library can cover{' '}
              <strong>{summary.coverableHighNames.toLocaleString()}</strong> confidently and{' '}
              <strong>{coveragePossible.toLocaleString()}</strong> at best with review. The remaining{' '}
              <strong>{summary.needsNewVideoNames.toLocaleString()}</strong> movements need a video
              sourced or filmed.
            </p>
            <p className="text-blue-800">
              There is no YouTube API key on this project, so nothing here can go and find new videos.
              This screen makes the gap countable and clearable by hand — it does not close it on its own.
            </p>
            <p className="text-blue-800">
              Suggestions are string similarity, not understanding. When nothing scores well enough the
              tool says <em>no suitable match</em> rather than offering the closest wrong video.
            </p>
          </div>
        </div>

        {/* --- what this user is actually allowed to write --- */}
        <div
          className={`mt-3 rounded-lg border p-3 text-sm flex items-start gap-2 ${
            ownershipStats.noTemplateAccess
              ? 'border-red-300 bg-red-50 text-red-900'
              : ownershipStats.blockedEntries > 0
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-gray-200 bg-gray-50 text-gray-700'
          }`}
          role="status"
        >
          {ownershipStats.noTemplateAccess
            ? <Lock size={15} className="mt-0.5 shrink-0" />
            : <ShieldAlert size={15} className="mt-0.5 shrink-0" />}
          <div className="space-y-1">
            {ownershipStats.noTemplateAccess ? (
              <p className="font-semibold">
                You cannot save changes to any of these workout templates. Every one of the{' '}
                {ownershipStats.blockedEntries.toLocaleString()} template entries below was created by
                someone else{ownershipStats.orphanEntries > 0 ? ' or has no owner recorded' : ''}.
              </p>
            ) : (
              <p>
                <span className="font-semibold">
                  {plural(ownershipStats.attemptableEntries, 'template entry')}
                </span>{' '}
                {ownershipStats.attemptableEntries === 1 ? 'is' : 'are'} in templates you can edit
                ({plural(ownershipStats.editableTemplates, 'template')}).
                {ownershipStats.staffEntries > 0 && (
                  <> {plural(ownershipStats.staffEntries, 'entry')} of those sit in{' '}
                  {plural(ownershipStats.staffTemplates, 'template')} created by someone else and are
                  editable because you are staff (#388). Each of those writes is checked against what
                  the database actually changed.</>
                )}
                {ownershipStats.otherEntries > 0 && (
                  <> {plural(ownershipStats.otherEntries, 'entry')} sit in{' '}
                  {plural(ownershipStats.otherTemplates, 'template')} created by someone else and
                  cannot be saved from this account.</>
                )}
                {ownershipStats.orphanEntries > 0 && (
                  <> {plural(ownershipStats.orphanEntries, 'entry')} sit in{' '}
                  {plural(ownershipStats.orphanTemplates, 'template')} with no owner recorded; this
                  screen does not write to those.</>
                )}
              </p>
            )}
            <p>{RLS_PLAIN_SENTENCE}</p>
            {ownershipStats.programEntries > 0 && (
              <p>
                The {plural(ownershipStats.programEntries, 'assigned-program row')} below{' '}
                {ownershipStats.programEntries === 1 ? 'is' : 'are'} not owner-gated, so those can be
                saved either way.
              </p>
            )}
            {ownershipStats.ownerUnknown && (
              <p className="font-medium">
                Your user account could not be read, so nothing could be checked in advance. Writes
                will still be attempted and each one verified — anything the database refuses is
                reported as blocked, never as saved.
              </p>
            )}
          </div>
        </div>

        {summary.unusableOccurrences > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            {plural(summary.unusableOccurrences, 'entry')} had a name that is blank or pure
            punctuation and were left out of the report entirely.
          </p>
        )}
      </div>

      {/* ---------------- exclusions note ---------------- */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <div>
          <p>
            <span className="font-medium">“Not a movement” is stored in this browser only.</span>{' '}
            There is no table for it, and this screen will not invent one.{' '}
            {excluded.size > 0
              ? `${plural(excluded.size, 'name')} currently hidden on this browser.`
              : 'Nothing is hidden yet.'}{' '}
            Another coach, another laptop, or a cleared cache sees the full list again. Making it stick
            needs a small table (name_key + reason) and a migration — a separate, deliberate piece of work.
          </p>
          {!storageAvailable && (
            <p className="mt-1 font-medium">
              This browser is blocking local storage, so exclusions will not survive a reload at all.
            </p>
          )}
          {excluded.size > 0 && (
            <button
              type="button"
              onClick={restoreExclusions}
              className="mt-2 inline-flex items-center gap-1 text-amber-900 underline focus:outline-none focus:ring-2 focus:ring-amber-500 rounded"
            >
              <Undo2 size={13} /> Show the {excluded.size} hidden name{excluded.size === 1 ? '' : 's'} again
            </button>
          )}
        </div>
      </div>

      {/* ---------------- apply result ---------------- */}
      {applyResult && (
        <div
          className={`rounded-lg border p-4 text-sm ${applyResult.ok ? 'border-green-200 bg-green-50 text-green-900' : 'border-red-200 bg-red-50 text-red-900'}`}
          role="status"
        >
          <p className="font-medium flex items-center gap-2">
            {applyResult.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {applyResult.ok
              ? 'Changes applied.'
              : (applyResult.templateEntriesWritten + applyResult.programRowsWritten === 0
                ? 'Nothing was saved.'
                : applyResult.failures.length > 0
                  ? 'Applied with failures.'
                  : 'Partly applied — some changes were blocked.')}
          </p>

          {/* Written, blocked and errored are three different things and are
              never merged into one "succeeded/failed" number. */}
          <p className="mt-2 font-medium">Written</p>
          <ul className="space-y-0.5 list-disc list-inside">
            <li>{plural(applyResult.templateEntriesWritten, 'workout entry')} linked across {plural(applyResult.templatesUpdated, 'template')}.</li>
            <li>{plural(applyResult.programRowsWritten, 'assigned-program row')} linked.</li>
            {applyResult.excludedNames > 0 && (
              <li>
                {plural(applyResult.excludedNames, 'name')} marked “not a movement”
                {applyResult.exclusionsSaved ? ' (saved in this browser).' : ' — but this browser refused to store it, so it will come back on reload.'}
              </li>
            )}
          </ul>

          {(applyResult.templateEntriesBlocked > 0 || applyResult.programRowsBlocked > 0) && (
            <div className="mt-2">
              <p className="font-medium flex items-center gap-1.5">
                <Lock size={14} /> Blocked by permissions — not saved, and not an error
              </p>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {applyResult.templateEntriesBlockedOther > 0 && (
                  <li>
                    {plural(applyResult.templateEntriesBlockedOther, 'workout entry')} in templates created
                    by someone else. Nothing was sent for these.
                  </li>
                )}
                {applyResult.templateEntriesBlockedOrphan > 0 && (
                  <li>
                    {plural(applyResult.templateEntriesBlockedOrphan, 'workout entry')} in templates with no
                    owner recorded. This screen does not write to those; nothing was sent for them.
                  </li>
                )}
                {applyResult.templateEntriesBlockedUnexpected > 0 && (
                  <li>
                    {plural(applyResult.templateEntriesBlockedUnexpected, 'workout entry')} the database
                    refused even though this account appeared able to write the template — the update
                    returned zero rows. Treated as not saved.
                    {applyResult.templateEntriesBlockedStaffPolicy > 0 && (
                      <> {plural(applyResult.templateEntriesBlockedStaffPolicy, 'entry')} of those{' '}
                      {applyResult.templateEntriesBlockedStaffPolicy === 1 ? 'was' : 'were'} in a
                      template created by someone else. <strong>{MIGRATION_MISSING_SENTENCE}</strong></>
                    )}
                  </li>
                )}
                {applyResult.programRowsBlocked > 0 && (
                  <li>
                    {plural(applyResult.programRowsBlocked, 'assigned-program row')} returned zero rows on
                    update and were not saved.
                  </li>
                )}
              </ul>
              <p className="mt-1 text-xs">{RLS_PLAIN_SENTENCE}</p>
            </div>
          )}

          {applyResult.failures.length > 0 && (
            <div className="mt-2">
              <p className="font-medium">Errored — {plural(applyResult.failures.length, 'failure')}:</p>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {applyResult.failures.slice(0, 8).map((f, i) => (
                  <li key={i}>{f.what}: {f.message}</li>
                ))}
              </ul>
              {applyResult.failures.length > 8 && (
                <p className="mt-1 text-xs">…and {applyResult.failures.length - 8} more. See the browser console.</p>
              )}
              <p className="mt-1 text-xs">
                Nothing was rolled back — PostgREST gives the browser no transaction. Everything above
                that succeeded is written; re-running is safe, it only fills entries that are still empty.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------------- filters ---------------- */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="evg-search" className="block text-xs font-medium text-gray-700 mb-1">Search names</label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                id="evg-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. squat"
                className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label htmlFor="evg-classification" className="block text-xs font-medium text-gray-700 mb-1">Classification</label>
            <select
              id="evg-classification"
              value={classificationFilter}
              onChange={(e) => setClassificationFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CLASSIFICATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="evg-tier" className="block text-xs font-medium text-gray-700 mb-1">Match confidence</label>
            <select
              id="evg-tier"
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TIER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="evg-folder" className="block text-xs font-medium text-gray-700 mb-1">Folder</label>
            <select
              id="evg-folder"
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All folders</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Showing {Math.min(visibleCount, filteredRows.length).toLocaleString()} of{' '}
          {filteredRows.length.toLocaleString()} matching names ({summary.distinctNames.toLocaleString()} in total).
          {classificationFilter === 'movement' && ' Prescriptions are hidden — switch the classification filter to check them.'}
        </p>
      </div>

      {/* ---------------- rows ---------------- */}
      {filteredRows.length === 0 ? (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-10 text-center">
          <CheckCircle2 size={30} className="text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-600">No names match these filters.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">
                Exercise names with no video link, their suggested library matches and the action staged for each.
              </caption>
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Exercise name</th>
                  <th scope="col" className="px-4 py-2 font-medium whitespace-nowrap">Appears in</th>
                  <th scope="col" className="px-4 py-2 font-medium">Best library matches</th>
                  <th scope="col" className="px-4 py-2 font-medium">Staged action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleRows.map((row) => {
                  const stagedRow = staged[row.key];
                  const w = rowWritability.get(row.key)
                    || { writableTotal: row.occurrences, blockedTotal: 0, blockedOther: 0, blockedOrphan: 0 };
                  const fullyBlocked = w.writableTotal === 0 && w.blockedTotal > 0;
                  return (
                    <tr key={row.key} className={stagedRow ? 'bg-blue-50/40 align-top' : 'align-top'}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900 break-words max-w-md">{row.displayName}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${CLASSIFICATION_STYLES[row.classification] || CLASSIFICATION_STYLES.prose}`}>
                            {CLASSIFICATION_LABELS[row.classification] || row.classification}
                          </span>
                          <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${TIER_STYLES[row.tier]}`}>
                            {TIER_LABELS[row.tier]}
                          </span>
                        </div>
                        {row.folders.length > 0 && (
                          <p className="mt-1 text-[11px] text-gray-500 break-words max-w-md">{row.folders.join(' · ')}</p>
                        )}
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap text-gray-700">
                        <p className="font-medium">{row.occurrences.toLocaleString()} place{row.occurrences === 1 ? '' : 's'}</p>
                        <p className="text-xs text-gray-500">{row.templateCount.toLocaleString()} workout entr{row.templateCount === 1 ? 'y' : 'ies'}</p>
                        <p className="text-xs text-gray-500">{row.programCount.toLocaleString()} program row{row.programCount === 1 ? '' : 's'}</p>
                        {w.blockedTotal > 0 && (
                          <p className={`mt-1 inline-flex items-start gap-1 rounded border px-1.5 py-0.5 text-[11px] ${fullyBlocked ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
                            <Lock size={11} className="mt-px shrink-0" />
                            <span>
                              {fullyBlocked
                                ? "You can't save any of these"
                                : `${w.blockedTotal.toLocaleString()} of ${row.occurrences.toLocaleString()} can't be saved`}
                              {w.blockedOrphan > 0 && w.blockedOther === 0
                                ? ' — no template owner'
                                : ' — template owned by someone else'}
                            </span>
                          </p>
                        )}
                      </td>

                      <td className="px-4 py-3 min-w-[18rem]">
                        {!row.isMovement ? (
                          <p className="text-xs text-gray-500 max-w-sm">
                            Not a movement — this is a prescription, so no video is suggested for it at all.
                          </p>
                        ) : row.matches.length === 0 ? (
                          <p className="text-xs text-gray-600 max-w-sm">
                            <span className="font-medium text-gray-800">No suitable match.</span>{' '}
                            Nothing in the library scores above {MATCH_TIERS.weak.min}. This movement needs a
                            video filmed or found — paste one below once you have it.
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            {row.matches.map((m) => (
                              <li key={m.name_key} className="flex items-start gap-2 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => stageLink(row, m.video_url, m.name)}
                                  className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                  <Check size={12} /> Use this video
                                </button>
                                <span className="text-xs text-gray-700 break-words max-w-[14rem]">{m.name}</span>
                                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${TIER_STYLES[m.tier]}`}>
                                  {pct(m.score)}
                                </span>
                                <a
                                  href={m.video_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                                  aria-label={`Open the video for ${m.name} in a new tab`}
                                >
                                  <ExternalLink size={13} />
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}

                        {row.isMovement && (
                          <div className="mt-2">
                            <label htmlFor={`evg-url-${row.key}`} className="block text-[11px] font-medium text-gray-600 mb-1">
                              Or paste a video URL for “{row.displayName}”
                            </label>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <input
                                id={`evg-url-${row.key}`}
                                type="url"
                                value={manualUrls[row.key] || ''}
                                onChange={(e) => setManualUrls((prev) => ({ ...prev, [row.key]: e.target.value }))}
                                placeholder="https://www.youtube.com/watch?v=…"
                                className="flex-1 min-w-[12rem] px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <button
                                type="button"
                                onClick={() => stageLink(row, manualUrls[row.key] || '', 'pasted link')}
                                className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                Stage
                              </button>
                            </div>
                            {manualErrors[row.key] && (
                              <p className="mt-1 text-[11px] text-red-600">{manualErrors[row.key]}</p>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 min-w-[13rem]">
                        {stagedRow ? (
                          <div className="space-y-1">
                            {stagedRow.action === 'link' ? (
                              <div className="text-xs text-gray-800 space-y-0.5">
                                {(stagedRow.writableEntries || 0) > 0 ? (
                                  <p>
                                    <span className="font-medium">Will link</span>{' '}
                                    {plural(stagedRow.writableEntries, 'entry')} to{' '}
                                    <span className="break-all">{stagedRow.matchName}</span>
                                  </p>
                                ) : (
                                  <p className="text-red-700">
                                    <span className="font-medium">Will not save</span> — nothing here is
                                    writable from this account. See the reason next to the count.
                                  </p>
                                )}
                                {(stagedRow.blockedEntries || 0) > 0 && (stagedRow.writableEntries || 0) > 0 && (
                                  <p className="text-amber-800">
                                    {plural(stagedRow.blockedEntries, 'entry')} will not save — owned by
                                    someone else.
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-800">
                                <span className="font-medium">Will hide</span> as “not a movement” (this browser only)
                              </p>
                            )}
                            <button
                              type="button"
                              onClick={() => unstage(row.key)}
                              className="inline-flex items-center gap-1 text-xs text-gray-600 underline hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                            >
                              <X size={12} /> Unstage
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => stageExclude(row)}
                            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <Ban size={12} /> Not a movement
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredRows.length > visibleCount && (
            <div className="border-t border-gray-100 p-3 text-center">
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + VISIBLE_STEP)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Show {Math.min(VISIBLE_STEP, filteredRows.length - visibleCount)} more
                <span className="text-gray-500"> ({(filteredRows.length - visibleCount).toLocaleString()} left)</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---------------- sticky staging bar ---------------- */}
      {stagedStats.total > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white shadow-[0_-2px_10px_rgba(0,0,0,0.08)]">
          <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-gray-800" role="status">
              <p className="font-medium">
                {plural(stagedStats.total, 'name')} staged, affecting{' '}
                {plural(stagedStats.linkEntries, 'writable entry')}.
              </p>
              <p className="text-xs text-gray-500">
                {stagedStats.linkNames.toLocaleString()} to link ({stagedStats.templateEntries.toLocaleString()} workout entries,{' '}
                {stagedStats.programEntries.toLocaleString()} program rows) ·{' '}
                {stagedStats.excludeNames.toLocaleString()} to hide locally. Nothing is written yet.
              </p>
              {stagedStats.blockedEntries > 0 && (
                <p className="text-xs text-red-700 flex items-center gap-1 mt-0.5">
                  <Lock size={11} className="shrink-0" />
                  {plural(stagedStats.blockedEntries, 'further entry')} cannot be written from this
                  account and {stagedStats.blockedEntries === 1 ? 'is' : 'are'} excluded from that count
                  {stagedStats.fullyBlockedNames > 0
                    && ` (${plural(stagedStats.fullyBlockedNames, 'staged name')} will save nothing at all)`}.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStaged({})}
                disabled={applying}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Clear staged
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={applying || (stagedStats.linkEntries === 0 && stagedStats.excludeNames === 0)}
                title={stagedStats.linkEntries === 0 && stagedStats.excludeNames === 0
                  ? 'Nothing staged here can be written from this account.'
                  : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
              >
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {applying ? 'Applying…' : 'Apply changes'}
              </button>
            </div>
          </div>
          {applying && progress.total > 0 && (
            <div className="px-4 pb-3" role="status" aria-live="polite">
              <div className="h-1.5 w-full rounded bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">Step {progress.done} of {progress.total}…</p>
            </div>
          )}
        </div>
      )}

      {/* ---------------- confirm ----------------
          Buttons live in a footer OUTSIDE the scrolling region, so a long list
          can never push the actions off-screen. */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-xl max-h-[90vh] flex flex-col overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="evg-confirm-title"
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 shrink-0">
              <h3 id="evg-confirm-title" className="text-lg font-semibold text-gray-900">Apply these changes?</h3>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                aria-label="Close"
                className="p-1 hover:bg-gray-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto px-4 py-3 space-y-3 text-sm text-gray-700" style={{ maxHeight: '55vh' }}>
              <p>This will write to the database:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>{stagedStats.templateEntries.toLocaleString()}</strong> workout-template exercise
                  {stagedStats.templateEntries === 1 ? '' : 's'} will get a link.
                </li>
                <li>
                  <strong>{stagedStats.programEntries.toLocaleString()}</strong> assigned-program row
                  {stagedStats.programEntries === 1 ? '' : 's'} will get a video_url.
                </li>
                {stagedStats.blockedEntries > 0 && (
                  <li className="text-red-700">
                    <strong>{stagedStats.blockedEntries.toLocaleString()}</strong> further entr
                    {stagedStats.blockedEntries === 1 ? 'y' : 'ies'} will <strong>not</strong> be
                    written: they live in templates this screen does not write to. Nothing will be sent
                    for them.
                  </li>
                )}
                <li>
                  <strong>{stagedStats.excludeNames.toLocaleString()}</strong> name
                  {stagedStats.excludeNames === 1 ? '' : 's'} will be hidden as “not a movement” —
                  <em> in this browser only, nothing is written to the database for those.</em>
                </li>
              </ul>
              <p className="text-gray-600">
                Entries that already have a link are never overwritten, so the real number written may be
                lower if someone filled one in since this screen loaded. Re-running is safe: it only fills
                what is still empty.
              </p>
              <p className="text-gray-600">
                {RLS_PLAIN_SENTENCE} Every write is checked against what the database actually changed,
                so the report afterwards distinguishes saved from blocked.
              </p>
              <div className="rounded border border-gray-200 bg-gray-50 p-2 max-h-48 overflow-y-auto">
                <ul className="space-y-1 text-xs text-gray-700">
                  {Object.entries(staged).map(([key, s]) => (
                    <li key={key} className="break-words">
                      <span className="font-medium">{s.displayName}</span>{' '}
                      {s.action === 'link'
                        ? `→ ${s.matchName} (${s.occurrences} place${s.occurrences === 1 ? '' : 's'})`
                        : '→ hidden as not a movement'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="border-t border-gray-200 px-4 py-3 flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyChanges}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
              >
                Write {plural(stagedStats.linkEntries, 'row')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
