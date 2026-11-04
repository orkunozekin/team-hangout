import { createHash } from 'crypto';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, revision, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied } from '../operations/access';
import { teamViewer } from '../coaching/lineups';
import {
  BRACKET_SCHEMA_VERSION, BracketNode, BracketRuleError, buildBracket, MAX_BRACKET_TEAMS, nodeState, overrideSeeds, standingsSeeds,
} from './bracket';
import { bracketDomain, chainChange, nodesRef, startedNodes, storedNode, writeBracketChange } from './bracketProgress';
import { standingsStatus } from './generations';
import {
  competitionMatch, competitionRef, competitionStaff, correctFinal, domain, envelope, finalRules, loadCompetition,
  normalizeResultCommand, scorerContext, validate,
} from './results';

const db = () => getFirestore();
const REASON_MAX = 500;
const LIST_LIMIT = 100;
const STANDINGS_ROWS_MAX = 256;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function ruleFailure(error: unknown): never {
  if (error instanceof BracketRuleError) throw new HttpsError('invalid-argument', error.message, { domainCode: error.code });
  throw error;
}

function seedOverride(value: unknown) {
  if (value == null) return null;
  const raw = object(value);
  keys(raw, ['teamIds', 'reason']);
  if (!Array.isArray(raw.teamIds) || raw.teamIds.length > MAX_BRACKET_TEAMS) invalid('Invalid seed order.');
  return { teamIds: (raw.teamIds as unknown[]).map(teamId => id(teamId, 'teamId')), reason: text(raw.reason, 'seed override reason', REASON_MAX) };
}

function previewInput(data: Data) {
  return {
    sourceCompetitionId: data.sourceCompetitionId == null ? null : id(data.sourceCompetitionId, 'sourceCompetitionId'),
    seedOverride: seedOverride(data.seedOverride),
  };
}

type Plan = Awaited<ReturnType<typeof seedPlan>>;

/**
 * Seeds come from the active complete standings generation of a competition in the same program and season, or from a
 * manager's explicit order with a reason. Standings that are updating, stale or tied between bracket teams never seed.
 */
async function seedPlan(tx: Transaction, competition: Data, input: ReturnType<typeof previewInput>) {
  if (competition.format !== 'knockout') domain('BRACKET_FORMAT', 'Only knockout competitions have a bracket.');
  const teamIds = competition.teamIds as string[];
  if (teamIds.length > MAX_BRACKET_TEAMS) domain('BRACKET_LIMIT', `Brackets support at most ${MAX_BRACKET_TEAMS} teams. Split larger groups into divisions.`, 'invalid-argument');
  let source: { competitionId: string; name: string; generationId: string; sourceRevision: number } | null = null;
  let unresolvedTies: string[][] = [];
  let seeds: string[] | null = null;
  if (input.sourceCompetitionId) {
    const origin = input.sourceCompetitionId === competition.competitionId ? competition : await loadCompetition(tx, competition.orgId, input.sourceCompetitionId);
    if (!origin || origin.programId !== competition.programId || origin.seasonId !== competition.seasonId) denied();
    if (standingsStatus(origin!) !== 'current' || !origin!.activeGeneration) {
      domain('STANDINGS_NOT_CURRENT', 'Seeding standings are updating or unconfirmed. Wait for a complete current table.');
    }
    const generationId = origin!.activeGeneration.generationId as string;
    const rows = await tx.get(competitionRef(competition.orgId, origin!.competitionId).collection('generations').doc(generationId)
      .collection('rows').orderBy(FieldPath.documentId()).limit(STANDINGS_ROWS_MAX));
    try {
      const seeded = standingsSeeds(rows.docs.map(doc => doc.data() as never), teamIds);
      seeds = seeded.seeds;
      unresolvedTies = seeded.unresolvedTies;
    } catch (error) {
      ruleFailure(error);
    }
    source = { competitionId: origin!.competitionId, name: origin!.name, generationId, sourceRevision: origin!.sourceRevision ?? 0 };
  }
  if (input.seedOverride) {
    try {
      seeds = overrideSeeds(input.seedOverride.teamIds, teamIds);
    } catch (error) {
      ruleFailure(error);
    }
  }
  const blocked = !seeds ? 'SEED_ORDER_REQUIRED' : unresolvedTies.length && !input.seedOverride ? 'SEED_TIE_UNRESOLVED' : null;
  let nodes: BracketNode[] = [];
  if (seeds) {
    try {
      nodes = buildBracket(seeds);
    } catch (error) {
      ruleFailure(error);
    }
  }
  const previewHash = digest({
    schema: BRACKET_SCHEMA_VERSION, competitionId: competition.competitionId, teamIds: [...teamIds].sort(), source, seeds,
    overrideReason: input.seedOverride?.reason ?? null,
  });
  return { source, seeds, unresolvedTies, blocked, nodes, previewHash, override: input.seedOverride };
}

