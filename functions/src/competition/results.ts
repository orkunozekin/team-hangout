import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, revision, text } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied, hierarchy, requireProgram, staffScope } from '../operations/access';
import { publishedEvent } from '../scheduling/visibility';
import { coachingEvent } from '../coaching/lineups';
import { bracketChange, bracketDomain, writeBracketChange } from './bracketProgress';
import {
  assertRulesFitFormat, CompetitionFormat, CompetitionResultValues, CompetitionRuleError, CompetitionRules,
  normalizeResultValues, normalizeRules, sameResult, sameRules,
} from './rules';

const db = () => getFirestore();
/** Engineering guardrails from the plan; revisit after measurement, not commercial limits. */
export const MAX_COMPETITION_TEAMS = 256;
export const MAX_FINAL_RESULTS = 4096;
const REASON_MAX = 500;
const NAME_MAX = 120;
const MATCH_PAGE = 50;
const LIST_LIMIT = 100;
const VERSION_PAGE = 20;
const FORMATS: CompetitionFormat[] = ['league', 'knockout'];

/** Marks standings as needing a rebuild inside the source transaction. Keeps the earliest pending time for stale detection. */
export function pendingSince(competition: Data | undefined, now: Timestamp): Timestamp {
  return competition?.standingsPendingSince instanceof Timestamp ? competition.standingsPendingSince : now;
}

export function domain(code: string, message: string, transport: 'failed-precondition' | 'invalid-argument' | 'resource-exhausted' = 'failed-precondition'): never {
  throw new HttpsError(transport, message, { domainCode: code });
}

function ruleFailure(error: unknown): never {
  if (error instanceof CompetitionRuleError) throw new HttpsError('invalid-argument', error.message, { domainCode: error.code });
  throw error;
}

export function competitionRef(orgId: string, competitionId: string) {
  return db().doc(`organizations/${orgId}/competitions/${competitionId}`);
}

export function envelope(data: Data, payloadFields: string[]) {
  keys(data, ['requestId', 'orgId', 'resourceId', 'expectedRevision', 'payload']);
  const payload = object(data.payload);
  keys(payload, payloadFields);
  return {
    payload,
    base: {
      requestId: id(data.requestId, 'requestId'),
      orgId: id(data.orgId, 'orgId'),
      competitionId: id(data.resourceId, 'competitionId'),
      expectedRevision: revision(data.expectedRevision),
    },
  };
}

/** Exported for pure tests. Rules are validated here; scope and team eligibility are checked against stored records. */
export function normalizeCompetitionRules(data: Data) {
  const { payload, base } = envelope(data, ['programId', 'seasonId', 'divisionId', 'name', 'format', 'teamIds', 'rules', 'confirm']);
  if (!FORMATS.includes(payload.format)) invalid('Choose league or knockout.');
  if (typeof payload.confirm !== 'boolean') invalid('Choose whether to confirm these rules.');
  if (!Array.isArray(payload.teamIds) || payload.teamIds.length < 2 || payload.teamIds.length > MAX_COMPETITION_TEAMS) {
    domain('COMPETITION_LIMIT', `Competitions need 2 to ${MAX_COMPETITION_TEAMS} teams. Split larger groups into divisions.`, 'invalid-argument');
  }
  const teamIds = [...new Set((payload.teamIds as unknown[]).map(teamId => id(teamId, 'teamId')))].sort();
  if (teamIds.length !== payload.teamIds.length) invalid('Each team can appear once.');
  let rules: CompetitionRules;
  try {
    rules = normalizeRules(payload.rules);
    assertRulesFitFormat(rules, payload.format);
  } catch (error) {
    ruleFailure(error);
  }
  return {
    ...base,
    programId: id(payload.programId, 'programId'),
    seasonId: id(payload.seasonId, 'seasonId'),
    divisionId: payload.divisionId == null ? null : id(payload.divisionId, 'divisionId'),
    name: text(payload.name, 'competition name', NAME_MAX),
    format: payload.format as CompetitionFormat,
    teamIds,
    rules: rules!,
    confirm: payload.confirm,
  };
}

/** Competition managers and scorers: active orgAdmin, or programStaff assigned to the competition's program. */
export async function competitionStaff(tx: Transaction, orgId: string, programId: string, uid: string) {
  const scope = await staffScope(tx, orgId, uid);
  requireProgram(scope, programId);
  return scope;
}

