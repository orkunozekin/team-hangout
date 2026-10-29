/**
 * Pure competition rules and result validation. No Firebase imports so backend and native tests can reuse it.
 * Keep wire shapes aligned with shared/competition.ts.
 */
export type CompetitionFormat = 'league' | 'knockout';
export type ResultOutcome = 'played' | 'forfeit' | 'void';
export type TieBreaker = 'tablePoints' | 'headToHeadPoints' | 'scoreDifferential' | 'scoresFor' | 'wins';
export type KnockoutDecider = 'extraTime' | 'penalties' | 'shootout';

export type CompetitionRules = {
  rulesSchemaVersion: 1;
  points: { win: number; draw: number; loss: number; forfeitWin: number; forfeitLoss: number };
  allowDraws: boolean;
  forfeitScore: { winner: number; loser: number };
  countedOutcomes: ('played' | 'forfeit')[];
  tieBreakers: TieBreaker[];
  /** Applied per result before aggregation; null means uncapped. */
  scoreDifferentialCap: number | null;
  knockoutDeciders: KnockoutDecider[];
};

export type CompetitionResultValues = {
  outcome: ResultOutcome;
  homeScore: number | null;
  awayScore: number | null;
  forfeitingTeamId: string | null;
  winnerTeamId: string | null;
  decider: KnockoutDecider | null;
};

export type RuleErrorCode = 'INVALID_RULES' | 'INVALID_RESULT' | 'DRAW_NOT_ALLOWED' | 'INVALID_KNOCKOUT_DRAW';

export class CompetitionRuleError extends Error {
  constructor(public readonly code: RuleErrorCode, message: string) {
    super(message);
    this.name = 'CompetitionRuleError';
  }
}

export const TIE_BREAKERS: TieBreaker[] = ['tablePoints', 'headToHeadPoints', 'scoreDifferential', 'scoresFor', 'wins'];
export const KNOCKOUT_DECIDERS: KnockoutDecider[] = ['extraTime', 'penalties', 'shootout'];
export const MAX_POINTS = 100;
export const MAX_SCORE = 999;

type Raw = Record<string, unknown>;

function fail(code: RuleErrorCode, message: string): never {
  throw new CompetitionRuleError(code, message);
}

function record(value: unknown, label: string, code: RuleErrorCode): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `Invalid ${label}.`);
  return value as Raw;
}

function exact(value: Raw, fields: string[], label: string, code: RuleErrorCode) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(code, `Invalid ${label} fields.`);
}

function int(value: unknown, max: number, label: string, code: RuleErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(code, `${label} must be a whole number from 0 to ${max}.`);
  return value as number;
}

function list<T extends string>(value: unknown, allowed: T[], label: string, min: number): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > allowed.length) fail('INVALID_RULES', `Invalid ${label}.`);
  const items = value as unknown[];
  if (items.some(item => !allowed.includes(item as T)) || new Set(items).size !== items.length) fail('INVALID_RULES', `Invalid ${label}.`);
  return items as T[];
}

/**
 * Every rule is explicit. Nothing is inferred from a sport name; the manager confirms actual league policy.
 */
