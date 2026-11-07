// #440: the NBP+ Athlete Training Agreement's pricing table (Section 2 of the
// PDF, v NBP+2.0) and the shared "who has to sign it" rule. The page and the
// staff lists both read from here so the numbers can't drift.
//
// Prices are PRE-TAX cents. Paid-in-full is 10% off the term total; month to
// month is the total split over the term, rounded to the cent (the PDF notes
// the 6-month final payment adjusts so the total matches).

import { supabase } from './supabaseClient';

export const AGREEMENT_TITLE_MATCH = '%Athlete Training Agreement%';

export const TERM_OPTIONS = [
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
];
export const TRAINING_TYPE_OPTIONS = [
  { value: 'in_house', label: 'In-house' },
  { value: 'remote', label: 'Remote' },
];
export const PAYMENT_OPTIONS = [
  { value: 'upfront', label: 'Paid in full upfront (10% off)' },
  { value: 'monthly', label: 'Month to month' },
];

// term_months → training_type → total pre-tax cents
const TERM_TOTAL_CENTS = {
  6: { remote: 350000, in_house: 400000 },
  12: { remote: 600000, in_house: 750000 },
};

// #482: during a high school, college or pro season the training price is
// cut by this fraction for those months (clause the athlete initials). Staff
// apply it per month; the signed price_cents is the full-term price.
export const IN_SEASON_DISCOUNT = 0.5;

export function agreementPricing(termMonths, trainingType) {
  const total = TERM_TOTAL_CENTS[termMonths]?.[trainingType];
  if (!total) return null;
  const upfront = Math.round(total * 0.9);
  const monthly = Math.round(total / termMonths);
  return { total, upfront, monthly, savings: total - upfront };
}

// What the athlete commits to under the chosen option: the discounted total
// when paying upfront, otherwise the full term total paid monthly.
export function agreementPrice(termMonths, trainingType, paymentOption) {
  const p = agreementPricing(termMonths, trainingType);
  if (!p) return null;
  return paymentOption === 'upfront'
    ? { price: p.upfront, monthly: null }
    : { price: p.total, monthly: p.monthly };
}

export const fmtUsd = (cents) => (cents == null ? '—'
  : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

// Start + N months, same day-of-month (clamped by Date arithmetic), minus a day
// so a 6-month term from 1 Jan ends 30 Jun.
export function termEndDate(startStr, termMonths) {
  if (!startStr || !termMonths) return '';
  const d = new Date(startStr + 'T00:00:00');
  if (isNaN(d)) return '';
  d.setMonth(d.getMonth() + termMonths);
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isUnder18(dobStr) {
  if (!dobStr) return false;
  const dob = new Date(dobStr + 'T00:00:00');
  if (isNaN(dob)) return false;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age < 18;
}

// Is this user an NBP+ athlete — a member of any training group? Same rule as
// #436's program_status (teams.team_type = 'training'). Readable by the
// athlete about themself; team_members is self-readable.
export async function isNbpPlusMember(userId) {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id, teams!inner(team_type)')
    .eq('user_id', userId)
    .eq('teams.team_type', 'training')
    .limit(1);
  if (error) { console.error('isNbpPlusMember:', error); return false; }
  return (data || []).length > 0;
}

// The current agreement document, or null when none is uploaded / readable.
export async function fetchAgreementDoc() {
  const { data: rows, error } = await supabase
    .from('staff_documents')
    .select('id, title, file_path, version, created_at')
    .ilike('title', AGREEMENT_TITLE_MATCH)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('fetchAgreementDoc:', error); return null; }
  const row = rows && rows[0];
  if (!row) return null;
  const { data: signed } = await supabase.storage
    .from('staff-documents')
    .createSignedUrl(row.file_path, 60 * 60);
  const ext = (row.file_path || '').split('.').pop().toLowerCase();
  return { id: row.id, title: row.title, version: row.version, ext, signedUrl: signed?.signedUrl || null };
}

// Has `userId` signed the CURRENT document? Returns true/false, or null when
// unknowable (no document readable) — the sidebar tests `=== false`, so null
// shows no dot but makes no false claim (#378's lesson).
export async function fetchAgreementSigned(userId) {
  const doc = await fetchAgreementDoc();
  if (!doc) return null;
  const { data, error } = await supabase
    .from('nbp_plus_agreements')
    .select('id')
    .eq('user_id', userId)
    .eq('document_id', doc.id)
    .maybeSingle();
  if (error) { console.error('fetchAgreementSigned:', error); return null; }
  return !!data;
}
