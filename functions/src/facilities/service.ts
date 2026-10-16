import { requireOpenInterval } from './closures';
import { publishedEvent } from '../scheduling/visibility';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, optional, revision, text } from '../commandSupport';
import { adminScope, choice, metadata, page, readCommand } from '../participants/policy';
import { checkRevision, denied, staffScope } from '../operations/access';
import { audit } from '../organizations/commands';
import { contains, occupancy, overlaps } from './intervals';

const facilityRef = (orgId: string, facilityId: string) => getFirestore().doc(`organizations/${orgId}/facilities/${facilityId}`);
const resourceRef = (orgId: string, facilityId: string, resourceId: string) => facilityRef(orgId, facilityId).collection('resources').doc(resourceId);
export function instant(value: unknown, field: string): string {
  const result = text(value, field, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(`Use an explicit UTC instant for ${field}.`);
  return result;
}
function interval(value: unknown) {
  const row = object(value); keys(row, ['startsAt', 'endsAt']);
  const startsAt = instant(row.startsAt, 'startsAt'), endsAt = instant(row.endsAt, 'endsAt');
  if (endsAt <= startsAt) invalid('endsAt must follow startsAt.');
  return { startsAt, endsAt };
}
function minutes(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 180) invalid(`${field} must be 0 through 180 minutes.`);
  return Number(value);
}
function zone(value: unknown) {
  const result = text(value, 'timeZone', 100);
  if (!/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(result)) invalid('Supply an IANA timeZone, not a numeric offset.');
  try { new Intl.DateTimeFormat('en', { timeZone: result }); } catch { invalid('Invalid timeZone.'); }
  return result;
}
function facilityFields(value: unknown) {
  const row = object(value); keys(row, ['name', 'address', 'timeZone', 'latitude', 'longitude', 'parking', 'accessibility', 'status']);
  const latitude = row.latitude ?? null, longitude = row.longitude ?? null;
  if ((latitude === null) !== (longitude === null) || (latitude !== null && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180))) invalid('Supply both valid coordinates or neither.');
  return { name: text(row.name, 'name'), address: text(row.address, 'address', 500), timeZone: zone(row.timeZone), latitude, longitude,
    parking: optional(row.parking, 'parking', 1000), accessibility: optional(row.accessibility, 'accessibility', 1000), status: choice(row.status, ['active', 'inactive'], 'status') };
}
function resourceFields(value: unknown) {
  const row = object(value); keys(row, ['label', 'sports', 'setupMinutes', 'cleanupMinutes', 'status']);
  if (!Array.isArray(row.sports) || !row.sports.length || row.sports.length > 3 || new Set(row.sports).size !== row.sports.length) invalid('Choose compatible sports.');
  return { label: text(row.label, 'field/court label'), sports: row.sports.map((sport: unknown) => choice(sport, ['soccer', 'basketball', 'football'], 'sport')),
    setupMinutes: minutes(row.setupMinutes, 'Setup'), cleanupMinutes: minutes(row.cleanupMinutes, 'Cleanup'), status: choice(row.status, ['active', 'inactive'], 'status') };
}
const publicFacility = (id: string, row: Data) => ({ id, ...Object.fromEntries(['name', 'address', 'timeZone', 'latitude', 'longitude', 'parking', 'accessibility', 'status', 'revision'].map(key => [key, row[key] ?? null])) });
const publicResource = (id: string, row: Data) => ({ id, ...Object.fromEntries(['label', 'sports', 'setupMinutes', 'cleanupMinutes', 'status', 'revision'].map(key => [key, row[key]])) });
async function staff(tx: Transaction, orgId: string, uid: string) {
  const scope = await staffScope(tx, orgId, uid);
  if (scope.organization.features?.organizationV2 !== true || scope.organization.features?.adminWorkspace !== true) denied();
  // Shared organization resources carry no program-private data. Empty/malformed program grants grant no catalog access.
  if (!scope.admin) {
    if (!scope.programIds.length || scope.programIds.length > 100) denied();
    const programs = await tx.getAll(...scope.programIds.map(programId => getFirestore().doc(`organizations/${orgId}/programs/${id(programId, 'programId')}`)));
    if (!programs.some(row => row.data()?.orgId === orgId && row.data()?.schemaVersion === 2 && row.data()?.status === 'active')) denied();
  }
  return scope;
}
async function catalogAdmin(tx: Transaction, orgId: string, uid: string, writing: boolean) {
  const scope = await adminScope(tx, orgId, uid, writing);
  if (scope.organization.features?.adminWorkspace !== true) denied();
  return scope;
}
async function facility(tx: Transaction, orgId: string, facilityId: string) {
  const row = (await tx.get(facilityRef(orgId, facilityId))).data();
  if (!row || row.orgId !== orgId || row.schemaVersion !== 2) denied(); return row!;
}
async function resource(tx: Transaction, orgId: string, facilityId: string, resourceId: string) {
  const row = (await tx.get(resourceRef(orgId, facilityId, resourceId))).data();
  if (!row || row.orgId !== orgId || row.facilityId !== facilityId || row.schemaVersion !== 2) denied(); return row!;
}
const conflict = (message: string): never => { throw new HttpsError('failed-precondition', message, { domainCode: 'SCHEDULE_CONFLICT' }); };
const bounded = (size: number) => { if (size > 500) throw new HttpsError('resource-exhausted', 'Too many reservations to validate safely. Narrow the interval or ask an administrator.'); };
async function active(tx: Transaction, event: Data) { return event.deletedAt == null && event.publicationState === 'published' && ['scheduled', 'completed'].includes(event.status) && (event.publicationOperationId == null || await publishedEvent(tx, event)); }
function occupied(event: Data) {
  return event.resourceOccupancy ? { startsAt: event.resourceOccupancy.startsAt.toDate().toISOString(), endsAt: event.resourceOccupancy.endsAt.toDate().toISOString() } : null;
}
function queryEvents(orgId: string, facilityId: string, resourceId?: string) {
  let query = getFirestore().collection('events').where('orgId', '==', orgId).where('facilityId', '==', facilityId);
  if (resourceId) query = query.where('resourceId', '==', resourceId);
  return query;
}
export const listFacilities = readCommand(data => {
  keys(data, ['orgId', 'cursor', 'pageSize']); return { orgId: id(data.orgId, 'orgId'), ...page(data) };
}, async (tx, data, uid) => {
  const scope = await staff(tx, data.orgId, uid);
  let query = getFirestore().collection(`organizations/${data.orgId}/facilities`).orderBy(FieldPath.documentId());
  if (data.cursor) query = query.startAfter(data.cursor);
  const rows = await tx.get(query.limit(data.pageSize + 1));
  return { canManage: scope.admin, items: rows.docs.slice(0, data.pageSize).map(row => publicFacility(row.id, row.data())), nextCursor: rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null };
});
export const listFacilityResources = readCommand(data => {
  keys(data, ['orgId', 'facilityId', 'cursor', 'pageSize']); return { orgId: id(data.orgId, 'orgId'), facilityId: id(data.facilityId, 'facilityId'), ...page(data) };
}, async (tx, data, uid) => {
  await staff(tx, data.orgId, uid); await facility(tx, data.orgId, data.facilityId);
  let query = facilityRef(data.orgId, data.facilityId).collection('resources').orderBy(FieldPath.documentId());
  if (data.cursor) query = query.startAfter(data.cursor);
  const rows = await tx.get(query.limit(data.pageSize + 1));
  return { items: rows.docs.slice(0, data.pageSize).map(row => publicResource(row.id, row.data())), nextCursor: rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null };
});
export const saveFacility = command('saveFacility', data => {
  keys(data, ['requestId', 'orgId', 'facilityId', 'expectedRevision', 'fields']);
  return { orgId: id(data.orgId, 'orgId'), facilityId: data.facilityId == null ? null : id(data.facilityId, 'facilityId'), expectedRevision: revision(data.expectedRevision), fields: facilityFields(data.fields) };
}, async (tx, data, uid, _actor, replay) => {
  await catalogAdmin(tx, data.orgId, uid, !replay); if (replay) return replay;
  const ref = data.facilityId ? facilityRef(data.orgId, data.facilityId) : getFirestore().collection(`organizations/${data.orgId}/facilities`).doc();
  const before = data.facilityId ? await facility(tx, data.orgId, data.facilityId) : undefined;
  checkRevision(before, data.expectedRevision);
  if (before && data.fields.status === 'inactive') {
    const rows = await tx.get(queryEvents(data.orgId, ref.id).where('endsAt', '>', Timestamp.now()).limit(501)); bounded(rows.size);
    if ((await Promise.all(rows.docs.map(row => active(tx, row.data())))).some(Boolean)) conflict('Move or postpone future reservations before making this facility unavailable.');
  }
  const row = { ...data.fields, orgId: data.orgId, ...metadata(uid, before), auditCorrelationId: ref.id };
  tx.create(ref.collection('revisions').doc(String(row.revision)), { ...row, effectiveAt: Timestamp.now() });
  tx.set(ref, row); audit(tx, data.orgId, uid, 'saveFacility', ref.id, row.revision);
  return { facility: publicFacility(ref.id, row) };
});
export const saveFacilityResource = command('saveFacilityResource', data => {
  keys(data, ['requestId', 'orgId', 'facilityId', 'resourceId', 'expectedRevision', 'fields']);
  return { orgId: id(data.orgId, 'orgId'), facilityId: id(data.facilityId, 'facilityId'), resourceId: data.resourceId == null ? null : id(data.resourceId, 'resourceId'), expectedRevision: revision(data.expectedRevision), fields: resourceFields(data.fields) };
}, async (tx, data, uid, _actor, replay) => {
  await catalogAdmin(tx, data.orgId, uid, !replay); await facility(tx, data.orgId, data.facilityId);
  const before = data.resourceId ? await resource(tx, data.orgId, data.facilityId, data.resourceId) : undefined;
  if (replay) return replay; checkRevision(before, data.expectedRevision);
  const ref = data.resourceId ? resourceRef(data.orgId, data.facilityId, data.resourceId) : facilityRef(data.orgId, data.facilityId).collection('resources').doc();
  if (before) {
    const rows = await tx.get(queryEvents(data.orgId, data.facilityId, ref.id).where('endsAt', '>', Timestamp.now()).limit(501)); bounded(rows.size);
    if ((await Promise.all(rows.docs.map(async row => await active(tx, row.data()) && (data.fields.status === 'inactive' || row.data().resourceOccupancy?.sports?.some((sport: string) => !data.fields.sports.includes(sport)))))).some(Boolean)) conflict('Move or postpone incompatible future reservations first.');
  }
  const row = { ...data.fields, orgId: data.orgId, facilityId: data.facilityId, ...metadata(uid, before), auditCorrelationId: ref.id };
  tx.create(ref.collection('revisions').doc(String(row.revision)), { ...row, effectiveAt: Timestamp.now() });
  tx.set(ref, row); audit(tx, data.orgId, uid, 'saveFacilityResource', ref.id, row.revision);
  return { resource: publicResource(ref.id, row) };
});
export const listResourceAvailability = readCommand(data => {
  keys(data, ['orgId', 'facilityId', 'resourceId', 'cursor', 'pageSize']);
  return { orgId: id(data.orgId, 'orgId'), facilityId: id(data.facilityId, 'facilityId'), resourceId: id(data.resourceId, 'resourceId'), ...page(data) };
}, async (tx, data, uid) => {
  await staff(tx, data.orgId, uid); await facility(tx, data.orgId, data.facilityId); await resource(tx, data.orgId, data.facilityId, data.resourceId);
  let query = resourceRef(data.orgId, data.facilityId, data.resourceId).collection('availability').orderBy('effectiveFrom', 'desc');
  if (data.cursor) {
    const cursor = await tx.get(queryEventsAvailability(data).doc(data.cursor)); if (!cursor.exists) invalid('Invalid cursor.');
    query = query.startAfter(cursor);
  }
  const rows = await tx.get(query.limit(data.pageSize + 1));
  return { items: rows.docs.slice(0, data.pageSize).map(row => ({ id: row.id, revision: row.data().revision, effectiveFrom: row.data().effectiveFrom, windows: row.data().windows })), nextCursor: rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null };
});
const queryEventsAvailability = (data: Data) => resourceRef(data.orgId, data.facilityId, data.resourceId).collection('availability');
export const appendResourceAvailability = command('appendResourceAvailability', data => {
  keys(data, ['requestId', 'orgId', 'facilityId', 'resourceId', 'expectedRevision', 'effectiveFrom', 'windows']);
  if (!Array.isArray(data.windows) || data.windows.length > 100) invalid('Supply at most 100 explicit availability windows.');
  const windows = data.windows.map(interval).sort((a: { startsAt: string }, b: { startsAt: string }) => a.startsAt.localeCompare(b.startsAt));
  for (let i = 1; i < windows.length; i++) if (overlaps(windows[i - 1], windows[i])) invalid('Availability windows overlap.');
  return { orgId: id(data.orgId, 'orgId'), facilityId: id(data.facilityId, 'facilityId'), resourceId: id(data.resourceId, 'resourceId'), expectedRevision: revision(data.expectedRevision), effectiveFrom: instant(data.effectiveFrom, 'effectiveFrom'), windows };
}, async (tx, data, uid, _actor, replay) => {
  await catalogAdmin(tx, data.orgId, uid, !replay); await facility(tx, data.orgId, data.facilityId);
  const before = await resource(tx, data.orgId, data.facilityId, data.resourceId); if (replay) return replay;
  checkRevision(before, data.expectedRevision);
  const ref = resourceRef(data.orgId, data.facilityId, data.resourceId);
  const latest = await tx.get(ref.collection('availability').orderBy('effectiveFrom', 'desc').limit(1));
  if (data.effectiveFrom <= Timestamp.now().toDate().toISOString() || (latest.size && data.effectiveFrom <= latest.docs[0].data().effectiveFrom)) invalid('New availability must take effect in the future after the previous revision.');
  if (data.windows.some((window: Data) => window.startsAt < data.effectiveFrom)) invalid('Availability windows cannot precede their effective date.');
  const rows = await tx.get(queryEvents(data.orgId, data.facilityId, data.resourceId).where('endsAt', '>', Timestamp.fromMillis(Date.parse(data.effectiveFrom) - 3 * 3600000)).limit(501)); bounded(rows.size);
  if ((await Promise.all(rows.docs.map(async row => await active(tx, row.data()) && occupied(row.data()) && occupied(row.data())!.endsAt > data.effectiveFrom && !contains(data.windows, occupied(row.data())!)))).some(Boolean)) conflict('New availability would exclude a reservation. Move or postpone it first.');
  const next = before.revision + 1;
  tx.create(ref.collection('availability').doc(String(next)), { schemaVersion: 2, orgId: data.orgId, facilityId: data.facilityId, resourceId: data.resourceId,
    revision: next, effectiveFrom: data.effectiveFrom, windows: data.windows, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), auditCorrelationId: `${ref.id}:${next}` });
  tx.update(ref, { revision: next, updatedAt: Timestamp.now(), updatedBy: uid }); audit(tx, data.orgId, uid, 'appendResourceAvailability', ref.id, next);
  return { revision: next };
});

