import { randomUUID } from 'node:crypto';
import { getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, revision, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied } from '../operations/access';
import { fingerprint } from '../operations/requests';
import { coachingEvent, teamViewer } from '../coaching/lineups';

const db = () => getFirestore();
/** Keep aligned with shared/volunteers.ts. */
export const VOLUNTEER_KINDS = ['snacks', 'setup', 'scorekeeping', 'cleanup', 'other'] as const;
const SLOT_LIMIT = 30;
const CAPACITY_MAX = 50;
const ALIAS_MAX = 40;

const fail = (code: string, message: string, status: 'failed-precondition' | 'permission-denied' = 'failed-precondition'): never => {
  throw new HttpsError(status, message, { domainCode: code });
};

/** A chosen alias must not smuggle contact details into the shared assignment list. */
export function displayAlias(value: unknown): string {
  const alias = text(value, 'display name', ALIAS_MAX).replace(/\s+/g, ' ');
  if (/@|https?:|www\./i.test(alias) || /\d[\d\s().-]{5,}\d/.test(alias)) {
    invalid('Use a display name or initials only. Do not include email, phone or links.');
  }
  return alias;
}

function envelope(data: Data, payloadFields: string[]) {
  keys(data, ['requestId', 'orgId', 'resourceId', 'expectedRevision', 'payload']);
  const payload = object(data.payload);
  keys(payload, payloadFields);
  return {
    payload,
    base: {
      requestId: id(data.requestId, 'requestId'),
      orgId: id(data.orgId, 'orgId'),
      eventId: id(data.resourceId, 'eventId'),
      teamId: id(payload.teamId, 'teamId'),
    },
  };
}

function millis(value: unknown) {
  return value instanceof Timestamp ? value.toMillis() : null;
}

/** Claims close at the slot deadline, or when the event starts. Only scheduled events accept volunteers. */
export function slotState(slot: Data, event: Data, now: number) {
  if (slot.status === 'cancelled' || event.status === 'cancelled') return 'cancelled';
  const closes = millis(slot.claimDeadline) ?? millis(event.startsAt) ?? 0;
  if (event.status !== 'scheduled' || now >= closes) return 'closed';
  return slot.openCount > 0 ? 'open' : 'full';
}

async function slotScope(tx: Transaction, data: Data, uid: string, writing: boolean) {
  const { scope, event } = await coachingEvent(tx, data.eventId, data.teamId, uid, writing);
  if (scope.orgId !== data.orgId) denied();
  return { scope, event };
}

