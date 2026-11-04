const mockNativeTeam = jest.fn();
jest.mock('firebase/functions', () => ({ httpsCallable: () => mockNativeTeam }));
const mockRunCommand = jest.fn();
jest.mock('../commands', () => ({ runCommand: (...args: unknown[]) => mockRunCommand(...args) }));
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
  listAllTeams,
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
    expect(mapTeamDoc('canonical', {
      schemaVersion: 2, name: 'Falcons', orgId: 'org', divisionId: 'u12', sport: null,
      createdAt: new Date(), updatedAt: new Date(),
    })).toMatchObject({ orgId: 'org', divisionId: 'u12', schemaVersion: 2 });

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




  it('lists all teams for super admin', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ items: [{ id: 't2', name: 'Wolves' }], nextCursor: 't2' })
      .mockResolvedValueOnce({ items: [{ id: 't1', name: 'Tigers' }], nextCursor: null });
    const teams = await listAllTeams();
    expect(teams.map((x) => x.name)).toEqual(['Tigers', 'Wolves']);
    expect(mockRunCommand).toHaveBeenNthCalledWith(1, 'listLegacyTeams', { pageSize: 50, cursor: null });
    expect(mockRunCommand).toHaveBeenNthCalledWith(2, 'listLegacyTeams', { pageSize: 50, cursor: 't2' });
  });

  it('resolves preferred team for super admin without membership', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    mockGetDoc.mockResolvedValue({
      id: 't1',
      exists: () => true,
      data: () => ({
        name: 'Tigers',
        inviteCode: 'ABCD2345',
        createdBy: 'c1',
        sport: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const resolved = await resolveActiveMembership('super1', 't1', {
      isSuperAdmin: true,
      displayName: 'Orkun',
    });
    expect(resolved?.membership.id).toBe('super_t1_super1');
    expect(resolved?.membership.role).toBe('coach');
  });

  it('routes mutations through server commands without trusting client identity or privileges', async () => {
    const team = { id: 't1', name: 'Tigers', inviteCode: 'ABCD2345' };
    const membership = { id: 't1_actor', role: 'coach', userId: 'actor', teamId: 't1' };
    mockRunCommand.mockResolvedValueOnce({ team, membership });
    const created = await createTeam({ name: ' Tigers ', userId: 'forged', displayName: 'Ignored' });
    expect(created.team.id).toBe('t1');
    expect(created.membership.userId).toBe('actor');
    expect(created.inviteDeepLink).toContain('ABCD2345');
    expect(mockRunCommand).toHaveBeenLastCalledWith('createTeam', { name: 'Tigers', sport: null });
    mockRunCommand.mockResolvedValueOnce({ team, membership: { ...membership, role: 'player' } });
    expect((await joinTeamWithInviteCode({ code: 'abcd2345', userId: 'forged', displayName: 'Ignored' })).membership.role).toBe('player');
    expect(mockRunCommand).toHaveBeenLastCalledWith('joinTeamWithInvite', { code: 'ABCD2345' });
    mockRunCommand.mockResolvedValueOnce({ inviteCode: 'ABCDEFGH' });
    expect((await regenerateInviteCode({ teamId: 't1', userId: 'forged', isSuperAdmin: true })).inviteCode).toBe('ABCDEFGH');
    expect(mockRunCommand).toHaveBeenLastCalledWith('regenerateInvite', { teamId: 't1' });
    await updateTeamName('t1', ' New ');
    expect(mockRunCommand).toHaveBeenLastCalledWith('renameTeam', { teamId: 't1', name: 'New' });
    mockRunCommand.mockRejectedValueOnce(new Error('Invite code is invalid or no longer active.'));
    await expect(joinTeamWithInviteCode({ code: 'AAAAAAAA', userId: 'u', displayName: 'u' })).rejects.toThrow('no longer active');
    expect(mockSetDoc).not.toHaveBeenCalled();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockWriteBatch).not.toHaveBeenCalled();
  });

test('canonical teams use authorized callable fallback and revoked roles do not become coach', async () => {
  mockGetDoc.mockRejectedValueOnce({ code: 'permission-denied' });
  mockNativeTeam.mockResolvedValue({ data: { id: 'canonical', name: 'Falcons', schemaVersion: 2, timeZone: 'America/Phoenix' } });
  expect(await getTeam('canonical')).toEqual(expect.objectContaining({ schemaVersion: 2, timeZone: 'America/Phoenix' }));
  mockGetDoc.mockRejectedValueOnce(new Error('Offline'));
  await expect(getTeam('canonical')).rejects.toThrow('Offline');
  expect(mapMemberDoc('member', { schemaVersion: 2, role: 'coach', roles: ['coach'], status: 'revoked' }).role).toBe('player');
  expect(mapMemberDoc('member', { schemaVersion: 2, roles: ['coach'], status: 'active' }).role).toBe('coach');
});


it('maps active canonical captains to native management controls and rejects revoked or legacy spoofed roles', () => {
  expect(mapMemberDoc('member', { schemaVersion: 2, roles: ['captain'], status: 'active' }).role).toBe('coach');
  expect(mapMemberDoc('member', { schemaVersion: 2, roles: ['captain'], status: 'revoked' }).role).toBe('player');
  expect(mapMemberDoc('member', { roles: ['captain'], role: 'player' }).role).toBe('player');
  expect(mapMemberDoc('member', { schemaVersion: 2, roles: ['parent', 7], status: 'active' }).roles).toEqual(['parent']);
  expect(mapMemberDoc('member', { schemaVersion: 2, roles: ['parent'], status: 'revoked' }).roles).toBeUndefined();
});

it('ignores revoked canonical preferred assignments and resolves an active team', async () => {
  jest.resetAllMocks();
  mockGetDocs.mockResolvedValue({ docs: [
    { id: 'revoked_u', data: () => ({ schemaVersion: 2, teamId: 'revoked', userId: 'u', roles: ['coach'], status: 'revoked' }) },
    { id: 'active_u', data: () => ({ schemaVersion: 2, teamId: 'active', userId: 'u', roles: ['captain'], status: 'active' }) },
    { id: 'pending_u', data: () => ({ schemaVersion: 2, teamId: 'pending', userId: 'u', roles: ['coach'], status: 'pending' }) },
  ] });
  mockGetDoc.mockRejectedValue({ code: 'permission-denied' });
  mockNativeTeam.mockResolvedValue({ data: { id: 'active', schemaVersion: 2, name: 'Active team' } });
  expect(await resolveActiveMembership('u', 'revoked')).toEqual(expect.objectContaining({
    membership: expect.objectContaining({ teamId: 'active', role: 'coach' }),
    team: expect.objectContaining({ name: 'Active team' }),
  }));
  expect(mockNativeTeam).toHaveBeenCalledTimes(1);
  expect(mockNativeTeam).toHaveBeenCalledWith({ teamId: 'active' });
});

it('falls back after a grant is revoked between discovery and the live canonical team read', async () => {
  jest.resetAllMocks();
  mockGetDocs.mockResolvedValue({ docs: ['first', 'second'].map(teamId => ({ id: teamId, data: () => ({ schemaVersion: 2, teamId, userId: 'u', roles: ['coach'], status: 'active' }) })) });
  mockGetDoc.mockRejectedValue({ code: 'permission-denied' });
  mockNativeTeam.mockRejectedValueOnce({ code: 'functions/permission-denied' }).mockResolvedValueOnce({ data: { id: 'second', schemaVersion: 2, name: 'Still authorized' } });
  expect((await resolveActiveMembership('u', 'first'))?.team.id).toBe('second');
  mockNativeTeam.mockRejectedValue({ code: 'functions/permission-denied' });
  expect(await resolveActiveMembership('u', 'first')).toBeNull();
  mockNativeTeam.mockRejectedValue(new Error('Service unavailable'));
  await expect(resolveActiveMembership('u', 'first')).rejects.toThrow('Service unavailable');
});

it('single revoked canonical membership reads return null', async () => {
  jest.resetAllMocks();
  mockGetDoc.mockResolvedValue({ exists: () => true, id: 't_u', data: () => ({ schemaVersion: 2, status: 'revoked', roles: ['coach'] }) });
  expect(await getMembership('t', 'u')).toBeNull();
});
