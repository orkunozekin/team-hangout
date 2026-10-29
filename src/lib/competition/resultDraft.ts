import type { CompetitionFormat, KnockoutDecider, ResultOutcome, ResultValues } from '../../../shared/competition';
import { RESULT_SCORE_MAX, tiedNeedsDecider } from '../../../shared/competition';

export type ResultDraft = {
  outcome: ResultOutcome;
  homeScore: string;
  awayScore: string;
  forfeitingTeamId: string | null;
  winnerTeamId: string | null;
  decider: KnockoutDecider | null;
};

export const emptyResultDraft = (): ResultDraft => ({
  outcome: 'played', homeScore: '', awayScore: '', forfeitingTeamId: null, winnerTeamId: null, decider: null,
});

export function draftFromValues(values: ResultValues | null | undefined): ResultDraft {
  if (!values) return emptyResultDraft();
  return {
    outcome: values.outcome,
    homeScore: values.homeScore === null ? '' : String(values.homeScore),
    awayScore: values.awayScore === null ? '' : String(values.awayScore),
    forfeitingTeamId: values.forfeitingTeamId,
    winnerTeamId: values.decider ? values.winnerTeamId : null,
    decider: values.decider,
  };
}

function score(value: string): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed <= RESULT_SCORE_MAX ? parsed : null;
}

/** Ties compare parsed scores, matching resultFromDraft, so "01" and "1" are a tie. */
export function scoresTied(draft: Pick<ResultDraft, 'homeScore' | 'awayScore'>): boolean {
  const home = score(draft.homeScore);
  return home !== null && home === score(draft.awayScore);
}

/**
 * Builds the wire result or explains what is missing. Forfeit scores are left to confirmed league policy on the server.
 * A tied score needs a winner and decider only when the format or rules forbid draws.
 */
export function resultFromDraft(
  draft: ResultDraft,
  format: CompetitionFormat,
  rules: { allowDraws: boolean } | null,
): { values: ResultValues } | { error: string } {
  if (draft.outcome === 'void') {
    return { values: { outcome: 'void', homeScore: null, awayScore: null, forfeitingTeamId: null, winnerTeamId: null, decider: null } };
  }
  if (draft.outcome === 'forfeit') {
    if (!draft.forfeitingTeamId) return { error: 'Choose the team that forfeited.' };
    return { values: { outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: draft.forfeitingTeamId, winnerTeamId: null, decider: null } };
  }
  const homeScore = score(draft.homeScore);
  const awayScore = score(draft.awayScore);
  if (homeScore === null || awayScore === null) return { error: `Enter whole-number scores from 0 to ${RESULT_SCORE_MAX}.` };
  const base = { outcome: 'played' as const, homeScore, awayScore, forfeitingTeamId: null };
  if (homeScore !== awayScore || !tiedNeedsDecider(format, rules)) return { values: { ...base, winnerTeamId: null, decider: null } };
  if (!draft.winnerTeamId || !draft.decider) {
    return { error: format === 'knockout' ? 'A knockout match cannot end in a draw. Choose the winner and how it was decided.' : 'These rules do not allow draws. Choose the winner and how it was decided.' };
  }
  return { values: { ...base, winnerTeamId: draft.winnerTeamId, decider: draft.decider } };
}

export type ResultErrorKind = 'offline' | 'conflict' | 'final' | 'invalid' | 'denied' | 'other';

export function resultError(error: unknown): { kind: ResultErrorKind; message: string } {
  const e = error as { code?: string; message?: string; details?: { domainCode?: string } };
  if (['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(e.code ?? '')) {
    return { kind: 'offline', message: 'Connection lost. The proposal may not have been saved, and nothing was queued. Retry sends the same proposal.' };
  }
  const code = e.details?.domainCode;
  if (code === 'STALE_REVISION') return { kind: 'conflict', message: 'Someone else updated this result. Reload, then propose again.' };
  if (code === 'RESULT_FINAL') return { kind: 'final', message: 'A scorer already finalized this result. Ask them to correct it if it is wrong.' };
  if (code && ['INVALID_RESULT', 'INVALID_KNOCKOUT_DRAW', 'DRAW_NOT_ALLOWED', 'EVENT_NOT_PLAYED', 'NOT_COMPETITION_MATCH', 'HIERARCHY_ARCHIVED', 'COMPETITION_CLOSED'].includes(code)) {
    return { kind: 'invalid', message: e.message || 'This result cannot be recorded.' };
  }
  if (e.code === 'functions/permission-denied') return { kind: 'denied', message: 'Coaching access changed or is unavailable for this team.' };
  return { kind: 'other', message: e.message || 'Results are unavailable. Reload before trying again.' };
}
