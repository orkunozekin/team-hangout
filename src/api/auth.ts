import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  User,
  UserCredential,
} from 'firebase/auth';

import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import * as AppleAuthentication from 'expo-apple-authentication';

import {
  Platform,
} from 'react-native';

import {
  auth,
} from '../firebase/config';

import {
  ensureUserDocument,
} from '../firebase/users';
import { clearGameDayCache } from '../lib/gameDayCache';
import { revokePushNotifications } from '../lib/pushRegistration';

let googleConfigured = false;

function ensureGoogleConfigured(): void {
  if (googleConfigured) {
    return;
  }

  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!webClientId) {
    throw new Error(
      'Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID. Add your Firebase Web OAuth client ID to .env.local.',
    );
  }

  GoogleSignin.configure({ webClientId });
  googleConfigured = true;
}

function appleDisplayName(
  fullName: AppleAuthentication.AppleAuthenticationFullName | null,
): string | null {
  if (!fullName) {
    return null;
  }
  const parts = [fullName.givenName, fullName.familyName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0));
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' ');
}

export function subscribeToAuthChanges(
  callback: (user: User | null) => void,
): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<UserCredential> {
  return signInWithEmailAndPassword(
    auth,
    email.trim(),
    password,
  );
}

export async function registerWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<UserCredential> {
  const credential = await createUserWithEmailAndPassword(
    auth,
    email.trim(),
    password,
  );

  const name = displayName.trim();
  await updateProfile(credential.user, { displayName: name });
  await ensureUserDocument(
    credential.user.uid,
    email.trim(),
    name,
  );

  return credential;
}

export async function loginWithGoogle(): Promise<UserCredential | null> {
  ensureGoogleConfigured();

  await GoogleSignin.hasPlayServices({
    showPlayServicesUpdateDialog: true,
  });

  const response = await GoogleSignin.signIn();
  if (!isSuccessResponse(response)) {
    return null;
  }

  const idToken = response.data.idToken;
  if (!idToken) {
    throw new Error('Google Sign-In did not return an ID token.');
  }

  const credential = GoogleAuthProvider.credential(idToken);
  const userCredential = await signInWithCredential(auth, credential);
  const { user } = userCredential;

  await ensureUserDocument(
    user.uid,
    user.email ?? '',
    user.displayName
      ?? user.email?.split('@')[0]
      ?? 'Player',
  );

  return userCredential;
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    return false;
  }
  return AppleAuthentication.isAvailableAsync();
}

export async function loginWithApple(): Promise<UserCredential | null> {
  const available = await isAppleSignInAvailable();
  if (!available) {
    throw new Error('Sign in with Apple is not available on this device.');
  }

  let appleCredential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    appleCredential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error: unknown) {
    if (
      typeof error === 'object'
      && error != null
      && 'code' in error
      && (error as { code: unknown }).code === 'ERR_REQUEST_CANCELED'
    ) {
      return null;
    }
    throw error;
  }

  if (!appleCredential.identityToken) {
    throw new Error('Apple Sign-In did not return an identity token.');
  }

  const provider = new OAuthProvider('apple.com');
  const credential = provider.credential({
    idToken: appleCredential.identityToken,
  });
  const userCredential = await signInWithCredential(auth, credential);
  const { user } = userCredential;

  const nameFromApple = appleDisplayName(appleCredential.fullName);
  const displayName = user.displayName
    ?? nameFromApple
    ?? user.email?.split('@')[0]
    ?? 'Player';

  if (!user.displayName && nameFromApple) {
    await updateProfile(user, { displayName: nameFromApple });
  }

  await ensureUserDocument(
    user.uid,
    user.email ?? appleCredential.email ?? '',
    displayName,
  );

  return userCredential;
}

export function getGoogleSignInErrorMessage(error: unknown): string {
  if (isErrorWithCode(error)) {
    switch (error.code) {
      case statusCodes.SIGN_IN_CANCELLED:
        return 'Google Sign-In was cancelled.';
      case statusCodes.IN_PROGRESS:
        return 'Google Sign-In is already in progress.';
      case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
        return 'Google Play Services is unavailable or out of date.';
      default:
        break;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Google Sign-In failed. Please try again.';
}

export function getAppleSignInErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error != null
    && 'code' in error
    && (error as { code: unknown }).code === 'ERR_REQUEST_CANCELED'
  ) {
    return 'Sign in with Apple was cancelled.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Sign in with Apple failed. Please try again.';
}

export async function resetPassword(
  email: string,
): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logout(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (uid) {
    await revokePushNotifications(uid);
    await clearGameDayCache(uid);
  }
  try {
    ensureGoogleConfigured();
    if (GoogleSignin.hasPreviousSignIn()) {
      await GoogleSignin.signOut();
    }
  } catch {
    // Continue with Firebase sign-out even if Google sign-out fails.
  }

  await firebaseSignOut(auth);
}

export function getCurrentUser(): User | null {
  return auth.currentUser;
}