export async function loadCompetition(tx: Transaction, orgId: string, competitionId: string) {
  const snap = await tx.get(competitionRef(orgId, competitionId));
  const competition = snap.data();
  if (competition && (competition.schemaVersion !== 2 || competition.orgId !== orgId)) denied();
  return competition;
}

export const saveCompetitionRules = command('saveCompetitionRules', normalizeCompetitionRules, async (tx, data, uid, _actor, replay) => {
  const current = await loadCompetition(tx, data.orgId, data.competitionId);
  await competitionStaff(tx, data.orgId, current?.programId ?? data.programId, uid);
  if (replay) return replay;
  if (current && (current.programId !== data.programId || current.seasonId !== data.seasonId
    || current.divisionId !== data.divisionId || current.format !== data.format)) {
    domain('IMMUTABLE_SCOPE', 'Program, season, division and format cannot change after a competition is created.', 'invalid-argument');
  }
  checkRevision(current, data.expectedRevision);
  await hierarchy(tx, data.orgId, data.programId, data.seasonId, data.divisionId, true);
  if (!current) {
    // Cap at creation so the program list always stays loadable.
    const existing = await tx.get(db().collection(`organizations/${data.orgId}/competitions`)
      .where('programId', '==', data.programId).select().limit(LIST_LIMIT));
    if (existing.size >= LIST_LIMIT) {
      domain('COMPETITION_LIMIT', `Programs support at most ${LIST_LIMIT} competitions. Edit an existing competition instead.`, 'resource-exhausted');
    }
  }
  const teams = await tx.getAll(...(data.teamIds as string[]).map(teamId => db().doc(`teams/${teamId}`)));
  if (teams.some(team => {
    const row = team.data();
    return !row || row.schemaVersion !== 2 || row.orgId !== data.orgId || row.programId !== data.programId
      || row.seasonId !== data.seasonId || (data.divisionId !== null && row.divisionId !== data.divisionId);
  })) domain('TEAM_SCOPE_MISMATCH', 'Every team must belong to this program, season and division.', 'invalid-argument');
  const teamsChanged = current && JSON.stringify(current.teamIds) !== JSON.stringify(data.teamIds);
  if (teamsChanged && (current!.finalResultCount ?? 0) > 0) {
    domain('COMPETITION_LOCKED', 'Teams cannot change after a result is final. Correct results or create a new competition.');
  }
  if (teamsChanged && current!.bracket?.bracketId) {
    domain('COMPETITION_LOCKED', 'Teams cannot change after a bracket is published.');
  }
  const now = Timestamp.now();
  const ref = competitionRef(data.orgId, data.competitionId);
  let activeRulesVersion: number | null = current?.activeRulesVersion ?? null;
  let rulesVersionCount: number = current?.rulesVersionCount ?? 0;
  let activeRules: CompetitionRules | null = current?.activeRules ?? null;
  if (data.confirm && !sameRules(activeRules, data.rules)) {
    // Confirmed versions are immutable; a change becomes a new version and earlier finals keep their applied version.
    rulesVersionCount += 1;
    activeRulesVersion = rulesVersionCount;
    activeRules = data.rules;
    tx.create(ref.collection('rulesVersions').doc(String(activeRulesVersion)), {
      schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, version: activeRulesVersion,
      rules: data.rules, format: data.format, confirmedBy: uid, confirmedAt: now,
    });
  }
  const nextRevision = (current?.revision ?? 0) + 1;
  // A new rules version or team set changes the standings inputs; Step 6 rebuilds and clears the marker.
  const standingsChanged = !!activeRules && (activeRulesVersion !== (current?.activeRulesVersion ?? null) || !current || teamsChanged);
  tx.set(ref, {
    ...(current ?? {
      schemaVersion: 2, orgId: data.orgId, competitionId: data.competitionId, programId: data.programId, seasonId: data.seasonId,
      divisionId: data.divisionId, format: data.format, state: 'active', sourceRevision: 0, finalResultCount: 0, createdAt: now, createdBy: uid,
    }),
    name: data.name, teamIds: data.teamIds, draftRules: data.rules,
    activeRulesVersion, rulesVersionCount, activeRules,
    standingsPendingSince: standingsChanged ? pendingSince(current, now) : current?.standingsPendingSince ?? null,
    revision: nextRevision, updatedAt: now, updatedBy: uid,
  });
  return {
    requestId: data.requestId, revision: nextRevision, activeRulesVersion,
    state: activeRules && sameRules(activeRules, data.rules) ? 'confirmed' : 'draft',
  };
});

