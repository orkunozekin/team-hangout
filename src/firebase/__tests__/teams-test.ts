const mockGetDoc = jest.fn();
const mockGetDocs = jest.fn();
const mockSetDoc = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDoc = jest.fn((...args: unknown[]) => ({
  id: typeof args[2] === 'string' ? args[2] : 'generated-id',
  path: args.join('/'),
}));
const mockCollection = jest.fn(() => ({ id: 'col' }));
const mockQuery = jest.fn((...args: unknown[]) => args);
const mockWhere = jest.fn((...args: unknown[]) => args);
const mockWriteBatch = jest.fn();
const mockSetActiveTeamId = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => (mockCollection as Function)(...args),
  doc: (...args: unknown[]) => (mockDoc as Function)(...args),
  getDoc: (...args: unknown[]) => (mockGetDoc as Function)(...args),
  getDocs: (...args: unknown[]) => (mockGetDocs as Function)(...args),
  query: (...args: unknown[]) => (mockQuery as Function)(...args),
  setDoc: (...args: unknown[]) => (mockSetDoc as Function)(...args),
  updateDoc: (...args: unknown[]) => (mockUpdateDoc as Function)(...args),
  where: (...args: unknown[]) => (mockWhere as Function)(...args),
  writeBatch: (...args: unknown[]) => (mockWriteBatch as Function)(...args),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  Timestamp: class {
    static fromDate(d: Date) {
      return d;
    }
  },
}));

jest.mock('../users', () => ({
  setActiveTeamId: (...args: unknown[]) =>
    (mockSetActiveTeamId as Function)(...args),
}));

import {
  createTeam,
  getMembership,
  getTeam,
  joinTeamWithInviteCode,
  listTeamMembers,
  mapMemberDoc,
  mapTeamDoc,
  regenerateInviteCode,
  resolveActiveMembership,
  updateTeamName,
} from '../teams';

