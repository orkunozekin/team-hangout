import { DocumentReference, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, optional, revision, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied } from '../operations/access';
import { fingerprint } from '../operations/requests';
import { displayAlias, guardianParticipants, teamViewerOrGuardian, volunteerEligibility } from './slots';

const db = () => getFirestore();
/** Keep aligned with shared/rides.ts. */
export const RIDE_DIRECTIONS = ['toEvent', 'fromEvent'] as const;
const RIDE_LIMIT = 100;
const SEATS_MAX = 8;
const PARTICIPANTS_MAX = 4;
const ACTIVE_PER_OFFER = 20;
const COORDINATORS_MAX = 5;
const CONTACT_MAX = 120;
const PICKUP_MAX = 200;
const ACTIVE = ['pending', 'confirmed'];

const fail = (code: string, message: string, status: 'failed-precondition' | 'permission-denied' = 'failed-precondition', details: Data = {}): never => {
  throw new HttpsError(status, message, { domainCode: code, ...details });
};

/**
 * Rides stay off until the organization enables them and records its own transport policy with at least one
 * active staff coordinator at organizations/{orgId}/transportPolicy/current. No callable writes that record.
 */
export async function ridePolicy(tx: Transaction, orgId: string) {
  const [orgDoc, policyDoc] = await tx.getAll(db().doc(`organizations/${orgId}`), db().doc(`organizations/${orgId}/transportPolicy/current`));
  const org = orgDoc.data();
  const policy = policyDoc.data();
  if (org?.schemaVersion !== 2 || org.status !== 'active' || org.features?.households !== true || org.features?.rides !== true) return null;
  const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (policy?.schemaVersion !== 2 || policy.orgId !== orgId || policy.status !== 'active' || !filled(policy.policyVersion)
    || !filled(policy.consentVersion) || !filled(policy.evidenceRef) || !Array.isArray(policy.coordinatorUids)
    || !policy.coordinatorUids.length || policy.coordinatorUids.length > COORDINATORS_MAX
    || !policy.coordinatorUids.every((uid: unknown) => typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid))) return null;
  const members = await tx.getAll(...(policy.coordinatorUids as string[]).map(uid => db().doc(`organizations/${orgId}/members/${uid}`)));
  const coordinators = new Map<string, Data>();
  (policy.coordinatorUids as string[]).forEach((uid, i) => {
    const grant = members[i].data();
    if (grant?.status === 'active' && grant.orgId === orgId && Array.isArray(grant.roles) && Array.isArray(grant.programIds)
      && grant.roles.some((role: string) => ['orgAdmin', 'programStaff'].includes(role))) coordinators.set(uid, grant);
  });
  if (!coordinators.size) return null;
  return { policyVersion: policy.policyVersion as string, consentVersion: policy.consentVersion as string, coordinators };
}
type Policy = Awaited<ReturnType<typeof ridePolicy>>;

function coordinates(policy: Policy, uid: string, programId: string) {
  const grant = policy?.coordinators.get(uid);
  return !!grant && (grant.roles.includes('orgAdmin') || (grant.roles.includes('programStaff') && grant.programIds.includes(programId)));
}

