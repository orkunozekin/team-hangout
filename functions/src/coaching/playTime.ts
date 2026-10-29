import { getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied } from '../operations/access';
import { coachingEvent, envelope, referenced, rosterFor, unavailable } from './lineups';
import {
  applyPlayAction, initialLedger, LedgerState, ledgerTotals, MAX_PERIODS, MAX_PLAY_ACTIONS, PlayAction, PlayActionKind,
  PlayLedgerError, replayPlayLedger, replayWithCorrection,
} from './playLedger';

const db = () => getFirestore();
const REASON_MAX = 500;
const RECENT_ACTIONS = 50;
const KINDS: PlayActionKind[] = ['start', 'pause', 'resume', 'substitute', 'switchUnit', 'endPeriod', 'correct'];
const FIELDS: Partial<Record<PlayActionKind, string[]>> = {
  start: ['periodCount'],
  substitute: ['unitId', 'outParticipantId', 'inParticipantId'],
  switchUnit: ['unitId'],
  correct: ['targetSequence', 'atElapsedMs', 'outParticipantId', 'inParticipantId', 'reason'],
};

function ledgerFailure(error: unknown): never {
  if (error instanceof PlayLedgerError) {
    throw new HttpsError(error.code === 'INVALID_ACTION' ? 'invalid-argument' : 'failed-precondition', error.message, { domainCode: error.code });
  }
  throw error;
}

function finalized(): never {
  throw new HttpsError('failed-precondition', 'This playing-time record is final.', { domainCode: 'SESSION_FINALIZED' });
}

/** Exported for pure tests. The server stamps game time; clients never supply a clock reading except for a backdated correction. */
export function normalizePlayAction(data: Data) {
  const { payload, base } = envelope(data, ['teamId', 'kind', 'periodCount', 'unitId', 'outParticipantId', 'inParticipantId', 'targetSequence', 'atElapsedMs', 'reason']);
  const kind = payload.kind as PlayActionKind;
  if (!KINDS.includes(kind)) invalid('Unsupported playing-time action.');
  keys(payload, ['teamId', 'kind', ...(FIELDS[kind] ?? [])]);
  const action: Data = { ...base, kind };
  if (kind === 'start' && payload.periodCount !== undefined) {
    if (!Number.isSafeInteger(payload.periodCount) || payload.periodCount < 1 || payload.periodCount > MAX_PERIODS) invalid(`Choose 1 to ${MAX_PERIODS} periods.`);
    action.periodCount = payload.periodCount;
  }
  if (kind === 'substitute' || kind === 'switchUnit') action.unitId = id(payload.unitId, 'unitId');
  if (kind === 'substitute' || kind === 'correct') {
    action.outParticipantId = id(payload.outParticipantId, 'participantId');
    action.inParticipantId = id(payload.inParticipantId, 'participantId');
    if (action.outParticipantId === action.inParticipantId) invalid('Choose two different participants.');
  }
  if (kind === 'correct') {
    if (!Number.isSafeInteger(payload.targetSequence) || payload.targetSequence < 1) invalid('Choose the substitution to correct.');
    if (!Number.isSafeInteger(payload.atElapsedMs) || payload.atElapsedMs < 0) invalid('Invalid corrected game time.');
    if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.trim().length > REASON_MAX) {
      invalid(`Corrections need a reason of at most ${REASON_MAX} characters.`);
    }
    Object.assign(action, { targetSequence: payload.targetSequence, atElapsedMs: payload.atElapsedMs, reason: payload.reason.trim() });
  }
  return action;
}

/** Live game-elapsed time from the last acknowledged anchor. No background timer writes. */
function elapsedNow(session: Data | undefined, ledger: LedgerState, now: Timestamp): number {
  if (!session || ledger.status !== 'running' || !session.anchorAt) return ledger.elapsedMs;
  return Math.max(ledger.elapsedMs, session.anchorElapsedMs + now.toMillis() - (session.anchorAt as Timestamp).toMillis());
}

/** Current active roster membership only; a departed participant cannot enter. Historic corrections need a roster record. */
async function rosterParticipant(tx: Transaction, orgId: string, teamId: string, participantId: string, requireActive: boolean) {
  const [roster, person] = await tx.getAll(
    db().doc(`teams/${teamId}/roster/${participantId}`),
    db().doc(`organizations/${orgId}/participants/${participantId}`),
  );
  const row = roster.data();
  const p = person.data();
  const known = row?.schemaVersion === 2 && row.orgId === orgId && row.participantId === participantId
    && p?.schemaVersion === 2 && (p.orgId == null || p.orgId === orgId);
  if (!known || (requireActive && (row!.status !== 'active' || p!.status !== 'active'))) unavailable([participantId]);
}

async function actionHistory(tx: Transaction, sessionPath: string, sequence: number): Promise<PlayAction[]> {
  if (sequence > MAX_PLAY_ACTIONS) ledgerFailure(new PlayLedgerError('INVALID_ACTION', `Sessions support at most ${MAX_PLAY_ACTIONS} actions.`));
  const snap = await tx.get(db().collection(`${sessionPath}/actions`).orderBy('sequence').limit(MAX_PLAY_ACTIONS + 1));
  return snap.docs.map(doc => doc.data().action as PlayAction);
}

