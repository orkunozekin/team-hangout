import { test } from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../../shared/contracts.ts';
const { timestampToIso, isoToTimestamp, decodeParents, decodeTeam, decodeStaff, decodeEvent, decodeLegacyDates } = contracts;
import { stamp, parentsA, parentsB, teamV2, staffV2, eventV2 } from './fixtures.mjs';

test('v2 storage timestamps serialize to callable ISO and round trip at millisecond precision', () => {
  assert.deepEqual(isoToTimestamp(timestampToIso(stamp)), stamp);
  assert.deepEqual(isoToTimestamp('1969-12-31T23:59:59.999Z'), { seconds: -1, nanoseconds: 999000000 });
  assert.equal(timestampToIso(new Date('2026-10-10T00:00:00.000Z')), '2026-10-10T00:00:00.000Z');
});
test('malformed legacy and v2 timestamps fail explicitly without substituting now', () => {
  for (const invalid of [undefined, null, '', 0, 'bad', '2026-02-30T00:00:00.000Z', new Date(NaN), {}, { seconds: 1, nanoseconds: -1 }, { seconds: Infinity, nanoseconds: 0 }, { seconds: 253402300800, nanoseconds: 0 }, '0000-01-01T00:00:00.000Z']) {
    assert.throws(() => timestampToIso(invalid));
    assert.throws(() => decodeLegacyDates({ date: invalid }, ['date']));
    assert.throws(() => decodeEvent({ ...eventV2, startsAt: invalid }, parentsA, { 'team-a': parentsA }));
  }
});
test('canonical hierarchy and roles reject forged scope and malformed records', () => {
  assert.equal(decodeTeam(teamV2, parentsA).orgId, 'org-a');
  assert.deepEqual(decodeStaff(staffV2, 'org-a').roles, ['programStaff']);
  for (const field of Object.keys(parentsA)) {
    assert.throws(() => decodeTeam({ ...teamV2, [field]: parentsB[field] }, parentsA));
    assert.throws(() => decodeParents({ ...parentsA, [field]: '' }));
  }
  for (const roles of [['coach'], ['[orgAdmin]'], [], ['orgAdmin', 'orgAdmin'], 'orgAdmin']) {
    assert.throws(() => decodeStaff({ ...staffV2, roles }, 'org-a'));
  }
  assert.throws(() => decodeStaff(staffV2, 'org-b'));
  assert.throws(() => decodeStaff({ ...staffV2, programIds: [] }, 'org-a'));
  for (const revision of [0, -1, 1.5, '1']) assert.throws(() => decodeTeam({ ...teamV2, revision }, parentsA));
  assert.throws(() => decodeTeam({ ...teamV2, schemaVersion: 1 }, parentsA));
});
test('event parents, canonical team set, lifecycle and instants are independently validated', () => {
  const teams = { 'team-a': parentsA, 'team-b': parentsB };
  assert.equal(decodeEvent(eventV2, parentsA, teams).publicationState, 'published');
  for (const patch of [{ orgId: 'org-b' }, { teamIds: [] }, { teamIds: ['team-a', 'team-b'] }, { teamIds: ['team-a', 'team-a'] },
    { teamId: 'team-b' }, { teamIds: ['unknown'] }, { endsAt: stamp }, { timeZone: 'invalid' }, { status: 'draft' }, { publicationState: 'scheduled' }]) {
    assert.throws(() => decodeEvent({ ...eventV2, ...patch }, parentsA, teams));
  }
});
