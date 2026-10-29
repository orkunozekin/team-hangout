import type { PlayStatus } from '../../../shared/playTime';

/**
 * Renders the clock from the last acknowledged server reading plus local monotonic-ish elapsed time.
 * Background resume recomputes from the same anchor, so no always-running timer or write loop is needed.
 */
export function estimateElapsedMs(
  reading: { status: PlayStatus; elapsedMs: number },
  receivedAtMs: number,
  nowMs: number,
): number {
  if (reading.status !== 'running') return reading.elapsedMs;
  return reading.elapsedMs + Math.max(0, nowMs - receivedAtMs);
}

export function formatGameClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Parses m:ss (or whole minutes) into game-elapsed milliseconds; null when malformed. */
export function parseGameClock(value: string): number | null {
  const match = /^\s*(\d{1,3})(?::([0-5]\d))?\s*$/.exec(value);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2] ?? 0)) * 1000;
}

export const STATUS_LABELS: Record<PlayStatus, string> = {
  notStarted: 'Not started',
  running: 'Clock running',
  paused: 'Clock paused',
  periodBreak: 'Period break',
  ended: 'Game ended',
  finalized: 'Final',
};

export type PlayErrorKind = 'offline' | 'conflict' | 'unavailable' | 'illegal' | 'denied' | 'other';

export function playError(error: unknown): { kind: PlayErrorKind; message: string } {
  const e = error as { code?: string; message?: string; details?: { domainCode?: string } };
  if (['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(e.code ?? '')) {
    return { kind: 'offline', message: 'Not recorded. You appear to be offline, and nothing was queued. Showing the last acknowledged clock.' };
  }
  const code = e.details?.domainCode;
  if (code === 'STALE_REVISION') {
    return { kind: 'conflict', message: 'Another coach recorded an action first. Reload the latest clock, then try again.' };
  }
  if (code === 'PARTICIPANT_UNAVAILABLE') {
    return { kind: 'unavailable', message: 'That participant is no longer on the roster.' };
  }
  if (code === 'LINEUP_NOT_SAVED') {
    return { kind: 'illegal', message: 'Save a lineup before starting the clock.' };
  }
  if (code === 'CORRECTION_CONFLICT' || code === 'ILLEGAL_TRANSITION' || code === 'SESSION_FINALIZED') {
    return { kind: 'illegal', message: e.message || 'That action is not available now. Reload the latest clock.' };
  }
  if (e.code === 'functions/permission-denied') {
    return { kind: 'denied', message: 'Coaching access changed or is unavailable for this team.' };
  }
  return { kind: 'other', message: e.message || 'Playing time unavailable. Reload before trying again.' };
}
