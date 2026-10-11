import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, optional, revision, text } from '../commandSupport';
import { audit } from '../organizations/commands';
import { checkRevision, denied, hierarchy, inactive, requireProgram, staffScope } from '../organizations/policy';
import { adminScope, availableUser, choice, householdAccess, identity, metadata, page, participant, participantRef,
  prepareProjections, projectionSources, publicParticipant, readCommand } from './policy';

const participantRevision = (row: Data) => (row.accessRevision ?? 0) + 1;
function activeParticipant(row: Data) { if (row.status !== 'active') inactive(); }
export const saveParticipant = command('saveParticipant', data => {
  keys(data, ['requestId', 'orgId', 'participantId', 'expectedRevision', 'fields']);
  const fields = object(data.fields); keys(fields, ['displayName', 'kind', 'externalId', 'status']);
  return { orgId: id(data.orgId, 'orgId'), participantId: data.participantId == null ? null : id(data.participantId, 'participantId'), expectedRevision: revision(data.expectedRevision),
    fields: { displayName: text(fields.displayName, 'displayName'), kind: choice(fields.kind, ['youth', 'adult', 'unknown'], 'kind'), externalId: optional(fields.externalId, 'externalId', 128), status: choice(fields.status, ['active', 'archived'], 'status') } };
}, async (tx, payload, uid, _actor, replay) => {
  await adminScope(tx, payload.orgId, uid, !replay);
  const ref = participantRef(payload.orgId, payload.participantId ?? replay?.participant?.id ?? getFirestore().collection('ids').doc().id);
  const before = payload.participantId || replay ? await participant(tx, payload.orgId, ref.id) : undefined;
  if (replay) return replay;
  checkRevision(before, payload.expectedRevision);
  if (before?.linkedUserId && payload.fields.kind !== 'adult' && before.kind === 'adult') invalid('Unlink the adult account before changing kind.');
  const row = { ...before, ...payload.fields, orgId: payload.orgId, linkedUserId: before?.linkedUserId ?? null,
    accessRevision: participantRevision(before ?? {}), ...metadata(uid, before) };
  const sources = before ? await projectionSources(tx, payload.orgId, ref.id, before) : { grants: {}, teamIds: [], linkedUserId: null };
  const projections = await prepareProjections(tx, payload.orgId, ref.id, sources, sources, row.status === 'active', row.accessRevision, uid);
  tx.set(ref, row); projections(); audit(tx, payload.orgId, uid, 'saveParticipant', ref.id, row.revision);
  return { participant: { id: ref.id, ...row } };
});

