import type { CompetitionRules } from '../../../functions/src/competition/rules';
import { computeStandings, type FinalResultInput } from '../../../functions/src/competition/standings';
import { draftRulesTemplate, tieNote } from '../../../shared/competition';

/** Synthetic policy for tests only; it is not a sport standard. */
const rules: CompetitionRules = { ...draftRulesTemplate(), forfeitScore: { winner: 3, loser: 0 } };
let seq = 0;
const game = (home: string, homeScore: number, away: string, awayScore: number, extra: Partial<FinalResultInput> = {}): FinalResultInput => ({
  eventId: `m${String(++seq).padStart(3, '0')}`, homeTeamId: home, awayTeamId: away, outcome: 'played', homeScore, awayScore,
  forfeitingTeamId: null, winnerTeamId: homeScore > awayScore ? home : homeScore < awayScore ? away : null, decider: null, ...extra,
});
const summary = (teams: string[], results: FinalResultInput[], with_: CompetitionRules = rules) =>
  computeStandings(teams, results, with_).rows.map(row => [row.teamId, row.rank, row.points, row.differential, row.decidedBy, row.sharedRank]);

test('three-way tie applies criteria to the original cohort in order without recursive head-to-head', () => {
  // Hand calculation: A, B and C each have 6 points and 3 head-to-head points. Differential A +2, B +2, C +1.
  // A and B continue with scores for (A 3, B 4), so B ranks first even though A beat B head-to-head.
  const results = [game('A', 2, 'B', 0), game('B', 1, 'C', 0), game('C', 1, 'A', 0), game('A', 1, 'D', 0), game('B', 3, 'D', 0), game('C', 1, 'D', 0)];
  expect(summary(['D', 'C', 'B', 'A'], results)).toEqual([
    ['B', 1, 6, 2, 'scoresFor', false],
    ['A', 2, 6, 2, 'scoresFor', false],
    ['C', 3, 6, 1, 'scoreDifferential', false],
    ['D', 4, 0, -5, 'tablePoints', false],
  ]);
});

test('incomplete head-to-head is marked not applicable and equal records share a rank', () => {
  // A and C never met, so head-to-head cannot apply; every other criterion is equal, leaving explicit shared ranks.
  const table = computeStandings(['C', 'A', 'D', 'B'], [game('A', 1, 'B', 0), game('C', 1, 'D', 0)], rules);
  expect(table.rows.map(row => [row.teamId, row.rank, row.position, row.sharedRank, row.tiedWith])).toEqual([
    ['A', 1, 1, true, ['A', 'C']],
    ['C', 1, 2, true, ['A', 'C']],
    ['B', 3, 3, true, ['B', 'D']],
    ['D', 3, 4, true, ['B', 'D']],
  ]);
  expect(table.unresolvedTies).toBe(2);
  expect(table.rows.every(row => row.notApplicable.includes('headToHeadPoints') && row.decidedBy === null)).toBe(true);
  expect(tieNote(table.rows[0], teamId => `Team ${teamId}`)).toBe('Tied with Team C; all tie-breakers exhausted. Head-to-head points (whole tied group) not applicable');
});

test('head-to-head separates a cohort when every pair met the same number of times', () => {
  // A and B both have 3 points and met once (A won), so head-to-head ranks A above B despite B's better differential.
  const results = [game('A', 1, 'B', 0), game('C', 1, 'A', 0), game('B', 5, 'D', 0), game('C', 1, 'D', 0)];
  expect(summary(['A', 'B', 'C', 'D'], results).map(row => [row[0], row[4]])).toEqual([
    ['C', 'tablePoints'], ['A', 'headToHeadPoints'], ['B', 'headToHeadPoints'], ['D', 'tablePoints'],
  ]);
  const tied = [game('A', 2, 'B', 1), game('B', 3, 'C', 0), game('C', 1, 'A', 0), game('B', 2, 'A', 2), game('A', 1, 'C', 1), game('C', 0, 'B', 0)];
  // Each pair met twice. Points A 5, B 5, C 5. Head-to-head equals table points here, so differential decides: B +2, A 0, C -2.
  expect(summary(['A', 'B', 'C'], tied).map(row => [row[0], row[4]])).toEqual([['B', 'scoreDifferential'], ['A', 'scoreDifferential'], ['C', 'scoreDifferential']]);
});

