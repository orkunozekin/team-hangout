import {
  assertRulesFitFormat,
  CompetitionRuleError,
  normalizeResultValues,
  normalizeRules,
  sameResult,
  sameRules,
} from '../../../functions/src/competition/rules';
import { draftRulesTemplate, describeResult } from '../../../shared/competition';

const sides = { homeTeamId: 'home', awayTeamId: 'away' };
const rules = { ...draftRulesTemplate(), forfeitScore: { winner: 3, loser: 0 }, knockoutDeciders: ['penalties' as const] };
const result = (patch: Record<string, unknown> = {}) => ({
  outcome: 'played', homeScore: 1, awayScore: 0, forfeitingTeamId: null, winnerTeamId: null, decider: null, ...patch,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CompetitionRuleError);
    return (error as CompetitionRuleError).code;
  }
  throw new Error('expected a rule error');
};

test('rules need every explicit field and reject a sport shortcut or impossible policy', () => {
  expect(normalizeRules(rules)).toEqual({ ...rules, knockoutDeciders: ['penalties'] });
  expect(code(() => normalizeRules({ ...rules, sport: 'soccer' }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ sport: 'soccer' }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, rulesSchemaVersion: 2 }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, points: { ...rules.points, win: 1.5 } }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, points: { ...rules.points, win: 0, loss: 1 } }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, allowDraws: false }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, forfeitScore: { winner: 0, loser: 0 } }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, tieBreakers: ['wins', 'wins'] }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, tieBreakers: ['fairPlay'] }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, scoreDifferentialCap: 0 }))).toBe('INVALID_RULES');
  expect(code(() => normalizeRules({ ...rules, allowDraws: 'yes' }))).toBe('INVALID_RULES');
  // Manager tie-break order is kept; set-like lists normalize so equal policies compare equal.
  const ordered = normalizeRules({ ...rules, tieBreakers: ['wins', 'tablePoints'], countedOutcomes: ['forfeit', 'played'] });
  expect(ordered.tieBreakers).toEqual(['wins', 'tablePoints']);
  expect(sameRules(ordered, { ...ordered, countedOutcomes: ['played', 'forfeit'] })).toBe(true);
  expect(sameRules(ordered, null)).toBe(false);
  expect(() => assertRulesFitFormat(normalizeRules({ ...rules, knockoutDeciders: [] }), 'league')).not.toThrow();
  expect(code(() => assertRulesFitFormat(normalizeRules({ ...rules, knockoutDeciders: [] }), 'knockout'))).toBe('INVALID_RULES');
  expect(code(() => assertRulesFitFormat(normalizeRules(rules), 'knockout'))).toBe('INVALID_RULES');
});

test('result table covers played, draw, forfeit, void and knockout deciders', () => {
  const confirmed = normalizeRules(rules);
  expect(normalizeResultValues(result(), sides, 'league', confirmed).winnerTeamId).toBe('home');
  expect(normalizeResultValues(result({ homeScore: 2, awayScore: 2 }), sides, 'league', confirmed).winnerTeamId).toBeNull();
  expect(code(() => normalizeResultValues(result({ homeScore: 2, awayScore: 2, winnerTeamId: 'home', decider: 'penalties' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  const noDraws = normalizeRules({ ...rules, allowDraws: false, points: { ...rules.points, draw: 0 } });
  expect(code(() => normalizeResultValues(result({ awayScore: 1 }), sides, 'league', noDraws))).toBe('DRAW_NOT_ALLOWED');
  expect(normalizeResultValues(result({ awayScore: 1, winnerTeamId: 'away', decider: 'penalties' }), sides, 'league', noDraws).decider).toBe('penalties');
  expect(code(() => normalizeResultValues(result({ awayScore: 1 }), sides, 'knockout', confirmed))).toBe('INVALID_KNOCKOUT_DRAW');
  expect(code(() => normalizeResultValues(result({ awayScore: 1, winnerTeamId: 'home', decider: 'shootout' }), sides, 'knockout', confirmed))).toBe('INVALID_KNOCKOUT_DRAW');
  expect(code(() => normalizeResultValues(result({ awayScore: 1, winnerTeamId: 'other', decider: 'penalties' }), sides, 'knockout', confirmed))).toBe('INVALID_RESULT');
  // Before confirmation a proposal may name any supported decider; the scorer validates with confirmed rules.
  expect(normalizeResultValues(result({ awayScore: 1, winnerTeamId: 'home', decider: 'shootout' }), sides, 'knockout', null).winnerTeamId).toBe('home');
  expect(code(() => normalizeResultValues(result({ winnerTeamId: 'away' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ homeScore: -1 }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ homeScore: 1000 }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ forfeitingTeamId: 'home' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ outcome: 'abandoned' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues({ ...result(), extra: 1 }, sides, 'league', confirmed))).toBe('INVALID_RESULT');

  const forfeit = normalizeResultValues(result({ outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: 'away' }), sides, 'league', confirmed);
  expect(forfeit).toEqual({ outcome: 'forfeit', homeScore: 3, awayScore: 0, forfeitingTeamId: 'away', winnerTeamId: 'home', decider: null });
  const proposedForfeit = normalizeResultValues(result({ outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: 'home' }), sides, 'league', null);
  expect([proposedForfeit.homeScore, proposedForfeit.winnerTeamId]).toEqual([null, 'away']);
  expect(code(() => normalizeResultValues(result({ outcome: 'forfeit', forfeitingTeamId: 'home' }), sides, 'league', null))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: 'nobody' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(code(() => normalizeResultValues(result({ outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: 'home', winnerTeamId: 'home' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');

  const voided = normalizeResultValues(result({ outcome: 'void', homeScore: null, awayScore: null }), sides, 'knockout', confirmed);
  expect(voided.winnerTeamId).toBeNull();
  expect(code(() => normalizeResultValues(result({ outcome: 'void' }), sides, 'league', confirmed))).toBe('INVALID_RESULT');
  expect(sameResult(voided, { ...voided })).toBe(true);
  expect(sameResult(voided, forfeit)).toBe(false);
  expect(code(() => normalizeResultValues(null, sides, 'league', confirmed))).toBe('INVALID_RESULT');

  const name = (teamId: string) => (teamId === 'home' ? 'Hawks' : 'Owls');
  expect(describeResult(forfeit, name)).toBe('Forfeit by Owls (3-0)');
  expect(describeResult(proposedForfeit, name)).toBe('Forfeit by Hawks');
  expect(describeResult(voided, name)).toBe('Void, no result counted');
  expect(describeResult({ ...result({ awayScore: 1, winnerTeamId: 'away', decider: 'penalties' }) } as never, name)).toBe('1-1, Owls won on penalties');
});
