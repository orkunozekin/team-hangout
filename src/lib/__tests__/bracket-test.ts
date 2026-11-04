import {
  applyWinner, buildBracket, nodeState, overrideSeeds, seedPositions, standingsSeeds, winnerImpact, type BracketNode,
} from '../../../functions/src/competition/bracket';

const teams = (count: number) => Array.from({ length: count }, (_, i) => `t${i + 1}`);
const byId = (nodes: BracketNode[]) => new Map(nodes.map(node => [node.nodeId, node]));
const firstRound = (nodes: BracketNode[]) => nodes.filter(node => node.round === 1).map(node => [node.teamIds, node.bye]);

test('seed positions keep top seeds apart until the final', () => {
  expect(seedPositions(2)).toEqual([1, 2]);
  expect(seedPositions(4)).toEqual([1, 4, 2, 3]);
  expect(seedPositions(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
});

test('three teams: the top seed gets the only bye and advances without a game', () => {
  const nodes = buildBracket(teams(3));
  expect(nodes.map(node => node.nodeId)).toEqual(['r1-01', 'r1-02', 'r2-01']);
  expect(firstRound(nodes)).toEqual([[['t1', null], true], [['t2', 't3'], false]]);
  const final = byId(nodes).get('r2-01')!;
  expect(final.teamIds).toEqual(['t1', null]);
  expect(final.seeds).toEqual([1, null]);
  expect(nodes.filter(node => node.bye).every(node => node.eventId === null && node.winnerTeamId === node.teamIds[0])).toBe(true);
  expect(nodes.map(nodeState)).toEqual(['bye', 'ready', 'waiting']);
});

test('five teams: three byes for seeds 1 to 3 and one real first-round game', () => {
  const nodes = buildBracket(teams(5));
  expect(firstRound(nodes)).toEqual([
    [['t1', null], true], [['t4', 't5'], false], [['t2', null], true], [['t3', null], true],
  ]);
  const map = byId(nodes);
  expect(map.get('r2-01')!.teamIds).toEqual(['t1', null]);
  expect(map.get('r2-02')!.teamIds).toEqual(['t2', 't3']);
  expect(nodeState(map.get('r2-02')!)).toBe('ready');
  expect(nodes.filter(node => !node.bye)).toHaveLength(4);
});

test('eight teams: no byes, seven games over three rounds', () => {
  const nodes = buildBracket(teams(8));
  expect(nodes.filter(node => node.bye)).toHaveLength(0);
  expect(firstRound(nodes).map(([pair]) => pair)).toEqual([['t1', 't8'], ['t4', 't5'], ['t2', 't7'], ['t3', 't6']]);
  expect(nodes.find(node => node.round === 3)!.parentNodeId).toBeNull();
});

test('bracket size and duplicate seeds are rejected', () => {
  expect(() => buildBracket(['t1'])).toThrow(expect.objectContaining({ code: 'BRACKET_LIMIT' }));
  expect(() => buildBracket(teams(129))).toThrow(expect.objectContaining({ code: 'BRACKET_LIMIT' }));
  expect(() => buildBracket(['t1', 't1'])).toThrow(expect.objectContaining({ code: 'INVALID_SEEDS' }));
  expect(buildBracket(teams(128))).toHaveLength(127);
});

test('standings seed by position and report shared ranks among bracket teams only', () => {
  const rows = [
    { teamId: 'a', position: 1, sharedRank: false, tiedWith: [] },
    { teamId: 'b', position: 2, sharedRank: true, tiedWith: ['b', 'c'] },
    { teamId: 'c', position: 3, sharedRank: true, tiedWith: ['b', 'c'] },
    { teamId: 'd', position: 4, sharedRank: true, tiedWith: ['d', 'x'] },
  ];
  expect(standingsSeeds(rows, ['c', 'a', 'b'])).toEqual({ seeds: ['a', 'b', 'c'], unresolvedTies: [['b', 'c']] });
  // d is tied only with a team outside the bracket, so its seed is not ambiguous.
  expect(standingsSeeds(rows, ['a', 'd'])).toEqual({ seeds: ['a', 'd'], unresolvedTies: [] });
  expect(() => standingsSeeds(rows, ['a', 'z'])).toThrow(expect.objectContaining({ code: 'SEED_SOURCE_MISMATCH' }));
  expect(overrideSeeds(['c', 'b', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  expect(() => overrideSeeds(['a', 'a', 'b'], ['a', 'b', 'c'])).toThrow(expect.objectContaining({ code: 'INVALID_SEEDS' }));
});

test('first winner fills only the parent slot; a repeated winner is a no-op', () => {
  const nodes = byId(buildBracket(teams(4)));
  const seeds = (teamId: string) => Number(teamId.slice(1));
  const first = applyWinner(nodes, 'r1-01', 't4', seeds);
  expect(first.changes).toEqual([{ nodeId: 'r2-01', slot: 0, teamId: 't4' }]);
  const next = byId([...nodes.values()].map(node => first.updated.find(row => row.nodeId === node.nodeId) ?? node));
  expect(next.get('r2-01')!.seeds).toEqual([4, null]);
  expect(winnerImpact(next, 'r1-01', 't4')).toEqual([]);
});

test('a corrected winner clears every later game the old winner reached', () => {
  const state = byId(buildBracket(teams(8)));
  const set = (id: string, patch: Partial<BracketNode>) => state.set(id, { ...state.get(id)!, ...patch });
  set('r1-01', { winnerTeamId: 't1', eventId: 'e1' });
  set('r1-02', { winnerTeamId: 't4', eventId: 'e2' });
  set('r2-01', { teamIds: ['t1', 't4'], winnerTeamId: 't1', eventId: 'e5' });
  set('r3-01', { teamIds: ['t1', null], eventId: null });
  const { changes, updated } = applyWinner(state, 'r1-01', 't8', () => null);
  expect(changes).toEqual([{ nodeId: 'r2-01', slot: 0, teamId: 't8' }, { nodeId: 'r3-01', slot: 0, teamId: null }]);
  const semi = updated.find(node => node.nodeId === 'r2-01')!;
  expect([semi.teamIds, semi.winnerTeamId, semi.eventId]).toEqual([['t8', 't4'], null, null]);
  // Inputs are not mutated, so a rejected correction leaves the read state intact.
  expect(state.get('r2-01')!.winnerTeamId).toBe('t1');
  // A voided winner clears the parent slot without inventing a team.
  expect(winnerImpact(state, 'r1-02', null)).toEqual([{ nodeId: 'r2-01', slot: 1, teamId: null }, { nodeId: 'r3-01', slot: 0, teamId: null }]);
});