async function teamNames(tx: Transaction, teamIds: string[]) {
  const teams = teamIds.length ? await tx.getAll(...teamIds.map(teamId => db().doc(`teams/${teamId}`))) : [];
  return new Map(teams.map(team => [team.id, typeof team.data()?.name === 'string' ? team.data()!.name as string : 'Unavailable team']));
}

/** A published bracket can be replaced only while no game has a linked match, a played winner or voided play history. */
const playedOrLinked = (row: Data) => !row.bye && (!!row.eventId || !!row.winnerTeamId || ((row.voidedPlays ?? []) as unknown[]).length > 0);

async function publishedNodes(tx: Transaction, competition: Data) {
  if (!competition.bracket?.bracketId) return [];
  const snap = await tx.get(nodesRef(competition).orderBy(FieldPath.documentId()).limit(MAX_BRACKET_TEAMS));
  return snap.docs.map(doc => doc.data()).filter(row => row.bracketId === competition.bracket.bracketId);
}

function nodeView(row: Data, names: Map<string, string>, events: Map<string, Data>, nowMs: number) {
  const node = storedNode(row);
  const event = node.eventId ? events.get(node.eventId) : undefined;
  const startsAt = event?.startsAt instanceof Timestamp ? event.startsAt : null;
  const state = nodeState(node);
  return {
    nodeId: node.nodeId, round: node.round, index: node.index, state, bye: node.bye,
    teams: node.teamIds.map((teamId, slot) => (teamId ? { teamId, name: names.get(teamId) ?? 'Unavailable team', seed: node.seeds[slot] } : null)),
    eventId: node.eventId, eventStartsAt: startsAt,
    // A linked match that already began without a winner is waiting on a final result (or a replacement for a void).
    winnerPending: state === 'scheduled' && !!startsAt && startsAt.toMillis() <= nowMs,
    winnerTeamId: node.winnerTeamId,
    voidedPlays: ((row.voidedPlays ?? []) as Data[]).map(play => ({ eventId: play.eventId, winnerTeamId: play.winnerTeamId ?? null, voidedAt: play.voidedAt })),
  };
}

async function bracketView(tx: Transaction, competition: Data) {
  const base = {
    competitionId: competition.competitionId, name: competition.name, format: competition.format,
    bracketRevision: competition.bracketRevision ?? 0,
  };
  if (!competition.bracket?.bracketId) return { ...base, bracket: null, nodes: [] };
  const rows = await publishedNodes(tx, competition);
  const linked = [...new Set(rows.map(row => row.eventId).filter(Boolean) as string[])];
  const [names, events] = await Promise.all([
    teamNames(tx, competition.teamIds),
    linked.length ? tx.getAll(...linked.map(eventId => db().doc(`events/${eventId}`))) : Promise.resolve([]),
  ]);
  const eventMap = new Map(events.map(event => [event.id, event.data() ?? {}]));
  const bracket = competition.bracket;
  return {
    ...base,
    bracket: {
      bracketId: bracket.bracketId, size: bracket.size, rounds: bracket.rounds, teamCount: bracket.seeds.length,
      source: bracket.source, override: bracket.override ? { reason: bracket.override.reason } : null,
      publishedAt: bracket.publishedAt, updatedAt: bracket.updatedAt ?? bracket.publishedAt,
    },
    nodes: rows.map(row => nodeView(row, names, eventMap, Date.now())),
  };
}

