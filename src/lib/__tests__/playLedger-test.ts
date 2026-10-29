import {
  applyPlayAction,
  initialLedger,
  ledgerTotals,
  MAX_PLAY_ACTIONS,
  PlayLedgerError,
  replayPlayLedger,
  replayWithCorrection,
  type PlayAction,
} from '../../../functions/src/coaching/playLedger';

type Step = Omit<PlayAction, 'sequence'>;
const seq = (steps: Step[]): PlayAction[] => steps.map((step, index) => ({ ...step, sequence: index + 1 }));
const soccer = [{ unitId: 'starting', participantIds: ['a', 'b'] }];
const football = [
  { unitId: 'offense', participantIds: ['a', 'b'] },
  { unitId: 'defense', participantIds: ['a', 'c'] },
  { unitId: 'specialTeams', participantIds: ['d'] },
];
const code = (fn: () => unknown, expected: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PlayLedgerError);
    expect((error as PlayLedgerError).code).toBe(expected);
    return;
  }
  throw new Error('expected a PlayLedgerError');
};

test('pauses, period breaks and the final period bound each total by measured game time', () => {
  const actions = seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 2, units: soccer },
    { kind: 'pause', atElapsedMs: 300_000 },
    { kind: 'resume', atElapsedMs: 300_000 },
    { kind: 'endPeriod', atElapsedMs: 600_000 },
    { kind: 'substitute', atElapsedMs: 600_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' },
    { kind: 'start', atElapsedMs: 600_000 },
    { kind: 'endPeriod', atElapsedMs: 1_200_000 },
    { kind: 'finalize', atElapsedMs: 1_200_000 },
  ]);
  const state = replayPlayLedger(actions);
  expect(state.status).toBe('finalized');
  expect(state.periods).toEqual([
    { period: 1, startMs: 0, endMs: 600_000 },
    { period: 2, startMs: 600_000, endMs: 1_200_000 },
  ]);
  expect(ledgerTotals(state)).toEqual({ a: 1_200_000, b: 600_000, c: 600_000 });
  // Pauses and breaks span wall time but not game time, so contiguous game-time intervals merge.
  expect(state.intervals.a).toEqual([{ from: 0, to: 1_200_000 }]);
  expect(state.intervals.c).toEqual([{ from: 600_000, to: 1_200_000 }]);
  for (const total of Object.values(ledgerTotals(state))) expect(total).toBeLessThanOrEqual(state.elapsedMs);
});

test('substitutions at identical timestamps leave no zero-length or overlapping intervals', () => {
  const state = replayPlayLedger(seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 1, units: soccer },
    { kind: 'substitute', atElapsedMs: 60_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' },
    { kind: 'substitute', atElapsedMs: 60_000, unitId: 'starting', outParticipantId: 'c', inParticipantId: 'd' },
    { kind: 'substitute', atElapsedMs: 60_000, unitId: 'starting', outParticipantId: 'd', inParticipantId: 'b' },
    { kind: 'endPeriod', atElapsedMs: 120_000 },
  ]));
  expect(state.intervals.c).toBeUndefined();
  expect(state.intervals.d).toBeUndefined();
  expect(state.intervals.b).toEqual([{ from: 0, to: 120_000 }]);
  expect(ledgerTotals(state)).toEqual({ a: 120_000, b: 120_000 });
});

test('football participants in several units count the union of on-field time once', () => {
  const state = replayPlayLedger(seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 1, units: football },
    { kind: 'switchUnit', atElapsedMs: 100_000, unitId: 'defense' },
    { kind: 'switchUnit', atElapsedMs: 250_000, unitId: 'specialTeams' },
    { kind: 'switchUnit', atElapsedMs: 260_000, unitId: 'offense' },
    { kind: 'endPeriod', atElapsedMs: 300_000 },
  ]));
  expect(state.intervals.a).toEqual([{ from: 0, to: 250_000 }, { from: 260_000, to: 300_000 }]);
  expect(ledgerTotals(state)).toEqual({ a: 290_000, b: 140_000, c: 150_000, d: 10_000 });
});

test('live totals close open intervals at the requested elapsed instant', () => {
  let state = initialLedger();
  for (const action of seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 1, units: soccer },
    { kind: 'substitute', atElapsedMs: 30_000, unitId: 'starting', outParticipantId: 'a', inParticipantId: 'c' },
  ])) state = applyPlayAction(state, action);
  expect(ledgerTotals(state, 90_000)).toEqual({ a: 30_000, b: 90_000, c: 60_000 });
  // An earlier instant never rewinds below the acknowledged ledger.
  expect(ledgerTotals(state, 0)).toEqual({ a: 30_000, b: 30_000, c: 0 });
});

test('corrections recompute derived intervals while raw actions stay immutable', () => {
  const actions = seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 2, units: soccer },
    { kind: 'substitute', atElapsedMs: 400_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' },
    { kind: 'endPeriod', atElapsedMs: 600_000 },
  ]);
  const frozen = JSON.stringify(actions);
  const correction: PlayAction = {
    sequence: 4, kind: 'correct', atElapsedMs: 600_000, targetSequence: 2, reason: 'Scorer noted the change at 5:00',
    corrected: { atElapsedMs: 300_000, outParticipantId: 'b', inParticipantId: 'd' },
  };
  const { state, affectedParticipantIds } = replayWithCorrection(actions, correction);
  expect(affectedParticipantIds).toEqual(['b', 'c', 'd']);
  expect(ledgerTotals(state)).toEqual({ a: 600_000, b: 300_000, d: 300_000 });
  expect(state.units[0].participantIds).toEqual(['a', 'd']);
  expect(JSON.stringify(actions)).toBe(frozen);
  // Replay of the stored history plus correction is deterministic.
  expect(replayPlayLedger([...actions, correction])).toEqual(state);
});

