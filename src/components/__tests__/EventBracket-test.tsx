import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import EventBracket from '../EventBracket';
import { getEventBracket } from '../../firebase/competition';
import type { BracketNodeView, BracketView, EventBracket as Data } from '../../../shared/competition';

jest.mock('../../firebase/competition', () => ({ getEventBracket: jest.fn() }));
const read = getEventBracket as jest.Mock;

const team = (teamId: string, name: string, seed: number | null) => ({ teamId, name, seed });
const node = (patch: Partial<BracketNodeView> & Pick<BracketNodeView, 'nodeId' | 'round' | 'state'>): BracketNodeView => ({
  index: 0, bye: false, teams: [null, null], eventId: null, eventStartsAt: null, winnerPending: false, winnerTeamId: null, voidedPlays: [], ...patch,
});
const view = (nodes: BracketNodeView[]): BracketView => ({
  competitionId: 'cup', name: 'Spring Cup', format: 'knockout', bracketRevision: 3, nodes,
  bracket: { bracketId: 'b1', size: 4, rounds: 2, teamCount: 3, source: null, override: { reason: 'Drawn at meeting' }, publishedAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-02T00:00:00.000Z' },
});
const data = (bracket: BracketView | null, patch: Partial<Data> = {}): Data => ({
  orgId: 'o', eventId: 'e', teamId: 'hawks', competitions: bracket ? [{ competitionId: 'cup', name: 'Spring Cup' }] : [], bracket, ...patch,
});
const open = async () => {
  await render(<EventBracket eventId="e" teamId="hawks" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Bracket' }));
};

beforeEach(() => jest.clearAllMocks());

test('a bye shows no game, an unresolved winner waits, and a voided play explains the replay', async () => {
  read.mockResolvedValue(data(view([
    node({ nodeId: 'r1-01', round: 1, state: 'bye', bye: true, teams: [team('foxes', 'Foxes', 1), null], winnerTeamId: 'foxes' }),
    node({ nodeId: 'r1-02', round: 1, index: 1, state: 'scheduled', teams: [team('hawks', 'Hawks', 2), team('owls', 'Owls', 3)], eventId: 'm1', eventStartsAt: '2026-04-05T15:00:00.000Z', winnerPending: true }),
    node({ nodeId: 'r2-01', round: 2, state: 'waiting', teams: [team('foxes', 'Foxes', 1), null], voidedPlays: [{ eventId: 'm0', winnerTeamId: 'owls', voidedAt: '2026-04-06T00:00:00.000Z' }] }),
  ])));
  await open();
  expect(await screen.findByText('Spring Cup')).toBeTruthy();
  expect(screen.getByText('Semifinals')).toBeTruthy();
  expect(screen.getByText('Final')).toBeTruthy();
  expect(screen.getByText('Foxes advances on a bye. No game is played.')).toBeTruthy();
  expect(screen.getByText('Bye')).toBeTruthy();
  expect(screen.getByText('(2) Hawks (your team)')).toBeTruthy();
  expect(screen.getByText('Winner unresolved. Waiting for a final result.')).toBeTruthy();
  expect(screen.getByText(/^Waiting for earlier winners\. A played match was invalidated by a reviewed correction/)).toBeTruthy();
  expect(screen.getByLabelText('(2) Hawks (your team) versus (3) Owls. Winner unresolved. Waiting for a final result.')).toBeTruthy();
  expect(read).toHaveBeenCalledWith('e', 'hawks', undefined);
});

test('no published bracket, a slow earlier competition response is ignored, and an error keeps the last bracket', async () => {
  read.mockResolvedValueOnce(data(null));
  await open();
  expect(await screen.findByText('This team is not in a published bracket.')).toBeTruthy();
  const decided = view([node({ nodeId: 'r1-01', round: 1, state: 'decided', teams: [team('hawks', 'Hawks', 1), team('owls', 'Owls', 2)], winnerTeamId: 'hawks' })]);
  const competitions = [{ competitionId: 'cup', name: 'Spring Cup' }, { competitionId: 'plate', name: 'Plate' }];
  read.mockResolvedValueOnce(data(decided, { competitions }));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh bracket' }));
  expect(await screen.findByText('Hawks advanced.')).toBeTruthy();
  let resolveSlow: (value: Data) => void = () => {};
  read.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; })).mockResolvedValueOnce(data(decided, { competitions }));
  await fireEvent.press(screen.getByRole('button', { name: 'Show Plate' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Show Spring Cup' }));
  expect(await screen.findByText('Hawks advanced.')).toBeTruthy();
  resolveSlow(data({ ...view([]), competitionId: 'plate', name: 'Plate' }, { competitions }));
  await Promise.resolve();
  expect(screen.getByText('Hawks advanced.')).toBeTruthy();
  read.mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh bracket' }));
  expect(await screen.findByText('The bracket could not be loaded. Showing the last loaded bracket.')).toBeTruthy();
  expect(screen.getByText('Hawks advanced.')).toBeTruthy();
});