/** Staff preview of seeds and byes, with the hash publishBracket requires so a stale preview cannot publish. */
export const previewBracket = readCommand(data => {
  keys(data, ['orgId', 'competitionId', 'sourceCompetitionId', 'seedOverride']);
  return { orgId: id(data.orgId, 'orgId'), competitionId: id(data.competitionId, 'competitionId'), ...previewInput(data) };
}, async (tx, data, uid) => {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  if (!competition) denied();
  await competitionStaff(tx, data.orgId, competition!.programId, uid);
  const plan = await seedPlan(tx, competition!, { sourceCompetitionId: data.sourceCompetitionId, seedOverride: data.seedOverride });
  const [names, existing] = await Promise.all([teamNames(tx, competition!.teamIds), publishedNodes(tx, competition!)]);
  return {
    competitionId: competition!.competitionId, bracketRevision: competition!.bracketRevision ?? 0,
    published: !!competition!.bracket?.bracketId, locked: existing.some(playedOrLinked),
    source: plan.source, previewHash: plan.previewHash, blocked: plan.blocked,
    unresolvedTies: plan.unresolvedTies.map(group => group.map(teamId => ({ teamId, name: names.get(teamId) ?? 'Unavailable team' }))),
    seeds: (plan.seeds ?? []).map((teamId, i) => ({ seed: i + 1, teamId, name: names.get(teamId) ?? 'Unavailable team' })),
    nodes: plan.nodes.map(node => nodeView({ ...node }, names, new Map(), Date.now())),
  };
});

export function normalizePublishBracket(data: Data) {
  const { payload, base } = envelope(data, ['sourceCompetitionId', 'generationId', 'sourceRevision', 'seedOverride', 'previewHash']);
  const input = previewInput(payload);
  if ((input.sourceCompetitionId === null) !== (payload.generationId == null)) invalid('A standings source needs its generation.');
  return {
    ...base, ...input,
    generationId: payload.generationId == null ? null : id(payload.generationId, 'generationId'),
    sourceRevision: payload.sourceRevision == null ? null : revision(payload.sourceRevision),
    previewHash: text(payload.previewHash, 'previewHash', 64),
  };
}

export const publishBracket = command('publishBracket', normalizePublishBracket, async (tx, data, uid, _actor, replay) => {
  const competition = await scorerContext(tx, data, uid, !replay);
  if (replay) return replay;
  checkRevision({ revision: competition.bracketRevision ?? 0 }, data.expectedRevision);
  const plan: Plan = await seedPlan(tx, competition, { sourceCompetitionId: data.sourceCompetitionId, seedOverride: data.seedOverride });
  if (plan.previewHash !== data.previewHash || plan.source?.generationId !== (data.generationId ?? undefined)
    || plan.source?.sourceRevision !== (data.sourceRevision ?? undefined)) {
    domain('BRACKET_PREVIEW_CHANGED', 'Standings or teams changed since this preview. Review the new preview before publishing.');
  }
  if (plan.blocked === 'SEED_TIE_UNRESOLVED') domain('SEED_TIE_UNRESOLVED', 'Bracket teams share a standings rank. Record a seed order with a reason.');
  if (plan.blocked) domain('SEED_ORDER_REQUIRED', 'Choose a standings source or record a seed order with a reason.');
  const existing = await publishedNodes(tx, competition);
  if (existing.some(playedOrLinked)) {
    domain('BRACKET_LOCKED', 'This bracket already has linked or decided games. Correct individual results instead of republishing.');
  }
  const now = Timestamp.now();
  const ref = competitionRef(data.orgId, data.competitionId);
  const history = ref.collection('bracketHistory').doc();
  const bracketId = history.id;
  const nextRevision = (competition.bracketRevision ?? 0) + 1;
  // Replacing an unplayed bracket: the old nodes carry no match or result, so removing them loses no history.
  for (const row of existing) tx.delete(nodesRef(competition).doc(row.nodeId));
  for (const node of plan.nodes) {
    tx.set(nodesRef(competition).doc(node.nodeId), {
      schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, bracketId, ...node,
      voidedPlays: [], revision: nextRevision, createdAt: now, updatedAt: now, updatedBy: uid,
    });
  }
  const rounds = Math.max(...plan.nodes.map(node => node.round));
  tx.update(ref, {
    bracketRevision: nextRevision,
    bracket: {
      bracketId, size: 2 ** rounds, rounds, seeds: plan.seeds, source: plan.source,
      override: plan.override ? { reason: plan.override.reason, by: uid, at: now } : null,
      previewHash: plan.previewHash, publishedAt: now, publishedBy: uid, updatedAt: now,
    },
  });
  tx.create(history, {
    schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, bracketId, operationId: history.id, kind: 'publish',
    replacedBracketId: competition.bracket?.bracketId ?? null, seeds: plan.seeds, source: plan.source,
    reason: plan.override?.reason ?? null, actorUid: uid, createdAt: now, beforeRevision: nextRevision - 1, afterRevision: nextRevision,
  });
  return { requestId: data.requestId, revision: nextRevision, state: 'published', bracketId, operationId: history.id };
});

