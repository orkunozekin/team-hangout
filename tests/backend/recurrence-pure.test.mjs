import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { generateOccurrences } = require('./lib/recurrence/generator');
const fields = { title: 'Practice', startsOn: '2035-03-04', endsOn: '2035-03-18', weekdays: [0], localTime: '02:30', timeZone: 'America/Chicago', durationMinutes: 60, exclusions: [], offsets: {}, facilityId: null, resourceId: null };
const generate = patch => generateOccurrences('stable', { ...fields, ...patch });
test('calendar recurrence rejects spring gaps and preserves wall time across 23 hour days', () => {
  const rows = generate({}); assert.equal(rows.length, 3); assert.equal(rows[1].localDate, '2035-03-11'); assert.match(rows[1].issue, /does not exist/);
  const valid = generate({ localTime: '17:00' });
  assert.equal(valid[0].startsAt, '2035-03-04T23:00:00.000Z'); assert.equal(valid[1].startsAt, '2035-03-11T22:00:00.000Z');
  assert.equal(valid[0].id, generate({ localTime: '18:00' })[0].id);
  assert.equal(generate({ exclusions: ['2035-03-11'] }).length, 2);
});
test('repeated time requires actual offset and produces distinct canonical instants', () => {
  const patch = { startsOn: '2035-11-04', endsOn: '2035-11-04', localTime: '01:30' };
  const [row] = generate(patch); assert.equal(row.choices.length, 2); assert.equal(row.startsAt, null);
  assert.equal(generate({ ...patch, offsets: { '2035-11-04': -300 } })[0].startsAt, '2035-11-04T06:30:00.000Z');
  assert.equal(generate({ ...patch, offsets: { '2035-11-04': -360 } })[0].startsAt, '2035-11-04T07:30:00.000Z');
  assert.ok(generate({ ...patch, offsets: { '2035-11-04': 0 } })[0].issue);
});
test('half-hour transitions, skipped date, leap day, bounds and deterministic output', () => {
  const row = generate({ startsOn: '2035-04-01', endsOn: '2035-04-01', localTime: '01:45', timeZone: 'Australia/Lord_Howe' })[0];
  assert.equal(row.choices.length, 2); assert.deepEqual(row.choices.map(c => c.offsetMinutes), [660, 630]);
  assert.ok(generate({ startsOn: '2011-12-30', endsOn: '2011-12-30', weekdays: [5], timeZone: 'Pacific/Apia' })[0].issue);
  assert.equal(generate({ startsOn: '2036-02-29', endsOn: '2036-02-29', weekdays: [5], timeZone: 'UTC' }).length, 1);
  assert.deepEqual(generate({ localTime: '17:00' }), generate({ localTime: '17:00' }));
  for (const patch of [{ endsOn: '2035-07-01' }, { startsOn: '2035-02-29' }, { exclusions: ['2035-03-05'] }, { offsets: { '2035-03-05': 0 } }, { weekdays: [] }, { timeZone: '+0500' }, { weekdays: [0,1,2,3,4,5,6], endsOn: '2035-06-01' }]) assert.throws(() => generate(patch));
});