/** Exported for pure tests. */
export function normalizeResultCommand(data: Data, withTeam: boolean, withReason: boolean) {
  const fields = ['eventId', 'result', ...(withTeam ? ['teamId'] : []), ...(withReason ? ['reason'] : [])];
  const { payload, base } = envelope(data, fields);
  const result = object(payload.result);
  keys(result, ['outcome', 'homeScore', 'awayScore', 'forfeitingTeamId', 'winnerTeamId', 'decider']);
  const normalized: Data = {
    ...base,
    eventId: id(payload.eventId, 'eventId'),
    result: {
      outcome: result.outcome ?? null, homeScore: result.homeScore ?? null, awayScore: result.awayScore ?? null,
      forfeitingTeamId: result.forfeitingTeamId ?? null, winnerTeamId: result.winnerTeamId ?? null, decider: result.decider ?? null,
    },
  };
  if (withTeam) normalized.teamId = id(payload.teamId, 'teamId');
  if (withReason) {
    if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.trim().length > REASON_MAX) {
      invalid(`Corrections need a reason of at most ${REASON_MAX} characters.`);
    }
    normalized.reason = payload.reason.trim();
  }
  return normalized;
}

/**
 * A result belongs to one canonical match whose two explicit sides are both competition teams in the same scope.
 * A one-sided external-opponent event never enters an internal competition.
 */
export async function competitionMatch(tx: Transaction, competition: Data, eventId: string) {
  const event = (await tx.get(db().doc(`events/${eventId}`))).data();
  if (!event || event.schemaVersion !== 2 || event.orgId !== competition.orgId) denied();
  if (event!.type !== 'match' || !Array.isArray(event!.teamIds) || event!.teamIds.length !== 2
    || event!.homeTeamId !== event!.teamIds[0] || event!.awayTeamId !== event!.teamIds[1]
    || event!.teamId !== event!.homeTeamId || event!.homeTeamId === event!.awayTeamId) {
    domain('NOT_COMPETITION_MATCH', 'Only a match between two competition teams can record a competition result.');
  }
  if (event!.programId !== competition.programId || event!.seasonId !== competition.seasonId
    || (competition.divisionId !== null && event!.divisionId !== competition.divisionId)
    || !event!.teamIds.every((teamId: string) => competition.teamIds.includes(teamId))) {
    domain('NOT_COMPETITION_MATCH', 'This match is not part of this competition.');
  }
  if (!(await publishedEvent(tx, event!))) denied();
  return { event: event!, sides: { homeTeamId: event!.homeTeamId as string, awayTeamId: event!.awayTeamId as string } };
}

/** Cancelled, postponed or not-yet-started matches only accept a void result; they never add losses or zero scores. */
function assertPlayable(event: Data, values: CompetitionResultValues, now: Timestamp) {
  if (values.outcome === 'void') return;
  const started = event.startsAt instanceof Timestamp && event.startsAt.toMillis() <= now.toMillis();
  if (event.status === 'cancelled' || event.status === 'postponed' || !started) {
    domain('EVENT_NOT_PLAYED', 'This match has not been played. Only a void result can be recorded.');
  }
}

export function validate(values: Data, sides: { homeTeamId: string; awayTeamId: string }, competition: Data, rules: CompetitionRules | null) {
  try {
    return normalizeResultValues(values, sides, competition.format, rules);
  } catch (error) {
    ruleFailure(error);
  }
}

