import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushDevice, revokePushDevice } from '../firebase/notifications';

const INSTALLATION_KEY = '@team-hangout/push-installation/v1';
const sessionKey = (uid: string) => `@team-hangout/push-registration-session/v1/${uid}`;
const pendingSessions = new Map<string, Promise<string>>();

/**
 * One ID per sign-in, shared by every sync in that session and kept until sign-out. Revocation is fenced to it, so a
 * late revoke from an earlier sign-in cannot clear a newer one, and slow or overlapping syncs never change it.
 */
function registrationSession(uid: string): Promise<string> {
  const pending = pendingSessions.get(uid);
  if (pending) return pending;
  const created = (async () => {
    const existing = await AsyncStorage.getItem(sessionKey(uid));
    if (existing && /^[A-Za-z0-9_-]{12,128}$/.test(existing)) return existing;
    const id = `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
    await AsyncStorage.setItem(sessionKey(uid), id);
    return id;
  })();
  // Only dedupe a creation still in flight; once settled, storage is the source of truth.
  pendingSessions.set(uid, created);
  const settle = () => { if (pendingSessions.get(uid) === created) pendingSessions.delete(uid); };
  created.then(settle, settle);
  return created;
}

function permissionState(permission: Notifications.NotificationPermissionsStatus): 'granted' | 'denied' | 'undetermined' {
  if (Platform.OS === 'ios' && permission.ios) {
    const allowed = [Notifications.IosAuthorizationStatus.AUTHORIZED, Notifications.IosAuthorizationStatus.PROVISIONAL,
      Notifications.IosAuthorizationStatus.EPHEMERAL];
    if (allowed.includes(permission.ios.status)) return 'granted';
    if (permission.ios.status === Notifications.IosAuthorizationStatus.DENIED) return 'denied';
    return 'undetermined';
  }
  return permission.status === 'granted' ? 'granted' : permission.status === 'denied' ? 'denied' : 'undetermined';
}

async function installationId(): Promise<string> {
  const existing = await AsyncStorage.getItem(INSTALLATION_KEY);
  if (existing && /^[A-Za-z0-9_-]{12,128}$/.test(existing)) return existing;
  const created = `install_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  await AsyncStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

async function sync(uid: string, projectId: string, ask: boolean) {
  const id = await installationId();
  if (!projectId) return { permissionState: 'unavailable' as const, installationId: id };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('team-updates', {
      name: 'Team updates',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (ask && permissionState(permission) === 'undetermined') permission = await Notifications.requestPermissionsAsync();
  const state = permissionState(permission);
  let expoPushToken: string | null = null;
  if (state === 'granted') expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await registerPushDevice({ installationId: id, platform: Platform.OS === 'ios' ? 'ios' : 'android', projectId,
    permissionState: state, expoPushToken, registrationSessionId: await registrationSession(uid) });
  return { permissionState: state, installationId: id };
}

export function registerPushNotifications(uid: string, projectId: string) {
  return sync(uid, projectId, true);
}

export function syncExistingPushPermission(uid: string, projectId: string) {
  return sync(uid, projectId, false);
}

export async function revokePushNotifications(uid: string): Promise<void> {
  const id = await AsyncStorage.getItem(INSTALLATION_KEY);
  // Capture and end this sign-in's session first, so the next sign-in starts a new one even if this request is slow.
  const session = await AsyncStorage.getItem(sessionKey(uid));
  pendingSessions.delete(uid);
  await AsyncStorage.removeItem(sessionKey(uid));
  if (id) await revokePushDevice(id, session ?? undefined);
}
