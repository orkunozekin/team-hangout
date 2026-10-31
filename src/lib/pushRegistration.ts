import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushDevice, revokePushDevice } from '../firebase/notifications';

const INSTALLATION_KEY = '@team-hangout/push-installation/v1';
const generationKey = (uid: string) => `@team-hangout/push-registration-generation/v1/${uid}`;

/** Keeps the highest generation per account so an older overlapping sync response cannot roll the revocation fence back. */
async function rememberGeneration(uid: string, generation: number) {
  const stored = Number(await AsyncStorage.getItem(generationKey(uid)));
  if (!Number.isSafeInteger(stored) || generation > stored) await AsyncStorage.setItem(generationKey(uid), String(generation));
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
  const registered = await registerPushDevice({ installationId: id, platform: Platform.OS === 'ios' ? 'ios' : 'android', projectId,
    permissionState: state, expoPushToken }) as { registrationGeneration?: unknown } | undefined;
  if (Number.isSafeInteger(registered?.registrationGeneration)) await rememberGeneration(uid, registered!.registrationGeneration as number);
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
  if (!id) return;
  // Capture the generation now: sign-out may time out and let a new sign-in re-register before this request lands.
  const generation = Number(await AsyncStorage.getItem(generationKey(uid)));
  await revokePushDevice(id, Number.isSafeInteger(generation) && generation > 0 ? generation : undefined);
}