function writeResult(
  tx: Transaction, competition: Data, eventId: string, event: Data, sides: Data, current: Data | undefined,
  kind: 'propose' | 'finalize' | 'correct', next: Data, uid: string, requestId: string, now: Timestamp, reason: string | null,
) {
  const ref = competitionRef(competition.orgId, competition.competitionId);
  const resultRef = ref.collection('results').doc(eventId);
  const nextRevision = (current?.revision ?? 0) + 1;
  tx.set(resultRef, {
    ...(current ?? {
      schemaVersion: 2, orgId: competition.orgId, competitionId: competition.competitionId, eventId,
      homeTeamId: sides.homeTeamId, awayTeamId: sides.awayTeamId, proposal: null, final: null, createdAt: now,
    }),
    eventStartsAt: event.startsAt ?? null,
    ...next,
    revision: nextRevision, updatedAt: now, updatedBy: uid,
  });
  if (next.status === 'final') {
    // Marker the event lifecycle checks so a match with a counted final result cannot silently change type.
    // A void final counts for nothing, so voiding releases the event.
    const marker = db().doc(`events/${eventId}/competitionResults/${competition.competitionId}`);
    if (next.final.outcome === 'void') tx.delete(marker);
    else tx.set(marker, { schemaVersion: 2, orgId: competition.orgId, competitionId: competition.competitionId, eventId, updatedAt: now });
  }
  // Immutable audit row. operationId is backend-generated.
  const historyRef = ref.collection('resultHistory').doc();
  tx.create(historyRef, {
    schemaVersion: 2, orgId: competition.orgId, competitionId: competition.competitionId, eventId, operationId: historyRef.id,
    requestId, kind, beforeRevision: current?.revision ?? 0, afterRevision: nextRevision,
    before: current ? { status: current.status, proposal: current.proposal ?? null, final: current.final ?? null } : null,
    after: { status: next.status, proposal: next.proposal ?? current?.proposal ?? null, final: next.final ?? current?.final ?? null },
    reason, actorUid: uid, createdAt: now,
  });
  return { revision: nextRevision, operationId: historyRef.id };
}

function activeCompetition(competition: Data | undefined) {
  if (!competition) denied();
  if (competition!.state !== 'active') domain('COMPETITION_CLOSED', 'This competition is closed.');
  return competition!;
}

export const proposeResult = command('proposeResult', data => normalizeResultCommand(data, true, false), async (tx, data, uid, _actor, replay) => {
  // Only an active coach of one side proposes. Staff, guardians and platform roles do not qualify.
  const { scope } = await coachingEvent(tx, data.eventId, data.teamId, uid, !replay);
  if (scope.orgId !== data.orgId) denied();
  const competition = activeCompetition(await loadCompetition(tx, data.orgId, data.competitionId));
  const { event, sides } = await competitionMatch(tx, competition, data.eventId);
  if (data.teamId !== sides.homeTeamId && data.teamId !== sides.awayTeamId) denied();
  if (replay) return replay;
  const current = (await tx.get(competitionRef(data.orgId, data.competitionId).collection('results').doc(data.eventId))).data();
  if (current?.status === 'final') domain('RESULT_FINAL', 'A scorer already finalized this result. Ask them to correct it.');
  checkRevision(current, data.expectedRevision);
  const now = Timestamp.now();
  const values = validate(data.result, sides, competition, competition.activeRules ?? null);
  assertPlayable(event, values!, now);
  const written = writeResult(tx, competition, data.eventId, event, sides, current, 'propose', {
    status: 'proposed',
    proposal: { ...values, proposedBy: uid, proposedTeamId: data.teamId, proposedAt: now },
  }, uid, data.requestId, now, null);
  return { requestId: data.requestId, revision: written.revision, state: 'proposed', operationId: written.operationId };
});

export async function scorerContext(tx: Transaction, data: Data, uid: string, writing: boolean) {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  if (!competition) denied();
  await competitionStaff(tx, data.orgId, competition!.programId, uid);
  if (writing) await hierarchy(tx, data.orgId, competition!.programId, competition!.seasonId, competition!.divisionId, true);
  return activeCompetition(competition);
}

function bumpSource(tx: Transaction, competition: Data, finalDelta: number, uid: string, now: Timestamp, extra: Data = {}) {
  // Every finalization or correction advances the source revision that standings generations rebuild from.
  const sourceRevision = (competition.sourceRevision ?? 0) + 1;
  tx.update(competitionRef(competition.orgId, competition.competitionId), {
    sourceRevision, finalResultCount: (competition.finalResultCount ?? 0) + finalDelta, sourceUpdatedAt: now, sourceUpdatedBy: uid,
    standingsPendingSince: pendingSince(competition, now), ...extra,
  });
  return sourceRevision;
}

export function finalRules(competition: Data): CompetitionRules {
  if (!competition.activeRules || !competition.activeRulesVersion) {
    domain('RULES_NOT_CONFIRMED', 'A competition manager must confirm the league rules before results become final.');
  }
  return competition.activeRules;
}