test('corrections that contradict later actions or reference non-substitutions are rejected', () => {
  const actions = seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 1, units: soccer },
    { kind: 'substitute', atElapsedMs: 100_000, unitId: 'starting', outParticipantId: 'b', inParticipantId: 'c' },
    { kind: 'substitute', atElapsedMs: 200_000, unitId: 'starting', outParticipantId: 'c', inParticipantId: 'b' },
  ]);
  const correct = (patch: Partial<PlayAction>): PlayAction => ({
    sequence: 4, kind: 'correct', atElapsedMs: 250_000, targetSequence: 2, reason: 'Fix',
    corrected: { atElapsedMs: 100_000, outParticipantId: 'b', inParticipantId: 'd' }, ...patch,
  });
  code(() => replayWithCorrection(actions, correct({})), 'CORRECTION_CONFLICT');
  code(() => replayWithCorrection(actions, correct({ corrected: { atElapsedMs: 250_000, outParticipantId: 'b', inParticipantId: 'c' } })), 'INVALID_ACTION');
  code(() => replayPlayLedger([...actions, correct({ targetSequence: 1 })]), 'INVALID_ACTION');
  code(() => replayPlayLedger([...actions, correct({ reason: ' ' })]), 'INVALID_ACTION');
});

test('illegal clock transitions and malformed actions are rejected', () => {
  const started = replayPlayLedger(seq([{ kind: 'start', atElapsedMs: 0, periodCount: 1, units: soccer }]));
  const next = (step: Step) => applyPlayAction(started, { ...step, sequence: 2 });
  code(() => next({ kind: 'resume', atElapsedMs: 10 }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'start', atElapsedMs: 10 }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'finalize', atElapsedMs: 10 }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'switchUnit', atElapsedMs: 10, unitId: 'starting' }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'substitute', atElapsedMs: 10, unitId: 'starting', outParticipantId: 'c', inParticipantId: 'd' }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'substitute', atElapsedMs: 10, unitId: 'starting', outParticipantId: 'a', inParticipantId: 'b' }), 'ILLEGAL_TRANSITION');
  code(() => next({ kind: 'substitute', atElapsedMs: 10, unitId: 'bench', outParticipantId: 'a', inParticipantId: 'c' }), 'INVALID_ACTION');
  code(() => applyPlayAction(started, { kind: 'pause', atElapsedMs: 10, sequence: 3 }), 'INVALID_ACTION');
  code(() => next({ kind: 'pause', atElapsedMs: -1 }), 'INVALID_ACTION');
  const paused = next({ kind: 'pause', atElapsedMs: 10 });
  code(() => applyPlayAction(paused, { kind: 'resume', atElapsedMs: 20, sequence: 3 }), 'INVALID_ACTION');
  code(() => applyPlayAction(paused, { kind: 'pause', atElapsedMs: 10, sequence: 3 }), 'ILLEGAL_TRANSITION');
  const fresh = (step: Step) => applyPlayAction(initialLedger(), { ...step, sequence: 1 });
  code(() => fresh({ kind: 'pause', atElapsedMs: 0 }), 'ILLEGAL_TRANSITION');
  code(() => fresh({ kind: 'correct', atElapsedMs: 0 }), 'ILLEGAL_TRANSITION');
  code(() => fresh({ kind: 'start', atElapsedMs: 0, periodCount: 9, units: soccer }), 'INVALID_ACTION');
  code(() => fresh({ kind: 'start', atElapsedMs: 0, periodCount: 1, units: [] }), 'INVALID_ACTION');
  code(() => fresh({ kind: 'start', atElapsedMs: 0, periodCount: 1, units: [{ unitId: 'x', participantIds: ['a', 'a'] }] }), 'INVALID_ACTION');
  code(() => fresh({ kind: 'start', atElapsedMs: 0, periodCount: 1, units: [soccer[0], soccer[0]] }), 'INVALID_ACTION');
  code(() => fresh({ kind: 'nope' as PlayAction['kind'], atElapsedMs: 0 }), 'INVALID_ACTION');
  const ended = applyPlayAction(started, { kind: 'endPeriod', atElapsedMs: 50, sequence: 2 });
  code(() => applyPlayAction(ended, { kind: 'start', atElapsedMs: 50, sequence: 3 }), 'ILLEGAL_TRANSITION');
  code(() => applyPlayAction(ended, { kind: 'substitute', atElapsedMs: 50, sequence: 3, unitId: 'starting', outParticipantId: 'a', inParticipantId: 'c' }), 'ILLEGAL_TRANSITION');
  const breakState = replayPlayLedger(seq([
    { kind: 'start', atElapsedMs: 0, periodCount: 2, units: soccer },
    { kind: 'endPeriod', atElapsedMs: 10 },
  ]));
  code(() => applyPlayAction(breakState, { kind: 'start', atElapsedMs: 10, sequence: 3, periodCount: 2 }), 'INVALID_ACTION');
  code(() => replayPlayLedger(seq([{ kind: 'start', atElapsedMs: 0, periodCount: 1, units: soccer }]).map((a) => ({ ...a, sequence: 2 }))), 'INVALID_ACTION');
  code(() => replayPlayLedger(Array.from({ length: MAX_PLAY_ACTIONS + 1 }, (_, i) => ({ kind: 'pause', atElapsedMs: 0, sequence: i + 1 }))), 'INVALID_ACTION');
});

test('a corrupted ledger exceeding measured duration fails closed', () => {
  const state = { ...initialLedger(), elapsedMs: 10, intervals: { a: [{ from: 0, to: 20 }] } };
  code(() => ledgerTotals(state), 'INVALID_ACTION');
});
