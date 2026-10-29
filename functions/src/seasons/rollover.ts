import { createHash } from 'crypto';
import { FieldValue, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { command, Data, id, invalid, keys, object, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { denied, hierarchy, staffScope } from '../operations/access';
import { audit } from '../organizations/commands';
import { accountAvailable } from '../accountAccess';

const db = () => getFirestore();
/** Preview contract version; part of every preview hash. */
export const ROLLOVER_VERSION = 1;
/** Engineering guardrails, revisited after measurements. Larger seasons are rejected with a split instruction. */
export const ROLLOVER_LIMITS = { teams: 1000, divisions: 100, chunk: 100 };
const MAX_ATTEMPTS = 3;
/** A run stays inside one invocation (at most 540 s); an older lease was abandoned. */
const LEASE_MS = 10 * 60 * 1000;
const LIST_PAGE = 20;
/** Configuration only. Everything else stays with the source season and is never copied. */
export const ROLLOVER_NOT_COPIED = [
  'staffAssignments', 'teamEnrollments', 'guardianLinks', 'invitations', 'messages', 'events', 'attendance',
  'lineups', 'results', 'competitions', 'volunteers', 'rides', 'waivers', 'payments', 'reports',
];

class RolloverStop extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RolloverStop'; }
}
class Fenced extends Error {}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobRef = (orgId: string, jobId: string) => db().doc(`organizations/${orgId}/rolloverJobs/${jobId}`);
const chunkId = (index: number) => String(index).padStart(3, '0');
/** Deterministic per job and source, so a retried chunk finds the target it already wrote. */
const targetId = (jobId: string, kind: string, sourceId: string) => `${kind}${digest([jobId, kind, sourceId]).slice(0, 23)}`;
const rejected = (code: string, message: string): never => { throw new HttpsError('failed-precondition', message, { domainCode: code }); };

function localDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(`Invalid ${field}.`);
  return value as string;
}
function normalize(data: Data) {
  const target = object(data.target); keys(target, ['name', 'startsOn', 'endsOn']);
  const startsOn = localDate(target.startsOn, 'startsOn'); const endsOn = localDate(target.endsOn, 'endsOn');
  if (endsOn < startsOn) invalid('endsOn must follow startsOn.');
  const excluded = data.excludedTeamIds ?? [];
  if (!Array.isArray(excluded) || excluded.length > ROLLOVER_LIMITS.teams) invalid('Invalid excludedTeamIds.');
  const excludedTeamIds = excluded.map((value: unknown) => id(value, 'excludedTeamIds')).sort();
  if (new Set(excludedTeamIds).size !== excludedTeamIds.length) invalid('Invalid excludedTeamIds.');
  return { orgId: id(data.orgId, 'orgId'), sourceSeasonId: id(data.sourceSeasonId, 'sourceSeasonId'),
    target: { name: text(target.name, 'name'), startsOn, endsOn }, excludedTeamIds };
}

/** rollover.manage: an active organization administrator, read from the canonical grant on every call and chunk. */
async function rolloverScope(tx: Transaction, orgId: string, uid: string) {
  const org = (await tx.get(db().doc(`organizations/${orgId}`))).data();
  if (!org || org.schemaVersion !== 2 || org.features?.organizationV2 !== true) denied();
  const scope = await staffScope(tx, orgId, uid);
  if (!scope.admin) denied();
  if (org!.features?.rollover !== true) rejected('ROLLOVER_DISABLED', 'Season rollover is not enabled for this organization.');
  return org!;
}