function deadline(value: unknown, event: Data): Timestamp | null {
  if (value == null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalid('Invalid claim deadline.');
  const at = Timestamp.fromMillis(Date.parse(value as string));
  const ends = millis(event.endsAt);
  if (ends != null && at.toMillis() > ends) invalid('The claim deadline must be before the event ends.');
  return at;
}

export const saveVolunteerSlot = command('saveVolunteerSlot', data => {
  const { payload, base } = envelope(data, ['teamId', 'slotId', 'action', 'kind', 'title', 'capacity', 'claimDeadline']);
  const action = payload.action ?? 'save';
  if (!['save', 'cancel'].includes(action)) invalid('Invalid slot action.');
  const slotId = payload.slotId == null ? null : id(payload.slotId, 'slotId');
  if (action === 'cancel') {
    if (!slotId) invalid('Choose a slot to cancel.');
    return { ...base, expectedRevision: revision(data.expectedRevision), slotId, action };
  }
  if (!VOLUNTEER_KINDS.includes(payload.kind)) invalid('Choose a supported slot kind.');
  const capacity = payload.capacity;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > CAPACITY_MAX) invalid(`Capacity must be 1 through ${CAPACITY_MAX}.`);
  return {
    ...base, expectedRevision: revision(data.expectedRevision), slotId, action, kind: payload.kind,
    title: text(payload.title, 'title', 80), capacity, claimDeadline: payload.claimDeadline ?? null,
  };
}, async (tx, data, uid, _actor, replay) => {
  const { scope, event } = await slotScope(tx, data, uid, !replay);
  if (replay) return replay;
  const slots = db().collection(`events/${data.eventId}/volunteerSlots`);
  const ref = data.slotId ? slots.doc(data.slotId) : slots.doc();
  const current = data.slotId ? (await tx.get(ref)).data() : undefined;
  if (data.slotId && (!current || current.teamId !== data.teamId)) fail('VOLUNTEER_SLOT_MISSING', 'This volunteer slot no longer exists.');
  checkRevision(current, data.expectedRevision);
  if (current?.status === 'cancelled') fail('VOLUNTEER_SLOT_CANCELLED', 'This volunteer slot was cancelled.');
  const now = Timestamp.now();
  const next = (current?.revision ?? 0) + 1;
  if (data.action === 'cancel') {
    tx.update(ref, { status: 'cancelled', revision: next, cancelledAt: now, updatedAt: now, updatedBy: uid });
    if (current!.claimedCount > 0) {
      // Generic copy only: aliases and claimant identity never enter the outbox.
      tx.create(db().doc(`organizations/${scope.orgId}/outbox/${fingerprint({ eventId: data.eventId, slotId: ref.id, revision: next, kind: 'volunteerSlotCancelled' })}`), {
        schemaVersion: 2, orgId: scope.orgId, sourceType: 'event', sourceId: data.eventId, sourceRevision: event.revision ?? 0,
        templateKey: 'volunteerSlotCancelled', state: 'pending', critical: false, audience: { teamIds: [data.teamId] },
        programId: scope.programId, createdAt: now, updatedAt: now, auditCorrelationId: `${data.eventId}:${ref.id}:${next}`,
      });
    }
    return { requestId: data.requestId, revision: next, state: 'cancelled', slotId: ref.id };
  }
  if (!current) {
    const existing = await tx.get(slots.where('teamId', '==', data.teamId).limit(SLOT_LIMIT));
    if (existing.size >= SLOT_LIMIT) fail('VOLUNTEER_SLOT_LIMIT', `A team can have at most ${SLOT_LIMIT} volunteer slots per event.`);
  }
  const claimed = current?.claimedCount ?? 0;
  if (data.capacity < claimed) fail('VOLUNTEER_CAPACITY_BELOW_CLAIMS', 'Capacity cannot be lower than the current number of volunteers.');
  tx.set(ref, {
    schemaVersion: 2, orgId: scope.orgId, programId: scope.programId, seasonId: scope.seasonId,
    eventId: data.eventId, teamId: data.teamId, kind: data.kind, title: data.title, capacity: data.capacity,
    claimedCount: claimed, openCount: data.capacity - claimed, assignees: current?.assignees ?? [],
    claimDeadline: deadline(data.claimDeadline, event), status: 'open', revision: next,
    createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? uid, updatedAt: now, updatedBy: uid,
  });
  return { requestId: data.requestId, revision: next, state: 'open', slotId: ref.id };
});

/** Participants actively rostered on this team for whom the caller holds the given guardian right. Never the participant's own account. */
export async function guardianParticipants(tx: Transaction, orgId: string, teamId: string, uid: string, right: 'respond' | 'viewSchedule') {
  const org = (await tx.get(db().doc(`organizations/${orgId}`))).data();
  if (org?.schemaVersion !== 2 || org.features?.households !== true) return [];
  const grants = await tx.get(db().collectionGroup('guardians').where('orgId', '==', orgId).where('userId', '==', uid).where('status', '==', 'active').limit(11));
  if (grants.size > 10) throw new HttpsError('resource-exhausted', 'Ask your organization to review household access.');
  const ids = grants.docs.filter(doc => {
    const grant = doc.data();
    return doc.ref.path === `organizations/${orgId}/participants/${grant.participantId}/guardians/${uid}` && grant.permissions?.[right] === true;
  }).map(doc => doc.data().participantId as string);
  if (!ids.length) return [];
  const sources = await tx.getAll(...ids.flatMap(participantId => [
    db().doc(`organizations/${orgId}/participants/${participantId}`), db().doc(`teams/${teamId}/roster/${participantId}`),
  ]));
  return ids.flatMap((participantId, i) => {
    const person = sources[i * 2].data();
    const roster = sources[i * 2 + 1].data();
    return person?.schemaVersion === 2 && person.status === 'active' && (person.orgId == null || person.orgId === orgId)
      && person.linkedUserId !== uid && roster?.schemaVersion === 2 && roster.orgId === orgId
      && roster.participantId === participantId && roster.status === 'active'
      ? [{ participantId, displayName: typeof person.displayName === 'string' ? person.displayName : 'Participant' }] : [];
  });
}

async function guardianParticipant(tx: Transaction, orgId: string, teamId: string, uid: string, right: 'respond' | 'viewSchedule') {
  return (await guardianParticipants(tx, orgId, teamId, uid, right))[0]?.participantId ?? null;
}

/**
 * Adults only: an active team coach, or a guardian with respond permission for a participant actively
 * rostered on this team. A participant's own linked account never qualifies, so children cannot self-assign.
 */
