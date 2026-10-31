import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';
import ScheduleScreen from '../ScheduleScreen';
import { listTeamEventPage } from '../../firebase/events';
import { clearGameDayCache, loadCachedTeamSchedule, saveCachedTeamSchedule } from '../../lib/gameDayCache';
jest.mock('../../firebase/events', () => ({ listTeamEventPage: jest.fn() }));
jest.mock('../../lib/gameDayCache', () => ({
  loadCachedTeamSchedule: jest.fn(),
  saveCachedTeamSchedule: jest.fn(),
  clearGameDayCache: jest.fn(),
  isGameDayCacheAccessLoss: (error: { code?: string; details?: { domainCode?: string } }) =>
    ['permission-denied', 'functions/permission-denied', 'unauthenticated', 'functions/unauthenticated'].includes(error?.code ?? '') || error?.details?.domainCode === 'AGENDA_CHANGED',
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
const membership = { teamId: 'a', role: 'coach' } as any;
const navigation = { navigate: jest.fn() } as any;
const event = (id: string) => ({ id, teamId: 'a', title: id, type: 'match', date: new Date('2026-10-20T12:00:00Z'), time: '18:00', location: null });
beforeEach(() => {
  jest.resetAllMocks();
  (loadCachedTeamSchedule as jest.Mock).mockResolvedValue(null);
  (saveCachedTeamSchedule as jest.Mock).mockResolvedValue(undefined);
  (clearGameDayCache as jest.Mock).mockResolvedValue(undefined);
});

test('restores an offline schedule without restoring management authority', async () => {
  (listTeamEventPage as jest.Mock).mockRejectedValueOnce({ code: 'functions/unavailable' });
  (loadCachedTeamSchedule as jest.Mock).mockResolvedValue({
    value: { items: [event('Cached match')], nextCursor: null, canManage: false },
    savedAt: '2026-10-16T18:00:00.000Z',
    olderThanTtl: false,
  });
  await render(<ScheduleScreen userId="user-a" teamId="a" teamSchemaVersion={2} membership={membership} navigation={navigation} />);
  await screen.findByText('Cached match');
  expect(screen.getByRole('alert').props.children.join('')).toMatch(/Offline copy/);
  expect(screen.queryByText('Add event')).toBeNull();
  // Filter chips wrap instead of running off screen at large accessibility text sizes.
  let node = screen.getByRole('button', { name: 'Past events' }).parent;
  while (node && StyleSheet.flatten(node.props.style)?.flexDirection !== 'row') node = node.parent;
  expect(StyleSheet.flatten(node?.props.style)).toMatchObject({ flexWrap: 'wrap' });
});

test('keeps a cached schedule read-only until foreground authorization succeeds and clears it on revocation', async () => {
  let appStateListener: (state: string) => void = () => {};
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener: any) => {
    appStateListener = listener;
    return { remove: jest.fn() } as any;
  });
  (listTeamEventPage as jest.Mock)
    .mockRejectedValueOnce({ code: 'functions/unavailable' })
    .mockRejectedValueOnce({ code: 'permission-denied' });
  (loadCachedTeamSchedule as jest.Mock).mockResolvedValue({
    value: { items: [event('Cached match')], nextCursor: null, canManage: false },
    savedAt: '2026-10-16T18:00:00.000Z', olderThanTtl: false,
  });
  await render(<ScheduleScreen userId="user-a" teamId="a" teamSchemaVersion={2} membership={membership} navigation={navigation} />);
  await screen.findByText('Cached match');
  await act(async () => appStateListener('active'));
  await screen.findByText('Permission removed. Reload to see your current schedule.');
  expect(screen.queryByText('Cached match')).toBeNull();
  expect(clearGameDayCache).toHaveBeenCalledWith('user-a');
  expect(loadCachedTeamSchedule).toHaveBeenCalledTimes(1);
});

test('clears a live schedule when pagination discovers revocation', async () => {
  (listTeamEventPage as jest.Mock)
    .mockResolvedValueOnce({ items: [event('Previously visible')], nextCursor: 'next', canManage: false })
    .mockRejectedValueOnce({ code: 'functions/permission-denied' });
  await render(<ScheduleScreen userId="user-a" teamId="a" teamSchemaVersion={2} membership={membership} navigation={navigation} />);
  await screen.findByText('Previously visible');
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByText('Permission removed. Reload to see your current schedule.');
  expect(screen.queryByText('Previously visible')).toBeNull();
  expect(clearGameDayCache).toHaveBeenCalledWith('user-a');
});

test('reloads page one when publication changes invalidate a schedule cursor', async () => {
  (listTeamEventPage as jest.Mock)
    .mockResolvedValueOnce({ items: [event('Before publication change')], nextCursor: 'old-cursor', canManage: false })
    .mockRejectedValueOnce({ code: 'functions/invalid-argument' })
    .mockResolvedValueOnce({ items: [event('After publication change')], nextCursor: null, canManage: false });
  await render(<ScheduleScreen userId="user-a" teamId="a" teamSchemaVersion={2} membership={membership} navigation={navigation} />);
  await screen.findByText('Before publication change');
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByText('After publication change');
  expect(screen.queryByText('Before publication change')).toBeNull();
  expect(clearGameDayCache).toHaveBeenCalledWith('user-a');
  expect(listTeamEventPage).toHaveBeenLastCalledWith('a', null, 'upcoming', 2);
});

test('renders one schedule page immediately and loads the next only on request', async () => {
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [event('First match')], nextCursor: 'first' })
    .mockResolvedValueOnce({ items: [event('Second match')], nextCursor: null });
  await render(<ScheduleScreen teamId="a" membership={membership} navigation={navigation} />);
  await screen.findByText('First match');
  expect(listTeamEventPage).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('Load more events'));
  await screen.findByText('Second match');
  expect(listTeamEventPage).toHaveBeenLastCalledWith('a', 'first', 'upcoming', undefined);
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
  expect(listTeamEventPage).toHaveBeenNthCalledWith(3, 'a', 'first', 'upcoming', undefined);
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


test('opens upcoming events first and switches to a bounded past view', async () => {
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [event('Next practice')], nextCursor: null })
    .mockResolvedValueOnce({ items: [event('Recent history')], nextCursor: 'past-page' });
  await render(<ScheduleScreen teamId="a" membership={membership} navigation={navigation} />);
  await screen.findByText('Next practice');
  expect(listTeamEventPage).toHaveBeenCalledWith('a', null, 'upcoming', undefined);
  await fireEvent.press(screen.getByText('Past events'));
  await screen.findByText('Recent history');
  expect(listTeamEventPage).toHaveBeenLastCalledWith('a', null, 'past', undefined);
  expect(screen.queryByText('Next practice')).toBeNull();
  expect(screen.getByText('Load more events')).toBeTruthy();
});


test('canonical add controls follow live page authority despite stale coach and support roles', async () => {
  (listTeamEventPage as jest.Mock).mockResolvedValueOnce({ items: [], nextCursor: null, canManage: true })
    .mockResolvedValueOnce({ items: [], nextCursor: null, canManage: false });
  await render(<ScheduleScreen teamId="a" teamSchemaVersion={2} membership={membership} appRole="superAdmin" navigation={navigation} />);
  await screen.findByText('Add event');
  await fireEvent.press(screen.getByText('Past events'));
  await waitFor(() => expect(screen.queryByText('Add event')).toBeNull());
  expect(listTeamEventPage).toHaveBeenLastCalledWith('a', null, 'past', 2);
});