export const finalizeResult = command('finalizeResult', data => normalizeResultCommand(data, false, false), async (tx, data, uid, _actor, replay) => {
  const competition = await scorerContext(tx, data, uid, !replay);
  const { event, sides } = await competitionMatch(tx, competition, data.eventId);
  if (replay) return replay;
  const current = (await tx.get(competitionRef(data.orgId, data.competitionId).collection('results').doc(data.eventId))).data();
  if (current?.status === 'final') domain('RESULT_FINAL', 'This result is already final. Use a correction with a reason.');
  checkRevision(current, data.expectedRevision);
  const rules = finalRules(competition);
  if ((competition.finalResultCount ?? 0) >= MAX_FINAL_RESULTS) {
    domain('RESULT_LIMIT', `Competitions support at most ${MAX_FINAL_RESULTS} final results. Split the competition by division.`, 'resource-exhausted');
  }
  const now = Timestamp.now();
  const values = validate(data.result, sides, competition, rules);
  assertPlayable(event, values!, now);
  // Bracket progression reads before any write and only ever advances a finalized winner.
  const bracket = await bracketChange(tx, competition, data.eventId, sides, values!.winnerTeamId, now);
  if (bracket?.invalidated.length) requireBracketReview(bracket.invalidated);
  const written = writeResult(tx, competition, data.eventId, event, sides, current, 'finalize', {
    status: 'final',
    final: { ...values, appliedRulesVersion: competition.activeRulesVersion, finalizedBy: uid, finalizedAt: now, correctedAt: null },
  }, uid, data.requestId, now, null);
  const progressed = bracket ? writeBracketChange(tx, competition, bracket, 'progress', uid, now, null) : {};
  const sourceRevision = bumpSource(tx, competition, 1, uid, now, progressed);
  return { requestId: data.requestId, revision: written.revision, state: 'final', sourceRevision, operationId: written.operationId };
});

function requireBracketReview(invalidated: string[]): never {
  bracketDomain('BRACKET_CORRECTION_REQUIRED',
    'Later bracket games already started. Review the bracket correction preview and confirm the games it invalidates.', { invalidatedNodeIds: invalidated });
}

/**
 * Corrects a final result. When the winner of a linked bracket game changes, downstream games that have not started are
 * cleared automatically; started ones block unless the caller passes exactly the reviewed invalidation list.
 */
export async function correctFinal(tx: Transaction, competition: Data, data: Data, uid: string, confirmedInvalidation: string[] | null) {
  const current = (await tx.get(competitionRef(data.orgId, data.competitionId).collection('results').doc(data.eventId))).data();
  let match: Awaited<ReturnType<typeof competitionMatch>> | null = null;
  try {
    match = await competitionMatch(tx, competition, data.eventId);
  } catch (error) {
    // A final whose event no longer qualifies (type, teams or publication changed) can still be voided with its saved sides.
    if (current?.status !== 'final' || data.result?.outcome !== 'void') throw error;
  }
  if (current?.status !== 'final') domain('RESULT_NOT_FINAL', 'Only a final result can be corrected.');
  checkRevision(current, data.expectedRevision);
  const rules = finalRules(competition);
  const now = Timestamp.now();
  const sides = match?.sides ?? { homeTeamId: current!.homeTeamId as string, awayTeamId: current!.awayTeamId as string };
  const event = match?.event ?? { startsAt: current!.eventStartsAt ?? null };
  const values = validate(data.result, sides, competition, rules);
  if (match) assertPlayable(event, values!, now);
  if (sameResult(values!, current!.final) && current!.final.appliedRulesVersion === competition.activeRulesVersion) {
    domain('NO_CHANGE', 'The correction matches the current final result.', 'invalid-argument');
  }
  const bracket = await bracketChange(tx, competition, data.eventId, sides, values!.winnerTeamId, now);
  const invalidated = bracket?.invalidated ?? [];
  if (confirmedInvalidation === null) {
    if (invalidated.length) requireBracketReview(invalidated);
  } else if (!bracket || bracket.previousWinnerTeamId === bracket.winnerTeamId
    || JSON.stringify([...confirmedInvalidation].sort()) !== JSON.stringify([...invalidated].sort())) {
    bracketDomain('BRACKET_PREVIEW_CHANGED', 'The bracket changed since the correction preview. Review it again.', { invalidatedNodeIds: invalidated });
  }
  const written = writeResult(tx, competition, data.eventId, event, sides, current, 'correct', {
    status: 'final',
    final: {
      ...values, appliedRulesVersion: competition.activeRulesVersion, finalizedBy: current!.final.finalizedBy,
      finalizedAt: current!.final.finalizedAt, correctedBy: uid, correctedAt: now, correctionReason: data.reason,
    },
  }, uid, data.requestId, now, data.reason);
  const bracketFields = bracket ? writeBracketChange(tx, competition, bracket, 'correct', uid, now, data.reason) : {};
  const sourceRevision = bumpSource(tx, competition, 0, uid, now, bracketFields);
  return {
    requestId: data.requestId, revision: written.revision, state: 'final' as const, sourceRevision, operationId: written.operationId,
    ...(bracket ? { bracketRevision: (bracketFields.bracketRevision as number | undefined) ?? competition.bracketRevision ?? 0 } : {}),
  };
}

