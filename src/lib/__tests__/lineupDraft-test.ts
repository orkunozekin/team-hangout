import { LINEUP_PRESETS } from '../../../functions/src/coaching/presets';
import type { PrivateLineup } from '../../../shared/lineups';
import {
  addToBench,
  assignToSlot,
  changePreset,
  clearSlot,
  draftFromLineup,
  draftToPayload,
  emptyDraft,
  lineupError,
  moveBench,
  removeFromBench,
  unassignedParticipants,
} from '../coaching/lineupDraft';
import { getSportPreset, SPORT_PRESET_IDS } from '../coaching/lineupSurface';

const saved: PrivateLineup = {
  orgId: 'o', eventId: 'e', teamId: 't', revision: 4, sportPresetId: 'soccer', presetVersion: 1,
  units: [{ unitId: 'starting', slots: [{ slotId: 'gk', participantId: 'a', x: 0.4, y: 0.9 }] }],
  bench: ['d', 'b'], note: 'private', updatedAt: null, unavailableParticipantIds: [],
  roster: [
    { participantId: 'a', displayName: 'A', available: true },
    { participantId: 'b', displayName: 'B', available: true },
    { participantId: 'c', displayName: 'C', available: true },
    { participantId: 'd', displayName: 'D', available: true },
    { participantId: 'x', displayName: 'X', available: false },
  ],
  publication: { state: 'private', sourceRevision: null, publishedAt: null },
};

test('server slot identities stay aligned with the native presets', () => {
  for (const id of SPORT_PRESET_IDS) {
    const preset = getSportPreset(id);
    expect(LINEUP_PRESETS[id].version).toBe(preset.version);
    expect(LINEUP_PRESETS[id].units).toEqual(preset.units.map((unit) => ({ id: unit.id, slots: unit.slots.map((slot) => slot.id) })));
    for (const unit of preset.units) expect(new Set(unit.slots.map((slot) => slot.id)).size).toBe(unit.slots.length);
  }
  expect(getSportPreset('football').units.map((unit) => unit.id)).toEqual(['offense', 'defense', 'specialTeams']);
});

test('saved lineups round-trip coordinates and explicit bench order without reordering', () => {
  const draft = draftFromLineup(saved);
  expect(draftToPayload(draft, 't')).toEqual({
    teamId: 't', sportPresetId: 'soccer', units: saved.units, bench: ['d', 'b'], note: 'private',
  });
  expect(draftFromLineup({ ...saved, sportPresetId: null, units: [] }, 'basketball').units).toEqual({ onCourt: [] });
  expect(unassignedParticipants(draft, saved.roster, 'starting').map((r) => r.participantId)).toEqual(['c']);
});

test('assignment keeps each participant once per unit and moves them off the bench', () => {
  let draft = draftFromLineup(saved);
  draft = assignToSlot(draft, 'starting', 'st', 'b');
  expect(draft.bench).toEqual(['d']);
  draft = assignToSlot(draft, 'starting', 'st', 'a');
  expect(draft.units.starting.map((p) => [p.slotId, p.participantId]).sort()).toEqual([['gk', 'b'], ['st', 'a']]);
  draft = clearSlot(draft, 'starting', 'gk');
  expect(draft.units.starting.map((p) => p.participantId)).toEqual(['a']);
  draft = addToBench(draft, 'a');
  expect(draft.units.starting).toEqual([]);
  expect(draft.bench).toEqual(['d', 'a']);
  expect(addToBench(draft, 'a').bench).toEqual(['d', 'a']);
  expect(() => assignToSlot(draft, 'offense', 'qb', 'a')).toThrow('Unknown unit');
  expect(() => assignToSlot(draft, 'starting', 'qb', 'a')).toThrow('Unknown slot');
});

test('football units are independent and switching sport keeps placed participants on the bench', () => {
  let draft = emptyDraft('football');
  draft = assignToSlot(draft, 'offense', 'qb', 'a');
  draft = assignToSlot(draft, 'defense', 'mlb', 'a');
  expect(draftToPayload(draft, 't').units.map((unit) => unit.slots.map((slot) => slot.participantId))).toEqual([['a'], ['a'], []]);
  const roster = [{ participantId: 'a', displayName: 'A', available: true }];
  expect(unassignedParticipants(assignToSlot(emptyDraft('football'), 'offense', 'qb', 'a'), roster, 'defense')).toEqual(roster);
  expect(unassignedParticipants(assignToSlot(emptyDraft('football'), 'offense', 'qb', 'a'), roster, 'offense')).toEqual([]);
  const soccer = changePreset({ ...draft, bench: ['b'] }, 'soccer');
  expect(soccer.units).toEqual({ starting: [] });
  expect(soccer.bench).toEqual(['b', 'a']);
  expect(changePreset(soccer, 'soccer')).toBe(soccer);
});

test('bench reordering is explicit and bounded', () => {
  const draft = { ...emptyDraft('soccer'), bench: ['a', 'b', 'c'] };
  expect(moveBench(draft, 'c', -1).bench).toEqual(['a', 'c', 'b']);
  expect(moveBench(draft, 'a', -1)).toBe(draft);
  expect(moveBench(draft, 'c', 1)).toBe(draft);
  expect(moveBench(draft, 'z', 1)).toBe(draft);
  expect(removeFromBench(draft, 'b').bench).toEqual(['a', 'c']);
});

test('errors distinguish offline, conflict, departure and denial', () => {
  expect(lineupError({ code: 'functions/unavailable' }).kind).toBe('offline');
  expect(lineupError({ code: 'functions/aborted', details: { domainCode: 'STALE_REVISION' } }).kind).toBe('conflict');
  expect(lineupError({ code: 'functions/failed-precondition', details: { domainCode: 'PARTICIPANT_UNAVAILABLE' } }).kind).toBe('unavailable');
  expect(lineupError({ code: 'functions/permission-denied' }).kind).toBe('denied');
  expect(lineupError({ message: 'Other' })).toEqual({ kind: 'other', message: 'Other' });
  expect(lineupError({}).message).toMatch('Reload');
});
