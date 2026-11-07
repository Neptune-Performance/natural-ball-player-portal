import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabaseClient';
import { Mail, Send, History, LayoutTemplate, Image as ImageIcon, ShieldAlert, ChevronLeft, ChevronRight, ChevronDown, Check, RefreshCw } from 'lucide-react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { formatUserError } from './errorMessage';
import { readAllPages } from './readAllPages';
import EmailImageLibrary, { EmailImagePicker } from './EmailImageLibrary';

/*
 * Issue #281 — Email Campaigns, Phase 1 of 3. Mirrors EZFacility's Email
 * Campaign section: five sub-items in a left rail, with Send Email Campaign
 * as a 4-step wizard (Select Clients → Filter Clients → Compose Message →
 * Preview and Send) and the live recipient count repeated in every step
 * header.
 *
 * ⚠️ Phase 2 adds Send Blast — the only irreversible button in the app.
 * There are 937 real email addresses behind this screen. The protections,
 * in order: the recipient list is snapshotted into email_campaign_recipients
 * BEFORE anything sends (frozen at commit time — a signup mid-send changes
 * nothing); the admin must TYPE the exact recipient count to confirm; the
 * send-campaign edge function is admin-only, reads recipients server-side
 * by campaign id (never from the browser), verifies the snapshot matches
 * the confirmed count, skips blacklisted addresses (recorded as 'skipped'),
 * writes per-recipient results as it goes, and is idempotent — re-invoking
 * skips everyone already sent, so a double click or a retry cannot
 * double-send. Every campaign email carries a per-recipient unsubscribe
 * link. "Send Test" (one email, to the admin, via send-email) is unchanged.
 *
 * The recipient COUNT and the recipient LIST must never diverge, so both
 * derive from the same query builder (buildRecipientQuery) — the count is
 * the LENGTH of the list that query produces, never a separate estimate.
 *
 * ⚠️ #281 follow-up, 2026-08-29: a campaign now also reaches the Parent 1 and
 * Parent 2 addresses on an athlete's profile, so ONE user row can produce up
 * to THREE inboxes. That is why the count cannot be a head:true row count any
 * more — it has to expand and de-duplicate first. See expandRecipients.
 */

// Paginated read — see src/readAllPages.js. A single .range(0, 9999) is
// silently clamped to the project's db-max-rows (1000 by default) and returns
// a SHORT LIST WITH NO ERROR. Imported rather than defined here since #437
// made it the shared fix for every list-all-users query in the app.

// Deliberately permissive. Apostrophes are legal in a local part and were
// wrongly rejected here once already; what this needs to catch is the shape a
// hand-typed parent address actually arrives in — stray whitespace, a missing
// @, a domain with no dot.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RECIPIENT_COLUMNS = 'id, email, parent1_email, parent2_email';

// One entry per INBOX. Walks users in id order and takes, for each: the
// athlete's own address first, then Parent 1, then Parent 2.
//
// Cordell, 2026-08-29: "Please move forward with sending out to parents" —
// parents had never been recipients (this file only ever read users.email)
// and were complaining they could not see schedules, blasts or updates.
//
// Two rules this must not break:
//
//  1. ADDITIVE ONLY. The athlete's own address is passed through exactly as it
//     is today and is NOT validated, because validating it here could silently
//     drop somebody who receives campaigns right now. Validation applies only
//     to the two parent columns, which are free-typed on the profile and have
//     never been checked by anything.
//
//  2. ONE ROW PER INBOX. email_campaign_recipients carries
//     UNIQUE (campaign_id, lower(email)), so two siblings who share a parent
//     address — or a parent whose address IS the athlete's — must collapse to
//     a single entry HERE, or the snapshot insert fails and nothing sends.
//     First occurrence wins, which is why the athlete is taken first.
//
// user_id stays the ATHLETE's id on a parent row. That is what ties a parent
// back to the player they were listed under, and it is what lets a parent
// unsubscribe on their own without unsubscribing the athlete — each row gets
// its own unsubscribe token from the database.
const expandRecipients = (rows) => {
  const seen = new Set();
  const out = [];
  const take = (id, raw, isParent) => {
    // Trim BEFORE anything else: a leading space once dodged the blacklist
    // while still failing validation downstream.
    const key = (raw || '').trim().toLowerCase();
    if (!key) return;
    if (isParent && !LOOKS_LIKE_EMAIL.test(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, email: key });
  };
  (rows || []).forEach(r => {
    take(r.id, r.email, false);
    take(r.id, r.parent1_email, true);
    take(r.id, r.parent2_email, true);
  });
  return out;
};

// ---------------------------------------------------------------------
// #390 — Campaign History and Failed Emails.
//
// Cordell, 2026-09-02: "When I click on the buttons to look at email campaign
// history and failed emails it does not give me anything." Both sections were
// deliberate Phase 3 stubs rendering renderPlaceholder, which from the outside
// is indistinguishable from a dead button. The tables they were waiting on are
// populated now, so they read real data.
//
// The rule these two screens are built around: a query that fails must SAY SO
// on screen. A silent console.error here is what produced the bug report in
// the first place.
// ---------------------------------------------------------------------

const HISTORY_LIMIT = 100;   // campaigns read per load — never unbounded.
const RECIPIENT_LIMIT = 250; // per-campaign recipient rows shown at once.
const FAILURE_LIMIT = 200;   // recent delivery failures shown at once.

// PostgREST cannot ORDER BY an expression, so coalesce(sent_at, created_at)
// cannot be pushed to the server. The window is taken on created_at (a
// campaign is always created before it is sent, so the newest campaigns are
// always inside it) and re-sorted here. Within the capped window this is
// exactly the requested order.
const campaignTime = (c) => new Date(c.sent_at || c.created_at || 0).getTime();

const fetchRecentCampaigns = async (limit) => {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select('id, subject, created_by, recipient_count, status, sent_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { campaigns: null, error };
  const campaigns = (data || []).slice().sort((a, b) => campaignTime(b) - campaignTime(a));
  return { campaigns, error: null };
};

// The SAME five buckets readTally counts, spelled the same way the send path
// writes them. Nothing new is invented here: a status outside this list is
// counted in `total` only, exactly as readTally already behaves, so an
// unaccounted-for row shows up as sent+failed+skipped+pending+unknown < total
// rather than being quietly re-labelled.
const TALLY_KEYS = ['sent', 'failed', 'skipped', 'pending', 'unknown'];
const emptyTally = () => ({ sent: 0, failed: 0, skipped: 0, pending: 0, unknown: 0, total: 0 });

const tallyByCampaign = (rows) => {
  const out = {};
  (rows || []).forEach(r => {
    if (!r.campaign_id) return;
    const t = out[r.campaign_id] || (out[r.campaign_id] = emptyTally());
    if (TALLY_KEYS.includes(r.status)) t[r.status] += 1;
    t.total += 1;
  });
  return out;
};

// Covers both vocabularies: recipient status (pending/sent/failed/skipped/
// unknown) and campaign status (draft/sending/sent/failed/partial).
const STATUS_STYLES = {
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  skipped: 'bg-gray-100 text-gray-700',
  pending: 'bg-blue-100 text-blue-800',
  unknown: 'bg-amber-100 text-amber-800',
  draft: 'bg-gray-100 text-gray-700',
  sending: 'bg-blue-100 text-blue-800',
  partial: 'bg-amber-100 text-amber-800',
};

const statusPill = (status) => (
  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-700'}`}>
    {status || 'unknown'}
  </span>
);

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString() : null);

const SECTIONS = [
  { key: 'send', label: 'Send Email Campaign', desc: 'Send an email to all or targeted clients', icon: Send },
  { key: 'history', label: 'Campaign History', desc: 'View history for email campaigns', icon: History },
  { key: 'templates', label: 'Email Template Library', desc: 'Create, edit, and email templates that can be used with an email blast', icon: LayoutTemplate },
  { key: 'images', label: 'Email Image Library', desc: 'Add and remove images that can be used with an email blast', icon: ImageIcon },
  { key: 'failed', label: 'Failed Emails', desc: 'View email addresses currently on the blacklist', icon: ShieldAlert },
];

