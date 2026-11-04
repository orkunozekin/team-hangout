process.env.EXPO_PUBLIC_FIREBASE_API_KEY =
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'test-api-key';

process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN =
  process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ??
  'test.firebaseapp.com';

process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID =
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? 'test-project';

process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET =
  process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ??
  'test.appspot.com';

process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID =
  process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??
  '1234567890';

process.env.EXPO_PUBLIC_FIREBASE_APP_ID =
  process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '1:1234567890:web:test';

jest.mock('./src/firebase/config', () => ({
  auth: {
    currentUser: null,
  },
  db: {},
  functions: {},
}));

// Icon fonts load through the native asset registry, which jest does not provide.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
