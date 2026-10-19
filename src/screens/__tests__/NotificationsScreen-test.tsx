import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import NotificationsScreen from '../NotificationsScreen';
import * as api from '../../firebase/notifications';
import * as push from '../../lib/pushRegistration';
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: jest.fn(() => ({ id: 'request-id' })) }));
jest.mock('firebase/functions', () => ({ httpsCallable: jest.fn() }));
jest.mock('../../firebase/config', () => ({ db: {}, functions: {} }));
jest.mock('../../firebase/commands', () => ({ runCommand: jest.fn() }));
jest.mock('../../firebase/notifications');
jest.mock('../../lib/pushRegistration', () => ({ registerPushNotifications: jest.fn(), syncExistingPushPermission: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
const rows = [
  { id: 'unread', title: 'Field closed', body: 'Open Team Hangout for current details.', critical: true, sourceRevision: 3, createdAt: '2026-10-18T14:00:00.000Z', readAt: null, acknowledgedAt: null, deliveryStatus: 'providerAccepted' },
  { id: 'read', title: 'Schedule published', body: 'Open Team Hangout for current details.', critical: false, sourceRevision: 1, createdAt: '2026-10-18T13:00:00.000Z', readAt: '2026-10-18T13:05:00.000Z', acknowledgedAt: null, deliveryStatus: 'permanentFailure' },
  { id: 'unknown', title: 'Event updated', body: 'Open Team Hangout for current details.', critical: false, sourceRevision: 1, createdAt: '2026-10-18T12:00:00.000Z', readAt: '2026-10-18T12:05:00.000Z', acknowledgedAt: null, deliveryStatus: 'unknownOutcome' },
];
beforeEach(() => { jest.clearAllMocks(); (api.listNotifications as jest.Mock).mockResolvedValue({ items: rows, nextCursor: null, unreadCount: 1 }); });
test('distinguishes unread, acknowledged and failed delivery without equating them', async () => {
  (api.markNotificationRead as jest.Mock).mockResolvedValue({ ...rows[0], readAt: 'now' });
  (api.acknowledgeCriticalUpdate as jest.Mock).mockResolvedValue({ ...rows[0], readAt: 'now', acknowledgedAt: 'now' });
  await render(<NotificationsScreen />);
  await screen.findByText('1 unread');
  expect(screen.getByText('Unread')).toBeTruthy();
  expect(screen.getByText('Delivery failed')).toBeTruthy();
  expect(screen.getByText('Delivery outcome unknown')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('Open Field closed')));
  await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith('unread', 3));
  await act(async () => fireEvent.press(screen.getByText('Acknowledge critical update')));
  await waitFor(() => expect(api.acknowledgeCriticalUpdate).toHaveBeenCalledWith('unread', 3));
  expect(await screen.findByText('Acknowledged')).toBeTruthy();
});
test('loads the next bounded inbox page without duplicating rows', async () => {
  (api.listNotifications as jest.Mock)
    .mockResolvedValueOnce({ items: rows.slice(0, 2), nextCursor: 'read', unreadCount: 1 })
    .mockResolvedValueOnce({ items: [rows[1], rows[2]], nextCursor: null, unreadCount: 0 });
  await render(<NotificationsScreen />);
  await screen.findByText('Load more updates');
  await act(async () => fireEvent.press(screen.getByText('Load more updates')));
  await waitFor(() => expect(api.listNotifications).toHaveBeenLastCalledWith('read'));
  expect(screen.getAllByText('Schedule published')).toHaveLength(1);
  expect(await screen.findByText('Delivery outcome unknown')).toBeTruthy();
});
test('shows denied permission without hiding the authoritative inbox', async () => {
  (push.syncExistingPushPermission as jest.Mock).mockResolvedValue({ permissionState: 'denied', installationId: 'install-a' });
  (push.registerPushNotifications as jest.Mock).mockResolvedValue({ permissionState: 'denied', installationId: 'install-a' });
  await render(<NotificationsScreen userId="user-a" pushProjectId="project-a" />);
  expect(await screen.findByText('Push permission denied')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Enable push updates')));
  expect(await screen.findByText('Push permission is denied. In-app updates and email fallback remain available.')).toBeTruthy();
  expect(screen.getByText('Field closed')).toBeTruthy();
});
