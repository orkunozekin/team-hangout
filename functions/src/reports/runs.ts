import { createHash } from 'crypto';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { command, Data, id, invalid, keys, object } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { denied, hierarchy, staffScope } from '../operations/access';
import { publishedEvent } from '../scheduling/visibility';
import { effectiveClosure, primeClosureReads } from '../facilities/closures';
import {
  AttendanceEventInput, AvailabilityVersion, BookingInput, RecordedAttendance, reduceAttendance, reduceFacility,
  REPORT_REDUCER_VERSION, ReportInputError, reportInterval, ResourceInput,
} from './reducers';

const db = () => getFirestore();
/** Filter and output contract version. */
export const REPORT_VERSION = 1;
const MAX_ATTEMPTS = 3;
/** A build runs inside one invocation (at most 540 s); an older lease was abandoned. */
const LEASE_MS = 10 * 60 * 1000;
const EVENT_PAGE = 200;
const ROW_PAGE = 50;
const LIST_PAGE = 20;
const ACTIVE_RUN_LIMIT = 10;
/** Engineering guardrails, revisited after measurements. Larger runs fail with a partition instruction. */
export const REPORT_LIMITS = { events: 3000, participantRows: 60_000, resources: 100, availabilityVersions: 366, closures: 1000, rows: 1000 };
const STATUSES: RecordedAttendance[] = ['present', 'late', 'absent', 'excused', 'unknown'];
const FORMULAS = {
  attendance: [
    'presenceRate = (present + late) / (present + late + absent)',
    'completionCoverage = (present + late + absent + excused) / eligible',
    'eligible = frozen completion roster snapshot; missing = no record for the current schedule version; unknown = recorded unknown',
    'excluded = cancelled and postponed events; awaitingClosure = ended but not completed',
  ],
  facility: [
    'utilization = bookedMinutes / availableMinutes',
    'availableMinutes = versioned availability windows minus applied closures, summed across resources',
    'bookedMinutes = union of published scheduled or completed occupancy within availableMinutes; shared games count once',
    'outsideAvailability, conflict and unknownAvailability minutes are reported separately; reservations are not physical use',
  ],
};

class ReportTooLarge extends Error {
  constructor(message: string) { super(message); this.name = 'ReportTooLarge'; }
}
class SourceUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'SourceUnavailable'; }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runRef = (orgId: string, runId: string) => db().doc(`organizations/${orgId}/reportRuns/${runId}`);
const iso = (value: unknown) => (value instanceof Timestamp ? value.toDate().toISOString() : typeof value === 'string' ? value : null);
const rowId = (attempt: number, position: number) => `${String(attempt).padStart(2, '0')}-${String(position).padStart(4, '0')}`;
/** Read-only adapter so shared visibility and closure helpers can read outside a transaction. */
const reader = () => ({ get: (ref: any) => ref.get(), getAll: (...refs: any[]) => db().getAll(...refs) }) as unknown as Transaction;

function localDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`Invalid ${field}.`);
  return value as string;
}
function normalizeFilters(value: unknown): Data {
  const row = object(value);
  if (row.kind === 'attendance') {
    keys(row, ['kind', 'programId', 'seasonId', 'teamId', 'fromDate', 'toDate']);
    return { kind: 'attendance', programId: id(row.programId, 'programId'), seasonId: id(row.seasonId, 'seasonId'),
      teamId: row.teamId == null ? null : id(row.teamId, 'teamId'), fromDate: localDate(row.fromDate, 'fromDate'), toDate: localDate(row.toDate, 'toDate') };
  }
  if (row.kind === 'facility') {
    keys(row, ['kind', 'facilityId', 'fromDate', 'toDate']);
    return { kind: 'facility', facilityId: id(row.facilityId, 'facilityId'), fromDate: localDate(row.fromDate, 'fromDate'), toDate: localDate(row.toDate, 'toDate') };
  }
  return invalid('Choose an attendance or facility report.');
}

async function staffOrNull(tx: Transaction, orgId: string, uid: string) {
  try {
    return await staffScope(tx, orgId, uid);
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'permission-denied') return null;
    throw error;
  }
}
/** Team reporting needs a live coach assignment; captains, players and guardians do not qualify. */
async function activeCoach(tx: Transaction, orgId: string, teamId: string, uid: string) {
  const coach = (await tx.get(db().doc(`teamMembers/${teamId}_${uid}`))).data();
  return coach?.teamId === teamId && coach.userId === uid && coach.orgId === orgId && coach.status === 'active'
    && Array.isArray(coach.roles) && coach.roles.includes('coach');
}

/**
 * Rechecked on every request and read from canonical grants. Organization reports need scoped staff
 * (reports.viewOrganization); a team-filtered attendance report also admits that team's active coach (reports.viewTeam).
 * Facility reports aggregate every program's reservations, so they need an organization administrator.
 */
