import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { Data, id } from '../commandSupport';

export function denied(): never { throw new HttpsError('permission-denied', 'Organization access is unavailable.'); }
export function inactive(): never {
  throw new HttpsError('failed-precondition', 'Restore the archived hierarchy before editing.', { domainCode: 'HIERARCHY_ARCHIVED' });
}
export function stale(currentRevision: number): never {
  throw new HttpsError('aborted', 'This record changed. Reload before saving.', { domainCode: 'STALE_REVISION', currentRevision });
}
export function checkRevision(record: Data | undefined, expected: number) {
  if ((record?.revision ?? 0) !== expected) stale(record?.revision ?? 0);
}
/** Canonical grants only. Platform support and navigation projections confer no tenant authority. */
export async function staffScope(tx: Transaction, orgId: string, uid: string) {
  const db = getFirestore();
  const [org, member] = await tx.getAll(db.doc(`organizations/${orgId}`), db.doc(`organizations/${orgId}/members/${uid}`));
  const grant = member.data();
  if (!org.exists || org.data()?.schemaVersion !== 2 || grant?.status !== 'active'
    || grant.orgId !== orgId || !Array.isArray(grant.roles) || !Array.isArray(grant.programIds)
    || !grant.roles.some((role: string) => ['orgAdmin', 'programStaff'].includes(role))) denied();
  return { organization: org.data()!, admin: grant!.roles.includes('orgAdmin'), programIds: grant!.programIds as string[] };
}
export function requireProgram(scope: Awaited<ReturnType<typeof staffScope>>, programId: string) {
  if (!scope.admin && !scope.programIds.includes(programId)) denied();
}
export async function hierarchy(tx: Transaction, orgId: string, programId: string, seasonId?: string, divisionId?: string | null, writing = true) {
  const db = getFirestore();
  const paths = [`organizations/${orgId}`, `organizations/${orgId}/programs/${programId}`];
  if (seasonId) paths.push(`organizations/${orgId}/seasons/${seasonId}`);
  if (divisionId) paths.push(`organizations/${orgId}/divisions/${divisionId}`);
  const docs = await tx.getAll(...paths.map(path => db.doc(path)));
  if (docs.some(doc => !doc.exists || doc.data()?.schemaVersion !== 2)) denied();
  const [org, program, season, division] = docs.map(doc => doc.data()!);
  if (program.orgId !== orgId || (seasonId && (season.orgId !== orgId || season.programId !== programId))
    || (divisionId && (division.orgId !== orgId || division.programId !== programId || division.seasonId !== seasonId))) denied();
  if (writing && docs.some(doc => doc.data()?.status === 'archived')) inactive();
  return { org, program, season, division };
}
/** All event teams must have the same tenant/program/season. Coaches need every team's current grant. */
export async function eventScope(tx: Transaction, teamIds: string[], uid: string, writing = true) {
  const db = getFirestore();
  const teams = await tx.getAll(...teamIds.map(teamId => db.doc(`teams/${teamId}`)));
  if (teams.some(team => !team.exists || team.data()?.schemaVersion !== 2)) denied();
  const first = teams[0].data()!;
  const orgId = id(first.orgId, 'stored orgId'); const programId = id(first.programId, 'stored programId');
  const seasonId = id(first.seasonId, 'stored seasonId');
  const [org, member] = await tx.getAll(db.doc(`organizations/${orgId}`), db.doc(`organizations/${orgId}/members/${uid}`));
  if (!org.exists) denied();
  const grant = member.data();
  const staff = grant?.orgId === orgId && grant.status === 'active'
    && (grant.roles?.includes('orgAdmin') || (grant.roles?.includes('programStaff') && grant.programIds?.includes(programId)));
  const coaches = staff ? [] : await tx.getAll(...teamIds.map(teamId => db.doc(`teamMembers/${teamId}_${uid}`)));
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i].data()!;
    if (team.orgId !== orgId || team.programId !== programId || team.seasonId !== seasonId) denied();
    if (!staff) {
      const coach = coaches[i].data();
      if (coach?.teamId !== teams[i].id || coach.userId !== uid || coach.orgId !== orgId
        || coach.status !== 'active' || !coach.roles?.includes('coach')) denied();
    }
    await hierarchy(tx, orgId, programId, seasonId, id(team.divisionId, 'stored divisionId'), writing);
    if (writing && team.status !== 'active') inactive();
  }
  if (org.data()?.features?.organizationV2 !== true) {
    throw new HttpsError('failed-precondition', 'Organization features are not enabled.', { domainCode: 'ORGANIZATION_SETUP_REQUIRED' });
  }
  return { orgId, programId, seasonId, teams: teams.map(team => team.data()!) };
}
