import { accountAvailable } from '../accountAccess';
import { householdOrganization } from '../participants/policy';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { Data, command, id, invalid, keys, object, optional, revision, text, wire } from '../commandSupport';
import { checkRevision, denied, hierarchy, inactive, requireProgram, staffScope } from './policy';

function choice(value: unknown, choices: string[], field: string): string {
  if (typeof value !== 'string' || !choices.includes(value)) invalid(`Invalid ${field}.`);
  return value as string;
}
function zone(value: unknown): string {
  const result = text(value, 'timeZone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: result }); } catch { invalid('Invalid timeZone.'); }
  return result;
}
function localDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(`Invalid ${field}.`);
  return value as string;
}
function metadata(uid: string, before?: Data) {
  const now = Timestamp.now();
  return { schemaVersion: 2, revision: (before?.revision ?? 0) + 1,
    createdBy: before?.createdBy ?? uid, createdAt: before?.createdAt ?? now, updatedBy: uid, updatedAt: now };
}
export function audit(tx: Transaction, orgId: string, uid: string, operation: string, targetId: string, newRevision: number) {
  tx.create(getFirestore().collection(`organizations/${orgId}/audit`).doc(), {
    schemaVersion: 2, actorUid: uid, operation, targetId, revision: newRevision, createdAt: Timestamp.now(),
  });
}
function enabled(organization: Data) {
  if (organization.features?.organizationV2 !== true) throw new HttpsError('failed-precondition', 'Organization features are not enabled.');
}

export const createOrganization = command('createOrganization', data => {
  keys(data, ['requestId', 'name', 'kind', 'timeZone']);
  return { name: text(data.name, 'name'), kind: choice(data.kind, ['municipal', 'communityCenter', 'club'], 'kind'), timeZone: zone(data.timeZone) };
}, async (tx, payload, uid, _actor, replay) => {
  const db = getFirestore();
  // Provisioned through the trusted server owner path, never a self-editable profile or custom payload.
  if ((await tx.get(db.doc(`organizationOwners/${uid}`))).data()?.enabled !== true) denied();
  if (replay) { await staffScope(tx, replay.organization.id, uid); return replay; }
  const ref = db.collection('organizations').doc();
  const organization = { ...payload, status: 'active', features: { organizationV2: true }, ...metadata(uid) };
  const member = { orgId: ref.id, roles: ['orgAdmin'], programIds: [], status: 'active', grantedBy: uid, grantedAt: Timestamp.now(), revokedAt: null, ...metadata(uid) };
  tx.create(ref, organization);
  tx.create(ref.collection('members').doc(uid), member);
  tx.set(db.doc(`users/${uid}/organizationLinks/${ref.id}`), { orgId: ref.id, status: 'active', revision: 1 });
  audit(tx, ref.id, uid, 'createOrganization', ref.id, 1);
  return { organization: { id: ref.id, ...organization } };
});

function entityFields(kind: string, value: unknown): Data {
  const fields = object(value);
  const extra: Record<string, string[]> = {
    organization: ['kind', 'timeZone'], program: ['sportCode', 'sportLabel'],
    season: ['programId', 'startsOn', 'endsOn'], division: ['programId', 'seasonId', 'ageBandLabel'],
  };
  keys(fields, ['name', 'status', ...extra[kind]]);
  const result: Data = { name: text(fields.name, 'name'), status: choice(fields.status, kind === 'season' ? ['draft', 'active'] : ['active', 'archived'], 'status') };
  if (kind === 'organization') Object.assign(result, { kind: choice(fields.kind, ['municipal', 'communityCenter', 'club'], 'kind'), timeZone: zone(fields.timeZone) });
  if (kind === 'program') Object.assign(result, { sportCode: choice(fields.sportCode, ['soccer', 'basketball', 'football', 'other'], 'sportCode'), sportLabel: optional(fields.sportLabel, 'sportLabel', 100) });
  if (['season', 'division'].includes(kind)) result.programId = id(fields.programId, 'programId');
  if (kind === 'season') {
    result.startsOn = localDate(fields.startsOn, 'startsOn'); result.endsOn = localDate(fields.endsOn, 'endsOn');
    if (result.endsOn < result.startsOn) invalid('endsOn must follow startsOn.');
  }
  if (kind === 'division') Object.assign(result, { seasonId: id(fields.seasonId, 'seasonId'), ageBandLabel: optional(fields.ageBandLabel, 'ageBandLabel', 100) });
  return result;
}