type Preview = Awaited<ReturnType<typeof readSource>>;
/** Reads selected source revisions. Archived sources stay readable; nothing here writes. */
async function readSource(tx: Transaction, input: ReturnType<typeof normalize>) {
  const { orgId, sourceSeasonId } = input;
  const season = (await tx.get(db().doc(`organizations/${orgId}/seasons/${sourceSeasonId}`))).data();
  if (!season || season.schemaVersion !== 2 || season.orgId !== orgId) denied();
  if (season!.rolloverState === 'building') rejected('ROLLOVER_IN_PROGRESS', 'This season is still being created by a rollover.');
  const programId = season!.programId as string;
  const { program } = await hierarchy(tx, orgId, programId, sourceSeasonId, undefined, false);
  const [divisionDocs, teamDocs] = await Promise.all([
    tx.get(db().collection(`organizations/${orgId}/divisions`).where('seasonId', '==', sourceSeasonId).limit(ROLLOVER_LIMITS.divisions + 1)),
    tx.get(db().collection('teams').where('orgId', '==', orgId).where('seasonId', '==', sourceSeasonId).limit(ROLLOVER_LIMITS.teams + 1)),
  ]);
  if (divisionDocs.size > ROLLOVER_LIMITS.divisions || teamDocs.size > ROLLOVER_LIMITS.teams) {
    throw new HttpsError('resource-exhausted', `Rollover supports up to ${ROLLOVER_LIMITS.teams} teams and ${ROLLOVER_LIMITS.divisions} divisions. Split the season into smaller seasons first.`, { domainCode: 'ROLLOVER_TOO_LARGE' });
  }
  const divisions = divisionDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Data)
    .filter(row => row.schemaVersion === 2 && row.orgId === orgId && row.programId === programId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(row => ({ id: row.id, name: row.name, ageBandLabel: row.ageBandLabel ?? null, status: row.status, revision: row.revision ?? 0,
      included: row.status !== 'archived', reason: row.status === 'archived' ? 'archived' : null }));
  const copied = new Set(divisions.filter(row => row.included).map(row => row.id));
  const known = new Set(divisions.map(row => row.id));
  const teams = teamDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Data)
    .filter(row => row.schemaVersion === 2 && row.programId === programId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(row => {
      const reason = row.status === 'archived' ? 'archived' : !known.has(row.divisionId) ? 'divisionMissing'
        : !copied.has(row.divisionId) ? 'divisionArchived' : input.excludedTeamIds.includes(row.id) ? 'deselected' : null;
      return { id: row.id, name: row.name, divisionId: row.divisionId ?? null, externalId: row.externalId ?? null, status: row.status,
        revision: row.revision ?? 0, included: reason === null, reason };
    });
  const teamIds = new Set(teams.map(row => row.id));
  if (input.excludedTeamIds.some((teamId: string) => !teamIds.has(teamId))) invalid('Excluded teams must belong to the source season.');
  // The hash covers every selected source revision and the requested target, so any change invalidates the preview.
  const previewHash = digest({
    version: ROLLOVER_VERSION, orgId, target: input.target, excludedTeamIds: input.excludedTeamIds,
    season: [sourceSeasonId, season!.revision ?? 0, season!.status], program: [programId, program.revision ?? 0, program.status],
    divisions: divisions.map(row => [row.id, row.revision, row.status]),
    teams: teams.map(row => [row.id, row.revision, row.status, row.divisionId]),
  });
  return {
    previewHash, programId, sport: program.sportCode ?? null,
    source: { seasonId: sourceSeasonId, name: season!.name, status: season!.status, programId, programName: program.name, programStatus: program.status },
    target: input.target, divisions, teams,
    counts: {
      divisions: divisions.filter(row => row.included).length, excludedDivisions: divisions.filter(row => !row.included).length,
      teams: teams.filter(row => row.included).length, excludedTeams: teams.filter(row => !row.included).length,
    },
    notCopied: ROLLOVER_NOT_COPIED,
  };
}

function publicJob(job: Data) {
  return {
    jobId: job.jobId, state: job.state, sourceSeasonId: job.sourceSeasonId, programId: job.programId, targetSeasonId: job.targetSeasonId,
    target: job.target, previewHash: job.previewHash, counts: job.counts, created: job.created, chunkCount: job.chunkCount,
    completedChunks: job.nextChunk, attempts: job.attempts, failure: job.failure ?? null, createdAt: job.createdAt,
    completedAt: job.completedAt ?? null, revision: job.revision,
  };
}

export const previewRollover = readCommand(data => {
  keys(data, ['orgId', 'sourceSeasonId', 'target', 'excludedTeamIds']);
  return normalize(data);
}, async (tx, input, uid) => {
  await rolloverScope(tx, input.orgId, uid);
  return readSource(tx, input as ReturnType<typeof normalize>);
});