export function normalizeRules(value: unknown): CompetitionRules {
  const raw = record(value, 'rules', 'INVALID_RULES');
  exact(raw, ['rulesSchemaVersion', 'points', 'allowDraws', 'forfeitScore', 'countedOutcomes', 'tieBreakers', 'scoreDifferentialCap', 'knockoutDeciders'], 'rules', 'INVALID_RULES');
  if (raw.rulesSchemaVersion !== 1) fail('INVALID_RULES', 'Unsupported rules version. Update the app and try again.');
  const points = record(raw.points, 'points', 'INVALID_RULES');
  exact(points, ['win', 'draw', 'loss', 'forfeitWin', 'forfeitLoss'], 'points', 'INVALID_RULES');
  const forfeitScore = record(raw.forfeitScore, 'forfeit score', 'INVALID_RULES');
  exact(forfeitScore, ['winner', 'loser'], 'forfeit score', 'INVALID_RULES');
  if (typeof raw.allowDraws !== 'boolean') fail('INVALID_RULES', 'Choose whether draws are allowed.');
  const normalized: CompetitionRules = {
    rulesSchemaVersion: 1,
    points: {
      win: int(points.win, MAX_POINTS, 'Win points', 'INVALID_RULES'),
      draw: int(points.draw, MAX_POINTS, 'Draw points', 'INVALID_RULES'),
      loss: int(points.loss, MAX_POINTS, 'Loss points', 'INVALID_RULES'),
      forfeitWin: int(points.forfeitWin, MAX_POINTS, 'Forfeit win points', 'INVALID_RULES'),
      forfeitLoss: int(points.forfeitLoss, MAX_POINTS, 'Forfeit loss points', 'INVALID_RULES'),
    },
    allowDraws: raw.allowDraws,
    forfeitScore: {
      winner: int(forfeitScore.winner, MAX_SCORE, 'Forfeit winner score', 'INVALID_RULES'),
      loser: int(forfeitScore.loser, MAX_SCORE, 'Forfeit loser score', 'INVALID_RULES'),
    },
    countedOutcomes: list(raw.countedOutcomes, ['played', 'forfeit'], 'counted outcomes', 1),
    tieBreakers: list(raw.tieBreakers, TIE_BREAKERS, 'tie-breakers', 1),
    scoreDifferentialCap: raw.scoreDifferentialCap === null ? null : int(raw.scoreDifferentialCap, MAX_SCORE, 'Score differential cap', 'INVALID_RULES'),
    knockoutDeciders: list(raw.knockoutDeciders, KNOCKOUT_DECIDERS, 'knockout deciders', 0),
  };
  if (normalized.scoreDifferentialCap === 0) fail('INVALID_RULES', 'Score differential cap must be at least 1 or none.');
  if (normalized.forfeitScore.winner <= normalized.forfeitScore.loser) fail('INVALID_RULES', 'The forfeit winner score must be higher than the loser score.');
  if (normalized.points.win < normalized.points.loss || normalized.points.forfeitWin < normalized.points.forfeitLoss) {
    fail('INVALID_RULES', 'A win cannot earn fewer points than a loss.');
  }
  if (!normalized.allowDraws && normalized.points.draw !== 0) fail('INVALID_RULES', 'Draw points must be 0 when draws are not allowed.');
  // Stable ordering for presentation and equality; tie-breakers keep the manager's order.
  normalized.countedOutcomes = (['played', 'forfeit'] as const).filter(item => normalized.countedOutcomes.includes(item));
  normalized.knockoutDeciders = KNOCKOUT_DECIDERS.filter(item => normalized.knockoutDeciders.includes(item));
  return normalized;
}

export function sameRules(a: CompetitionRules | null | undefined, b: CompetitionRules | null | undefined): boolean {
  return !!a && !!b && JSON.stringify(normalizeRules(a)) === JSON.stringify(normalizeRules(b));
}

/**
 * Validates one result for a canonical match. Without confirmed rules (a coach proposal) only structure and the
 * competition format are checked; finalization always passes the active confirmed rules.
 */