test('score differential cap applies per result before aggregation', () => {
  const capped = { ...rules, scoreDifferentialCap: 3 };
  const results = [game('A', 7, 'B', 0), game('C', 4, 'B', 0)];
  // Capped: A +3 and C +3 tie, scores for decides (A 7, C 4). B is -6 rather than -11.
  expect(summary(['A', 'B', 'C'], results, capped)).toEqual([
    ['A', 1, 3, 3, 'scoresFor', false],
    ['C', 2, 3, 3, 'scoresFor', false],
    ['B', 3, 0, -6, 'tablePoints', false],
  ]);
  expect(summary(['A', 'B', 'C'], results).map(row => [row[0], row[3], row[4]])).toEqual([['A', 7, 'scoreDifferential'], ['C', 4, 'scoreDifferential'], ['B', -11, 'tablePoints']]);
});

test('forfeits use league policy and stay marked; void and uncounted outcomes add nothing', () => {
  const forfeit = game('A', 0, 'B', 3, { outcome: 'forfeit', forfeitingTeamId: 'A', winnerTeamId: 'B' });
  const results = [forfeit, game('A', 1, 'C', 1), { ...game('B', 0, 'C', 0), outcome: 'void' as const, homeScore: null, awayScore: null }];
  const rows = computeStandings(['A', 'B', 'C'], results, rules).rows;
  const b = rows.find(row => row.teamId === 'B')!;
  const a = rows.find(row => row.teamId === 'A')!;
  expect([b.points, b.wins, b.forfeitWins, b.played, b.scoresFor]).toEqual([3, 1, 1, 1, 3]);
  expect([a.points, a.losses, a.forfeitLosses, a.draws, a.played]).toEqual([1, 1, 1, 1, 2]);
  const playedOnly = computeStandings(['A', 'B', 'C'], results, { ...rules, countedOutcomes: ['played'] });
  expect(playedOnly.countedResults).toBe(1);
  expect(playedOnly.rows.find(row => row.teamId === 'B')!.played).toBe(0);
});

test('a decided tied score awards win and loss points, not a draw', () => {
  const noDraws = { ...rules, allowDraws: false, points: { ...rules.points, draw: 0 }, knockoutDeciders: ['penalties' as const] };
  const rows = computeStandings(['A', 'B'], [game('A', 1, 'B', 1, { winnerTeamId: 'B', decider: 'penalties' })], noDraws).rows;
  expect(rows.map(row => [row.teamId, row.points, row.wins, row.draws])).toEqual([['B', 3, 1, 0], ['A', 0, 0, 0]]);
});

test('randomized replay order reproduces the identical table', () => {
  let state = 20261029;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const teams = Array.from({ length: 8 }, (_, i) => `T${i}`);
  const results: FinalResultInput[] = [];
  for (let i = 0; i < 60; i++) {
    const home = teams[Math.floor(random() * 8)];
    const away = teams.filter(team => team !== home)[Math.floor(random() * 7)];
    const kind = random();
    if (kind < 0.1) results.push(game(home, 0, away, 3, { outcome: 'forfeit', forfeitingTeamId: home, winnerTeamId: away }));
    else if (kind < 0.15) results.push({ ...game(home, 0, away, 0), outcome: 'void', homeScore: null, awayScore: null, winnerTeamId: null });
    else results.push(game(home, Math.floor(random() * 6), away, Math.floor(random() * 6)));
  }
  const capped = { ...rules, scoreDifferentialCap: 3 };
  const expected = computeStandings(teams, results, capped);
  for (let i = 0; i < 25; i++) {
    const shuffled = [...results].sort(() => random() - 0.5);
    expect(computeStandings([...teams].reverse(), shuffled, capped)).toEqual(expected);
  }
  // Totals reconcile: every counted result contributes one played game to each side.
  expect(expected.rows.reduce((sum, row) => sum + row.played, 0)).toBe(expected.countedResults * 2);
});

test('a competition with no results is one explicit unresolved tie', () => {
  const table = computeStandings(['B', 'A'], [], rules);
  expect(table.rows.map(row => [row.teamId, row.rank, row.sharedRank])).toEqual([['A', 1, true], ['B', 1, true]]);
});
