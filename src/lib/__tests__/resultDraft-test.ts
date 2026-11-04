import { draftFromValues, emptyResultDraft, resultError, resultFromDraft, scoresTied } from '../competition/resultDraft';

const draft = (patch = {}) => ({ ...emptyResultDraft(), homeScore: '2', awayScore: '1', ...patch });

test('drafts build wire results and explain missing input', () => {
  expect(resultFromDraft(draft(), 'league', null)).toEqual({ values: { outcome: 'played', homeScore: 2, awayScore: 1, forfeitingTeamId: null, winnerTeamId: null, decider: null } });
  expect(resultFromDraft(draft({ homeScore: '' }), 'league', null)).toEqual({ error: expect.stringContaining('whole-number') });
  expect(resultFromDraft(draft({ homeScore: '1000' }), 'league', null)).toHaveProperty('error');
  expect(resultFromDraft(draft({ homeScore: '1.5' }), 'league', null)).toHaveProperty('error');
  // A league draw is allowed unless the rules forbid it.
  expect(resultFromDraft(draft({ awayScore: '2' }), 'league', { allowDraws: true })).toHaveProperty('values.winnerTeamId', null);
  expect(resultFromDraft(draft({ awayScore: '2' }), 'league', { allowDraws: false })).toEqual({ error: expect.stringContaining('do not allow draws') });
  expect(resultFromDraft(draft({ awayScore: '2' }), 'knockout', null)).toEqual({ error: expect.stringContaining('knockout match cannot end in a draw') });
  expect(resultFromDraft(draft({ awayScore: '2', winnerTeamId: 'a', decider: 'penalties' }), 'knockout', null)).toHaveProperty('values.decider', 'penalties');
  expect(resultFromDraft(draft({ outcome: 'forfeit' }), 'league', null)).toEqual({ error: 'Choose the team that forfeited.' });
  expect(resultFromDraft(draft({ outcome: 'forfeit', forfeitingTeamId: 'a' }), 'league', null)).toHaveProperty('values.homeScore', null);
  expect(resultFromDraft(draft({ outcome: 'void' }), 'league', null)).toHaveProperty('values.outcome', 'void');
});

test('drafts reload from a proposal', () => {
  expect(draftFromValues(null)).toEqual(emptyResultDraft());
  expect(draftFromValues({ outcome: 'played', homeScore: 1, awayScore: 1, forfeitingTeamId: null, winnerTeamId: 'a', decider: 'penalties' }))
    .toEqual({ outcome: 'played', homeScore: '1', awayScore: '1', forfeitingTeamId: null, winnerTeamId: 'a', decider: 'penalties' });
  expect(draftFromValues({ outcome: 'forfeit', homeScore: null, awayScore: null, forfeitingTeamId: 'b', winnerTeamId: 'a', decider: null }))
    .toMatchObject({ homeScore: '', winnerTeamId: null, forfeitingTeamId: 'b' });
});

test('errors map transport and domain failures', () => {
  expect(resultError({ code: 'functions/unavailable' }).kind).toBe('offline');
  expect(resultError({ details: { domainCode: 'STALE_REVISION' } }).kind).toBe('conflict');
  expect(resultError({ details: { domainCode: 'RESULT_FINAL' } }).kind).toBe('final');
  expect(resultError({ message: 'No draw', details: { domainCode: 'INVALID_KNOCKOUT_DRAW' } })).toEqual({ kind: 'invalid', message: 'No draw' });
  expect(resultError({ details: { domainCode: 'EVENT_NOT_PLAYED' } }).message).toBe('This result cannot be recorded.');
  expect(resultError({ code: 'functions/permission-denied' }).kind).toBe('denied');
  expect(resultError({ message: 'x' })).toEqual({ kind: 'other', message: 'x' });
  expect(resultError({}).message).toContain('unavailable');
});

test('ties compare parsed scores', () => {
  expect(scoresTied({ homeScore: '01', awayScore: '1' })).toBe(true);
  expect(scoresTied({ homeScore: '2', awayScore: '1' })).toBe(false);
  expect(scoresTied({ homeScore: '', awayScore: '' })).toBe(false);
  expect(scoresTied({ homeScore: 'x', awayScore: 'x' })).toBe(false);
});
