const mockGetDoc = jest.fn();
const mockSetDoc = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDoc = jest.fn((...args: unknown[]) => ({ path: args.join('/') }));

jest.mock('firebase/firestore', () => ({
  doc: (...args: unknown[]) => (mockDoc as Function)(...args),
  getDoc: (...args: unknown[]) => (mockGetDoc as Function)(...args),
  setDoc: (...args: unknown[]) => (mockSetDoc as Function)(...args),
  updateDoc: (...args: unknown[]) => (mockUpdateDoc as Function)(...args),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
}));

import {
  ensureUserDocument,
  getUserDocument,
  mapUserDoc,
  setActiveTeamId,
  updateUserDisplayName,
  setUserAppRole,
} from '../users';

import {
  db,
} from '../config';

describe('firebase/users', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps user documents with assorted date shapes', () => {
    const withDate = mapUserDoc('u1', {
      email: 'a@b.com',
      displayName: 'Alex',
      appRole: 'superAdmin',
      activeTeamId: 't1',
      createdAt: new Date('2026-01-01'),
      updatedAt: '2026-01-02',
    });
    expect(withDate.uid).toBe('u1');
    expect(withDate.activeTeamId).toBe('t1');
    expect(withDate.appRole).toBe('superAdmin');

    const withToDate = mapUserDoc('u2', {
      email: 'b@c.com',
      displayName: 'Pat',
      activeTeamId: null,
      createdAt: { toDate: () => new Date('2026-02-01') },
      updatedAt: 1700000000000,
    });
    expect(withToDate.displayName).toBe('Pat');
    expect(withToDate.activeTeamId).toBeNull();

    const fallback = mapUserDoc('u3', {
      email: '',
      displayName: '',
      createdAt: null,
      updatedAt: undefined,
    });
    expect(fallback.email).toBe('');
    expect(fallback.createdAt).toBeInstanceOf(Date);
  });

  it('returns null when user missing', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });
    await expect(getUserDocument('u1')).resolves.toBeNull();
  });

  it('returns existing user without rewriting', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'a@b.com',
        displayName: 'Alex',
        activeTeamId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const user = await ensureUserDocument('u1', 'a@b.com', 'Alex');
    expect(user.displayName).toBe('Alex');
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('creates user document when missing', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });
    mockSetDoc.mockResolvedValue(undefined);
    const user = await ensureUserDocument('u1', 'a@b.com', 'Alex');
    expect(user.uid).toBe('u1');
    expect(mockSetDoc).toHaveBeenCalled();
    expect(mockDoc).toHaveBeenCalledWith(db, 'users', 'u1');
  });

  it('updates display name and active team', async () => {
    mockUpdateDoc.mockResolvedValue(undefined);
    await updateUserDisplayName('u1', '  New ');
    await setActiveTeamId('u1', 't9');
    await setActiveTeamId('u1', null);
    expect(mockUpdateDoc).toHaveBeenCalledTimes(3);
  });
});


  it('defaults appRole to user and can set app role', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });
    mockSetDoc.mockResolvedValue(undefined);
    const user = await ensureUserDocument('u1', 'a@b.com', 'Alex');
    expect(user.appRole).toBe('user');
    mockUpdateDoc.mockResolvedValue(undefined);
    await setUserAppRole('u1', 'superAdmin');
    expect(mockUpdateDoc).toHaveBeenCalled();
  });