export const saveHierarchyEntity = command('saveHierarchyEntity', data => {
  keys(data, ['requestId', 'orgId', 'kind', 'entityId', 'expectedRevision', 'fields']);
  const kind = choice(data.kind, ['organization', 'program', 'season', 'division'], 'kind');
  return { orgId: id(data.orgId, 'orgId'), kind, entityId: data.entityId == null ? null : id(data.entityId, 'entityId'),
    expectedRevision: revision(data.expectedRevision), fields: entityFields(kind, data.fields) };
}, async (tx, payload, uid, _actor, replay) => {
  const { orgId, kind, fields } = payload;
  const scope = await staffScope(tx, orgId, uid); enabled(scope.organization);
  if (['organization', 'program'].includes(kind) && !scope.admin) denied();
  if (fields.programId) requireProgram(scope, fields.programId);
  const db = getFirestore();
  const collection = db.collection(`organizations/${orgId}/${kind}s`);
  const ref = kind === 'organization' ? db.doc(`organizations/${orgId}`) : collection.doc(payload.entityId ?? replay?.entity?.id ?? collection.doc().id);
  if (kind === 'organization' && payload.entityId !== orgId) invalid('entityId must be the organization ID.');
  const before = (await tx.get(ref)).data();
  if (!before && payload.entityId) denied();
  if (before && kind !== 'organization' && before.orgId !== orgId) denied();
  if (before?.programId) requireProgram(scope, before.programId);
  for (const field of ['programId', 'seasonId']) {
    if (before && before[field] !== fields[field]) invalid(`${field} is immutable.`);
  }
  if (!replay && kind !== 'organization' && scope.organization.status === 'archived') inactive();
  if (kind === 'season') await hierarchy(tx, orgId, fields.programId, undefined, undefined, !replay);
  if (kind === 'division') await hierarchy(tx, orgId, fields.programId, fields.seasonId, undefined, !replay);
  if (replay) return replay;
  if (kind === 'season' && before?.status === 'archived') inactive();
  checkRevision(before, payload.expectedRevision);
  const entity = { ...before, ...fields, ...(kind === 'organization' ? {} : { orgId }), ...metadata(uid, before) };
  tx.set(ref, entity);
  audit(tx, orgId, uid, `save${kind}`, ref.id, entity.revision);
  return { entity: { id: ref.id, ...entity } };
});

export const saveTeam = command('saveTeam', data => {
  keys(data, ['requestId', 'orgId', 'teamId', 'expectedRevision', 'fields']);
  const fields = object(data.fields); keys(fields, ['name', 'programId', 'seasonId', 'divisionId', 'status']);
  return { orgId: id(data.orgId, 'orgId'), teamId: data.teamId == null ? null : id(data.teamId, 'teamId'), expectedRevision: revision(data.expectedRevision),
    fields: { name: text(fields.name, 'name'), programId: id(fields.programId, 'programId'), seasonId: id(fields.seasonId, 'seasonId'), divisionId: id(fields.divisionId, 'divisionId'), status: choice(fields.status, ['active', 'archived'], 'status') } };
}, async (tx, payload, uid, _actor, replay) => {
  const scope = await staffScope(tx, payload.orgId, uid); enabled(scope.organization); requireProgram(scope, payload.fields.programId);
  const db = getFirestore(); const ref = db.collection('teams').doc(payload.teamId ?? replay?.team?.id ?? db.collection('teams').doc().id);
  const before = (await tx.get(ref)).data();
  if (!before && payload.teamId) denied();
  if (before) {
    if (before.orgId !== payload.orgId || before.schemaVersion !== 2) denied();
    requireProgram(scope, before.programId);
    for (const field of ['programId', 'seasonId', 'divisionId']) if (before[field] !== payload.fields[field]) invalid(`${field} is immutable.`);
  }
  const parents = await hierarchy(tx, payload.orgId, payload.fields.programId, payload.fields.seasonId, payload.fields.divisionId, !replay);
  if (replay) return replay;
  checkRevision(before, payload.expectedRevision);
  // V2 invitations are a later command. Never issue a legacy code for a tenant team.
  const team = { ...before, sport: parents.program.sportCode, inviteCode: null, orgId: payload.orgId, ...payload.fields, ...metadata(uid, before) };
  tx.set(ref, team); audit(tx, payload.orgId, uid, 'saveTeam', ref.id, team.revision);
  return { team: { id: ref.id, ...team } };
});

