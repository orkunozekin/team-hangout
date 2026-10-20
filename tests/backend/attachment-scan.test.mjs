import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const scan = require('./lib/communications/attachmentScan.js');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF SYNTHETIC-JPEG-MARKER'), Buffer.from([0xff, 0xd9])]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n%SYNTHETIC-PDF-MARKER\n%%EOF');
const key = scan.DEMO_ATTACHMENT_UPLOAD_KEY;

test('the fake scanner accepts JPEG, PNG, and PDF signatures and rejects MIME lookalikes', async () => {
  assert.equal(scan.ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(scan.ATTACHMENT_LIMIT, 3);
  assert.equal(scan.ATTACHMENT_EXPIRY_SECONDS, 300);
  for (const [name, bytes, type] of [['photo.jpg', jpeg, 'image/jpeg'], ['diagram.png', png, 'image/png'], ['notes.pdf', pdf, 'application/pdf']]) {
    const review = await scan.reviewAttachment({ fileName: name, declaredBytes: bytes.length, bytes, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.developmentScanner });
    assert.equal(review.state, 'ready');
    assert.equal(review.detectedType, type);
    assert.equal(review.scan.scanner, 'fake');
    assert.equal(JSON.stringify(review).includes('SYNTHETIC'), false);
  }
  const html = Buffer.from('<!DOCTYPE html><p>SYNTHETIC-HTML</p>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  for (const [name, bytes, code] of [['photo.jpg', html, 'UNSAFE_CONTENT'], ['image.png', svg, 'UNSAFE_CONTENT'], ['photo.jpg', exe, 'UNSAFE_CONTENT'], ['photo.jpg', elf, 'UNSAFE_CONTENT'], ['notes.pdf', jpeg, 'SIGNATURE_MISMATCH'], ['photo.jpg', pdf, 'SIGNATURE_MISMATCH']]) {
    const review = await scan.reviewAttachment({ fileName: name, declaredBytes: bytes.length, bytes, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: () => { throw new Error('scanner should not run'); } });
    assert.equal(review.state, 'rejected');
    assert.equal(review.code, code);
  }
  assert.equal(scan.attachmentFileName('folder/photo.jpg').error, 'invalid');
  assert.equal(scan.attachmentFileName('page.html').error, 'invalid');
  assert.equal(scan.attachmentFileName('../photo.jpg').error, 'invalid');
});

test('review rejects expired, oversized, and mismatched bytes before a rejecting scanner can mark a file ready', async () => {
  const expired = await scan.reviewAttachment({ fileName: 'photo.jpg', declaredBytes: jpeg.length, bytes: jpeg, expiresAtMs: 1, nowMs: 1, scanner: scan.developmentScanner });
  assert.equal(expired.code, 'EXPIRED');
  const oversized = await scan.reviewAttachment({ fileName: 'photo.jpg', declaredBytes: scan.ATTACHMENT_MAX_BYTES + 1, bytes: jpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.developmentScanner });
  assert.equal(oversized.code, 'OVERSIZED');
  const mismatch = await scan.reviewAttachment({ fileName: 'photo.jpg', declaredBytes: jpeg.length + 1, bytes: jpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.developmentScanner });
  assert.equal(mismatch.code, 'SIZE_MISMATCH');
  const rejected = await scan.reviewAttachment({ fileName: 'photo.jpg', declaredBytes: jpeg.length, bytes: jpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: () => ({ verdict: 'rejected', code: 'MALWARE' }) });
  assert.equal(rejected.code, 'MALWARE');
  assert.equal(rejected.scan.scanner, 'fake');
  const failed = await scan.reviewAttachment({ fileName: 'photo.jpg', declaredBytes: jpeg.length, bytes: jpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: () => { throw new Error('offline'); } });
  assert.equal(failed.code, 'SCAN_FAILED');
});

test('upload grants expire and reject a tampered signature', () => {
  const grant = { v: 1, exp: Math.floor(Date.now() / 1000) + 300, attachmentId: 'file', uid: 'owner', orgId: 'org', bytes: jpeg.length, path: 'quarantine/org/file/1' };
  const token = scan.signUploadGrant(grant, key);
  assert.equal(scan.readUploadGrant(token, key, Date.now()).grant.attachmentId, 'file');
  assert.equal(scan.readUploadGrant(token, key, grant.exp * 1000).error, 'expired');
  const expired = scan.signUploadGrant({ ...grant, exp: 10 }, key);
  assert.equal(scan.readUploadGrant(expired, key, Date.now()).error, 'expired');
  const [body, signature] = token.split('.');
  const raw = Buffer.from(signature, 'base64url');
  raw[0] ^= 0x01;
  const flipped = raw.toString('base64url');
  assert.notEqual(flipped, signature);
  assert.equal(scan.readUploadGrant(`${body}.${flipped}`, key, Date.now()).error, 'invalid');
  assert.equal(scan.attachmentCorsOrigin('https://team-hangout-staging.web.app', false), 'https://team-hangout-staging.web.app');
  assert.equal(scan.attachmentCorsOrigin('https://team-hangout-staging.firebaseapp.com', false), 'https://team-hangout-staging.firebaseapp.com');
  assert.equal(scan.attachmentCorsOrigin('https://team-hangout-ddf27.web.app', false), 'https://team-hangout-ddf27.web.app');
  assert.equal(scan.attachmentCorsOrigin('https://team-hangout-ddf27.firebaseapp.com', false), 'https://team-hangout-ddf27.firebaseapp.com');
  assert.equal(scan.attachmentCorsOrigin('https://evil.example', true), null);
  assert.equal(scan.attachmentCorsOrigin('http://127.0.0.1:4177', false), null);
  assert.equal(scan.attachmentCorsOrigin('http://127.0.0.1:4177', true), 'http://127.0.0.1:4177');
  assert.equal(scan.attachmentCorsOrigin('http://localhost:4177', true), 'http://localhost:4177');
  assert.equal(scan.storageReadFailure({ code: 404 }), 'missing');
  assert.equal(scan.storageReadFailure({ code: '404' }), 'missing');
  assert.equal(scan.storageReadFailure({ code: 'ENOENT' }), 'missing');
  assert.equal(scan.storageReadFailure({ code: 503 }), 'retry');
  assert.equal(scan.storageReadFailure(new Error('timeout')), 'retry');
  assert.equal(scan.configuredAttachmentBucket('team-hangout-ddf27.firebasestorage.app'), 'team-hangout-ddf27.firebasestorage.app');
  assert.equal(scan.configuredAttachmentBucket('gs://team-hangout-staging.firebasestorage.app'), 'team-hangout-staging.firebasestorage.app');
  assert.equal(scan.configuredAttachmentBucket('demo-team-hangout.appspot.com'), 'demo-team-hangout.appspot.com');
  assert.equal(scan.configuredAttachmentBucket(undefined), null);
  assert.equal(scan.configuredAttachmentBucket(''), null);
  assert.equal(scan.configuredAttachmentBucket('gs://../secret'), null);
  assert.throws(() => scan.signUploadGrant({ ...grant, bytes: scan.ATTACHMENT_MAX_BYTES + 1 }, key));
  assert.throws(() => scan.uploadObjectPath('../org', 'file'));
});