export function normalizeLinkBracketEvent(data: Data) {
  const { payload, base } = envelope(data, ['nodeId', 'eventId']);
  if (typeof payload.nodeId !== 'string' || !/^r[1-7]-\d{2}$/.test(payload.nodeId)) invalid('Invalid nodeId.');
  return { ...base, nodeId: payload.nodeId as string, eventId: id(payload.eventId, 'eventId') };
}

/**
 * Links a canonical published match to a bracket game whose two teams are known. A bye never takes a match. A
 * replacement link is allowed only while the previous match has not started, or after it was finalized as void.
 */
export const linkBracketEvent = command('linkBracketEvent', normalizeLinkBracketEvent, async (tx, data, uid, _actor, replay) => {
  const competition = await scorerContext(tx, data, uid, !replay);
  if (replay) return replay;
  checkRevision({ revision: competition.bracketRevision ?? 0 }, data.expectedRevision);
  if (!competition.bracket?.bracketId) domain('BRACKET_NOT_PUBLISHED', 'Publish the bracket before linking matches.');
  const row = (await tx.get(nodesRef(competition).doc(data.nodeId))).data();
  if (!row || row.bracketId !== competition.bracket.bracketId) denied();
  const node = storedNode(row!);
  if (node.bye) domain('BYE_NO_EVENT', 'A bye has no match, score, attendance or booking.');
  if (!node.teamIds[0] || !node.teamIds[1]) domain('BRACKET_NODE_WAITING', 'Both teams must be known before a match is linked.');
  if (node.winnerTeamId) domain('BRACKET_NODE_DECIDED', 'This game already has a winner. Correct its result instead.');
  if (node.eventId === data.eventId) domain('NO_CHANGE', 'This match is already linked.', 'invalid-argument');
  // A match a reviewed correction invalidated must be replayed; relinking it would restore its old winner.
  if (((row!.voidedPlays ?? []) as Data[]).some(play => play.eventId === data.eventId)) {
    domain('BRACKET_EVENT_VOIDED', 'A reviewed correction invalidated this match for this game. Link a replay instead.');
  }
  const { event, sides } = await competitionMatch(tx, competition, data.eventId);
  if (!node.teamIds.includes(sides.homeTeamId) || !node.teamIds.includes(sides.awayTeamId)) {
    domain('BRACKET_EVENT_MISMATCH', 'Link a match between the two teams in this bracket game.');
  }
  if (event.status === 'cancelled') domain('EVENT_NOT_PLAYED', 'A cancelled match cannot decide a bracket game.');
  const results = competitionRef(data.orgId, data.competitionId).collection('results');
  const [inUse, result, previous] = await Promise.all([
    tx.get(nodesRef(competition).where('eventId', '==', data.eventId).limit(2)),
    tx.get(results.doc(data.eventId)),
    node.eventId ? tx.get(results.doc(node.eventId)) : Promise.resolve(null),
  ]);
  if (inUse.docs.some(doc => doc.data().bracketId === competition.bracket.bracketId)) domain('BRACKET_EVENT_IN_USE', 'This match is linked to another bracket game.');
  const now = Timestamp.now();
  if (node.eventId) {
    const started = await startedNodes(tx, competition, [node], now);
    const voided = previous?.data()?.status === 'final' && previous.data()!.final?.outcome === 'void';
    if (started.has(node.nodeId) && !voided) {
      domain('BRACKET_EVENT_STARTED', 'The linked match already started. Finalize it, or void it before linking a replacement.');
    }
  }
  // A match finalized before it was linked advances its winner now; progression still comes only from a final result.
  const final = result.data()?.status === 'final' ? result.data()!.final : null;
  const linked = { ...node, eventId: data.eventId };
  const change = await chainChange(tx, competition, linked, final?.winnerTeamId ?? null, now);
  if (change.invalidated.length) {
    bracketDomain('BRACKET_CORRECTION_REQUIRED', 'Later bracket games already started. Review a bracket correction instead.', { invalidatedNodeIds: change.invalidated });
  }
  const ref = competitionRef(data.orgId, data.competitionId);
  const history = ref.collection('bracketHistory').doc();
  const nextRevision = (competition.bracketRevision ?? 0) + 1;
  if (node.eventId) tx.delete(db().doc(`events/${node.eventId}/bracketLinks/${data.competitionId}`));
  // The event lifecycle checks this marker so a linked match keeps its match identity.
  tx.set(db().doc(`events/${data.eventId}/bracketLinks/${data.competitionId}`), {
    schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, eventId: data.eventId, nodeId: node.nodeId, updatedAt: now,
  });
  let fields: Data = { bracketRevision: nextRevision, 'bracket.updatedAt': now };
  if (change.previousWinnerTeamId !== change.winnerTeamId) {
    fields = writeBracketChange(tx, { ...competition }, change, 'progress', uid, now, null);
  } else {
    tx.update(nodesRef(competition).doc(node.nodeId), { eventId: data.eventId, revision: nextRevision, updatedAt: now, updatedBy: uid });
  }
  tx.update(ref, fields);
  tx.create(history, {
    schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, bracketId: competition.bracket.bracketId,
    operationId: history.id, kind: 'link', nodeId: node.nodeId, eventId: data.eventId, replacedEventId: node.eventId,
    actorUid: uid, createdAt: now, beforeRevision: nextRevision - 1, afterRevision: nextRevision,
  });
  return { requestId: data.requestId, revision: nextRevision, state: change.winnerTeamId ? 'decided' : 'scheduled', operationId: history.id };
});

