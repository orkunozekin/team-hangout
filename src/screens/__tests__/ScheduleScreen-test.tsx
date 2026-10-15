import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import ScheduleScreen from '../ScheduleScreen';
import { listTeamEventPage } from '../../firebase/events';
jest.mock('../../firebase/events', () => ({ listTeamEventPage: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
const membership = { teamId: 'a', role: 'coach' } as any;
const navigation = { navigate: jest.fn() } as any;
const event = (id: string) => ({ id, title: id, type: 'match', date: new Date('2026-10-20T12:00:00Z'), time: '18:00', location: null });
beforeEach(() => jest.resetAllMocks());

test('renders one schedule page immediately and loads the next only on request', async () => {
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [event('First match')], nextCursor: 'first' })
    .mockResolvedValueOnce({ items: [event('Second match')], nextCursor: null });
  await render(<ScheduleScreen teamId="a" membership={membership} navigation={navigation} />);
  await screen.findByText('First match');
  expect(listTeamEventPage).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByText('Second match');
  expect(listTeamEventPage).toHaveBeenLastCalledWith('a', 'first');
  expect(screen.getByText('First match')).toBeTruthy();
  expect(screen.queryByText('Load more events')).toBeNull();
});

test('preserves earlier events after a later page fails and retries the same cursor', async () => {
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [event('Keep this match')], nextCursor: 'first' })
    .mockRejectedValueOnce(new Error('More events unavailable'))
    .mockResolvedValueOnce({ items: [event('Keep this match'), event('Recovered match')], nextCursor: null });
  await render(<ScheduleScreen teamId="a" membership={membership} navigation={navigation} />);
  await screen.findByText('Keep this match');
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByRole('alert');
  expect(screen.getByText('Keep this match')).toBeTruthy();
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByText('Recovered match');
  expect(screen.getAllByText('Keep this match')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(listTeamEventPage).toHaveBeenNthCalledWith(3, 'a', 'first');
});

test('ignores a pending old page after changing teams', async () => {
  let resolvePage!: (data: unknown) => void;
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [event('Old first')], nextCursor: 'old' })
    .mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }))
    .mockResolvedValueOnce({ items: [event('New team match')], nextCursor: null });
  const view = await render(<ScheduleScreen teamId="a" membership={membership} navigation={navigation} />);
  await screen.findByText('Old first');
  await fireEvent.press(screen.getByText('Load more events'));
  await view.rerender(<ScheduleScreen teamId="b" membership={membership} navigation={navigation} />);
  await screen.findByText('New team match');
  await act(async () => { resolvePage({ items: [event('Old late page')], nextCursor: null }); });
  await waitFor(() => expect(screen.queryByText('Old late page')).toBeNull());
  expect(screen.queryByText('Old first')).toBeNull();
});
