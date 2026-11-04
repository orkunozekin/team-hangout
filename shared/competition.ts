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

/** Standings rows come from one immutable generation. Team ID only orders rows inside a shared rank. */
export type StandingsRow = {
  position: number;
  rank: number;
  teamId: string;
  teamName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  forfeitWins: number;
  forfeitLosses: number;
  scoresFor: number;
  scoresAgainst: number;
  differential: number;
  points: number;
  sharedRank: boolean;
  tiedWith: string[];
  decidedBy: TieBreaker | null;
  notApplicable: TieBreaker[];
};

/** current: the table matches every final result. updating: a rebuild is pending. stale: pending longer than expected. */
export type StandingsStatus = "current" | "updating" | "stale" | "unconfirmed";

export type StandingsView = {
  competitionId: string;
  name: string;
  format: CompetitionFormat;
  status: StandingsStatus;
  sourceRevision: number;
  sourceUpdatedAt: string | null;
  generation: {
    generationId: string;
    active: boolean;
    sourceRevision: number;
    rulesVersion: number;
    completedAt: string;
    sourceUpdatedAt: string | null;
    rowCount: number;
    countedResults: number;
    unresolvedTies: number;
    reducerVersion: number;
  } | null;
  rows: StandingsRow[];
  nextCursor: string | null;
};

export type EventStandings = {
  orgId: string;
  eventId: string;
  teamId: string;
  competitions: { competitionId: string; name: string; status: StandingsStatus }[];
  standings: StandingsView | null;
};

/** Keep aligned with functions/src/competition/bracket.ts and brackets.ts. A bye has no match, score, attendance or booking. */
export type BracketNodeState = "bye" | "waiting" | "ready" | "scheduled" | "decided";
export type BracketTeam = { teamId: string; name: string; seed: number | null };
export type BracketNodeView = {
  nodeId: string;
  round: number;
  index: number;
  state: BracketNodeState;
  bye: boolean;
  teams: (BracketTeam | null)[];
  eventId: string | null;
  eventStartsAt: string | null;
  /** The linked match began but has no final winner yet (delayed or void result). */
  winnerPending: boolean;
  winnerTeamId: string | null;
  /** Played matches a reviewed correction invalidated. Their results stay in history. */
  voidedPlays: { eventId: string; winnerTeamId: string | null; voidedAt: string }[];
};
export type BracketView = {
  competitionId: string;
  name: string;
  format: CompetitionFormat;
  bracketRevision: number;
  bracket: {
    bracketId: string;
    size: number;
    rounds: number;
    teamCount: number;
    source: { competitionId: string; name: string; generationId: string; sourceRevision: number } | null;
    override: { reason: string } | null;
    publishedAt: string;
    updatedAt: string;
  } | null;
  nodes: BracketNodeView[];
};
export type BracketPreview = {
  competitionId: string;
  bracketRevision: number;
  published: boolean;
  locked: boolean;
  source: { competitionId: string; name: string; generationId: string; sourceRevision: number } | null;
  previewHash: string;
  blocked: "SEED_ORDER_REQUIRED" | "SEED_TIE_UNRESOLVED" | null;
  unresolvedTies: { teamId: string; name: string }[][];
  seeds: { seed: number; teamId: string; name: string }[];
  nodes: BracketNodeView[];
};
export type BracketCorrectionPreview = {
  eventId: string;
  resultRevision: number;
  bracketRevision: number;
  rounds: number;
  nodeId: string | null;
  previousWinnerTeamId: string | null;
  winnerTeamId: string | null;
  affected: { nodeId: string; round: number; index: number; eventId: string | null; winnerTeamId: string | null; started: boolean }[];
  invalidatedNodeIds: string[];
  requiresConfirmation: boolean;
};
export type EventBracket = {
  orgId: string;
  eventId: string;
  teamId: string;
  competitions: { competitionId: string; name: string }[];
  bracket: BracketView | null;
};
type SeedOverride = { teamIds: string[]; reason: string } | null;

export function roundLabel(round: number, rounds: number): string {
  if (round === rounds) return "Final";
  if (round === rounds - 1) return "Semifinals";
  if (round === rounds - 2) return "Quarterfinals";
  return `Round ${round}`;
}

/** Plain-language status for one bracket game. */
export function bracketNodeStatus(node: BracketNodeView, names: (teamId: string) => string): string {
  const replay = node.voidedPlays.length && node.state !== "decided"
    ? ` ${node.voidedPlays.length === 1 ? "A played match was" : `${node.voidedPlays.length} played matches were`} invalidated by a reviewed correction; this game needs a new match.`
    : "";
  switch (node.state) {
    case "bye": return `${names(node.winnerTeamId!)} advances on a bye. No game is played.`;
    case "decided": return `${names(node.winnerTeamId!)} advanced.`;
    case "waiting": return `Waiting for earlier winners.${replay}`;
    case "ready": return `Both teams known. No match linked yet.${replay}`;
    case "scheduled": return node.winnerPending ? "Winner unresolved. Waiting for a final result." : "Match linked.";
  }
}

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
  getStandings: { input: { orgId: string; competitionId: string; generationId?: string; cursor?: string }; output: StandingsView };
  previewBracket: { input: { orgId: string; competitionId: string; sourceCompetitionId: string | null; seedOverride: SeedOverride }; output: BracketPreview };
  publishBracket: {
    input: Envelope<{ sourceCompetitionId: string | null; generationId: string | null; sourceRevision: number | null; seedOverride: SeedOverride; previewHash: string }>;
    output: { requestId: string; revision: number; state: "published"; bracketId: string; operationId: string };
  };
  linkBracketEvent: { input: Envelope<{ nodeId: string; eventId: string }>; output: { requestId: string; revision: number; state: "scheduled" | "decided"; operationId: string } };
  getBracket: { input: { orgId: string; competitionId: string }; output: BracketView };
  previewBracketCorrection: { input: { orgId: string; competitionId: string; eventId: string; result: ResultValues }; output: BracketCorrectionPreview };
  correctBracket: {
    input: Envelope<{ eventId: string; resultRevision: number; result: ResultValues; reason: string; invalidatedNodeIds: string[] }>;
    output: ResultMutation & { bracketRevision?: number };
  };
};

export const STANDINGS_STATUS_LABELS: Record<StandingsStatus, string> = {
  current: "Up to date",
  updating: "Updating. Showing the last complete table.",
  stale: "Update delayed. Showing the last complete table; it may not include the latest results.",
  unconfirmed: "Standings appear after league rules are confirmed.",
};

export function formatDifferential(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** Plain-language tie note for one row. A shared rank is a sporting tie; list order inside it is not a ranking. */
export function tieNote(row: Pick<StandingsRow, "teamId" | "sharedRank" | "tiedWith" | "notApplicable">, names: (teamId: string) => string): string | null {
  const parts: string[] = [];
  if (row.sharedRank) parts.push(`Tied with ${row.tiedWith.filter(teamId => teamId !== row.teamId).map(names).join(", ")}; all tie-breakers exhausted`);
  if (row.notApplicable.length) parts.push(`${row.notApplicable.map(item => TIE_BREAKER_LABELS[item]).join(", ")} not applicable`);
  return parts.length ? parts.join(". ") : null;
}

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
