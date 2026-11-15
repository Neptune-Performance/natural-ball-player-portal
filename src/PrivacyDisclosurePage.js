import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { CheckCircle, AlertTriangle, Search } from 'lucide-react';
import { formatUserError } from './errorMessage';
import { readAllPages } from './readAllPages';
import { fetchUserDirectory } from './userDirectory';
import { FacilityFineDocViewer } from './FacilityFinePage';

// #490: NBP Client Data Privacy Disclosure. Cordell uploaded the PDF under
// Documents and wants it in every athlete's account. Same model as the
// Facility Fine policy (#189): the uploaded file is the only source of the
// text, every signed-in user can read it (title-based RLS, migration
// 20261114_privacy_disclosure.sql), and each user acknowledges the CURRENT
// upload once — re-uploading a new version asks everyone again.
//
// The acknowledgement is a typed full name, not a drawn signature: it is a
// disclosure being read, not a contract being signed.

// Title an admin must use when uploading it. The RLS policies match on the
// same text — keep the two in sync.
export const PRIVACY_DISCLOSURE_TITLE_MATCH = '%Privacy Disclosure%';

const fmtDate = (s) => new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

// The current disclosure document, or null when none is uploaded / readable.
export async function fetchPrivacyDisclosureDoc() {
  const { data: rows, error } = await supabase
    .from('staff_documents')
    .select('id, title, file_path, created_at')
    .ilike('title', PRIVACY_DISCLOSURE_TITLE_MATCH)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('fetchPrivacyDisclosureDoc:', error); return null; }
  const row = rows && rows[0];
  if (!row) return null;
  const { data: signed } = await supabase.storage
    .from('staff-documents')
    .createSignedUrl(row.file_path, 60 * 60);
  const ext = (row.file_path || '').split('.').pop().toLowerCase();
  // The upload's title is its file name ("… – PDF.pdf"); show it without that.
  const title = (row.title || '').replace(/\s*[–-]\s*PDF\.pdf$/i, '').replace(/\.pdf$/i, '');
  return signed?.signedUrl ? { id: row.id, title, ext, signedUrl: signed.signedUrl } : null;
}

// Has `userId` acknowledged the CURRENT document? true / false, or null when
// unknowable (no document readable) — the sidebar tests `=== false`, so null
// shows no dot but makes no false claim (#378's lesson).
export async function fetchPrivacyDisclosureAcknowledged(userId) {
  const { data: rows, error: docErr } = await supabase
    .from('staff_documents')
    .select('id')
    .ilike('title', PRIVACY_DISCLOSURE_TITLE_MATCH)
    .order('created_at', { ascending: false })
    .limit(1);
  const doc = rows && rows[0];
  if (docErr || !doc) return null;
  const { data, error } = await supabase
    .from('privacy_disclosure_acknowledgements')
    .select('id')
    .eq('user_id', userId)
    .eq('document_id', doc.id)
    .maybeSingle();
  if (error) { console.error('fetchPrivacyDisclosureAcknowledged:', error); return null; }
  return !!data;
}

// Staff only: who has acknowledged this version.
function AcknowledgementRoster({ documentId }) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acks = await readAllPages(() => supabase
          .from('privacy_disclosure_acknowledgements')
          .select('id, user_id, signature_text, acknowledged_at')
          .eq('document_id', documentId)
          .order('acknowledged_at', { ascending: false })
          .order('id'));
        // A few hundred ids per lookup keeps the request URL short.
        const people = new Map();
        const ids = acks.map(a => a.user_id);
        for (let i = 0; i < ids.length; i += 200) {
          const part = await fetchUserDirectory(ids.slice(i, i + 200));
          part.forEach((v, k) => people.set(k, v));
        }
        if (!cancelled) setRows(acks.map(a => ({ ...a, name: people.get(a.user_id)?.full_name || a.signature_text, role: people.get(a.user_id)?.role || '' })));
      } catch (err) {
        console.error('AcknowledgementRoster:', err);
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [documentId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter(r => `${r.name} ${r.signature_text}`.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-900">
          Acknowledged by {rows == null ? '…' : rows.length}
        </h2>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name"
            className="pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
      {rows == null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-500">{rows.length === 0 ? 'Nobody has acknowledged this version yet.' : 'No match.'}</p>
      ) : (
        <ul className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
          {shown.map(r => (
            <li key={r.id} className="py-2 flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-900">
                {r.name}
                {r.role && r.role !== 'player' && <span className="ml-2 text-xs text-gray-400 capitalize">{r.role}</span>}
              </span>
              <span className="text-gray-500 whitespace-nowrap">{fmtDate(r.acknowledged_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PrivacyDisclosurePage({ userId, userRole, onAcknowledged }) {
  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState(null);
  const [existing, setExisting] = useState(null);
  const [printedName, setPrintedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isStaff = userRole === 'admin' || userRole === 'coach';

  const fetchAck = async (documentId) => {
    const { data } = await supabase
      .from('privacy_disclosure_acknowledgements')
      .select('*')
      .eq('user_id', userId)
      .eq('document_id', documentId)
      .maybeSingle();
    return data;
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      const d = await fetchPrivacyDisclosureDoc();
      setDoc(d);
      if (d) setExisting(await fetchAck(d.id));
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleSubmit = async () => {
    if (!printedName.trim()) return alert('Please type your full name.');
    if (!agreed) return alert('Please tick the box to confirm you have read the disclosure.');
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('privacy_disclosure_acknowledgements')
        .insert({ user_id: userId, document_id: doc.id, signature_text: printedName.trim() });
      // 23505: already acknowledged from another tab — that is a success.
      if (error && error.code !== '23505') throw error;
      setExisting(await fetchAck(doc.id));
      if (onAcknowledged) onAcknowledged();
    } catch (error) {
      console.error('Privacy disclosure acknowledge error:', error);
      alert('Could not save your acknowledgement: ' + formatUserError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading privacy disclosure...</div>;
  }

  if (!doc) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 flex-shrink-0" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-amber-900">Privacy disclosure not available</h2>
            <p className="text-sm text-amber-800 mt-1">
              We could not load the client data privacy disclosure for your account. Please
              contact an admin.
            </p>
            <p className="text-xs text-amber-700 mt-2">
              Admins: upload it under Settings → Documents with "Privacy Disclosure" in the title.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{doc.title}</h1>
        <p className="text-sm text-gray-500 mt-1">
          How NBP collects, uses and protects your information. Read it below, then acknowledge.
        </p>
      </div>

      <FacilityFineDocViewer doc={doc} />

      {existing ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-5 flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0" size={22} />
          <div>
            <div className="text-green-900 font-semibold">Acknowledged</div>
            <div className="text-sm text-green-800">
              {existing.signature_text} · {fmtDate(existing.acknowledged_at)}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <label className="flex items-start gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300"
            />
            <span>
              I have read the NBP Client Data Privacy Disclosure. If the athlete is under 18,
              I am their parent or guardian and I am acknowledging it on their behalf.
            </span>
          </label>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full name *</label>
            <input
              type="text"
              value={printedName}
              onChange={(e) => setPrintedName(e.target.value)}
              placeholder="Type your full name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Acknowledge'}
            </button>
          </div>
        </div>
      )}

      {isStaff && <AcknowledgementRoster documentId={doc.id} />}
    </div>
  );
}