export const setStaffAssignment = command('setStaffAssignment', data => {
  keys(data, ['requestId', 'orgId', 'userId', 'roles', 'programIds', 'status', 'expectedRevision']);
  if (!Array.isArray(data.roles) || data.roles.length === 0 || data.roles.length > 2 || new Set(data.roles).size !== data.roles.length) invalid('Invalid roles.');
  const roles = data.roles.map((role: unknown) => choice(role, ['orgAdmin', 'programStaff'], 'roles')).sort();
  if (!Array.isArray(data.programIds) || data.programIds.length > 20) invalid('Invalid programIds.');
  const programIds = data.programIds.map((value: unknown) => id(value, 'programIds')).sort();
  if (new Set(programIds).size !== programIds.length || (roles.includes('programStaff') && !programIds.length)) invalid('Invalid programIds.');
  return { orgId: id(data.orgId, 'orgId'), userId: id(data.userId, 'userId'), roles, programIds,
    status: choice(data.status, ['active', 'revoked'], 'status'), expectedRevision: revision(data.expectedRevision) };
}, async (tx, payload, uid, _actor, replay) => {
  const db = getFirestore(); const scope = await staffScope(tx, payload.orgId, uid); enabled(scope.organization);
  if (!scope.admin) denied();
  if (!replay && scope.organization.status !== 'active') inactive();
  // Self-demotion is a separate handover/deletion policy, never an accidental lockout here.
  if (payload.userId === uid && (payload.status !== 'active' || !payload.roles.includes('orgAdmin'))) {
    throw new HttpsError('failed-precondition', 'Another organization administrator must change your assignment.');
  }
  const ref = db.doc(`organizations/${payload.orgId}/members/${payload.userId}`);
  const discovery = db.doc(`users/${payload.userId}/organizationLinks/${payload.orgId}`);
  const [previous, previousDiscovery] = await tx.getAll(ref, discovery);
  await accountAvailable(tx, payload.userId);
  for (const programId of payload.programIds) await hierarchy(tx, payload.orgId, programId, undefined, undefined, false);
  if (replay) return replay;
  checkRevision(previous.data(), payload.expectedRevision);
  const now = Timestamp.now();
  const member = { orgId: payload.orgId, roles: payload.roles, programIds: payload.programIds, status: payload.status,
    grantedBy: uid, grantedAt: now, revokedAt: payload.status === 'revoked' ? now : null, ...metadata(uid, previous.data()) };
  tx.set(ref, member);
  tx.set(discovery, { orgId: payload.orgId, status: payload.status, ...metadata(uid, previousDiscovery.data()) }, { merge: true });
  audit(tx, payload.orgId, uid, 'setStaffAssignment', payload.userId, member.revision);
  return { member: { id: payload.userId, ...member } };
});

export const archiveSeason = command('archiveSeason', data => {
  keys(data, ['requestId', 'orgId', 'seasonId', 'status', 'expectedRevision']);
  return { orgId: id(data.orgId, 'orgId'), seasonId: id(data.seasonId, 'seasonId'),
    status: choice(data.status, ['draft', 'active', 'archived'], 'status'), expectedRevision: revision(data.expectedRevision) };
}, async (tx, payload, uid, _actor, replay) => {
  const db = getFirestore(); const scope = await staffScope(tx, payload.orgId, uid); enabled(scope.organization);
  const ref = db.doc(`organizations/${payload.orgId}/seasons/${payload.seasonId}`); const before = (await tx.get(ref)).data();
  if (!before || before.orgId !== payload.orgId) denied();
  requireProgram(scope, before!.programId); await hierarchy(tx, payload.orgId, before!.programId, undefined, undefined, !replay);
  if (replay) return replay;
  checkRevision(before, payload.expectedRevision);
  const season = { ...before, status: payload.status, ...metadata(uid, before) };
  tx.set(ref, season); audit(tx, payload.orgId, uid, 'archiveSeason', ref.id, season.revision);
  return { season: { id: ref.id, ...season } };
});