/** Competition staff view of the published bracket. */
export const getBracket = readCommand(data => {
  keys(data, ['orgId', 'competitionId']);
  return { orgId: id(data.orgId, 'orgId'), competitionId: id(data.competitionId, 'competitionId') };
}, async (tx, data, uid) => {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  if (!competition) denied();
  await competitionStaff(tx, data.orgId, competition!.programId, uid);
  return bracketView(tx, competition!);
});

/** Team viewers see only published brackets of knockout competitions containing their team. */
export const getEventBracket = readCommand(data => {
  keys(data, ['eventId', 'teamId', 'participantId', 'competitionId']);
  return {
    eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId'),
    participantId: data.participantId == null ? null : id(data.participantId, 'participantId'),
    competitionId: data.competitionId == null ? null : id(data.competitionId, 'competitionId'),
  };
}, async (tx, data, uid) => {
  const team = await teamViewer(tx, data.eventId, data.teamId, data.participantId, uid);
  const snap = await tx.get(db().collection(`organizations/${team.orgId}/competitions`)
    .where('teamIds', 'array-contains', data.teamId).limit(LIST_LIMIT));
  const competitions = snap.docs.map(doc => doc.data()).filter(row => row.schemaVersion === 2 && row.orgId === team.orgId
    && row.format === 'knockout' && row.bracket?.bracketId && row.programId === team.programId && row.seasonId === team.seasonId
    && (row.divisionId === null || row.divisionId === team.divisionId))
    .sort((a, b) => a.name.localeCompare(b.name) || a.competitionId.localeCompare(b.competitionId));
  const selected = data.competitionId ? competitions.find(row => row.competitionId === data.competitionId) : competitions[0];
  if (data.competitionId && !selected) denied();
  return {
    orgId: team.orgId, eventId: data.eventId, teamId: data.teamId,
    competitions: competitions.map(row => ({ competitionId: row.competitionId, name: row.name })),
    bracket: selected ? await bracketView(tx, selected) : null,
  };
});

