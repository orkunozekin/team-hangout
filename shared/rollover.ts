/** Wire shapes for season rollover. Keep aligned with functions/src/seasons/rollover.ts. */
export type RolloverState = "queued" | "running" | "complete" | "failed";
export type RolloverTarget = { name: string; startsOn: string; endsOn: string };
export type RolloverCounts = { divisions: number; excludedDivisions: number; teams: number; excludedTeams: number };
export type RolloverReason = "archived" | "divisionArchived" | "divisionMissing" | "deselected";
export type RolloverPreview = {
  previewHash: string;
  source: { seasonId: string; name: string; status: string; programId: string; programName: string; programStatus: string };
  target: RolloverTarget;
  divisions: { id: string; name: string; status: string; included: boolean; reason: RolloverReason | null }[];
  teams: { id: string; name: string; divisionId: string | null; status: string; included: boolean; reason: RolloverReason | null }[];
  counts: RolloverCounts;
  notCopied: string[];
};
export type RolloverJob = {
  jobId: string;
  state: RolloverState;
  sourceSeasonId: string;
  programId: string;
  targetSeasonId: string;
  target: RolloverTarget;
  counts: RolloverCounts;
  created: { divisions: number; teams: number };
  chunkCount: number;
  completedChunks: number;
  attempts: number;
  failure: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
};

export const ROLLOVER_STATE_LABELS: Record<RolloverState, string> = {
  queued: "Queued",
  running: "In progress",
  complete: "Complete, draft season",
  failed: "Stopped",
};
export const ROLLOVER_REASON_LABELS: Record<RolloverReason, string> = {
  archived: "Archived, not copied",
  divisionArchived: "Division archived, not copied",
  divisionMissing: "Division missing, not copied",
  deselected: "Not selected",
};
const NOT_COPIED_LABELS: Record<string, string> = {
  staffAssignments: "Coach and staff assignments",
  teamEnrollments: "Player enrollments and rosters",
  guardianLinks: "Guardian links",
  invitations: "Invitations and join codes",
  messages: "Messages and staff notes",
  events: "Events and schedules",
  attendance: "Availability and attendance",
  lineups: "Lineups and playing time",
  results: "Scores and results",
  competitions: "Competitions, standings and brackets",
  volunteers: "Volunteer slots",
  rides: "Ride coordination",
  waivers: "Waivers",
  payments: "Payment obligations",
  reports: "Report runs and exports",
};
export function notCopiedLabel(kind: string): string {
  return NOT_COPIED_LABELS[kind] ?? kind;
}

/** Progress counts target entities, so a partial job shows exactly what exists so far. */
export function rolloverProgress(job: Pick<RolloverJob, "state" | "counts" | "created" | "chunkCount" | "completedChunks">): string {
  const total = job.counts.divisions + job.counts.teams;
  const done = Math.min(job.created.divisions + job.created.teams, total);
  if (job.state === "complete") return `${job.created.teams} teams and ${job.created.divisions} divisions created`;
  return `${done} of ${total} records created, step ${Math.min(job.completedChunks, job.chunkCount)} of ${job.chunkCount}`;
}

export type RolloverInput = { orgId: string; sourceSeasonId: string; target: RolloverTarget; excludedTeamIds: string[] };
export type RolloverCommands = {
  previewRollover: { input: RolloverInput; output: RolloverPreview };
  commitRollover: { input: RolloverInput & { requestId: string; previewHash: string }; output: { job: RolloverJob } };
  resumeRollover: { input: { requestId: string; orgId: string; jobId: string }; output: { job: RolloverJob } };
  listRolloverJobs: { input: { orgId: string; cursor?: string | null }; output: { items: RolloverJob[]; nextCursor: string | null } };
};