/** A coarse meeting area only: a neighborhood or landmark, never an address or contact detail. */
export function rideArea(value: unknown): string {
  const area = text(value, 'meeting area', 60).replace(/\s+/g, ' ');
  if (/@|https?:|www\./i.test(area) || /\d{2,}|\b\d+\s+[a-z]/i.test(area)) {
    invalid('Use a coarse meeting area such as a neighborhood or landmark. Do not include an address, phone, email or link.');
  }
  return area;
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

const millis = (value: unknown) => value instanceof Timestamp ? value.toMillis() : null;

async function rideScope(tx: Transaction, data: Data, uid: string) {
  const team = await teamViewerOrGuardian(tx, data.eventId, data.teamId, uid);
  if (team.orgId !== data.orgId) denied();
  const policy = await ridePolicy(tx, team.orgId);
  const event = (await tx.get(db().doc(`events/${data.eventId}`))).data()!;
  return { team, policy, event };
}

/** New offers, requests and consents need an enabled policy and a scheduled event that has not started. */
function requireOpen(policy: Policy, event: Data) {
  if (!policy) fail('RIDES_DISABLED', 'Ride coordination is not enabled for this organization.');
  if (event.status === 'cancelled') fail('RIDE_EVENT_CANCELLED', 'This event was cancelled.');
  if (event.status !== 'scheduled' || Date.now() >= (millis(event.startsAt) ?? 0)) fail('RIDE_CLOSED', 'Ride coordination for this event has closed.');
}

/** The household's live respond grants: every child on a ride request must be linked to the acting guardian. */
async function linkedIds(tx: Transaction, orgId: string, teamId: string, uid: string) {
  return new Set((await guardianParticipants(tx, orgId, teamId, uid, 'respond')).map(row => row.participantId));
}
const covers = (linked: Set<string>, participantIds: string[]) => participantIds.length > 0 && participantIds.every(pid => linked.has(pid));

/** Notification access source recorded at consent, rechecked by the outbox worker at delivery. */
function driverSource(eligible: Awaited<ReturnType<typeof volunteerEligibility>>, teamId: string) {
  return eligible?.kind === 'coach' ? { kind: 'team', teamId } : { kind: 'household', teamId, participantId: eligible!.participantId };
}

type Loaded = { ref: DocumentReference; data: Data; changed?: boolean };

/**
 * Cancels one arrangement: frees confirmed seats, clears the need's active link, deletes both stored contacts and
 * notifies the other parties with generic copy. Callers perform every read first and flush offer/need writes after.
 */
function closeArrangement(tx: Transaction, ref: DocumentReference, row: Data, offer: Loaded, need: Loaded | null,
  actorUid: string, by: string, event: Data, now: Timestamp) {
  const next = row.revision + 1;
  tx.update(ref, { state: 'cancelled', cancelledBy: by, cancelledAt: now, revision: next, updatedAt: now });
  for (const uid of new Set([row.driverUid, row.riderUid].filter(Boolean))) tx.delete(ref.collection('contacts').doc(uid));
  offer.data.activeCount = Math.max(0, (offer.data.activeCount ?? 0) - 1);
  if (row.state === 'confirmed') offer.data.seatsReserved = Math.max(0, offer.data.seatsReserved - row.seats);
  offer.changed = true;
  if (need && need.data.activeArrangementId === ref.id) { need.data.activeArrangementId = null; need.changed = true; }
  notify(tx, row, ref.id, next, actorUid, event, now);
}

function notify(tx: Transaction, row: Data, arrangementId: string, next: number, actorUid: string, event: Data, now: Timestamp) {
  const recipients = [
    row.driverUid && row.driverUid !== actorUid ? { uid: row.driverUid, accessSources: [row.driverSource] } : null,
    row.riderUid && row.riderUid !== actorUid && row.riderSource ? { uid: row.riderUid, accessSources: [row.riderSource] } : null,
  ].filter(Boolean);
  if (!recipients.length) return;
  // Generic copy only: aliases, areas, pickup notes and contacts never enter the outbox.
  tx.create(db().doc(`organizations/${row.orgId}/outbox/${fingerprint({ eventId: row.eventId, arrangementId, revision: next, kind: 'rideArrangementChanged' })}`), {
    schemaVersion: 2, orgId: row.orgId, sourceType: 'event', sourceId: row.eventId, sourceRevision: event.revision ?? 0,
    templateKey: 'rideArrangementChanged', state: 'pending', critical: false, programId: event.programId ?? null,
    audience: { mode: 'explicit', teamIds: [row.teamId], recipients }, createdAt: now, updatedAt: now,
    auditCorrelationId: `${row.eventId}:${arrangementId}:${next}`,
  });
}

function flush(tx: Transaction, rows: (Loaded | null)[], uid: string, now: Timestamp) {
  for (const row of rows) {
    if (!row?.changed) continue;
    row.data.revision += 1;
    tx.update(row.ref, { activeCount: row.data.activeCount ?? null, seatsReserved: row.data.seatsReserved ?? null,
      activeArrangementId: row.data.activeArrangementId ?? null, revision: row.data.revision, updatedAt: now, updatedBy: uid });
  }
}

function sameRide(row: Data | undefined, data: Data) {
  return !!row && row.schemaVersion === 2 && row.orgId === data.orgId && row.eventId === data.eventId && row.teamId === data.teamId;
}

export const saveRideRequest = command('saveRideRequest', data => {
  const { payload, base } = envelope(data, ['teamId', 'rideId', 'action', 'kind', 'direction', 'area', 'seats', 'participantIds', 'discoverable']);
  const action = payload.action ?? 'save';
  if (!['save', 'cancel'].includes(action)) invalid('Invalid ride action.');
  const rideId = payload.rideId == null ? null : id(payload.rideId, 'rideId');
  const expectedRevision = revision(data.expectedRevision);
  if (action === 'cancel') {
    if (!rideId) invalid('Choose a ride to cancel.');
    return { ...base, expectedRevision, rideId, action };
  }
  if (!['need', 'offer'].includes(payload.kind)) invalid('Choose a ride request or offer.');
  if (!RIDE_DIRECTIONS.includes(payload.direction)) invalid('Choose a ride direction.');
  if (typeof payload.discoverable !== 'boolean') invalid('Choose whether other households can find this ride.');
  let seats: number;
  let participantIds: string[] = [];
  if (payload.kind === 'offer') {
    if (payload.participantIds != null) invalid('Ride offers do not list children.');
    seats = payload.seats;
    if (!Number.isSafeInteger(seats) || seats < 1 || seats > SEATS_MAX) invalid(`Seats must be 1 through ${SEATS_MAX}.`);
  } else {
    if (payload.seats != null) invalid('A ride request needs one seat per child.');
    if (!Array.isArray(payload.participantIds) || payload.participantIds.length < 1 || payload.participantIds.length > PARTICIPANTS_MAX) {
      invalid(`Choose 1 through ${PARTICIPANTS_MAX} children.`);
    }
    participantIds = [...new Set((payload.participantIds as unknown[]).map(value => id(value, 'participantId')))].sort();
    if (participantIds.length !== payload.participantIds.length) invalid('Each child can be listed once.');
    seats = participantIds.length;
  }
  return {
    ...base, expectedRevision, rideId, action, kind: payload.kind, direction: payload.direction,
    area: rideArea(payload.area), seats, participantIds, discoverable: payload.discoverable,
  };
}, async (tx, data, uid, _actor, replay) => {
  const { team, policy, event } = await rideScope(tx, data, uid);
  const rides = db().collection(`events/${data.eventId}/rideRequests`);
  const ref = data.rideId ? rides.doc(data.rideId) : rides.doc();
  const current = data.rideId ? (await tx.get(ref)).data() : undefined;
  if (data.rideId && !sameRide(current, data)) fail('RIDE_MISSING', 'This ride no longer exists.');
  const kind = current?.kind ?? data.kind;
  const linked = await linkedIds(tx, team.orgId, data.teamId, uid);
  const eligible = kind === 'offer' ? await volunteerEligibility(tx, team.orgId, data.teamId, uid) : null;
  // Offers belong to the adult who made them; requests to any guardian linked to every listed child.
  const owner = kind === 'offer'
    ? (current ? current.ownerUid === uid && (data.action === 'cancel' || !!eligible) : !!eligible)
    : (!current || covers(linked, current.participantIds)) && (data.action === 'cancel' || covers(linked, data.participantIds));
  if (!owner) fail('RIDE_NOT_ELIGIBLE', 'Only an adult guardian linked to each child, or the adult offering seats, can change this ride.', 'permission-denied');
  if (replay) return replay;
  checkRevision(current, data.expectedRevision);
  const now = Timestamp.now();
  if (data.action === 'cancel') {
    if (current!.status === 'cancelled') return { requestId: data.requestId, revision: current!.revision, state: 'cancelled', rideId: ref.id };
    // Withdrawing always works, even after the policy is withdrawn, because it only reduces sharing.
    const self: Loaded = { ref, data: { ...current! } };
    const arrangements = kind === 'offer'
      ? (await tx.get(db().collection(`events/${data.eventId}/rideArrangements`).where('offerId', '==', ref.id).where('state', 'in', ACTIVE).limit(ACTIVE_PER_OFFER))).docs
      : current!.activeArrangementId ? [await tx.get(db().doc(`events/${data.eventId}/rideArrangements/${current!.activeArrangementId}`))] : [];
    const otherIds = [...new Set(arrangements.map(doc => kind === 'offer' ? doc.data()!.needId : doc.data()!.offerId))];
    const others = otherIds.length ? await tx.getAll(...otherIds.map(other => rides.doc(other))) : [];
    const loaded = new Map<string, Loaded>(others.filter(doc => doc.exists).map(doc => [doc.id, { ref: doc.ref, data: { ...doc.data() } }]));
    for (const doc of arrangements) {
      const row = doc.data();
      if (!row || !ACTIVE.includes(row.state)) continue;
      const offer = kind === 'offer' ? self : loaded.get(row.offerId);
      const need = kind === 'need' ? self : loaded.get(row.needId) ?? null;
      if (offer) closeArrangement(tx, doc.ref, row, offer, need, uid, kind === 'offer' ? 'driver' : 'rider', event, now);
    }
    flush(tx, [...loaded.values()], uid, now);
    const next = current!.revision + 1;
    tx.update(ref, { status: 'cancelled', discoverable: false, activeArrangementId: null, activeCount: self.data.activeCount ?? null,
      seatsReserved: self.data.seatsReserved ?? null, revision: next, cancelledAt: now, updatedAt: now, updatedBy: uid });
    return { requestId: data.requestId, revision: next, state: 'cancelled', rideId: ref.id };
  }
  requireOpen(policy, event);
  if (current?.status === 'cancelled') fail('RIDE_CANCELLED', 'This ride was cancelled.');
  if (current && current.kind !== data.kind) invalid('A ride cannot change between request and offer.');
  if (current?.kind === 'need' && current.activeArrangementId
    && (current.direction !== data.direction || current.participantIds.join() !== data.participantIds.join())) {
    fail('RIDE_ARRANGEMENT_ACTIVE', 'Cancel the current arrangement before changing the children or direction.');
  }
  if (current?.kind === 'offer') {
    if (data.seats < current.seatsReserved) fail('RIDE_SEATS_BELOW_RESERVED', 'Seats cannot be fewer than the seats already confirmed.');
    if (current.activeCount > 0 && current.direction !== data.direction) fail('RIDE_ARRANGEMENT_ACTIVE', 'Cancel current arrangements before changing direction.');
  }
  if (!current) {
    const existing = await tx.get(rides.where('teamId', '==', data.teamId).limit(RIDE_LIMIT));
    if (existing.size >= RIDE_LIMIT) fail('RIDE_LIMIT', `A team can have at most ${RIDE_LIMIT} ride requests and offers per event.`);
  }
  const next = (current?.revision ?? 0) + 1;
  tx.set(ref, {
    schemaVersion: 2, orgId: team.orgId, programId: team.programId, seasonId: team.seasonId, eventId: data.eventId, teamId: data.teamId,
    kind: data.kind, direction: data.direction, area: data.area, seats: data.seats, discoverable: data.discoverable, status: 'open',
    participantIds: data.kind === 'need' ? data.participantIds : [], ownerUid: data.kind === 'offer' ? uid : null,
    seatsReserved: data.kind === 'offer' ? current?.seatsReserved ?? 0 : null, activeCount: data.kind === 'offer' ? current?.activeCount ?? 0 : null,
    activeArrangementId: data.kind === 'need' ? current?.activeArrangementId ?? null : null,
    revision: next, createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? uid, updatedAt: now, updatedBy: uid,
  });
  return { requestId: data.requestId, revision: next, state: 'open', rideId: ref.id };
});

/**
 * Proposes an arrangement between a seat offer and a ride request, or gives the second party's consent. Both
 * adults consent to share contact details; seats are reserved in the same transaction as the confirmation.
 */
export const confirmRideArrangement = command('confirmRideArrangement', data => {
  const { payload, base } = envelope(data, ['teamId', 'arrangementId', 'offerId', 'needId', 'displayAlias', 'contact', 'pickupNote', 'shareContact']);
  if (data.expectedRevision != null) revision(data.expectedRevision);
  if (payload.shareContact !== true) invalid('Confirm that your contact details can be shared with the other adult in this ride.');
  const arrangementId = payload.arrangementId == null ? null : id(payload.arrangementId, 'arrangementId');
  if (!arrangementId && (payload.offerId == null || payload.needId == null)) invalid('Choose a ride offer and request.');
  return {
    ...base, arrangementId,
    offerId: arrangementId ? null : id(payload.offerId, 'offerId'), needId: arrangementId ? null : id(payload.needId, 'needId'),
    displayAlias: displayAlias(payload.displayAlias), contact: text(payload.contact, 'contact', CONTACT_MAX),
    pickupNote: optional(payload.pickupNote, 'pickup note', PICKUP_MAX),
  };
}, async (tx, data, uid, _actor, replay) => {
  const { team, policy, event } = await rideScope(tx, data, uid);
  const arrangements = db().collection(`events/${data.eventId}/rideArrangements`);
  const ref = data.arrangementId ? arrangements.doc(data.arrangementId) : arrangements.doc();
  const arrangement = data.arrangementId ? (await tx.get(ref)).data() : undefined;
  if (data.arrangementId && !sameRide(arrangement, data)) fail('RIDE_ARRANGEMENT_MISSING', 'This ride arrangement no longer exists.');
  const offerRef = db().doc(`events/${data.eventId}/rideRequests/${arrangement?.offerId ?? data.offerId}`);
  const needRef = db().doc(`events/${data.eventId}/rideRequests/${arrangement?.needId ?? data.needId}`);
  const [offerDoc, needDoc] = await tx.getAll(offerRef, needRef);
  const offer = offerDoc.data();
  const need = needDoc.data();
  if (!sameRide(offer, data) || offer!.kind !== 'offer' || !sameRide(need, data) || need!.kind !== 'need') fail('RIDE_MISSING', 'This ride no longer exists.');
  const driver = await volunteerEligibility(tx, team.orgId, data.teamId, offer!.ownerUid);
  const isDriver = offer!.ownerUid === uid && !!driver;
  const linked = await linkedIds(tx, team.orgId, data.teamId, uid);
  // Unauthorized adults can never add a child: the rider side must be linked to every child on the request.
  const isRider = covers(linked, need!.participantIds);
  let side: 'driver' | 'rider';
  if (arrangement) {
    if (isDriver && arrangement.consents.driver) return { requestId: data.requestId, revision: arrangement.revision, state: arrangement.state, arrangementId: ref.id };
    if (isRider && arrangement.consents.rider && arrangement.riderUid === uid) {
      return { requestId: data.requestId, revision: arrangement.revision, state: arrangement.state, arrangementId: ref.id };
    }
    if (isDriver) side = 'driver';
    else if (isRider && !arrangement.consents.rider) side = 'rider';
    else fail('RIDE_NOT_ELIGIBLE', 'Only the adults in this ride can confirm it.', 'permission-denied');
  } else {
    if (isDriver && isRider) invalid('Choose another household\'s ride.');
    if (isDriver) side = 'driver';
    else if (isRider) side = 'rider';
    else fail('RIDE_NOT_ELIGIBLE', 'Only the adult offering seats or a guardian linked to each child can arrange this ride.', 'permission-denied');
  }
  if (replay) return replay;
  requireOpen(policy, event);
  if (offer!.status !== 'open' || need!.status !== 'open') fail('RIDE_CANCELLED', 'This ride was cancelled.');
  if (!driver) fail('RIDE_PARTY_UNAVAILABLE', 'The adult offering seats can no longer drive for this team.');
  const now = Timestamp.now();
  const consent = { alias: data.displayAlias, at: now };
  const contact = { schemaVersion: 2, orgId: team.orgId, uid, role: side!, contact: data.contact, pickupNote: data.pickupNote, consentVersion: policy!.consentVersion, createdAt: now };
  const riderSource = { kind: 'household', teamId: data.teamId, participantId: need!.participantIds[0] };
  if (!arrangement) {
    if (offer!.direction !== need!.direction) fail('RIDE_DIRECTION_MISMATCH', 'This offer and request are for different directions.');
    // Opt-in discovery: a household can only reach another household's ride that it chose to make findable.
    if (!(side! === 'driver' ? need!.discoverable : offer!.discoverable)) fail('RIDE_MISSING', 'This ride no longer exists.');
    if (need!.activeArrangementId) fail('RIDE_NEED_ARRANGED', 'This ride request already has an arrangement in progress.');
    if (offer!.seats - offer!.seatsReserved < need!.seats) fail('RIDE_SEATS_FULL', 'There are not enough open seats for this request.');
    if (offer!.activeCount >= ACTIVE_PER_OFFER) fail('RIDE_LIMIT', 'This offer has too many pending arrangements.');
    tx.create(ref, {
      schemaVersion: 2, orgId: team.orgId, programId: team.programId, seasonId: team.seasonId, eventId: data.eventId, teamId: data.teamId,
      offerId: offerRef.id, needId: needRef.id, direction: offer!.direction, seats: need!.seats, participantIds: need!.participantIds,
      driverUid: offer!.ownerUid, riderUid: side! === 'rider' ? uid : null, driverSource: driverSource(driver, data.teamId),
      riderSource: side! === 'rider' ? riderSource : null, proposedBy: side!, state: 'pending',
      consents: { driver: side! === 'driver' ? consent : null, rider: side! === 'rider' ? consent : null },
      policyVersion: policy!.policyVersion, consentVersion: policy!.consentVersion, revision: 1, createdAt: now, updatedAt: now,
    });
    tx.set(ref.collection('contacts').doc(uid), contact);
    tx.update(offerRef, { activeCount: offer!.activeCount + 1, revision: offer!.revision + 1, updatedAt: now });
    tx.update(needRef, { activeArrangementId: ref.id, revision: need!.revision + 1, updatedAt: now });
    return { requestId: data.requestId, revision: 1, state: 'pending', arrangementId: ref.id };
  }
  if (arrangement.state !== 'pending') fail('RIDE_ARRANGEMENT_CLOSED', 'This ride arrangement was cancelled.');
  if (arrangement.consentVersion !== policy!.consentVersion) fail('RIDE_CONSENT_OUTDATED', 'The organization updated its ride policy. Start a new arrangement.');
  // The proposer's authority is rechecked too: a guardian unlinked after proposing cannot be confirmed into a ride.
  if (arrangement.proposedBy === 'rider') {
    const proposer = await linkedIds(tx, team.orgId, data.teamId, arrangement.riderUid);
    if (!covers(proposer, arrangement.participantIds)) fail('RIDE_PARTY_UNAVAILABLE', 'The guardian who asked for this ride is no longer linked to every child.');
  }
  if (offer!.seats - offer!.seatsReserved < arrangement.seats) fail('RIDE_SEATS_FULL', 'Someone else took the last seats in this offer.');
  const next = arrangement.revision + 1;
  tx.update(ref, {
    state: 'confirmed', [`consents.${side!}`]: consent, ...(side! === 'rider' ? { riderUid: uid, riderSource } : {}),
    confirmedAt: now, revision: next, updatedAt: now,
  });
  tx.set(ref.collection('contacts').doc(uid), contact);
  tx.update(offerRef, { seatsReserved: offer!.seatsReserved + arrangement.seats, revision: offer!.revision + 1, updatedAt: now });
  notify(tx, { ...arrangement, ...(side! === 'rider' ? { riderUid: uid, riderSource } : {}) }, ref.id, next, uid, event, now);
  return { requestId: data.requestId, revision: next, state: 'confirmed', arrangementId: ref.id };
});

/** A party, a household linked to every child, or a designated coordinator ends an arrangement. Repeats are no-ops. */
export const revokeRideConsent = command('revokeRideConsent', data => {
  const { payload, base } = envelope(data, ['teamId', 'arrangementId']);
  if (data.expectedRevision != null) revision(data.expectedRevision);
  return { ...base, arrangementId: id(payload.arrangementId, 'arrangementId') };
}, async (tx, data, uid, _actor, replay) => {
  const ref = db().doc(`events/${data.eventId}/rideArrangements/${data.arrangementId}`);
  const row = (await tx.get(ref)).data();
  if (!sameRide(row, data)) denied();
  let by: string | null = row!.driverUid === uid ? 'driver' : row!.riderUid === uid ? 'rider' : null;
  // Parties can always withdraw their own consent, even after losing access, because it only reduces sharing.
  if (!by) {
    const linked = await linkedIds(tx, row!.orgId, data.teamId, uid);
    if (covers(linked, row!.participantIds)) by = 'rider';
    else if (coordinates(await ridePolicy(tx, row!.orgId), uid, row!.programId)) by = 'coordinator';
    else denied();
  }
  if (replay) return replay;
  if (!ACTIVE.includes(row!.state)) return { requestId: data.requestId, revision: row!.revision, state: 'cancelled', arrangementId: ref.id };
  const [offerDoc, needDoc, eventDoc] = await tx.getAll(
    db().doc(`events/${data.eventId}/rideRequests/${row!.offerId}`), db().doc(`events/${data.eventId}/rideRequests/${row!.needId}`),
    db().doc(`events/${data.eventId}`),
  );
  const offer: Loaded = { ref: offerDoc.ref, data: { ...offerDoc.data() } };
  const need: Loaded | null = needDoc.exists ? { ref: needDoc.ref, data: { ...needDoc.data() } } : null;
  const now = Timestamp.now();
  closeArrangement(tx, ref, row!, offer, need, uid, by!, eventDoc.data() ?? {}, now);
  flush(tx, offerDoc.exists ? [offer, need] : [need], uid, now);
  return { requestId: data.requestId, revision: row!.revision + 1, state: 'cancelled', arrangementId: ref.id };
});

function effective(row: Data, event: Data) {
  return event.status === 'cancelled' && ACTIVE.includes(row.state) ? 'cancelled' : row.state;
}

export const getEventRides = readCommand(data => {
  keys(data, ['eventId', 'teamId']);
  return { eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId') };
}, async (tx, data, uid) => {
  const team = await teamViewerOrGuardian(tx, data.eventId, data.teamId, uid);
  const policy = await ridePolicy(tx, team.orgId);
  const event = (await tx.get(db().doc(`events/${data.eventId}`))).data()!;
  const base = { orgId: team.orgId, eventId: data.eventId, teamId: data.teamId, eventStatus: event.status };
  if (!policy) return { ...base, enabled: false };
  const children = await guardianParticipants(tx, team.orgId, data.teamId, uid, 'respond');
  const linked = new Set(children.map(row => row.participantId));
  const names = new Map(children.map(row => [row.participantId, row.displayName]));
  const eligible = await volunteerEligibility(tx, team.orgId, data.teamId, uid);
  const coordinator = coordinates(policy, uid, team.programId);
  const rideSnap = await tx.get(db().collection(`events/${data.eventId}/rideRequests`).where('teamId', '==', data.teamId).limit(RIDE_LIMIT));
  // Each request has at most one active arrangement, so active rows are bounded by RIDE_LIMIT; cancelled history is best effort.
  const arrangementRows = db().collection(`events/${data.eventId}/rideArrangements`).where('teamId', '==', data.teamId);
  const activeSnap = await tx.get(arrangementRows.where('state', 'in', ACTIVE).limit(RIDE_LIMIT));
  const endedSnap = await tx.get(arrangementRows.where('state', '==', 'cancelled').limit(RIDE_LIMIT));
  const rides = rideSnap.docs.filter(doc => doc.data().orgId === team.orgId && doc.data().schemaVersion === 2);
  const arrangements = [...activeSnap.docs, ...endedSnap.docs].filter(doc => doc.data().orgId === team.orgId && doc.data().schemaVersion === 2);
  const open = (ride: Data) => ride.kind === 'offer' ? ride.seats - ride.seatsReserved : 0;
  const own = (ride: Data) => ride.kind === 'offer' ? ride.ownerUid === uid : ride.participantIds.some((pid: string) => linked.has(pid));
  const sort = (a: { createdAt: unknown; id: string }, b: { createdAt: unknown; id: string }) => millis(a.createdAt)! - millis(b.createdAt)! || a.id.localeCompare(b.id);
  const rows = rides.map(doc => ({ id: doc.id, createdAt: doc.data().createdAt, ride: doc.data() })).sort(sort);
  // Explicit allowlists. Discovery shows kind, direction, coarse area and seat counts only: no names, children or contacts.
  const mine = rows.filter(row => own(row.ride)).map(({ id: rideId, ride }) => ({
    rideId, kind: ride.kind, direction: ride.direction, area: ride.area, seats: ride.seats, seatsOpen: ride.kind === 'offer' ? open(ride) : null,
    discoverable: ride.discoverable, status: event.status === 'cancelled' ? 'cancelled' : ride.status, revision: ride.revision,
    // Only the caller's own linked children are named; other children on a shared request stay unnamed.
    participants: ride.kind === 'need' ? ride.participantIds.filter((pid: string) => linked.has(pid)).map((pid: string) => ({ participantId: pid, displayName: names.get(pid)! })) : [],
    canEdit: ride.kind === 'offer' ? !!eligible : covers(linked, ride.participantIds), updatedByYou: ride.updatedBy === uid,
    hasArrangement: ride.kind === 'offer' ? ride.activeCount > 0 : !!ride.activeArrangementId,
  }));
  const matches = event.status === 'scheduled' ? rows.filter(({ ride }) => !own(ride) && ride.status === 'open' && ride.discoverable
    && (ride.kind === 'offer' ? open(ride) > 0 : !ride.activeArrangementId)).map(({ id: rideId, ride }) => ({
    rideId, kind: ride.kind, direction: ride.direction, area: ride.area, seats: ride.kind === 'offer' ? open(ride) : ride.seats, revision: ride.revision,
  })) : [];
  const parties = arrangements.map(doc => ({ id: doc.id, createdAt: doc.data().createdAt, row: doc.data() })).sort(sort).flatMap(({ id: arrangementId, row }) => {
    const driver = row.driverUid === uid;
    const rider = row.riderUid === uid || (!row.riderUid && covers(linked, row.participantIds));
    if (!driver && !rider) return [];
    const role = driver ? 'driver' : 'rider';
    const other = row.consents?.[driver ? 'rider' : 'driver'];
    const state = effective(row, event);
    return [{
      arrangementId, role, state, direction: row.direction, seats: row.seats, revision: row.revision,
      counterpartAlias: other?.alias ?? null, yourAlias: row.consents?.[role]?.alias ?? null,
      awaitingYou: state === 'pending' && !row.consents?.[role],
      participants: rider ? row.participantIds.filter((pid: string) => linked.has(pid)).map((pid: string) => names.get(pid)!) : [],
    }];
  });
  // Designated coordinators see arrangement states and the aliases parties chose, never children or contacts.
  const coordination = coordinator ? {
    openRequests: rows.filter(({ ride }) => ride.status === 'open' && ride.kind === 'need' && !ride.activeArrangementId).length,
    openSeats: rows.filter(({ ride }) => ride.status === 'open' && ride.kind === 'offer').reduce((sum, { ride }) => sum + open(ride), 0),
    arrangements: arrangements.map(doc => doc.data()).map((row, i) => ({
      arrangementId: arrangements[i].id, state: effective(row, event), direction: row.direction, seats: row.seats,
      driverAlias: row.consents?.driver?.alias ?? null, riderAlias: row.consents?.rider?.alias ?? null,
    })),
  } : null;
  return {
    ...base, enabled: true, policyVersion: policy.policyVersion, consentVersion: policy.consentVersion,
    canOffer: !!eligible, children: children.map(row => ({ participantId: row.participantId, displayName: row.displayName })),
    mine, matches, arrangements: parties, coordination,
  };
});

/**
 * Party-scoped contact retrieval. Every call rechecks the enabled policy and consent version, the confirmed state,
 * a scheduled event and both adults' current authority. Nothing is cached; revoked consent stops future retrieval.
 */
export const getRideContacts = readCommand(data => {
  keys(data, ['eventId', 'teamId', 'arrangementId']);
  return { eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId'), arrangementId: id(data.arrangementId, 'arrangementId') };
}, async (tx, data, uid) => {
  const ref = db().doc(`events/${data.eventId}/rideArrangements/${data.arrangementId}`);
  const row = (await tx.get(ref)).data();
  if (!row || row.schemaVersion !== 2 || row.eventId !== data.eventId || row.teamId !== data.teamId) denied();
  const role = row!.driverUid === uid ? 'driver' : row!.riderUid === uid ? 'rider' : null;
  if (!role) denied();
  const unavailable = (reason: string): never => fail('RIDE_CONTACT_UNAVAILABLE', 'Contact details are not available for this ride.', 'failed-precondition', { reason });
  const [policy, eventDoc, offerDoc] = [await ridePolicy(tx, row!.orgId), await tx.get(db().doc(`events/${data.eventId}`)), await tx.get(db().doc(`events/${data.eventId}/rideRequests/${row!.offerId}`))];
  const event = eventDoc.data();
  if (!policy || policy.consentVersion !== row!.consentVersion) unavailable('policy');
  if (row!.state !== 'confirmed') unavailable('notConfirmed');
  if (!event || event.status !== 'scheduled' || Date.now() >= (millis(event.endsAt) ?? 0)) unavailable('event');
  const driverOk = offerDoc.data()?.ownerUid === row!.driverUid && offerDoc.data()?.status === 'open'
    && !!(await volunteerEligibility(tx, row!.orgId, data.teamId, row!.driverUid));
  const riderOk = covers(await linkedIds(tx, row!.orgId, data.teamId, row!.riderUid), row!.participantIds);
  if (!driverOk || !riderOk) unavailable('authority');
  const counterpart = role === 'driver' ? 'rider' : 'driver';
  const contact = (await tx.get(ref.collection('contacts').doc(row![`${counterpart}Uid`]))).data();
  if (!contact || contact.consentVersion !== row!.consentVersion) unavailable('consent');
  return {
    arrangementId: ref.id, counterpart: { role: counterpart, alias: row!.consents[counterpart].alias, contact: contact!.contact, pickupNote: contact!.pickupNote ?? null },
  };
});
