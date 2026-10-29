import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { TeamReportSummary } from '../TeamReportSummary';
import { exportReport, getReportRun, listTeamReports, requestTeamAttendanceReport } from '../../firebase/reports';
import { clearReportExports, shareReportCsv } from '../../lib/reportExport';
import type { AttendanceCounts, ReportRun } from '../../../shared/reports';

let mockIds = 0;
jest.mock('../../firebase/reports', () => ({
  exportReport: jest.fn(),
  getReportRun: jest.fn(),
  listTeamReports: jest.fn(),
  requestTeamAttendanceReport: jest.fn(),
  reportRequestId: () => `request-${++mockIds}`,
}));
jest.mock('../../lib/reportExport', () => ({ clearReportExports: jest.fn(), shareReportCsv: jest.fn() }));
const list = listTeamReports as jest.Mock;
const exportCsv = exportReport as jest.Mock;
const share = shareReportCsv as jest.Mock;
const read = getReportRun as jest.Mock;
const request = requestTeamAttendanceReport as jest.Mock;

const counts = (patch: Partial<AttendanceCounts> = {}): AttendanceCounts => ({
  events: { closed: 4, cancelled: 1, postponed: 1, awaitingClosure: 1, upcoming: 0 },
  eligible: 40, present: 24, late: 3, absent: 3, excused: 4, unknown: 2, missing: 4,
  presenceRate: { numerator: 27, denominator: 30, rate: 0.9 }, completionCoverage: { numerator: 34, denominator: 40, rate: 0.85 }, ...patch,
});
const run = (patch: Partial<ReportRun> = {}): ReportRun => ({
  runId: 'r1', kind: 'attendance', state: 'complete',
  filters: { kind: 'attendance', programId: 'p', seasonId: 's', teamId: 't', fromDate: '2026-10-01', toDate: '2026-10-30' },
  interval: { startsAt: '2026-10-01T04:00:00.000Z', endsAt: '2026-10-31T04:00:00.000Z', timeZone: 'America/New_York', days: 30, hours: 720 },
  reportVersion: 1, reducerVersion: 1, formulas: [], requestedAt: '2026-10-30T12:00:00.000Z', completedAt: '2026-10-30T12:00:03.000Z',
  sourceCutoff: '2026-10-30T12:00:01.000Z', sourceDigest: 'abc', stale: false, staleReason: null, supersedes: null, supersededBy: null,
  failure: null, attempts: 1, manifest: {}, summary: counts(), rowCount: 1, ...patch,
});
const mount = () => render(<TeamReportSummary orgId="o" programId="p" seasonId="s" teamId="t" />);

beforeEach(() => {
  jest.clearAllMocks();
  mockIds = 0;
});

test('shows the latest team snapshot with numerators, denominators and missing data apart from absent', async () => {
  list.mockResolvedValue({ items: [run()], nextCursor: null });
  await mount();
  await screen.findByText('90%');
  expect(list).toHaveBeenCalledWith('o', 't');
  expect(screen.getByText('27 present or late of 30 present, late or absent')).toBeTruthy();
  expect(screen.getByText('34 recorded of 40 eligible')).toBeTruthy();
  expect(screen.getByText('Excused 4 · Unknown 2 · Missing 4. Missing and unknown are not counted as absent.')).toBeTruthy();
  expect(screen.getByText('4 completed events, 2 cancelled or postponed excluded, 1 awaiting completion.')).toBeTruthy();
  expect(screen.getByLabelText(/Presence rate 90%, 27 present or late of 30/)).toBeTruthy();
});

test('a zero denominator reads not enough data and a stale snapshot says to rebuild', async () => {
  list.mockResolvedValue({ items: [run({ stale: true, staleReason: 'attendanceCorrected', summary: counts({ presenceRate: { numerator: 0, denominator: 0, rate: null } }) })], nextCursor: null });
  await mount();
  await screen.findByText('Not enough data');
  expect(screen.getByRole('alert').props.children).toContain('Rebuild it');
  expect(screen.getByText(/Complete, stale/)).toBeTruthy();
});

test('requesting a summary polls a calculating run and shows rows only when complete', async () => {
  jest.useFakeTimers();
  try {
    list.mockResolvedValue({ items: [], nextCursor: null });
    request.mockResolvedValue({ runId: 'r2', state: 'queued' });
    read.mockResolvedValueOnce({ run: run({ runId: 'r2', state: 'building', summary: null }), rows: [], nextCursor: null })
      .mockResolvedValue({ run: run({ runId: 'r2' }), rows: [], nextCursor: null });
    await mount();
    await screen.findByText('No attendance summary yet. Create one for the last 30 days.');
    await fireEvent.press(screen.getByText('Update last 30 days'));
    await screen.findByText(/still calculating/);
    expect(screen.queryByText('90%')).toBeNull();
    const [orgId, scope, dates, requestId] = request.mock.calls[0];
    expect([orgId, scope, requestId]).toEqual(['o', { programId: 'p', seasonId: 's', teamId: 't' }, 'request-1']);
    expect(dates.fromDate <= dates.toDate).toBe(true);
    jest.advanceTimersByTime(2000);
    await screen.findByText('90%');
    expect(read).toHaveBeenLastCalledWith('o', 'r2');
  } finally {
    jest.useRealTimers();
  }
});

