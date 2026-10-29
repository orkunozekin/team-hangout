/**
 * Pure playing-time ledger. No Firebase imports so Jest and the callable share one reducer.
 * Time is authoritative game-elapsed milliseconds, never wall time; it advances only while running.
 */
export type PlayStatus = 'notStarted' | 'running' | 'paused' | 'periodBreak' | 'ended' | 'finalized';
export type PlayActionKind = 'start' | 'pause' | 'resume' | 'substitute' | 'switchUnit' | 'endPeriod' | 'correct' | 'finalize';
export type PlayInterval = { from: number; to: number };
export type PlayUnit = { unitId: string; participantIds: string[] };
export type SubstitutionFields = { atElapsedMs: number; outParticipantId: string; inParticipantId: string };

export type PlayAction = {
  sequence: number;
  kind: PlayActionKind;
  atElapsedMs: number;
  /** First start only. */
  periodCount?: number;
  units?: PlayUnit[];
  unitId?: string;
  outParticipantId?: string;
  inParticipantId?: string;
  /** Corrections reference an earlier substitution and replace its fields during replay. */
  targetSequence?: number;
  corrected?: SubstitutionFields;
  reason?: string;
};

export type LedgerState = {
  status: PlayStatus;
  periodCount: number;
  currentPeriod: number;
  activeUnitId: string | null;
  units: PlayUnit[];
  elapsedMs: number;
  sequence: number;
  /** Elapsed time when each currently counted participant entered. */
  openSince: Record<string, number>;
  /** Closed, non-overlapping, ascending on-field intervals per participant. */
  intervals: Record<string, PlayInterval[]>;
  periods: { period: number; startMs: number; endMs: number | null }[];
};

export const MAX_PERIODS = 8;
export const MAX_PLAY_ACTIONS = 600;

export class PlayLedgerError extends Error {
  constructor(public readonly code: 'ILLEGAL_TRANSITION' | 'INVALID_ACTION' | 'CORRECTION_CONFLICT' | 'ACTION_LIMIT', message: string) {
    super(message);
    this.name = 'PlayLedgerError';
  }
}

const illegal = (message: string): never => { throw new PlayLedgerError('ILLEGAL_TRANSITION', message); };
const bad = (message: string): never => { throw new PlayLedgerError('INVALID_ACTION', message); };

export function initialLedger(): LedgerState {
  return {
    status: 'notStarted', periodCount: 0, currentPeriod: 0, activeUnitId: null, units: [],
    elapsedMs: 0, sequence: 0, openSince: {}, intervals: {}, periods: [],
  };
}

/** Participants accruing time: the active unit while a period is in progress (paused time does not advance). */
function counted(state: LedgerState): Set<string> {
  if (state.status !== 'running' && state.status !== 'paused') return new Set();
  return new Set(state.units.find(unit => unit.unitId === state.activeUnitId)?.participantIds ?? []);
}

function unitOf(state: LedgerState, unitId: unknown): PlayUnit {
  return state.units.find(unit => unit.unitId === unitId) ?? bad('Unknown unit.');
}

/** Structural actions still needed to end every period and finalize. Reserved so a busy game can always lock its totals. */
export function actionsToFinalize(state: LedgerState): number {
  const laterPeriods = 2 * (state.periodCount - state.currentPeriod);
  if (state.status === 'running' || state.status === 'paused') return laterPeriods + 2;
  if (state.status === 'periodBreak') return laterPeriods + 1;
  return state.status === 'ended' ? 1 : 0;
}

const inProgress = (state: LedgerState) => ['running', 'paused', 'periodBreak'].includes(state.status);