describe('firebase/teams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps team and member docs', () => {
    expect(
      mapTeamDoc('t1', {
        name: 'Tigers',
        sport: 'soccer',
        inviteCode: 'ABCD2345',
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).name,
    ).toBe('Tigers');

    expect(
      mapMemberDoc('t1_u1', {
        teamId: 't1',
        userId: 'u1',
        role: 'coach',
        displayName: 'Alex',
        joinedAt: new Date(),
      }).role,
    ).toBe('coach');
  });

  it('returns null for missing team/membership', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });
    await expect(getTeam('t1')).resolves.toBeNull();
    await expect(getMembership('t1', 'u1')).resolves.toBeNull();
  });

  it('creates a team with invite code and coach membership', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => false });
    const batch = {
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    mockWriteBatch.mockReturnValue(batch);
    mockDoc.mockImplementation((...args: unknown[]) => {
      if (args.length === 1) {
        return { id: 'team-1', path: 'teams/team-1' };
      }
      if (args[1] === 'teams' && args.length === 2) {
        return { id: 'team-1', path: 'teams/team-1' };
      }
      return {
        id: String(args[2] ?? 'x'),
        path: args.join('/'),
      };
    });
    mockSetActiveTeamId.mockResolvedValue(undefined);

    const result = await createTeam({
      name: 'Tigers',
      userId: 'u1',
      displayName: 'Alex',
    });

    expect(result.team.id).toBe('team-1');
    expect(result.membership.role).toBe('coach');
    expect(result.inviteDeepLink).toContain('teamhangout://join?code=');
    expect(batch.commit).toHaveBeenCalled();
    expect(mockSetActiveTeamId).toHaveBeenCalledWith('u1', 'team-1');
  });

  it('joins with invite code as player', async () => {
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 't1', code: 'ABCD2345' }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          name: 'Tigers',
          inviteCode: 'ABCD2345',
          createdBy: 'coach',
          sport: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      })
      .mockResolvedValueOnce({ exists: () => false });

    mockSetDoc.mockResolvedValue(undefined);
    mockSetActiveTeamId.mockResolvedValue(undefined);

    const result = await joinTeamWithInviteCode({
      code: 'abcd2345',
      userId: 'u2',
      displayName: 'Pat',
    });

    expect(result.membership.role).toBe('player');
    expect(result.team.name).toBe('Tigers');
  });

  it('rejects invalid invite format', async () => {
    await expect(
      joinTeamWithInviteCode({
        code: 'bad',
        userId: 'u2',
        displayName: 'Pat',
      }),
    ).rejects.toThrow('Invalid invite code format');
  });

  it('lists members sorted with coaches first', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 't1_u2',
          data: () => ({
            teamId: 't1',
            userId: 'u2',
            role: 'player',
            displayName: 'Zed',
            joinedAt: new Date(),
          }),
        },
        {
          id: 't1_u1',
          data: () => ({
            teamId: 't1',
            userId: 'u1',
            role: 'coach',
            displayName: 'Ann',
            joinedAt: new Date(),
          }),
        },
      ],
    });

    const members = await listTeamMembers('t1');
    expect(members.map((m) => m.userId)).toEqual(['u1', 'u2']);
  });

  it('regenerates invite codes for coaches only', async () => {
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          teamId: 't1',
          userId: 'u1',
          role: 'coach',
          displayName: 'Alex',
          joinedAt: new Date(),
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          name: 'Tigers',
          inviteCode: 'OLDCODE1',
          createdBy: 'u1',
          sport: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      })
      .mockResolvedValue({ exists: () => false });

    const batch = {
      delete: jest.fn(),
      set: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    mockWriteBatch.mockReturnValue(batch);

    const result = await regenerateInviteCode({
      teamId: 't1',
      userId: 'u1',
    });
    expect(result.inviteCode).toHaveLength(8);
    expect(batch.commit).toHaveBeenCalled();
  });

  it('resolves active membership', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 't1_u1',
          data: () => ({
            teamId: 't1',
            userId: 'u1',
            role: 'player',
            displayName: 'Alex',
            joinedAt: new Date(),
          }),
        },
      ],
    });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        name: 'Tigers',
        inviteCode: 'ABCD2345',
        createdBy: 'coach',
        sport: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });

    const resolved = await resolveActiveMembership('u1', 't1');
    expect(resolved?.team.name).toBe('Tigers');
  });
});

  it('handles join error paths and existing membership', async () => {
    mockGetDoc.mockResolvedValueOnce({ exists: () => false });
    await expect(
      joinTeamWithInviteCode({
        code: 'ABCD2345',
        userId: 'u2',
        displayName: 'Pat',
      }),
    ).rejects.toThrow('Invite code not found');

    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: '', code: 'ABCD2345' }),
      });
    await expect(
      joinTeamWithInviteCode({
        code: 'ABCD2345',
        userId: 'u2',
        displayName: 'Pat',
      }),
    ).rejects.toThrow('Invite code is invalid');

    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 't1', code: 'ABCD2345' }),
      })
      .mockResolvedValueOnce({ exists: () => false });
    await expect(
      joinTeamWithInviteCode({
        code: 'ABCD2345',
        userId: 'u2',
        displayName: 'Pat',
      }),
    ).rejects.toThrow('Team not found');

    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 't1', code: 'ABCD2345' }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          name: 'Tigers',
          inviteCode: 'OTHER123',
          createdBy: 'coach',
          sport: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });
    await expect(
      joinTeamWithInviteCode({
        code: 'ABCD2345',
        userId: 'u2',
        displayName: 'Pat',
      }),
    ).rejects.toThrow('Invite code is no longer active');

    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 't1', code: 'ABCD2345' }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          name: 'Tigers',
          inviteCode: 'ABCD2345',
          createdBy: 'coach',
          sport: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          teamId: 't1',
          userId: 'u2',
          role: 'player',
          displayName: 'Pat',
          joinedAt: new Date(),
        }),
      });
    mockSetActiveTeamId.mockResolvedValue(undefined);
    const existing = await joinTeamWithInviteCode({
      code: 'ABCD2345',
      userId: 'u2',
      displayName: 'Pat',
    });
    expect(existing.membership.role).toBe('player');
  });

  it('blocks non-coach invite regeneration and missing team', async () => {
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        teamId: 't1',
        userId: 'u2',
        role: 'player',
        displayName: 'Pat',
        joinedAt: new Date(),
      }),
    });
    await expect(
      regenerateInviteCode({ teamId: 't1', userId: 'u2' }),
    ).rejects.toThrow('Only coaches can regenerate invite codes');

    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          teamId: 't1',
          userId: 'u1',
          role: 'coach',
          displayName: 'Alex',
          joinedAt: new Date(),
        }),
      })
      .mockResolvedValueOnce({ exists: () => false });
    await expect(
      regenerateInviteCode({ teamId: 't1', userId: 'u1' }),
    ).rejects.toThrow('Team not found');
  });

  it('returns null when user has no memberships', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    await expect(resolveActiveMembership('u1')).resolves.toBeNull();
  });

  it('falls back to first membership when preferred missing', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 't2_u1',
          data: () => ({
            teamId: 't2',
            userId: 'u1',
            role: 'player',
            displayName: 'Alex',
            joinedAt: new Date(),
          }),
        },
      ],
    });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        name: 'Wolves',
        inviteCode: 'WOLF1234',
        createdBy: 'c1',
        sport: 'basketball',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const resolved = await resolveActiveMembership('u1', 'missing');
    expect(resolved?.team.name).toBe('Wolves');
  });

  it('throws when unique invite allocation fails', async () => {
    mockGetDoc.mockResolvedValue({ exists: () => true });
    await expect(
      createTeam({
        name: 'Tigers',
        userId: 'u1',
        displayName: 'Alex',
      }),
    ).rejects.toThrow('Could not allocate a unique invite code');
  });


  it('updates team name', async () => {
    mockUpdateDoc.mockResolvedValue(undefined);
    await updateTeamName('t1', '  New Name ');
    expect(mockUpdateDoc).toHaveBeenCalled();
  });

  it('returns null when preferred membership team is missing', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 't1_u1',
          data: () => ({
            teamId: 't1',
            userId: 'u1',
            role: 'player',
            displayName: 'Alex',
            joinedAt: new Date(),
          }),
        },
      ],
    });
    mockGetDoc.mockResolvedValue({ exists: () => false });
    await expect(resolveActiveMembership('u1', 't1')).resolves.toBeNull();
  });
