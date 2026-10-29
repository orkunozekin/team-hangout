import { createHash } from 'crypto';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Data, id, invalid, keys } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { denied, requireProgram, staffScope } from '../operations/access';
import { teamViewer } from '../coaching/lineups';
import { computeStandings, FinalResultInput, STANDINGS_REDUCER_VERSION } from './standings';
import { MAX_FINAL_RESULTS } from './results';

const db = () => getFirestore();
export const STANDINGS_PAGE = 50;
const RESULT_PAGE = 500;
const ROW_BATCH = 200;
const MAX_ATTEMPTS = 3;
const LIST_LIMIT = 100;
/** Pending longer than this is shown as stale rather than updating. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
/** Builds run inside one function invocation (at most 300 s), so an older building generation was abandoned. */
const ABANDONED_AFTER_MS = 15 * 60 * 1000;
/** Complete generations kept readable so a viewer paging one table never mixes generations. */
const RETAINED_GENERATIONS = 3;

type Key = { sourceRevision: number; rulesVersion: number; teamsKey: string; createdAtMs: number };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const competitionRef = (orgId: string, competitionId: string) => db().doc(`organizations/${orgId}/competitions/${competitionId}`);
const rowId = (position: number) => String(position).padStart(4, '0');

/** Everything a generation depends on. Results are covered by sourceRevision, which every finalization and correction advances. */
export function standingsKey(competition: Data | undefined): Key | null {
  if (!competition || competition.schemaVersion !== 2 || !competition.activeRules || !competition.activeRulesVersion) return null;
  return {
    sourceRevision: competition.sourceRevision ?? 0,
    rulesVersion: competition.activeRulesVersion,
    teamsKey: digest([...competition.teamIds].sort()).slice(0, 16),
    // Distinguishes a recreated competition that reuses the ID and restarts its revisions.
    createdAtMs: competition.createdAt instanceof Timestamp ? competition.createdAt.toMillis() : 0,
  };
}

function sameKey(a: Partial<Key> | null | undefined, b: Key | null): boolean {
  return !!a && !!b && a.sourceRevision === b.sourceRevision && a.rulesVersion === b.rulesVersion
    && a.teamsKey === b.teamsKey && a.createdAtMs === b.createdAtMs;
}

async function deleteRows(generation: FirebaseFirestore.DocumentReference) {
  await db().recursiveDelete(generation.collection('rows'));
}

async function readFinals(competition: FirebaseFirestore.DocumentReference, generation: FirebaseFirestore.DocumentReference) {
  const finals: FinalResultInput[] = [];
  let reads = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = competition.collection('results').where('status', '==', 'final').orderBy(FieldPath.documentId()).limit(RESULT_PAGE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    reads += Math.max(page.size, 1);
    for (const doc of page.docs) {
      const row = doc.data();
      if (row.schemaVersion !== 2 || !row.final) continue;
      finals.push({
        eventId: doc.id, homeTeamId: row.homeTeamId, awayTeamId: row.awayTeamId,
        outcome: row.final.outcome, homeScore: row.final.homeScore, awayScore: row.final.awayScore,
        forfeitingTeamId: row.final.forfeitingTeamId, winnerTeamId: row.final.winnerTeamId, decider: row.final.decider,
      });
    }
    if (finals.length > MAX_FINAL_RESULTS) throw new Error('Final result guardrail exceeded.');
    // Checkpoint progress so an operator can see how far a build got.
    await generation.update({ 'checkpoint.resultsRead': finals.length, 'checkpoint.updatedAt': Timestamp.now() });
    if (page.size < RESULT_PAGE) break;
    last = page.docs[page.size - 1];
  }
  return { finals, reads };
}

/**
 * Marks a build failed and deletes its rows only while it is still building. A generation that a transaction already
 * made complete (or superseded) is never touched, so a late error cannot destroy a published table.
 */
