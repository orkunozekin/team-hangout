import { httpsCallable } from 'firebase/functions';
import { runCommand } from '../commands';
import { acknowledgeCriticalUpdate, listNotifications, markNotificationRead, registerPushDevice, resolveNotificationTarget, revokePushDevice } from '../notifications';
jest.mock('firebase/functions', () => ({ httpsCallable: jest.fn() }));
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: jest.fn(() => ({ id: 'notification-request' })) }));
jest.mock('../config', () => ({ db: {}, functions: {} }));
jest.mock('../commands', () => ({ runCommand: jest.fn() }));
beforeEach(() => jest.clearAllMocks());
test('notification adapter keeps reads separate from revisioned read and acknowledgement commands', async () => {
  const page = { items: [], unreadCount: 0, nextCursor: null };
  (httpsCallable as jest.Mock).mockReturnValue(async () => ({ data: page }));
  await expect(listNotifications()).resolves.toEqual(page);
  expect(httpsCallable).toHaveBeenCalledWith({}, 'listNotifications');
  (runCommand as jest.Mock).mockResolvedValue({ ok: true });
  await markNotificationRead('notification-a', 3);
  await acknowledgeCriticalUpdate('notification-a', 3);
  expect(runCommand).toHaveBeenNthCalledWith(1, 'markNotificationRead', { notificationId: 'notification-a', sourceRevision: 3 }, 'notification-request');
  expect(runCommand).toHaveBeenNthCalledWith(2, 'acknowledgeCriticalUpdate', { notificationId: 'notification-a', sourceRevision: 3 }, 'notification-request');
});

test('notification adapter registers and revokes this installation and resolves a live target', async () => {
  (runCommand as jest.Mock).mockResolvedValue({ ok: true });
  await registerPushDevice({ installationId: 'install-a', platform: 'ios', projectId: 'project-a', permissionState: 'granted', expoPushToken: 'ExponentPushToken[x]' });
  await revokePushDevice('install-a');
  expect(runCommand).toHaveBeenNthCalledWith(1, 'registerPushDevice', expect.objectContaining({ installationId: 'install-a' }), 'notification-request');
  expect(runCommand).toHaveBeenNthCalledWith(2, 'revokePushDevice', { installationId: 'install-a' }, 'notification-request');
  const result = { available: true, target: { type: 'event', id: 'event-a' } };
  (httpsCallable as jest.Mock).mockReturnValue(async () => ({ data: result }));
  await expect(resolveNotificationTarget('notice-a', 2)).resolves.toEqual(result);
  expect(httpsCallable).toHaveBeenCalledWith({}, 'resolveNotificationTarget');
});
