const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
  clear: jest.fn(async () => { mockStorage.clear(); }),
}));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  registerPushNotifications,
  revokePushNotifications,
  syncExistingPushPermission,
} from '../pushRegistration';
import * as api from '../../firebase/notifications';

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
}));
jest.mock('../../firebase/notifications', () => ({
  registerPushDevice: jest.fn(),
  revokePushDevice: jest.fn(),
}));

const granted = { status: 'granted', ios: { status: 2 } };

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue(granted);
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue(granted);
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[test-token]' });
  (api.registerPushDevice as jest.Mock).mockResolvedValue({ permissionState: 'granted' });
});

it('registers a stable installation with the configured Expo project', async () => {
  await registerPushNotifications('user-1', 'project-1');
  const first = (api.registerPushDevice as jest.Mock).mock.calls[0][0];
  expect(first).toEqual(expect.objectContaining({ platform: 'ios', permissionState: 'granted', expoPushToken: 'ExponentPushToken[test-token]', projectId: 'project-1' }));
  await registerPushNotifications('user-1', 'project-1');
  expect((api.registerPushDevice as jest.Mock).mock.calls[1][0].installationId).toBe(first.installationId);
});

it('records denial without requesting again during passive sign-in sync', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied', ios: { status: 1 } });
  await syncExistingPushPermission('user-1', 'project-1');
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(api.registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ permissionState: 'denied', expoPushToken: null }));
});

it('creates the Android channel before asking permission and revokes on logout', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'undetermined' });
  await registerPushNotifications('user-1', 'project-1');
  expect((Notifications.setNotificationChannelAsync as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (Notifications.requestPermissionsAsync as jest.Mock).mock.invocationCallOrder[0],
  );
  const installationId = (api.registerPushDevice as jest.Mock).mock.calls[0][0].installationId;
  await revokePushNotifications('user-1');
  expect(api.revokePushDevice).toHaveBeenCalledWith(installationId, expect.stringMatching(/^session_/));
});

it('every sync in a sign-in shares one session ID and logout revocation is fenced to it', async () => {
  let resolveSlow: (value: unknown) => void = () => undefined;
  await AsyncStorage.setItem('@team-hangout/push-installation/v1', 'install_existing_device');
  (api.registerPushDevice as jest.Mock)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
    .mockResolvedValueOnce({ permissionState: 'granted' });
  // Overlapping syncs, including one whose response is still pending at sign-out, all carry the same session.
  const slow = registerPushNotifications('user-1', 'project-1');
  await syncExistingPushPermission('user-1', 'project-1');
  const [first, second] = (api.registerPushDevice as jest.Mock).mock.calls.map((call) => call[0]);
  expect(first.registrationSessionId).toMatch(/^session_/);
  expect(second.registrationSessionId).toBe(first.registrationSessionId);
  await revokePushNotifications('user-1');
  expect(api.revokePushDevice).toHaveBeenCalledWith(first.installationId, first.registrationSessionId);
  resolveSlow({ permissionState: 'granted' });
  await slow;
});

it('the next sign-in gets a new session, so a late revocation from the previous one cannot match it', async () => {
  await registerPushNotifications('user-1', 'project-1');
  const before = (api.registerPushDevice as jest.Mock).mock.calls[0][0].registrationSessionId;
  await revokePushNotifications('user-1');
  await registerPushNotifications('user-1', 'project-1');
  const after = (api.registerPushDevice as jest.Mock).mock.calls[1][0].registrationSessionId;
  expect(after).not.toBe(before);
});
