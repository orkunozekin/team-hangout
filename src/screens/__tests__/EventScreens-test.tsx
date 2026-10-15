import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import CreateEditEventScreen from '../CreateEditEventScreen';
import EventDetailScreen from '../EventDetailScreen';
import { createCanonicalEvent, getEvent, listEventTeamChoices, mutateEventSchedule } from '../../firebase/events';
import { getTeam } from '../../firebase/teams';
jest.mock('../../firebase/events', () => ({ getEvent: jest.fn(), createCanonicalEvent: jest.fn(), mutateEventSchedule: jest.fn(), listEventTeamChoices: jest.fn() }));
jest.mock('../../firebase/teams', () => ({ getTeam: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
const membership = { teamId: 'a', userId: 'staff', role: 'coach' } as any;
const navigation = { goBack: jest.fn(), navigate: jest.fn() } as any;
const event = { id: 'shared', schemaVersion: 2, revision: 4, title: 'Falcons vs Comets', type: 'match', date: new Date('2026-10-20T12:00:00Z'), time: '18:00', startsAt: '2026-10-20T23:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z', timeZone: 'America/Chicago', status: 'scheduled', scheduleVersion: 2, canManage: true, teams: [{ id: 'a', name: 'Falcons' }, { id: 'b', name: 'Comets' }], location: null, notes: null };
beforeEach(() => {
  jest.clearAllMocks();
  (getTeam as jest.Mock).mockResolvedValue({ schemaVersion: 2, timeZone: 'America/Phoenix' });
  (listEventTeamChoices as jest.Mock).mockResolvedValue({ items: event.teams, nextCursor: null });
  (getEvent as jest.Mock).mockResolvedValue(event);
  (mutateEventSchedule as jest.Mock).mockResolvedValue({});
});
test('shared-match creation offers authorized opponents and sends the displayed local interval', async () => {
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: {} } as any} />);
  await screen.findByText('Event time zone: America/Phoenix');
  expect(listEventTeamChoices).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Match'));
  await fireEvent.press(screen.getByText('Load opponent teams'));
  await screen.findByText('Comets');
  await fireEvent.press(screen.getByText('Comets'));
  await fireEvent.changeText(screen.getByLabelText('Event date'), '2026-10-20');
  await fireEvent.changeText(screen.getByLabelText('Local time'), '18:00');
  await fireEvent.press(screen.getByText('Change time zone'));
  await fireEvent.press(screen.getByRole('button', { name: /America\/Chicago/ }));
  await fireEvent.changeText(screen.getByPlaceholderText('Evening practice'), 'Falcons vs Comets');
  await fireEvent.press(screen.getByText('Create event'));
  expect(createCanonicalEvent).toHaveBeenCalledWith('a', expect.objectContaining({ teamIds: ['a', 'b'], startsAt: '2026-10-20T23:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' }));
});
test('stale saves preserve form inputs and explicitly reload before another revision is submitted', async () => {
  (mutateEventSchedule as jest.Mock).mockRejectedValueOnce(new Error('This record changed. Reload before saving.'));
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByDisplayValue(event.title);
  await fireEvent.changeText(screen.getByPlaceholderText('Evening practice'), 'Corrected title');
  await fireEvent.changeText(screen.getByLabelText('Reason for change'), 'Correcting title');
  await fireEvent.press(screen.getByText('Save changes'));
  await screen.findByText('This record changed. Reload before saving.');
  expect(screen.getByDisplayValue('Corrected title')).toBeTruthy();
  expect(navigation.goBack).not.toHaveBeenCalled();
  expect(mutateEventSchedule).toHaveBeenCalledWith('shared', 4, 'edit', expect.objectContaining({ title: 'Corrected title' }), 'Correcting title');
  (getEvent as jest.Mock).mockResolvedValue({ ...event, revision: 5, title: 'Other coach title' });
  await fireEvent.press(screen.getByText('Reload event'));
  await screen.findByDisplayValue('Other coach title');
  await fireEvent.press(screen.getByText('Save changes'));
  expect(mutateEventSchedule).toHaveBeenLastCalledWith('shared', 5, 'edit', expect.objectContaining({ title: 'Other coach title' }), 'Correcting title');
});
test('postponed event preserves its previous time and history, while management follows server authority', async () => {
  (getEvent as jest.Mock).mockResolvedValue({ ...event, status: 'postponed', canManage: false, history: [{ revision: 4, action: 'postpone', reason: 'Field closed', previousStatus: 'scheduled', status: 'postponed' }] });
  await render(<EventDetailScreen membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Awaiting a new schedule. The previous time is shown below.');
  expect(screen.getByText(/Field closed/)).toBeTruthy();
  expect(screen.queryByText('Edit event')).toBeNull();
  expect(screen.queryByText('Delete event')).toBeNull();
});
test('reschedule edits local date/time independently from other details', async () => {
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared', action: 'reschedule' } } as any} />);
  await screen.findByDisplayValue('2026-10-20');
  expect(screen.queryByPlaceholderText('Evening practice')).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('Event date'), '2026-10-21');
  await fireEvent.changeText(screen.getByLabelText('Reason for change'), 'Makeup');
  await fireEvent.press(screen.getByText('Save changes'));
  expect(mutateEventSchedule).toHaveBeenCalledWith('shared', 4, 'reschedule', { startsAt: '2026-10-21T23:00:00.000Z', endsAt: '2026-10-22T00:00:00.000Z', timeZone: 'America/Chicago' }, 'Makeup');
});

