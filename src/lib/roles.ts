import {
  AppRole,
  TeamMember,
  TeamRole,
} from '../types/models';

export function parseAppRole(value: unknown): AppRole {
  return value === 'superAdmin' ? 'superAdmin' : 'user';
}

export function isSuperAdminRole(role: AppRole | null | undefined): boolean {
  return role === 'superAdmin';
}

export function canManageTeam(params: {
  membership: TeamMember | null | undefined;
  appRole?: AppRole | null;
}): boolean {
  if (isSuperAdminRole(params.appRole)) {
    return true;
  }
  return params.membership?.role === 'coach';
}

export function displayTeamRole(
  role: TeamRole,
  appRole?: AppRole | null,
): string {
  if (isSuperAdminRole(appRole)) {
    return 'super admin';
  }
  return role;
}

export function buildSyntheticCoachMembership(params: {
  teamId: string;
  userId: string;
  displayName: string;
}): TeamMember {
  return {
    id: `super_${params.teamId}_${params.userId}`,
    teamId: params.teamId,
    userId: params.userId,
    role: 'coach',
    displayName: params.displayName,
    joinedAt: new Date(),
  };
}
