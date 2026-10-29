/** Wire contracts for Phase 3 playing time. Keep aligned with functions/src/coaching/playTime.ts. */
import type { LineupPresetId, LineupRosterEntry } from "./lineups";

export type PlayStatus = "notStarted" | "running" | "paused" | "periodBreak" | "ended" | "finalized";
export type PlayActionKind = "start" | "pause" | "resume" | "substitute" | "switchUnit" | "endPeriod" | "correct" | "finalize";

export type PlayActionRecord = {
  sequence: number;
  kind: PlayActionKind;
  period: number;
  /** Authoritative game-elapsed milliseconds, never wall time. */
  atElapsedMs: number;
  unitId?: string;
  outParticipantId?: string;
  inParticipantId?: string;
  targetSequence?: number;
  reason?: string;
  corrected?: { atElapsedMs: number; outParticipantId: string; inParticipantId: string };
};

/** Coach-only. Individual playing time is never exposed to households in the first release. */
export type PlaySession = {
  orgId: string;
  eventId: string;
  teamId: string;
  revision: number;
  lineupRevision: number;
  sportPresetId: LineupPresetId | null;
  status: PlayStatus;
  periodCount: number;
  currentPeriod: number;
  activeUnitId: string | null;
  units: { unitId: string; participantIds: string[] }[];
  /** Server estimate at serverNow from the last acknowledged clock anchor. */
  elapsedMs: number;
  serverNow: string;
  totals: { participantId: string; displayName: string; ms: number }[];
  roster: LineupRosterEntry[];
  /** Most recent first, at most 50. */
  actions: PlayActionRecord[];
  finalizedAt: string | null;
};

export type PlayActionPayload =
  | { kind: "start"; periodCount?: number }
  | { kind: "pause" | "resume" | "endPeriod" }
  | { kind: "switchUnit"; unitId: string }
  | { kind: "substitute"; unitId: string; outParticipantId: string; inParticipantId: string }
  | { kind: "correct"; targetSequence: number; atElapsedMs: number; outParticipantId: string; inParticipantId: string; reason: string };

export type PlayMutationResult = {
  requestId: string;
  revision: number;
  state: PlayStatus;
  sequence: number;
  /** Corrections only: participants whose totals changed and need coach review. */
  affectedParticipantIds?: string[];
};

export const PLAY_MAX_PERIODS = 8;
export const PLAY_CORRECTION_REASON_MAX = 500;