export const correctResult = command('correctResult', data => normalizeResultCommand(data, false, true), async (tx, data, uid, _actor, replay) => {
  const competition = await scorerContext(tx, data, uid, !replay);
  if (replay) {
    // Replays still require the event to belong to this competition, as before.
    await competitionMatch(tx, competition, data.eventId).catch(error => {
      if (replay.state !== 'final' || data.result?.outcome !== 'void') throw error;
    });
    return replay;
  }
  return correctFinal(tx, competition, data, uid, null);
});

function publicResult(result: Data | undefined) {
  if (!result) return null;
  return {
    eventId: result.eventId, status: result.status, revision: result.revision,
    homeTeamId: result.homeTeamId, awayTeamId: result.awayTeamId,
    proposal: result.proposal ?? null, final: result.final ?? null, updatedAt: result.updatedAt ?? null,
  };
}

function summary(competition: Data) {
  return {
    competitionId: competition.competitionId, name: competition.name, format: competition.format,
    programId: competition.programId, seasonId: competition.seasonId, divisionId: competition.divisionId,
    teamIds: competition.teamIds, revision: competition.revision, state: competition.state,
    activeRulesVersion: competition.activeRulesVersion ?? null, sourceRevision: competition.sourceRevision ?? 0,
    finalResultCount: competition.finalResultCount ?? 0,
    rulesState: competition.activeRules && sameRules(competition.activeRules, competition.draftRules) ? 'confirmed' : 'draft',
  };
}

export const listCompetitions = readCommand(data => {
  keys(data, ['orgId', 'programId']);
  return { orgId: id(data.orgId, 'orgId'), programId: id(data.programId, 'programId') };
}, async (tx, data, uid) => {
  await competitionStaff(tx, data.orgId, data.programId, uid);
  // saveCompetitionRules caps creation at LIST_LIMIT, so one bounded read returns the whole program list.
  const snap = await tx.get(db().collection(`organizations/${data.orgId}/competitions`)
    .where('programId', '==', data.programId).limit(LIST_LIMIT));
  return {
    competitions: snap.docs.map(doc => doc.data()).filter(row => row.schemaVersion === 2 && row.orgId === data.orgId)
      .map(summary).sort((a, b) => a.name.localeCompare(b.name) || a.competitionId.localeCompare(b.competitionId)),
  };
});

