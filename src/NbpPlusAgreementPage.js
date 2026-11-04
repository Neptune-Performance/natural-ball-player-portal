import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { CheckCircle, AlertTriangle, FileSignature, Clock } from 'lucide-react';
import { formatUserError } from './errorMessage';
import {
  TERM_OPTIONS, TRAINING_TYPE_OPTIONS, PAYMENT_OPTIONS,
  agreementPricing, agreementPrice, fmtUsd, termEndDate, isUnder18, IN_SEASON_DISCOUNT,
  fetchAgreementDoc,
} from './nbpPlusAgreement';

// #440: NBP+ Athlete Training Agreement, filled out and signed in the app.
//
// Cordell uploaded the agreement (Settings → Documents, title "NBP Athlete
// Training Agreement …") as a fillable PDF and wants NBP+ athletes to complete
// it here instead of printing it. The PDF is rendered for reading; every field
// it asks for is a form field below it, in the PDF's own order: Section 1
// (athlete + program details), the three INITIALS boxes (Sections 2, 3, 4) and
// Section 10's signatures. Signatures are TYPED full legal names — that is
// what the document itself says ("type full legal name to sign") — so unlike
// the Waiver / LOI pages there is no canvas and no storage upload.
//
// Mandatory = sidebar red dot for training-group members, like the other four
// documents. The NBP countersignature (Section 10, third block) is staff's: an
// admin or coach signs it from the athlete's signed view.

