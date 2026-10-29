export const projectId = 'demo-team-hangout';
export const stamp = { seconds: 1791586800, nanoseconds: 123000000 };
export const common = { schemaVersion: 2, revision: 1, createdAt: stamp, updatedAt: stamp, createdBy: 'owner-a', updatedBy: 'owner-a' };
export const parentsA = { orgId: 'org-a', programId: 'program-a', seasonId: 'season-a', divisionId: 'division-a' };
export const parentsB = { orgId: 'org-b', programId: 'program-b', seasonId: 'season-b', divisionId: 'division-b' };
export const teamV2 = { ...common, ...parentsA, name: 'Synthetic team', sport: null, inviteCode: 'AAAAAAAA', status: 'active' };
export const staffV2 = { ...common, orgId: 'org-a', roles: ['programStaff'], programIds: ['program-a'], status: 'active' };
export const eventV2 = { ...common, ...parentsA, title: 'Synthetic practice', type: 'practice', teamId: 'team-a', teamIds: ['team-a'], startsAt: stamp,
  endsAt: { ...stamp, seconds: stamp.seconds + 3600 }, timeZone: 'America/Chicago', status: 'scheduled',
  publicationState: 'published', publicationOperationId: null, deletedAt: null };
export function requireEmulators() {
  if (process.env.BACKEND_EMULATOR_TESTS !== '1' || process.env.GCLOUD_PROJECT !== projectId
    || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
    throw new Error('Use yarn test:backend with the isolated demo project and loopback emulators.');
  }
}

/** Callable fixture shared by Phase 1 compatibility and operational boundary tests. */
export const operationalEventFields = { title: 'Synthetic practice', type: 'practice',
  startsAt: '2026-10-11T23:00:00.000Z', endsAt: '2026-10-12T00:00:00.000Z',
  timeZone: 'America/Chicago', status: 'scheduled', publicationState: 'staged' };

const p3Common = { schemaVersion: 2, revision: 1, createdAt: stamp, updatedAt: stamp, createdBy: 'p3-org-admin', updatedBy: 'p3-org-admin' };
const p3ParentsA = { orgId: 'p3-org-a', programId: 'p3-program-a', seasonId: 'p3-season-a', divisionId: 'p3-division-a' };
const p3ParentsB = { orgId: 'p3-org-b', programId: 'p3-program-b', seasonId: 'p3-season-b', divisionId: 'p3-division-b' };
const actor = (organizationMemberships = [], teamAssignments = []) => ({ organizationMemberships, teamAssignments });

