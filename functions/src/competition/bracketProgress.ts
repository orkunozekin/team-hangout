import { FieldValue, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { Data } from '../commandSupport';
import { applyWinner, BracketNode } from './bracket';

const db = () => getFirestore();
const competitionRef = (orgId: string, competitionId: string) => db().doc(`organizations/${orgId}/competitions/${competitionId}`);
export const nodesRef = (competition: Data) => competitionRef(competition.orgId, competition.competitionId).collection('bracketNodes');

export function bracketDomain(code: string, message: string, details: Data = {}): never {
  throw new HttpsError('failed-precondition', message, { domainCode: code, ...details });
}

export function storedNode(row: Data): BracketNode {
  return {
    nodeId: row.nodeId, round: row.round, index: row.index, teamIds: row.teamIds, seeds: row.seeds, bye: row.bye === true,
    eventId: row.eventId ?? null, winnerTeamId: row.winnerTeamId ?? null, parentNodeId: row.parentNodeId ?? null, parentSlot: row.parentSlot ?? null,
  };
}

/** A node has started once its linked match began, completed or recorded any final result. Played history is never rewritten silently. */
export async function startedNodes(tx: Transaction, competition: Data, nodes: BracketNode[], now: Timestamp) {
  const linked = nodes.filter(node => node.eventId);
  if (!linked.length) return new Set<string>();
  const results = competitionRef(competition.orgId, competition.competitionId).collection('results');
  const reads = await tx.getAll(...linked.flatMap(node => [db().doc(`events/${node.eventId}`), results.doc(node.eventId!)]));
  const started = new Set<string>();
  linked.forEach((node, i) => {
    const event = reads[i * 2].data();
    const result = reads[i * 2 + 1].data();
    const began = event?.startsAt instanceof Timestamp && event.startsAt.toMillis() <= now.toMillis();
    if (node.winnerTeamId || began || event?.status === 'completed' || result?.status === 'final') started.add(node.nodeId);
  });
  return started;
}

/**
 * Reads the bracket node linked to a match and the ancestors a winner change would touch. Must run before any write in
 * the transaction. Returns null when the match is not linked to the published bracket.
 */
export async function bracketChange(tx: Transaction, competition: Data, eventId: string, sides: { homeTeamId: string; awayTeamId: string },
  winnerTeamId: string | null, now: Timestamp) {
  if (!competition.bracket?.bracketId) return null;
  const linked = await tx.get(nodesRef(competition).where('eventId', '==', eventId).limit(2));
  const doc = linked.docs.find(row => row.data().bracketId === competition.bracket.bracketId);
  if (!doc) return null;
  const node = storedNode(doc.data());
  if (!node.teamIds.includes(sides.homeTeamId) || !node.teamIds.includes(sides.awayTeamId)) {
    bracketDomain('BRACKET_EVENT_MISMATCH', 'The linked match teams no longer match this bracket game. Link the correct match first.', { nodeId: node.nodeId });
  }
  return chainChange(tx, competition, node, winnerTeamId, now);
}

/** Winner change for a known node: reads its ancestors and which affected games already started. */
export async function chainChange(tx: Transaction, competition: Data, node: BracketNode, winnerTeamId: string | null, now: Timestamp) {
  const chain: BracketNode[] = [node];
  for (let parentId = node.parentNodeId; parentId;) {
    const parent = (await tx.get(nodesRef(competition).doc(parentId))).data();
    if (!parent || parent.bracketId !== competition.bracket.bracketId) break;
    chain.push(storedNode(parent));
    parentId = parent.parentNodeId ?? null;
  }
  const nodes = new Map(chain.map(row => [row.nodeId, row]));
  const seeds = new Map((competition.bracket.seeds as string[]).map((teamId, i) => [teamId, i + 1]));
  const { changes, updated } = applyWinner(nodes, node.nodeId, winnerTeamId, teamId => seeds.get(teamId) ?? null);
  const affected = changes.map(change => nodes.get(change.nodeId)!);
  const started = await startedNodes(tx, competition, affected, now);
  return {
    node, previousWinnerTeamId: node.winnerTeamId, winnerTeamId, updated,
    affected: affected.map(row => ({
      nodeId: row.nodeId, round: row.round, index: row.index, eventId: row.eventId, winnerTeamId: row.winnerTeamId, started: started.has(row.nodeId),
    })),
    invalidated: affected.filter(row => started.has(row.nodeId)).map(row => row.nodeId),
  };
}

export type BracketChange = Awaited<ReturnType<typeof chainChange>>;

/**
 * Writes a winner change. Affected nodes that already started are recorded as voided plays (event and winner kept
 * in the node history and audit); unstarted links are simply cleared. Returns competition fields to merge into the
 * caller's single competition update.
 */
export function writeBracketChange(tx: Transaction, competition: Data, change: BracketChange, kind: 'progress' | 'correct',
  uid: string, now: Timestamp, reason: string | null): Data {
  if (change.previousWinnerTeamId === change.winnerTeamId) return {};
  const ref = competitionRef(competition.orgId, competition.competitionId);
  const history = ref.collection('bracketHistory').doc();
  const before = new Map(change.affected.map(row => [row.nodeId, row]));
  for (const node of change.updated) {
    const prior = before.get(node.nodeId);
    const patch: Data = {
      teamIds: node.teamIds, seeds: node.seeds, winnerTeamId: node.winnerTeamId, eventId: node.eventId,
      revision: (competition.bracketRevision ?? 0) + 1, updatedAt: now, updatedBy: uid,
    };
    if (prior?.eventId) {
      // The linked match no longer has valid participants for this node.
      tx.delete(db().doc(`events/${prior.eventId}/bracketLinks/${competition.competitionId}`));
      if (prior.started) {
        patch.voidedPlays = FieldValue.arrayUnion({
          eventId: prior.eventId, winnerTeamId: prior.winnerTeamId, operationId: history.id, voidedAt: now,
        });
      }
    }
    tx.update(nodesRef(competition).doc(node.nodeId), patch);
  }
  tx.create(history, {
    schemaVersion: 2, orgId: competition.orgId, competitionId: competition.competitionId, bracketId: competition.bracket.bracketId,
    operationId: history.id, kind, nodeId: change.node.nodeId, eventId: change.node.eventId,
    beforeWinnerTeamId: change.previousWinnerTeamId, afterWinnerTeamId: change.winnerTeamId,
    affected: change.affected, invalidatedNodeIds: change.invalidated, reason, actorUid: uid, createdAt: now,
    beforeRevision: competition.bracketRevision ?? 0, afterRevision: (competition.bracketRevision ?? 0) + 1,
  });
  return { bracketRevision: (competition.bracketRevision ?? 0) + 1, 'bracket.updatedAt': now };
}
