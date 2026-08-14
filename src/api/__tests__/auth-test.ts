const mockSignIn = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateProfile = jest.fn();
const mockSendReset = jest.fn();
const mockSignOut = jest.fn();
const mockOnAuthStateChanged = jest.fn();

jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => mockSignIn(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) =>
    mockCreateUser(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  sendPasswordResetEmail: (...args: unknown[]) => mockSendReset(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  onAuthStateChanged: (...args: unknown[]) =>
    mockOnAuthStateChanged(...args),
}));

const mockEnsureUserDocument = jest.fn();

jest.mock('../../firebase/users', () => ({
  ensureUserDocument: (...args: unknown[]) =>
    mockEnsureUserDocument(...args),
}));

import {
  getCurrentUser,
  loginWithEmail,
  logout,
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

  it('sends password reset', async () => {
    mockSendReset.mockResolvedValue(undefined);
    await resetPassword(' a@b.com ');
    expect(mockSendReset).toHaveBeenCalledWith(auth, 'a@b.com');
  });

  it('logs out and reads current user', async () => {
    mockSignOut.mockResolvedValue(undefined);
    await logout();
    expect(mockSignOut).toHaveBeenCalledWith(auth);
    expect(getCurrentUser()).toBeNull();
  });
});