async function playContext(tx: Transaction, data: Data, uid: string, writing: boolean) {
  const { scope } = await coachingEvent(tx, data.eventId, data.teamId, uid, writing);
  if (data.orgId !== undefined && scope.orgId !== data.orgId) denied();
  const ref = db().doc(`events/${data.eventId}/playSessions/${data.teamId}`);
  const session = (await tx.get(ref)).data();
  return { scope, ref, session, ledger: (session?.ledger as LedgerState | undefined) ?? initialLedger() };
}

function persist(tx: Transaction, ctx: Awaited<ReturnType<typeof playContext>>, uid: string, action: PlayAction, ledger: LedgerState, extra: Data, now: Timestamp) {
  const revision = (ctx.session?.revision ?? 0) + 1;
  // Immutable audit row. operationId is backend-generated; sequence orders replay.
  const actionRef = ctx.ref.collection('actions').doc();
  tx.create(actionRef, {
    schemaVersion: 2, orgId: ctx.scope.orgId, eventId: ctx.ref.parent.parent!.id, teamId: ctx.ref.id, operationId: actionRef.id,
    sequence: action.sequence, period: ledger.currentPeriod, actorUid: uid, createdAt: now, action,
  });
  const anchored = ledger.status === 'running';
  tx.set(ctx.ref, {
    ...(ctx.session ?? { schemaVersion: 2, orgId: ctx.scope.orgId, programId: ctx.scope.programId, seasonId: ctx.scope.seasonId,
      eventId: ctx.ref.parent.parent!.id, teamId: ctx.ref.id, createdAt: now, createdBy: uid }),
    ...extra,
    ledger,
    // Keep a running anchor across substitutions so the live clock does not drift.
    anchorAt: anchored ? (ctx.session?.anchorAt && ctx.ledger.status === 'running' ? ctx.session.anchorAt : now) : null,
    anchorElapsedMs: anchored && ctx.ledger.status === 'running' ? ctx.session!.anchorElapsedMs : ledger.elapsedMs,
    finalized: ledger.status === 'finalized',
    revision, updatedAt: now, updatedBy: uid,
  });
  return revision;
}

export const recordPlayAction = command('recordPlayAction', normalizePlayAction, async (tx, data, uid, _actor, replay) => {
  const ctx = await playContext(tx, data, uid, !replay);
  if (replay) return replay;
  checkRevision(ctx.session, data.expectedRevision);
  if (ctx.ledger.status === 'finalized') finalized();
  const now = Timestamp.now();
  const atElapsedMs = elapsedNow(ctx.session, ctx.ledger, now);
  const kind = data.kind as PlayActionKind;
  const action: PlayAction = { sequence: ctx.ledger.sequence + 1, kind, atElapsedMs };
  const extra: Data = {};
  let affectedParticipantIds: string[] | undefined;
  if (kind === 'start' && ctx.ledger.status === 'notStarted') {
    // Seed from the saved private lineup; RSVP and attendance never reorder it.
    const lineup = (await tx.get(db().doc(`events/${data.eventId}/coaching/${data.teamId}`))).data();
    if (!lineup) throw new HttpsError('failed-precondition', 'Save a lineup before starting the clock.', { domainCode: 'LINEUP_NOT_SAVED' });
    if (data.periodCount === undefined) invalid('Choose the number of periods.');
    const roster = await rosterFor(tx, ctx.scope.orgId, data.teamId);
    const missing = referenced(lineup).filter(participantId => !roster.get(participantId)?.available);
    if (missing.length) unavailable(missing);
    action.periodCount = data.periodCount;
    action.units = (lineup.units as Data[]).map(unit => ({
      unitId: unit.unitId, participantIds: (unit.slots as Data[]).map(slot => slot.participantId as string),
    }));
    Object.assign(extra, { sportPresetId: lineup.sportPresetId, presetVersion: lineup.presetVersion, lineupRevision: lineup.revision });
  } else if (kind === 'start' && data.periodCount !== undefined) {
    invalid('Periods are set when the game starts.');
  }
  if (kind === 'substitute' || kind === 'switchUnit') action.unitId = data.unitId;
  if (kind === 'substitute') {
    await rosterParticipant(tx, ctx.scope.orgId, data.teamId, data.inParticipantId, true);
    Object.assign(action, { outParticipantId: data.outParticipantId, inParticipantId: data.inParticipantId });
  }
  let ledger: LedgerState;
  try {
    if (kind === 'correct') {
      await rosterParticipant(tx, ctx.scope.orgId, data.teamId, data.inParticipantId, false);
      Object.assign(action, {
        targetSequence: data.targetSequence, reason: data.reason,
        corrected: { atElapsedMs: data.atElapsedMs, outParticipantId: data.outParticipantId, inParticipantId: data.inParticipantId },
      });
      // Corrections recompute every derived interval from the immutable history.
      const history = await actionHistory(tx, ctx.ref.path, ctx.ledger.sequence);
      ({ state: ledger, affectedParticipantIds } = replayWithCorrection(history, action));
    } else {
      ledger = applyPlayAction(ctx.ledger, action);
    }
  } catch (error) {
    ledgerFailure(error);
  }
  const revision = persist(tx, ctx, uid, action, ledger!, extra, now);
  return {
    requestId: data.requestId, revision, state: ledger!.status, sequence: action.sequence,
    ...(affectedParticipantIds ? { affectedParticipantIds } : {}),
  };
});

