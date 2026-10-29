/**
 * Pure single-elimination bracket rules. No Firebase imports so seeding, byes and correction impact are unit tested
 * directly. Byes are nodes without an event: they never create a game, score, attendance or facility demand.
 */
export const MAX_BRACKET_TEAMS = 128;
export const BRACKET_SCHEMA_VERSION = 1;

export type BracketNode = {
  nodeId: string;
  round: number;
  index: number;
  teamIds: [string | null, string | null];
  seeds: [number | null, number | null];
  bye: boolean;
  eventId: string | null;
  winnerTeamId: string | null;
  parentNodeId: string | null;
  parentSlot: 0 | 1 | null;
};

export type NodeState = 'bye' | 'waiting' | 'ready' | 'scheduled' | 'decided';

export type StandingsSeedRow = { teamId: string; position: number; sharedRank: boolean; tiedWith: string[] };

export class BracketRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const fail = (code: string, message: string): never => { throw new BracketRuleError(code, message); };

export const nodeId = (round: number, index: number) => `r${round}-${String(index + 1).padStart(2, '0')}`;

/** Standard seed positions, so the top seeds meet as late as possible and receive the byes. */
export function seedPositions(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap(seed => [seed, next + 1 - seed]);
  }
  return order;
}

/** Builds every node for seeded teams (index 0 is seed 1). Byes advance their team at build time. */
export function buildBracket(seededTeamIds: string[]): BracketNode[] {
  const count = seededTeamIds.length;
  if (count < 2 || count > MAX_BRACKET_TEAMS) fail('BRACKET_LIMIT', `Brackets need 2 to ${MAX_BRACKET_TEAMS} teams. Split larger groups into divisions.`);
  if (new Set(seededTeamIds).size !== count) fail('INVALID_SEEDS', 'Each team can be seeded once.');
  let size = 2;
  while (size < count) size *= 2;
  const rounds = Math.log2(size);
  const positions = seedPositions(size);
  const nodes: BracketNode[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const matches = size / 2 ** round;
    for (let index = 0; index < matches; index += 1) {
      nodes.push({
        nodeId: nodeId(round, index), round, index, teamIds: [null, null], seeds: [null, null], bye: false, eventId: null, winnerTeamId: null,
        parentNodeId: round < rounds ? nodeId(round + 1, Math.floor(index / 2)) : null,
        parentSlot: round < rounds ? (index % 2) as 0 | 1 : null,
      });
    }
  }
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (let index = 0; index < size / 2; index += 1) {
    const node = byId.get(nodeId(1, index))!;
    const pair = [positions[index * 2], positions[index * 2 + 1]];
    pair.forEach((seed, slot) => {
      if (seed <= count) {
        node.teamIds[slot] = seededTeamIds[seed - 1];
        node.seeds[slot] = seed;
      }
    });
    if (node.teamIds[1] === null) {
      // Only the higher seed can face a missing seed because count is more than half the bracket size.
      node.bye = true;
      node.winnerTeamId = node.teamIds[0];
      const parent = byId.get(node.parentNodeId!)!;
      parent.teamIds[node.parentSlot!] = node.teamIds[0];
      parent.seeds[node.parentSlot!] = node.seeds[0];
    }
  }
  return nodes;
}

export function nodeState(node: Pick<BracketNode, 'bye' | 'teamIds' | 'eventId' | 'winnerTeamId'>): NodeState {
  if (node.bye) return 'bye';
  if (node.winnerTeamId) return 'decided';
  if (!node.teamIds[0] || !node.teamIds[1]) return 'waiting';
  return node.eventId ? 'scheduled' : 'ready';
}

/**
 * Seeds from one complete standings generation. Teams that share a rank with another bracket team cannot be ordered
 * by standings, so seeding blocks until a manager records an explicit, reasoned order.
 */
export function standingsSeeds(rows: StandingsSeedRow[], teamIds: string[]) {
  const members = new Set(teamIds);
  const ordered = rows.filter(row => members.has(row.teamId)).sort((a, b) => a.position - b.position);
  if (ordered.length !== members.size) fail('SEED_SOURCE_MISMATCH', 'Every bracket team needs a row in the seeding standings.');
  const groups = new Map<string, string[]>();
  for (const row of ordered) {
    if (!row.sharedRank) continue;
    const tied = row.tiedWith.filter(teamId => members.has(teamId)).sort();
    if (tied.length > 1) groups.set(tied.join(','), tied);
  }
  return { seeds: ordered.map(row => row.teamId), unresolvedTies: [...groups.values()] };
}

/** A manager override must order exactly the bracket teams. */
export function overrideSeeds(order: unknown, teamIds: string[]): string[] {
  if (!Array.isArray(order) || order.length !== teamIds.length || new Set(order).size !== order.length
    || !order.every(teamId => typeof teamId === 'string' && teamIds.includes(teamId))) {
    fail('INVALID_SEEDS', 'A seed order must list every bracket team exactly once.');
  }
  return order as string[];
}

export type ImpactChange = { nodeId: string; slot: 0 | 1; teamId: string | null };

/**
 * Changing a node's winner rewrites the slot it fed, and every later node the old winner had already reached.
 * Each affected node loses its winner and event link. Returns them nearest first.
 */
export function winnerImpact(nodes: Map<string, BracketNode>, changedNodeId: string, winnerTeamId: string | null): ImpactChange[] {
  const node = nodes.get(changedNodeId);
  if (!node) return [];
  if (node.winnerTeamId === winnerTeamId) return [];
  const changes: ImpactChange[] = [];
  let child = node;
  let previous = node.winnerTeamId;
  let next = winnerTeamId;
  while (child.parentNodeId && child.parentSlot !== null) {
    const parent = nodes.get(child.parentNodeId);
    if (!parent || parent.teamIds[child.parentSlot] !== previous) break;
    changes.push({ nodeId: parent.nodeId, slot: child.parentSlot, teamId: next });
    if (!parent.winnerTeamId) break;
    // The parent's winner was decided with an invalid participant, so it no longer advances either.
    previous = parent.winnerTeamId;
    next = null;
    child = parent;
  }
  return changes;
}

/** Applies a winner and its impact to copies of the nodes. Seeds travel with their team. */
export function applyWinner(nodes: Map<string, BracketNode>, changedNodeId: string, winnerTeamId: string | null, seedOf: (teamId: string) => number | null) {
  const changes = winnerImpact(nodes, changedNodeId, winnerTeamId);
  const updated = new Map<string, BracketNode>();
  const copy = (id: string) => updated.get(id) ?? { ...nodes.get(id)!, teamIds: [...nodes.get(id)!.teamIds] as BracketNode['teamIds'], seeds: [...nodes.get(id)!.seeds] as BracketNode['seeds'] };
  const changed = copy(changedNodeId);
  changed.winnerTeamId = winnerTeamId;
  updated.set(changedNodeId, changed);
  for (const change of changes) {
    const node = copy(change.nodeId);
    node.teamIds[change.slot] = change.teamId;
    node.seeds[change.slot] = change.teamId ? seedOf(change.teamId) : null;
    node.winnerTeamId = null;
    node.eventId = null;
    updated.set(change.nodeId, node);
  }
  return { changes, updated: [...updated.values()] };
}
