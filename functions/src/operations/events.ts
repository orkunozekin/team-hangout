import { prepareRosterSnapshot } from './attendance';
import { effectiveEvent, requireOpenInterval, primeClosureReads } from '../facilities/closures';
import { fingerprint } from './requests';
import { publishedEvent } from '../scheduling/visibility';
import { validateResourceAssignment, commitResourceAssignment } from '../facilities/service';
import { cacheDocumentReads } from './reads';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, revision, text } from '../commandSupport';
import { checkRevision, denied, eventScope, hierarchy, staffScope, requireProgram } from './access';
import { storageFields, teamIds, v2Fields, validateStoredEvent, eventAudit } from '../organizations/events';
import { readCommand, page } from '../participants/policy';
import { readAgenda } from '../calendar/agenda';
import { stageReminder } from '../notifications/reminders';


// Reuse the existing live staff/coach/participant/guardian reader; navigation pointers grant nothing.
async function readableTeam(tx: Transaction, teamId: string, uid: string, household?: () => Promise<Data>) {
  const team = (await tx.get(getFirestore().doc(`teams/${teamId}`))).data();
  if (!team || team.schemaVersion !== 2) denied();
  const parents = await hierarchy(tx, team.orgId, team.programId, team.seasonId, team.divisionId, false);
  if (parents.org.features?.organizationV2 !== true) denied();
  try { const staff = await staffScope(tx, team.orgId, uid); requireProgram(staff, team.programId); return team; }
  catch (error) { if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error; }
  const member = (await tx.get(getFirestore().doc(`teamMembers/${teamId}_${uid}`))).data();
  if (member?.schemaVersion === 2 && member.orgId === team.orgId && member.teamId === teamId && member.userId === uid
    && member.status === 'active' && Array.isArray(member.roles) && member.roles.some((role: string) => ['coach', 'captain'].includes(role))) return team;
  const access = await (household ? household() : readAgenda(tx, {}, uid, { events: false }));
  if (!access.teams.some((row: Data) => row.id === teamId && row.orgId === team.orgId)) denied();
  return team;
}
async function canonical(tx: Transaction, event: Data) {
  const db = getFirestore();
  const ids = teamIds(event.teamIds);
  const rows = await tx.getAll(...ids.map(teamId => db.doc(`teams/${teamId}`)));
  if (event.teamId !== ids[0] || rows.some(row => row.data()?.schemaVersion !== 2
    || row.data()?.orgId !== event.orgId || row.data()?.programId !== event.programId
    || row.data()?.seasonId !== event.seasonId || (event.divisionId !== null && row.data()?.divisionId !== event.divisionId))) denied();
  for (const row of rows) await hierarchy(tx, event.orgId, event.programId, event.seasonId, row.data()!.divisionId, false);
  return rows.map(row => ({ id: row.id, name: row.data()!.name }));
}
async function result(tx: Transaction, eventId: string, event: Data, uid: string, management = new Map<string, Promise<boolean>>()) {
  event = await effectiveEvent(tx, event);
  const teams = await canonical(tx, event);
  const key = JSON.stringify(event.teamIds);
  if (!management.has(key)) management.set(key, (async () => {
    try { await eventScope(tx, event.teamIds, uid); return true; }
    catch (error) { if (!(error instanceof HttpsError) || !['permission-denied', 'failed-precondition'].includes(error.code)) throw error; return false; }
  })());
  const canManage = await management.get(key)!;
  let canReadPrivate = false;
  for (const teamId of event.teamIds) {
    const readKey = `private:${teamId}`;
    if (!management.has(readKey)) management.set(readKey, (async () => {
      try { await eventScope(tx, [teamId], uid, false); return true; }
      catch (error) { if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error; return false; }
    })());
    if (await management.get(readKey)!) { canReadPrivate = true; break; }
  }
  const fields = ['schemaVersion', 'orgId', 'programId', 'seasonId', 'divisionId', 'teamId', 'teamIds', 'title', 'type',
    'startsAt', 'endsAt', 'timeZone', 'status', 'publicationState', 'publicationOperationId', 'revision',
    'resourceClosed', 'closureUpdatePending', 'scheduleVersion', 'rescheduledFromRevision', 'homeTeamId', 'awayTeamId', 'completedAt',
    'createdAt', 'updatedAt', 'deletedAt', 'facilityId', 'resourceId'];
  const safe = Object.fromEntries(fields.filter(field => event[field] !== undefined).map(field => [field, event[field]]));
  return { id: eventId, ...safe, location: event.location ? { name: event.location.name,
    ...(event.location.address ? { address: event.location.address } : {}) } : null, ...(canReadPrivate ? { notes: event.notes ?? null, createdBy: event.createdBy, updatedBy: event.updatedBy } : {}), teams, canManage };
}
export const getNativeTeam = readCommand(data => {
  keys(data, ['teamId']); return { teamId: id(data.teamId, 'teamId') };
}, async (tx, data, uid) => {
  tx = cacheDocumentReads(tx);
  const team = await readableTeam(tx, data.teamId, uid);
  const organization = (await tx.get(getFirestore().doc(`organizations/${team.orgId}`))).data();
  const timeZone = text(organization?.timeZone, 'organization time zone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { invalid('Organization time zone needs administrator correction.'); }
  return { id: data.teamId, schemaVersion: 2, name: team.name, sport: team.sport ?? null, timeZone, orgId: id(team.orgId, 'stored orgId') };
});
export const listEventTeamChoices = readCommand(data => {
  keys(data, ['teamId', 'pageSize', 'cursor']); return { teamId: id(data.teamId, 'teamId'), ...page(data) };
}, async (tx, data, uid) => {
  tx = cacheDocumentReads(tx);
  const base = await readableTeam(tx, data.teamId, uid);
  // Mutating any combination requires the same every-team grant used by creation.
  await eventScope(tx, [data.teamId], uid);
  let query = getFirestore().collection('teams').where('orgId', '==', base.orgId).where('programId', '==', base.programId)
    .where('seasonId', '==', base.seasonId).orderBy(FieldPath.documentId());
  if (data.cursor) query = query.startAfter(data.cursor);
  const rows = await tx.get(query.limit(data.pageSize + 1));
  const items: Data[] = [];
  for (const row of rows.docs.slice(0, data.pageSize)) {
    try { await eventScope(tx, row.id === data.teamId ? [data.teamId] : [data.teamId, row.id], uid); items.push({ id: row.id, name: row.data().name }); }
    catch (error) { if (!(error instanceof HttpsError) || !['permission-denied', 'failed-precondition'].includes(error.code)) throw error; }
  }
  return { items, nextCursor: rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null };
});
export const listCanonicalTeamEvents = readCommand(data => {
  keys(data, ['teamId', 'pageSize', 'cursor', 'view']);
  const view = data.view ?? 'all';
  if (!['all', 'upcoming', 'past'].includes(view)) invalid('Invalid schedule view.');
  return { teamId: id(data.teamId, 'teamId'), view, ...page({ ...data, cursor: null }),
    cursor: data.cursor == null ? null : text(data.cursor, 'cursor', 2000) };
}, async (tx, data, uid) => {
  tx = cacheDocumentReads(tx);
  const management = new Map<string, Promise<boolean>>();
  const team = await readableTeam(tx, data.teamId, uid);
  const publicationVersion = (await tx.get(getFirestore().doc(`organizations/${team.orgId}/schedulingLock/current`))).data()?.visibilityRevision ?? 0;
  let cutoff = Timestamp.now().toDate().toISOString();
  let boundary: Data | null = null;
  if (data.cursor) {
    try { boundary = JSON.parse(Buffer.from(data.cursor, 'base64url').toString('utf8')); } catch { invalid('Invalid schedule cursor.'); }
    if (!boundary || boundary.orgId !== team.orgId || boundary.teamId !== data.teamId || boundary.view !== data.view || boundary.publicationVersion !== publicationVersion
      || typeof boundary.cutoff !== 'string' || !Number.isFinite(Date.parse(boundary.cutoff))
      || new Date(boundary.cutoff).toISOString() !== boundary.cutoff
      || typeof boundary.startsAt !== 'string' || !Number.isFinite(Date.parse(boundary.startsAt))
      || new Date(boundary.startsAt).toISOString() !== boundary.startsAt) return invalid('Invalid schedule cursor.');
    cutoff = boundary.cutoff;
  }
  let query = getFirestore().collection('events').where('orgId', '==', team.orgId)
    .where('teamIds', 'array-contains', data.teamId).where('publicationState', '==', 'published')
    .where('deletedAt', '==', null);
  if (data.view !== 'all') query = query.where('startsAt', data.view === 'past' ? '<' : '>=', Timestamp.fromDate(new Date(cutoff)));
  const direction = data.view === 'past' ? 'desc' : 'asc';
  query = query.orderBy('startsAt', direction).orderBy(FieldPath.documentId(), direction);
  if (boundary) query = query.startAfter(Timestamp.fromDate(new Date(boundary.startsAt)), id(boundary.id, 'cursor eventId'));
  const visibleRows: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let scanned = 0;
  while (visibleRows.length <= data.pageSize) {
    const rows = await tx.get(query.limit(data.pageSize + 1));
    for (const row of rows.docs) {
      if (++scanned > 500) throw new HttpsError('resource-exhausted', 'Schedule visibility scan exceeded 500 rows. Retry after publication recovery.');
      const event = row.data();
      if (event.schemaVersion === 2 && await publishedEvent(tx, event)) visibleRows.push(row);
      if (visibleRows.length > data.pageSize) break;
    }
    if (visibleRows.length > data.pageSize || rows.size < data.pageSize + 1) break;
    query = query.startAfter(rows.docs[rows.docs.length - 1]);
  }
  await primeClosureReads(tx, visibleRows.slice(0, data.pageSize).map(row => row.data()));
  const items: Data[] = [];
  for (const row of visibleRows.slice(0, data.pageSize)) items.push(await result(tx, row.id, row.data(), uid, management));
  const last = visibleRows[data.pageSize - 1];
  const nextCursor = visibleRows.length > data.pageSize ? Buffer.from(JSON.stringify({ orgId: team.orgId, teamId: data.teamId, view: data.view, publicationVersion, cutoff,
    startsAt: last.data().startsAt.toDate().toISOString(), id: last.id })).toString('base64url') : null;
  let canManage = false;
  try { await eventScope(tx, [data.teamId], uid); canManage = true; }
  catch (error) { if (!(error instanceof HttpsError) || !['permission-denied', 'failed-precondition'].includes(error.code)) throw error; }
  return { items, nextCursor, canManage };
});
export const getCanonicalEvent = readCommand(data => {
  keys(data, ['eventId']); return { eventId: id(data.eventId, 'eventId') };
}, async (tx, data, uid) => {
  tx = cacheDocumentReads(tx);
  let agenda: Promise<Data> | undefined;
  const household = () => agenda ??= readAgenda(tx, {}, uid, { events: false });
  const event = (await tx.get(getFirestore().doc(`events/${data.eventId}`))).data();
  if (!event || event.schemaVersion !== 2 || !(await publishedEvent(tx, event))) denied();
  let allowed = false;
  for (const teamId of teamIds(event.teamIds)) {
    try { await readableTeam(tx, teamId, uid, household); allowed = true; break; }
    catch (error) { if (!(error instanceof HttpsError) || error.code !== 'permission-denied') throw error; }
  }
  if (!allowed) denied();
  const item = await result(tx, data.eventId, event, uid);
  // Bounded recent history is safe schedule metadata only, never private notes or actor identity.
  const rows = await tx.get(getFirestore().collection(`events/${data.eventId}/scheduleHistory`).orderBy('revision', 'desc').limit(21));
  const privateHistory = Object.hasOwn(item, 'notes');
  const historyFields = ['schemaVersion', 'revision', 'action', 'previousStatus', 'status', 'previousTimeZone', 'timeZone',
    'previousStartsAt', 'previousEndsAt', 'startsAt', 'endsAt', 'createdAt', ...(privateHistory ? ['reason'] : [])];
  return { ...item, history: rows.docs.slice(0, 20).map(row => {
    const value = row.data(); return Object.fromEntries(historyFields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  }), historyHasMore: rows.size > 20 };
});

export const mutateEventSchedule = command('mutateEventSchedule', data => {
  keys(data, ['requestId', 'eventId', 'expectedRevision', 'action', 'patch', 'reason']);
  const action = text(data.action, 'action');
  if (!['edit', 'postpone', 'cancel', 'reschedule', 'complete'].includes(action)) invalid('Invalid lifecycle action.');
  const patch = object(data.patch ?? {});
  if (['postpone', 'cancel', 'complete'].includes(action)) keys(patch, []);
  else keys(patch, action === 'edit' ? ['title', 'type', 'location', 'notes', 'facilityId', 'resourceId'] : ['startsAt', 'endsAt', 'timeZone']);
  if (action === 'reschedule' && ['startsAt', 'endsAt', 'timeZone'].some(field => patch[field] === undefined)) invalid('Supply the complete new interval and timeZone.');
  return { eventId: id(data.eventId, 'eventId'), expectedRevision: revision(data.expectedRevision), action,
    patch: ['edit', 'reschedule'].includes(action) ? v2Fields(patch, true) : {}, reason: text(data.reason, 'reason', 500) };
}, lifecycleMutation);
export async function lifecycleMutation(tx: Transaction, data: Data, uid: string, _actor: Data, replay: Data | null, reviewedMakeup = false) {
  const db = getFirestore(); const ref = db.doc(`events/${data.eventId}`);
  const event = (await tx.get(ref)).data();
  if (!event || event.schemaVersion !== 2) denied();
  const scope = await eventScope(tx, teamIds(event.teamIds), uid, !replay);
  validateStoredEvent({ ...event, publicationOperationId: null }, scope);
  if (replay) return replay;
  checkRevision(event, data.expectedRevision);
  const [storedReminder, organization] = await tx.getAll(
    db.doc(`organizations/${event.orgId}/rsvpReminders/${ref.id}`), db.doc(`organizations/${event.orgId}`));
  const remindersEnabled = organization.data()?.features?.rsvpReminders === true && organization.data()?.status === 'active';
  if (!(await publishedEvent(tx, event))) throw new HttpsError('failed-precondition', 'Only committed published events can be changed.');
  if (event.status === 'completed' || event.status === 'cancelled'
    || (['postpone', 'complete'].includes(data.action) && event.status !== 'scheduled')) {
    throw new HttpsError('failed-precondition', 'This action is unavailable for the current event status.');
  }
  if (data.action === 'reschedule' && event.status === 'postponed' && event.closureId != null && !reviewedMakeup) {
    throw new HttpsError('failed-precondition', 'Use Closures and makeups in the browser workspace to review and confirm this closure makeup.', { domainCode: 'MAKEUP_REVIEW_REQUIRED' });
  }
  if (['complete', 'edit'].includes(data.action)) await requireOpenInterval(tx, event);
  // A final competition result or bracket link keeps its match identity; scorers void or relink it before the event can stop being a match.
  if (data.patch.type !== undefined && data.patch.type !== event.type && event.type === 'match') {
    const [results, links] = await Promise.all([tx.get(ref.collection('competitionResults').limit(1)), tx.get(ref.collection('bracketLinks').limit(1))]);
    if (!results.empty) {
      throw new HttpsError('failed-precondition', 'A competition result is final for this match. Ask a scorer to void it before changing the event type.', { domainCode: 'RESULT_RECORDED' });
    }
    if (!links.empty) {
      throw new HttpsError('failed-precondition', 'This match is linked to a published bracket game. Ask a competition manager to link another match first.', { domainCode: 'BRACKET_LINKED' });
    }
  }
  const now = Timestamp.now(); const nextRevision = event.revision + 1;
  const changes: Data = { ...data.patch };
  if (data.patch.type !== undefined) Object.assign(changes, {
    homeTeamId: data.patch.type === 'match' && event.teamIds.length === 2 ? event.teamIds[0] : null,
    awayTeamId: data.patch.type === 'match' && event.teamIds.length === 2 ? event.teamIds[1] : null });
  if (data.action === 'reschedule') {
    if (reviewedMakeup) changes.closureId = null;
    if (event.startsAt.toMillis() === Date.parse(data.patch.startsAt) && event.endsAt.toMillis() === Date.parse(data.patch.endsAt)
      && event.timeZone === data.patch.timeZone) invalid('Choose a different schedule.');
    Object.assign(changes, storageFields({ ...data.patch }), { status: 'scheduled', rsvpDeadline: null, scheduleVersion: (event.scheduleVersion ?? 1) + 1,
      rescheduledFromRevision: event.revision, originalInterval: event.originalInterval ?? { startsAt: event.startsAt, endsAt: event.endsAt, timeZone: event.timeZone } });
  } else if (data.action !== 'edit') changes.status = { postpone: 'postponed', cancel: 'cancelled', complete: 'completed' }[data.action as string];
  const snapshot = data.action === 'complete' ? await prepareRosterSnapshot(tx, ref.id, event, uid, nextRevision, now) : null;
  if (snapshot) Object.assign(changes, { completedAt: now, rosterSnapshot: snapshot.metadata });
  if (data.action === 'postpone') changes.postponementReason = data.reason;
  let assignment: Data = {};
  const assigning = data.patch.facilityId !== undefined || data.patch.resourceId !== undefined;
  if (data.action === 'reschedule' || assigning) assignment = await validateResourceAssignment(tx, { ...event, ...changes }, ref.id, scope.teams.map(team => team.sport));
  if (!assigning && event.resourceId && data.patch.location !== undefined && JSON.stringify(data.patch.location) !== JSON.stringify(event.location)) invalid('Assigned resources determine the location. Remove the resource assignment before entering a custom location.');
  Object.assign(changes, commitResourceAssignment(tx, { ...event, ...changes }, assignment, ref.id, nextRevision, event));
  snapshot?.write();
  // History is immutable and retains the previous interval and status for each committed transition.
  tx.create(ref.collection('scheduleHistory').doc(String(nextRevision)), { schemaVersion: 2, revision: nextRevision,
    action: data.action, reason: data.reason, previousStatus: event.status, status: changes.status ?? event.status,
    previousTimeZone: event.timeZone, timeZone: changes.timeZone ?? event.timeZone,
    previousStartsAt: event.startsAt, previousEndsAt: event.endsAt, startsAt: changes.startsAt ?? event.startsAt,
    endsAt: changes.endsAt ?? event.endsAt, createdAt: now });
  tx.update(ref, { ...changes, revision: nextRevision, updatedAt: now, updatedBy: uid });
  eventAudit(tx, event, uid, `event:${data.action}`, ref.id, nextRevision);
  tx.create(db.doc(`organizations/${event.orgId}/outbox/${fingerprint({ eventId: ref.id, revision: nextRevision, kind: data.action })}`), {
    schemaVersion: 2, orgId: event.orgId, sourceType: 'event', sourceId: ref.id, sourceRevision: nextRevision,
    templateKey: `event:${data.action}`, state: 'pending', critical: data.action !== 'edit', audience: { teamIds: event.teamIds },
    programId: event.programId ?? null, createdAt: now, updatedAt: now, auditCorrelationId: `${ref.id}:${nextRevision}` });
  stageReminder(tx, ref.id, { ...event, ...changes, revision: nextRevision }, storedReminder.data(), remindersEnabled, now.toMillis(), true);
  return { id: ref.id, revision: nextRevision };
}