const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const lbl = 'block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1';
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (s) => (s ? new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—');

function DocViewer({ doc }) {
  if (!doc || !doc.signedUrl) return null;
  const isPdf = doc.ext === 'pdf';
  const isOffice = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(doc.ext);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">{doc.title}{doc.version ? <span className="ml-2 text-xs font-normal text-gray-400">v{doc.version}</span> : null}</h3>
        <a href={doc.signedUrl} target="_blank" rel="noopener noreferrer" download className="text-sm text-blue-600 hover:underline whitespace-nowrap">
          Download / Open in new tab
        </a>
      </div>
      {isPdf ? (
        <iframe title={doc.title} src={doc.signedUrl} className="w-full" style={{ height: '70vh', border: 0 }} />
      ) : isOffice ? (
        <iframe title={doc.title} src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(doc.signedUrl)}`} className="w-full" style={{ height: '70vh', border: 0 }} />
      ) : (
        <div className="p-8 text-center">
          <a href={doc.signedUrl} target="_blank" rel="noopener noreferrer" download className="inline-block bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition">
            Open the document to review
          </a>
        </div>
      )}
    </div>
  );
}

function RadioRow({ name, value, options, onChange }) {
  return (
    <div className="flex flex-wrap gap-4">
      {options.map((o) => (
        <label key={String(o.value)} className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="text-blue-600 focus:ring-blue-500" />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function Initials({ label, value, onChange, children }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded-lg px-4 py-3 flex items-start gap-3">
      <div className="shrink-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-red-700 mb-1">Initials</div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase().slice(0, 4))}
          maxLength={4}
          placeholder="AB"
          aria-label={label}
          className="w-16 px-2 py-1.5 border border-red-300 rounded text-center font-semibold tracking-widest focus:outline-none focus:ring-2 focus:ring-red-400"
        />
      </div>
      <p className="text-sm text-gray-800 pt-4">{children}</p>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <span className={lbl}>{label}</span>
      {children}
    </div>
  );
}

function Readout({ label, value }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm text-gray-900 font-medium">{value || '—'}</div>
    </div>
  );
}

export default function NbpPlusAgreementPage({ userId, userRole, athleteId, onSigned }) {
  // Staff open another athlete's agreement via athleteId (Manage Athletes →
  // profile); athletes open their own.
  const subjectId = athleteId || userId;
  const isStaff = userRole === 'admin' || userRole === 'coach';
  const viewingOther = isStaff && athleteId && athleteId !== userId;

  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState(null);
  const [existing, setExisting] = useState(null);
  const [subject, setSubject] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Section 1
  const [athleteName, setAthleteName] = useState('');
  const [dob, setDob] = useState('');
  const [parentName, setParentName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [termMonths, setTermMonths] = useState(null);
  const [trainingType, setTrainingType] = useState(null);
  const [paymentOption, setPaymentOption] = useState(null);
  const [startDate, setStartDate] = useState(today());

  // Initials
  const [initPayment, setInitPayment] = useState('');
  const [initRequirements, setInitRequirements] = useState('');
  const [initEarlyStop, setInitEarlyStop] = useState('');
  const [initInSeason, setInitInSeason] = useState('');

  // Signatures
  const [athleteSig, setAthleteSig] = useState('');
  const [parentSig, setParentSig] = useState('');
  const [parentPrinted, setParentPrinted] = useState('');
  const [parentRelationship, setParentRelationship] = useState('');
  const [agree, setAgree] = useState(false);

  // Countersign (staff)
  const [nbpSig, setNbpSig] = useState('');
  const [nbpTitle, setNbpTitle] = useState('');
  const [countersigning, setCountersigning] = useState(false);

  const endDate = useMemo(() => termEndDate(startDate, termMonths), [startDate, termMonths]);
  const pricing = useMemo(() => agreementPricing(termMonths, trainingType), [termMonths, trainingType]);
  const chosen = useMemo(() => agreementPrice(termMonths, trainingType, paymentOption), [termMonths, trainingType, paymentOption]);
  const minor = isUnder18(dob);

  const load = async () => {
    setLoading(true);
    const [d, { data: u, error: uErr }] = await Promise.all([
      fetchAgreementDoc(),
      supabase.from('users').select('id, full_name, email, phone, date_of_birth, parent1_name, parent1_email').eq('id', subjectId).maybeSingle(),
    ]);
    if (uErr) console.error('NbpPlusAgreementPage: user read failed:', uErr);
    setDoc(d);
    setSubject(u || null);
    if (u) {
      setAthleteName((prev) => prev || u.full_name || '');
      setDob((prev) => prev || u.date_of_birth || '');
      setPhone((prev) => prev || u.phone || '');
      setEmail((prev) => prev || u.email || '');
      setParentName((prev) => prev || u.parent1_name || '');
    }
    if (d) {
      const { data: row, error: rErr } = await supabase
        .from('nbp_plus_agreements')
        .select('*')
        .eq('user_id', subjectId)
        .eq('document_id', d.id)
        .maybeSingle();
      if (rErr) console.error('NbpPlusAgreementPage: agreement read failed:', rErr);
      setExisting(row || null);
    } else {
      setExisting(null);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [subjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Staff countersign defaults to their own name.
  useEffect(() => {
    if (!isStaff || !userId) return;
    supabase.from('users').select('full_name').eq('id', userId).maybeSingle()
      .then(({ data }) => { if (data?.full_name) setNbpSig((prev) => prev || data.full_name); });
  }, [isStaff, userId]);

  const validate = () => {
    if (!athleteName.trim()) return 'Enter the athlete\'s name.';
    if (!dob) return 'Enter the athlete\'s date of birth.';
    if (!termMonths) return 'Choose a term — 6 or 12 months.';
    if (!trainingType) return 'Choose a training type — in-house or remote.';
    if (!paymentOption) return 'Choose a payment option.';
    if (!startDate) return 'Enter a start date.';
    if (!chosen) return 'Could not work out the price for that term and training type.';
    if (!initPayment.trim() || !initRequirements.trim() || !initEarlyStop.trim() || !initInSeason.trim()) return 'Add your initials to all four boxes.';
    if (!athleteSig.trim()) return 'Type the athlete\'s full legal name to sign.';
    if (minor) {
      if (!parentName.trim()) return 'A parent or guardian name is required for an athlete under 18.';
      if (!parentSig.trim()) return 'A parent or guardian must type their full legal name to sign.';
      if (!parentRelationship.trim()) return 'Enter the parent or guardian\'s relationship to the athlete.';
    }
    if (!agree) return 'Confirm you have read and agree to the agreement.';
    return '';
  };

  const handleSubmit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError('');
    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      const parentSigned = parentSig.trim() ? now : null;
      const { error: insErr } = await supabase.from('nbp_plus_agreements').insert({
        user_id: subjectId,
        document_id: doc.id,
        athlete_name: athleteName.trim(),
        date_of_birth: dob || null,
        parent_name: parentName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        term_months: termMonths,
        training_type: trainingType,
        payment_option: paymentOption,
        start_date: startDate,
        end_date: endDate,
        price_cents: chosen.price,
        monthly_cents: chosen.monthly,
        initials_payment: initPayment.trim(),
        initials_requirements: initRequirements.trim(),
        initials_early_stop: initEarlyStop.trim(),
        initials_in_season: initInSeason.trim(),
        athlete_signature: athleteSig.trim(),
        athlete_signed_at: now,
        parent_signature: parentSig.trim() || null,
        parent_printed_name: (parentPrinted.trim() || parentName.trim()) || null,
        parent_relationship: parentRelationship.trim() || null,
        parent_signed_at: parentSigned,
      });
      if (insErr) throw insErr;
      await load();
      if (onSigned && subjectId === userId) onSigned();
    } catch (e) {
      console.error('NBP+ agreement sign error:', e);
      setError('Could not save the agreement: ' + formatUserError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCountersign = async () => {
    if (!nbpSig.trim()) { setError('Type your full legal name to countersign.'); return; }
    setError('');
    setCountersigning(true);
    try {
      const { error: upErr } = await supabase
        .from('nbp_plus_agreements')
        .update({
          nbp_signature: nbpSig.trim(),
          nbp_printed_name: nbpSig.trim(),
          nbp_title: nbpTitle.trim() || null,
          nbp_signed_at: new Date().toISOString(),
          nbp_signed_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .is('nbp_signed_at', null);
      if (upErr) throw upErr;
      await load();
    } catch (e) {
      console.error('NBP+ agreement countersign error:', e);
      setError('Could not countersign: ' + formatUserError(e));
    } finally {
      setCountersigning(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-500">Loading NBP+ training agreement...</div>;

  if (!doc) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 flex-shrink-0" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-amber-900">NBP+ training agreement not available</h2>
            <p className="text-sm text-amber-800 mt-1">
              We could not load the agreement document for your account. Either it has not been uploaded yet, or your
              account does not have permission to view it. Please contact an admin — do not assume you have nothing to sign.
            </p>
            <p className="text-xs text-amber-700 mt-2">
              Admins: upload it under Settings → Documents with "Athlete Training Agreement" in the title.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const heading = viewingOther && subject ? `${subject.full_name} — NBP+ Training Agreement` : 'NBP+ Athlete Training Agreement';

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{heading}</h1>
        <p className="text-sm text-gray-500 mt-1">
          6-month and 12-month terms · required for every NBP+ athlete, in-house or remote, before training begins.
          Read the agreement, then complete the fields below — they are the same fields as the document.
        </p>
      </div>

      <DocViewer doc={doc} />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {existing ? (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-5 flex items-start gap-3">
            <CheckCircle className="text-green-600 flex-shrink-0" size={22} />
            <div className="flex-1">
              <div className="text-green-900 font-semibold">Signed</div>
              <div className="text-sm text-green-800">
                {existing.athlete_signature} · {fmtDate(existing.athlete_signed_at)}
                {existing.parent_signature ? ` · parent/guardian ${existing.parent_signature}` : ''}
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">1. Athlete and program details</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Readout label="Athlete" value={existing.athlete_name} />
              <Readout label="Date of birth" value={fmtDate(existing.date_of_birth)} />
              <Readout label="Parent / guardian" value={existing.parent_name} />
              <Readout label="Phone" value={existing.phone} />
              <Readout label="Email" value={existing.email} />
              <Readout label="Term" value={`${existing.term_months} months`} />
              <Readout label="Training type" value={TRAINING_TYPE_OPTIONS.find((o) => o.value === existing.training_type)?.label} />
              <Readout label="Payment option" value={PAYMENT_OPTIONS.find((o) => o.value === existing.payment_option)?.label} />
              <Readout label="Start date" value={fmtDate(existing.start_date)} />
              <Readout label="End date" value={fmtDate(existing.end_date)} />
              <Readout label="Price (pre-tax)" value={`${fmtUsd(existing.price_cents)}${existing.monthly_cents ? ` · ${fmtUsd(existing.monthly_cents)} / month` : ''}`} />
            </div>
            <div className={`mt-4 grid gap-3 text-xs text-gray-600 ${existing.initials_in_season ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
              <div><span className="font-semibold text-gray-800">{existing.initials_payment}</span> — committing to every payment for the term</div>
              <div><span className="font-semibold text-gray-800">{existing.initials_requirements}</span> — biomechanics assessment + WHOOP Peak</div>
              <div><span className="font-semibold text-gray-800">{existing.initials_early_stop}</span> — stopping early does not end payments</div>
              {/* #482: absent on agreements signed before the clause existed */}
              {existing.initials_in_season && (
                <div><span className="font-semibold text-gray-800">{existing.initials_in_season}</span> — {Math.round(IN_SEASON_DISCOUNT * 100)}% off during HS / college / pro season months</div>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">10. Signatures</div>
            <div className="grid sm:grid-cols-3 gap-4">
              <Readout label="Athlete" value={`${existing.athlete_signature} · ${fmtDate(existing.athlete_signed_at)}`} />
              <Readout label="Parent / guardian" value={existing.parent_signature ? `${existing.parent_signature}${existing.parent_relationship ? ` (${existing.parent_relationship})` : ''} · ${fmtDate(existing.parent_signed_at)}` : 'Not required'} />
              <Readout label="The Natural Ballplayer" value={existing.nbp_signed_at ? `${existing.nbp_signature}${existing.nbp_title ? `, ${existing.nbp_title}` : ''} · ${fmtDate(existing.nbp_signed_at)}` : 'Awaiting NBP countersignature'} />
            </div>

            {isStaff && !existing.nbp_signed_at && (
              <div className="mt-5 border-t border-gray-200 pt-4">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-800 mb-3">
                  <FileSignature size={16} className="text-blue-600" /> Countersign for The Natural Ballplayer
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Signature (type full legal name)">
                    <input className={inp} value={nbpSig} onChange={(e) => setNbpSig(e.target.value)} />
                  </Field>
                  <Field label="Title">
                    <input className={inp} value={nbpTitle} onChange={(e) => setNbpTitle(e.target.value)} placeholder="e.g. Owner, Director of Player Development" />
                  </Field>
                </div>
                <div className="flex justify-end mt-3">
                  <button onClick={handleCountersign} disabled={countersigning} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                    {countersigning ? 'Signing…' : 'Countersign'}
                  </button>
                </div>
              </div>
            )}
            {!isStaff && !existing.nbp_signed_at && (
              <p className="mt-4 text-xs text-gray-500 flex items-center gap-1"><Clock size={12} /> NBP will countersign once your agreement has been reviewed.</p>
            )}
          </div>
        </div>
      ) : viewingOther ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 text-sm text-gray-600">
          {subject?.full_name || 'This athlete'} has not signed the current agreement yet. Athletes complete it themselves from Documents → NBP+ Agreement.
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. Athlete and program details */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">1. Athlete and program details</div>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Athlete name *"><input className={inp} value={athleteName} onChange={(e) => setAthleteName(e.target.value)} /></Field>
              <Field label="Date of birth *"><input className={inp} type="date" value={dob} onChange={(e) => setDob(e.target.value)} /></Field>
              <Field label={`Parent / guardian name${minor ? ' *' : ' (if under 18)'}`} className="sm:col-span-2">
                <input className={inp} value={parentName} onChange={(e) => setParentName(e.target.value)} />
              </Field>
              <Field label="Phone"><input className={inp} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <Field label="Email"><input className={inp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Term *"><RadioRow name="term" value={termMonths} options={TERM_OPTIONS} onChange={setTermMonths} /></Field>
              <Field label="Training type *"><RadioRow name="ttype" value={trainingType} options={TRAINING_TYPE_OPTIONS} onChange={setTrainingType} /></Field>
            </div>
            <Field label="Payment option *"><RadioRow name="pay" value={paymentOption} options={PAYMENT_OPTIONS} onChange={setPaymentOption} /></Field>
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Start date *"><input className={inp} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
              <Field label="End date"><input className={`${inp} bg-gray-50`} value={endDate ? fmtDate(endDate) : ''} readOnly placeholder="Pick a term" /></Field>
              <Field label="Price (Section 2, pre-tax)">
                <input className={`${inp} bg-gray-50`} readOnly value={chosen ? `${fmtUsd(chosen.price)}${chosen.monthly ? ` (${fmtUsd(chosen.monthly)} / mo)` : ''}` : ''} placeholder="Pick term, type & payment" />
              </Field>
            </div>
            {pricing && (
              <p className="text-xs text-gray-500">
                {termMonths}-month {TRAINING_TYPE_OPTIONS.find((o) => o.value === trainingType)?.label.toLowerCase()}: {fmtUsd(pricing.total)} total ·{' '}
                {fmtUsd(pricing.monthly)} / month ({termMonths} payments) · {fmtUsd(pricing.upfront)} paid upfront (saves {fmtUsd(pricing.savings)}).
                All prices are before tax; sales tax is added to every payment.
              </p>
            )}
          </div>

          {/* 2 / 3 / 4 initials */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Initial each statement</div>
            <Initials label="Initials — payment commitment" value={initPayment} onChange={setInitPayment}>
              <span className="font-medium">2. Term and Payment.</span> I understand I am committing to every payment for my selected term. NBP has a no-refund policy: all payments are non-refundable.
            </Initials>
            <Initials label="Initials — required before training" value={initRequirements} onChange={setInitRequirements}>
              <span className="font-medium">3. Required Before Training Starts.</span> I will complete the biomechanics assessment ($750 plus tax, non-refundable) and keep an active WHOOP Peak membership for the full term.
            </Initials>
            <Initials label="Initials — stopping early" value={initEarlyStop} onChange={setInitEarlyStop}>
              <span className="font-medium">4. Stopping Training Early.</span> I understand stopping early does not end my payments.
            </Initials>
            <Initials label="Initials — in-season rate" value={initInSeason} onChange={setInitInSeason}>
              <span className="font-medium">4a. In-Season Rate.</span> During the months I am playing a high school, college or professional season, my training price is reduced by {Math.round(IN_SEASON_DISCOUNT * 100)}% to reflect reduced in-season training time. I will let NBP know when my season starts and ends.
              {pricing && paymentOption === 'monthly' && (
                <span className="block text-xs text-gray-500 mt-1">In-season month: {fmtUsd(Math.round(pricing.monthly * (1 - IN_SEASON_DISCOUNT)))} instead of {fmtUsd(pricing.monthly)} (before tax).</span>
              )}
            </Initials>
          </div>

          {/* 10. Signatures */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">10. Signatures</div>
            <div>
              <div className="text-sm font-semibold text-gray-800 mb-2">Athlete</div>
              <Field label="Signature (type full legal name to sign) *">
                <input className={`${inp} font-serif italic text-lg`} value={athleteSig} onChange={(e) => setAthleteSig(e.target.value)} placeholder={athleteName || 'Full legal name'} />
              </Field>
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-800 mb-2">
                Parent / guardian <span className="font-normal text-gray-500">{minor ? '(required — the athlete is under 18)' : '(required if the athlete is under 18)'}</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label={`Signature (type full legal name to sign)${minor ? ' *' : ''}`}>
                  <input className={`${inp} font-serif italic text-lg`} value={parentSig} onChange={(e) => setParentSig(e.target.value)} placeholder={parentName || 'Full legal name'} />
                </Field>
                <Field label="Printed name"><input className={inp} value={parentPrinted} onChange={(e) => setParentPrinted(e.target.value)} placeholder={parentName || ''} /></Field>
                <Field label={`Relationship to athlete${minor ? ' *' : ''}`}><input className={inp} value={parentRelationship} onChange={(e) => setParentRelationship(e.target.value)} placeholder="Mother, Father, Guardian…" /></Field>
              </div>
            </div>
            <div className="text-xs text-gray-500 border-t border-gray-100 pt-3">
              The Natural Ballplayer's countersignature is added by NBP staff after you sign.
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span>By signing, I confirm I have read, understand and agree to this NBP+ Athlete Training Agreement, including the photo and video release in Section 6.</span>
            </label>
            <div className="flex justify-end">
              <button onClick={handleSubmit} disabled={submitting} className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
                {submitting ? 'Submitting…' : 'Sign and Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
