import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportsTab from './ReportsTab';
import { supabase } from './supabaseClient';
jest.mock('./supabaseClient', () => ({ supabase: { from: jest.fn() } }));
jest.mock('./mechanics-report/SessionReportView', () => ({ __esModule: true, default: ({ report }) => <div>Saved notes: {report.notes}</div> }));
const row = { id: 'report1', title: 'Fixture Athlete — Mechanics', capture_date: '2026-11-11' };
function mockQuery(result) {
  const chain = {};
  for (const method of ['select', 'eq', 'order']) chain[method] = jest.fn(() => chain);
  chain.range = jest.fn(async () => result);
  chain.maybeSingle = jest.fn(async () => result);
  supabase.from.mockReturnValueOnce(chain);
  return chain;
}
beforeEach(() => jest.resetAllMocks());
test('loads recipient-scoped metadata, then the full selected report', async () => {
  const list = mockQuery({ data: [row] });
  const detail = mockQuery({ data: { payload: { schema: 'mechanics-session-report-v1', notes: 'Stay balanced.' } } });
  render(<ReportsTab userId="athlete1" />);
  fireEvent.click(await screen.findByText(row.title));
  expect(await screen.findByText('Saved notes: Stay balanced.')).toBeTruthy();
  expect(list.eq).toHaveBeenCalledWith('athlete_id', 'athlete1');
  expect(detail.eq).toHaveBeenCalledWith('id', row.id);
  expect(detail.eq).toHaveBeenCalledWith('athlete_id', 'athlete1');
  fireEvent.click(screen.getByText('← All reports'));
  expect(screen.getByText(row.title)).toBeTruthy();
});
test('shows empty state only after a successful read and retries failures', async () => {
  mockQuery({ error: { message: 'offline' } });
  mockQuery({ data: [] });
  render(<ReportsTab userId="athlete1" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(/No reports yet/)).toBeNull();
  fireEvent.click(screen.getByText('Retry'));
  expect(await screen.findByText(/No reports yet/)).toBeTruthy();
});
test('detail retries do not reload or duplicate a paginated list', async () => {
  mockQuery({ data: Array.from({ length: 21 }, (_, i) => ({ ...row, id: `r${i}`, title: `Report ${i}` })) });
  mockQuery({ data: [{ ...row, id: 'r20', title: 'Report 20' }] });
  mockQuery({ error: { message: 'offline' } });
  mockQuery({ data: { payload: { schema: 'mechanics-session-report-v1', notes: 'Retry succeeded.' } } });
  render(<ReportsTab userId="athlete1" />);
  fireEvent.click(await screen.findByText('Load more reports'));
  fireEvent.click(await screen.findByText('Report 20'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByText('Retry'));
  await screen.findByText('Saved notes: Retry succeeded.');
  expect(supabase.from).toHaveBeenCalledTimes(4);
  fireEvent.click(screen.getByText('← All reports'));
  expect(screen.getAllByText('Report 20')).toHaveLength(1);
});
test('ignores a late response from an unmounted athlete profile', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const chain = mockQuery({ data: [] }); chain.range.mockReturnValue(pending);
  const first = render(<ReportsTab userId="athlete1" />);
  first.unmount();
  mockQuery({ data: [] });
  render(<ReportsTab userId="athlete2" />);
  await screen.findByText(/No reports yet/);
  finish({ data: [row] });
  await waitFor(() => expect(screen.queryByText(row.title)).toBeNull());
});
