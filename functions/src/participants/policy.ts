import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { Data, id, invalid, keys, object, wire } from '../commandSupport';
import { denied, inactive, staffScope } from '../organizations/policy';

export function metadata(uid: string, before?: Data): Data {
  const now = Timestamp.now();
  return { schemaVersion: 2, revision: (before?.revision ?? 0) + 1, createdAt: before?.createdAt ?? now,
    createdBy: before?.createdBy ?? uid, updatedAt: now, updatedBy: uid };
}
export function choice(value: unknown, choices: string[], field: string): string {
  if (typeof value !== 'string' || !choices.includes(value)) invalid(`Invalid ${field}.`);
  return value as string;
}
export function participantRef(orgId: string, participantId: string) {
  return getFirestore().doc(`organizations/${orgId}/participants/${participantId}`);
}
export async function participant(tx: Transaction, orgId: string, participantId: string) {
  const row = (await tx.get(participantRef(orgId, participantId))).data();
  // Migration-created participants are scoped by path; new commands also stamp orgId.
  if (!row || row.schemaVersion !== 2 || (row.orgId != null && row.orgId !== orgId)) denied();
  return row!;
}
export async function adminScope(tx: Transaction, orgId: string, uid: string, writing = false) {
  const scope = await staffScope(tx, orgId, uid);
  if (!scope.admin) denied();
  if (scope.organization.features?.organizationV2 !== true) denied();
  if (writing && scope.organization.status !== 'active') inactive();
  return scope;
}
export async function availableUser(tx: Transaction, uid: string) {
  const user = (await tx.get(getFirestore().doc(`users/${uid}`))).data();
  if (!user || user.accountState === 'deleting') denied();
}
export async function householdAccess(tx: Transaction, orgId: string, participantId: string, uid: string, right: string) {
  const db = getFirestore(); const row = await participant(tx, orgId, participantId);
  const [org, grant] = await tx.getAll(db.doc(`organizations/${orgId}`), participantRef(orgId, participantId).collection('guardians').doc(uid));
  if (org.data()?.schemaVersion !== 2 || org.data()?.features?.households !== true || row.status !== 'active') denied();
  const self = row.linkedUserId === uid;
  const guardian = grant.data();
  if (!self && !(guardian?.status === 'active' && guardian.orgId === orgId
    && guardian.participantId === participantId && (right === 'discovery' ? (guardian.permissions?.viewProfile === true || guardian.permissions?.viewSchedule === true) : guardian.permissions?.[right] === true))) denied();
  return { row, self, guardian, organization: org.data()! };
}
export function readCommand(normalize: (data: Data) => Data, execute: (tx: Transaction, data: Data, uid: string) => Promise<Data>) {
  return onCall(async request => {
    const uid = request.auth?.uid; if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    const payload = normalize(object(request.data));
    return getFirestore().runTransaction(async tx => {
      await availableUser(tx, uid); return wire(await execute(tx, payload, uid));
    });
  });
}
export function identity(data: Data): Data { return { orgId: id(data.orgId, 'orgId'), participantId: id(data.participantId, 'participantId') }; }
export function page(data: Data): Data {
  const pageSize = data.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid('pageSize must be 1 through 50.');
  return { pageSize, cursor: data.cursor == null ? null : id(data.cursor, 'cursor') };
}
export function publicParticipant(participantId: string, row: Data): Data {
  return { id: participantId, displayName: row.displayName, kind: row.kind, status: row.status, revision: row.revision ?? 0 };
}
/** Read all sources before any writes. Bounds keep authority changes within one atomic transaction. */
export async function projectionSources(tx: Transaction, orgId: string, participantId: string, row: Data) {
  const db = getFirestore();
  const [guardians, rosters] = await Promise.all([
    tx.get(participantRef(orgId, participantId).collection('guardians').where('status', '==', 'active').limit(11)),
    tx.get(db.collectionGroup('roster').where('orgId', '==', orgId).where('participantId', '==', participantId).where('status', '==', 'active').limit(21)),
  ]);
  if (guardians.size > 10 || rosters.size > 20) throw new HttpsError('resource-exhausted', 'This participant requires a reviewed bulk access change.');
  const grants: Record<string, Data> = Object.fromEntries(guardians.docs.map(doc => [doc.id, doc.data()]));
  const teamIds = rosters.docs.map(doc => {
    if (doc.ref.parent.parent?.parent.id !== 'teams' || doc.id !== participantId) denied();
    return doc.ref.parent.parent!.id;
  });
  return { grants, teamIds, linkedUserId: row.linkedUserId as string | null };
}
/** Keep one source per participant so removing a sibling's grant cannot erase another sibling's pointer. */
export async function prepareProjections(tx: Transaction, orgId: string, participantId: string, before: Awaited<ReturnType<typeof projectionSources>>, after: Awaited<ReturnType<typeof projectionSources>>, active: boolean, accessRevision: number, actorUid: string) {
  const db = getFirestore();
  const uids = [...new Set([...Object.keys(before.grants), ...Object.keys(after.grants), before.linkedUserId, after.linkedUserId].filter((uid): uid is string => !!uid))];
  const teams = [...new Set([...before.teamIds, ...after.teamIds])];
  const writes: { path: string; data: Data }[] = [];
  const sourceId = `${orgId}_${participantId}`;
  for (const uid of uids) {
    const self = after.linkedUserId === uid;
    const grant = after.grants[uid];
    const current = active && (self || grant?.status === 'active');
    const linkPath = `users/${uid}/participantLinks/${sourceId}`;
    const orgPath = `users/${uid}/organizationLinks/${orgId}`;
    const [previousLink, previousOrg] = await tx.getAll(db.doc(linkPath), db.doc(orgPath));
    writes.push({ path: linkPath, data: { ...metadata(actorUid, previousLink.data()),
      orgId, participantId, relationship: self ? 'self' : 'guardian', status: current ? 'active' : 'revoked', sourceRevision: accessRevision, schemaVersion: 2, updatedAt: Timestamp.now(),
    } });
    // Organization discovery remains a candidate pointer. Other participants/staff may still grant access.
    writes.push({ path: orgPath, data: { ...metadata(actorUid, previousOrg.data()), orgId, status: 'active' } });
    for (const teamId of teams) {
      const path = `users/${uid}/teamAccess/${teamId}`;
      const previous = (await tx.get(db.doc(path))).data();
      const sources = new Set<string>(previous?.sourceParticipantIds ?? []);
      sources.delete(sourceId);
      if (current && (self || grant?.permissions?.viewSchedule === true) && after.teamIds.includes(teamId)) sources.add(sourceId);
      writes.push({ path, data: { orgId, teamId, sourceParticipantIds: [...sources].sort(), status: sources.size ? 'active' : 'revoked',
        ...metadata(actorUid, previous) } });
    }
  }
  return () => { for (const write of writes) tx.set(db.doc(write.path), write.data, { merge: true }); };
}
export const listMyParticipants = readCommand(data => {
  keys(data, ['pageSize', 'cursor']); return page(data);
}, async (tx, payload, uid) => {
  let query = getFirestore().collection(`users/${uid}/participantLinks`).orderBy(FieldPath.documentId()).limit(payload.pageSize + 1);
  if (payload.cursor) query = query.startAfter(payload.cursor);
  const links = await tx.get(query); const items: Data[] = [];
  for (const link of links.docs.slice(0, payload.pageSize)) {
    const data = link.data();
    try {
      const access = await householdAccess(tx, id(data.orgId, 'orgId'), id(data.participantId, 'participantId'), uid, 'discovery');
      items.push({ orgId: data.orgId, ...publicParticipant(data.participantId, access.row), relationship: access.self ? 'self' : 'guardian' });
    } catch (error) { if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error; }
  }
  return { items, nextCursor: links.size > payload.pageSize ? links.docs[payload.pageSize - 1].id : null };
});