export async function volunteerEligibility(tx: Transaction, orgId: string, teamId: string, uid: string) {
  const coach = (await tx.get(db().doc(`teamMembers/${teamId}_${uid}`))).data();
  if (coach?.teamId === teamId && coach.userId === uid && coach.orgId === orgId && coach.status === 'active'
    && Array.isArray(coach.roles) && coach.roles.includes('coach')) return { kind: 'coach' as const, participantId: null };
  const participantId = await guardianParticipant(tx, orgId, teamId, uid, 'respond');
  return participantId ? { kind: 'guardian' as const, participantId } : null;
}

async function claimEvent(tx: Transaction, data: Data, uid: string) {
  const team = await teamViewerOrGuardian(tx, data.eventId, data.teamId, uid);
  if (team.orgId !== data.orgId) denied();
  const eligible = await volunteerEligibility(tx, team.orgId, data.teamId, uid);
  if (!eligible) fail('VOLUNTEER_NOT_ELIGIBLE', 'Only an adult guardian or coach of this team can volunteer.', 'permission-denied');
  return (await tx.get(db().doc(`events/${data.eventId}`))).data()!;
}

function slotPayload(data: Data, fields: string[]) {
  const { payload, base } = envelope(data, fields);
  if (data.expectedRevision != null) revision(data.expectedRevision);
  return { payload, base: { ...base, slotId: id(payload.slotId, 'slotId') } };
}

/** Capacity and the claim commit in one transaction, so concurrent last-seat claims produce exactly one winner. */
export const claimVolunteerSlot = command('claimVolunteerSlot', data => {
  const { payload, base } = slotPayload(data, ['teamId', 'slotId', 'displayAlias', 'showAlias']);
  if (payload.showAlias !== true) invalid('Confirm that your display name can appear on the volunteer list.');
  return { ...base, displayAlias: displayAlias(payload.displayAlias) };
}, async (tx, data, uid, _actor, replay) => {
  const event = await claimEvent(tx, data, uid);
  if (replay) return replay;
  const ref = db().doc(`events/${data.eventId}/volunteerSlots/${data.slotId}`);
  const claimRef = ref.collection('claims').doc(uid);
  const [slotDoc, claimDoc] = await tx.getAll(ref, claimRef);
  const slot = slotDoc.data();
  if (!slot || slot.teamId !== data.teamId || slot.orgId !== data.orgId) fail('VOLUNTEER_SLOT_MISSING', 'This volunteer slot no longer exists.');
  const claim = claimDoc.data();
  if (claim?.status === 'active') return { requestId: data.requestId, revision: slot!.revision, state: 'claimed', slotId: data.slotId };
  const state = slotState(slot!, event, Date.now());
  if (state === 'cancelled') fail('VOLUNTEER_SLOT_CANCELLED', 'This volunteer slot was cancelled.');
  if (state === 'closed') fail('VOLUNTEER_CLOSED', 'Volunteer sign-up for this slot has closed.');
  if (state === 'full') fail('VOLUNTEER_SLOT_FULL', 'Someone else took the last spot.');
  const now = Timestamp.now();
  const next = slot!.revision + 1;
  const key = randomUUID().replace(/-/g, '');
  tx.update(ref, {
    claimedCount: slot!.claimedCount + 1, openCount: slot!.openCount - 1,
    assignees: [...slot!.assignees, { key, alias: data.displayAlias }], revision: next, updatedAt: now,
  });
  tx.set(claimRef, {
    schemaVersion: 2, orgId: slot!.orgId, eventId: data.eventId, teamId: data.teamId, slotId: data.slotId, uid, key,
    alias: data.displayAlias, status: 'active', operationId: data.requestId, claimedAt: now, releasedAt: null,
    releasedBy: null, revision: (claim?.revision ?? 0) + 1, updatedAt: now,
  });
  return { requestId: data.requestId, revision: next, state: 'claimed', slotId: data.slotId };
});

