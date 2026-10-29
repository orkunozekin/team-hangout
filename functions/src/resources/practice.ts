import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, optional, revision, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied, requireProgram, staffScope } from '../operations/access';
import { audit } from '../organizations/commands';
import { coachingEvent, teamViewer } from '../coaching/lineups';

const db = () => getFirestore();
/** Keep aligned with shared/practiceResources.ts. */
export const PRACTICE_LIMITS = {
  ageMin: 4, ageMax: 19, title: 80, objective: 120, objectives: 5, equipmentItem: 60, equipment: 10, instructions: 4000,
  safety: 1000, durationMax: 120, planItems: 20, plannedMax: 180, planTotal: 600, note: 2000, householdNote: 1000, page: 50,
};
export const RIGHTS_ORIGINS = ['original', 'commissioned', 'licensed'] as const;

const fail = (code: string, message: string, status: 'failed-precondition' | 'permission-denied' = 'failed-precondition', extra: Data = {}): never => {
  throw new HttpsError(status, message, { domainCode: code, ...extra });
};
const resources = (orgId: string) => db().collection(`organizations/${orgId}/practiceResources`);
const millis = (value: unknown) => (value instanceof Timestamp ? value.toMillis() : null);

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(`${field} must be ${min} through ${max}.`);
  return value as number;
}
function list(value: unknown, field: string, maxItems: number, maxLength: number, required: boolean): string[] {
  if (!Array.isArray(value) || value.length > maxItems || (required && value.length === 0)) invalid(`Invalid ${field}.`);
  const items = (value as unknown[]).map(item => text(item, field, maxLength));
  if (new Set(items).size !== items.length) invalid(`Remove duplicate ${field}.`);
  return items;
}
function instant(value: unknown, field: string): Timestamp | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${field}.`);
  return Timestamp.fromMillis(Date.parse(value as string));
}

/** Exported for pure tests. Content is original instructional text; links and media are not accepted here. */
export function normalizeContent(value: unknown) {
  const content = object(value);
  keys(content, ['title', 'objectives', 'ageMin', 'ageMax', 'durationMinutes', 'equipment', 'instructions', 'safetyNotes']);
  const ageMin = integer(content.ageMin, 'ageMin', PRACTICE_LIMITS.ageMin, PRACTICE_LIMITS.ageMax);
  const ageMax = integer(content.ageMax, 'ageMax', PRACTICE_LIMITS.ageMin, PRACTICE_LIMITS.ageMax);
  if (ageMax < ageMin) invalid('ageMax must be at least ageMin.');
  return {
    title: text(content.title, 'title', PRACTICE_LIMITS.title),
    objectives: list(content.objectives, 'objectives', PRACTICE_LIMITS.objectives, PRACTICE_LIMITS.objective, true),
    ageMin, ageMax,
    durationMinutes: integer(content.durationMinutes, 'durationMinutes', 1, PRACTICE_LIMITS.durationMax),
    equipment: list(content.equipment ?? [], 'equipment', PRACTICE_LIMITS.equipment, PRACTICE_LIMITS.equipmentItem, false),
    instructions: text(content.instructions, 'instructions', PRACTICE_LIMITS.instructions),
    safetyNotes: text(content.safetyNotes, 'safetyNotes', PRACTICE_LIMITS.safety),
  };
}

/** Exported for pure tests. Rights evidence is a reference the organization holds; the app never fetches or stores the asset. */
export function normalizeRights(value: unknown) {
  const rights = object(value);
  keys(rights, ['origin', 'owner', 'allowedUses', 'attribution', 'evidence', 'licenseUrl', 'expiresAt', 'derivativesAllowed']);
  if (!RIGHTS_ORIGINS.includes(rights.origin)) invalid('Choose original, commissioned or licensed.');
  if (typeof rights.derivativesAllowed !== 'boolean') invalid('Record whether derivatives are allowed.');
  const licenseUrl = optional(rights.licenseUrl, 'licenseUrl', 300);
  if (licenseUrl && !/^https:\/\/[^\s]+$/i.test(licenseUrl)) invalid('The license URL must start with https://.');
  const attribution = optional(rights.attribution, 'attribution', 200);
  if (rights.origin === 'licensed' && (!attribution || !licenseUrl)) invalid('Licensed resources need attribution and a license URL.');
  return {
    origin: rights.origin as string,
    owner: text(rights.owner, 'owner', 120),
    allowedUses: text(rights.allowedUses, 'allowedUses', 300),
    attribution,
    evidence: text(rights.evidence, 'evidence', 500),
    licenseUrl,
    expiresAt: rights.expiresAt == null ? null : rights.expiresAt,
    derivativesAllowed: rights.derivativesAllowed as boolean,
  };
}

const expired = (rights: Data | null | undefined, now: number) => {
  const at = millis(rights?.expiresAt);
  return at != null && at <= now;
};
const ages = (content: Data) => Array.from({ length: content.ageMax - content.ageMin + 1 }, (_, i) => content.ageMin + i);

/** Selectable means published, not withdrawn and the recorded permission has not expired. */
export function availability(resource: Data | undefined, now: number): 'available' | 'withdrawn' | 'expired' | 'unpublished' {
  if (!resource) return 'unpublished';
  if (resource.status === 'withdrawn') return 'withdrawn';
  if (resource.status !== 'published' || !resource.published) return 'unpublished';
  return expired(resource.published.rights, now) ? 'expired' : 'available';
}

async function enabledOrg(tx: Transaction, orgId: string) {
  const org = (await tx.get(db().doc(`organizations/${orgId}`))).data();
  if (!org || org.schemaVersion !== 2 || org.features?.organizationV2 !== true) denied();
  if (org!.features?.practiceResources !== true) fail('PRACTICE_RESOURCES_DISABLED', 'Practice resources are not enabled for this organization.');
  return org!;
}

/** practiceResources.manage: a live organization administrator, or program staff for the resource's program. */
async function editorScope(tx: Transaction, orgId: string, programId: string, uid: string) {
  const scope = await staffScope(tx, orgId, uid);
  requireProgram(scope, programId);
  const program = (await tx.get(db().doc(`organizations/${orgId}/programs/${programId}`))).data();
  if (!program || program.schemaVersion !== 2 || program.orgId !== orgId) denied();
  await enabledOrg(tx, orgId);
  return { ...scope, program: program! };
}

/**
 * A designated reviewer is recorded by the organization outside the app (no client or callable writes it) and must
 * also hold a live editor grant for the program. The designation records the qualification the organization verified.
 */
async function reviewerDesignation(tx: Transaction, orgId: string, programId: string, uid: string) {
  const row = (await tx.get(db().doc(`organizations/${orgId}/resourceReviewers/${uid}`))).data();
  return row?.status === 'active' && row.orgId === orgId && row.userId === uid && Array.isArray(row.programIds)
    && row.programIds.includes(programId) && typeof row.qualification === 'string' && row.qualification.trim() ? row : null;
}

function resourceEnvelope(data: Data, payloadFields: string[]) {
  keys(data, ['requestId', 'orgId', 'resourceId', 'expectedRevision', 'payload']);
  const payload = object(data.payload);
  keys(payload, payloadFields);
  return {
    payload,
    base: {
      requestId: id(data.requestId, 'requestId'),
      orgId: id(data.orgId, 'orgId'),
      expectedRevision: revision(data.expectedRevision),
    },
  };
}

async function existing(tx: Transaction, orgId: string, resourceId: string) {
  const ref = resources(orgId).doc(resourceId);
  const resource = (await tx.get(ref)).data();
  if (!resource || resource.schemaVersion !== 2 || resource.orgId !== orgId) fail('PRACTICE_RESOURCE_MISSING', 'This practice resource no longer exists.');
  return { ref, resource: resource! };
}

/** Editors save a draft version. Publication never happens here; it needs a different designated reviewer. */
export const savePracticeResource = command('savePracticeResource', data => {
  const { payload, base } = resourceEnvelope(data, ['programId', 'content', 'rights']);
  const content = normalizeContent(payload.content);
  const rights = normalizeRights(payload.rights);
  if (rights.expiresAt != null) instant(rights.expiresAt, 'expiresAt');
  return {
    ...base, resourceId: data.resourceId == null ? null : id(data.resourceId, 'resourceId'),
    programId: id(payload.programId, 'programId'), content, rights,
  };
}, async (tx, data, uid, _actor, replay) => {
  const scope = await editorScope(tx, data.orgId, data.programId, uid);
  if (replay) return replay;
  const ref = data.resourceId ? resources(data.orgId).doc(data.resourceId) : resources(data.orgId).doc();
  const current = data.resourceId ? (await existing(tx, data.orgId, data.resourceId)).resource : undefined;
  if (current && current.programId !== data.programId) denied();
  checkRevision(current, data.expectedRevision);
  if (current?.status === 'withdrawn') fail('PRACTICE_RESOURCE_WITHDRAWN', 'This resource was withdrawn. Create a new resource instead.');
  const now = Timestamp.now();
  const rights = { ...data.rights, expiresAt: instant(data.rights.expiresAt, 'expiresAt') };
  if (expired(rights, now.toMillis())) fail('PRACTICE_RIGHTS_EXPIRED', 'The recorded permission has already expired.');
  const next = (current?.revision ?? 0) + 1;
  const version = current?.draft?.version ?? (current?.published?.version ?? 0) + 1;
  tx.set(ref, {
    schemaVersion: 2, orgId: data.orgId, programId: data.programId, sportCode: scope.program.sportCode ?? null,
    status: current?.status ?? 'draft', title: current?.published ? current.title : data.content.title,
    ages: current?.ages ?? [], draft: { version, content: data.content, rights, editedBy: uid, editedAt: now },
    published: current?.published ?? null, revision: next,
    createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? uid, updatedAt: now, updatedBy: uid,
  });
  audit(tx, data.orgId, uid, 'savePracticeResource', ref.id, next);
  return { requestId: data.requestId, revision: next, state: current?.status ?? 'draft', resourceId: ref.id, version };
});

/**
 * approve: a designated reviewer, not the draft's last editor, attests rights and age/safety review and publishes that exact draft.
 * withdraw: any editor; terminal, so the resource can never be newly assigned again.
 */
export const publishPracticeResource = command('publishPracticeResource', data => {
  const { payload, base } = resourceEnvelope(data, ['action', 'rightsVerified', 'ageSafetyReviewed', 'reviewNote', 'reason']);
  const resourceId = id(data.resourceId, 'resourceId');
  if (payload.action === 'approve') {
    if (payload.rightsVerified !== true || payload.ageSafetyReviewed !== true) {
      invalid('Confirm the rights evidence and the age and safety review before approving.');
    }
    return { ...base, resourceId, action: 'approve', reviewNote: optional(payload.reviewNote, 'reviewNote', 500) };
  }
  if (payload.action === 'withdraw') return { ...base, resourceId, action: 'withdraw', reason: text(payload.reason, 'reason', 300) };
  return invalid('Invalid resource action.');
}, async (tx, data, uid, _actor, replay) => {
  const { ref, resource } = await existing(tx, data.orgId, data.resourceId);
  await editorScope(tx, data.orgId, resource.programId, uid);
  const reviewer = data.action === 'approve' ? await reviewerDesignation(tx, data.orgId, resource.programId, uid) : null;
  if (data.action === 'approve' && !reviewer) fail('PRACTICE_REVIEWER_REQUIRED', 'Only a designated content reviewer can approve resources.', 'permission-denied');
  if (replay) return replay;
  checkRevision(resource, data.expectedRevision);
  if (resource.status === 'withdrawn') fail('PRACTICE_RESOURCE_WITHDRAWN', 'This resource was withdrawn.');
  const now = Timestamp.now();
  const next = resource.revision + 1;
  if (data.action === 'withdraw') {
    // Withdrawal clears the age index so no listing or plan save can select it again.
    tx.update(ref, { status: 'withdrawn', ages: [], draft: null, withdrawal: { reason: data.reason, by: uid, at: now }, revision: next, updatedAt: now, updatedBy: uid });
    audit(tx, data.orgId, uid, 'withdrawPracticeResource', ref.id, next);
    return { requestId: data.requestId, revision: next, state: 'withdrawn', resourceId: ref.id, version: resource.published?.version ?? null };
  }
  const draft = resource.draft;
  if (!draft) fail('PRACTICE_NOTHING_TO_REVIEW', 'There is no draft to review.');
  if (draft.editedBy === uid) fail('PRACTICE_REVIEWER_CONFLICT', 'A different reviewer must approve your own edits.', 'permission-denied');
  if (!draft.rights?.evidence || !draft.rights?.owner) fail('PRACTICE_RIGHTS_MISSING', 'Record rights evidence before approval.');
  if (expired(draft.rights, now.toMillis())) fail('PRACTICE_RIGHTS_EXPIRED', 'The recorded permission has expired. Record renewed evidence first.');
  const review = { reviewerUid: uid, qualification: reviewer!.qualification, rightsVerified: true, ageSafetyReviewed: true, note: data.reviewNote, reviewedAt: now };
  const published = { version: draft.version, content: draft.content, rights: draft.rights, editedBy: draft.editedBy, review, publishedAt: now };
  tx.create(ref.collection('versions').doc(String(draft.version)), { schemaVersion: 2, orgId: data.orgId, resourceId: ref.id, ...published });
  tx.update(ref, {
    status: 'published', title: draft.content.title, ages: ages(draft.content), draft: null, published,
    revision: next, updatedAt: now, updatedBy: uid,
  });
  audit(tx, data.orgId, uid, 'approvePracticeResource', ref.id, next);
  return { requestId: data.requestId, revision: next, state: 'published', resourceId: ref.id, version: draft.version };
});

function editorRow(doc: FirebaseFirestore.QueryDocumentSnapshot, now: number) {
  const row = doc.data();
  return {
    resourceId: doc.id, programId: row.programId, sportCode: row.sportCode ?? null, title: row.title, status: row.status,
    availability: availability(row, now), revision: row.revision,
    publishedVersion: row.published?.version ?? null, draftVersion: row.draft?.version ?? null,
    ageMin: row.published?.content.ageMin ?? row.draft?.content.ageMin ?? null, ageMax: row.published?.content.ageMax ?? row.draft?.content.ageMax ?? null,
    rightsExpiresAt: row.published?.rights.expiresAt ?? null, reviewedAt: row.published?.review.reviewedAt ?? null,
  };
}

function coachRow(doc: FirebaseFirestore.QueryDocumentSnapshot) {
  const row = doc.data();
  const { content, rights, version } = row.published;
  return { resourceId: doc.id, version, sportCode: row.sportCode ?? null, ...content, attribution: rights.attribution ?? null };
}

/**
 * Editors (programId) list every state; coaches (teamId) list only selectable resources for their team's program.
 * Pagination follows scanned document IDs, so rows filtered for expiry never hide later pages.
 */
export const listPracticeResources = readCommand(data => {
  keys(data, ['orgId', 'programId', 'teamId', 'age', 'status', 'pageSize', 'cursor']);
  if ((data.programId == null) === (data.teamId == null)) invalid('Choose a program or a team.');
  const pageSize = data.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PRACTICE_LIMITS.page) invalid(`pageSize must be 1 through ${PRACTICE_LIMITS.page}.`);
  const status = data.status ?? null;
  if (status != null && !['draft', 'published', 'withdrawn'].includes(status)) invalid('Invalid status.');
  const age = data.age == null ? null : integer(data.age, 'age', PRACTICE_LIMITS.ageMin, PRACTICE_LIMITS.ageMax);
  if (age != null && status != null && status !== 'published') invalid('Age filters apply to published resources.');
  return {
    orgId: id(data.orgId, 'orgId'), programId: data.programId == null ? null : id(data.programId, 'programId'),
    teamId: data.teamId == null ? null : id(data.teamId, 'teamId'), age, status, pageSize,
    cursor: data.cursor == null ? null : id(data.cursor, 'cursor'),
  };
}, async (tx, input, uid) => {
  let programId = input.programId as string | null;
  const coach = input.teamId != null;
  if (coach) {
    const [team, member] = await tx.getAll(db().doc(`teams/${input.teamId}`), db().doc(`teamMembers/${input.teamId}_${uid}`));
    const t = team.data();
    const m = member.data();
    if (t?.schemaVersion !== 2 || t.orgId !== input.orgId || !m || m.teamId !== input.teamId || m.userId !== uid || m.orgId !== input.orgId
      || m.status !== 'active' || !Array.isArray(m.roles) || !m.roles.includes('coach')) denied();
    programId = t!.programId;
    await enabledOrg(tx, input.orgId);
  } else {
    await editorScope(tx, input.orgId, programId!, uid);
  }
  let query = resources(input.orgId).where('programId', '==', programId);
  const status = coach || input.age != null ? 'published' : input.status;
  if (status) query = query.where('status', '==', status);
  if (input.age != null) query = query.where('ages', 'array-contains', input.age);
  query = query.orderBy(FieldPath.documentId());
  if (input.cursor) query = query.startAfter(input.cursor);
  const snap = await tx.get(query.limit(input.pageSize + 1));
  const page = snap.docs.slice(0, input.pageSize).filter(doc => doc.data().schemaVersion === 2 && doc.data().orgId === input.orgId);
  const now = Date.now();
  const items = coach ? page.filter(doc => availability(doc.data(), now) === 'available').map(coachRow) : page.map(doc => editorRow(doc, now));
  return { programId, items, nextCursor: snap.size > input.pageSize ? snap.docs[input.pageSize - 1].id : null };
});

export const getPracticeResource = readCommand(data => {
  keys(data, ['orgId', 'resourceId']);
  return { orgId: id(data.orgId, 'orgId'), resourceId: id(data.resourceId, 'resourceId') };
}, async (tx, input, uid) => {
  const { resource } = await existing(tx, input.orgId, input.resourceId);
  await editorScope(tx, input.orgId, resource.programId, uid);
  const reviewer = await reviewerDesignation(tx, input.orgId, resource.programId, uid);
  const now = Date.now();
  return {
    resourceId: input.resourceId, programId: resource.programId, sportCode: resource.sportCode ?? null, status: resource.status,
    availability: availability(resource, now), revision: resource.revision, draft: resource.draft ?? null,
    published: resource.published ?? null, withdrawal: resource.withdrawal ?? null,
    canReview: !!reviewer && !!resource.draft && resource.draft.editedBy !== uid && resource.status !== 'withdrawn',
  };
});

function planEnvelope(data: Data) {
  keys(data, ['requestId', 'orgId', 'resourceId', 'expectedRevision', 'payload']);
  const payload = object(data.payload);
  const base = {
    requestId: id(data.requestId, 'requestId'), orgId: id(data.orgId, 'orgId'), eventId: id(data.resourceId, 'eventId'),
    expectedRevision: revision(data.expectedRevision), teamId: id(payload.teamId, 'teamId'),
  };
  const action = payload.action ?? 'save';
  if (action === 'publish' || action === 'retract') {
    keys(payload, ['teamId', 'action']);
    return { ...base, action };
  }
  if (action !== 'save') invalid('Invalid plan action.');
  keys(payload, ['teamId', 'action', 'items', 'householdNote', 'privateNote']);
  if (!Array.isArray(payload.items) || payload.items.length > PRACTICE_LIMITS.planItems) invalid(`A plan holds at most ${PRACTICE_LIMITS.planItems} activities.`);
  const items = (payload.items as unknown[]).map(raw => {
    const item = object(raw);
    keys(item, ['resourceId', 'version', 'plannedMinutes']);
    return {
      resourceId: id(item.resourceId, 'resourceId'), version: integer(item.version, 'version', 1, Number.MAX_SAFE_INTEGER),
      plannedMinutes: integer(item.plannedMinutes, 'plannedMinutes', 1, PRACTICE_LIMITS.plannedMax),
    };
  });
  if (new Set(items.map(item => item.resourceId)).size !== items.length) invalid('Each resource can appear once in a plan.');
  if (items.reduce((sum, item) => sum + item.plannedMinutes, 0) > PRACTICE_LIMITS.planTotal) invalid(`Plans are limited to ${PRACTICE_LIMITS.planTotal} minutes.`);
  const note = (value: unknown, field: string, max: number) => {
    if (value != null && (typeof value !== 'string' || value.trim().length > max)) invalid(`${field} is limited to ${max} characters.`);
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    ...base, action, items,
    householdNote: note(payload.householdNote, 'householdNote', PRACTICE_LIMITS.householdNote),
    privateNote: note(payload.privateNote, 'privateNote', PRACTICE_LIMITS.note),
  };
}

function unavailable(resourceIds: string[]): never {
  return fail('PRACTICE_RESOURCE_UNAVAILABLE', 'A resource in this plan was withdrawn, expired or replaced. Remove or re-add it before saving.', 'failed-precondition', { resourceIds });
}

async function readResources(tx: Transaction, orgId: string, resourceIds: string[]) {
  const unique = [...new Set(resourceIds)];
  const docs = unique.length ? await tx.getAll(...unique.map(resourceId => resources(orgId).doc(resourceId))) : [];
  return new Map(unique.map((resourceId, i) => {
    const row = docs[i].data();
    return [resourceId, row?.schemaVersion === 2 && row.orgId === orgId ? row : undefined];
  }));
}

async function planScope(tx: Transaction, data: Data, uid: string, writing: boolean) {
  const { scope, event } = await coachingEvent(tx, data.eventId, data.teamId, uid, writing);
  if (scope.orgId !== data.orgId) denied();
  if (event.type !== 'practice') fail('PRACTICE_PLAN_PRACTICE_ONLY', 'Practice plans attach to practice events.');
  return { scope, event };
}

/**
 * Saving snapshots the published version of each newly added resource. An activity already in the plan keeps its
 * snapshot, but every item must still be selectable: withdrawn or expired resources block the save until removed.
 */
export const savePracticePlan = command('savePracticePlan', planEnvelope, async (tx, data, uid, _actor, replay) => {
  const { scope, event } = await planScope(tx, data, uid, !replay);
  await enabledOrg(tx, scope.orgId);
  if (replay) return replay;
  const ref = db().doc(`events/${data.eventId}/practicePlans/${data.teamId}`);
  const viewRef = ref.collection('views').doc('household');
  const noteRef = ref.collection('notes').doc('plan');
  const current = (await tx.get(ref)).data();
  checkRevision(current, data.expectedRevision);
  const now = Timestamp.now();
  const next = (current?.revision ?? 0) + 1;
  const prior = current?.publication ?? { state: 'private', sourceRevision: null, publishedAt: null, publicationRevision: 0 };
  if (data.action !== 'save' && !current) fail('PRACTICE_PLAN_NOT_SAVED', 'Save a practice plan before publishing it.');
  if (data.action === 'publish' && event.status === 'cancelled') fail('PRACTICE_EVENT_CANCELLED', 'This practice was cancelled.');
  const items: Data[] = data.action === 'save' ? data.items : current!.items;
  const found = await readResources(tx, scope.orgId, items.map(item => item.resourceId));
  const nowMs = now.toMillis();
  const kept = new Map(((current?.items ?? []) as Data[]).map(item => [`${item.resourceId}:${item.version}`, item]));
  const blocked = items.filter(item => {
    const resource = found.get(item.resourceId);
    if (!resource || resource.programId !== scope.programId || availability(resource, nowMs) !== 'available') return true;
    // A new activity must use the current published version; a kept one may keep its older snapshot.
    return data.action === 'save' && !kept.has(`${item.resourceId}:${item.version}`) && resource.published.version !== item.version;
  }).map(item => item.resourceId);
  if (blocked.length && data.action !== 'retract') unavailable(blocked);
  if (data.action === 'save') {
    const snapshot = data.items.map((item: Data) => {
      const previous = kept.get(`${item.resourceId}:${item.version}`);
      if (previous) return { ...previous, plannedMinutes: item.plannedMinutes };
      const { content, rights, version } = found.get(item.resourceId)!.published;
      return { resourceId: item.resourceId, version, ...content, attribution: rights.attribution ?? null, plannedMinutes: item.plannedMinutes };
    });
    tx.set(ref, {
      schemaVersion: 2, orgId: scope.orgId, programId: scope.programId, seasonId: scope.seasonId, eventId: data.eventId,
      teamId: data.teamId, items: snapshot, householdNote: data.householdNote, publication: prior, revision: next,
      createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? uid, updatedAt: now, updatedBy: uid,
    });
    // Private notes live in a separate document that no publication path reads.
    if (data.privateNote) tx.set(noteRef, { schemaVersion: 2, orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, text: data.privateNote, authorUid: uid, editedAt: now });
    else tx.delete(noteRef);
    return { requestId: data.requestId, revision: next, state: prior.state };
  }
  let publication: Data;
  if (data.action === 'publish') {
    publication = { state: 'published', sourceRevision: next, publishedAt: now, publicationRevision: prior.publicationRevision + 1 };
    // Explicit allowlist: activity instructions and the household note only. No private notes, rights evidence or actor IDs.
    tx.set(viewRef, {
      schemaVersion: 2, orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, householdNote: current!.householdNote,
      items: items.map(item => ({
        resourceId: item.resourceId, version: item.version, title: item.title, objectives: item.objectives, plannedMinutes: item.plannedMinutes,
        equipment: item.equipment, instructions: item.instructions, safetyNotes: item.safetyNotes, attribution: item.attribution ?? null,
      })),
      publicationRevision: publication.publicationRevision, publishedAt: now,
    });
  } else {
    publication = { state: 'private', sourceRevision: null, publishedAt: null, publicationRevision: prior.publicationRevision };
    tx.delete(viewRef);
  }
  tx.update(ref, { publication, revision: next, updatedAt: now, updatedBy: uid });
  return { requestId: data.requestId, revision: next, state: publication.state };
});

/** Notice for a referenced resource that can no longer be assigned; its instructions are no longer shown to households. */
function notice(resource: Data | undefined, item: Data, now: number) {
  const state = availability(resource, now);
  if (state === 'available') return resource!.published.version === item.version ? null : 'superseded';
  return state === 'unpublished' ? 'withdrawn' : state;
}

export const getEventPracticePlan = readCommand(data => {
  keys(data, ['eventId', 'teamId', 'participantId']);
  return {
    eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId'),
    participantId: data.participantId == null ? null : id(data.participantId, 'participantId'),
  };
}, async (tx, data, uid) => {
  let coach: Data | null = null;
  try {
    coach = (await coachingEvent(tx, data.eventId, data.teamId, uid, false)).scope;
  } catch (error) {
    if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error;
  }
  const team = coach ? null : await teamViewer(tx, data.eventId, data.teamId, data.participantId, uid);
  const orgId = coach?.orgId ?? team!.orgId;
  const org = (await tx.get(db().doc(`organizations/${orgId}`))).data();
  if (org?.features?.practiceResources !== true) return { enabled: false, canManage: false, eventId: data.eventId, teamId: data.teamId };
  const event = (await tx.get(db().doc(`events/${data.eventId}`))).data()!;
  const ref = db().doc(`events/${data.eventId}/practicePlans/${data.teamId}`);
  const now = Date.now();
  if (coach) {
    const [planDoc, noteDoc] = await tx.getAll(ref, ref.collection('notes').doc('plan'));
    const plan = planDoc.data();
    const items = (plan?.items ?? []) as Data[];
    const found = await readResources(tx, orgId, items.map(item => item.resourceId));
    const publication = plan?.publication ?? { state: 'private', sourceRevision: null, publishedAt: null };
    return {
      enabled: true, canManage: true, orgId, programId: coach.programId, eventId: data.eventId, teamId: data.teamId, eventType: event.type,
      revision: plan?.revision ?? 0, items: items.map(item => ({ ...item, notice: notice(found.get(item.resourceId), item, now) })),
      householdNote: plan?.householdNote ?? '', privateNote: noteDoc.data()?.text ?? '',
      publication: { state: publication.state, sourceRevision: publication.sourceRevision, publishedAt: publication.publishedAt },
    };
  }
  const view = (await tx.get(ref.collection('views').doc('household'))).data();
  if (!view) return { enabled: true, canManage: false, eventId: data.eventId, teamId: data.teamId, eventType: event.type, state: 'unpublished' };
  const found = await readResources(tx, orgId, (view.items as Data[]).map(item => item.resourceId));
  return {
    enabled: true, canManage: false, eventId: data.eventId, teamId: data.teamId, eventType: event.type, state: 'published',
    householdNote: view.householdNote, publishedAt: view.publishedAt,
    items: (view.items as Data[]).map(item => {
      const state = notice(found.get(item.resourceId), item, now);
      return state === 'withdrawn' || state === 'expired'
        ? { title: item.title, plannedMinutes: item.plannedMinutes, notice: state }
        : { title: item.title, objectives: item.objectives, plannedMinutes: item.plannedMinutes, equipment: item.equipment,
          instructions: item.instructions, safetyNotes: item.safetyNotes, attribution: item.attribution, notice: null };
    }),
  };
});