/** Canonical organization discovery; stale participant and organization links cannot establish access. */
export async function householdOrganization(tx: Transaction, orgId: string, uid: string) {
  const db = getFirestore(); const org = (await tx.get(db.doc(`organizations/${orgId}`))).data();
  if (!org || org.schemaVersion !== 2 || org.features?.households !== true) denied();
  const own = await tx.get(db.collection(`organizations/${orgId}/participants`).where('linkedUserId', '==', uid).where('status', '==', 'active').limit(1));
  if (own.docs.some(doc => doc.data().schemaVersion === 2 && (doc.data().orgId == null || doc.data().orgId === orgId))) return { organization: org, relationship: 'self' };
  const grants = await tx.get(db.collectionGroup('guardians').where('orgId', '==', orgId).where('userId', '==', uid).where('status', '==', 'active').limit(11));
  for (const grant of grants.docs) {
    const row = grant.data();
    if (grant.ref.path !== `organizations/${orgId}/participants/${row.participantId}/guardians/${uid}`) continue;
    try { await householdAccess(tx, orgId, row.participantId, uid, 'discovery'); return { organization: org, relationship: 'guardian' }; }
    catch (error) { if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error; }
  }
  if (grants.size > 10) throw new HttpsError('resource-exhausted', 'Use participant discovery to select this organization.');
  denied();
}