test('new events default to the canonical organization zone even when absent from the preset list', async () => {
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: {} } as any} />);
  await screen.findByText('Event time zone: America/Phoenix');
  await fireEvent.changeText(screen.getByLabelText('Event date'), '2026-10-20');
  await fireEvent.changeText(screen.getByLabelText('Local time'), '18:00');
  await fireEvent.changeText(screen.getByPlaceholderText('Evening practice'), 'Organization time');
  await fireEvent.press(screen.getByText('Change time zone'));
  expect(screen.getByRole('button', { name: /America\/Phoenix/ })).toBeTruthy();
  await fireEvent.press(screen.getByText('Create event'));
  expect(createCanonicalEvent).toHaveBeenCalledWith('a', expect.objectContaining({ timeZone: 'America/Phoenix', startsAt: '2026-10-21T01:00:00.000Z' }));
});
test('a canonical team without a confirmed organization timezone cannot publish with a guessed device zone', async () => {
  (getTeam as jest.Mock).mockResolvedValue({ schemaVersion: 2 });
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: {} } as any} />);
  await screen.findByText('Organization time zone is unavailable. Reload before creating an event.');
  expect(screen.getByRole('button', { name: 'Create event' })).toBeDisabled();
  expect(createCanonicalEvent).not.toHaveBeenCalled();
});


test('opponent discovery loads one page per request and preserves choices after an error', async () => {
  (listEventTeamChoices as jest.Mock).mockResolvedValueOnce({ items: [{ id: 'b', name: 'Comets' }], nextCursor: 'b' })
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce({ items: [{ id: 'c', name: 'Wolves' }], nextCursor: null });
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: {} } as any} />);
  await screen.findByText('Event time zone: America/Phoenix');
  expect(listEventTeamChoices).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Match'));
  await fireEvent.press(screen.getByText('Load opponent teams'));
  await screen.findByText('Comets');
  expect(listEventTeamChoices).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Load more opponent teams'));
  await screen.findByText('Unable to load opponent teams. Please try again.');
  expect(screen.getByText('Comets')).toBeTruthy();
  await fireEvent.press(screen.getByText('Load more opponent teams'));
  await screen.findByText('Wolves');
  expect(listEventTeamChoices).toHaveBeenNthCalledWith(3, 'a', 'b');
  expect(screen.queryByText('Load more opponent teams')).toBeNull();
});