async function failBuild(generation: FirebaseFirestore.DocumentReference, failure: string, startedBefore?: number) {
  const failed = await db().runTransaction(async tx => {
    const row = (await tx.get(generation)).data();
    if (row?.state !== 'building') return false;
    if (startedBefore !== undefined && !(row.startedAt instanceof Timestamp && row.startedAt.toMillis() <= startedBefore)) return false;
    tx.update(generation, { state: 'failed', failure, finishedAt: Timestamp.now() });
    return true;
  });
  if (failed) await deleteRows(generation);
}

/** Builds left `building` by a crashed worker, found across all competitions so cleanup never depends on a later rebuild. */
export async function sweepAbandonedBuilds(limit = 50) {
  const cutoff = Date.now() - ABANDONED_AFTER_MS;
  const stuck = await db().collectionGroup('generations').where('state', '==', 'building')
    .where('startedAt', '<=', Timestamp.fromMillis(cutoff)).orderBy('startedAt').limit(limit).get();
  let swept = 0;
  for (const doc of stuck.docs) {
    if (doc.ref.parent.parent?.parent.id !== 'competitions') continue;
    try {
      await failBuild(doc.ref, 'abandoned', cutoff);
      swept += 1;
    } catch {
      // Retried on the next scheduled run.
    }
  }
  return swept;
}

export type BuildOutcome = {
  state: 'activated' | 'current' | 'no-rules' | 'missing' | 'retrying';
  generationId: string | null;
  attempts: number;
  discarded: number;
  reads: number;
  durationMs: number;
};

/**
 * Rebuilds standings from canonical final results and activates the generation only if the competition still has
 * the same source revision, rules version and team set. Duplicate and out-of-order invocations converge on one active
 * complete generation; a source change during the build discards it and retries with the new source.
 */
export async function buildStandings(orgId: string, competitionId: string,
  hooks: { beforeActivate?: (generationId: string) => Promise<void> } = {}): Promise<BuildOutcome> {
  const started = Date.now();
  const ref = competitionRef(orgId, competitionId);
  const outcome: BuildOutcome = { state: 'retrying', generationId: null, attempts: 0, discarded: 0, reads: 0, durationMs: 0 };
  const done = (state: BuildOutcome['state'], generationId: string | null) => ({ ...outcome, state, generationId, durationMs: Date.now() - started });
  while (outcome.attempts < MAX_ATTEMPTS) {
    outcome.attempts += 1;
    const competition = (await ref.get()).data();
    outcome.reads += 1;
    if (!competition || competition.schemaVersion !== 2 || competition.orgId !== orgId) return done('missing', null);
    const key = standingsKey(competition);
    if (!key) return done('no-rules', null);
    if (sameKey(competition.activeGeneration, key)) {
      if (competition.standingsPendingSince != null) await clearPending(ref, key);
      return done('current', competition.activeGeneration.generationId);
    }
    const generation = ref.collection('generations').doc();
    await generation.create({
      schemaVersion: 2, orgId, competitionId, generationId: generation.id, state: 'building', ...key,
      reducerVersion: STANDINGS_REDUCER_VERSION, startedAt: Timestamp.now(), checkpoint: { resultsRead: 0, rowsWritten: 0 },
    });
    let activation: Awaited<ReturnType<typeof activate>>;
    try {
      const { finals, reads } = await readFinals(ref, generation);
      const teamIds = [...competition.teamIds as string[]].sort();
      const teams = await db().getAll(...teamIds.map(teamId => db().doc(`teams/${teamId}`)));
      outcome.reads += reads + teams.length;
      const names = new Map(teams.map(team => [team.id, typeof team.data()?.name === 'string' ? team.data()!.name as string : 'Unavailable team']));
      const table = computeStandings(teamIds, finals, competition.activeRules);
      for (let i = 0; i < table.rows.length; i += ROW_BATCH) {
        const batch = db().batch();
        for (const row of table.rows.slice(i, i + ROW_BATCH)) {
          batch.set(generation.collection('rows').doc(rowId(row.position)), { ...row, teamName: names.get(row.teamId) });
        }
        batch.update(generation, { 'checkpoint.rowsWritten': Math.min(i + ROW_BATCH, table.rows.length), 'checkpoint.updatedAt': Timestamp.now() });
        await batch.commit();
      }
      const inputDigest = digest({
        reducerVersion: STANDINGS_REDUCER_VERSION, rules: competition.activeRules, teamIds,
        results: [...finals].sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
      });
      const outputDigest = digest(table.rows);
      if (hooks.beforeActivate) await hooks.beforeActivate(generation.id);
      activation = await db().runTransaction(async tx => activate(tx, ref, generation, key, {
        rowCount: table.rows.length, countedResults: table.countedResults, unresolvedTies: table.unresolvedTies,
        inputDigest, outputDigest, sourceUpdatedAt: competition.sourceUpdatedAt ?? null,
        stats: { resultReads: reads, teamReads: teams.length, durationMs: Date.now() - started },
      }));
      if (activation.state !== 'activated') await deleteRows(generation);
    } catch (error) {
      // Never leave a partial build readable; the pending marker stays set so reconciliation retries.
      await failBuild(generation, error instanceof Error ? error.name : 'unknown').catch(() => {});
      throw error;
    }
    if (activation.state === 'activated') {
      // Cleanup after activation is best effort and outside the build's failure handling: the new table is published.
      for (const evicted of activation.evicted) await deleteRows(ref.collection('generations').doc(evicted)).catch(() => {});
      return done('activated', generation.id);
    }
    if (activation.state === 'duplicate') return done('current', activation.generationId);
    outcome.discarded += 1;
  }
  return done('retrying', null);
}

