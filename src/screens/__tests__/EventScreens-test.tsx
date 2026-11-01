jest.mock("../../firebase/checkIn", () => ({ getParticipantCheckIn: jest.fn(), checkInParticipant: jest.fn(), setEventCheckInPolicy: jest.fn() }));
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import CreateEditEventScreen from '../CreateEditEventScreen';
import EventDetailScreen from '../EventDetailScreen';
import { createCanonicalEvent, getEvent, listEventTeamChoices, mutateEventSchedule } from '../../firebase/events';
import { getTeam } from '../../firebase/teams';
import { clearGameDayCache, loadCachedEvent, saveCachedEvent } from '../../lib/gameDayCache';
jest.mock('../../firebase/events', () => ({ getEvent: jest.fn(), createCanonicalEvent: jest.fn(), mutateEventSchedule: jest.fn(), listEventTeamChoices: jest.fn() }));
jest.mock('../../firebase/availability', () => ({ getEventAvailability: jest.fn().mockRejectedValue(new Error('Unavailable')) }));
jest.mock('../../firebase/attendance', () => ({ getEventAttendance: jest.fn().mockRejectedValue(new Error('Unavailable')) }));
jest.mock('../../firebase/lineups', () => ({ getLineup: jest.fn().mockResolvedValue({ orgId: 'org', eventId: 'event', teamId: 'team', revision: 0, sportPresetId: null, presetVersion: null, units: [], bench: [], note: '', roster: [], unavailableParticipantIds: [], publication: { state: 'private', sourceRevision: null, publishedAt: null }, updatedAt: null }), getLineupView: jest.fn(), saveLineup: jest.fn(), publishLineup: jest.fn(), lineupRequestId: () => 'id' }));
jest.mock('../../firebase/playTime', () => ({ getPlaySession: jest.fn(), recordPlayAction: jest.fn(), finalizePlaySession: jest.fn() }));
jest.mock('../../firebase/competition', () => ({ getEventResults: jest.fn(), proposeResult: jest.fn(), getEventStandings: jest.fn(), getEventBracket: jest.fn() }));
jest.mock('../../firebase/volunteers', () => ({ getEventVolunteers: jest.fn(), claimVolunteerSlot: jest.fn(), releaseVolunteerSlot: jest.fn(), saveVolunteerSlot: jest.fn(), volunteerRequestId: () => 'id' }));
jest.mock('../../firebase/practice', () => ({ getEventPracticePlan: jest.fn(), listTeamPracticeResources: jest.fn(), savePracticePlan: jest.fn(), practiceRequestId: () => 'id' }));
jest.mock('../../firebase/rides', () => ({ getEventRides: jest.fn(), getRideContacts: jest.fn(), saveRideRequest: jest.fn(), confirmRideArrangement: jest.fn(), revokeRideConsent: jest.fn(), rideRequestId: () => 'id' }));
jest.mock('../../firebase/teams', () => ({ getTeam: jest.fn() }));
jest.mock('../../lib/gameDayCache', () => ({
  loadCachedEvent: jest.fn(), saveCachedEvent: jest.fn(), clearGameDayCache: jest.fn(),
  isGameDayCacheAccessLoss: (error: { code?: string }) =>
    ['permission-denied', 'functions/permission-denied', 'unauthenticated', 'functions/unauthenticated'].includes(error?.code ?? ''),
}));
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
  (loadCachedEvent as jest.Mock).mockResolvedValue(null);
  (saveCachedEvent as jest.Mock).mockResolvedValue(undefined);
  (clearGameDayCache as jest.Mock).mockResolvedValue(undefined);
});

