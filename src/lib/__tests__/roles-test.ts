import {
  buildSyntheticCoachMembership,
  canManageTeam,
  displayTeamRole,
  isSuperAdminRole,
  parseAppRole,
} from '../roles';

describe('roles', () => {
  it('parses app roles', () => {
    expect(parseAppRole('superAdmin')).toBe('superAdmin');
    expect(parseAppRole('user')).toBe('user');
    expect(parseAppRole('nope')).toBe('user');
    expect(parseAppRole(undefined)).toBe('user');
  });

  it('detects super admins', () => {
    expect(isSuperAdminRole('superAdmin')).toBe(true);
    expect(isSuperAdminRole('user')).toBe(false);
    expect(isSuperAdminRole(null)).toBe(false);
  });

  it('grants manage access to coaches and super admins', () => {
    const coach = {
      id: 't1_u1',
      teamId: 't1',
      userId: 'u1',
      role: 'coach' as const,
      displayName: 'Alex',
      joinedAt: new Date(),
    };
    const player = { ...coach, role: 'player' as const };

    expect(canManageTeam({ membership: coach })).toBe(true);
    expect(canManageTeam({ membership: player })).toBe(false);
    expect(
      canManageTeam({ membership: player, appRole: 'superAdmin' }),
    ).toBe(true);
    expect(canManageTeam({ membership: null, appRole: 'superAdmin' })).toBe(
      true,
    );
  });

  it('formats display roles', () => {
    expect(displayTeamRole({ role: 'player' })).toBe('Player');
    expect(displayTeamRole({ role: 'coach' })).toBe('Coach');
    expect(displayTeamRole({ role: 'coach' }, 'superAdmin')).toBe('Super admin');
  });

  it('reads actual canonical roles instead of the mapped coach/player value', () => {
    expect(displayTeamRole({ role: 'coach', roles: ['captain'] })).toBe('Captain');
    expect(displayTeamRole({ role: 'player', roles: ['parent'] })).toBe('Parent/guardian');
    expect(displayTeamRole({ role: 'player', roles: ['guardian', 'player'] })).toBe('Parent/guardian, Player');
    expect(displayTeamRole({ role: 'coach', roles: ['captain', 'coach'] })).toBe('Coach, Captain');
    expect(displayTeamRole({ role: 'player', roles: ['programStaff'] })).toBe('Staff');
    expect(displayTeamRole({ role: 'player', roles: ['unknown'] })).toBe('Player');
  });

  it('builds synthetic coach membership for super admins', () => {
    const membership = buildSyntheticCoachMembership({
      teamId: 't1',
      userId: 'u1',
      displayName: 'Orkun',
    });
    expect(membership.role).toBe('coach');
    expect(membership.id).toBe('super_t1_u1');
  });
});