export const getCompetition = readCommand(data => {
  keys(data, ['orgId', 'competitionId', 'cursor']);
  return {
    orgId: id(data.orgId, 'orgId'), competitionId: id(data.competitionId, 'competitionId'),
    cursor: data.cursor == null ? null : id(data.cursor, 'cursor'),
  };
}, async (tx, data, uid) => {
  const competition = await loadCompetition(tx, data.orgId, data.competitionId);
  if (!competition) denied();
  await competitionStaff(tx, data.orgId, competition!.programId, uid);
  const ref = competitionRef(data.orgId, data.competitionId);
  // Matches in competition scope, ordered by start time then ID so pages are deterministic.
  let query = db().collection('events').where('orgId', '==', data.orgId).where('seasonId', '==', competition!.seasonId)
    .where('type', '==', 'match').orderBy('startsAt').orderBy(FieldPath.documentId());
  if (data.cursor) {
    const after = await tx.get(db().doc(`events/${data.cursor}`));
    if (!after.exists || after.data()?.orgId !== data.orgId) invalid('Invalid cursor.');
    query = query.startAfter(after);
  }
  const [versions, scanned, teams] = await Promise.all([
    tx.get(ref.collection('rulesVersions').orderBy('version', 'desc').limit(VERSION_PAGE)),
    tx.get(query.limit(MATCH_PAGE)),
    tx.getAll(...(competition!.teamIds as string[]).map(teamId => db().doc(`teams/${teamId}`))),
  ]);
  const matches = scanned.docs.filter(doc => {
    const event = doc.data();
    return event.schemaVersion === 2 && event.programId === competition!.programId && event.deletedAt == null
      && event.publicationState === 'published' && Array.isArray(event.teamIds) && event.teamIds.length === 2
      && event.teamIds.every((teamId: string) => competition!.teamIds.includes(teamId))
      && (competition!.divisionId === null || event.divisionId === competition!.divisionId);
  });
  const results = matches.length ? await tx.getAll(...matches.map(doc => ref.collection('results').doc(doc.id))) : [];
  return {
    competition: { ...summary(competition!), draftRules: competition!.draftRules, activeRules: competition!.activeRules ?? null },
    rulesVersions: versions.docs.map(doc => {
      const row = doc.data();
      return { version: row.version, rules: row.rules, confirmedBy: row.confirmedBy, confirmedAt: row.confirmedAt };
    }),
    teams: teams.map(team => ({ teamId: team.id, name: typeof team.data()?.name === 'string' ? team.data()!.name : 'Unavailable team' })),
    matches: matches.map((doc, i) => {
      const event = doc.data();
      return {
        eventId: doc.id, title: event.title ?? 'Match', startsAt: event.startsAt ?? null, status: event.status,
        homeTeamId: event.homeTeamId ?? event.teamIds[0], awayTeamId: event.awayTeamId ?? event.teamIds[1],
        result: publicResult(results[i].data()),
      };
    }),
    nextCursor: scanned.size === MATCH_PAGE ? scanned.docs[scanned.size - 1].id : null,
  };
});

/** Coach view of competitions containing this match. Final scores reach families through Step 6 publication, not here. */
export const getEventResults = readCommand(data => {
  keys(data, ['eventId', 'teamId']);
  return { eventId: id(data.eventId, 'eventId'), teamId: id(data.teamId, 'teamId') };
}, async (tx, data, uid) => {
  const { scope, event } = await coachingEvent(tx, data.eventId, data.teamId, uid, false);
  const external = event.type !== 'match' || !Array.isArray(event.teamIds) || event.teamIds.length !== 2;
  if (external) return { orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, competitions: [], externalOpponent: true };
  const snap = await tx.get(db().collection(`organizations/${scope.orgId}/competitions`)
    .where('teamIds', 'array-contains', data.teamId).limit(LIST_LIMIT));
  const competitions = snap.docs.map(doc => doc.data()).filter(row => row.schemaVersion === 2 && row.orgId === scope.orgId
    && row.state === 'active' && row.programId === event.programId && row.seasonId === event.seasonId
    && (row.divisionId === null || row.divisionId === event.divisionId)
    && event.teamIds.every((teamId: string) => row.teamIds.includes(teamId)));
  const [results, sideTeams] = await Promise.all([
    competitions.length
      ? tx.getAll(...competitions.map(row => competitionRef(scope.orgId, row.competitionId).collection('results').doc(data.eventId)))
      : Promise.resolve([]),
    tx.getAll(...(event.teamIds as string[]).map(teamId => db().doc(`teams/${teamId}`))),
  ]);
  return {
    orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, externalOpponent: false,
    homeTeamId: event.homeTeamId, awayTeamId: event.awayTeamId,
    teams: sideTeams.map(team => ({ teamId: team.id, name: typeof team.data()?.name === 'string' ? team.data()!.name : 'Unavailable team' })),
    competitions: competitions.map((row, i) => ({
      competitionId: row.competitionId, name: row.name, format: row.format,
      rules: row.activeRules
        ? { version: row.activeRulesVersion, allowDraws: row.activeRules.allowDraws, knockoutDeciders: row.activeRules.knockoutDeciders }
        : null,
      result: publicResult(results[i].data()),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
});
