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

const ROLE_LABELS: Record<string, string> = {
  coach: 'Coach',
  captain: 'Captain',
  parent: 'Parent/guardian',
  guardian: 'Parent/guardian',
  player: 'Player',
  staff: 'Staff',
  programStaff: 'Staff',
  orgAdmin: 'Staff',
};
const ROLE_ORDER = ['Coach', 'Captain', 'Staff', 'Parent/guardian', 'Player'];

/**
 * Names the person's actual roles on this team, read from the canonical membership `roles` grants
 * (coach, captain, parent/guardian, player, staff) and falling back to the legacy coach/player role.
 */
export function displayTeamRole(
  member: Pick<TeamMember, 'role' | 'roles'>,
  appRole?: AppRole | null,
): string {
  if (isSuperAdminRole(appRole)) {
    return 'Super admin';
  }
  const labels = new Set((member.roles ?? []).map(role => ROLE_LABELS[role]).filter(Boolean));
  if (labels.size === 0) labels.add(member.role === 'coach' ? 'Coach' : 'Player');
  return ROLE_ORDER.filter(label => labels.has(label)).join(', ');
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
