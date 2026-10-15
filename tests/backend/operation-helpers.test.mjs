import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { fingerprint, receiptId } = require('./lib/operations/requests.js');
const { checkRevision } = require('./lib/operations/revisions.js');
const { eventScope } = require('./lib/operations/access.js');
const { validateStoredEvent } = require('./lib/organizations/events.js');
const hash = value => createHash('sha256').update(value).digest('hex');

test('Phase 1 receipt identities and normalized payload fingerprints survive extraction', () => {
  assert.equal(receiptId('actor', 'saveTeam', 'request', 'org-a'), hash('actor:saveTeam:org-a:request'));
  assert.equal(receiptId('actor', 'createEvent', 'request'), hash('actor:createEvent:request'));
  assert.equal(fingerprint({ z: ['b', 'a'], a: null }), hash('{"a":null,"z":{"0":"b","1":"a"}}'));
  assert.equal(fingerprint({ a: null, z: ['b', 'a'] }), fingerprint({ z: ['b', 'a'], a: null }));
  assert.notEqual(fingerprint({ z: ['a', 'b'] }), fingerprint({ z: ['b', 'a'] }));
  for (const args of [['other', 'saveTeam', 'request', 'org-a'], ['actor', 'saveEvent', 'request', 'org-a'], ['actor', 'saveTeam', 'request', 'org-b']]) {
    assert.notEqual(receiptId(...args), receiptId('actor', 'saveTeam', 'request', 'org-a'));
  }
});
test('revision helper rejects stale, malformed and exhausted revisions with supported transport codes', () => {
  checkRevision(undefined, 0); checkRevision({ revision: 2 }, 2);
  assert.throws(() => checkRevision({ revision: 2 }, 1), error => error.code === 'aborted' && error.details.domainCode === 'STALE_REVISION' && error.details.currentRevision === 2);
  for (const value of [-1, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => checkRevision({ revision: value }, 2), { code: 'invalid-argument' });
    assert.throws(() => checkRevision({ revision: 2 }, value), { code: 'invalid-argument' });
  }
  assert.throws(() => checkRevision({ revision: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER), { code: 'failed-precondition' });
});
test('event authority rejects empty/duplicate teams before database reads and validates exact canonical identities', async () => {
  for (const ids of [[], ['a', 'a'], Array.from({ length: 21 }, (_, i) => `team-${i}`)]) {
    await assert.rejects(eventScope(null, ids, 'actor'), { code: 'permission-denied' });
  }
  const scope = { orgId: 'org-a', programId: 'program-a', seasonId: 'season-a', teamIds: ['team-a'], teams: [{ divisionId: 'division-a' }] };
  const event = { ...scope, teamId: 'team-a', divisionId: 'division-a', status: 'scheduled', publicationState: 'published', publicationOperationId: null };
  validateStoredEvent(event, scope);
  assert.throws(() => validateStoredEvent({ ...event, teamId: 'other', teamIds: ['other'] }, scope), { code: 'permission-denied' });
});
test('read caches deduplicate concurrent document batches and never carry snapshots to another transaction attempt', async () => {
  const { cacheDocumentReads } = require('./lib/operations/reads.js');
  const { DocumentReference } = require('firebase-admin/firestore');
  const ref = Object.assign(Object.create(DocumentReference.prototype), {});
  Object.defineProperty(ref, 'path', { value: 'organizations/cache-fixture' });
  let reads = 0;
  const transaction = { getAll: async (...refs) => { reads += refs.length; return refs.map(ref => ({ ref, revision: reads })); } };
  const first = cacheDocumentReads(transaction);
  const [single, batch] = await Promise.all([first.get(ref), first.getAll(ref, ref)]);
  assert.equal(reads, 1); assert.equal(single, batch[0]); assert.equal(batch[0], batch[1]);
  const next = cacheDocumentReads(transaction);
  assert.notEqual(await next.get(ref), single); assert.equal(reads, 2);
});