/** Applies one effective action. Corrections must already be folded in by effectiveActions. */
export function applyPlayAction(state: LedgerState, action: PlayAction): LedgerState {
  if (action.sequence !== state.sequence + 1) bad('Actions must be applied in sequence.');
  if (!Number.isSafeInteger(action.atElapsedMs) || action.atElapsedMs < state.elapsedMs) {
    bad('Action time cannot precede the previous action.');
  }
  // Paused clocks, period breaks and unstarted sessions do not advance game time.
  if (state.status !== 'running' && action.atElapsedMs !== state.elapsedMs) bad('Game time advances only while the clock runs.');
  const at = action.atElapsedMs;
  const next: LedgerState = {
    ...state,
    units: state.units.map(unit => ({ ...unit, participantIds: [...unit.participantIds] })),
    periods: state.periods.map(period => ({ ...period })),
    openSince: { ...state.openSince },
    intervals: Object.fromEntries(Object.entries(state.intervals).map(([id, list]) => [id, list.map(interval => ({ ...interval }))])),
    elapsedMs: at,
    sequence: action.sequence,
  };
  switch (action.kind) {
    case 'start':
      if (state.status === 'notStarted') {
        const count = action.periodCount;
        if (!Number.isSafeInteger(count) || count! < 1 || count! > MAX_PERIODS) bad('Invalid period count.');
        if (!Array.isArray(action.units) || !action.units.length) bad('Start needs the saved lineup units.');
        next.units = action.units!.map(unit => ({ unitId: unit.unitId, participantIds: [...unit.participantIds] }));
        for (const unit of next.units) {
          if (new Set(unit.participantIds).size !== unit.participantIds.length) bad('A participant can appear only once in each unit.');
        }
        if (new Set(next.units.map(unit => unit.unitId)).size !== next.units.length) bad('Duplicate unit.');
        next.periodCount = count!;
        next.activeUnitId = next.units[0].unitId;
      } else if (state.status === 'periodBreak') {
        if (action.periodCount !== undefined || action.units !== undefined) bad('Only the first start sets periods and units.');
      } else {
        illegal('The clock can start only before the game or during a period break.');
      }
      next.status = 'running';
      next.currentPeriod = state.currentPeriod + 1;
      next.periods.push({ period: next.currentPeriod, startMs: at, endMs: null });
      break;
    case 'pause':
      if (state.status !== 'running') illegal('Only a running clock can pause.');
      next.status = 'paused';
      break;
    case 'resume':
      if (state.status !== 'paused') illegal('Only a paused clock can resume.');
      next.status = 'running';
      break;
    case 'endPeriod':
      if (state.status !== 'running' && state.status !== 'paused') illegal('No period is in progress.');
      next.status = state.currentPeriod >= state.periodCount ? 'ended' : 'periodBreak';
      next.periods[next.periods.length - 1].endMs = at;
      break;
    case 'substitute': {
      if (!inProgress(state)) illegal('Substitutions need a game in progress.');
      const unit = unitOf(next, action.unitId);
      const index = unit.participantIds.indexOf(action.outParticipantId ?? '');
      if (index < 0) illegal('The leaving participant is not in that unit.');
      if (!action.inParticipantId || unit.participantIds.includes(action.inParticipantId)) {
        illegal('The entering participant is already in that unit.');
      }
      unit.participantIds[index] = action.inParticipantId!;
      break;
    }
    case 'switchUnit':
      if (!inProgress(state)) illegal('Unit switches need a game in progress.');
      if (state.units.length < 2) illegal('This sport has one unit.');
      if (unitOf(state, action.unitId).unitId === state.activeUnitId) illegal('That unit is already active.');
      next.activeUnitId = action.unitId!;
      break;
    case 'correct':
      if (state.status === 'notStarted' || state.status === 'finalized') illegal('Nothing can be corrected now.');
      break;
    case 'finalize':
      if (state.status !== 'ended') illegal('End the final period before finalizing.');
      next.status = 'finalized';
      break;
    default:
      bad('Unknown action.');
  }
  // Union semantics: a participant in several football units accrues one interval while any active unit holds them.
  const before = counted(state);
  const after = counted(next);
  for (const id of before) {
    if (after.has(id)) continue;
    const from = next.openSince[id];
    delete next.openSince[id];
    if (at <= from) continue;
    const list = next.intervals[id] ?? (next.intervals[id] = []);
    const last = list[list.length - 1];
    if (last && last.to === from) last.to = at;
    else list.push({ from, to: at });
  }
  for (const id of after) if (!before.has(id)) next.openSince[id] = at;
  if (next.sequence + actionsToFinalize(next) > MAX_PLAY_ACTIONS) {
    throw new PlayLedgerError('ACTION_LIMIT', 'This game reached its action limit. End the remaining periods and finalize.');
  }
  return next;
}

/** Folds corrections into their target substitutions. Raw actions stay unchanged. */
export function effectiveActions(actions: PlayAction[]): PlayAction[] {
  if (actions.length > MAX_PLAY_ACTIONS) bad(`Sessions support at most ${MAX_PLAY_ACTIONS} actions.`);
  const result = actions.map(action => ({ ...action }));
  result.forEach((action, index) => {
    if (action.sequence !== index + 1) bad('Action sequence has a gap.');
    if (action.kind !== 'correct') return;
    const target = result[(action.targetSequence ?? 0) - 1];
    if (!target || target.sequence >= action.sequence || target.kind !== 'substitute') {
      bad('A correction must reference an earlier substitution.');
    }
    if (!action.reason?.trim() || !action.corrected) bad('Corrections need a reason.');
    Object.assign(target, action.corrected);
  });
  return result;
}

export function replayPlayLedger(actions: PlayAction[]): LedgerState {
  return effectiveActions(actions).reduce(applyPlayAction, initialLedger());
}

/** Replays with a proposed correction, reporting which participants a coach must review. */
export function replayWithCorrection(actions: PlayAction[], correction: PlayAction) {
  let state: LedgerState;
  try {
    state = replayPlayLedger([...actions, correction]);
  } catch (error) {
    if (error instanceof PlayLedgerError && error.code === 'ILLEGAL_TRANSITION') {
      throw new PlayLedgerError('CORRECTION_CONFLICT', 'This correction conflicts with later actions. Correct those first.');
    }
    throw error;
  }
  // Compare against the previous effective version, which may itself be corrected, plus any changed total.
  const previous = effectiveActions(actions)[correction.targetSequence! - 1];
  const affected = new Set([previous.outParticipantId!, previous.inParticipantId!, correction.corrected!.outParticipantId, correction.corrected!.inParticipantId]);
  const before = ledgerTotals(replayPlayLedger(actions), state.elapsedMs);
  const after = ledgerTotals(state);
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[id] !== after[id]) affected.add(id);
  return { state, affectedParticipantIds: [...affected].sort() };
}

/** Totals as of a game-elapsed instant; open intervals close at asOfMs. Each total is bounded by the measured duration. */
export function ledgerTotals(state: LedgerState, asOfMs = state.elapsedMs): Record<string, number> {
  const asOf = Math.max(asOfMs, state.elapsedMs);
  const totals: Record<string, number> = {};
  for (const [id, list] of Object.entries(state.intervals)) {
    totals[id] = list.reduce((sum, interval) => sum + interval.to - interval.from, 0);
  }
  for (const [id, from] of Object.entries(state.openSince)) totals[id] = (totals[id] ?? 0) + asOf - from;
  for (const total of Object.values(totals)) {
    if (total < 0 || total > asOf) throw new PlayLedgerError('INVALID_ACTION', 'Playing time exceeded the measured game duration.');
  }
  return totals;
}
