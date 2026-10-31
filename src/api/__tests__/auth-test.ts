const mockSignIn = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateProfile = jest.fn();
const mockSendReset = jest.fn();
const mockSignOut = jest.fn();
const mockOnAuthStateChanged = jest.fn();
const mockSignInWithCredential = jest.fn();
const mockGoogleCredential = jest.fn();
const mockOAuthCredential = jest.fn();
function MockOAuthProvider(this: {
  credential: (...args: unknown[]) => unknown;
}, _providerId: string) {
  this.credential = (...args: unknown[]) => mockOAuthCredential(...args);
}

jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => mockSignIn(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) =>
    mockCreateUser(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  sendPasswordResetEmail: (...args: unknown[]) => mockSendReset(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  onAuthStateChanged: (...args: unknown[]) =>
    mockOnAuthStateChanged(...args),
  signInWithCredential: (...args: unknown[]) =>
    mockSignInWithCredential(...args),
  GoogleAuthProvider: {
    credential: (...args: unknown[]) => mockGoogleCredential(...args),
  },
  OAuthProvider: MockOAuthProvider,
}));

const mockGoogleConfigure = jest.fn();
const mockHasPlayServices = jest.fn();
const mockGoogleSignIn = jest.fn();
const mockGoogleSignOut = jest.fn();
const mockHasPreviousSignIn = jest.fn();

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: (...args: unknown[]) => mockGoogleConfigure(...args),
    hasPlayServices: (...args: unknown[]) => mockHasPlayServices(...args),
    signIn: (...args: unknown[]) => mockGoogleSignIn(...args),
    signOut: (...args: unknown[]) => mockGoogleSignOut(...args),
    hasPreviousSignIn: (...args: unknown[]) =>
      mockHasPreviousSignIn(...args),
  },
  isSuccessResponse: (response: { type?: string }) =>
    response?.type === 'success',
  isErrorWithCode: (error: unknown): error is { code: string } =>
    typeof error === 'object'
    && error != null
    && 'code' in error,
  statusCodes: {
    SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
    SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
    NULL_PRESENTER: 'NULL_PRESENTER',
  },
}));

const mockAppleIsAvailable = jest.fn();
const mockAppleSignIn = jest.fn();

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: (...args: unknown[]) => mockAppleIsAvailable(...args),
  signInAsync: (...args: unknown[]) => mockAppleSignIn(...args),
  AppleAuthenticationScope: {
    FULL_NAME: 0,
    EMAIL: 1,
  },
  AppleAuthenticationButton: () => null,
  AppleAuthenticationButtonType: {
    SIGN_IN: 0,
    SIGN_UP: 1,
  },
  AppleAuthenticationButtonStyle: {
    BLACK: 0,
    WHITE: 1,
  },
}));
const mockRevokePushNotifications = jest.fn();
jest.mock('../../lib/pushRegistration', () => ({ revokePushNotifications: (...args: unknown[]) => mockRevokePushNotifications(...args) }));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mockEnsureUserDocument = jest.fn();
const mockClearGameDayCache = jest.fn();

jest.mock('../../firebase/users', () => ({
  ensureUserDocument: (...args: unknown[]) =>
    mockEnsureUserDocument(...args),
}));
jest.mock('../../lib/gameDayCache', () => ({
  clearGameDayCache: (...args: unknown[]) => mockClearGameDayCache(...args),
}));

const ORIGINAL_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

import {
  getAppleSignInErrorMessage,
  getCurrentUser,
  getGoogleSignInErrorMessage,
  isAppleSignInAvailable,
  loginWithApple,
  loginWithEmail,
  loginWithGoogle,
  logout,
  PUSH_REVOCATION_TIMEOUT_MS,
  registerWithEmail,
  resetPassword,
  subscribeToAuthChanges,
} from '../auth';

import {
  auth,
} from '../../firebase/config';