export const finalizePlaySession = command('finalizePlaySession', data => {
  const { base } = envelope(data, ['teamId']);
  return base;
}, async (tx, data, uid, _actor, replay) => {
  const ctx = await playContext(tx, data, uid, !replay);
  if (replay) return replay;
  if (!ctx.session) throw new HttpsError('failed-precondition', 'Start the clock before finalizing.', { domainCode: 'SESSION_NOT_STARTED' });
  checkRevision(ctx.session, data.expectedRevision);
  if (ctx.ledger.status === 'finalized') finalized();
  const now = Timestamp.now();
  const action: PlayAction = { sequence: ctx.ledger.sequence + 1, kind: 'finalize', atElapsedMs: ctx.ledger.elapsedMs };
  let ledger: LedgerState;
  try {
    ledger = applyPlayAction(ctx.ledger, action);
    // Finalization proves the stored incremental ledger equals a full replay of the immutable actions.
    const replayed = replayPlayLedger([...await actionHistory(tx, ctx.ref.path, action.sequence), action]);
    if (JSON.stringify(ledgerTotals(replayed)) !== JSON.stringify(ledgerTotals(ledger))) {
      throw new HttpsError('internal', 'Playing-time replay mismatch. Contact support before finalizing.', { domainCode: 'LEDGER_REPLAY_MISMATCH' });
    }
    ledger = replayed;
  } catch (error) {
    ledgerFailure(error);
  }
  const totals = ledgerTotals(ledger!);
  const revision = persist(tx, ctx, uid, action, ledger!, { finalizedAt: now, finalTotals: totals, durationMs: ledger!.elapsedMs }, now);
  return { requestId: data.requestId, revision, state: 'finalized', sequence: action.sequence };
});

export const getPlaySession = readCommand(data => {
  keys(data, ['eventId', 'teamId', 'beforeSequence']);
  if (data.beforeSequence !== undefined && (!Number.isSafeInteger(data.beforeSequence) || data.beforeSequence < 2)) invalid('Invalid history cursor.');
  return { eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId'), beforeSequence: data.beforeSequence ?? null };
}, async (tx, data, uid) => {
  const ctx = await playContext(tx, data, uid, false);
  // Newest first, paged by sequence so every earlier substitution stays reachable for correction.
  let page = ctx.ref.collection('actions').orderBy('sequence', 'desc');
  if (data.beforeSequence) page = page.where('sequence', '<', data.beforeSequence);
  const [lineupDoc, recent] = await Promise.all([
    tx.get(db().doc(`events/${data.eventId}/coaching/${data.teamId}`)),
    tx.get(page.limit(RECENT_ACTIONS)),
  ]);
  const oldest = recent.docs[recent.docs.length - 1]?.data().sequence as number | undefined;
  const roster = await rosterFor(tx, ctx.scope.orgId, data.teamId);
  const now = Timestamp.now();
  const elapsedMs = elapsedNow(ctx.session, ctx.ledger, now);
  const totals = ledgerTotals(ctx.ledger, elapsedMs);
  const name = (participantId: string) => roster.get(participantId)?.displayName ?? 'Unavailable participant';
  const lineup = lineupDoc.data();
  return {
    orgId: ctx.scope.orgId, eventId: data.eventId, teamId: data.teamId, revision: ctx.session?.revision ?? 0,
    lineupRevision: lineup?.revision ?? 0, sportPresetId: ctx.session?.sportPresetId ?? lineup?.sportPresetId ?? null,
    status: ctx.ledger.status, periodCount: ctx.ledger.periodCount, currentPeriod: ctx.ledger.currentPeriod,
    activeUnitId: ctx.ledger.activeUnitId, units: ctx.ledger.units, elapsedMs, serverNow: now,
    totals: Object.entries(totals).map(([participantId, ms]) => ({ participantId, displayName: name(participantId), ms }))
      .sort((a, b) => b.ms - a.ms || a.displayName.localeCompare(b.displayName)),
    roster: [...roster.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    actions: recent.docs.map(doc => ({ ...(doc.data().action as PlayAction), period: doc.data().period })),
    olderBeforeSequence: recent.size === RECENT_ACTIONS && oldest! > 1 ? oldest! : null,
    finalizedAt: ctx.session?.finalizedAt ?? null,
  };
});