async function authorize(tx: Transaction, orgId: string, uid: string, filters: Data) {
  const org = (await tx.get(db().doc(`organizations/${orgId}`))).data();
  if (!org || org.schemaVersion !== 2 || org.features?.organizationV2 !== true) denied();
  if (org!.features?.reports !== true) throw new HttpsError('failed-precondition', 'Reports are not enabled for this organization.', { domainCode: 'REPORTS_DISABLED' });
  const staff = await staffOrNull(tx, orgId, uid);
  if (filters.kind === 'facility') {
    if (!staff?.admin) denied();
    const facility = (await tx.get(db().doc(`organizations/${orgId}/facilities/${filters.facilityId}`))).data();
    if (!facility || facility.schemaVersion !== 2 || facility.orgId !== orgId) denied();
    return org!;
  }
  await hierarchy(tx, orgId, filters.programId, filters.seasonId, null, false);
  if (filters.teamId) {
    const team = (await tx.get(db().doc(`teams/${filters.teamId}`))).data();
    if (!team || team.schemaVersion !== 2 || team.orgId !== orgId || team.programId !== filters.programId || team.seasonId !== filters.seasonId) denied();
  }
  if (staff && (staff.admin || staff.programIds.includes(filters.programId))) return org!;
  if (filters.teamId && await activeCoach(tx, orgId, filters.teamId, uid)) return org!;
  return denied();
}

function intervalFor(filters: Data, timeZone: unknown) {
  if (typeof timeZone !== 'string') throw new HttpsError('failed-precondition', 'Set the organization time zone before running reports.', { domainCode: 'TIME_ZONE_REQUIRED' });
  try {
    return reportInterval(filters.fromDate, filters.toDate, timeZone);
  } catch (error) {
    if (error instanceof ReportInputError || error instanceof RangeError) return invalid(error.message);
    throw error;
  }
}

async function createRun(tx: Transaction, orgId: string, filters: Data, interval: ReturnType<typeof reportInterval>, uid: string, supersedes: string | null) {
  const active = await tx.get(db().collection(`organizations/${orgId}/reportRuns`).where('state', 'in', ['queued', 'building']).limit(ACTIVE_RUN_LIMIT));
  if (active.size >= ACTIVE_RUN_LIMIT) {
    throw new HttpsError('resource-exhausted', 'Several reports are already calculating. Try again when they finish.', { domainCode: 'REPORT_QUEUE_FULL' });
  }
  const ref = db().collection(`organizations/${orgId}/reportRuns`).doc();
  const now = Timestamp.now();
  tx.create(ref, {
    schemaVersion: 2, orgId, runId: ref.id, kind: filters.kind, filters,
    programId: filters.programId ?? null, seasonId: filters.seasonId ?? null, teamId: filters.teamId ?? null, facilityId: filters.facilityId ?? null,
    interval, intervalStartsAt: interval.startsAt, intervalEndsAt: interval.endsAt,
    reportVersion: REPORT_VERSION, reducerVersion: REPORT_REDUCER_VERSION, formulas: FORMULAS[filters.kind as 'attendance' | 'facility'],
    state: 'queued', attempts: 0, requestedBy: uid, requestedAt: now, queuedAt: now, startedAt: null, leaseExpiresAt: null,
    stale: false, staleReason: null, sourceChangedAt: null, supersedes, supersededBy: null, verifiedBy: null,
    failure: null, summary: null, manifest: null, rowCount: 0, sourceDigest: null, sourceCutoff: null, completedAt: null, completedAttempt: null,
  });
  return { runId: ref.id, state: 'queued' };
}

export const requestReport = command('requestReport', data => {
  keys(data, ['requestId', 'orgId', 'filters']);
  return { orgId: id(data.orgId, 'orgId'), filters: normalizeFilters(data.filters) };
}, async (tx, data, uid, _actor, replay) => {
  const org = await authorize(tx, data.orgId, uid, data.filters);
  if (replay) return replay;
  return createRun(tx, data.orgId, data.filters, intervalFor(data.filters, org.timeZone), uid, null);
});

/** A rebuild never edits the earlier snapshot's figures; it creates a new run and marks the old one stale if sources differ. */
export const rebuildReport = command('rebuildReport', data => {
  keys(data, ['requestId', 'orgId', 'runId']);
  return { orgId: id(data.orgId, 'orgId'), runId: id(data.runId, 'runId') };
}, async (tx, data, uid, _actor, replay) => {
  const run = await loadRun(tx, data.orgId, data.runId);
  await authorize(tx, data.orgId, uid, run.filters);
  if (replay) return replay;
  if (run.state !== 'complete' && run.state !== 'failed') {
    throw new HttpsError('failed-precondition', 'This report is still calculating.', { domainCode: 'REPORT_IN_PROGRESS' });
  }
  return createRun(tx, data.orgId, run.filters, intervalFor(run.filters, run.interval.timeZone), uid, run.runId);
});

async function loadRun(tx: Transaction, orgId: string, runId: string) {
  const run = (await tx.get(runRef(orgId, runId))).data();
  if (!run || run.schemaVersion !== 2 || run.orgId !== orgId) denied();
  return run!;
}