/** Recomputes the preview in the commit transaction; a changed source or target never commits a stale selection. */
export const commitRollover = command('commitRollover', data => {
  keys(data, ['requestId', 'orgId', 'sourceSeasonId', 'target', 'excludedTeamIds', 'previewHash']);
  if (typeof data.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.previewHash)) invalid('Invalid previewHash.');
  return { ...normalize(data), previewHash: data.previewHash };
}, async (tx, input, uid, _actor, replay) => {
  await rolloverScope(tx, input.orgId, uid);
  if (replay) return replay;
  const preview: Preview = await readSource(tx, input as ReturnType<typeof normalize>);
  if (preview.previewHash !== input.previewHash) {
    rejected('ROLLOVER_PREVIEW_CHANGED', 'The source season changed since this preview. Preview again before committing.');
  }
  // The target is created in the source program, which must be writable.
  await hierarchy(tx, input.orgId, preview.programId, undefined, undefined, true);
  if (!preview.counts.teams) invalid('Select at least one team to roll over.');
  const { orgId } = input;
  const jobId = `j${digest([orgId, input.sourceSeasonId, input.previewHash]).slice(0, 23)}`;
  const ref = jobRef(orgId, jobId);
  // The same preview always maps to one job, so a retry with a new request ID cannot duplicate the season.
  const existing = (await tx.get(ref)).data();
  if (existing) return { job: publicJob(existing) };
  const targetSeasonId = targetId(jobId, 's', input.sourceSeasonId);
  const seasonRef = db().doc(`organizations/${orgId}/seasons/${targetSeasonId}`);
  if ((await tx.get(seasonRef)).exists) rejected('ROLLOVER_TARGET_CONFLICT', 'The target season already exists.');
  const divisionTargets = new Map(preview.divisions.filter(row => row.included).map(row => [row.id, targetId(jobId, 'd', row.id)]));
  const items: Data[] = [
    ...preview.divisions.filter(row => row.included).map(row => ({ kind: 'division', sourceId: row.id, sourceRevision: row.revision,
      targetId: divisionTargets.get(row.id), name: row.name, ageBandLabel: row.ageBandLabel })),
    ...preview.teams.filter(row => row.included).map(row => ({ kind: 'team', sourceId: row.id, sourceRevision: row.revision,
      targetId: targetId(jobId, 't', row.id), targetDivisionId: divisionTargets.get(row.divisionId), name: row.name, externalId: row.externalId })),
  ];
  const now = Timestamp.now();
  const owner = { schemaVersion: 2, revision: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now };
  // A partial target stays draft and hidden from listings and writes until the job completes.
  tx.create(seasonRef, { ...owner, orgId, programId: preview.programId, name: input.target.name, startsOn: input.target.startsOn,
    endsOn: input.target.endsOn, status: 'draft', previousSeasonId: input.sourceSeasonId, rolloverJobId: jobId, rolloverState: 'building' });
  const chunkCount = Math.ceil(items.length / ROLLOVER_LIMITS.chunk);
  for (let index = 0; index < chunkCount; index++) {
    tx.create(ref.collection('chunks').doc(chunkId(index)), { schemaVersion: 2, orgId, jobId, index, state: 'pending', completedAt: null,
      items: items.slice(index * ROLLOVER_LIMITS.chunk, (index + 1) * ROLLOVER_LIMITS.chunk) });
  }
  const job = {
    ...owner, orgId, jobId, programId: preview.programId, sport: preview.sport, sourceSeasonId: input.sourceSeasonId, targetSeasonId,
    target: input.target, previewHash: input.previewHash, excludedTeamIds: input.excludedTeamIds, counts: preview.counts,
    created: { divisions: 0, teams: 0 }, chunkCount, nextChunk: 0, state: 'queued', attempts: 0, actorUid: uid, initiatedBy: uid,
    queuedAt: now, startedAt: null, leaseExpiresAt: null, failure: null, completedAt: null,
  };
  tx.create(ref, job);
  audit(tx, orgId, uid, 'commitRollover', jobId, 1);
  return { job: publicJob(job) };
});

