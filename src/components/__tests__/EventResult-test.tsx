import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventResult from '../EventResult';
import { getEventResults, proposeResult } from '../../firebase/competition';
import type { EventResults } from '../../../shared/competition';

jest.mock('../../firebase/competition', () => ({ getEventResults: jest.fn(), proposeResult: jest.fn() }));
jest.mock('../../firebase/lineups', () => ({ lineupRequestId: jest.fn(() => 'req-1') }));
const read = getEventResults as jest.Mock;
const propose = proposeResult as jest.Mock;

const competition = (patch: Partial<EventResults['competitions'][number]> = {}): EventResults['competitions'][number] => ({
  competitionId: 'cup', name: 'Spring Cup', format: 'knockout', rules: { version: 2, allowDraws: false, knockoutDeciders: ['penalties'] }, result: null, ...patch,
});
const results = (competitions = [competition()], patch: Partial<EventResults> = {}): EventResults => ({
  orgId: 'o', eventId: 'e', teamId: 'home', externalOpponent: false, homeTeamId: 'home', awayTeamId: 'away',
  teams: [{ teamId: 'home', name: 'Hawks' }, { teamId: 'away', name: 'Owls' }], competitions, ...patch,
});
const open = async () => {
  await render(<EventResult eventId="e" teamId="home" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Match result' }));
};
const played = { outcome: 'played', forfeitingTeamId: null } as const;

beforeEach(() => jest.clearAllMocks());

test('a knockout tie needs a permitted winner and decider before the coach can propose', async () => {
  read.mockResolvedValueOnce(results()).mockResolvedValueOnce(results([competition({
    result: { eventId: 'e', status: 'proposed', revision: 1, homeTeamId: 'home', awayTeamId: 'away', final: null, updatedAt: null,
      proposal: { ...played, homeScore: 1, awayScore: 1, winnerTeamId: 'away', decider: 'penalties', proposedBy: 'u', proposedTeamId: 'home', proposedAt: '' } },
  })]));
  propose.mockResolvedValue({ requestId: 'req-1', revision: 1, state: 'proposed', operationId: 'op' });
  await open();
  expect(await screen.findByText('No result proposed yet.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Hawks score'), '1');
  await fireEvent.changeText(screen.getByLabelText('Owls score'), '1');
  expect(screen.getByText('A knockout match cannot end in a draw. Choose the winner and how it was decided.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Decided by Shootout' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Winner Owls' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Decided by Penalties' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Propose result' }));
  await waitFor(() => expect(propose).toHaveBeenCalledWith('o', 'cup', 'e', 'home', 0,
    { ...played, homeScore: 1, awayScore: 1, winnerTeamId: 'away', decider: 'penalties' }, 'req-1'));
  expect(await screen.findByText('Pending proposal: 1-1, Owls won on penalties. Waiting for a scorer to finalize.')).toBeTruthy();
});

test('final results are read-only for coaches and show corrections', async () => {
  read.mockResolvedValue(results([competition({
    format: 'league',
    result: { eventId: 'e', status: 'final', revision: 3, homeTeamId: 'home', awayTeamId: 'away', proposal: null, updatedAt: null,
      final: { ...played, homeScore: 2, awayScore: 0, winnerTeamId: 'home', decider: null, appliedRulesVersion: 2, finalizedBy: 's', finalizedAt: '', correctedAt: '2026-01-01', correctionReason: 'Sheet' } },
  })]));
  await open();
  expect(await screen.findByText('Final: 2-0')).toBeTruthy();
  expect(screen.getByText('Corrected by a scorer.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Propose result' })).toBeNull();
});

test('forfeit, void, external opponent and unconfirmed rules states', async () => {
  read.mockResolvedValueOnce(results([competition({ format: 'league', rules: null })]));
  propose.mockRejectedValueOnce({ code: 'functions/unavailable' }).mockRejectedValueOnce({ details: { domainCode: 'STALE_REVISION' } });
  await open();
  expect(await screen.findByText('League · Rules not confirmed yet')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Outcome Forfeit' }));
  expect(screen.getByText('Choose the team that forfeited.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Forfeited Owls' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Propose result' }));
  expect(await screen.findByText(/Connection lost/)).toBeTruthy();
  // An uncertain write retries with the same request ID.
  await fireEvent.press(screen.getByRole('button', { name: 'Retry same proposal' }));
  await waitFor(() => expect(propose).toHaveBeenCalledTimes(2));
  expect(propose.mock.calls[1][6]).toBe('req-1');
  expect(await screen.findByText('Someone else updated this result. Reload, then propose again.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Outcome Void' }));
  expect(screen.getByText('A void result counts for nothing. Use it for cancelled or abandoned matches.')).toBeTruthy();

  read.mockResolvedValueOnce(results([], { externalOpponent: true }));
  await render(<EventResult eventId="x" teamId="home" initiallyOpen />);
  expect(await screen.findByText('This game has an external opponent, so it is not part of a league competition.')).toBeTruthy();
});

test('load failure offers retry', async () => {
  read.mockRejectedValueOnce({ code: 'functions/permission-denied' }).mockResolvedValueOnce(results([]));
  await open();
  expect(await screen.findByText('Coaching access changed or is unavailable for this team.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading results' }));
  expect(await screen.findByText('This match is not part of a competition.')).toBeTruthy();
});
