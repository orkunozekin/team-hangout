import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import EventStandings from '../EventStandings';
import { getEventStandings } from '../../firebase/competition';
import type { EventStandings as Data, StandingsRow, StandingsView } from '../../../shared/competition';

jest.mock('../../firebase/competition', () => ({ getEventStandings: jest.fn() }));
const read = getEventStandings as jest.Mock;

const row = (teamId: string, teamName: string, rank: number, position: number, patch: Partial<StandingsRow> = {}): StandingsRow => ({
  position, rank, teamId, teamName, played: 3, wins: 1, draws: 1, losses: 1, forfeitWins: 0, forfeitLosses: 0,
  scoresFor: 4, scoresAgainst: 2, differential: 2, points: 4, sharedRank: false, tiedWith: [], decidedBy: 'tablePoints', notApplicable: [], ...patch,
});
const tie = { sharedRank: true, tiedWith: ['foxes', 'hawks'], decidedBy: null, notApplicable: ['headToHeadPoints' as const] };
const view = (patch: Partial<StandingsView> = {}): StandingsView => ({
  competitionId: 'league', name: 'Spring League', format: 'league', status: 'current', sourceRevision: 5, sourceUpdatedAt: '2026-04-12T15:00:00.000Z',
  generation: { generationId: 'g1', active: true, sourceRevision: 5, rulesVersion: 1, completedAt: '2026-04-12T15:00:05.000Z', sourceUpdatedAt: null, rowCount: 3, countedResults: 5, unresolvedTies: 1, reducerVersion: 1 },
  rows: [row('foxes', 'Foxes', 1, 1, tie), row('hawks', 'Hawks', 1, 2, tie), row('owls', 'Owls', 3, 3, { points: 1, forfeitLosses: 1 })],
  nextCursor: null, ...patch,
});
const data = (standings: StandingsView | null = view(), patch: Partial<Data> = {}): Data => ({
  orgId: 'o', eventId: 'e', teamId: 'hawks', competitions: standings ? [{ competitionId: 'league', name: 'Spring League', status: standings.status }] : [], standings, ...patch,
});
const open = async () => {
  await render(<EventStandings eventId="e" teamId="hawks" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Standings' }));
};

beforeEach(() => jest.clearAllMocks());

test('a completed table keeps a shared rank visible and never presents list order as a ranking', async () => {
  read.mockResolvedValue(data());
  await open();
  expect(await screen.findByText('Spring League')).toBeTruthy();
  expect(screen.getAllByText('T-1')).toHaveLength(2);
  expect(screen.getByText('Hawks (your team)')).toBeTruthy();
  expect(screen.getByText('Tied with Foxes; all tie-breakers exhausted. Head-to-head points (whole tied group) not applicable')).toBeTruthy();
  expect(screen.getByText('Forfeits: 0 won, 1 lost')).toBeTruthy();
  expect(screen.getByText('Up to date')).toBeTruthy();
  expect(screen.getByLabelText(/^Rank 1, shared\. Hawks, your team\. 4 points/)).toBeTruthy();
  expect(read).toHaveBeenCalledWith('e', 'hawks', {});
});

test('updating and stale states show the last complete table with the source time', async () => {
  read.mockResolvedValueOnce(data(view({ status: 'updating' }))).mockResolvedValueOnce(data(view({ status: 'stale' })));
  await open();
  expect(await screen.findByText(/^Updating\. Showing the last complete table\. Latest result change/)).toBeTruthy();
  expect(screen.getAllByText('T-1')).toHaveLength(2);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh standings' }));
  expect(await screen.findByText(/^Update delayed\./)).toBeTruthy();
  expect(read).toHaveBeenLastCalledWith('e', 'hawks', { competitionId: 'league' });
});

test('paging stays pinned to one generation and restarts from the top when the table changed', async () => {
  read.mockResolvedValueOnce(data(view({ nextCursor: '0002', rows: view().rows.slice(0, 2) })))
    .mockResolvedValueOnce(data(view({ rows: view().rows.slice(2) })));
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Show more teams' }));
  expect(read).toHaveBeenLastCalledWith('e', 'hawks', { competitionId: 'league', generationId: 'g1', cursor: '0002' });
  expect(await screen.findByText('Owls')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show more teams' })).toBeNull();

  read.mockReset();
  read.mockResolvedValueOnce(data(view({ nextCursor: '0002', rows: view().rows.slice(0, 2) })))
    .mockRejectedValueOnce({ details: { domainCode: 'STANDINGS_CHANGED' } })
    .mockResolvedValueOnce(data(view({ generation: { ...view().generation!, generationId: 'g2' } })));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh standings' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Show more teams' }));
  expect(await screen.findByText('Standings were updated. Showing the latest table from the top.')).toBeTruthy();
  expect(screen.getAllByText('Owls')).toHaveLength(1);
});

test('empty, unconfirmed and failed loads explain the state without inventing a table', async () => {
  read.mockResolvedValueOnce(data(null)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(data(view({ status: 'unconfirmed', generation: null, rows: [] })));
  const first = await render(<EventStandings eventId="e" teamId="hawks" initiallyOpen />);
  expect(await screen.findByText('This team is not in a competition with published standings.')).toBeTruthy();
  await first.unmount();
  await render(<EventStandings eventId="e" teamId="hawks" initiallyOpen />);
  expect(await screen.findByText('Standings could not be loaded.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading standings' }));
  expect(await screen.findByText('Standings appear after league rules are confirmed.')).toBeTruthy();
  expect(screen.queryByText('No complete table yet.')).toBeNull();
});