async function activate(tx: Transaction, ref: FirebaseFirestore.DocumentReference, generation: FirebaseFirestore.DocumentReference, key: Key, summary: Data) {
  const [current, built] = await tx.getAll(ref, generation);
  const competition = current.data();
  const now = Timestamp.now();
  if (built.data()?.state !== 'building') return { state: 'discarded' as const, evicted: [] as string[], generationId: null };
  if (!sameKey(standingsKey(competition), key)) {
    tx.update(generation, { state: 'superseded', finishedAt: now });
    return { state: 'discarded' as const, evicted: [], generationId: null };
  }
  if (sameKey(competition!.activeGeneration, key)) {
    // Another invocation already activated an identical build.
    tx.update(generation, { state: 'duplicate', finishedAt: now, duplicateOf: competition!.activeGeneration.generationId });
    return { state: 'duplicate' as const, evicted: [], generationId: competition!.activeGeneration.generationId as string };
  }
  const retained = [generation.id, ...((competition!.retainedGenerationIds ?? []) as string[])];
  const evicted = retained.slice(RETAINED_GENERATIONS);
  tx.update(generation, { ...summary, state: 'complete', completedAt: now, finishedAt: now });
  for (const generationId of evicted) {
    tx.set(ref.collection('generations').doc(generationId), { state: 'retired', retiredAt: now }, { merge: true });
  }
  tx.update(ref, {
    activeGeneration: {
      generationId: generation.id, ...key, completedAt: now, sourceUpdatedAt: summary.sourceUpdatedAt,
      rowCount: summary.rowCount, unresolvedTies: summary.unresolvedTies,
    },
    retainedGenerationIds: retained.slice(0, RETAINED_GENERATIONS),
    standingsPendingSince: null,
  });
  return { state: 'activated' as const, evicted, generationId: generation.id };
}

async function clearPending(ref: FirebaseFirestore.DocumentReference, key: Key) {
  await db().runTransaction(async tx => {
    const competition = (await tx.get(ref)).data();
    if (sameKey(competition?.activeGeneration, key) && sameKey(standingsKey(competition), key)) tx.update(ref, { standingsPendingSince: null });
  });
}

