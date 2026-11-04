import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventLineup from '../EventLineup';
import { getLineup, getLineupView, publishLineup, saveLineup } from '../../firebase/lineups';
import type { PrivateLineup } from '../../../shared/lineups';

let mockSeq = 0;
jest.mock('../../firebase/lineups', () => ({
  getLineup: jest.fn(),
  getLineupView: jest.fn(),
  saveLineup: jest.fn(),
  publishLineup: jest.fn(),
  lineupRequestId: () => `request-${++mockSeq}`,
}));
const read = getLineup as jest.Mock;
const view = getLineupView as jest.Mock;
const save = saveLineup as jest.Mock;
const publish = publishLineup as jest.Mock;

const roster = [
  { participantId: 'a', displayName: 'Avery Stone', available: true },
  { participantId: 'b', displayName: 'Blake Rivers', available: true },
  { participantId: 'c', displayName: 'Casey Moore', available: true },
];
const lineup = (patch: Partial<PrivateLineup> = {}): PrivateLineup => ({
  orgId: 'o', eventId: 'e', teamId: 't', revision: 2, sportPresetId: 'soccer', presetVersion: 1,
  units: [{ unitId: 'starting', slots: [{ slotId: 'gk', participantId: 'a', x: 0.5, y: 0.91 }] }],
  bench: ['c'], note: 'Synthetic private note', roster, unavailableParticipantIds: [], updatedAt: null,
  publication: { state: 'private', sourceRevision: null, publishedAt: null },
  ...patch,
});
const open = async (props: Partial<React.ComponentProps<typeof EventLineup>> = {}) =>
  await render(<EventLineup orgId="o" eventId="e" teamId="t" canCoach {...props} />);

beforeEach(() => {
  mockSeq = 0;
  jest.clearAllMocks();
});

