import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';

import {
  db,
} from './config';

import {
  buildInviteDeepLink,
  generateInviteCode,
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

import {
  setActiveTeamId,
} from './users';

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
    role: (data.role === 'coach' ? 'coach' : 'player') as TeamRole,
    displayName: String(data.displayName ?? ''),
    joinedAt: toDate(data.joinedAt),
  };
}

export async function getTeam(
  teamId: string,
): Promise<Team | null> {
  const snap = await getDoc(doc(db, 'teams', teamId));
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

async function allocateUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateInviteCode();
    const existing = await getDoc(doc(db, 'inviteCodes', code));
    if (!existing.exists()) {
      return code;
    }
  }
  throw new Error('Could not allocate a unique invite code');
}

export async function createTeam(params: {
  name: string;
  sport?: string | null;
  userId: string;
  displayName: string;
}): Promise<{ team: Team; membership: TeamMember; inviteDeepLink: string }> {
  const teamRef = doc(collection(db, 'teams'));
  const inviteCode = await allocateUniqueInviteCode();
  const memberId = memberDocId(teamRef.id, params.userId);
  const batch = writeBatch(db);

  batch.set(teamRef, {
    name: params.name.trim(),
    sport: params.sport?.trim() || null,
    inviteCode,
    createdBy: params.userId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'inviteCodes', inviteCode), {
    code: inviteCode,
    teamId: teamRef.id,
    createdBy: params.userId,
    createdAt: serverTimestamp(),
  });

  batch.set(doc(db, 'teamMembers', memberId), {
    teamId: teamRef.id,
    userId: params.userId,
    role: 'coach',
    displayName: params.displayName.trim(),
    joinedAt: serverTimestamp(),
  });

  await batch.commit();
  await setActiveTeamId(params.userId, teamRef.id);

  const team: Team = {
    id: teamRef.id,
    name: params.name.trim(),
    sport: params.sport?.trim() || null,
    inviteCode,
    createdBy: params.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const membership: TeamMember = {
    id: memberId,
    teamId: teamRef.id,
    userId: params.userId,
    role: 'coach',
    displayName: params.displayName.trim(),
    joinedAt: new Date(),
  };

  return {
    team,
    membership,
    inviteDeepLink: buildInviteDeepLink(inviteCode),
  };
}

export async function joinTeamWithInviteCode(params: {
  code: string;
  userId: string;
  displayName: string;
}): Promise<{ team: Team; membership: TeamMember }> {
  const code = normalizeInviteCode(params.code);
  if (!isValidInviteCodeFormat(code)) {
    throw new Error('Invalid invite code format');
  }

  const inviteSnap = await getDoc(doc(db, 'inviteCodes', code));
  if (!inviteSnap.exists()) {
    throw new Error('Invite code not found');
  }

  const inviteData = inviteSnap.data() as Record<string, unknown>;
  const teamId = String(inviteData.teamId ?? '');
  if (!teamId) {
    throw new Error('Invite code is invalid');
  }

  const team = await getTeam(teamId);
  if (!team) {
    throw new Error('Team not found');
  }

  if (team.inviteCode !== code) {
    throw new Error('Invite code is no longer active');
  }

  const existing = await getMembership(teamId, params.userId);
  if (existing) {
    await setActiveTeamId(params.userId, teamId);
    return { team, membership: existing };
  }

  const memberId = memberDocId(teamId, params.userId);
  await setDoc(doc(db, 'teamMembers', memberId), {
    teamId,
    userId: params.userId,
    role: 'player',
    displayName: params.displayName.trim(),
    joinedAt: serverTimestamp(),
  });

  await setActiveTeamId(params.userId, teamId);

  return {
    team,
    membership: {
      id: memberId,
      teamId,
      userId: params.userId,
      role: 'player',
      displayName: params.displayName.trim(),
      joinedAt: new Date(),
    },
  };
}

export async function regenerateInviteCode(params: {
  teamId: string;
  userId: string;
  isSuperAdmin?: boolean;
}): Promise<{ inviteCode: string; inviteDeepLink: string }> {
  const membership = await getMembership(params.teamId, params.userId);
  const allowed =
    params.isSuperAdmin === true ||
    (membership != null && membership.role === 'coach');
  if (!allowed) {
    throw new Error('Only coaches or super admins can regenerate invite codes');
  }

  const team = await getTeam(params.teamId);
  if (!team) {
    throw new Error('Team not found');
  }

  const newCode = await allocateUniqueInviteCode();
  const batch = writeBatch(db);

  batch.delete(doc(db, 'inviteCodes', team.inviteCode));
  batch.set(doc(db, 'inviteCodes', newCode), {
    code: newCode,
    teamId: params.teamId,
    createdBy: params.userId,
    createdAt: serverTimestamp(),
  });
  batch.update(doc(db, 'teams', params.teamId), {
    inviteCode: newCode,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();

  return {
    inviteCode: newCode,
    inviteDeepLink: buildInviteDeepLink(newCode),
  };
}

export async function listAllTeams(): Promise<Team[]> {
  const snap = await getDocs(collection(db, 'teams'));
  return snap.docs
    .map((d) => mapTeamDoc(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  await updateDoc(doc(db, 'teams', teamId), {
    name: name.trim(),
    updatedAt: serverTimestamp(),
  });
}