/** Rebuild on any competition write whose standings inputs differ from the active generation. */
export const rebuildStandings = onDocumentWritten(
  { document: 'organizations/{orgId}/competitions/{competitionId}', timeoutSeconds: 300, memory: '512MiB' },
  async event => {
    const after = event.data?.after.data();
    const key = standingsKey(after);
    if (!key || (sameKey(after!.activeGeneration, key) && after!.standingsPendingSince == null)) return;
    await buildStandings(event.params.orgId, event.params.competitionId);
  },
);

/** Reconciliation: competitions still pending after a missed or failed trigger are rebuilt, oldest first. */
export async function reconcilePendingStandings(limit = 25, olderThanMs = 60_000) {
  const cutoff = Timestamp.fromMillis(Date.now() - olderThanMs);
  const pending = await db().collectionGroup('competitions').where('standingsPendingSince', '<=', cutoff)
    .orderBy('standingsPendingSince').limit(limit).get();
  let rebuilt = 0;
  let failed = 0;
  for (const doc of pending.docs) {
    const row = doc.data();
    if (row.schemaVersion !== 2 || doc.ref.parent.parent?.id !== row.orgId) continue;
    try {
      const result = await buildStandings(row.orgId, doc.id);
      if (result.state === 'activated' || result.state === 'current') rebuilt += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: pending.size, rebuilt, failed, swept: await sweepAbandonedBuilds() };
}

export const reconcileStandings = onSchedule({ schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  await reconcilePendingStandings();
});

/** Read side. Viewers only ever see the active complete generation, or a retained one they are already paging. */
export function standingsStatus(competition: Data, nowMs = Date.now()): 'current' | 'updating' | 'stale' | 'unconfirmed' {
  const key = standingsKey(competition);
  if (!key) return 'unconfirmed';
  if (sameKey(competition.activeGeneration, key) && competition.standingsPendingSince == null) return 'current';
  const since = competition.standingsPendingSince ?? competition.sourceUpdatedAt ?? competition.updatedAt;
  const sinceMs = since instanceof Timestamp ? since.toMillis() : nowMs;
  return nowMs - sinceMs > STALE_AFTER_MS ? 'stale' : 'updating';
}

function changed(): never {
  throw new HttpsError('failed-precondition', 'Standings were updated. Reload to see the latest table.', { domainCode: 'STANDINGS_CHANGED' });
}

async function standingsView(tx: Transaction, competition: Data, generationId: string | null, cursor: string | null) {
  const status = standingsStatus(competition);
  const active = competition.activeGeneration;
  const base = {
    competitionId: competition.competitionId, name: competition.name, format: competition.format, status,
    sourceRevision: competition.sourceRevision ?? 0, sourceUpdatedAt: competition.sourceUpdatedAt ?? null,
  };
  if (!active) {
    if (generationId || cursor) changed();
    return { ...base, generation: null, rows: [], nextCursor: null };
  }
  const target = generationId ?? active.generationId;
  if (!((competition.retainedGenerationIds ?? []) as string[]).includes(target)) changed();
  const ref = competitionRef(competition.orgId, competition.competitionId).collection('generations').doc(target);
  let query = ref.collection('rows').orderBy(FieldPath.documentId()).limit(STANDINGS_PAGE);
  if (cursor) {
    if (!/^\d{4}$/.test(cursor)) invalid('Invalid cursor.');
    query = query.startAfter(cursor);
  }
  const [generation, rows] = await Promise.all([tx.get(ref), tx.get(query)]);
  const row = generation.data();
  if (!row || row.state !== 'complete') changed();
  return {
    ...base,
    generation: {
      generationId: target, active: target === active.generationId, sourceRevision: row!.sourceRevision, rulesVersion: row!.rulesVersion,
      completedAt: row!.completedAt, sourceUpdatedAt: row!.sourceUpdatedAt ?? null, rowCount: row!.rowCount,
      countedResults: row!.countedResults, unresolvedTies: row!.unresolvedTies, reducerVersion: row!.reducerVersion,
    },
    rows: rows.docs.map(doc => {
      const r = doc.data();
      return {
        position: r.position, rank: r.rank, teamId: r.teamId, teamName: r.teamName, played: r.played, wins: r.wins, draws: r.draws,
        losses: r.losses, forfeitWins: r.forfeitWins, forfeitLosses: r.forfeitLosses, scoresFor: r.scoresFor, scoresAgainst: r.scoresAgainst,
        differential: r.differential, points: r.points, sharedRank: r.sharedRank, tiedWith: r.tiedWith, decidedBy: r.decidedBy,
        notApplicable: r.notApplicable,
      };
    }),
    nextCursor: rows.size === STANDINGS_PAGE && rows.docs[rows.size - 1].data().position < row!.rowCount ? rows.docs[rows.size - 1].id : null,
  };
}

function pageArgs(data: Data) {
  // A generation is pinned only to continue paging the table already shown, never to browse older tables.
  if (data.generationId != null && data.cursor == null) invalid('A generation can only be pinned while paging.');
  return {
    generationId: data.generationId == null ? null : id(data.generationId, 'generationId'),
    cursor: data.cursor == null ? null : id(data.cursor, 'cursor'),
  };
}

async function loadCompetition(tx: Transaction, orgId: string, competitionId: string) {
  const competition = (await tx.get(competitionRef(orgId, competitionId))).data();
  if (!competition || competition.schemaVersion !== 2 || competition.orgId !== orgId) denied();
  return competition!;
}

/** Competition staff view of the active generation, including its update state. */
export const getStandings = readCommand(data => {
  keys(data, ['orgId', 'competitionId', 'generationId', 'cursor']);
  return { orgId: id(data.orgId, 'orgId'), competitionId: id(data.competitionId, 'competitionId'), ...pageArgs(data) };
}, async (tx, data, uid) => {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  requireProgram(await staffScope(tx, data.orgId, uid), competition.programId);
  return standingsView(tx, competition, data.generationId, data.cursor);
});

/**
 * Team viewer entry from a canonical event: active team members, scoped staff, or a household whose participant is
 * actively rostered on the team. Lists only competitions containing that team in its own program and season.
 */
export const getEventStandings = readCommand(data => {
  keys(data, ['eventId', 'teamId', 'participantId', 'competitionId', 'generationId', 'cursor']);
  return {
    eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId'),
    participantId: data.participantId == null ? null : id(data.participantId, 'participantId'),
    competitionId: data.competitionId == null ? null : id(data.competitionId, 'competitionId'),
    ...pageArgs(data),
  };
}, async (tx, data, uid) => {
  const team = await teamViewer(tx, data.eventId, data.teamId, data.participantId, uid);
  const snap = await tx.get(db().collection(`organizations/${team.orgId}/competitions`)
    .where('teamIds', 'array-contains', data.teamId).limit(LIST_LIMIT));
  const competitions = snap.docs.map(doc => doc.data()).filter(row => row.schemaVersion === 2 && row.orgId === team.orgId
    && row.programId === team.programId && row.seasonId === team.seasonId
    && (row.divisionId === null || row.divisionId === team.divisionId))
    .sort((a, b) => a.name.localeCompare(b.name) || a.competitionId.localeCompare(b.competitionId));
  const selected = data.competitionId ? competitions.find(row => row.competitionId === data.competitionId) : competitions[0];
  if (data.competitionId && !selected) denied();
  return {
    orgId: team.orgId, eventId: data.eventId, teamId: data.teamId,
    competitions: competitions.map(row => ({ competitionId: row.competitionId, name: row.name, status: standingsStatus(row) })),
    standings: selected ? await standingsView(tx, selected, data.generationId, data.cursor) : null,
  };
});