describe('api/auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as { currentUser: unknown }).currentUser = null;
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID =
      'test-web-client-id.apps.googleusercontent.com';
    mockHasPlayServices.mockResolvedValue(true);
    mockHasPreviousSignIn.mockReturnValue(false);
    mockAppleIsAvailable.mockResolvedValue(true);
    mockClearGameDayCache.mockResolvedValue(undefined);
    mockRevokePushNotifications.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = ORIGINAL_WEB_CLIENT_ID;
  });

  it('subscribes to auth changes', () => {
    const cb = jest.fn();
    const unsub = jest.fn();
    mockOnAuthStateChanged.mockReturnValue(unsub);
    expect(subscribeToAuthChanges(cb)).toBe(unsub);
    expect(mockOnAuthStateChanged).toHaveBeenCalledWith(auth, cb);
  });

  it('logs in with trimmed email', async () => {
    mockSignIn.mockResolvedValue({ user: { uid: '1' } });
    await loginWithEmail('  a@b.com ', 'secret');
    expect(mockSignIn).toHaveBeenCalledWith(auth, 'a@b.com', 'secret');
  });

  it('registers, updates profile, and ensures user doc', async () => {
    const user = { uid: 'u1' };
    mockCreateUser.mockResolvedValue({ user });
    mockUpdateProfile.mockResolvedValue(undefined);
    mockEnsureUserDocument.mockResolvedValue({});

    await registerWithEmail('a@b.com', 'secret1', '  Alex ');

    expect(mockCreateUser).toHaveBeenCalledWith(
      auth,
      'a@b.com',
      'secret1',
    );
    expect(mockUpdateProfile).toHaveBeenCalledWith(user, {
      displayName: 'Alex',
    });
    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u1',
      'a@b.com',
      'Alex',
    );
  });

  it('signs in with Google and ensures user doc', async () => {
    mockGoogleSignIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'google-id-token',
        user: {
          id: 'g1',
          email: 'player@gmail.com',
          name: 'Alex Player',
          photo: null,
          familyName: null,
          givenName: null,
        },
        scopes: [],
        serverAuthCode: null,
      },
    });
    mockGoogleCredential.mockReturnValue({ providerId: 'google.com' });
    const firebaseUser = {
      uid: 'u-google',
      email: 'player@gmail.com',
      displayName: 'Alex Player',
    };
    mockSignInWithCredential.mockResolvedValue({ user: firebaseUser });
    mockEnsureUserDocument.mockResolvedValue({});

    const result = await loginWithGoogle();

    expect(mockGoogleConfigure).toHaveBeenCalledWith({
      webClientId: 'test-web-client-id.apps.googleusercontent.com',
    });
    expect(mockGoogleCredential).toHaveBeenCalledWith('google-id-token');
    expect(mockSignInWithCredential).toHaveBeenCalledWith(
      auth,
      { providerId: 'google.com' },
    );
    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u-google',
      'player@gmail.com',
      'Alex Player',
    );
    expect(result?.user).toEqual(firebaseUser);
  });

  it('returns null when Google Sign-In is cancelled', async () => {
    mockGoogleSignIn.mockResolvedValue({ type: 'cancelled' });
    await expect(loginWithGoogle()).resolves.toBeNull();
    expect(mockSignInWithCredential).not.toHaveBeenCalled();
  });

  it('throws when Google Sign-In omits an ID token', async () => {
    mockGoogleSignIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: null,
        user: {
          id: 'g1',
          email: 'player@gmail.com',
          name: null,
          photo: null,
          familyName: null,
          givenName: null,
        },
        scopes: [],
        serverAuthCode: null,
      },
    });

    await expect(loginWithGoogle()).rejects.toThrow(
      'Google Sign-In did not return an ID token.',
    );
  });

  it('falls back to email local-part when Google user has no display name', async () => {
    mockGoogleSignIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'token-2',
        user: {
          id: 'g2',
          email: 'noname@gmail.com',
          name: null,
          photo: null,
          familyName: null,
          givenName: null,
        },
        scopes: [],
        serverAuthCode: null,
      },
    });
    mockGoogleCredential.mockReturnValue({ providerId: 'google.com' });
    mockSignInWithCredential.mockResolvedValue({
      user: {
        uid: 'u2',
        email: 'noname@gmail.com',
        displayName: null,
      },
    });
    mockEnsureUserDocument.mockResolvedValue({});

    await loginWithGoogle();

    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u2',
      'noname@gmail.com',
      'noname',
    );
  });

  it('falls back to Player when Google user has no email or display name', async () => {
    mockGoogleSignIn.mockResolvedValue({
      type: 'success',
      data: {
        idToken: 'token-3',
        user: {
          id: 'g3',
          email: '',
          name: null,
          photo: null,
          familyName: null,
          givenName: null,
        },
        scopes: [],
        serverAuthCode: null,
      },
    });
    mockGoogleCredential.mockReturnValue({ providerId: 'google.com' });
    mockSignInWithCredential.mockResolvedValue({
      user: {
        uid: 'u3',
        email: null,
        displayName: null,
      },
    });
    mockEnsureUserDocument.mockResolvedValue({});

    await loginWithGoogle();

    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u3',
      '',
      'Player',
    );
  });

  it('maps Google Sign-In error codes to messages', () => {
    expect(
      getGoogleSignInErrorMessage({ code: 'SIGN_IN_CANCELLED' }),
    ).toBe('Google Sign-In was cancelled.');
    expect(
      getGoogleSignInErrorMessage({ code: 'IN_PROGRESS' }),
    ).toBe('Google Sign-In is already in progress.');
    expect(
      getGoogleSignInErrorMessage({
        code: 'PLAY_SERVICES_NOT_AVAILABLE',
      }),
    ).toBe('Google Play Services is unavailable or out of date.');
    expect(
      getGoogleSignInErrorMessage({ code: 'UNKNOWN', message: 'nope' }),
    ).toBe('Google Sign-In failed. Please try again.');
    expect(
      getGoogleSignInErrorMessage(new Error('Network down')),
    ).toBe('Network down');
    expect(getGoogleSignInErrorMessage('boom')).toBe(
      'Google Sign-In failed. Please try again.',
    );
  });

  it('throws when Google web client id is missing', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = '';
      // Re-require against a fresh module so googleConfigured starts false.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const freshAuth = require('../auth') as typeof import('../auth');
      await expect(freshAuth.loginWithGoogle()).rejects.toThrow(
        'Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
      );
    });
  });

  it('reports Apple Sign-In availability on iOS', async () => {
    mockAppleIsAvailable.mockResolvedValue(true);
    await expect(isAppleSignInAvailable()).resolves.toBe(true);
  });

  it('signs in with Apple and uses Apple full name on first sign-in', async () => {
    mockAppleSignIn.mockResolvedValue({
      identityToken: 'apple-id-token',
      email: 'hidden@privaterelay.appleid.com',
      fullName: {
        givenName: 'Alex',
        familyName: 'Coach',
      },
    });
    mockOAuthCredential.mockReturnValue({ providerId: 'apple.com' });
    const firebaseUser = {
      uid: 'u-apple',
      email: 'hidden@privaterelay.appleid.com',
      displayName: null,
    };
    mockSignInWithCredential.mockResolvedValue({ user: firebaseUser });
    mockUpdateProfile.mockResolvedValue(undefined);
    mockEnsureUserDocument.mockResolvedValue({});

    const result = await loginWithApple();

    expect(MockOAuthProvider).toBeDefined();
    expect(mockOAuthCredential).toHaveBeenCalledWith({
      idToken: 'apple-id-token',
    });
    expect(mockUpdateProfile).toHaveBeenCalledWith(firebaseUser, {
      displayName: 'Alex Coach',
    });
    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u-apple',
      'hidden@privaterelay.appleid.com',
      'Alex Coach',
    );
    expect(result?.user).toEqual(firebaseUser);
  });

  it('returns null when Apple Sign-In is cancelled', async () => {
    mockAppleSignIn.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });
    await expect(loginWithApple()).resolves.toBeNull();
    expect(mockSignInWithCredential).not.toHaveBeenCalled();
  });

  it('throws when Apple Sign-In omits an identity token', async () => {
    mockAppleSignIn.mockResolvedValue({
      identityToken: null,
      email: null,
      fullName: null,
    });
    await expect(loginWithApple()).rejects.toThrow(
      'Apple Sign-In did not return an identity token.',
    );
  });

  it('throws when Apple Sign-In is unavailable', async () => {
    mockAppleIsAvailable.mockResolvedValue(false);
    await expect(loginWithApple()).rejects.toThrow(
      'Sign in with Apple is not available on this device.',
    );
  });

  it('falls back to email local-part when Apple provides no name', async () => {
    mockAppleSignIn.mockResolvedValue({
      identityToken: 'apple-id-token-2',
      email: 'relay@privaterelay.appleid.com',
      fullName: {
        givenName: null,
        familyName: null,
      },
    });
    mockOAuthCredential.mockReturnValue({ providerId: 'apple.com' });
    mockSignInWithCredential.mockResolvedValue({
      user: {
        uid: 'u-apple-2',
        email: 'relay@privaterelay.appleid.com',
        displayName: null,
      },
    });
    mockEnsureUserDocument.mockResolvedValue({});

    await loginWithApple();

    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockEnsureUserDocument).toHaveBeenCalledWith(
      'u-apple-2',
      'relay@privaterelay.appleid.com',
      'relay',
    );
  });

  it('rethrows non-cancel Apple Sign-In errors', async () => {
    mockAppleSignIn.mockRejectedValue(new Error('apple boom'));
    await expect(loginWithApple()).rejects.toThrow('apple boom');
  });

  it('maps Apple Sign-In error messages', () => {
    expect(
      getAppleSignInErrorMessage({ code: 'ERR_REQUEST_CANCELED' }),
    ).toBe('Sign in with Apple was cancelled.');
    expect(getAppleSignInErrorMessage(new Error('boom'))).toBe('boom');
    expect(getAppleSignInErrorMessage('x')).toBe(
      'Sign in with Apple failed. Please try again.',
    );
  });

  it('sends password reset', async () => {
    mockSendReset.mockResolvedValue(undefined);
    await resetPassword(' a@b.com ');
    expect(mockSendReset).toHaveBeenCalledWith(auth, 'a@b.com');
  });

  it('logs out Firebase and Google when previously signed in', async () => {
    mockHasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignOut.mockResolvedValue(null);
    mockSignOut.mockResolvedValue(undefined);

    await logout();

    expect(mockGoogleSignOut).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith(auth);
    expect(getCurrentUser()).toBeNull();
  });

  it('clears the signed-in account cache before Firebase sign-out', async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: 'cached-user' };
    mockSignOut.mockResolvedValue(undefined);

    await logout();

    expect(mockClearGameDayCache).toHaveBeenCalledWith('cached-user');
    expect(mockClearGameDayCache.mock.invocationCallOrder[0]).toBeLessThan(
      mockSignOut.mock.invocationCallOrder[0],
    );
  });

  it('does not sign out when durable cache cleanup fails', async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: 'cached-user' };
    mockClearGameDayCache.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(logout()).rejects.toThrow('storage unavailable');
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('still clears cache and signs out when endpoint revocation is unavailable', async () => {
    (auth as { currentUser: unknown }).currentUser = { uid: 'cached-user' };
    mockRevokePushNotifications.mockRejectedValueOnce(new Error('functions unavailable'));
    mockSignOut.mockResolvedValue(undefined);

    await logout();

    expect(mockClearGameDayCache).toHaveBeenCalledWith('cached-user');
    expect(mockSignOut).toHaveBeenCalledWith(auth);
  });

  it('signs out after a bounded wait when endpoint revocation never settles', async () => {
    jest.useFakeTimers();
    try {
      (auth as { currentUser: unknown }).currentUser = { uid: 'cached-user' };
      mockRevokePushNotifications.mockReturnValueOnce(new Promise(() => undefined));
      mockSignOut.mockResolvedValue(undefined);

      let settled = false;
      const pending = logout().then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(PUSH_REVOCATION_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(mockSignOut).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await pending;

      expect(mockClearGameDayCache).toHaveBeenCalledWith('cached-user');
      expect(mockClearGameDayCache.mock.invocationCallOrder[0]).toBeLessThan(
        mockSignOut.mock.invocationCallOrder[0],
      );
      expect(mockSignOut).toHaveBeenCalledWith(auth);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still signs out of Firebase if Google sign-out fails', async () => {
    mockHasPreviousSignIn.mockReturnValue(true);
    mockGoogleSignOut.mockRejectedValue(new Error('google down'));
    mockSignOut.mockResolvedValue(undefined);

    await logout();

    expect(mockSignOut).toHaveBeenCalledWith(auth);
  });
});