/** A failed job resumes from its checkpoint under the caller's live grant. Completed chunks are never rewritten. */
export const resumeRollover = command('resumeRollover', data => {
  keys(data, ['requestId', 'orgId', 'jobId']);
  return { orgId: id(data.orgId, 'orgId'), jobId: id(data.jobId, 'jobId') };
}, async (tx, input, uid, _actor, replay) => {
  await rolloverScope(tx, input.orgId, uid);
  const ref = jobRef(input.orgId, input.jobId);
  const job = (await tx.get(ref)).data();
  if (!job || job.schemaVersion !== 2 || job.orgId !== input.orgId) denied();
  if (replay) return replay;
  if (job!.state !== 'failed') rejected('ROLLOVER_NOT_FAILED', 'Only a failed rollover can be resumed.');
  await hierarchy(tx, input.orgId, job!.programId, undefined, undefined, true);
  const now = Timestamp.now();
  const next = { ...job, state: 'queued', attempts: 0, actorUid: uid, failure: null, queuedAt: now, leaseExpiresAt: null,
    revision: job!.revision + 1, updatedBy: uid, updatedAt: now };
  tx.set(ref, next);
  audit(tx, input.orgId, uid, 'resumeRollover', input.jobId, next.revision);
  return { job: publicJob(next) };
});

export const listRolloverJobs = readCommand(data => {
  keys(data, ['orgId', 'cursor']);
  return { orgId: id(data.orgId, 'orgId'), cursor: data.cursor == null ? null : id(data.cursor, 'cursor') };
}, async (tx, input, uid) => {
  await rolloverScope(tx, input.orgId, uid);
  let query = db().collection(`organizations/${input.orgId}/rolloverJobs`).orderBy('createdAt', 'desc').limit(LIST_PAGE);
  if (input.cursor) {
    const cursor = await tx.get(jobRef(input.orgId, input.cursor));
    if (!cursor.exists) invalid('Invalid cursor.');
    query = query.startAfter(cursor);
  }
  const rows = await tx.get(query);
  return { items: rows.docs.map(doc => publicJob(doc.data())), nextCursor: rows.size === LIST_PAGE ? rows.docs[rows.size - 1].id : null };
});

/** The worker acts for the job's current actor, so a revoked grant or disabled feature stops it at the next chunk. */
async function actorStillAllowed(tx: Transaction, job: Data) {
  // An account being deleted loses access at once, before its organization grant is cleaned up.
  const available = await accountAvailable(tx, job.actorUid).then(() => true, () => false);
  const [org, member, program] = await tx.getAll(db().doc(`organizations/${job.orgId}`),
    db().doc(`organizations/${job.orgId}/members/${job.actorUid}`), db().doc(`organizations/${job.orgId}/programs/${job.programId}`));
  const grant = member.data();
  if (!available || org.data()?.features?.rollover !== true || org.data()?.features?.organizationV2 !== true || grant?.status !== 'active'
    || grant.orgId !== job.orgId || !Array.isArray(grant.roles) || !grant.roles.includes('orgAdmin')) {
    throw new RolloverStop('ROLLOVER_ACCESS_REVOKED', 'The administrator who started this rollover no longer has access. Another administrator can resume it.');
  }
  if (org.data()?.status === 'archived' || program.data()?.status === 'archived' || program.data()?.orgId !== job.orgId) {
    throw new RolloverStop('ROLLOVER_HIERARCHY_ARCHIVED', 'Restore the program before resuming this rollover.');
  }
}

function targetDoc(job: Data, item: Data, now: Timestamp): Data {
  const base = { schemaVersion: 2, revision: 1, orgId: job.orgId, programId: job.programId, seasonId: job.targetSeasonId, status: 'active',
    name: item.name, rolloverJobId: job.jobId, createdBy: job.actorUid, createdAt: now, updatedBy: job.actorUid, updatedAt: now };
  if (item.kind === 'division') return { ...base, ageBandLabel: item.ageBandLabel ?? null, previousDivisionId: item.sourceId };
  // Fresh team: no roster, staff, invitation code, events or messages carry over.
  return { ...base, divisionId: item.targetDivisionId, externalId: item.externalId ?? null, sport: job.sport ?? null, inviteCode: null, previousTeamId: item.sourceId };
}

