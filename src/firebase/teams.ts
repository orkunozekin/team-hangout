import { httpsCallable } from 'firebase/functions';
import { functions } from './config';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';

import {
  db,
} from './config';

import {
  buildInviteDeepLink,
  isValidInviteCodeFormat,
  memberDocId,
  normalizeInviteCode,
} from '../lib/inviteCode';

import {
  buildSyntheticCoachMembership,
} from '../lib/roles';

import {
  Team,
  TeamMember,
  TeamRole,
} from '../types/models';

import { runCommand } from './commands';

function toDate(value: unknown): Date {
  if (
    value != null &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return new Date();
}

export function mapTeamDoc(
  id: string,
  data: Record<string, unknown>,
): Team {
  return {
    id,
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : undefined,
    timeZone: typeof data.timeZone === 'string' ? data.timeZone : undefined,
    name: String(data.name ?? ''),
    sport: data.sport == null ? null : String(data.sport),
    inviteCode: String(data.inviteCode ?? ''),
    createdBy: String(data.createdBy ?? ''),
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

export function mapMemberDoc(
  id: string,
  data: Record<string, unknown>,
): TeamMember {
  return {
    id,
    teamId: String(data.teamId ?? ''),
    userId: String(data.userId ?? ''),
    role: (data.schemaVersion === 2 ? data.status === 'active' && Array.isArray(data.roles) && data.roles.includes('coach') : data.role === 'coach') ? 'coach' : 'player',
    displayName: String(data.displayName ?? ''),
    joinedAt: toDate(data.joinedAt),
  };
}

export async function getTeam(
  teamId: string,
): Promise<Team | null> {
  let snap;
  try { snap = await getDoc(doc(db, 'teams', teamId)); }
  catch (error) {
    if ((error as { code?: string }).code !== 'permission-denied') throw error;
    const result = (await httpsCallable<{ teamId: string }, Record<string, unknown>>(functions, 'getNativeTeam')({ teamId })).data;
    return mapTeamDoc(teamId, result);
  }
  if (!snap.exists()) {
    return null;
  }
  return mapTeamDoc(snap.id, snap.data() as Record<string, unknown>);
}

export async function getMembership(
  teamId: string,
  userId: string,
): Promise<TeamMember | null> {
  const id = memberDocId(teamId, userId);
  const snap = await getDoc(doc(db, 'teamMembers', id));
  if (!snap.exists()) {
    return null;
  }
  return mapMemberDoc(snap.id, snap.data() as Record<string, unknown>);
}

export async function getMembershipsForUser(
  userId: string,
): Promise<TeamMember[]> {
  const q = query(
    collection(db, 'teamMembers'),
    where('userId', '==', userId),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    mapMemberDoc(d.id, d.data() as Record<string, unknown>),
  );
}

export async function listTeamMembers(
  teamId: string,
): Promise<TeamMember[]> {
  const q = query(
    collection(db, 'teamMembers'),
    where('teamId', '==', teamId),
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => mapMemberDoc(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === 'coach' ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });
}

export async function createTeam(params: {
  name: string; sport?: string | null; userId: string; displayName: string;
}): Promise<{ team: Team; membership: TeamMember; inviteDeepLink: string }> {
  const result = await runCommand<{ team: Record<string, unknown> & { id: string }; membership: Record<string, unknown> & { id: string } }>('createTeam', {
    name: params.name.trim(), sport: params.sport?.trim() || null,
  });
  const team = mapTeamDoc(result.team.id, result.team);
  return { team, membership: mapMemberDoc(result.membership.id, result.membership), inviteDeepLink: buildInviteDeepLink(team.inviteCode) };
}

export async function joinTeamWithInviteCode(params: {
  code: string; userId: string; displayName: string;
}): Promise<{ team: Team; membership: TeamMember }> {
  const code = normalizeInviteCode(params.code);
  if (!isValidInviteCodeFormat(code)) throw new Error('Invalid invite code format');
  const result = await runCommand<{ team: Record<string, unknown> & { id: string }; membership: Record<string, unknown> & { id: string } }>('joinTeamWithInvite', { code });
  return { team: mapTeamDoc(result.team.id, result.team), membership: mapMemberDoc(result.membership.id, result.membership) };
}

export async function regenerateInviteCode(params: {
  teamId: string; userId: string; isSuperAdmin?: boolean;
}): Promise<{ inviteCode: string; inviteDeepLink: string }> {
  const result = await runCommand<{ inviteCode: string }>('regenerateInvite', { teamId: params.teamId });
  return { ...result, inviteDeepLink: buildInviteDeepLink(result.inviteCode) };
}

export async function listAllTeams(): Promise<Team[]> {
  const teams: Team[] = [];
  let cursor: string | null = null;
  do {
    const result: { items: (Record<string, unknown> & { id: string })[]; nextCursor: string | null } =
      await runCommand('listLegacyTeams', { pageSize: 50, cursor });
    teams.push(...result.items.map(team => mapTeamDoc(team.id, team)));
    cursor = result.nextCursor;
  } while (cursor);
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveActiveMembership(
  userId: string,
  preferredTeamId?: string | null,
  options?: {
    isSuperAdmin?: boolean;
    displayName?: string;
  },
): Promise<{ team: Team; membership: TeamMember } | null> {
  const memberships = await getMembershipsForUser(userId);

  if (
    memberships.length === 0 &&
    options?.isSuperAdmin &&
    preferredTeamId
  ) {
    const team = await getTeam(preferredTeamId);
    if (!team) {
      return null;
    }
    return {
      team,
      membership: buildSyntheticCoachMembership({
        teamId: team.id,
        userId,
        displayName: options.displayName ?? 'Super Admin',
      }),
    };
  }

  if (memberships.length === 0) {
    return null;
  }

  let membership =
    preferredTeamId
      ? memberships.find((m) => m.teamId === preferredTeamId)
      : undefined;

  if (!membership && options?.isSuperAdmin && preferredTeamId) {
    const team = await getTeam(preferredTeamId);
    if (team) {
      return {
        team,
        membership: buildSyntheticCoachMembership({
          teamId: team.id,
          userId,
          displayName: options.displayName ?? 'Super Admin',
        }),
      };
    }
  }

  if (!membership) {
    membership = memberships[0];
  }

  const team = await getTeam(membership.teamId);
  if (!team) {
    return null;
  }

  return { team, membership };
}

export async function updateTeamName(
  teamId: string,
  name: string,
): Promise<void> {
  await runCommand('renameTeam', { teamId, name: name.trim() });
}