/** Self-release clears the caller's own claim; a coach can remove an assignee by its opaque key. Repeats are no-ops. */
export const releaseVolunteerSlot = command('releaseVolunteerSlot', data => {
  const { payload, base } = slotPayload(data, ['teamId', 'slotId', 'assigneeKey']);
  return { ...base, assigneeKey: payload.assigneeKey == null ? null : id(payload.assigneeKey, 'assigneeKey') };
}, async (tx, data, uid, _actor, replay) => {
  let event: Data;
  if (data.assigneeKey) event = (await slotScope(tx, data, uid, !replay)).event;
  else event = await claimEvent(tx, data, uid);
  if (replay) return replay;
  const ref = db().doc(`events/${data.eventId}/volunteerSlots/${data.slotId}`);
  const slot = (await tx.get(ref)).data();
  if (!slot || slot.teamId !== data.teamId || slot.orgId !== data.orgId) fail('VOLUNTEER_SLOT_MISSING', 'This volunteer slot no longer exists.');
  let claimDoc: FirebaseFirestore.DocumentSnapshot | undefined;
  if (data.assigneeKey) {
    const match = await tx.get(ref.collection('claims').where('key', '==', data.assigneeKey).limit(1));
    claimDoc = match.docs[0];
  } else {
    claimDoc = await tx.get(ref.collection('claims').doc(uid));
  }
  const claim = claimDoc?.data();
  if (!claim || claim.status !== 'active') return { requestId: data.requestId, revision: slot!.revision, state: 'released', slotId: data.slotId };
  // Cancelled assignments are retained as history; neither the adult nor a coach can release them.
  const state = slotState(slot!, event, Date.now());
  if (state === 'cancelled') fail('VOLUNTEER_SLOT_CANCELLED', 'This volunteer slot was cancelled. The assignment is kept as cancelled.');
  if (!data.assigneeKey && state === 'closed') {
    fail('VOLUNTEER_CLOSED', 'The release deadline has passed. Ask your coach to remove you.');
  }
  const now = Timestamp.now();
  const next = slot!.revision + 1;
  tx.update(ref, {
    claimedCount: slot!.claimedCount - 1, openCount: slot!.openCount + 1,
    assignees: (slot!.assignees as Data[]).filter(row => row.key !== claim.key), revision: next, updatedAt: now,
  });
  tx.update(claimDoc!.ref, { status: 'released', releasedAt: now, releasedBy: data.assigneeKey ? 'staff' : 'self', revision: claim.revision + 1, updatedAt: now });
  return { requestId: data.requestId, revision: next, state: 'released', slotId: data.slotId };
});

/** Team viewers, plus households of an actively rostered participant who are not team members. */
export async function teamViewerOrGuardian(tx: Transaction, eventId: string, teamId: string, uid: string) {
  try {
    return await teamViewer(tx, eventId, teamId, null, uid);
  } catch (error) {
    if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error;
    const team = (await tx.get(db().doc(`teams/${teamId}`))).data();
    const participantId = team?.schemaVersion === 2 ? await guardianParticipant(tx, team.orgId, teamId, uid, 'viewSchedule') : null;
    if (!participantId) throw error;
    return teamViewer(tx, eventId, teamId, participantId, uid);
  }
}

export const getEventVolunteers = readCommand(data => {
  keys(data, ['eventId', 'teamId']);
  return { eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId') };
}, async (tx, data, uid) => {
  const team = await teamViewerOrGuardian(tx, data.eventId, data.teamId, uid);
  const eligible = await volunteerEligibility(tx, team.orgId, data.teamId, uid);
  const manager = eligible?.kind === 'coach';
  const event = (await tx.get(db().doc(`events/${data.eventId}`))).data()!;
  const snap = await tx.get(db().collection(`events/${data.eventId}/volunteerSlots`).where('teamId', '==', data.teamId).limit(SLOT_LIMIT));
  const slots = snap.docs.filter(doc => doc.data().orgId === team.orgId && doc.data().schemaVersion === 2);
  const claims = slots.length ? await tx.getAll(...slots.map(doc => doc.ref.collection('claims').doc(uid))) : [];
  const now = Date.now();
  // Explicit allowlist: aliases and counts only. Claimant UIDs, contacts and actor IDs never leave the backend.
  const items = slots.map((doc, i) => {
    const slot = doc.data();
    const own = claims[i].data();
    const state = slotState(slot, event, now);
    return {
      slotId: doc.id, kind: slot.kind, title: slot.title, capacity: slot.capacity, openCount: slot.openCount, state,
      claimDeadline: slot.claimDeadline ?? null, revision: slot.revision,
      assignees: (slot.assignees as Data[]).map(row => manager ? { alias: row.alias, assigneeKey: row.key } : { alias: row.alias }),
      ownClaim: own?.status === 'active' ? { alias: own.alias, status: state === 'cancelled' ? 'cancelled' : 'active' } : null,
      createdAt: slot.createdAt,
    };
  }).sort((a, b) => millis(a.createdAt)! - millis(b.createdAt)! || a.slotId.localeCompare(b.slotId))
    .map(({ createdAt: _createdAt, ...item }) => item);
  return { orgId: team.orgId, eventId: data.eventId, teamId: data.teamId, canManage: manager, canClaim: !!eligible, eventStatus: event.status, slots: items };
});