function correctionInput(data: Data, withConfirmation: boolean) {
  const fields = ['eventId', 'result', 'reason', 'resultRevision', ...(withConfirmation ? ['invalidatedNodeIds'] : [])];
  const { payload, base } = envelope(data, fields);
  const normalized = normalizeResultCommand({ ...data, payload: { eventId: payload.eventId, result: payload.result, reason: payload.reason } }, false, true);
  const result: Data = { ...normalized, ...base, resultRevision: revision(payload.resultRevision) };
  if (withConfirmation) {
    if (!Array.isArray(payload.invalidatedNodeIds) || payload.invalidatedNodeIds.length > MAX_BRACKET_TEAMS) invalid('Invalid invalidated games.');
    result.invalidatedNodeIds = (payload.invalidatedNodeIds as unknown[]).map(nodeId => id(nodeId, 'nodeId'));
  }
  return result;
}

/** Shows which bracket games a corrected winner would clear and which started ones need explicit confirmation. */
export const previewBracketCorrection = readCommand(data => {
  keys(data, ['orgId', 'competitionId', 'eventId', 'result']);
  const normalized = normalizeResultCommand({
    requestId: 'preview', orgId: data.orgId, resourceId: data.competitionId, expectedRevision: 0,
    payload: { eventId: data.eventId, result: data.result },
  }, false, false);
  return { orgId: normalized.orgId, competitionId: normalized.competitionId, eventId: normalized.eventId, result: normalized.result };
}, async (tx, data, uid) => {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  if (!competition) denied();
  await competitionStaff(tx, data.orgId, competition!.programId, uid);
  const current = (await tx.get(competitionRef(data.orgId, data.competitionId).collection('results').doc(data.eventId))).data();
  if (current?.status !== 'final') domain('RESULT_NOT_FINAL', 'Only a final result can be corrected.');
  const sides = { homeTeamId: current!.homeTeamId as string, awayTeamId: current!.awayTeamId as string };
  const values = validate(data.result, sides, competition!, finalRules(competition!));
  const rows = competition!.bracket?.bracketId ? await tx.get(nodesRef(competition!).where('eventId', '==', data.eventId).limit(2)) : null;
  const row = rows?.docs.map(doc => doc.data()).find(item => item.bracketId === competition!.bracket.bracketId);
  const base = {
    eventId: data.eventId, resultRevision: current!.revision, bracketRevision: competition!.bracketRevision ?? 0, rounds: competition!.bracket?.rounds ?? 0,
  };
  if (!row) return { ...base, nodeId: null, previousWinnerTeamId: null, winnerTeamId: values!.winnerTeamId, affected: [], invalidatedNodeIds: [], requiresConfirmation: false };
  const change = await chainChange(tx, competition!, storedNode(row), values!.winnerTeamId, Timestamp.now());
  return {
    ...base, nodeId: change.node.nodeId, previousWinnerTeamId: change.previousWinnerTeamId, winnerTeamId: change.winnerTeamId,
    affected: change.affected, invalidatedNodeIds: change.invalidated, requiresConfirmation: change.invalidated.length > 0,
  };
});

/**
 * Administrator correction for a bracket game whose later games already started. The caller confirms exactly the games
 * the preview listed; those keep their played match and winner in node history and audit, and must be replayed.
 */
export const correctBracket = command('correctBracket', data => correctionInput(data, true), async (tx, data, uid, _actor, replay) => {
  const competition = await scorerContext(tx, data, uid, !replay);
  if (replay) return replay;
  checkRevision({ revision: competition.bracketRevision ?? 0 }, data.expectedRevision);
  if (!competition.bracket?.bracketId) domain('BRACKET_NOT_PUBLISHED', 'This competition has no published bracket.');
  return correctFinal(tx, competition, { ...data, expectedRevision: data.resultRevision }, uid, data.invalidatedNodeIds);
});