function profileFields(value: unknown): Data {
  const fields = object(value); keys(fields, ['birthDate', 'contactEmail', 'contactPhone', 'guardianContactDetails', 'operationalNotes']);
  const birthDate = optional(fields.birthDate, 'birthDate', 10);
  if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(Date.parse(`${birthDate}T00:00:00.000Z`))
    || new Date(`${birthDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== birthDate)) invalid('Invalid birthDate.');
  return { birthDate, contactEmail: optional(fields.contactEmail, 'contactEmail', 254), contactPhone: optional(fields.contactPhone, 'contactPhone', 40),
    guardianContactDetails: optional(fields.guardianContactDetails, 'guardianContactDetails', 2000), operationalNotes: optional(fields.operationalNotes, 'operationalNotes', 4000) };
}
export const saveParticipantPrivateProfile = command('saveParticipantPrivateProfile', data => {
  keys(data, ['requestId', 'orgId', 'participantId', 'expectedRevision', 'fields']);
  return { ...identity(data), expectedRevision: revision(data.expectedRevision), fields: profileFields(data.fields) };
}, async (tx, payload, uid, _actor, replay) => {
  await adminScope(tx, payload.orgId, uid, !replay);
  const row = await participant(tx, payload.orgId, payload.participantId);
  const ref = participantRef(payload.orgId, payload.participantId).collection('private').doc('profile');
  const before = (await tx.get(ref)).data();
  if (replay) return replay;
  activeParticipant(row); checkRevision(before, payload.expectedRevision);
  const profile = { ...payload.fields, ...metadata(uid, before) };
  tx.set(ref, profile); audit(tx, payload.orgId, uid, 'saveParticipantPrivateProfile', payload.participantId, profile.revision);
  // Do not retain private fields in command receipts.
  return { revision: profile.revision };
});

export const approveSelfLink = command('approveSelfLink', data => {
  keys(data, ['requestId', 'orgId', 'participantId', 'userId', 'expectedRevision']);
  return { ...identity(data), userId: data.userId == null ? null : id(data.userId, 'userId'), expectedRevision: revision(data.expectedRevision) };
}, async (tx, payload, uid, _actor, replay) => {
  await adminScope(tx, payload.orgId, uid, !!payload.userId && !replay, !!payload.userId);
  const row = await participant(tx, payload.orgId, payload.participantId);
  if (payload.userId) await availableUser(tx, payload.userId);
  if (replay) return replay;
  if (payload.userId) activeParticipant(row);
  checkRevision(row, payload.expectedRevision);
  if (payload.userId && row.kind !== 'adult') invalid('Only a confirmed adult participant can be self-linked.');
  if (payload.userId && row.linkedUserId && row.linkedUserId !== payload.userId) invalid('Unlink the existing account before approving another.');
  const before = await projectionSources(tx, payload.orgId, payload.participantId, row);
  if (payload.userId && before.grants[payload.userId]) invalid('Revoke this account\'s guardian link before self-linking.');
  const after = { ...before, linkedUserId: payload.userId };
  const accessRevision = participantRevision(row);
  const projections = await prepareProjections(tx, payload.orgId, payload.participantId, before, after, row.status === 'active', accessRevision, uid);
  const updated: Data = { ...row, linkedUserId: payload.userId, accessRevision, ...metadata(uid, row) };
  tx.set(participantRef(payload.orgId, payload.participantId), updated); projections();
  audit(tx, payload.orgId, uid, 'approveSelfLink', payload.participantId, updated.revision);
  return { participant: { id: payload.participantId, ...updated } };
});

function grantPayload(data: Data, approving: boolean): Data {
  keys(data, ['requestId', 'orgId', 'participantId', 'userId', 'expectedRevision', ...(approving ? ['permissions'] : [])]);
  const permissions = approving ? object(data.permissions ?? { viewSchedule: true, viewProfile: true, editProfile: false, respond: false }) : null;
  if (permissions) {
    keys(permissions, ['viewSchedule', 'viewProfile', 'editProfile', 'respond']);
    for (const key of ['viewSchedule', 'viewProfile', 'editProfile', 'respond']) if (typeof permissions[key] !== 'boolean') invalid('Invalid guardian permissions.');
    if (permissions.respond || (permissions.editProfile && !permissions.viewProfile)) invalid('Invalid Phase 1 guardian permissions.');
  }
  return { ...identity(data), userId: id(data.userId, 'userId'), expectedRevision: revision(data.expectedRevision), permissions };
}
function guardianCommand(approving: boolean) {
  const name = approving ? 'approveGuardian' : 'revokeGuardian';
  return command(name, data => grantPayload(data, approving), async (tx, payload, uid, _actor, replay) => {
    const scope = await adminScope(tx, payload.orgId, uid, approving && !replay, approving);
    const row = await participant(tx, payload.orgId, payload.participantId);
    // Revocation must remain possible for archived participants/organizations and unavailable targets.
    if (approving) await availableUser(tx, payload.userId);
    if (replay) return replay;
    if (approving) {
      activeParticipant(row);
      if (payload.userId === row.linkedUserId) invalid('A self-linked account cannot also be its own guardian.');
      if (payload.permissions.editProfile && scope.organization.features?.guardianProfileEditing !== true) invalid('Guardian profile editing is not enabled.');
    }
    checkRevision(row, payload.expectedRevision);
    const ref = participantRef(payload.orgId, payload.participantId).collection('guardians').doc(payload.userId);
    const previous = (await tx.get(ref)).data();
    if (!approving && !previous) denied();
    const before = await projectionSources(tx, payload.orgId, payload.participantId, row);
    if (approving && !before.grants[payload.userId] && Object.keys(before.grants).length >= 10) throw new HttpsError('resource-exhausted', 'At most 10 active guardians are supported per participant.');
    const grant = { orgId: payload.orgId, participantId: payload.participantId, userId: payload.userId, status: approving ? 'active' : 'revoked',
      permissions: approving ? payload.permissions : previous!.permissions, grantedBy: approving ? uid : previous!.grantedBy,
      grantedAt: approving ? Timestamp.now() : previous!.grantedAt, revokedBy: approving ? null : uid, revokedAt: approving ? null : Timestamp.now(), ...metadata(uid, previous) };
    const grants = { ...before.grants }; if (approving) grants[payload.userId] = grant; else delete grants[payload.userId];
    // Include a revoked target even when no longer in the active canonical query.
    const oldSources = { ...before, grants: { ...before.grants, [payload.userId]: previous ?? grant } };
    const accessRevision = participantRevision(row);
    const projections = await prepareProjections(tx, payload.orgId, payload.participantId, oldSources, { ...before, grants }, row.status === 'active', accessRevision, uid);
    tx.set(ref, grant); tx.update(participantRef(payload.orgId, payload.participantId), { accessRevision, ...metadata(uid, row) });
    projections(); audit(tx, payload.orgId, uid, name, payload.participantId, accessRevision);
    return { grant, participantRevision: (row.revision ?? 0) + 1, accessRevision };
  });
}
export const approveGuardian = guardianCommand(true);
export const revokeGuardian = guardianCommand(false);

export const setRosterEnrollment = command('setRosterEnrollment', data => {
  keys(data, ['requestId', 'orgId', 'participantId', 'teamId', 'status', 'jerseyNumber', 'expectedRevision']);
  return { ...identity(data), teamId: id(data.teamId, 'teamId'), status: choice(data.status, ['active', 'removed'], 'status'),
    jerseyNumber: optional(data.jerseyNumber, 'jerseyNumber', 10), expectedRevision: revision(data.expectedRevision) };
}, async (tx, payload, uid, _actor, replay) => {
  const db = getFirestore(); const scope = await staffScope(tx, payload.orgId, uid);
  const team = (await tx.get(db.doc(`teams/${payload.teamId}`))).data();
  if (!team || team.schemaVersion !== 2 || team.orgId !== payload.orgId) denied();
  requireProgram(scope, team.programId);
  await hierarchy(tx, payload.orgId, team.programId, team.seasonId, team.divisionId, !replay && payload.status === 'active');
  if (scope.organization.features?.organizationV2 !== true) denied();
  const row = await participant(tx, payload.orgId, payload.participantId);
  const ref = db.doc(`teams/${payload.teamId}/roster/${payload.participantId}`); const previous = (await tx.get(ref)).data();
  if (previous && (previous.orgId !== payload.orgId || previous.participantId !== payload.participantId)) denied();
  if (replay) return replay;
  if (payload.status === 'active') { activeParticipant(row); if (team.status !== 'active') inactive(); }
  checkRevision(previous, payload.expectedRevision);
  const before = await projectionSources(tx, payload.orgId, payload.participantId, row);
  const teamIds = before.teamIds.filter(teamId => teamId !== payload.teamId);
  if (payload.status === 'active') teamIds.push(payload.teamId);
  if (teamIds.length > 20) throw new HttpsError('resource-exhausted', 'At most 20 active team enrollments are supported per participant.');
  const accessRevision = participantRevision(row);
  const projections = await prepareProjections(tx, payload.orgId, payload.participantId,
    { ...before, teamIds: [...new Set([...before.teamIds, payload.teamId])] }, { ...before, teamIds }, row.status === 'active', accessRevision, uid);
  const enrollment: Data = { orgId: payload.orgId, participantId: payload.participantId, status: payload.status, jerseyNumber: payload.jerseyNumber,
    joinedAt: previous?.joinedAt ?? Timestamp.now(), removedAt: payload.status === 'removed' ? Timestamp.now() : null, ...metadata(uid, previous) };
  tx.set(ref, enrollment); tx.update(participantRef(payload.orgId, payload.participantId), { accessRevision, ...metadata(uid, row) });
  projections(); audit(tx, payload.orgId, uid, 'setRosterEnrollment', payload.participantId, enrollment.revision);
  return { enrollment, participantRevision: (row.revision ?? 0) + 1, accessRevision };
});

export const getParticipantProfile = readCommand(data => {
  keys(data, ['orgId', 'participantId', 'staffPrivate']);
  if (data.staffPrivate != null && typeof data.staffPrivate !== 'boolean') invalid('Invalid staffPrivate.');
  return { ...identity(data), staffPrivate: data.staffPrivate === true };
}, async (tx, payload, uid) => {
  const row = payload.staffPrivate ? (await adminScope(tx, payload.orgId, uid), await participant(tx, payload.orgId, payload.participantId))
    : (await householdAccess(tx, payload.orgId, payload.participantId, uid, 'viewProfile')).row;
  const profile = (await tx.get(participantRef(payload.orgId, payload.participantId).collection('private').doc('profile'))).data();
  return { participant: publicParticipant(payload.participantId, row), profile: payload.staffPrivate ? profile ?? null : {
    birthDate: profile?.birthDate ?? null, contactEmail: profile?.contactEmail ?? null, contactPhone: profile?.contactPhone ?? null, revision: profile?.revision ?? 0,
  } };
});
export const listRoster = readCommand(data => {
  keys(data, ['orgId', 'teamId', 'pageSize', 'cursor']); return { orgId: id(data.orgId, 'orgId'), teamId: id(data.teamId, 'teamId'), ...page(data) };
}, async (tx, payload, uid) => {
  const db = getFirestore(); const team = (await tx.get(db.doc(`teams/${payload.teamId}`))).data();
  if (!team || team.orgId !== payload.orgId || team.schemaVersion !== 2) denied();
  const [org, member, coach] = await tx.getAll(db.doc(`organizations/${payload.orgId}`), db.doc(`organizations/${payload.orgId}/members/${uid}`), db.doc(`teamMembers/${payload.teamId}_${uid}`));
  const staff = member.data(); const assignment = coach.data();
  if (org.data()?.features?.organizationV2 !== true) denied();
  const canStaff = !!staff && staff.orgId === payload.orgId && staff.status === 'active'
    && (staff.roles?.includes('orgAdmin') || (staff.roles?.includes('programStaff') && staff.programIds?.includes(team.programId)));
  const canCoach = !!assignment && assignment.orgId === payload.orgId && assignment.teamId === payload.teamId && assignment.userId === uid
    && assignment.status === 'active' && assignment.roles?.some((role: string) => ['coach', 'captain'].includes(role));
  if (!canStaff && !canCoach) denied();
  await hierarchy(tx, payload.orgId, team.programId, team.seasonId, team.divisionId, false);
  let query = db.collection(`teams/${payload.teamId}/roster`).orderBy(FieldPath.documentId()).limit(payload.pageSize + 1);
  if (payload.cursor) query = query.startAfter(payload.cursor);
  const result = await tx.get(query); const items: Data[] = [];
  for (const doc of result.docs.slice(0, payload.pageSize)) {
    const enrollment = doc.data();
    if (enrollment.orgId !== payload.orgId || enrollment.participantId !== doc.id) denied();
    if (enrollment.status !== 'active') continue;
    const row = await participant(tx, payload.orgId, doc.id); if (row.status !== 'active') continue;
    items.push({ participantId: doc.id, displayName: row.displayName, jerseyNumber: enrollment.jerseyNumber ?? null, status: enrollment.status, revision: enrollment.revision ?? 0 });
  }
  return { items, nextCursor: result.size > payload.pageSize ? result.docs[payload.pageSize - 1].id : null };
});

export const editParticipantProfile = command('editParticipantProfile', data => {
  keys(data, ['requestId', 'orgId', 'participantId', 'expectedRevision', 'fields']);
  const fields = object(data.fields); keys(fields, ['contactEmail', 'contactPhone']);
  return { ...identity(data), expectedRevision: revision(data.expectedRevision), fields: {
    ...(Object.prototype.hasOwnProperty.call(fields, 'contactEmail') ? { contactEmail: optional(fields.contactEmail, 'contactEmail', 254) } : {}),
    ...(Object.prototype.hasOwnProperty.call(fields, 'contactPhone') ? { contactPhone: optional(fields.contactPhone, 'contactPhone', 40) } : {}),
  } };
}, async (tx, payload, uid, _actor, replay) => {
  const access = await householdAccess(tx, payload.orgId, payload.participantId, uid, 'editProfile');
  if (!access.self && access.organization.features?.guardianProfileEditing !== true) denied();
  const ref = participantRef(payload.orgId, payload.participantId).collection('private').doc('profile');
  const previous = (await tx.get(ref)).data();
  if (replay) return replay;
  if (access.organization.status !== 'active') inactive();
  checkRevision(previous, payload.expectedRevision);
  const profile: Data = { ...previous, ...payload.fields, ...metadata(uid, previous) };
  tx.set(ref, profile); audit(tx, payload.orgId, uid, 'editParticipantProfile', payload.participantId, profile.revision);
  return { revision: profile.revision };
});