/** One chunk per transaction: either every target in it and the checkpoint commit together, or none do. */
async function applyChunk(orgId: string, jobId: string, attempt: number, index: number) {
  const ref = jobRef(orgId, jobId);
  return db().runTransaction(async tx => {
    const job = (await tx.get(ref)).data();
    if (!job || job.state !== 'running' || job.attempts !== attempt || job.nextChunk !== index) throw new Fenced();
    await actorStillAllowed(tx, job);
    const chunkRef = ref.collection('chunks').doc(chunkId(index));
    const chunk = (await tx.get(chunkRef)).data();
    if (!chunk || chunk.jobId !== jobId) throw new RolloverStop('ROLLOVER_FAILED', 'A rollover checkpoint is missing.');
    const targets: FirebaseFirestore.DocumentReference[] = chunk.items.map((item: Data) => item.kind === 'division'
      ? db().doc(`organizations/${orgId}/divisions/${item.targetId}`) : db().doc(`teams/${item.targetId}`));
    const existing = targets.length ? await tx.getAll(...targets) : [];
    const now = Timestamp.now();
    const created = { divisions: 0, teams: 0 };
    if (chunk.state !== 'done') {
      chunk.items.forEach((item: Data, position: number) => {
        const current = existing[position].data();
        if (current && current.rolloverJobId !== jobId) throw new RolloverStop('ROLLOVER_TARGET_CONFLICT', 'A rollover target already exists.');
        if (!current) tx.create(targets[position], targetDoc(job, item, now));
        created[item.kind === 'division' ? 'divisions' : 'teams'] += 1;
      });
      tx.update(chunkRef, { state: 'done', completedAt: now });
    }
    tx.update(ref, { nextChunk: index + 1, 'created.divisions': FieldValue.increment(created.divisions),
      'created.teams': FieldValue.increment(created.teams), leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS) });
  });
}

/** Counts must reconcile with what the target season holds before it leaves the hidden building state. */
async function finish(orgId: string, jobId: string, attempt: number) {
  const ref = jobRef(orgId, jobId);
  const job = (await ref.get()).data()!;
  const [teams, divisions] = await Promise.all([
    db().collection('teams').where('seasonId', '==', job.targetSeasonId).count().get(),
    db().collection(`organizations/${orgId}/divisions`).where('seasonId', '==', job.targetSeasonId).count().get(),
  ]);
  return db().runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current || current.state !== 'running' || current.attempts !== attempt) throw new Fenced();
    await actorStillAllowed(tx, current);
    const seasonRef = db().doc(`organizations/${orgId}/seasons/${current.targetSeasonId}`);
    const season = (await tx.get(seasonRef)).data();
    const counted = { teams: teams.data().count, divisions: divisions.data().count };
    if (!season || season.rolloverJobId !== jobId || current.created.teams !== current.counts.teams || current.created.divisions !== current.counts.divisions
      || counted.teams !== current.counts.teams || counted.divisions !== current.counts.divisions) {
      throw new RolloverStop('ROLLOVER_COUNT_MISMATCH', 'The new season does not match the preview counts. Resume to recheck it.');
    }
    const now = Timestamp.now();
    tx.update(seasonRef, { rolloverState: 'complete', revision: season.revision + 1, updatedAt: now, updatedBy: current.actorUid });
    tx.update(ref, { state: 'complete', completedAt: now, leaseExpiresAt: null, reconciled: counted, revision: current.revision + 1, updatedAt: now });
    audit(tx, orgId, current.actorUid, 'completeRollover', jobId, current.revision + 1);
  });
}

export type RolloverOutcome = { state: 'complete' | 'failed' | 'busy' | 'missing' | 'discarded'; attempts: number; chunks: number };

/**
 * Claims the job with a lease and applies chunks from its checkpoint. A crash leaves the lease to expire, and the next
 * claim resumes at the next pending chunk. `afterChunk` runs outside failure handling so tests can simulate a crash.
 */