export function normalizeResultValues(
  value: unknown,
  sides: { homeTeamId: string; awayTeamId: string },
  format: CompetitionFormat,
  rules: CompetitionRules | null,
): CompetitionResultValues {
  const raw = record(value, 'result', 'INVALID_RESULT');
  exact(raw, ['outcome', 'homeScore', 'awayScore', 'forfeitingTeamId', 'winnerTeamId', 'decider'], 'result', 'INVALID_RESULT');
  const side = (teamId: unknown, label: string) => {
    if (teamId !== sides.homeTeamId && teamId !== sides.awayTeamId) fail('INVALID_RESULT', `Choose the ${label} from the two match teams.`);
    return teamId as string;
  };
  const other = (teamId: string) => (teamId === sides.homeTeamId ? sides.awayTeamId : sides.homeTeamId);
  if (raw.outcome === 'void') {
    if (raw.homeScore !== null || raw.awayScore !== null || raw.forfeitingTeamId !== null || raw.winnerTeamId !== null || raw.decider !== null) {
      fail('INVALID_RESULT', 'A void result has no score, forfeit or winner.');
    }
    return { outcome: 'void', homeScore: null, awayScore: null, forfeitingTeamId: null, winnerTeamId: null, decider: null };
  }
  if (raw.outcome === 'forfeit') {
    const forfeitingTeamId = side(raw.forfeitingTeamId, 'forfeiting team');
    if (raw.winnerTeamId !== null || raw.decider !== null) fail('INVALID_RESULT', 'A forfeit winner is the other team.');
    // Forfeit scores come only from explicit league policy; a proposal before confirmation records no score.
    const winner = rules ? rules.forfeitScore.winner : null;
    const loser = rules ? rules.forfeitScore.loser : null;
    const homeForfeits = forfeitingTeamId === sides.homeTeamId;
    if (!rules && (raw.homeScore !== null || raw.awayScore !== null)) fail('INVALID_RESULT', 'Forfeit scores come from the confirmed league rules.');
    return {
      outcome: 'forfeit', homeScore: homeForfeits ? loser : winner, awayScore: homeForfeits ? winner : loser,
      forfeitingTeamId, winnerTeamId: other(forfeitingTeamId), decider: null,
    };
  }
  if (raw.outcome !== 'played') fail('INVALID_RESULT', 'Choose played, forfeit or void.');
  const homeScore = int(raw.homeScore, MAX_SCORE, 'Home score', 'INVALID_RESULT');
  const awayScore = int(raw.awayScore, MAX_SCORE, 'Away score', 'INVALID_RESULT');
  if (raw.forfeitingTeamId !== null) fail('INVALID_RESULT', 'A played result has no forfeiting team.');
  if (homeScore !== awayScore) {
    const winnerTeamId = homeScore > awayScore ? sides.homeTeamId : sides.awayTeamId;
    if ((raw.winnerTeamId !== null && raw.winnerTeamId !== winnerTeamId) || raw.decider !== null) {
      fail('INVALID_RESULT', 'The higher score wins. A decider only applies to a tied score.');
    }
    return { outcome: 'played', homeScore, awayScore, forfeitingTeamId: null, winnerTeamId, decider: null };
  }
  if (raw.winnerTeamId === null && raw.decider === null) {
    if (format === 'knockout') fail('INVALID_KNOCKOUT_DRAW', 'A knockout match cannot end in a draw. Record the winner and the decider the rules allow.');
    if (rules && !rules.allowDraws) fail('DRAW_NOT_ALLOWED', 'These rules do not allow draws. Record the winner and the decider the rules allow.');
    return { outcome: 'played', homeScore, awayScore, forfeitingTeamId: null, winnerTeamId: null, decider: null };
  }
  const winnerTeamId = side(raw.winnerTeamId, 'winner');
  const decider = raw.decider as KnockoutDecider;
  const allowed = rules ? rules.knockoutDeciders : KNOCKOUT_DECIDERS;
  if (!allowed.includes(decider)) {
    fail(format === 'knockout' ? 'INVALID_KNOCKOUT_DRAW' : 'INVALID_RESULT', 'Choose a decider the competition rules allow.');
  }
  if (format === 'league' && rules?.allowDraws) fail('INVALID_RESULT', 'These rules record a tied league score as a draw.');
  return { outcome: 'played', homeScore, awayScore, forfeitingTeamId: null, winnerTeamId, decider };
}

export function sameResult(a: CompetitionResultValues, b: CompetitionResultValues): boolean {
  return (['outcome', 'homeScore', 'awayScore', 'forfeitingTeamId', 'winnerTeamId', 'decider'] as const).every(key => a[key] === b[key]);
}

/** A knockout, or a league without draws, needs at least one permitted decider so a tied score can be resolved. */
export function assertRulesFitFormat(rules: CompetitionRules, format: CompetitionFormat): void {
  if (format === 'knockout' && rules.allowDraws) fail('INVALID_RULES', 'Knockout competitions cannot allow draws.');
  if ((format === 'knockout' || !rules.allowDraws) && rules.knockoutDeciders.length === 0) {
    fail('INVALID_RULES', 'Choose at least one decider for tied matches when draws are not allowed.');
  }
}
