import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import TeamsScreen from '../TeamsScreen';
import { getMembershipsForUser, getTeam } from '../../firebase/teams';

jest.mock('../../firebase/teams', () => ({ getMembershipsForUser: jest.fn(), getTeam: jest.fn(), listTeamMembers: jest.fn(async () => []), regenerateInviteCode: jest.fn() }));
jest.mock('../../firebase/reports', () => ({ listTeamReports: jest.fn(async () => ({ items: [], nextCursor: null })), getReportRun: jest.fn(), requestTeamAttendanceReport: jest.fn(), reportRequestId: () => 'r' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));

const falcons = { id: 'a', name: 'Falcons', sport: 'Soccer', inviteCode: 'X' } as any;
const hawks = { id: 'b', name: 'Hawks', sport: null, inviteCode: 'Y' } as any;
const member = (teamId: string) => ({ id: `${teamId}_u`, teamId, userId: 'u', role: 'parent', displayName: 'U', joinedAt: new Date(0) });
beforeEach(() => {
  jest.resetAllMocks();
  (jest.requireMock('../../firebase/teams').listTeamMembers as jest.Mock).mockResolvedValue([]);
});

test('lists every team the user belongs to and opens the chosen one', async () => {
  (getMembershipsForUser as jest.Mock).mockResolvedValue([member('a'), member('b'), member('gone')]);
  (getTeam as jest.Mock).mockImplementation(async (id: string) => (id === 'b' ? hawks : id === 'gone' ? null : falcons));
  const onOpenTeam = jest.fn();
  await render(<TeamsScreen userId="u" activeTeam={falcons} activeMembership={member('a') as any} onOpenTeam={onOpenTeam} />);
  await screen.findByText('Your teams');
  expect(screen.getAllByRole('button', { name: /^Open / }).map(node => node.props.accessibilityLabel)).toEqual(['Open Falcons', 'Open Hawks']);
  await fireEvent.press(screen.getByLabelText('Open Hawks'));
  expect(onOpenTeam).toHaveBeenCalledWith({ team: hawks, membership: member('b') });
});

test('a single team goes straight to its details', async () => {
  (getMembershipsForUser as jest.Mock).mockResolvedValue([member('a')]);
  (getTeam as jest.Mock).mockResolvedValue(falcons);
  await render(<TeamsScreen userId="u" activeTeam={falcons} activeMembership={member('a') as any} onOpenTeam={jest.fn()} />);
  await screen.findByText('Falcons');
  expect(screen.queryByText('Your teams')).toBeNull();
});
