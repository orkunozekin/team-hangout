import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import TeamScreen from '../TeamScreen';
import { getTeam, listTeamMembers } from '../../firebase/teams';
jest.mock('../../firebase/teams', () => ({ getTeam: jest.fn(), listTeamMembers: jest.fn(), regenerateInviteCode: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
const membership = { teamId: 'a', userId: 'coach', role: 'coach' } as any;
beforeEach(() => jest.resetAllMocks());

test('canonical Team tab loads its authorized name without querying the legacy directory or exposing invite tools', async () => {
  (getTeam as jest.Mock).mockResolvedValue({ id: 'a', schemaVersion: 2, name: 'Falcons' });
  (listTeamMembers as jest.Mock).mockRejectedValue({ code: 'permission-denied' });
  await render(<TeamScreen teamId="a" membership={membership} />);
  await screen.findByText('Falcons');
  expect(screen.getByText("Your organization manages this team's roster.")).toBeTruthy();
  expect(listTeamMembers).not.toHaveBeenCalled();
  expect(screen.queryByText('Share invite')).toBeNull();
  expect(screen.queryByText('No members yet.')).toBeNull();
  await fireEvent.press(screen.getByText('Refresh team'));
  await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
  await screen.findByText('Falcons');
  expect(listTeamMembers).not.toHaveBeenCalled();
});

test('legacy Team tab retains members and invite controls', async () => {
  (getTeam as jest.Mock).mockResolvedValue({ id: 'legacy', name: 'Legacy Wolves', inviteCode: 'ABCDEFGH' });
  (listTeamMembers as jest.Mock).mockResolvedValue([{ id: 'member', displayName: 'Alex', role: 'player' }]);
  await render(<TeamScreen teamId="legacy" membership={membership} />);
  await screen.findByText('Alex');
  expect(screen.getByText('Members (1)')).toBeTruthy();
  expect(screen.getByText('Share invite')).toBeTruthy();
  expect(listTeamMembers).toHaveBeenCalledWith('legacy');
});

test('failed Team tab reads show a retry, then recover without an unhandled rejection', async () => {
  (getTeam as jest.Mock).mockRejectedValueOnce({ code: 'permission-denied' }).mockResolvedValue({ id: 'a', schemaVersion: 2, name: 'Recovered' });
  await render(<TeamScreen teamId="a" membership={membership} />);
  await screen.findByRole('alert');
  await fireEvent.press(screen.getByText('Retry'));
  await screen.findByText('Recovered');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(listTeamMembers).not.toHaveBeenCalled();
});

test('switching teams ignores an earlier team response', async () => {
  let resolveOld!: (data: unknown) => void;
  (getTeam as jest.Mock).mockImplementation((id: string) => id === 'old'
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ id, schemaVersion: 2, name: 'Current team' }));
  const view = await render(<TeamScreen teamId="old" membership={membership} />);
  await view.rerender(<TeamScreen teamId="new" membership={membership} />);
  await screen.findByText('Current team');
  resolveOld({ id: 'old', schemaVersion: 2, name: 'Old team' });
  await waitFor(() => expect(screen.queryByText('Old team')).toBeNull());
});