test('coach places a participant, keeps explicit bench order and saves privately', async () => {
  read.mockResolvedValueOnce(lineup()).mockResolvedValueOnce(lineup({ revision: 3 }));
  save.mockResolvedValue({ requestId: 'request-1', revision: 3, state: 'private' });
  await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Team lineup' }));
  expect(await screen.findByText('Private. Families cannot see this lineup.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Goalkeeper: Avery Stone' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Blake Rivers' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Add Blake Rivers to bench' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Move Blake Rivers up' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save lineup' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith('o', 'e', 2, {
    teamId: 't', sportPresetId: 'soccer',
    units: [{ unitId: 'starting', slots: [{ slotId: 'gk', participantId: 'a', x: 0.5, y: 0.91 }] }],
    bench: ['b', 'c'], note: 'Synthetic private note',
  }, 'request-1');
  expect(await screen.findByText('Lineup saved privately.')).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
});

test('offline save keeps the draft and retries with the same request ID', async () => {
  read.mockResolvedValue(lineup());
  save.mockRejectedValueOnce({ code: 'functions/unavailable' }).mockRejectedValueOnce({ code: 'functions/unavailable' });
  await open({ initiallyOpen: true });
  await fireEvent.press(await screen.findByRole('button', { name: 'Blake Rivers' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Striker: open' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save lineup' }));
  expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Striker: Blake Rivers' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][4]).toBe(save.mock.calls[0][4]);
});

test('a conflicting save offers reload of the latest lineup', async () => {
  read.mockResolvedValueOnce(lineup()).mockResolvedValueOnce(lineup({ revision: 5, bench: ['b'] }));
  save.mockRejectedValue({ code: 'functions/aborted', details: { domainCode: 'STALE_REVISION', currentRevision: 5 } });
  await open({ initiallyOpen: true });
  await fireEvent.changeText(await screen.findByLabelText('Private coach note'), 'Changed');
  await fireEvent.press(screen.getByRole('button', { name: 'Save lineup' }));
  expect(await screen.findByText(/Another coach saved this lineup first/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Publish to families' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Reload latest lineup' }));
  expect(await screen.findByText('1. Blake Rivers')).toBeTruthy();
  expect(screen.queryByText(/Another coach/)).toBeNull();
});

test('a roster departure is flagged for replacement and never silently replaced', async () => {
  read.mockResolvedValue(lineup({
    roster: [...roster, { participantId: 'x', displayName: 'Former Player', available: false }],
    units: [{ unitId: 'starting', slots: [{ slotId: 'gk', participantId: 'x', x: 0.5, y: 0.91 }] }],
    unavailableParticipantIds: ['x'],
  }));
  await open({ initiallyOpen: true });
  expect(await screen.findByRole('button', { name: 'Goalkeeper: Former Player, left the roster. Replace before saving' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Former Player' })).toBeNull();
});

test('an empty roster explains why no lineup can be built', async () => {
  read.mockResolvedValue(lineup({ revision: 0, sportPresetId: null, units: [], bench: [], note: '', roster: [] }));
  await open({ initiallyOpen: true });
  expect(await screen.findByText(/No active roster participants yet/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save lineup' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Publish to families' })).toBeNull();
});

test('publication is explicit, stale publications prompt republish, and retraction is offered', async () => {
  read.mockResolvedValueOnce(lineup()).mockResolvedValueOnce(lineup({
    revision: 4, publication: { state: 'published', sourceRevision: 3, publishedAt: '2026-10-29T00:00:00.000Z' },
  }));
  publish.mockResolvedValue({ requestId: 'request-1', revision: 3, state: 'published' });
  await open({ initiallyOpen: true });
  await fireEvent.press(await screen.findByRole('button', { name: 'Publish to families' }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith('o', 'e', 't', 2, 'publish', 'request-1'));
  expect(await screen.findByText(/Published view is older than your saved lineup/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retract publication' })).toBeTruthy();
});

test('families see only the published positions and bench order', async () => {
  view.mockResolvedValue({
    state: 'published', sportPresetId: 'soccer', presetVersion: 1, publicationRevision: 1, publishedAt: '2026-10-29T00:00:00.000Z',
    units: [{ unitId: 'starting', slots: [{ slotId: 'gk', participantId: 'a', displayName: 'Avery Stone', x: 0.5, y: 0.91 }] }],
    bench: [{ participantId: 'c', displayName: 'Casey Moore' }],
  });
  await open({ canCoach: false, participantId: 'a', initiallyOpen: true });
  expect(await screen.findByText('Goalkeeper: Avery Stone')).toBeTruthy();
  expect(screen.getByText('1. Casey Moore')).toBeTruthy();
  expect(view).toHaveBeenCalledWith('e', 't', 'a');
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByText(/private note/i)).toBeNull();
  expect(screen.queryByLabelText('Private coach note')).toBeNull();
});

test('unpublished lineups stay hidden and a denied coach falls back to the family view', async () => {
  read.mockRejectedValue({ code: 'functions/permission-denied' });
  view.mockResolvedValue({ state: 'unpublished' });
  await open({ initiallyOpen: true });
  expect(await screen.findByText('The coach has not published a lineup for this event.')).toBeTruthy();
  expect(view).toHaveBeenCalledWith('e', 't', undefined);
});

test('an offline family view explains the outage without draft language', async () => {
  view.mockRejectedValue({ code: 'functions/unavailable' });
  await open({ canCoach: false, initiallyOpen: true });
  expect(await screen.findByText('Lineup unavailable while offline. Reconnect and reopen the lineup.')).toBeTruthy();
});

test('football units are independent: one participant can hold offense and defense positions', async () => {
  read.mockResolvedValue(lineup({ sportPresetId: 'football', units: [], bench: [] }));
  save.mockResolvedValue({ requestId: 'request-1', revision: 3, state: 'private' });
  await open({ initiallyOpen: true });
  await fireEvent.press(await screen.findByRole('button', { name: 'Avery Stone' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Quarterback: open' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Defense' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Avery Stone' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Middle linebacker: open' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save lineup' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][3].units.map((u: { slots: { participantId: string }[] }) => u.slots.map((s) => s.participantId)))
    .toEqual([['a'], ['a'], []]);
});

test('an acknowledged publication stays visible when the refresh fails, with a reload path', async () => {
  read.mockResolvedValueOnce(lineup()).mockRejectedValueOnce({ code: 'functions/unavailable' });
  publish.mockResolvedValue({ requestId: 'request-1', revision: 3, state: 'published' });
  await open({ initiallyOpen: true });
  await fireEvent.press(await screen.findByRole('button', { name: 'Publish to families' }));
  expect(await screen.findByText('Published. Families see positions and bench order, never notes.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retract publication' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload latest lineup' })).toBeTruthy();
});

test('edits are frozen while a save is in flight so the refresh cannot discard them', async () => {
  let finish: (value: unknown) => void = () => {};
  read.mockResolvedValue(lineup());
  save.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await open({ initiallyOpen: true });
  await fireEvent.changeText(await screen.findByLabelText('Private coach note'), 'First edit');
  await fireEvent.press(screen.getByRole('button', { name: 'Save lineup' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Clear Goalkeeper' }));
  expect(screen.getByRole('button', { name: 'Goalkeeper: Avery Stone' })).toBeTruthy();
  expect(screen.getByLabelText('Private coach note').props.editable).toBe(false);
  finish({ requestId: 'request-1', revision: 3, state: 'private' });
  expect(await screen.findByText('Lineup saved privately.')).toBeTruthy();
});

test('a text size change remounts the lineup text but keeps the open panel and unsaved draft', async () => {
  const dimensions = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  const metrics = { width: 390, height: 844, scale: 3, fontScale: 1 };
  const spy = jest.spyOn(dimensions, 'default').mockImplementation(() => metrics);
  read.mockResolvedValue(lineup());
  const { rerender } = await open();
  await fireEvent.press(screen.getByRole('button', { name: 'Team lineup' }));
  await screen.findByText('Private. Families cannot see this lineup.');
  await fireEvent.press(screen.getByRole('button', { name: 'Blake Rivers' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Add Blake Rivers to bench' }));
  await fireEvent.changeText(screen.getByLabelText('Private coach note'), 'Edited before resize');
  const headingBefore = screen.getByText('Private lineup');
  metrics.fontScale = 2;
  await rerender(<EventLineup orgId="o" eventId="e" teamId="t" canCoach />);
  const headingAfter = screen.getByText('Private lineup');
  expect(headingAfter).not.toBe(headingBefore);
  expect(screen.getByLabelText('Private coach note').props.value).toBe('Edited before resize');
  expect(screen.getByRole('button', { name: 'Move Blake Rivers up' })).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