test('offline event detail is visibly stale and read-only', async () => {
  (getEvent as jest.Mock).mockRejectedValueOnce({ code: 'functions/unavailable' });
  (loadCachedEvent as jest.Mock).mockResolvedValue({
    value: { ...event, canManage: false, notes: null },
    savedAt: '2026-10-16T18:00:00.000Z',
    olderThanTtl: true,
  });
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Falcons vs Comets');
  expect(screen.getByRole('alert').props.children.join('')).toMatch(/Offline copy/);
  expect(screen.getByText(/Updates, responses, check-in, and attendance require a connection/)).toBeTruthy();
  expect(screen.queryByText('Edit event')).toBeNull();
  expect(screen.queryByText('Conversation')).toBeNull();
  expect(screen.queryByText('Participant availability')).toBeNull();
});
test('canonical event detail offers the team lineup entry without loading it until opened', async () => {
  const { getLineup } = jest.requireMock('../../firebase/lineups');
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org' });
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await fireEvent.press(await screen.findByText('Team lineup'));
  expect(await screen.findByText(/No active roster participants yet/)).toBeTruthy();
  expect(getLineup).toHaveBeenCalledWith('shared', membership.teamId);
});
test('canonical event detail offers playing time only to coaches and loads nothing until opened', async () => {
  const { getPlaySession } = jest.requireMock('../../firebase/playTime');
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org' });
  const view = await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'coach' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  expect(await screen.findByText('Playing time')).toBeTruthy();
  expect(getPlaySession).not.toHaveBeenCalled();
  await view.unmount();
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'player' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Team lineup');
  expect(screen.queryByText('Playing time')).toBeNull();
});
test('match result proposal is offered only to coaches on match events', async () => {
  const { getEventResults } = jest.requireMock('../../firebase/competition');
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org', type: 'match' });
  const view = await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'coach' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  expect(await screen.findByText('Match result')).toBeTruthy();
  expect(getEventResults).not.toHaveBeenCalled();
  await view.unmount();
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'player' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Team lineup');
  expect(screen.queryByText('Match result')).toBeNull();
});
test('match standings and bracket are offered to every team viewer on match events and load nothing until opened', async () => {
  const { getEventStandings, getEventBracket } = jest.requireMock('../../firebase/competition');
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org', type: 'match' });
  const view = await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'player' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  expect(await screen.findByText('Standings')).toBeTruthy();
  expect(screen.getByText('Bracket')).toBeTruthy();
  expect(getEventStandings).not.toHaveBeenCalled();
  expect(getEventBracket).not.toHaveBeenCalled();
  await view.unmount();
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org', type: 'practice' });
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={{ ...membership, role: 'player' }} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Team lineup');
  expect(screen.queryByText('Standings')).toBeNull();
  expect(screen.queryByText('Bracket')).toBeNull();
});
test('published event detail opens the event conversation for the event organization', async () => {
  (getEvent as jest.Mock).mockResolvedValue({ ...event, orgId: 'org' });
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Falcons vs Comets');
  await fireEvent.press(screen.getByText('Conversation'));
  expect(navigation.navigate).toHaveBeenCalledWith('Conversation', { orgId: 'org', scopeType: 'event', scopeId: 'shared' });
});
test('bare Firestore permission denial clears event snapshots without offline fallback', async () => {
  (getEvent as jest.Mock).mockRejectedValueOnce({ code: 'permission-denied' });
  await render(<EventDetailScreen userId="user-a" cacheScope="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await waitFor(() => expect(clearGameDayCache).toHaveBeenCalledWith('user-a'));
  expect(loadCachedEvent).not.toHaveBeenCalled();
  expect(screen.queryByText('Falcons vs Comets')).toBeNull();
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

test('resource-assigned detail renders the exact facility and field label for a read-only viewer', async () => {
  (getEvent as jest.Mock).mockResolvedValue({ ...event, canManage: false,
    location: { name: 'Cedar Park · Field 2 North', address: '100 Sample Street' } });
  await render(<EventDetailScreen membership={membership} navigation={navigation} route={{ params: { eventId: 'shared' } } as any} />);
  await screen.findByText('Cedar Park · Field 2 North\n100 Sample Street');
  expect(screen.queryByText('Edit event')).toBeNull();
});

test('resource conflict on native reschedule preserves entered local time and explains the rejection', async () => {
  (mutateEventSchedule as jest.Mock).mockRejectedValueOnce(new Error('This resource already has an overlapping reservation including setup and cleanup.'));
  await render(<CreateEditEventScreen teamId="a" membership={membership} navigation={navigation} route={{ params: { eventId: 'shared', action: 'reschedule' } } as any} />);
  await screen.findByDisplayValue('2026-10-20');
  await fireEvent.changeText(screen.getByLabelText('Local time'), '19:30');
  await fireEvent.changeText(screen.getByLabelText('Reason for change'), 'Moving practice');
  await fireEvent.press(screen.getByText('Save changes'));
  await screen.findByText('This resource already has an overlapping reservation including setup and cleanup.');
  expect(screen.getByDisplayValue('19:30')).toBeTruthy();
  expect(navigation.goBack).not.toHaveBeenCalled();
});