/** Synthetic-only Phase 3 isolation matrix. Participant IDs deliberately differ from every auth uid. */
export const phase3IsolationFixture = {
  parentsA: p3ParentsA,
  parentsB: p3ParentsB,
  actors: {
    orgAdmin: actor([{ orgId: 'p3-org-a', status: 'active', roles: ['orgAdmin'], programIds: [] }]),
    programStaff: actor([{ orgId: 'p3-org-a', status: 'active', roles: ['programStaff'], programIds: ['p3-program-a'] }]),
    coachParent: actor([], [{ orgId: 'p3-org-a', teamId: 'p3-team-home', status: 'active', roles: ['coach'] }]),
    revokedCoach: actor([], [{ orgId: 'p3-org-a', teamId: 'p3-team-home', status: 'revoked', roles: ['coach'] }]),
    guardianA: actor(),
  },
  records: {
    'organizations/p3-org-a': { ...p3Common, name: 'Synthetic organization A', kind: 'club', timeZone: 'America/Chicago', status: 'active', features: { organizationV2: true } },
    'organizations/p3-org-b': { ...p3Common, orgId: 'p3-org-b', name: 'Synthetic organization B', kind: 'club', timeZone: 'America/New_York', status: 'active', features: { organizationV2: true } },
    'organizations/p3-org-a/programs/p3-program-a': { ...p3Common, orgId: 'p3-org-a', name: 'Synthetic program A', sportCode: 'soccer', status: 'active' },
    'organizations/p3-org-b/programs/p3-program-b': { ...p3Common, orgId: 'p3-org-b', name: 'Synthetic program B', sportCode: 'soccer', status: 'active' },
    'organizations/p3-org-a/seasons/p3-season-a': { ...p3Common, orgId: 'p3-org-a', programId: 'p3-program-a', name: 'Active season', status: 'active' },
    'organizations/p3-org-a/seasons/p3-season-archived': { ...p3Common, orgId: 'p3-org-a', programId: 'p3-program-a', name: 'Archived season', status: 'archived' },
    'organizations/p3-org-b/seasons/p3-season-b': { ...p3Common, orgId: 'p3-org-b', programId: 'p3-program-b', name: 'Foreign season', status: 'active' },
    'organizations/p3-org-a/divisions/p3-division-a': { ...p3Common, orgId: 'p3-org-a', programId: 'p3-program-a', seasonId: 'p3-season-a', name: 'Division A', status: 'active' },
    'organizations/p3-org-b/divisions/p3-division-b': { ...p3Common, orgId: 'p3-org-b', programId: 'p3-program-b', seasonId: 'p3-season-b', name: 'Division B', status: 'active' },
    'organizations/p3-org-a/members/p3-org-admin': { ...p3Common, orgId: 'p3-org-a', roles: ['orgAdmin'], programIds: [], status: 'active' },
    'organizations/p3-org-a/participants/p3-participant-a': { ...p3Common, orgId: 'p3-org-a', displayName: 'Synthetic participant A', kind: 'youth', linkedUserId: null, status: 'active' },
    'organizations/p3-org-a/participants/p3-participant-a/private/profile': { orgId: 'p3-org-a', participantId: 'p3-participant-a', notes: 'Synthetic private A' },
    'organizations/p3-org-a/participants/p3-participant-a/guardians/p3-guardian-a': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', userId: 'p3-guardian-a', status: 'active', permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false } },
    'organizations/p3-org-a/participants/p3-participant-a/guardians/p3-coach-parent': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', userId: 'p3-coach-parent', status: 'active', permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false } },
    'organizations/p3-org-b/participants/p3-participant-b': { ...p3Common, orgId: 'p3-org-b', displayName: 'Synthetic participant B', kind: 'youth', linkedUserId: null, status: 'active' },
    'organizations/p3-org-b/participants/p3-participant-b/private/profile': { orgId: 'p3-org-b', participantId: 'p3-participant-b', notes: 'Synthetic private B' },
    'organizations/p3-org-b/participants/p3-participant-b/guardians/p3-guardian-b': { ...p3Common, orgId: 'p3-org-b', participantId: 'p3-participant-b', userId: 'p3-guardian-b', status: 'active', permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false } },
    'teams/p3-team-home': { ...p3Common, ...p3ParentsA, name: 'Synthetic home', sport: 'soccer', status: 'active' },
    'teams/p3-team-away': { ...p3Common, ...p3ParentsA, name: 'Synthetic away', sport: 'soccer', status: 'active' },
    'teams/p3-team-foreign': { ...p3Common, ...p3ParentsB, name: 'Synthetic foreign', sport: 'soccer', status: 'active' },
    'teamMembers/p3-team-home_p3-coach-parent': { ...p3Common, orgId: 'p3-org-a', teamId: 'p3-team-home', userId: 'p3-coach-parent', roles: ['coach'], status: 'active' },
    'teamMembers/p3-team-home_p3-revoked-coach': { ...p3Common, orgId: 'p3-org-a', teamId: 'p3-team-home', userId: 'p3-revoked-coach', roles: ['coach'], status: 'revoked' },
    'teams/p3-team-home/roster/p3-participant-a': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', status: 'active' },
    'teams/p3-team-away/roster/p3-participant-a': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', status: 'active' },
    'teams/p3-team-foreign/roster/p3-participant-b': { ...p3Common, orgId: 'p3-org-b', participantId: 'p3-participant-b', status: 'active' },
    'events/p3-shared-match': { ...p3Common, ...p3ParentsA, title: 'Synthetic shared match', type: 'match', teamId: 'p3-team-home', teamIds: ['p3-team-home', 'p3-team-away'], homeTeamId: 'p3-team-home', awayTeamId: 'p3-team-away', startsAt: stamp, endsAt: { ...stamp, seconds: stamp.seconds + 5400 }, timeZone: 'America/Chicago', status: 'completed', publicationState: 'published', publicationOperationId: null, facilityId: 'p3-facility-a', resourceId: 'p3-field-a', deletedAt: null },
    'events/p3-shared-match/attendance/p3-participant-a': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', status: 'present', scheduleVersion: 1 },
    'events/p3-shared-match/rosterSnapshots/p3-participant-a': { ...p3Common, orgId: 'p3-org-a', participantId: 'p3-participant-a', teamIds: ['p3-team-home', 'p3-team-away'], eligible: true, capturedRevision: 1 },
    'organizations/p3-org-a/facilities/p3-facility-a': { ...p3Common, orgId: 'p3-org-a', name: 'Synthetic park', status: 'active' },
    'organizations/p3-org-a/facilities/p3-facility-a/resources/p3-field-a': { ...p3Common, orgId: 'p3-org-a', facilityId: 'p3-facility-a', label: 'Field A', status: 'active' },
  },
};
