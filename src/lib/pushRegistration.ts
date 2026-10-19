import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushDevice, revokePushDevice } from '../firebase/notifications';

const INSTALLATION_KEY = '@team-hangout/push-installation/v1';

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
    permissionState: state, expoPushToken });
  return { permissionState: state, installationId: id };
}

export function registerPushNotifications(uid: string, projectId: string) {
  return sync(uid, projectId, true);
}

export function syncExistingPushPermission(uid: string, projectId: string) {
  return sync(uid, projectId, false);
}

export async function revokePushNotifications(_uid: string): Promise<void> {
  const id = await AsyncStorage.getItem(INSTALLATION_KEY);
  if (id) await revokePushDevice(id);
}
