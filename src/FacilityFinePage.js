import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { CheckCircle, AlertTriangle, Eraser } from 'lucide-react';
import SignedSignatureImage from './SignedSignatureImage';
import { formatUserError } from './errorMessage';

// Issue #189: acknowledgment of the Facility Fine policy document. Every user
// (player/coach/admin) must sign before they can dismiss the prompt. Mirrors
// ContractPage / WaiverPage flow but with a single signature, no extra fields.
//
// The actual fine document is uploaded via Settings → Documents with a title
// starting "Facility Fine". This page locates it, renders it inline, and writes
// a row to facility_fine_signatures once signed.

// #378 — renders the uploaded facility fine document reliably across file types.
// PDFs render natively; Office documents (.docx and friends) go through the
// Microsoft Office Online viewer; anything else falls back to a prominent
// open/download link so review never silently fails. This mirrors
// ContractDocViewer in ContractPage.js, which solved the identical problem for
// the player contract. Worth collapsing the two into one shared component the
// next time either is touched.
// Exported for PrivacyDisclosurePage (#490), which shows a document the same way.
export function FacilityFineDocViewer({ doc }) {
  if (!doc) return null;
  const ext = (doc.ext || '').toLowerCase();
  const isPdf = ext === 'pdf';
  const isOffice = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">{doc.title}</h3>
        <a
          href={doc.signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          download
          className="text-sm text-blue-600 hover:underline whitespace-nowrap"
        >
          Download / Open in new tab
        </a>
      </div>
      {isPdf ? (
        <iframe title={doc.title} src={doc.signedUrl} className="w-full" style={{ height: '70vh', border: 0 }} />
      ) : isOffice ? (
        <iframe
          title={doc.title}
          src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(doc.signedUrl)}`}
          className="w-full"
          style={{ height: '70vh', border: 0 }}
        />
      ) : (
        <div className="p-8 text-center">
          <p className="text-gray-600 mb-4">This document can't be previewed here.</p>
          <a
            href={doc.signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            download
            className="inline-block bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition"
          >
            Open the document to review
          </a>
        </div>
      )}
      <div className="border-t border-gray-200 px-4 py-3 bg-gray-50">
        <p className="text-xs text-gray-500">
          Trouble viewing it above?{' '}
          <a href={doc.signedUrl} target="_blank" rel="noopener noreferrer" download className="text-blue-600 hover:underline">
            Open it in a new tab
          </a>{' '}to read before signing.
        </p>
      </div>
    </div>
  );
}

export default function FacilityFinePage({ userId, onSigned }) {
  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState(null); // { id, title, signedUrl }
  const [existing, setExisting] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [printedName, setPrintedName] = useState('');

  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

  const fetchDoc = async () => {
    const { data: rows } = await supabase
      .from('staff_documents')
      .select('id, title, file_path, created_at')
      .ilike('title', 'Facility Fine%')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = rows && rows[0];
    if (!row) return null;
    const { data: signed } = await supabase.storage
      .from('staff-documents')
      .createSignedUrl(row.file_path, 60 * 60);
    // #378: the uploaded facility fine document is a .docx, and a .docx in a
    // plain <iframe> downloads or renders nothing. Carry the extension through
    // so the viewer below can pick the right strategy, exactly as ContractPage
    // has done since the player contract hit the same problem.
    const ext = (row.file_path || '').split('.').pop().toLowerCase();
    return signed?.signedUrl ? { id: row.id, title: row.title, ext, signedUrl: signed.signedUrl } : null;
  };

  const fetchSignature = async (documentId) => {
    if (!documentId) return null;
    const { data } = await supabase
      .from('facility_fine_signatures')
      .select('*')
      .eq('user_id', userId)
      .eq('document_id', documentId)
      .maybeSingle();
    return data;
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      const d = await fetchDoc();
      setDoc(d);
      if (d) {
        const sig = await fetchSignature(d.id);
        setExisting(sig);
      }
      setLoading(false);
    })();
  }, [userId]);

  const initCanvas = useCallback((canvas) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  useEffect(() => {
    if (!loading && !existing && doc) initCanvas(canvasRef.current);
  }, [loading, existing, doc, initCanvas]);

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const startDraw = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
  };

  const draw = (e) => {
    e.preventDefault();
    if (!drawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e, canvas);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setHasSignature(true);
  };

  const stopDraw = () => setDrawing(false);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const canvasToBlob = () => new Promise((resolve) => canvasRef.current.toBlob(resolve, 'image/png'));

  const handleSubmit = async () => {
    if (!printedName.trim()) return alert('Please type your printed name.');
    if (!hasSignature) return alert('Please draw your signature.');
    setSubmitting(true);
    try {
      const blob = await canvasToBlob();
      const path = `${userId}/facility-fine-${Date.now()}.png`;
      const { error: upErr } = await supabase.storage
        .from('signatures')
        .upload(path, blob, { contentType: 'image/png', upsert: true });
      if (upErr) throw upErr;

      const { error: insErr } = await supabase
        .from('facility_fine_signatures')
        .insert({
          user_id: userId,
          document_id: doc.id,
          signature_url: path,
          signature_text: printedName.trim(),
        });
      if (insErr) throw insErr;

      const sig = await fetchSignature(doc.id);
      setExisting(sig);
      if (onSigned) onSigned();
    } catch (error) {
      console.error('Facility Fine sign error:', error);
      alert('Could not save signature: ' + formatUserError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading facility fine policy...</div>;
  }

  if (!doc) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 flex-shrink-0" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-amber-900">Facility fine policy not available</h2>
            <p className="text-sm text-amber-800 mt-1">
              We could not load the facility fine document for your account. Either it has not
              been uploaded yet, or your account does not have permission to view it. Please
              contact an admin — do not assume you have nothing to sign.
            </p>
            <p className="text-xs text-amber-700 mt-2">
              Admins: upload it under Settings → Documents with a title starting "Facility Fine".
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
        <p className="text-sm text-gray-500 mt-1">Read the document below, then add your signature to acknowledge.</p>
      </div>

      <FacilityFineDocViewer doc={doc} />

      {existing ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-5 flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0" size={22} />
          <div className="flex-1">
            <div className="text-green-900 font-semibold">Signed</div>
            <div className="text-sm text-green-800">
              {existing.signature_text ? `${existing.signature_text} · ` : ''}
              {new Date(existing.signed_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
            {existing.signature_url && (
              <div className="mt-3 max-w-xs">
                <SignedSignatureImage signatureValue={existing.signature_url} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Printed name *</label>
            <input
              type="text"
              value={printedName}
              onChange={(e) => setPrintedName(e.target.value)}
              placeholder="Type your full name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Signature *</label>
            <div className="border border-gray-300 rounded-lg bg-white">
              <canvas
                ref={canvasRef}
                style={{ width: '100%', height: 180, touchAction: 'none' }}
                onMouseDown={startDraw}
                onMouseMove={draw}
                onMouseUp={stopDraw}
                onMouseLeave={stopDraw}
                onTouchStart={startDraw}
                onTouchMove={draw}
                onTouchEnd={stopDraw}
              />
            </div>
            <button
              type="button"
              onClick={clearCanvas}
              className="mt-2 text-sm text-gray-600 hover:text-gray-900 inline-flex items-center gap-1"
            >
              <Eraser size={14} />
              <span>Clear</span>
            </button>
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Sign and Submit'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