test('an uncertain failure retries with the same request ID', async () => {
  list.mockResolvedValue({ items: [], nextCursor: null });
  request.mockRejectedValueOnce({ code: 'functions/unavailable' }).mockResolvedValue({ runId: 'r3', state: 'complete' });
  read.mockResolvedValue({ run: run({ runId: 'r3' }), rows: [], nextCursor: null });
  await mount();
  await screen.findByText('Update last 30 days');
  await fireEvent.press(screen.getByText('Update last 30 days'));
  await screen.findByText('The summary could not be loaded. Try again.');
  await fireEvent.press(screen.getByText('Update last 30 days'));
  await screen.findByText('90%');
  expect(request.mock.calls.map(call => call[3])).toEqual(['request-1', 'request-1']);
});

test('explains denied and disabled reports without showing figures', async () => {
  list.mockRejectedValueOnce({ code: 'functions/permission-denied' });
  await mount();
  await screen.findByText('Team summaries are available to this team’s coaches.');
  list.mockRejectedValueOnce({ code: 'functions/failed-precondition', details: { domainCode: 'REPORTS_DISABLED' } });
  await mount();
  await screen.findByText('Reports are not enabled for this organization.');
  expect(screen.queryByText('Presence rate')).toBeNull();
});

const csvFile = { runId: 'r1', kind: 'attendance', exportVersion: 1, stale: false, mimeType: 'text/csv', fileName: 'r1.csv', csv: 'x', rowCount: 1 };

test('shares the complete snapshot as CSV, reports the closed sheet and clears temporary files', async () => {
  list.mockResolvedValue({ items: [run()], nextCursor: null });
  exportCsv.mockResolvedValue(csvFile);
  share.mockResolvedValue('closed');
  const view = await mount();
  await screen.findByText('90%');
  expect(screen.getByText(/aggregate counts only/)).toBeTruthy();
  await fireEvent.press(screen.getByText('Share CSV'));
  await screen.findByText('Share sheet closed. 1 team row; the temporary file was deleted.');
  expect(exportCsv).toHaveBeenCalledWith('o', 'r1');
  expect(share).toHaveBeenCalledWith(csvFile, 'Share attendance summary');
  await view.unmount();
  expect(clearReportExports).toHaveBeenCalledTimes(2);
});

test('sharing unavailable, export denial and calculating runs never open a share sheet', async () => {
  list.mockResolvedValue({ items: [run()], nextCursor: null });
  exportCsv.mockResolvedValueOnce({ ...csvFile, stale: true }).mockResolvedValueOnce(csvFile).mockRejectedValueOnce({ code: 'functions/permission-denied' });
  share.mockResolvedValueOnce('unavailable').mockRejectedValueOnce(new Error('write failed'));
  await mount();
  await screen.findByText('90%');
  await fireEvent.press(screen.getByText('Share CSV'));
  await screen.findByText('Sharing is not available on this device.');
  await fireEvent.press(screen.getByText('Share CSV'));
  await screen.findByText('The CSV could not be shared. Try again.');
  await fireEvent.press(screen.getByText('Share CSV'));
  await screen.findByText('Team summaries are available to this team’s coaches.');
  expect(share).toHaveBeenCalledTimes(2);
  list.mockResolvedValue({ items: [run({ state: 'building', summary: null })], nextCursor: null });
  await mount();
  await screen.findByText(/still calculating/);
  expect(screen.queryByText('Share CSV')).toBeNull();
});

test('an export response for a run that is no longer shown is dropped', async () => {
  list.mockResolvedValue({ items: [run()], nextCursor: null });
  let resolveExport: (value: unknown) => void = () => {};
  exportCsv.mockImplementation(() => new Promise(resolve => { resolveExport = resolve; }));
  request.mockResolvedValue({ runId: 'r2', state: 'complete' });
  read.mockResolvedValue({ run: run({ runId: 'r2' }), rows: [], nextCursor: null });
  await mount();
  await screen.findByText('90%');
  await fireEvent.press(screen.getByText('Share CSV'));
  await fireEvent.press(screen.getByText('Update last 30 days'));
  await screen.findByText('90%');
  expect(read).toHaveBeenLastCalledWith('o', 'r2');
  resolveExport(csvFile);
  await screen.findByText('Share CSV');
  expect(share).not.toHaveBeenCalled();
});
