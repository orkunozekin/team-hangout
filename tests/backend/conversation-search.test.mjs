import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { messageTokens, queryTokens } = require('./lib/communications/tokens');

test('message tokens are normalized unique words with a 200 word cap', () => {
  assert.deepEqual(messageTokens('  North-FIELD, north!  '), ['north', 'field']);
  assert.deepEqual(messageTokens('Go café'), ['go', 'café']);
  assert.deepEqual(messageTokens('a I'), []);
  const twoHundred = Array.from({ length: 200 }, (_, index) => `w${index}`).join(' ');
  assert.equal(messageTokens(twoHundred).length, 200);
  assert.equal(messageTokens(twoHundred).at(-1), 'w199');
  assert.throws(() => messageTokens(`${twoHundred} w200`), /200/);
});

test('search queries keep one to five normalized words', () => {
  assert.deepEqual(queryTokens(' South field '), ['south', 'field']);
  assert.throws(() => queryTokens('a I'), /word/);
  assert.throws(() => queryTokens('one two three four five six'), /five/);
});
