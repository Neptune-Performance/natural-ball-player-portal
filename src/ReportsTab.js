import React, { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import SessionReportView from './mechanics-report/SessionReportView';
import './mechanics-report/SessionReportView.css';

const PAGE_SIZE = 20;
class ReportBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert" className="text-red-700">This report could not be displayed. Please ask your coach to resend it.</p> : this.props.children;
  }
}

export default function ReportsTab({ userId }) {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [reportRetry, setReportRetry] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    (async () => {
      try {
        const { data, error: failure } = await supabase.from('athlete_reports')
          .select('id,title,capture_date,received_at').eq('athlete_id', userId)
          .order('received_at', { ascending: false }).order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        if (failure) throw failure;
        if (active) { setRows(previous => page === 0 ? (data || []).slice(0, PAGE_SIZE) : [...previous, ...(data || []).slice(0, PAGE_SIZE)]); setHasMore((data || []).length > PAGE_SIZE); }
      } catch { if (active) setError('Reports could not be loaded. Please try again.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [userId, page, retry]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setReport(null); setReportError('');
    (async () => {
      try {
        const { data, error: failure } = await supabase.from('athlete_reports').select('payload')
          .eq('id', selected.id).eq('athlete_id', userId).maybeSingle();
        if (failure || !data) throw new Error('Unavailable');
        if (active) {
          if (data.payload?.schema !== 'mechanics-session-report-v1') setReportError('This report format is not supported. Please contact your coach.');
          else setReport(data.payload);
        }
      } catch { if (active) setReportError('This report could not be loaded or is no longer available.'); }
    })();
    return () => { active = false; };
  }, [selected, userId, reportRetry]);

  if (selected) return <section aria-label="Report detail" className="min-w-0 space-y-4">
    <button type="button" onClick={() => { setSelected(null); setReport(null); }} className="text-blue-700 font-medium">← All reports</button>
    <h3 className="text-xl font-semibold text-gray-900">{selected.title}</h3>
    {reportError ? <p role="alert" className="text-red-700">{reportError} <button className="underline" onClick={() => setReportRetry(value => value + 1)}>Retry</button></p> : !report ? <p role="status">Loading report…</p> :
      <ReportBoundary key={selected.id}><SessionReportView report={report} /></ReportBoundary>}
  </section>;
  return <section aria-label="Reports" className="space-y-4">
    <div><h3 className="text-xl font-semibold text-gray-900">Reports</h3><p className="text-sm text-gray-600">Mechanics reports shared by your coach. Each report preserves the findings and notes from the version sent to you.</p></div>
    {error && <p role="alert" className="text-red-700">{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {!loading && !error && !rows.length && <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-600">No reports yet. Reports from your coach will appear here.</div>}
    <ul className="space-y-3">{rows.map(row => <li key={row.id}>
      <button type="button" className="w-full rounded-xl border border-gray-200 p-4 text-left hover:border-blue-400 focus-visible:outline-blue-600" onClick={() => { setReport(null); setReportError(''); setSelected(row); }}>
        <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Mechanics · {row.capture_date}</span>
        <span className="mt-1 block font-semibold text-gray-900">{row.title}</span>
        <span className="mt-2 block text-sm text-blue-700">View report →</span>
      </button>
    </li>)}</ul>
    {loading && <p role="status">Loading reports…</p>}
    {hasMore && !error && <button type="button" disabled={loading} className="rounded-lg border px-4 py-2 text-blue-700 disabled:opacity-50" onClick={() => setPage(value => value + 1)}>Load more reports</button>}
  </section>;
}