type Built = { summary: Data; rows: Data[]; manifest: Record<string, number>; sourceDigest: string };

/** Filtered-out documents (staged, other scopes) still cost reads, so raw scans are bounded too. */
function scanned(reads: number) {
  if (reads > REPORT_LIMITS.events * 2) throw new ReportTooLarge('Too many calendar records in this range. Choose one team or a shorter date range.');
}

async function teamNames(teamIds: string[], orgId: string) {
  if (!teamIds.length) return new Map<string, string>();
  const docs = await db().getAll(...teamIds.map(teamId => db().doc(`teams/${teamId}`)));
  return new Map(docs.map(doc => [doc.id, doc.data()?.orgId === orgId && typeof doc.data()?.name === 'string' ? doc.data()!.name as string : 'Unavailable team']));
}

/** Reads only published events in the organization, program, season and interval; restricted subcollections are never read. */
export async function attendanceSource(run: Data): Promise<Built> {
  const { orgId, programId, seasonId, teamId } = run;
  const cutoff = Date.now();
  const start = Timestamp.fromDate(new Date(run.intervalStartsAt)), end = Timestamp.fromDate(new Date(run.intervalEndsAt));
  let base = db().collection('events').where('orgId', '==', orgId);
  base = teamId ? base.where('teamIds', 'array-contains', teamId) : base.where('seasonId', '==', seasonId);
  const inputs: AttendanceEventInput[] = [];
  const parts: unknown[] = [];
  const manifest = { eventReads: 0, snapshotReads: 0, attendanceReads: 0, eventsInScope: 0, skippedSnapshotRows: 0 };
  let participantRows = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  const tx = reader();
  for (;;) {
    let query = base.where('startsAt', '>=', start).where('startsAt', '<', end).orderBy('startsAt').orderBy(FieldPath.documentId()).limit(EVENT_PAGE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    manifest.eventReads += Math.max(page.size, 1);
    scanned(manifest.eventReads);
    const events = page.docs.filter(doc => {
      const e = doc.data();
      return e.schemaVersion === 2 && e.orgId === orgId && e.programId === programId && e.seasonId === seasonId && Array.isArray(e.teamIds);
    });
    await primeClosureReads(tx, events.map(doc => doc.data()));
    for (const doc of events) {
      const e = doc.data();
      if (!(await publishedEvent(tx, e))) continue;
      manifest.eventsInScope += 1;
      if (manifest.eventsInScope > REPORT_LIMITS.events) throw new ReportTooLarge(`More than ${REPORT_LIMITS.events} events match. Choose one team or a shorter date range.`);
      const status = e.status === 'scheduled' && await effectiveClosure(tx, e) ? 'postponed' : e.status;
      const closed = status === 'completed' && Number.isSafeInteger(e.rosterSnapshot?.capturedRevision);
      const participants: AttendanceEventInput['participants'] = [];
      const recorded: unknown[] = [];
      if (closed) {
        let snapshots = db().collection(`events/${doc.id}/rosterSnapshots`) as FirebaseFirestore.Query;
        if (teamId) snapshots = snapshots.where('teamIds', 'array-contains', teamId);
        const rows = await snapshots.limit(201).get();
        manifest.snapshotReads += Math.max(rows.size, 1);
        participantRows += rows.size;
        if (participantRows > REPORT_LIMITS.participantRows) throw new ReportTooLarge('Too many attendance records for one run. Choose one team or a shorter date range.');
        const valid = rows.docs.filter(row => {
          const r = row.data();
          const ok = r.orgId === orgId && r.participantId === row.id && r.capturedRevision === e.rosterSnapshot.capturedRevision && Array.isArray(r.enrollments);
          if (!ok) manifest.skippedSnapshotRows += 1;
          return ok;
        });
        const marks = valid.length ? await db().getAll(...valid.map(row => db().doc(`events/${doc.id}/attendance/${row.id}`))) : [];
        manifest.attendanceReads += marks.length;
        const version = e.scheduleVersion ?? 1;
        valid.forEach((row, index) => {
          const mark = marks[index].data();
          const attendance = mark && mark.orgId === orgId && mark.scheduleVersion === version && STATUSES.includes(mark.status) ? mark.status as RecordedAttendance : null;
          const eligibleTeamIds = row.data().enrollments.filter((x: Data) => x.eligible === true && typeof x.teamId === 'string').map((x: Data) => x.teamId as string).sort();
          participants.push({ participantId: row.id, eligibleTeamIds, attendance });
          recorded.push([row.id, eligibleTeamIds, attendance, attendance ? mark!.revision ?? 0 : null]);
        });
      }
      inputs.push({ eventId: doc.id, status, ended: (e.endsAt as Timestamp).toMillis() <= cutoff, closed, teamIds: e.teamIds, participants });
      parts.push([doc.id, e.revision ?? 0, status, e.scheduleVersion ?? 1, closed ? e.rosterSnapshot.capturedRevision : null, recorded]);
    }
    if (page.size < EVENT_PAGE) break;
    last = page.docs[page.size - 1];
  }
  const result = reduceAttendance(inputs, teamId ? [teamId] : null);
  if (result.teams.length > REPORT_LIMITS.rows) throw new ReportTooLarge('Too many teams for one run. Choose one team.');
  const names = await teamNames(result.teams.map(row => row.teamId), orgId);
  return {
    summary: result.summary,
    rows: result.teams.map(row => ({ kind: 'team', label: names.get(row.teamId) ?? 'Unavailable team', ...row })),
    manifest: { ...manifest, participantRows, eventsCounted: result.summary.events.closed },
    sourceDigest: digest({ reportVersion: REPORT_VERSION, reducerVersion: REPORT_REDUCER_VERSION, filters: run.filters, interval: run.interval, parts }),
  };
}

/** Reservations at one organization facility. Event titles, teams and participants never enter the report. */
export async function facilitySource(run: Data): Promise<Built> {
  const { orgId, facilityId } = run;
  const startsAt = run.intervalStartsAt as string, endsAt = run.intervalEndsAt as string;
  const facilityDoc = db().doc(`organizations/${orgId}/facilities/${facilityId}`);
  const facility = (await facilityDoc.get()).data();
  if (!facility || facility.schemaVersion !== 2 || facility.orgId !== orgId) throw new SourceUnavailable('The facility is no longer available.');
  const manifest = { resourceReads: 0, availabilityReads: 0, closureReads: 0, eventReads: 0, bookingsInScope: 0 };
  const resourceRows = await facilityDoc.collection('resources').orderBy(FieldPath.documentId()).limit(REPORT_LIMITS.resources + 1).get();
  manifest.resourceReads = Math.max(resourceRows.size, 1);
  if (resourceRows.size > REPORT_LIMITS.resources) throw new ReportTooLarge('This facility has too many resources for one run.');
  const resources = resourceRows.docs.filter(doc => doc.data().schemaVersion === 2 && doc.data().orgId === orgId && doc.data().facilityId === facilityId);
  const closureRows = await db().collection(`organizations/${orgId}/closures`).where('facilityId', '==', facilityId).where('status', '==', 'applied')
    .where('endsAt', '>', startsAt).where('startsAt', '<', endsAt).limit(REPORT_LIMITS.closures + 1).get();
  manifest.closureReads = Math.max(closureRows.size, 1);
  if (closureRows.size > REPORT_LIMITS.closures) throw new ReportTooLarge('Too many closures overlap this range. Choose a shorter date range.');
  const closures = closureRows.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter((c: Data) => c.schemaVersion === 2 && c.orgId === orgId && Array.isArray(c.resourceIds));
  const inputs = new Map<string, ResourceInput>();
  const parts: Data = { resources: [], closures: closures.map((c: Data) => [c.id, c.revision ?? 0, c.startsAt, c.endsAt, [...c.resourceIds].sort()]), bookings: [] };
  for (const doc of resources) {
    // Every version that starts inside the interval, plus the one already in force at its start.
    const rows = await doc.ref.collection('availability').where('effectiveFrom', '<', endsAt).orderBy('effectiveFrom', 'desc')
      .limit(REPORT_LIMITS.availabilityVersions + 1).get();
    manifest.availabilityReads += Math.max(rows.size, 1);
    if (rows.size > REPORT_LIMITS.availabilityVersions) throw new ReportTooLarge('A resource has too many availability versions in this range. Choose a shorter date range.');
    const versions: AvailabilityVersion[] = [];
    for (const row of rows.docs) {
      const v = row.data();
      if (v.schemaVersion !== 2 || v.orgId !== orgId || !Array.isArray(v.windows)) continue;
      versions.push({ revision: v.revision, effectiveFrom: v.effectiveFrom, windows: v.windows });
      if (v.effectiveFrom <= startsAt) break;
    }
    versions.reverse();
    inputs.set(doc.id, { resourceId: doc.id, availability: versions, bookings: [],
      closures: closures.filter((c: Data) => c.resourceIds.includes(doc.id)).map((c: Data) => ({ startsAt: c.startsAt, endsAt: c.endsAt })) });
    parts.resources.push([doc.id, versions.map(v => [v.revision, v.effectiveFrom])]);
  }
  // Bookings are at most 24 hours plus setup and cleanup, so a booking overlapping the interval starts after this bound.
  const earliest = Timestamp.fromMillis(Date.parse(startsAt) - 27 * 3_600_000), end = Timestamp.fromDate(new Date(endsAt));
  const tx = reader();
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = db().collection('events').where('orgId', '==', orgId).where('facilityId', '==', facilityId)
      .where('startsAt', '>=', earliest).where('startsAt', '<', end).orderBy('startsAt').orderBy(FieldPath.documentId()).limit(EVENT_PAGE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    manifest.eventReads += Math.max(page.size, 1);
    scanned(manifest.eventReads);
    for (const doc of page.docs) {
      const e = doc.data();
      const resource = inputs.get(e.resourceId);
      if (e.schemaVersion !== 2 || e.orgId !== orgId || !resource || !(await publishedEvent(tx, e))) continue;
      const occupancy = { startsAt: iso(e.resourceOccupancy?.startsAt ?? e.startsAt)!, endsAt: iso(e.resourceOccupancy?.endsAt ?? e.endsAt)! };
      if (occupancy.endsAt <= startsAt) continue;
      manifest.bookingsInScope += 1;
      if (manifest.bookingsInScope > REPORT_LIMITS.events) throw new ReportTooLarge(`More than ${REPORT_LIMITS.events} reservations match. Choose a shorter date range.`);
      const booking: BookingInput = { eventId: doc.id, status: e.status, occupancy };
      resource.bookings.push(booking);
      parts.bookings.push([doc.id, e.revision ?? 0, e.status, e.resourceId, occupancy.startsAt, occupancy.endsAt]);
    }
    if (page.size < EVENT_PAGE) break;
    last = page.docs[page.size - 1];
  }
  const result = reduceFacility([...inputs.values()], { startsAt, endsAt });
  const labels = new Map(resources.map(doc => [doc.id, typeof doc.data().label === 'string' ? doc.data().label as string : 'Resource']));
  return {
    summary: result.summary,
    rows: result.resources.map(row => ({ kind: 'resource', label: labels.get(row.resourceId)!, ...row })),
    manifest,
    sourceDigest: digest({ reportVersion: REPORT_VERSION, reducerVersion: REPORT_REDUCER_VERSION, filters: run.filters, interval: run.interval, parts }),
  };
}

async function deleteAttemptRows(ref: FirebaseFirestore.DocumentReference, attempt: number) {
  for (;;) {
    const rows = await ref.collection('rows').where('attempt', '==', attempt).limit(400).get();
    if (rows.empty) return;
    const batch = db().batch();
    rows.docs.forEach(row => batch.delete(row.ref));
    await batch.commit();
  }
}

export type ReportOutcome = { state: 'complete' | 'failed' | 'busy' | 'missing' | 'discarded'; attempts: number; durationMs: number; manifest?: Record<string, number> };

/**
 * Leased, fenced build. Rows are written under the attempt number and become readable only when the same attempt
 * completes the run in a transaction, so a late or abandoned worker can neither publish partial rows nor delete the
 * rows of a completed run.
 */
export async function buildReport(orgId: string, runId: string,
  hooks: { beforeComplete?: (attempt: number) => Promise<void> } = {}): Promise<ReportOutcome> {
  const started = Date.now();
  const ref = runRef(orgId, runId);
  const done = (state: ReportOutcome['state'], attempts: number, manifest?: Record<string, number>) => ({ state, attempts, durationMs: Date.now() - started, manifest });
  for (;;) {
    const claim = await db().runTransaction(async tx => {
      const run = (await tx.get(ref)).data();
      if (!run || run.schemaVersion !== 2 || run.orgId !== orgId) return { state: 'missing' as const };
      if (run.state === 'complete' || run.state === 'failed') return { state: run.state as 'complete' | 'failed', attempts: run.attempts };
      const now = Timestamp.now();
      if (run.state === 'building' && run.leaseExpiresAt instanceof Timestamp && run.leaseExpiresAt.toMillis() > now.toMillis()) return { state: 'busy' as const, attempts: run.attempts };
      if (run.attempts >= MAX_ATTEMPTS) {
        tx.update(ref, { state: 'failed', failure: { code: 'REPORT_RETRIES_EXHAUSTED', message: 'This report could not be calculated after several attempts. Rebuild it to try again.' }, finishedAt: now, leaseExpiresAt: null });
        return { state: 'failed' as const, attempts: run.attempts };
      }
      const attempt = run.attempts + 1;
      tx.update(ref, { state: 'building', attempts: attempt, startedAt: now, leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS) });
      return { state: 'claimed' as const, attempt, run };
    });
    if (claim.state !== 'claimed') return done(claim.state, 'attempts' in claim ? claim.attempts : 0);
    const { attempt, run } = claim;
    let built: Built;
    try {
      built = run.kind === 'facility' ? await facilitySource(run) : await attendanceSource(run);
      for (let i = 0; i < built.rows.length; i += 200) {
        const batch = db().batch();
        built.rows.slice(i, i + 200).forEach((row, offset) => {
          batch.set(ref.collection('rows').doc(rowId(attempt, i + offset + 1)), { ...row, attempt, position: i + offset + 1 });
        });
        await batch.commit();
      }
      if (hooks.beforeComplete) await hooks.beforeComplete(attempt);
    } catch (error) {
      const permanent = error instanceof ReportTooLarge || error instanceof SourceUnavailable;
      const ended = await db().runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.state !== 'building' || current.attempts !== attempt) return 'discarded';
        const now = Timestamp.now();
        if (permanent || attempt >= MAX_ATTEMPTS) {
          tx.update(ref, { state: 'failed', finishedAt: now, leaseExpiresAt: null, failure: permanent
            ? { code: error instanceof ReportTooLarge ? 'REPORT_TOO_LARGE' : 'REPORT_SOURCE_UNAVAILABLE', message: (error as Error).message }
            : { code: 'REPORT_FAILED', message: 'This report could not be calculated. Rebuild it to try again.' } });
          return 'failed';
        }
        // Transient: requeue so this loop or reconciliation retries with a fresh read.
        tx.update(ref, { state: 'queued', queuedAt: now, leaseExpiresAt: null, lastError: error instanceof Error ? error.name : 'unknown' });
        return 'queued';
      });
      await deleteAttemptRows(ref, attempt).catch(() => {});
      if (ended === 'queued') continue;
      return done(ended === 'failed' ? 'failed' : 'discarded', attempt);
    }
    const finished = await db().runTransaction(async tx => {
      const previousRef = run.supersedes ? runRef(orgId, run.supersedes) : null;
      const [current, previous] = await Promise.all([tx.get(ref), previousRef ? tx.get(previousRef) : Promise.resolve(null)]);
      const row = current.data();
      if (row?.state !== 'building' || row.attempts !== attempt) return false;
      const now = Timestamp.now();
      // A source change seen after this attempt started may be missing from what it read.
      const changed = row.sourceChangedAt instanceof Timestamp && row.startedAt instanceof Timestamp && row.sourceChangedAt.toMillis() >= row.startedAt.toMillis();
      tx.update(ref, {
        state: 'complete', summary: built.summary, rowCount: built.rows.length, manifest: { ...built.manifest, durationMs: Date.now() - started },
        sourceDigest: built.sourceDigest, sourceCutoff: row.startedAt, completedAt: now, finishedAt: now, completedAttempt: attempt, leaseExpiresAt: null,
        ...(changed ? { stale: true, staleReason: 'sourceChangedDuringBuild', staleAt: now } : {}),
      });
      const old = previous?.data();
      if (previousRef && old?.state === 'complete') {
        const differs = old.sourceDigest !== built.sourceDigest;
        tx.update(previousRef, { supersededBy: runId, ...(differs ? (old.stale ? {} : { stale: true, staleReason: 'sourceChanged', staleAt: now }) : { verifiedBy: runId, verifiedAt: now }) });
      }
      return true;
    });
    if (!finished) {
      await deleteAttemptRows(ref, attempt).catch(() => {});
      return done('discarded', attempt);
    }
    // Rows of fenced-out earlier attempts are never served; remove them best effort.
    for (let earlier = 1; earlier < attempt; earlier++) await deleteAttemptRows(ref, earlier).catch(() => {});
    return done('complete', attempt, built.manifest);
  }
}

