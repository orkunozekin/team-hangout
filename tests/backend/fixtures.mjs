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