function readCommand(normalize: (data: Data) => Data, execute: (tx: Transaction, payload: Data, uid: string) => Promise<Data>) {
  return onCall(async request => {
    const uid = request.auth?.uid; if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    const payload = normalize(object(request.data));
    return getFirestore().runTransaction(async tx => {
      await accountAvailable(tx, uid);
      return wire(await execute(tx, payload, uid));
    });
  });
}
function page(data: Data): Data {
  const pageSize = data.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid('pageSize must be 1 through 50.');
  return { pageSize, cursor: data.cursor == null ? null : id(data.cursor, 'cursor') };
}
export const listMyOrganizations = readCommand(data => {
  keys(data, ['pageSize', 'cursor']); return page(data);
}, async (tx, payload, uid) => {
  let query = getFirestore().collection(`users/${uid}/organizationLinks`).orderBy(FieldPath.documentId()).limit(payload.pageSize + 1);
  if (payload.cursor) query = query.startAfter(payload.cursor);
  const links = await tx.get(query); const items: Data[] = [];
  for (const link of links.docs.slice(0, payload.pageSize)) {
    // Discovery pointers never grant access; removed canonical membership drops stale pointers.
    try {
      const scope = await staffScope(tx, link.id, uid);
      items.push({ id: link.id, name: scope.organization.name, status: scope.organization.status,
        roles: scope.admin ? ['orgAdmin'] : ['programStaff'], programIds: scope.admin ? [] : scope.programIds });
    } catch (error) {
      if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error;
      try {
        const access = await householdOrganization(tx, link.id, uid);
        items.push({ id: link.id, name: access.organization.name, status: access.organization.status, roles: [access.relationship], programIds: [] });
      } catch (householdError) { if (!(householdError instanceof HttpsError) || householdError.code !== 'permission-denied') throw householdError; }
    }
  }
  return { items, nextCursor: links.size > payload.pageSize ? links.docs[payload.pageSize - 1].id : null };
});
export const listOrganizationHierarchy = readCommand(data => {
  keys(data, ['orgId', 'kind', 'programId', 'seasonStatus', 'pageSize', 'cursor']);
  const kind = choice(data.kind ?? 'program', ['program', 'season', 'division', 'team'], 'kind');
  if (data.seasonStatus != null && kind !== 'season') invalid('seasonStatus requires kind season.');
  return { orgId: id(data.orgId, 'orgId'), kind, programId: data.programId == null ? null : id(data.programId, 'programId'),
    seasonStatus: data.seasonStatus == null ? null : choice(data.seasonStatus, ['draft', 'active', 'archived'], 'seasonStatus'), ...page(data) };
}, async (tx, payload, uid) => {
  const scope = await staffScope(tx, payload.orgId, uid);
  if (payload.programId) {
    requireProgram(scope, payload.programId); await hierarchy(tx, payload.orgId, payload.programId, undefined, undefined, false);
  } else if (!scope.admin && payload.kind !== 'program') invalid('Choose an assigned program.');
  const db = getFirestore();
  let query: FirebaseFirestore.Query = payload.kind === 'team' ? db.collection('teams').where('orgId', '==', payload.orgId)
    : db.collection(`organizations/${payload.orgId}/${payload.kind}s`);
  if (payload.kind === 'program') {
    if (payload.programId) query = query.where(FieldPath.documentId(), '==', payload.programId);
    else if (!scope.admin) {
      if (!scope.programIds.length) denied();
      query = query.where(FieldPath.documentId(), 'in', scope.programIds);
    }
  } else if (payload.programId) query = query.where('programId', '==', payload.programId);
  if (payload.seasonStatus) query = query.where('status', '==', payload.seasonStatus);
  query = query.orderBy(FieldPath.documentId()).limit(payload.pageSize + 1);
  if (payload.cursor) query = query.startAfter(payload.cursor);
  const result = await tx.get(query);
  return { organization: { id: payload.orgId, name: scope.organization.name, status: scope.organization.status, timeZone: scope.organization.timeZone },
    items: result.docs.slice(0, payload.pageSize).map(doc => ({ id: doc.id, ...doc.data() })),
    nextCursor: result.size > payload.pageSize ? result.docs[payload.pageSize - 1].id : null };
});

// Preserve the existing support directory without exposing v2 teams through an unscoped client query.
export const listLegacyTeams = readCommand(data => {
  keys(data, ['requestId', 'pageSize', 'cursor']); return page(data);
}, async (tx, payload, uid) => {
  const db = getFirestore(); const actor = (await tx.get(db.doc(`users/${uid}`))).data();
  if (actor?.appRole !== 'superAdmin') denied();
  let query = db.collection('teams').orderBy(FieldPath.documentId()).limit(payload.pageSize + 1);
  if (payload.cursor) query = query.startAfter(payload.cursor);
  const result = await tx.get(query);
  return { items: result.docs.slice(0, payload.pageSize).filter(doc => doc.data().orgId == null && doc.data().schemaVersion !== 2).map(doc => ({ id: doc.id, ...doc.data() })),
    nextCursor: result.size > payload.pageSize ? result.docs[payload.pageSize - 1].id : null };
});
