/** Wire contracts for Phase 3 competition rules and results. Keep aligned with functions/src/competition/rules.ts and results.ts. */
export type CompetitionFormat = "league" | "knockout";
export type ResultOutcome = "played" | "forfeit" | "void";
export type TieBreaker = "tablePoints" | "headToHeadPoints" | "scoreDifferential" | "scoresFor" | "wins";
export type KnockoutDecider = "extraTime" | "penalties" | "shootout";

export type CompetitionRules = {
  rulesSchemaVersion: 1;
  points: { win: number; draw: number; loss: number; forfeitWin: number; forfeitLoss: number };
  allowDraws: boolean;
  forfeitScore: { winner: number; loser: number };
  countedOutcomes: ("played" | "forfeit")[];
  tieBreakers: TieBreaker[];
  scoreDifferentialCap: number | null;
  knockoutDeciders: KnockoutDecider[];
};

export type ResultValues = {
  outcome: ResultOutcome;
  homeScore: number | null;
  awayScore: number | null;
  forfeitingTeamId: string | null;
  winnerTeamId: string | null;
  decider: KnockoutDecider | null;
};

export type CompetitionResult = {
  eventId: string;
  status: "proposed" | "final";
  revision: number;
  homeTeamId: string;
  awayTeamId: string;
  proposal: (ResultValues & { proposedBy: string; proposedTeamId: string; proposedAt: string }) | null;
  final: (ResultValues & {
    appliedRulesVersion: number;
    finalizedBy: string;
    finalizedAt: string;
    correctedAt: string | null;
    correctionReason?: string;
  }) | null;
  updatedAt: string | null;
};

export type CompetitionSummary = {
  competitionId: string;
  name: string;
  format: CompetitionFormat;
  programId: string;
  seasonId: string;
  divisionId: string | null;
  teamIds: string[];
  revision: number;
  state: "active" | "closed";
  activeRulesVersion: number | null;
  sourceRevision: number;
  finalResultCount: number;
  /** "draft" when the saved draft differs from the active confirmed version, or nothing is confirmed yet. */
  rulesState: "draft" | "confirmed";
};

export type CompetitionDetail = {
  competition: CompetitionSummary & { draftRules: CompetitionRules; activeRules: CompetitionRules | null };
  rulesVersions: { version: number; rules: CompetitionRules; confirmedBy: string; confirmedAt: string }[];
  teams: { teamId: string; name: string }[];
  matches: {
    eventId: string;
    title: string;
    startsAt: string | null;
    status: string;
    homeTeamId: string;
    awayTeamId: string;
    result: CompetitionResult | null;
  }[];
  nextCursor: string | null;
};

/** Coach-only view for one match. Families see final scores only through later published standings. */
export type EventResults = {
  orgId: string;
  eventId: string;
  teamId: string;
  externalOpponent: boolean;
  homeTeamId?: string;
  awayTeamId?: string;
  teams?: { teamId: string; name: string }[];
  competitions: {
    competitionId: string;
    name: string;
    format: CompetitionFormat;
    rules: { version: number; allowDraws: boolean; knockoutDeciders: KnockoutDecider[] } | null;
    result: CompetitionResult | null;
  }[];
};

export type ResultMutation = { requestId: string; revision: number; state: "proposed" | "final"; sourceRevision?: number; operationId: string };

type Envelope<P> = { requestId: string; orgId: string; resourceId: string; expectedRevision: number; payload: P };
export type CompetitionCommands = {
  saveCompetitionRules: {
    input: Envelope<{
      programId: string;
      seasonId: string;
      divisionId: string | null;
      name: string;
      format: CompetitionFormat;
      teamIds: string[];
      rules: CompetitionRules;
      confirm: boolean;
    }>;
    output: { requestId: string; revision: number; activeRulesVersion: number | null; state: "draft" | "confirmed" };
  };
  finalizeResult: { input: Envelope<{ eventId: string; result: ResultValues }>; output: ResultMutation };
  correctResult: { input: Envelope<{ eventId: string; result: ResultValues; reason: string }>; output: ResultMutation };
  listCompetitions: { input: { orgId: string; programId: string }; output: { competitions: CompetitionSummary[] } };
  getCompetition: { input: { orgId: string; competitionId: string; cursor?: string }; output: CompetitionDetail };
};

export const TIE_BREAKER_LABELS: Record<TieBreaker, string> = {
  tablePoints: "Table points",
  headToHeadPoints: "Head-to-head points (whole tied group)",
  scoreDifferential: "Score differential",
  scoresFor: "Scores for",
  wins: "Wins",
};
export const DECIDER_LABELS: Record<KnockoutDecider, string> = {
  extraTime: "Extra time",
  penalties: "Penalties",
  shootout: "Shootout",
};
export const KNOCKOUT_DECIDERS_ALL: KnockoutDecider[] = ["extraTime", "penalties", "shootout"];
export const RESULT_REASON_MAX = 500;
export const RESULT_SCORE_MAX = 999;

/**
 * Starting draft only. It is not a sport standard and has no effect until a competition manager edits it to
 * match actual league policy and confirms it.
 */
export function draftRulesTemplate(): CompetitionRules {
  return {
    rulesSchemaVersion: 1,
    points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
    allowDraws: true,
    forfeitScore: { winner: 1, loser: 0 },
    countedOutcomes: ["played", "forfeit"],
    tieBreakers: ["tablePoints", "headToHeadPoints", "scoreDifferential", "scoresFor", "wins"],
    scoreDifferentialCap: null,
    knockoutDeciders: [],
  };
}

/** Client-side hint only; the server validates again with the active confirmed rules. */
export function tiedNeedsDecider(format: CompetitionFormat, rules: { allowDraws: boolean } | null): boolean {
  return format === "knockout" || (rules !== null && !rules.allowDraws);
}

export function describeResult(values: ResultValues, names: (teamId: string) => string): string {
  if (values.outcome === "void") return "Void, no result counted";
  if (values.outcome === "forfeit") {
    const score = values.homeScore === null ? "" : ` (${values.homeScore}-${values.awayScore})`;
    return `Forfeit by ${names(values.forfeitingTeamId!)}${score}`;
  }
  const decided = values.decider ? `, ${names(values.winnerTeamId!)} won on ${DECIDER_LABELS[values.decider].toLowerCase()}` : "";
  return `${values.homeScore}-${values.awayScore}${decided}`;
}