/** Read before writing; resource document fencing serializes assignments and catalog changes. */
export async function validateResourceAssignment(tx: Transaction, event: Data, eventId: string, sports: string[]) {
  if (event.facilityId == null && event.resourceId == null) return { resourceDetails: null, resourceOccupancy: null };
  if (!event.facilityId || !event.resourceId) invalid('Choose both facility and resource.');
  const f = await facility(tx, event.orgId, event.facilityId), r = await resource(tx, event.orgId, event.facilityId, event.resourceId);
  if (f.status !== 'active' || r.status !== 'active') conflict('This facility or resource is unavailable.');
  if (!sports.length || sports.some(sport => !r.sports.includes(sport))) conflict('The resource is incompatible with this sport.');
  const startsAt = event.startsAt.toDate().toISOString(), endsAt = event.endsAt.toDate().toISOString();
  if (Date.parse(endsAt) - Date.parse(startsAt) > 24 * 3600000) invalid('Resource bookings are limited to 24 hours.');
  const span = occupancy({ startsAt, endsAt }, r.setupMinutes, r.cleanupMinutes);
  await requireOpenInterval(tx, { ...event, resourceOccupancy: { startsAt: Timestamp.fromDate(new Date(span.startsAt)), endsAt: Timestamp.fromDate(new Date(span.endsAt)) } });
  // Select by occupancy start, then ensure no revision boundary splits the occupied interval.
  const revisions = await tx.get(resourceRef(event.orgId, event.facilityId, event.resourceId).collection('availability')
    .where('effectiveFrom', '<', span.endsAt).orderBy('effectiveFrom', 'desc').limit(1));
  const available = revisions.docs[0]?.data();
  if (!available || available.effectiveFrom > span.startsAt || !contains(available.windows, span)) conflict('This resource is unavailable for the full interval including setup and cleanup.');
  const rows = await tx.get(queryEvents(event.orgId, event.facilityId, event.resourceId)
    .where('startsAt', '>=', Timestamp.fromMillis(Date.parse(span.startsAt) - 27 * 3600000))
    .where('startsAt', '<', Timestamp.fromMillis(Date.parse(span.endsAt) + 3 * 3600000)).limit(501)); bounded(rows.size);
  for (const row of rows.docs) if (row.id !== eventId && await active(tx, row.data()) && occupied(row.data()) && overlaps(span, occupied(row.data())!)) conflict('This resource already has an overlapping reservation including setup and cleanup.');
  return { location: { name: `${f.name} · ${r.label}`, address: f.address }, resourceDetails: { facilityName: f.name, label: r.label,
    address: f.address, timeZone: f.timeZone, latitude: f.latitude, longitude: f.longitude, parking: f.parking, accessibility: f.accessibility },
    resourceOccupancy: { startsAt: Timestamp.fromDate(new Date(span.startsAt)), endsAt: Timestamp.fromDate(new Date(span.endsAt)),
      setupMinutes: r.setupMinutes, cleanupMinutes: r.cleanupMinutes, sports, availabilityRevision: available.revision, resourceRevision: r.revision },
    resourceFence: resourceRef(event.orgId, event.facilityId, event.resourceId) };
}
export function commitResourceAssignment(tx: Transaction, event: Data, assignment: Data, eventId: string, nextRevision: number, previous: Data = event) {
  const { resourceFence, ...fields } = assignment;
  if (resourceFence) tx.update(resourceFence, { reservationVersion: Timestamp.now() });
  if (event.resourceOccupancy || fields.resourceOccupancy) tx.create(getFirestore().doc(`events/${eventId}/resourceHistory/${nextRevision}`), {
    schemaVersion: 2, revision: nextRevision, orgId: event.orgId, facilityId: event.facilityId ?? null, resourceId: event.resourceId ?? null,
    status: event.status, occupancy: Object.hasOwn(fields, 'resourceOccupancy') ? fields.resourceOccupancy : event.resourceOccupancy ?? null,
    previousFacilityId: previous.facilityId ?? null, previousResourceId: previous.resourceId ?? null, previousOccupancy: previous.resourceOccupancy ?? null, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), auditCorrelationId: `${eventId}:${nextRevision}` });
  return fields;
}
