import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ConversationsScreen from '../ConversationsScreen';
import { listHouseholdAgenda } from '../../firebase/agenda';

jest.mock('../../firebase/agenda', () => ({ listHouseholdAgenda: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const team = {
  id: 'stars', orgId: 'org', organizationName: 'Demo Club', name: 'Stars', seasonId: 'fall', seasonName: 'Fall',
  seasonStatus: 'active', archived: false, divisionId: 'u12', divisionName: 'U12',
  participants: [{ orgId: 'org', participantId: 'jamie', displayName: 'Jamie' }],
};
beforeEach(() => jest.resetAllMocks());

test('lists announcement, team and event conversations grouped by section and opens the selected one', async () => {
  (listHouseholdAgenda as jest.Mock).mockResolvedValue({ items: [{ id: 'practice', orgId: 'org', title: 'Sibling practice' }], teams: [team], nextCursor: null, setupRequired: false, accessVersion: 'a' });
  const onOpen = jest.fn();
  await render(<ConversationsScreen activeTeam={{ id: 'coached', name: 'Comets', schemaVersion: 2, orgId: 'org' }} onOpen={onOpen} />);
  await screen.findByText('Demo Club announcements');
  expect(screen.getByText('U12 announcements')).toBeTruthy();
  expect(screen.getByText('Announcements')).toBeTruthy();
  expect(screen.getByText('Upcoming events')).toBeTruthy();
  expect(screen.getByText('Stars')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Open Comets'));
  await fireEvent.press(screen.getByLabelText('Open Sibling practice'));
  expect(onOpen.mock.calls.map(call => call[0])).toEqual([
    { orgId: 'org', scopeType: 'team', scopeId: 'coached' },
    { orgId: 'org', scopeType: 'event', scopeId: 'practice' },
  ]);
});

test('does not duplicate the active team and keeps legacy teams out', async () => {
  (listHouseholdAgenda as jest.Mock).mockResolvedValue({ items: [], teams: [team], nextCursor: null, setupRequired: false, accessVersion: 'a' });
  await render(<ConversationsScreen activeTeam={{ id: 'stars', name: 'Stars', schemaVersion: 2, orgId: 'org' }} onOpen={jest.fn()} />);
  await screen.findByText('Demo Club announcements');
  expect(screen.getAllByText('Stars')).toHaveLength(1);
});

test('shows an error and still offers the active team conversation when the agenda fails', async () => {
  (listHouseholdAgenda as jest.Mock).mockRejectedValue({ code: 'functions/unavailable' });
  await render(<ConversationsScreen activeTeam={{ id: 'stars', name: 'Stars', schemaVersion: 2, orgId: 'org' }} onOpen={jest.fn()} />);
  await screen.findByRole('alert');
  expect(screen.getByText('Stars')).toBeTruthy();
});

test('explains the empty state', async () => {
  (listHouseholdAgenda as jest.Mock).mockResolvedValue({ items: [], teams: [], nextCursor: null, setupRequired: false, accessVersion: 'a' });
  await render(<ConversationsScreen onOpen={jest.fn()} />);
  await screen.findByText(/No conversations yet/);
});