export async function runRolloverJob(orgId: string, jobId: string,
  hooks: { afterChunk?: (index: number) => Promise<void> } = {}): Promise<RolloverOutcome> {
  const ref = jobRef(orgId, jobId);
  let chunks = 0;
  for (;;) {
    const claim = await db().runTransaction(async tx => {
      const job = (await tx.get(ref)).data();
      if (!job || job.schemaVersion !== 2 || job.orgId !== orgId) return { state: 'missing' as const, attempts: 0 };
      if (job.state === 'complete' || job.state === 'failed') return { state: job.state as 'complete' | 'failed', attempts: job.attempts };
      const now = Timestamp.now();
      if (job.state === 'running' && job.leaseExpiresAt instanceof Timestamp && job.leaseExpiresAt.toMillis() > now.toMillis()) {
        return { state: 'busy' as const, attempts: job.attempts };
      }
      if (job.attempts >= MAX_ATTEMPTS) {
        tx.update(ref, { state: 'failed', failedAt: now, leaseExpiresAt: null, failure: { code: 'ROLLOVER_RETRIES_EXHAUSTED', message: 'This rollover stopped after several attempts. Resume it to continue.' } });
        return { state: 'failed' as const, attempts: job.attempts };
      }
      const attempt = job.attempts + 1;
      tx.update(ref, { state: 'running', attempts: attempt, startedAt: job.startedAt ?? now, leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS) });
      return { state: 'claimed' as const, attempts: attempt, job };
    });
    if (claim.state !== 'claimed') return { state: claim.state, attempts: claim.attempts, chunks };
    const attempt = claim.attempts;
    let index = claim.job.nextChunk as number;
    let failed: unknown = null;
    for (; index < claim.job.chunkCount && !failed; index++) {
      try {
        await applyChunk(orgId, jobId, attempt, index);
        chunks += 1;
      } catch (error) {
        failed = error;
        break;
      }
      if (hooks.afterChunk) await hooks.afterChunk(index);
    }
    if (!failed) {
      try {
        await finish(orgId, jobId, attempt);
        return { state: 'complete', attempts: attempt, chunks };
      } catch (error) {
        failed = error;
      }
    }
    if (failed instanceof Fenced) return { state: 'discarded', attempts: attempt, chunks };
    const ended = await db().runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.state !== 'running' || current.attempts !== attempt) return 'discarded' as const;
      if (failed instanceof RolloverStop || attempt >= MAX_ATTEMPTS) {
        tx.update(ref, { state: 'failed', failedAt: Timestamp.now(), leaseExpiresAt: null, failure: failed instanceof RolloverStop
          ? { code: failed.code, message: failed.message }
          : { code: 'ROLLOVER_FAILED', message: 'This rollover could not continue. Resume it to retry from the last checkpoint.' } });
        return 'failed' as const;
      }
      // Transient: requeue so this loop or reconciliation resumes from the checkpoint.
      tx.update(ref, { state: 'queued', queuedAt: Timestamp.now(), leaseExpiresAt: null, lastError: failed instanceof Error ? failed.name : 'unknown' });
      return 'queued' as const;
    });
    if (ended !== 'queued') return { state: ended, attempts: attempt, chunks };
  }
}

/** Runs on commit and on resume; worker requeues are left to its own loop and reconciliation. */
export const runRollover = onDocumentWritten(
  { document: 'organizations/{orgId}/rolloverJobs/{jobId}', timeoutSeconds: 540, memory: '512MiB' },
  async event => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (after?.state !== 'queued' || (before && before.state !== 'failed')) return;
    await runRolloverJob(event.params.orgId, event.params.jobId);
  },
);

/** Queued and abandoned jobs, found across organizations so a crashed worker never leaves a season half built. */
export async function reconcilePendingRollovers(limit = 25, olderThanMs = 60_000) {
  const now = Date.now();
  const [queued, abandoned] = await Promise.all([
    db().collectionGroup('rolloverJobs').where('state', '==', 'queued').where('queuedAt', '<=', Timestamp.fromMillis(now - olderThanMs)).orderBy('queuedAt').limit(limit).get(),
    db().collectionGroup('rolloverJobs').where('state', '==', 'running').where('leaseExpiresAt', '<=', Timestamp.fromMillis(now)).orderBy('leaseExpiresAt').limit(limit).get(),
  ]);
  let completed = 0, failed = 0;
  for (const doc of [...queued.docs, ...abandoned.docs]) {
    const row = doc.data();
    if (row.schemaVersion !== 2 || doc.ref.parent.parent?.id !== row.orgId) continue;
    try {
      if ((await runRolloverJob(row.orgId, doc.id)).state === 'complete') completed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: queued.size + abandoned.size, completed, failed };
}

export const reconcileRollovers = onSchedule({ schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  await reconcilePendingRollovers();
});
