import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventPlayTime from '../EventPlayTime';
import { finalizePlaySession, getPlaySession, recordPlayAction } from '../../firebase/playTime';
import type { PlaySession } from '../../../shared/playTime';

jest.mock('../../firebase/playTime', () => ({
  getPlaySession: jest.fn(),
  recordPlayAction: jest.fn(),
  finalizePlaySession: jest.fn(),
}));
const read = getPlaySession as jest.Mock;
const record = recordPlayAction as jest.Mock;
const finalize = finalizePlaySession as jest.Mock;

const roster = [
  { participantId: 'a', displayName: 'Avery Stone', available: true },
  { participantId: 'b', displayName: 'Blake Rivers', available: true },
  { participantId: 'c', displayName: 'Casey Moore', available: true },
];
const session = (patch: Partial<PlaySession> = {}): PlaySession => ({
  orgId: 'o', eventId: 'e', teamId: 't', revision: 3, lineupRevision: 2, sportPresetId: 'soccer',
  status: 'running', periodCount: 2, currentPeriod: 1, activeUnitId: 'starting',
  units: [{ unitId: 'starting', participantIds: ['a', 'b'] }], elapsedMs: 125_000, serverNow: '2026-12-20T23:05:00.000Z',
  totals: [{ participantId: 'a', displayName: 'Avery Stone', ms: 125_000 }, { participantId: 'b', displayName: 'Blake Rivers', ms: 60_000 }],
  roster, actions: [], finalizedAt: null, ...patch,
});
const open = async () => {
  await render(<EventPlayTime orgId="o" eventId="e" teamId="t" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Playing time' }));
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

test('coach chooses periods and starts the clock from the saved lineup', async () => {
  read.mockResolvedValueOnce(session({ status: 'notStarted', revision: 0, elapsedMs: 0, totals: [], units: [], periodCount: 0, currentPeriod: 0 }))
    .mockResolvedValueOnce(session({ elapsedMs: 0 }));
  record.mockResolvedValue({ requestId: 'r', revision: 1, state: 'running', sequence: 1 });
  await open();
  expect(await screen.findByText('Coaches only. Families cannot see individual playing time.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '3 periods' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Start game clock' }));
  await waitFor(() => expect(record).toHaveBeenCalledWith('o', 'e', 't', 0, { kind: 'start', periodCount: 3 }));
  expect(await screen.findByText('Clock started.')).toBeTruthy();
});

test('without a saved lineup the clock cannot start', async () => {
  read.mockResolvedValue(session({ status: 'notStarted', lineupRevision: 0, revision: 0, totals: [] }));
  await open();
  expect(await screen.findByText('Save a lineup before starting the clock.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start game clock' })).toBeNull();
  expect(screen.getByText('No playing time recorded yet.')).toBeTruthy();
});

test('the running clock renders from its anchor without writes, and on-field totals advance', async () => {
  jest.useFakeTimers({ now: new Date('2026-12-20T23:05:00Z') });
  read.mockResolvedValue(session());
  await open();
  expect(await screen.findByText('Clock running · Period 1 of 2 · 2:05')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(65_000); });
  expect(screen.getByText('Clock running · Period 1 of 2 · 3:10')).toBeTruthy();
  expect(screen.getByText('3:10')).toBeTruthy();
  expect(screen.getByText('2:05')).toBeTruthy();
  expect(record).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

test('tap who leaves then who enters records one substitution, then pause and end period', async () => {
  read.mockResolvedValue(session());
  record.mockResolvedValue({ requestId: 'r', revision: 4, state: 'running', sequence: 2 });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Sub out Blake Rivers' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Sub in Casey Moore for Blake Rivers' }));
  await waitFor(() => expect(record).toHaveBeenCalledWith('o', 'e', 't', 3, { kind: 'substitute', unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' }));
  expect(await screen.findByText('Casey Moore in for Blake Rivers.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Pause clock' }));
  await waitFor(() => expect(record).toHaveBeenLastCalledWith('o', 'e', 't', 3, { kind: 'pause' }));
  await fireEvent.press(screen.getByRole('button', { name: 'End period 1' }));
  await waitFor(() => expect(record).toHaveBeenLastCalledWith('o', 'e', 't', 3, { kind: 'endPeriod' }));
});

