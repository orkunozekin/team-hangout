/**
 * Pure standings reducer. No Firebase imports so backend and native tests can replay it.
 * Output depends only on the team set, the rules and the set of final results, never on input order.
 * Keep wire shapes aligned with shared/competition.ts.
 */
import type { CompetitionResultValues, CompetitionRules, TieBreaker } from './rules';

/** Bump when reducer semantics change so stored generations record which algorithm produced them. */
export const STANDINGS_REDUCER_VERSION = 1;

export type FinalResultInput = CompetitionResultValues & { eventId: string; homeTeamId: string; awayTeamId: string };

export type StandingsRow = {
  position: number;
  rank: number;
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  forfeitWins: number;
  forfeitLosses: number;
  scoresFor: number;
  scoresAgainst: number;
  /** Sum of per-result differentials after the configured cap. */
  differential: number;
  points: number;
  /** True when this row shares its rank because every configured criterion was exhausted. */
  sharedRank: boolean;
  /** Teams sharing this rank, in stable team ID order. Empty unless sharedRank. */
  tiedWith: string[];
  /** The criterion that separated this team from its tied cohort; null for a shared rank or a one-team cohort. */
  decidedBy: TieBreaker | null;
  /** Criteria skipped for this team's cohort because they could not apply (incomplete head-to-head). */
  notApplicable: TieBreaker[];
};

export type StandingsTable = { rows: StandingsRow[]; countedResults: number; unresolvedTies: number };

type Totals = Omit<StandingsRow, 'position' | 'rank' | 'sharedRank' | 'tiedWith' | 'decidedBy' | 'notApplicable'>;

function empty(teamId: string): Totals {
  return { teamId, played: 0, wins: 0, draws: 0, losses: 0, forfeitWins: 0, forfeitLosses: 0, scoresFor: 0, scoresAgainst: 0, differential: 0, points: 0 };
}

function counted(result: FinalResultInput, rules: CompetitionRules): boolean {
  // Void results and outcomes the league does not count contribute nothing, including no loss or zero score.
  return result.outcome !== 'void' && rules.countedOutcomes.includes(result.outcome);
}

/** Points each side earns from one counted result, using the generation's rules. */
function sidePoints(result: FinalResultInput, rules: CompetitionRules): [number, number] {
  const homeWon = result.winnerTeamId === result.homeTeamId;
  if (result.outcome === 'forfeit') return homeWon ? [rules.points.forfeitWin, rules.points.forfeitLoss] : [rules.points.forfeitLoss, rules.points.forfeitWin];
  if (result.winnerTeamId === null) return [rules.points.draw, rules.points.draw];
  return homeWon ? [rules.points.win, rules.points.loss] : [rules.points.loss, rules.points.win];
}

function capped(diff: number, cap: number | null): number {
  return cap === null ? diff : Math.max(-cap, Math.min(cap, diff));
}

function apply(totals: Totals, result: FinalResultInput, home: boolean, points: number, rules: CompetitionRules) {
  const own = (home ? result.homeScore : result.awayScore) ?? 0;
  const other = (home ? result.awayScore : result.homeScore) ?? 0;
  const teamId = home ? result.homeTeamId : result.awayTeamId;
  totals.played += 1;
  totals.points += points;
  totals.scoresFor += own;
  totals.scoresAgainst += other;
  totals.differential += capped(own - other, rules.scoreDifferentialCap);
  if (result.winnerTeamId === null) totals.draws += 1;
  else if (result.winnerTeamId === teamId) {
    totals.wins += 1;
    if (result.outcome === 'forfeit') totals.forfeitWins += 1;
  } else {
    totals.losses += 1;
    if (result.outcome === 'forfeit') totals.forfeitLosses += 1;
  }
}

type Group = { teams: string[]; decidedBy: TieBreaker | null; notApplicable: TieBreaker[]; unresolved: boolean };

/**
 * Head-to-head applies to the whole tied cohort only when every pair met the same positive number of times in
 * counted final results. Returns null when it cannot apply.
 */
