import {
  initializeApp,
  getApps,
} from 'firebase/app';

import {
  getAuth,
  initializeAuth,
  // getReactNativePersistence ships in Firebase's React Native bundle but is
  // not present in the default (web) type declarations, so we pull it in via
  // require below to keep TypeScript happy.
} from 'firebase/auth';

import {
  getFunctions,
} from 'firebase/functions';

import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';

import {
  getFirestore,
} from 'firebase/firestore';

const { getReactNativePersistence } =
  require('firebase/auth') as {
    getReactNativePersistence: (
      storage: typeof ReactNativeAsyncStorage,
    ) => unknown;
  };

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const isFirstInit = getApps().length === 0;
const app = isFirstInit ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = isFirstInit
  ? initializeAuth(app, {
      persistence: getReactNativePersistence(
        ReactNativeAsyncStorage,
      ) as never,
    })
  : getAuth(app);

export const db = getFirestore(app);

export const functions = getFunctions(app);