export const runReport = onDocumentCreated(
  { document: 'organizations/{orgId}/reportRuns/{runId}', timeoutSeconds: 540, memory: '512MiB' },
  async event => {
    await buildReport(event.params.orgId, event.params.runId);
  },
);

/** Requeued and abandoned runs, found across organizations so a crashed worker never leaves a run stuck. */
export async function reconcilePendingReports(limit = 25, olderThanMs = 60_000) {
  const now = Date.now();
  const [queued, abandoned] = await Promise.all([
    db().collectionGroup('reportRuns').where('state', '==', 'queued').where('queuedAt', '<=', Timestamp.fromMillis(now - olderThanMs)).orderBy('queuedAt').limit(limit).get(),
    db().collectionGroup('reportRuns').where('state', '==', 'building').where('leaseExpiresAt', '<=', Timestamp.fromMillis(now)).orderBy('leaseExpiresAt').limit(limit).get(),
  ]);
  let built = 0, failed = 0;
  for (const doc of [...queued.docs, ...abandoned.docs]) {
    const row = doc.data();
    if (row.schemaVersion !== 2 || doc.ref.parent.parent?.id !== row.orgId) continue;
    try {
      const outcome = await buildReport(row.orgId, doc.id);
      if (outcome.state === 'complete') built += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: queued.size + abandoned.size, built, failed };
}

export const reconcileReports = onSchedule({ schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  await reconcilePendingReports();
});

/**
 * Marks complete snapshots whose interval covers a changed source as stale, and flags runs still calculating so they
 * complete as stale if the change landed after they started reading. A change written before a run started reading is
 * already in it, so a delayed trigger never marks a fresh run stale. Snapshot figures are never edited.
 */
export async function markReportsStale(orgId: string, kind: 'attendance' | 'facility', from: string, to: string, matches: (run: Data) => boolean,
  reason: string, changedAt: Timestamp) {
  const rows = await db().collection(`organizations/${orgId}/reportRuns`).where('kind', '==', kind)
    .where('state', 'in', ['queued', 'building', 'complete']).where('stale', '==', false).where('intervalEndsAt', '>', from).limit(200).get();
  const now = Timestamp.now();
  let marked = 0;
  const batch = db().batch();
  for (const doc of rows.docs) {
    const run = doc.data();
    if (run.intervalStartsAt >= to || !matches(run)) continue;
    if (run.state === 'complete') {
      if (run.sourceCutoff instanceof Timestamp && changedAt.toMillis() < run.sourceCutoff.toMillis()) continue;
      batch.update(doc.ref, { stale: true, staleReason: reason, staleAt: now });
    } else {
      if (run.sourceChangedAt instanceof Timestamp && run.sourceChangedAt.toMillis() >= changedAt.toMillis()) continue;
      batch.update(doc.ref, { sourceChangedAt: changedAt });
    }
    marked += 1;
  }
  if (marked) await batch.commit();
  return marked;
}

/** Commit time of the source write. A delete has no snapshot time, so it uses the delivery time, which can only be later. */
function writtenAt(snapshot: { updateTime?: Timestamp } | undefined, time: string | undefined) {
  if (snapshot?.updateTime instanceof Timestamp) return snapshot.updateTime;
  return time && Number.isFinite(Date.parse(time)) ? Timestamp.fromDate(new Date(time)) : Timestamp.now();
}

async function eventChanged(event: Data, reason: string, changedAt: Timestamp) {
  if (event.schemaVersion !== 2 || typeof event.orgId !== 'string' || !(event.startsAt instanceof Timestamp)) return;
  const at = event.startsAt.toDate().toISOString();
  const after = new Date(event.startsAt.toMillis() + 1).toISOString();
  await markReportsStale(event.orgId, 'attendance', at, after, run => run.programId === event.programId && run.seasonId === event.seasonId
    && (run.teamId == null || (Array.isArray(event.teamIds) && event.teamIds.includes(run.teamId))), reason, changedAt);
  if (typeof event.facilityId === 'string') {
    const from = iso(event.resourceOccupancy?.startsAt ?? event.startsAt)!, to = iso(event.resourceOccupancy?.endsAt ?? event.endsAt) ?? after;
    await markReportsStale(event.orgId, 'facility', from, to, run => run.facilityId === event.facilityId, reason, changedAt);
  }
}

/**
 * Lifecycle changes (complete, cancel, postpone, reschedule, resource edits and closure postponements) each append one
 * schedule or resource history record, so these rare writes drive stale marking instead of every event document write.
 */
export const reportScheduleChanged = onDocumentCreated('events/{eventId}/scheduleHistory/{revision}', async event => {
  const history = event.data?.data();
  const row = (await db().doc(`events/${event.params.eventId}`).get()).data();
  if (!history || !row) return;
  const changedAt = writtenAt(event.data, event.time);
  await eventChanged(row, 'eventChanged', changedAt);
  if (history.previousStartsAt instanceof Timestamp && history.previousStartsAt.toMillis() !== row.startsAt?.toMillis?.()) {
    await eventChanged({ ...row, startsAt: history.previousStartsAt, endsAt: history.previousEndsAt ?? history.previousStartsAt, resourceOccupancy: null }, 'eventChanged', changedAt);
  }
});

export const reportResourceChanged = onDocumentCreated('events/{eventId}/resourceHistory/{revision}', async event => {
  const history = event.data?.data();
  const row = (await db().doc(`events/${event.params.eventId}`).get()).data();
  if (!history || !row || typeof history.previousFacilityId !== 'string' || !history.previousOccupancy) return;
  await eventChanged({ ...row, facilityId: history.previousFacilityId, resourceOccupancy: history.previousOccupancy }, 'eventChanged', writtenAt(event.data, event.time));
});

/** Attendance corrections after completion make covering attendance snapshots stale. */
export const reportAttendanceChanged = onDocumentWritten('events/{eventId}/attendance/{participantId}', async event => {
  const row = (await db().doc(`events/${event.params.eventId}`).get()).data();
  if (!row || row.status !== 'completed' || row.schemaVersion !== 2 || !(row.startsAt instanceof Timestamp)) return;
  const at = row.startsAt.toDate().toISOString(), after = new Date(row.startsAt.toMillis() + 1).toISOString();
  await markReportsStale(row.orgId, 'attendance', at, after, run => run.programId === row.programId && run.seasonId === row.seasonId
    && (run.teamId == null || (Array.isArray(row.teamIds) && row.teamIds.includes(run.teamId))), 'attendanceCorrected',
    writtenAt(event.data?.after.exists ? event.data.after : undefined, event.time));
});

/** Applying a closure writes one schedule operation; the closure itself is never edited afterwards. */
export const reportClosureChanged = onDocumentCreated('organizations/{orgId}/scheduleOperations/{operationId}', async event => {
  const operation = event.data?.data();
  if (operation?.action !== 'facilityClosure' || typeof operation.closureId !== 'string') return;
  const row = (await db().doc(`organizations/${event.params.orgId}/closures/${operation.closureId}`).get()).data();
  if (!row || typeof row.facilityId !== 'string' || typeof row.startsAt !== 'string' || typeof row.endsAt !== 'string') return;
  await markReportsStale(event.params.orgId, 'facility', row.startsAt, row.endsAt, run => run.facilityId === row.facilityId, 'closureChanged', writtenAt(event.data, event.time));
});

export const reportAvailabilityChanged = onDocumentCreated('organizations/{orgId}/facilities/{facilityId}/resources/{resourceId}/availability/{revision}', async event => {
  const row = event.data?.data();
  if (!row || typeof row.effectiveFrom !== 'string') return;
  await markReportsStale(event.params.orgId, 'facility', row.effectiveFrom, '9999-12-31T23:59:59.999Z', run => run.facilityId === event.params.facilityId, 'availabilityChanged', writtenAt(event.data, event.time));
});

function publicRun(run: Data) {
  return {
    runId: run.runId, kind: run.kind, state: run.state, filters: run.filters, interval: run.interval, reportVersion: run.reportVersion,
    reducerVersion: run.reducerVersion, formulas: run.formulas ?? [], requestedAt: run.requestedAt, completedAt: run.completedAt ?? null,
    sourceCutoff: run.sourceCutoff ?? null, sourceDigest: run.sourceDigest ?? null, stale: run.stale === true, staleReason: run.staleReason ?? null,
    supersedes: run.supersedes ?? null, supersededBy: run.supersededBy ?? null, failure: run.failure ?? null, attempts: run.attempts ?? 0,
    manifest: run.state === 'complete' ? run.manifest ?? null : null, summary: run.state === 'complete' ? run.summary ?? null : null,
    rowCount: run.state === 'complete' ? run.rowCount ?? 0 : 0,
  };
}

/** Rows are readable only for a complete run, and only those written by the attempt that completed it. */
export const getReportRun = readCommand(data => {
  keys(data, ['orgId', 'runId', 'cursor']);
  if (data.cursor != null && !/^\d{1,4}$/.test(String(data.cursor))) invalid('Invalid cursor.');
  return { orgId: id(data.orgId, 'orgId'), runId: id(data.runId, 'runId'), cursor: data.cursor == null ? null : Number(data.cursor) };
}, async (tx, data, uid) => {
  const run = await loadRun(tx, data.orgId, data.runId);
  await authorize(tx, data.orgId, uid, run.filters);
  if (run.state !== 'complete') return { run: publicRun(run), rows: [], nextCursor: null };
  const prefix = rowId(run.completedAttempt, 0).slice(0, 3);
  const rows = await tx.get(runRef(data.orgId, data.runId).collection('rows').orderBy(FieldPath.documentId())
    .startAfter(data.cursor != null ? rowId(run.completedAttempt, data.cursor) : prefix).endBefore(`${prefix.slice(0, 2)}.`).limit(ROW_PAGE));
  const items = rows.docs.map(doc => {
    const { attempt: _attempt, position: _position, ...row } = doc.data();
    return row;
  });
  const lastPosition = rows.docs.at(-1)?.data().position;
  return { run: publicRun(run), rows: items, nextCursor: rows.size === ROW_PAGE && lastPosition < run.rowCount ? String(lastPosition) : null };
});

/**
 * Administrators list every run; program staff list one held program; coaches list one team they coach.
 * Facility runs carry no program and appear only in the administrator listing.
 */
export const listReportRuns = readCommand(data => {
  keys(data, ['orgId', 'programId', 'teamId', 'cursor']);
  return { orgId: id(data.orgId, 'orgId'), programId: data.programId == null ? null : id(data.programId, 'programId'),
    teamId: data.teamId == null ? null : id(data.teamId, 'teamId'), cursor: data.cursor == null ? null : id(data.cursor, 'cursor') };
}, async (tx, data, uid) => {
  const org = (await tx.get(db().doc(`organizations/${data.orgId}`))).data();
  if (!org || org.schemaVersion !== 2 || org.features?.organizationV2 !== true) denied();
  if (org!.features?.reports !== true) throw new HttpsError('failed-precondition', 'Reports are not enabled for this organization.', { domainCode: 'REPORTS_DISABLED' });
  const staff = await staffOrNull(tx, data.orgId, uid);
  let query = db().collection(`organizations/${data.orgId}/reportRuns`) as FirebaseFirestore.Query;
  if (data.teamId) {
    const team = (await tx.get(db().doc(`teams/${data.teamId}`))).data();
    if (!team || team.schemaVersion !== 2 || team.orgId !== data.orgId) denied();
    if (!(staff && (staff.admin || staff.programIds.includes(team!.programId))) && !(await activeCoach(tx, data.orgId, data.teamId, uid))) denied();
    query = query.where('teamId', '==', data.teamId);
  } else if (data.programId) {
    if (!staff || (!staff.admin && !staff.programIds.includes(data.programId))) denied();
    query = query.where('programId', '==', data.programId);
  } else if (!staff?.admin) denied();
  query = query.orderBy('requestedAt', 'desc').limit(LIST_PAGE);
  if (data.cursor) {
    const cursor = await tx.get(runRef(data.orgId, data.cursor));
    if (!cursor.exists) invalid('Invalid cursor.');
    query = query.startAfter(cursor);
  }
  const rows = await tx.get(query);
  return { items: rows.docs.map(doc => publicRun(doc.data())), nextCursor: rows.size === LIST_PAGE ? rows.docs[rows.size - 1].id : null };
});