function headToHead(cohort: string[], results: FinalResultInput[], rules: CompetitionRules): Map<string, number> | null {
  const members = new Set(cohort);
  const meetings = new Map<string, number>();
  const points = new Map(cohort.map(teamId => [teamId, 0]));
  for (const result of results) {
    if (!members.has(result.homeTeamId) || !members.has(result.awayTeamId)) continue;
    const pair = [result.homeTeamId, result.awayTeamId].sort().join('|');
    meetings.set(pair, (meetings.get(pair) ?? 0) + 1);
    const [home, away] = sidePoints(result, rules);
    points.set(result.homeTeamId, points.get(result.homeTeamId)! + home);
    points.set(result.awayTeamId, points.get(result.awayTeamId)! + away);
  }
  const pairs = (cohort.length * (cohort.length - 1)) / 2;
  const counts = new Set(meetings.values());
  if (meetings.size !== pairs || counts.size !== 1 || [...counts][0] < 1) return null;
  return points;
}

function value(criterion: TieBreaker, totals: Totals): number {
  switch (criterion) {
    case 'tablePoints': return totals.points;
    case 'scoreDifferential': return totals.differential;
    case 'scoresFor': return totals.scoresFor;
    case 'wins': return totals.wins;
    default: throw new Error(`Unsupported criterion ${criterion}`);
  }
}

/**
 * Applies the configured criteria in order. Each criterion splits the cohort it receives; the resulting subgroups
 * continue with the next criterion only, so no criterion is reapplied recursively to a smaller cohort. Exhausted
 * criteria leave an explicit unresolved tie. Team ID only orders presentation inside an unresolved tie.
 */
function order(cohort: string[], index: number, notApplicable: TieBreaker[], decidedBy: TieBreaker | null,
  totals: Map<string, Totals>, results: FinalResultInput[], rules: CompetitionRules): Group[] {
  if (cohort.length === 1) return [{ teams: cohort, decidedBy, notApplicable, unresolved: false }];
  if (index >= rules.tieBreakers.length) return [{ teams: [...cohort].sort(), decidedBy: null, notApplicable, unresolved: true }];
  const criterion = rules.tieBreakers[index];
  let scores: Map<string, number>;
  if (criterion === 'headToHeadPoints') {
    const h2h = headToHead(cohort, results, rules);
    if (!h2h) return order(cohort, index + 1, [...notApplicable, criterion], decidedBy, totals, results, rules);
    scores = h2h;
  } else {
    scores = new Map(cohort.map(teamId => [teamId, value(criterion, totals.get(teamId)!)]));
  }
  const buckets = new Map<number, string[]>();
  for (const teamId of cohort) buckets.set(scores.get(teamId)!, [...(buckets.get(scores.get(teamId)!) ?? []), teamId]);
  const split = buckets.size > 1;
  return [...buckets.entries()].sort((a, b) => b[0] - a[0]).flatMap(([, teams]) =>
    order(teams, index + 1, notApplicable, split ? criterion : decidedBy, totals, results, rules));
}

export function computeStandings(teamIds: string[], results: FinalResultInput[], rules: CompetitionRules): StandingsTable {
  const teams = [...new Set(teamIds)].sort();
  const members = new Set(teams);
  const totals = new Map(teams.map(teamId => [teamId, empty(teamId)]));
  // Integer sums are order independent; sorting by event ID also fixes the scan order for reproducible output.
  const rows = results
    .filter(result => counted(result, rules) && members.has(result.homeTeamId) && members.has(result.awayTeamId) && result.homeTeamId !== result.awayTeamId)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  for (const result of rows) {
    const [home, away] = sidePoints(result, rules);
    apply(totals.get(result.homeTeamId)!, result, true, home, rules);
    apply(totals.get(result.awayTeamId)!, result, false, away, rules);
  }
  const groups = teams.length ? order(teams, 0, [], null, totals, rows, rules) : [];
  const table: StandingsRow[] = [];
  let unresolvedTies = 0;
  for (const group of groups) {
    const rank = table.length + 1;
    if (group.unresolved) unresolvedTies += 1;
    for (const teamId of group.teams) {
      table.push({
        ...totals.get(teamId)!, position: table.length + 1, rank,
        sharedRank: group.unresolved, tiedWith: group.unresolved ? group.teams : [],
        decidedBy: group.unresolved ? null : group.decidedBy, notApplicable: group.notApplicable,
      });
    }
  }
  return { rows: table, countedResults: rows.length, unresolvedTies };
}