test('offline writes are not claimed as recorded and the last acknowledged clock is labeled stale', async () => {
  jest.useFakeTimers({ now: new Date('2026-12-20T23:05:00Z') });
  read.mockResolvedValueOnce(session()).mockResolvedValueOnce(session({ revision: 4 }));
  record.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'functions/unavailable' }));
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Pause clock' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Not recorded.*nothing was queued/);
  expect(screen.getByText(/Offline\. Showing the last acknowledged clock/)).toBeTruthy();
  expect(screen.queryByText('Clock paused.')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(30_000); });
  // The stale clock freezes rather than implying live acknowledgment.
  expect(screen.getByText('Clock running · Period 1 of 2 · 2:05')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Reload latest clock' }));
  await waitFor(() => expect(screen.queryByText(/Offline\./)).toBeNull());
});

test('a stale coach revision explains the conflict', async () => {
  read.mockResolvedValue(session({ status: 'paused' }));
  record.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'functions/aborted', details: { domainCode: 'STALE_REVISION' } }));
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Resume clock' }));
  expect(await screen.findByText('Another coach recorded an action first. Reload the latest clock, then try again.')).toBeTruthy();
});

test('corrections need a reason, show corrected history and name affected participants', async () => {
  const actions = [
    { sequence: 3, kind: 'correct' as const, period: 1, atElapsedMs: 600_000, targetSequence: 2, reason: 'Sheet', corrected: { atElapsedMs: 240_000, outParticipantId: 'b', inParticipantId: 'c' } },
    { sequence: 2, kind: 'substitute' as const, period: 1, atElapsedMs: 300_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' },
    { sequence: 1, kind: 'start' as const, period: 1, atElapsedMs: 0 },
  ];
  read.mockResolvedValue(session({ status: 'periodBreak', actions }));
  record.mockResolvedValue({ requestId: 'r', revision: 5, state: 'periodBreak', sequence: 4, affectedParticipantIds: ['a', 'b'] });
  await open();
  expect(await screen.findByText('P1 4:00 · Casey Moore in for Blake Rivers (corrected)')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Correct substitution at 4:00' }));
  const save = screen.getByRole('button', { name: 'Save correction' });
  expect(save).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText('Corrected game time'), '3:3');
  expect(screen.getByText('Enter the time as minutes:seconds.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Corrected game time'), '3:30');
  await fireEvent.press(screen.getByRole('button', { name: 'Entered: Avery Stone' }));
  await fireEvent.changeText(screen.getByLabelText('Correction reason'), ' Scorer sheet ');
  await fireEvent.press(screen.getByRole('button', { name: 'Save correction' }));
  await waitFor(() => expect(record).toHaveBeenCalledWith('o', 'e', 't', 3, {
    kind: 'correct', targetSequence: 2, atElapsedMs: 210_000, outParticipantId: 'b', inParticipantId: 'a', reason: 'Scorer sheet',
  }));
  expect(await screen.findByText('Correction recorded. Review playing time for Avery Stone, Blake Rivers.')).toBeTruthy();
});

test('football coaches switch the active unit, and an ended game finalizes once', async () => {
  read.mockResolvedValueOnce(session({
    sportPresetId: 'football', activeUnitId: 'offense',
    units: [{ unitId: 'offense', participantIds: ['a'] }, { unitId: 'defense', participantIds: ['a', 'b'] }, { unitId: 'specialTeams', participantIds: [] }],
  })).mockResolvedValue(session({ status: 'ended' }));
  record.mockResolvedValue({ requestId: 'r', revision: 4, state: 'running', sequence: 2 });
  finalize.mockResolvedValue({ requestId: 'r', revision: 5, state: 'finalized', sequence: 3 });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Offense active' }));
  expect(record).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Switch to Defense' }));
  await waitFor(() => expect(record).toHaveBeenCalledWith('o', 'e', 't', 3, { kind: 'switchUnit', unitId: 'defense' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Finalize playing time' }));
  await waitFor(() => expect(finalize).toHaveBeenCalledWith('o', 'e', 't', 3));
});

test('a finalized ledger is locked and a failed load can retry', async () => {
  read.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'functions/permission-denied' }))
    .mockResolvedValueOnce(session({ status: 'finalized', actions: [{ sequence: 2, kind: 'substitute', period: 1, atElapsedMs: 5_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' }] }));
  await open();
  expect(await screen.findByText('Coaching access changed or is unavailable for this team.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading playing time' }));
  expect(await screen.findByText('Final totals are locked.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Correct substitution/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Sub out/ })).toBeNull();
});
