import { estimateElapsedMs, formatGameClock, parseGameClock, playError } from '../coaching/playClock';

test('a running estimate advances from the acknowledged anchor and survives a background gap', () => {
  const reading = { status: 'running' as const, elapsedMs: 90_000 };
  expect(estimateElapsedMs(reading, 1_000, 1_000)).toBe(90_000);
  // Returning from background ten minutes later recomputes from the same anchor without intermediate ticks.
  expect(estimateElapsedMs(reading, 1_000, 601_000)).toBe(690_000);
  expect(estimateElapsedMs(reading, 1_000, 500)).toBe(90_000);
  expect(estimateElapsedMs({ status: 'paused', elapsedMs: 90_000 }, 1_000, 601_000)).toBe(90_000);
});

test('game clock formatting and correction parsing round-trip', () => {
  expect(formatGameClock(0)).toBe('0:00');
  expect(formatGameClock(65_999)).toBe('1:05');
  expect(formatGameClock(-5)).toBe('0:00');
  expect(parseGameClock('12:34')).toBe(754_000);
  expect(parseGameClock(' 7 ')).toBe(420_000);
  expect(parseGameClock('1:75')).toBeNull();
  expect(parseGameClock('abc')).toBeNull();
});

test('play errors never claim an offline action was recorded', () => {
  expect(playError({ code: 'functions/unavailable' })).toEqual({ kind: 'offline', message: expect.stringContaining('nothing was queued') });
  expect(playError({ code: 'functions/aborted', details: { domainCode: 'STALE_REVISION' } }).kind).toBe('conflict');
  expect(playError({ details: { domainCode: 'PARTICIPANT_UNAVAILABLE' } }).kind).toBe('unavailable');
  expect(playError({ details: { domainCode: 'LINEUP_NOT_SAVED' } }).message).toBe('Save a lineup before starting the clock.');
  expect(playError({ message: 'Conflict', details: { domainCode: 'CORRECTION_CONFLICT' } })).toEqual({ kind: 'illegal', message: 'Conflict' });
  expect(playError({ details: { domainCode: 'ILLEGAL_TRANSITION' } }).message).toContain('not available now');
  expect(playError({ code: 'functions/permission-denied' }).kind).toBe('denied');
  expect(playError({ message: 'Boom' })).toEqual({ kind: 'other', message: 'Boom' });
  expect(playError({}).message).toContain('Playing time unavailable');
});