const STEPS = ['Select Clients', 'Filter Clients', 'Compose Message', 'Preview and Send'];

// #441 follow-up (Cordell, 2026-10-06): the archived / inactive lists are
// Step 1 categories in their own right, so picking one needs no further
// action — Step 2 then hides the Teams box, because most archived athletes
// have been removed from every group or team and the box read as required.
const CATEGORIES = [
  { value: 'all', label: 'All Contacts' },
  { value: 'players', label: 'Players' },
  { value: 'players_inactive', label: 'Inactive athletes' },
  { value: 'players_archived', label: 'Archived athletes' },
  { value: 'players_lapsed', label: 'Inactive + Archived athletes (win-back)' },
  { value: 'staff', label: 'Staff (Coaches & Admins)' },
  { value: 'leads', label: 'Public Leads' },
];
// Categories whose athlete status is fixed by the category itself. The
// status comes from player_profiles.status (Manage Athletes); team
// membership is deliberately NOT part of the definition.
const CATEGORY_FIXED_STATUS = {
  players_inactive: ['Inactive'],
  players_archived: ['Archived'],
  players_lapsed: ['Inactive', 'Archived'],
};
const CATEGORY_AUDIENCE_NOTE = {
  players_inactive: 'Every athlete whose status in Manage Athletes is Inactive — on a team or not.',
  players_archived: 'Every athlete whose status in Manage Athletes is Archived — on a team or not.',
  players_lapsed: 'Every athlete whose status in Manage Athletes is Inactive or Archived — on a team or not. This is the win-back list.',
};
// Categories that still offer the optional Teams box and the status select.
const hasTeamFilters = (category) => category === 'all' || category === 'players';

// #441: Step 2 "Athlete status" filter, read from player_profiles.status —
// the same Active / Inactive / Archived vocabulary Manage Athletes writes.
// 'lapsed' is Cordell's win-back audience: everyone who has paused or left,
// which is Inactive + Archived together. '' = no status filter (the
// pre-#441 behaviour, where "Players" reached archived athletes too).
const ATHLETE_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
  { value: 'Archived', label: 'Archived' },
  { value: 'lapsed', label: 'Inactive + Archived (win-back)' },
];
const athleteStatusList = (value) => {
  if (value === 'lapsed') return ['Inactive', 'Archived'];
  return value ? [value] : null;
};
const EMPTY_FILTERS = { teamIds: [], athleteStatus: '', staffStatus: '', signedUpAfter: '', signedUpBefore: '' };

// Rich-text toolbar kept to what email clients actually render.
// #480: 'image' opens the Email Image Library picker (handler wired in the
// component) instead of Quill's default, which would inline a base64 blob
// most mail clients strip.
const QUILL_TOOLBAR = [
  [{ header: [false, 2, 3] }],
  ['bold', 'italic', 'underline'],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['link', 'image'],
  ['clean'],
];

export default function EmailCampaigns({ userId, userRole, section, onSectionChange }) {
  // #390 — Cordell asked for admins AND coaches to be able to open Campaign
  // History and Failed Emails. Sending a blast stays admin-only: it is the one
  // irreversible button in the app and widening it was not asked for. A coach
  // who lands on 'send' (a stale link, a saved state) is moved to 'history'
  // rather than shown a wizard they cannot use.
  const canSendBlast = userRole === 'admin';
  const visibleSections = canSendBlast ? SECTIONS : SECTIONS.filter(sec => sec.key !== 'send');
  const effectiveSection = (!canSendBlast && section === 'send') ? 'history' : section;
  const [step, setStep] = useState(1);

  // Step 1 — category. Step 2 — filters.
  const [category, setCategory] = useState('all');
  const [teams, setTeams] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // Resolved user ids for the chosen team(s); null = no team filter active.
  const [teamMemberIds, setTeamMemberIds] = useState(null);

  const [count, setCount] = useState(null);
  const [countError, setCountError] = useState(null);

  // Step 3 — compose.
  const [returnEmail, setReturnEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const quillRef = useRef(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const quillModules = useMemo(() => ({
    toolbar: { container: QUILL_TOOLBAR, handlers: { image: () => setImagePickerOpen(true) } },
  }), []);
  const insertImage = (img) => {
    setImagePickerOpen(false);
    const editor = quillRef.current?.getEditor();
    if (!editor) return;
    const range = editor.getSelection(true);
    const at = range ? range.index : editor.getLength();
    editor.insertEmbed(at, 'image', img.public_url, 'user');
    editor.insertText(at + 1, '\n', 'user');
    editor.setSelection(at + 2, 0, 'silent');
  };
  const [templates, setTemplates] = useState([]);
  const [templatesUnavailable, setTemplatesUnavailable] = useState(false);
  const [templateCategory, setTemplateCategory] = useState('');

  // Step 4 — Send Test.
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [myProfile, setMyProfile] = useState(null);

  // Step 4 — Send Blast (#281 Phase 2). One state machine so a second run
  // cannot start while one is in flight: null → 'confirm' → 'snapshotting'
  // → 'sending' → 'done' | 'error'.
  const [blast, setBlast] = useState(null); // { phase, confirmText, confirmedCount, campaignId, tally, error }

  // Stable string key for the selected team ids — safe to use as an effect dep.
  const teamIdsKey = filters.teamIds.join(',');

  useEffect(() => {
    (async () => {
      const [{ data: teamRows, error: teamsError }, { data: me, error: meError }] = await Promise.all([
        supabase.from('teams').select('id, name').order('name'),
        supabase.from('users').select('id, full_name, email').eq('id', userId).maybeSingle(),
      ]);
      if (teamsError) console.error('EmailCampaigns: teams query failed:', teamsError);
      if (meError) console.error('EmailCampaigns: own user query failed:', meError);
      setTeams(teamRows || []);
      if (me) {
        setMyProfile(me);
        setReturnEmail(prev => prev || me.email || '');
      }
    })();
  }, [userId]);

  // Templates feed Step 3's picker. The email_templates table ships with this
  // phase's (unrun) migration, so tolerate it not existing yet.
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('email_templates').select('id, name, category, subject, body_html').order('name');
      if (error) {
        console.error('EmailCampaigns: email_templates query failed (expected until the #281 migration runs):', error);
        setTemplatesUnavailable(true);
        setTemplates([]);
        return;
      }
      setTemplatesUnavailable(false);
      setTemplates(data || []);
    })();
  }, []);

  // Resolve the chosen team(s) to user ids BEFORE counting, so the count and
  // the list can share one query. Multiple teams are OR'd: a user on any
  // selected team is included.
  useEffect(() => {
    if (filters.teamIds.length === 0) { setTeamMemberIds(null); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('team_members').select('user_id').in('team_id', filters.teamIds);
      if (error) { console.error('EmailCampaigns: team_members query failed:', error); if (!cancelled) setTeamMemberIds([]); return; }
      if (!cancelled) setTeamMemberIds(Array.from(new Set((data || []).map(r => r.user_id).filter(Boolean))));
    })();
    return () => { cancelled = true; };
  }, [teamIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE single source of truth for WHICH USERS a campaign reaches.
  // ⚠️ There is deliberately no head:true count option here any more. A row
  // count over this query would undercount, because each row can carry parent
  // addresses too. Everything that needs a number goes through
  // readRecipientList below, which expands and de-duplicates first.
  const buildRecipientQuery = useCallback((selectCols) => {
    // #441: an athlete-status filter joins player_profiles (inner, so a user
    // with no profile row is excluded — they have no status to match) and
    // filters on the embedded column. Without a status filter the select is
    // exactly what it was, so the other categories are untouched.
    const statusList = CATEGORY_FIXED_STATUS[category]
      || (hasTeamFilters(category) ? athleteStatusList(filters.athleteStatus) : null);
    let q = supabase.from('users').select(
      statusList ? `${selectCols}, player_profiles!player_profiles_user_id_fkey!inner(status)` : selectCols
    );
    if (statusList) q = q.in('player_profiles.status', statusList);
    if (category === 'players' || CATEGORY_FIXED_STATUS[category]) q = q.eq('role', 'player');
    else if (category === 'staff') q = q.in('role', ['admin', 'coach']);
    else if (category === 'leads') q = q.eq('role', 'public');
    // 'all' = All Contacts: every user row with an email.
    q = q.not('email', 'is', null);
    if (filters.teamIds.length > 0 && teamMemberIds !== null) {
      // Teams with no members must resolve to zero recipients, not "no filter".
      q = q.in('id', teamMemberIds.length > 0 ? teamMemberIds : ['00000000-0000-0000-0000-000000000000']);
    }
    if (category === 'staff' && filters.staffStatus) {
      // coach_status null counts as Active everywhere else in the app
      // (AdminSettings' getUserStatus) — mirror that here.
      if (filters.staffStatus === 'Active') q = q.or('coach_status.is.null,coach_status.eq.Active');
      else q = q.eq('coach_status', filters.staffStatus);
    }
    if (filters.signedUpAfter) q = q.gte('created_at', filters.signedUpAfter);
    if (filters.signedUpBefore) q = q.lte('created_at', filters.signedUpBefore + 'T23:59:59');
    return q;
  }, [category, filters, teamMemberIds]);

  // The list of inboxes a campaign would reach right now. The header count and
  // the frozen snapshot BOTH come from here so they cannot drift apart.
  const readRecipientList = useCallback(async () => {
    const { rows, error } = await readAllPages(() => buildRecipientQuery(RECIPIENT_COLUMNS).order('id'));
    if (error) return { list: null, error };
    return { list: expandRecipients(rows), error: null };
  }, [buildRecipientQuery]);

  useEffect(() => {
    // Waiting on the team resolve — don't show a count for the wrong list.
    if (filters.teamIds.length > 0 && teamMemberIds === null) { setCount(null); return; }
    let cancelled = false;
    (async () => {
      const { list, error } = await readRecipientList();
      if (error) {
        console.error('EmailCampaigns: recipient count query failed:', error);
        if (!cancelled) { setCount(null); setCountError(formatUserError(error)); }
        return;
      }
      if (!cancelled) { setCount(list.length); setCountError(null); }
    })();
    return () => { cancelled = true; };
  }, [readRecipientList, teamIdsKey, teamMemberIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const templateCategories = useMemo(
    () => Array.from(new Set(templates.map(t => t.category).filter(Boolean))).sort(),
    [templates]
  );
  const visibleTemplates = templateCategory
    ? templates.filter(t => t.category === templateCategory)
    : templates;

  const applyTemplate = (templateId) => {
    const t = templates.find(x => x.id === templateId);
    if (!t) return;
    if (t.subject) setSubject(t.subject);
    if (t.body_html) setBodyHtml(t.body_html);
  };

  // Quill emits '<p><br></p>' for an empty editor.
  const bodyIsEmpty = !bodyHtml || bodyHtml.replace(/<(.|\n)*?>/g, '').trim().length === 0;
  const canSendTest = !!subject.trim() && !bodyIsEmpty && !sendingTest;

  const htmlToText = (html) => {
    const div = document.createElement('div');
    // Sanitized even for text extraction — templates are staff-authored rows
    // shared between accounts, so treat their HTML as untrusted everywhere.
    div.innerHTML = DOMPurify.sanitize(html);
    return (div.innerText || '').trim();
  };

  // Sends exactly ONE email, to the logged-in admin, through the existing
  // single-recipient send-email function. It ignores the recipient list
  // entirely — that is the point. (send-email renders `body` as plain text,
  // so the test carries a text rendition; pixel-true HTML tests arrive with
  // Phase 2's send-campaign function, which owns HTML sending.)
  const handleSendTest = async () => {
    if (!canSendTest) return;
    setSendingTest(true);
    setTestResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const selfEmail = myProfile?.email || session?.user?.email;
      if (!session || !selfEmail) {
        setTestResult({ type: 'error', message: 'Could not resolve your own email address — not sending.' });
        return;
      }
      const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': supabaseAnonKey,
        },
        body: JSON.stringify({
          recipientEmail: selfEmail,
          recipientName: myProfile?.full_name || 'NBP Admin',
          subject: `[TEST] ${subject.trim()}`,
          body: htmlToText(bodyHtml),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ type: 'error', message: data.error || 'Failed to send the test email' });
      } else {
        setTestResult({ type: 'success', message: `Test sent to ${selfEmail} — and only to ${selfEmail}.` });
      }
    } catch (err) {
      setTestResult({ type: 'error', message: err.message || 'Network error' });
    } finally {
      setSendingTest(false);
    }
  };

  // ---- Send Blast (#281 Phase 2) -------------------------------------
  const blastBusy = !!blast && ['snapshotting', 'sending'].includes(blast.phase);
  // 🔴 A finished blast must NOT re-arm the button. Idempotency is scoped to
  // one campaign id; clicking Send Blast again creates a BRAND NEW campaign
  // and sends the identical email to the identical people a second time.
  // The only friction is re-typing the count, and an admin wondering "did
  // that actually go?" will type it without hesitating. This guard is
  // component-local: leaving the section and coming back unmounts the
  // wizard and re-arms it, which also means re-composing the email from
  // scratch. Editing the subject in place does NOT re-arm it.
  const blastFinished = !!blast && blast.phase === 'done';
  const canOpenBlastConfirm = !!subject.trim() && !bodyIsEmpty && (count || 0) >= 1
    && !blastBusy && !blastFinished;

  const readTally = async (campaignId) => {
    const { rows, error } = await readAllPages(() => supabase
      .from('email_campaign_recipients')
      .select('status')
      .eq('campaign_id', campaignId)
      .order('id'));
    if (error) { console.error('EmailCampaigns: tally query failed:', error); return null; }
    const tally = { sent: 0, failed: 0, skipped: 0, pending: 0, unknown: 0, total: rows.length };
    rows.forEach(r => { if (tally[r.status] !== undefined) tally[r.status] += 1; });
    return tally;
  };

  const invokeSendCampaign = async (campaignId, { retryFailed = false } = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const res = await fetch(`${supabaseUrl}/functions/v1/send-campaign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ campaignId, retryFailed }),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON body */ }
    if (!res.ok) throw new Error(data.error || `send-campaign returned status ${res.status}`);
    return data;
  };

  // Drives 'sending': invokes the function (re-invoking on { resume: true } —
  // idempotency makes resumption safe) while polling live tallies from the
  // database, which is the source of truth for progress.
  const runSend = async (campaignId, { retryFailed = false } = {}) => {
    setBlast(prev => ({ ...prev, phase: 'sending', campaignId, error: null }));
    const poll = setInterval(async () => {
      const tally = await readTally(campaignId);
      if (tally) setBlast(prev => (prev && prev.campaignId === campaignId ? { ...prev, tally } : prev));
    }, 1500);
    try {
      let result = await invokeSendCampaign(campaignId, { retryFailed });
      let hops = 0;
      while (result.resume && hops < 20) {
        result = await invokeSendCampaign(campaignId);
        hops += 1;
      }
      const tally = await readTally(campaignId);
      // The server stops itself when it cannot tell what happened to a batch.
      // That is NOT a finished send, and showing it as one would invite a
      // Retry that emails people a second time.
      if (result.aborted) {
        setBlast(prev => ({ ...prev, phase: 'error', error: result.aborted, tally: tally || prev?.tally || null }));
        return;
      }
      if (result.resume) {
        setBlast(prev => ({ ...prev, phase: 'error', tally: tally || prev?.tally || null,
          error: 'The send is taking longer than expected and paused itself. Press Resume to continue — nobody already emailed will be emailed again.' }));
        return;
      }
      setBlast(prev => ({ ...prev, phase: 'done', tally: tally || prev?.tally || null }));
    } catch (err) {
      const tally = await readTally(campaignId);
      setBlast(prev => ({ ...prev, phase: 'error', error: err.message, tally: tally || prev?.tally || null }));
    } finally {
      clearInterval(poll);
    }
  };

  // The commit point. Everything before the invoke is reversible; the order
  // here is the safety: re-verify the count, freeze the snapshot, and only
  // then hand the campaign id (nothing else) to the server.
  const handleConfirmedBlast = async () => {
    const confirmedCount = blast?.confirmedCount;
    setBlast(prev => ({ ...prev, phase: 'snapshotting', error: null }));
    let campaignId = null;
    try {
      // 1 & 2. Re-read the list and freeze it — ONE read, not two.
      // The old code counted with head:true and then re-read the rows, which
      // left a window where the count it checked and the list it froze could
      // disagree. Now the same array is both. readRecipientList paginates
      // (a single wide .range() is clamped to db-max-rows with no error) and
      // has already collapsed the athlete's address and both parent addresses
      // down to one entry per inbox, case-insensitively — users.email's own
      // UNIQUE constraint is case-SENSITIVE and 74 rows store mixed-case
      // addresses, so a.smith@ and A.Smith@ are two rows and one human.
      const { list: unique, error: listError } = await readRecipientList();
      if (listError) throw new Error(`Could not load the recipient list: ${formatUserError(listError)}`);

      // The list must still match the number the admin typed.
      if (unique.length !== confirmedCount) {
        throw new Error(`The recipient list changed (now ${unique.length}, you confirmed ${confirmedCount}). Nothing was sent — please re-check and confirm again.`);
      }

      // 3. The campaign row the server will trust.
      const { data: campaign, error: campaignError } = await supabase
        .from('email_campaigns')
        .insert({
          created_by: userId,
          subject: subject.trim(),
          body_html: DOMPurify.sanitize(bodyHtml),
          return_email: returnEmail || null,
          recipient_filter: { category, filters },
          // The number of MESSAGES, which after de-duplication can be lower
          // than the number of rows the admin confirmed. The server checks
          // this against the snapshot it reads, so the two must agree.
          recipient_count: unique.length,
          status: 'draft',
        })
        .select('id')
        .single();
      if (campaignError) throw new Error(`Could not create the campaign: ${formatUserError(campaignError)}`);
      // 🔴 Do not trust "no error" — RLS on this project denies a write by
      // returning 200 with NO ROWS and no error, not a 403. Without this
      // guard campaignId stays undefined, the recipient rows get inserted
      // with no campaign_id, send-campaign is called with no id, and the
      // admin is shown a green "Blast finished" for a send that never
      // happened. Caught by QA 2026-08-22 (T9).
      if (!campaign || !campaign.id) {
        throw new Error('The campaign could not be created — the database accepted the request but saved nothing. This is usually a permissions problem. Nothing was sent.');
      }
      campaignId = campaign.id;

      // 4. Snapshot rows (unsubscribe tokens are generated by the database).
      for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500).map(r => ({ campaign_id: campaignId, user_id: r.id, email: r.email }));
        const { error: insertError } = await supabase.from('email_campaign_recipients').insert(chunk);
        if (insertError) throw new Error(`Could not snapshot recipients: ${formatUserError(insertError)}`);
      }

      // 5. Send. From here on the server owns the run.
      await runSend(campaignId);
    } catch (err) {
      // A failed snapshot must not leave a half-frozen draft behind.
      if (campaignId) {
        const { error: cleanupError } = await supabase.from('email_campaigns').delete().eq('id', campaignId).eq('status', 'draft');
        if (cleanupError) console.error('EmailCampaigns: draft cleanup failed:', cleanupError);
      }
      setBlast(prev => ({ ...prev, phase: 'error', error: err.message }));
    }
  };

  // ---- Campaign History + Failed Emails (#390) -----------------------
  // Loaded on open, never on a second click. `loaded` guards the auto-load
  // so switching sections back and forth does not re-query; Refresh is the
  // deliberate way to re-read.
  const [history, setHistory] = useState({ loading: false, error: null, warn: null, campaigns: [], tallies: {}, senders: {} });
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [openCampaignId, setOpenCampaignId] = useState(null);
  const [detail, setDetail] = useState({ campaignId: null, loading: false, error: null, rows: [] });

  const [failedView, setFailedView] = useState({ loading: false, error: null, warn: null, blacklist: [], failures: [], failureTotal: 0 });
  const [failedLoaded, setFailedLoaded] = useState(false);
  // #400: outcome of a "Send now" / "Delete" on a stranded draft, shown in
  // the Drafts panel of Campaign History.
  const [draftNote, setDraftNote] = useState(null);
  const [draftBusyId, setDraftBusyId] = useState(null);

  const loadHistory = useCallback(async () => {
    setOpenCampaignId(null);
    setDetail({ campaignId: null, loading: false, error: null, rows: [] });
    setHistory(prev => ({ ...prev, loading: true, error: null, warn: null }));

    const { campaigns, error } = await fetchRecentCampaigns(HISTORY_LIMIT);
    if (error) {
      console.error('EmailCampaigns: campaign history query failed:', error);
      setHistory({ loading: false, error: formatUserError(error), warn: null, campaigns: [], tallies: {}, senders: {} });
      return;
    }

    const ids = campaigns.map(c => c.id);
    let tallies = {};
    let warn = null;
    if (ids.length > 0) {
      // ONE query for every campaign on screen, tallied client-side. 51
      // campaigns must not become 51 round trips. readAllPages because the
      // recipient table is already past a single 1000-row page.
      const { rows, error: tallyError } = await readAllPages(() => supabase
        .from('email_campaign_recipients')
        .select('campaign_id, status')
        .in('campaign_id', ids)
        .order('id'));
      if (tallyError) {
        console.error('EmailCampaigns: history tally query failed:', tallyError);
        warn = `Per-campaign results could not be fully loaded: ${formatUserError(tallyError)}`;
      }
      tallies = tallyByCampaign(rows);
    }

    // Sender names in one batched read, the same way this file already reads
    // users (id, full_name). If a name cannot be resolved the row simply
    // shows no sender rather than guessing at one.
    const senderIds = Array.from(new Set(campaigns.map(c => c.created_by).filter(Boolean)));
    const senders = {};
    if (senderIds.length > 0) {
      const { data: users, error: usersError } = await supabase
        .from('users').select('id, full_name').in('id', senderIds);
      if (usersError) console.error('EmailCampaigns: sender name query failed:', usersError);
      (users || []).forEach(u => { senders[u.id] = u.full_name; });
    }

    setHistory({ loading: false, error: null, warn, campaigns, tallies, senders });
  }, []);

  // Per-campaign recipients. Capped — one campaign can hold hundreds of rows.
  const openCampaign = useCallback(async (campaignId) => {
    // Clicking the open row closes it.
    if (openCampaignId === campaignId) { setOpenCampaignId(null); return; }
    setOpenCampaignId(campaignId);
    setDetail({ campaignId, loading: true, error: null, rows: [] });
    const { data, error } = await supabase
      .from('email_campaign_recipients')
      .select('id, email, status, error, sent_at')
      .eq('campaign_id', campaignId)
      // Alphabetical on status is not an accident: failed < pending < sent <
      // skipped < unknown, so the rows somebody opened this to see are the
      // ones that survive the cap.
      .order('status')
      .order('email')
      .limit(RECIPIENT_LIMIT);
    if (error) console.error('EmailCampaigns: recipient detail query failed:', error);
    // Two campaigns clicked quickly must not let the slower answer overwrite
    // the faster one.
    setDetail(prev => (prev.campaignId !== campaignId ? prev : {
      campaignId,
      loading: false,
      error: error ? formatUserError(error) : null,
      rows: error ? [] : (data || []),
    }));
  }, [openCampaignId]);

  const loadFailed = useCallback(async () => {
    setFailedView(prev => ({ ...prev, loading: true, error: null, warn: null }));

    // 1. The blacklist. `email` is unique here (the unsubscribe function
    // upserts on it), so it is a safe paging key; newest-first is applied
    // after, on created_at.
    const { rows: blacklistRows, error: blacklistError } = await readAllPages(() => supabase
      .from('email_blacklist')
      .select('email, reason, created_at')
      .order('email'));
    if (blacklistError) {
      console.error('EmailCampaigns: blacklist query failed:', blacklistError);
      setFailedView({ loading: false, error: formatUserError(blacklistError), warn: null, blacklist: [], failures: [], failureTotal: 0 });
      return;
    }
    const blacklist = blacklistRows.slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    // 2. Delivery failures. A failed recipient row has no sent_at (the send
    // path only stamps it on 'sent'), so "newest first" can only come from
    // the campaign the row belongs to — which is why the campaign window is
    // read first and the failures are ordered against it here.
    const { campaigns, error: campaignError } = await fetchRecentCampaigns(HISTORY_LIMIT);
    if (campaignError) {
      console.error('EmailCampaigns: failures campaign query failed:', campaignError);
      setFailedView({
        loading: false, error: null, blacklist, failures: [], failureTotal: 0,
        warn: `Recent delivery failures could not be loaded: ${formatUserError(campaignError)}`,
      });
      return;
    }

    let failures = [];
    let warn = null;
    const ids = campaigns.map(c => c.id);
    if (ids.length > 0) {
      const { rows, error: failError } = await readAllPages(() => supabase
        .from('email_campaign_recipients')
        .select('id, campaign_id, email, error, sent_at')
        .eq('status', 'failed')
        .in('campaign_id', ids)
        .order('id'));
      if (failError) {
        console.error('EmailCampaigns: delivery failure query failed:', failError);
        warn = `Recent delivery failures may be incomplete: ${formatUserError(failError)}`;
      }
      const rank = new Map(campaigns.map((c, i) => [c.id, i]));
      const byId = new Map(campaigns.map(c => [c.id, c]));
      failures = rows.slice()
        .sort((a, b) => (rank.get(a.campaign_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.campaign_id) ?? Number.MAX_SAFE_INTEGER))
        .map(r => ({ ...r, campaign: byId.get(r.campaign_id) || null }));
    }

    setFailedView({
      loading: false, error: null, warn, blacklist,
      failures: failures.slice(0, FAILURE_LIMIT),
      failureTotal: failures.length,
    });
  }, []);

  // Opening the section IS the trigger. #390 was partly "I clicked it and
  // nothing happened" — nothing here waits for a second click.
  useEffect(() => {
    if (effectiveSection === 'history' && !historyLoaded) { setHistoryLoaded(true); loadHistory(); }
    if (effectiveSection === 'failed' && !failedLoaded) { setFailedLoaded(true); loadFailed(); }
  }, [effectiveSection, historyLoaded, failedLoaded, loadHistory, loadFailed]);

  const activeCategoryLabel = (CATEGORIES.find(c => c.value === category) || CATEGORIES[0]).label;
  const countLabel = count === null ? '…' : count;

  const stepHeader = (title) => (
    <h4 className="text-base font-semibold text-gray-900">
      {title}{' '}
      <span className="font-normal text-gray-500">( {countLabel} recipient{count === 1 ? '' : 's'} selected. )</span>
    </h4>
  );

  const renderWizard = () => (
    <div>
      {/* Step rail */}
      <div className="flex items-center mb-6 overflow-x-auto">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const isCurrent = step === n;
          const isDone = step > n;
          return (
            <React.Fragment key={label}>
              {i > 0 && <div className={`h-0.5 w-6 sm:w-10 flex-shrink-0 ${step > i ? 'bg-blue-500' : 'bg-gray-200'}`} />}
              <button
                type="button"
                onClick={() => { if (n < step) setStep(n); }}
                className={`flex items-center space-x-2 px-2 py-1 rounded flex-shrink-0 ${n < step ? 'cursor-pointer hover:bg-gray-50' : 'cursor-default'}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${isCurrent ? 'bg-blue-600 text-white' : isDone ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-500'}`}>
                  {isDone ? <Check size={13} /> : n}
                </span>
                <span className={`text-sm whitespace-nowrap ${isCurrent ? 'font-semibold text-gray-900' : 'text-gray-500'}`}>{label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {countError && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          Could not count recipients: {countError}
        </div>
      )}

      {/* Step 1 — Select Clients */}
      {step === 1 && (
        <div className="space-y-4">
          {stepHeader('Select Clients')}
          <div className="max-w-sm">
            <label className="block text-sm font-medium text-gray-700 mb-1">Client Category</label>
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); setFilters(EMPTY_FILTERS); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <p className="text-xs text-gray-400 mt-1.5">
              The count above always reflects exactly who this campaign would reach with the current category and filters.
            </p>
          </div>
        </div>
      )}

      {/* Step 2 — Filter Clients */}
      {step === 2 && (
        <div className="space-y-4">
          {stepHeader('Filter Clients')}
          {CATEGORY_AUDIENCE_NOTE[category] && (
            <div className="max-w-2xl bg-blue-50 border border-blue-200 text-blue-900 text-sm rounded-lg px-4 py-3">
              <span className="font-medium">{activeCategoryLabel}.</span> {CATEGORY_AUDIENCE_NOTE[category]} No team or group needs to be chosen — only the sign-up date filters below narrow this list.
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
            {hasTeamFilters(category) && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Teams <span className="font-normal text-gray-400">(optional)</span></label>
                <div className="border border-gray-300 rounded-lg overflow-y-auto max-h-40 divide-y divide-gray-100">
                  {teams.map(t => (
                    <label key={t.id} className="flex items-center space-x-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={filters.teamIds.includes(t.id)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...filters.teamIds, t.id]
                            : filters.teamIds.filter(id => id !== t.id);
                          setFilters({ ...filters, teamIds: next });
                        }}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span>{t.name}</span>
                    </label>
                  ))}
                </div>
                {filters.teamIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilters({ ...filters, teamIds: [] })}
                    className="text-xs text-blue-600 hover:underline mt-1"
                  >
                    Clear selection ({filters.teamIds.length} selected)
                  </button>
                )}
              </div>
            )}
            {hasTeamFilters(category) && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Athlete Status</label>
                <select
                  value={filters.athleteStatus}
                  onChange={(e) => setFilters({ ...filters, athleteStatus: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {ATHLETE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Reads each athlete's status from Manage Athletes. "Inactive + Archived" is the win-back list —
                  everyone who has paused or left. Any status (the default) reaches all of them, as before.
                </p>
              </div>
            )}
            {category === 'staff' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Coach Status</label>
                <select
                  value={filters.staffStatus}
                  onChange={(e) => setFilters({ ...filters, staffStatus: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Any status</option>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Signed up after</label>
              <input
                type="date"
                value={filters.signedUpAfter}
                onChange={(e) => setFilters({ ...filters, signedUpAfter: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Signed up before</label>
              <input
                type="date"
                value={filters.signedUpBefore}
                onChange={(e) => setFilters({ ...filters, signedUpBefore: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <p className="text-xs text-gray-400 max-w-2xl">
            Filters are limited to what the database can answer exactly — the header count is derived from the same query that
            would produce the recipient list, never estimated separately.
          </p>
        </div>
      )}

      {/* Step 3 — Compose Message */}
      {step === 3 && (
        <div className="space-y-4 max-w-3xl">
          {stepHeader('Compose Message')}
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email Template</label>
              <div className="flex space-x-2">
                <select
                  value={templateCategory}
                  onChange={(e) => setTemplateCategory(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={templates.length === 0}
                >
                  <option value="">All categories</option>
                  {templateCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select
                  value=""
                  onChange={(e) => applyTemplate(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={visibleTemplates.length === 0}
                >
                  <option value="">{templates.length === 0 ? 'No templates yet' : 'Apply a template…'}</option>
                  {visibleTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {templatesUnavailable
                  ? 'The Template Library arrives with Phase 3 (its table is created by the #281 migration).'
                  : 'The Template Library (Phase 3) manages these.'}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Return Email Address</label>
              <input
                type="email"
                value={returnEmail}
                onChange={(e) => setReturnEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
            <div className="bg-white border border-gray-300 rounded-lg overflow-hidden">
              <ReactQuill ref={quillRef} theme="snow" value={bodyHtml} onChange={setBodyHtml} modules={quillModules} />
              {imagePickerOpen && <EmailImagePicker userId={userId} onPick={insertImage} onClose={() => setImagePickerOpen(false)} />}
            </div>
          </div>
        </div>
      )}

      {/* Step 4 — Preview and Send */}
      {step === 4 && (
        <div className="space-y-4 max-w-3xl">
          {stepHeader('Preview and Send')}
          <div className="text-sm text-gray-600 space-y-1">
            <p><span className="font-medium text-gray-900">Recipients:</span> {countLabel} ({activeCategoryLabel})</p>
            {filters.teamIds.length > 0 && (
              <p><span className="font-medium text-gray-900">Teams:</span> {teams.filter(t => filters.teamIds.includes(t.id)).map(t => t.name).join(', ')}</p>
            )}
            <p><span className="font-medium text-gray-900">Return address:</span> {returnEmail || '—'}</p>
            <p><span className="font-medium text-gray-900">Subject:</span> {subject || <span className="italic text-gray-400">no subject yet</span>}</p>
          </div>
          <div className="border border-gray-200 rounded-lg p-6 bg-gray-50">
            {bodyIsEmpty ? (
              <p className="text-sm text-gray-400 italic">Nothing composed yet — go back to Compose Message.</p>
            ) : (
              <div className="prose prose-sm max-w-none bg-white rounded-lg border border-gray-200 p-5" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bodyHtml) }} />
            )}
          </div>
          {!blast && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
              <span className="font-semibold">Send Blast is irreversible.</span> It emails every one of the {countLabel} recipients
              above and cannot be recalled. Confirming requires typing the exact recipient count. Send yourself a test first
              ({myProfile?.email || 'your account email'}).
            </div>
          )}
          {blast && ['snapshotting', 'sending'].includes(blast.phase) && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-800 space-y-1">
              <p className="font-semibold">{blast.phase === 'snapshotting' ? 'Freezing the recipient list…' : 'Sending…'}</p>
              {blast.tally && (
                <p>
                  {blast.tally.sent} sent · {blast.tally.failed} failed · {blast.tally.skipped} skipped ·{' '}
                  {blast.tally.pending} remaining of {blast.tally.total}
                </p>
              )}
              <p className="text-xs">Leave this screen open until it finishes. A second send cannot start while this runs.</p>
            </div>
          )}
          {blast && blast.phase === 'done' && blast.tally && (
            <div className={`rounded-lg px-4 py-3 text-sm space-y-2 ${(blast.tally.failed > 0 || blast.tally.unknown > 0 || blast.tally.sent === 0) ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'bg-green-50 border border-green-200 text-green-800'}`}>
              <p className="font-semibold">
                Blast finished: {blast.tally.sent} sent, {blast.tally.failed} failed, {blast.tally.skipped} skipped
                {blast.tally.skipped > 0 ? ' (unsubscribed)' : ''}
                {blast.tally.unknown > 0 ? `, ${blast.tally.unknown} unconfirmed` : ''}.
              </p>
              {/* Two very different zeros. "Everyone on this list has
                  unsubscribed" is a normal, fully-explained outcome and must
                  not be dressed up as an alarm — an admin who learns to
                  scroll past this box stops reading it in the case that
                  actually matters. An UNEXPLAINED zero (nothing snapshotted,
                  or rows left unaccounted for) is the one worth a warning.
                  The `total === 0` term is load-bearing: without it
                  `accounted < total` is 0 < 0 and the empty-snapshot case
                  would silently lose its warning. */}
              {blast.tally.sent === 0 && (() => {
                const accounted = blast.tally.skipped + blast.tally.failed + blast.tally.unknown;
                const unexplained = blast.tally.total === 0 || accounted < blast.tally.total;
                return unexplained ? (
                  <p>
                    <span className="font-semibold">Nothing actually went out.</span>{' '}
                    The run finished but zero emails were sent, and not every recipient is accounted
                    for. Check Campaign History and the Resend dashboard before trying again — do not
                    assume this was a no-op.
                  </p>
                ) : (
                  <p>
                    <span className="font-semibold">Nobody was emailed.</span>{' '}
                    All {blast.tally.total} recipients are unsubscribed, blacklisted or undeliverable,
                    so nothing was handed to the email provider. This is expected — there is nothing
                    to check and nothing to retry.
                  </p>
                );
              })()}
              {blast.tally.unknown > 0 && (
                <p>
                  <span className="font-semibold">{blast.tally.unknown} did not come back with a confirmation.</span>{' '}
                  They may or may not have been delivered, so they are deliberately left out of Retry —
                  check the Resend dashboard before doing anything else with them, or those families get it twice.
                </p>
              )}
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={() => { setHistoryLoaded(false); onSectionChange('history'); }}
                  className="text-sm font-medium underline"
                >
                  View in Campaign History
                </button>
                {blast.tally.failed > 0 && (
                  <button
                    type="button"
                    onClick={() => runSend(blast.campaignId, { retryFailed: true })}
                    className="text-sm font-medium underline"
                  >
                    Retry failed only ({blast.tally.failed})
                  </button>
                )}
              </div>
            </div>
          )}
          {blast && blast.phase === 'error' && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800 space-y-2">
              <p><span className="font-semibold">The blast did not complete:</span> {blast.error}</p>
              {blast.tally && (
                <p>
                  {blast.tally.sent} sent · {blast.tally.failed} failed · {blast.tally.skipped} skipped
                  {blast.tally.unknown > 0 ? ` · ${blast.tally.unknown} unconfirmed` : ''} · {blast.tally.pending} still pending of {blast.tally.total}.
                </p>
              )}
              {blast.campaignId ? (
                <button
                  type="button"
                  onClick={() => runSend(blast.campaignId)}
                  className="text-sm font-medium underline"
                >
                  Resume this campaign (skips everyone already sent)
                </button>
              ) : (
                <p className="text-xs">Nothing was sent. Fix the issue and confirm again.</p>
              )}
            </div>
          )}
          {testResult && (
            <div className={`rounded-lg px-4 py-3 text-sm ${testResult.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {/* Footer buttons — << Previous / Next >> / Send Test / Send Blast */}
      <div className="flex items-center justify-between border-t border-gray-200 mt-8 pt-4">
        <button
          type="button"
          onClick={() => setStep(s => Math.max(1, s - 1))}
          disabled={step === 1}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center space-x-1"
        >
          <ChevronLeft size={16} /><span>Previous</span>
        </button>
        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={handleSendTest}
            disabled={!canSendTest}
            title={canSendTest ? `Sends one email to ${myProfile?.email || 'you'} only` : 'Compose a subject and message first'}
            className="px-4 py-2 border border-blue-300 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sendingTest ? 'Sending test…' : 'Send Test'}
          </button>
          {step === 4 && (
            <button
              type="button"
              onClick={() => setBlast({ phase: 'confirm', confirmText: '', confirmedCount: count, campaignId: null, tally: null, error: null })}
              disabled={!canOpenBlastConfirm}
              title={canOpenBlastConfirm
                ? `Sends to all ${count} recipients — requires typing the count to confirm`
                : 'Needs a subject, a message, and at least 1 recipient'}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {blastBusy ? 'Sending…' : blastFinished ? 'Sent' : 'Send Blast'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setStep(s => Math.min(4, s + 1))}
            disabled={step === 4}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center space-x-1"
          >
            <span>Next</span><ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  // ---- #390 renderers -------------------------------------------------

  const refreshButton = (onClick, busy) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60 flex-shrink-0"
    >
      <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
      Refresh
    </button>
  );

  const errorBox = (text) => (
    <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">{text}</div>
  );

  const warnBox = (text) => (
    <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2">{text}</div>
  );

  const renderCampaignDetail = (campaign, tally) => {
    if (detail.campaignId !== campaign.id) return null;
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2">
        {detail.loading && <p className="text-sm text-gray-500">Loading recipients…</p>}
        {detail.error && errorBox(`Could not load this campaign's recipients: ${detail.error}`)}
        {!detail.loading && !detail.error && detail.rows.length === 0 && (
          <p className="text-sm text-gray-500">No recipient rows were ever snapshotted for this campaign.</p>
        )}
        {detail.rows.length > 0 && (
          <>
            <p className="text-xs text-gray-500">
              Showing {detail.rows.length}
              {tally && tally.total > detail.rows.length ? ` of ${tally.total}` : ''} recipient{detail.rows.length === 1 ? '' : 's'} — failures first.
              {tally && tally.total > detail.rows.length ? ' Only the first page is shown.' : ''}
            </p>
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-200 rounded-lg bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Email</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Status</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Error</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detail.rows.map(r => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-gray-900 whitespace-nowrap">{r.email}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{statusPill(r.status)}</td>
                      <td className="px-3 py-2 text-gray-600">{r.error || '—'}</td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtWhen(r.sent_at) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  };

  // ---- #400: stranded drafts -------------------------------------------
  // A campaign is written as 'draft' before its recipients are snapshotted
  // and send-campaign is called. If send-campaign refuses (409 count
  // mismatch, 403, network) the wizard shows the error but the draft row
  // and its recipients stay behind, still 'draft' — it never turned into
  // 'sending', so nobody was emailed. On 2026-09-23 six such drafts existed
  // (363 recipients across the three real ones) and the owner could not
  // find them: they were in the history list, labelled "Draft — never
  // sent", with nothing to do about them. These two actions are the
  // something. "Send now" re-runs the exact same server path the wizard
  // uses (send-campaign only ever emails rows still 'pending', so a retry
  // can never double-send). "Delete" removes the snapshot and the row.
  const draftCampaigns = history.campaigns.filter(c => c.status === 'draft');

  const draftCanSend = (c) => {
    const tally = history.tallies[c.id];
    // send-campaign 409s unless the snapshot matches the confirmed count,
    // so don't offer a button that is guaranteed to fail.
    return !!tally && tally.total > 0 && tally.total === (c.recipient_count ?? -1);
  };

  const sendDraft = async (c) => {
    if (blastBusy || draftBusyId) return;
    const tally = history.tallies[c.id];
    const ok = window.confirm(
      `Send "${c.subject || '(no subject)'}" now?\n\n` +
      `${tally?.total ?? 0} recipients, frozen when the draft was created on ${fmtWhen(c.created_at)}. ` +
      `Anyone who has unsubscribed since will be skipped.`
    );
    if (!ok) return;
    setDraftNote(null);
    setDraftBusyId(c.id);
    try {
      await runSend(c.id);
    } finally {
      setDraftBusyId(null);
      await loadHistory();
    }
  };

  const deleteDraft = async (c) => {
    if (draftBusyId) return;
    const ok = window.confirm(
      `Delete the draft "${c.subject || '(no subject)'}"?\n\nIt was never sent. This removes it and its recipient list for good.`
    );
    if (!ok) return;
    setDraftNote(null);
    setDraftBusyId(c.id);
    // Recipients first (they reference the campaign), then the campaign
    // itself, guarded on status so a draft that started sending under our
    // feet is never deleted. Zero rows back from the campaign delete means
    // RLS refused or the status moved — say so rather than pretend.
    const { error: recErr } = await supabase.from('email_campaign_recipients').delete().eq('campaign_id', c.id);
    if (recErr) {
      setDraftBusyId(null);
      setDraftNote({ kind: 'error', text: `Could not delete the draft's recipient list: ${formatUserError(recErr)}` });
      return;
    }
    const { data, error } = await supabase.from('email_campaigns').delete().eq('id', c.id).eq('status', 'draft').select('id');
    setDraftBusyId(null);
    if (error) {
      setDraftNote({ kind: 'error', text: `Could not delete the draft: ${formatUserError(error)}` });
      return;
    }
    if (!data || data.length === 0) {
      setDraftNote({ kind: 'error', text: 'The draft was not deleted — it may no longer be a draft, or you may not have permission.' });
      return;
    }
    setDraftNote({ kind: 'ok', text: `Deleted the draft "${c.subject || '(no subject)'}".` });
    await loadHistory();
  };

  const renderDraftsPanel = () => {
    if (draftCampaigns.length === 0 && !draftNote) return null;
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 space-y-3">
        <div className="flex items-start gap-2">
          <ShieldAlert size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <h5 className="text-sm font-semibold text-amber-900">
              {draftCampaigns.length === 0
                ? 'No drafts waiting'
                : `${draftCampaigns.length} campaign${draftCampaigns.length === 1 ? '' : 's'} created but never sent`}
            </h5>
            <p className="text-xs text-amber-800 mt-0.5">
              These were written but the send never started — nobody received them. Send them now, or delete them.
            </p>
          </div>
        </div>
        {draftNote && (
          <div className={`rounded px-3 py-2 text-xs ${draftNote.kind === 'error' ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-green-50 border border-green-200 text-green-800'}`}>
            {draftNote.text}
          </div>
        )}
        {draftCampaigns.length > 0 && (
          <div className="divide-y divide-amber-200 bg-white rounded border border-amber-200">
            {draftCampaigns.map(c => {
              const tally = history.tallies[c.id];
              const mine = blast && blast.campaignId === c.id;
              const busy = draftBusyId === c.id;
              return (
                <div key={`draft-${c.id}`} className="px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex-1 min-w-[200px]">
                    <div className="text-sm font-medium text-gray-900 break-words">{c.subject || <span className="italic text-gray-400">(no subject)</span>}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Created {fmtWhen(c.created_at)} · {c.recipient_count ?? 0} recipient{c.recipient_count === 1 ? '' : 's'} confirmed
                      {tally ? ` · ${tally.total} on the frozen list` : ' · list not loaded'}
                      {tally && tally.total !== (c.recipient_count ?? -1) && (
                        <span className="text-red-700"> · list does not match the confirmed count, so it cannot be sent — delete it and start again</span>
                      )}
                    </div>
                    {mine && blast.phase === 'sending' && (
                      <div className="text-xs text-blue-700 mt-1">Sending… {blast.tally ? `${blast.tally.sent} sent, ${blast.tally.pending} to go` : ''}</div>
                    )}
                    {mine && blast.phase === 'done' && blast.tally && (
                      <div className="text-xs text-green-700 mt-1">Sent: {blast.tally.sent} delivered to the provider, {blast.tally.failed} failed, {blast.tally.skipped} skipped.</div>
                    )}
                    {mine && blast.phase === 'error' && (
                      <div className="text-xs text-red-700 mt-1">{blast.error}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => sendDraft(c)}
                      disabled={!draftCanSend(c) || blastBusy || !!draftBusyId}
                      className="inline-flex items-center gap-1.5 bg-indigo-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50"
                    >
                      <Send size={12} />
                      {busy && blastBusy ? 'Sending…' : 'Send now'}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteDraft(c)}
                      disabled={blastBusy || !!draftBusyId}
                      className="border border-gray-300 text-gray-700 px-3 py-1.5 rounded text-xs font-medium hover:bg-gray-50 transition disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderHistory = () => (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-gray-900">Campaign History</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            The {HISTORY_LIMIT} most recent campaigns, newest first. Click one to see every address it went to.
          </p>
        </div>
        {refreshButton(loadHistory, history.loading)}
      </div>

      {history.error && errorBox(`Could not load campaign history: ${history.error}`)}
      {history.warn && warnBox(history.warn)}
      {historyLoaded && !history.loading && renderDraftsPanel()}

      {(history.loading || !historyLoaded) && history.campaigns.length === 0 && !history.error && (
        <p className="text-sm text-gray-500 py-8 text-center">Loading campaigns…</p>
      )}

      {/* `historyLoaded` is load-bearing: without it the very first paint —
          before the effect has run — shows "No campaigns yet", which is the
          exact wrong thing to flash at somebody who filed #390 because this
          screen showed him nothing. */}
      {historyLoaded && !history.loading && !history.error && history.campaigns.length === 0 && (
        <div className="text-center py-16 px-6">
          <History size={40} className="mx-auto mb-3 text-gray-300" />
          <h5 className="text-base font-semibold text-gray-900 mb-1">No campaigns yet</h5>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Every campaign shows up here the moment it is created in Send Email Campaign, with its results.
          </p>
        </div>
      )}

      {history.campaigns.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {history.campaigns.map(c => {
            const isOpen = openCampaignId === c.id;
            const tally = history.tallies[c.id];
            const sender = c.created_by ? history.senders[c.created_by] : null;
            return (
              <div key={c.id} className="border-b border-gray-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => openCampaign(c.id)}
                  className="w-full flex items-start px-4 py-3 hover:bg-gray-50 text-left"
                >
                  {isOpen
                    ? <ChevronDown size={16} className="text-gray-500 mt-0.5 flex-shrink-0" />
                    : <ChevronRight size={16} className="text-gray-500 mt-0.5 flex-shrink-0" />}
                  <div className="ml-3 flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 break-words">
                      {c.subject || <span className="italic text-gray-400">(no subject)</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>{c.sent_at ? fmtWhen(c.sent_at) : 'Draft — never sent'}</span>
                      {sender && <span>{sender}</span>}
                      <span>{c.recipient_count ?? 0} recipient{c.recipient_count === 1 ? '' : 's'}</span>
                      {statusPill(c.status)}
                      {tally ? (
                        <span className="flex flex-wrap gap-x-2">
                          <span className="text-green-700">{tally.sent} sent</span>
                          <span className={tally.failed > 0 ? 'text-red-700' : ''}>· {tally.failed} failed</span>
                          <span>· {tally.skipped} skipped</span>
                          {tally.unknown > 0 && <span className="text-amber-700">· {tally.unknown} unconfirmed</span>}
                          {tally.pending > 0 && <span>· {tally.pending} pending</span>}
                        </span>
                      ) : (
                        <span className="text-gray-400">no recipient rows</span>
                      )}
                    </div>
                  </div>
                </button>
                {isOpen && renderCampaignDetail(c, tally)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderFailed = () => (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-gray-900">Failed Emails</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Addresses on the blacklist, and the delivery failures recorded by recent campaigns.
          </p>
        </div>
        {refreshButton(loadFailed, failedView.loading)}
      </div>

      {failedView.error && errorBox(`Could not load failed emails: ${failedView.error}`)}
      {failedView.warn && warnBox(failedView.warn)}

      {(failedView.loading || !failedLoaded) && !failedView.error && (
        <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
      )}

      {failedLoaded && !failedView.loading && !failedView.error && (
        <>
          <section className="space-y-2">
            <h5 className="text-sm font-semibold text-gray-900">Blacklist ({failedView.blacklist.length})</h5>
            <p className="text-xs text-gray-500">
              These addresses are skipped by every future blast and recorded as “skipped”. The unsubscribe
              link in a campaign email adds an address here automatically.
            </p>
            {failedView.blacklist.length === 0 ? (
              <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-6 text-center">
                Nobody is on the blacklist.
              </p>
            ) : (
              <div className="overflow-x-auto max-h-[50vh] overflow-y-auto border border-gray-200 rounded-lg">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Email</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Reason</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {failedView.blacklist.map(b => (
                      <tr key={b.email}>
                        <td className="px-3 py-2 text-gray-900 whitespace-nowrap">{b.email}</td>
                        <td className="px-3 py-2 text-gray-600">{b.reason || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtWhen(b.created_at) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h5 className="text-sm font-semibold text-gray-900">Recent delivery failures ({failedView.failureTotal})</h5>
            <p className="text-xs text-gray-500">
              Recipients the email provider rejected, from the {HISTORY_LIMIT} most recent campaigns, newest
              campaign first{failedView.failureTotal > failedView.failures.length ? ` — showing the first ${FAILURE_LIMIT}` : ''}.
              A failure carries no send time of its own, so the time shown is its campaign’s.
            </p>
            {failedView.failures.length === 0 ? (
              <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-6 text-center">
                No delivery failures recorded.
              </p>
            ) : (
              <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-200 rounded-lg">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Email</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Campaign</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">Error</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-600">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {failedView.failures.map(f => (
                      <tr key={f.id}>
                        <td className="px-3 py-2 text-gray-900 whitespace-nowrap">{f.email}</td>
                        <td className="px-3 py-2 text-gray-600">
                          {f.campaign?.subject || <span className="italic text-gray-400">(no subject)</span>}
                        </td>
                        <td className="px-3 py-2 text-red-700">{f.error || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                          {fmtWhen(f.sent_at || f.campaign?.sent_at || f.campaign?.created_at) || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );

  const renderPlaceholder = (title, body) => (
    <div className="text-center py-16 px-6">
      <Mail size={40} className="mx-auto mb-3 text-gray-300" />
      <h4 className="text-base font-semibold text-gray-900 mb-1">{title}</h4>
      <p className="text-sm text-gray-500 max-w-md mx-auto">{body}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Email Campaign</h2>
        <p className="text-gray-600">Send targeted email blasts, manage templates and images, and review campaign history.</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* Left rail — the five EZFacility items */}
        <aside className="bg-white rounded-lg shadow w-full lg:w-72 flex-shrink-0 divide-y divide-gray-100">
          {visibleSections.map(({ key, label, desc, icon: Icon }) => (
            <button
              key={key}
              onClick={() => onSectionChange(key)}
              className={`w-full text-left px-4 py-3 transition flex items-start space-x-3 ${effectiveSection === key ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            >
              <Icon size={17} className={`mt-0.5 flex-shrink-0 ${effectiveSection === key ? 'text-blue-600' : 'text-gray-400'}`} />
              <span>
                <span className={`block text-sm font-medium ${effectiveSection === key ? 'text-blue-700' : 'text-gray-900'}`}>{label}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{desc}</span>
              </span>
            </button>
          ))}
        </aside>

        {/* Content area */}
        <div className="bg-white rounded-lg shadow flex-1 min-w-0 p-6">
          {effectiveSection === 'send' && renderWizard()}
          {effectiveSection === 'history' && renderHistory()}
          {effectiveSection === 'templates' && renderPlaceholder('Email Template Library', 'Create, edit and organize reusable templates by category — they feed the picker in Compose Message. Arrives in Phase 3.')}
          {effectiveSection === 'images' && <EmailImageLibrary userId={userId} />}
          {effectiveSection === 'failed' && renderFailed()}
        </div>
      </div>

      {/* #281 Phase 2: the last thing between a mis-click and the whole list —
          the admin must TYPE the exact recipient count. */}
      {blast && blast.phase === 'confirm' && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          {/* House pattern: max-h + flex-col + overflow. This modal's content
              is short today, but #350 shipped twice with action buttons
              pushed off a `fixed` overlay the page cannot scroll, and the
              obvious next request here ("show me who's on the list") is
              exactly the unbounded content that causes it. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-y-auto p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Send this blast?</h3>
            <p className="text-sm text-gray-700 mb-1">
              This sends to <span className="font-bold">{blast.confirmedCount} recipients</span> ({activeCategoryLabel}).
              <span className="font-semibold"> It cannot be undone.</span>
            </p>
            <p className="text-sm text-gray-500 mb-4">Type the recipient count to confirm.</p>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={blast.confirmText}
              onChange={(e) => setBlast(prev => ({ ...prev, confirmText: e.target.value }))}
              placeholder={String(blast.confirmedCount)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 mb-1"
            />
            {blast.confirmText.trim() !== '' && blast.confirmText.trim() !== String(blast.confirmedCount) && (
              <p className="text-xs text-red-600 mb-2">That does not match the recipient count.</p>
            )}
            <div className="flex justify-end space-x-3 mt-4">
              <button
                type="button"
                onClick={() => setBlast(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmedBlast}
                disabled={blast.confirmText.trim() !== String(blast.confirmedCount)}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Send to {blast.confirmedCount} recipients
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
