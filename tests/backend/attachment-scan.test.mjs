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

const validJpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda000800010100003f007f00ffd9", "hex");
function app1(payload) {
  const data = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from(payload)]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), length, data]);
}
function withExif(bytes, payload) {
  return Buffer.concat([bytes.subarray(0, 2), app1(payload), bytes.subarray(2)]);
}
function pngText(bytes, text) {
  const data = Buffer.concat([Buffer.from("Comment\0"), Buffer.from(text)]);
  const type = Buffer.from("tEXt");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(scan.attachmentCrc32(Buffer.concat([type, data])) >>> 0);
  const chunk = Buffer.concat([length, type, data, crc]);
  const end = bytes.lastIndexOf(Buffer.from("IEND"));
  return Buffer.concat([bytes.subarray(0, end - 4), chunk, bytes.subarray(end - 4)]);
}

test('the content scanner strips image metadata, rejects active PDF content, and fails closed', async () => {
  assert.equal(scan.ATTACHMENT_QUARANTINE_TTL_MS, 24 * 60 * 60 * 1000);
  const marked = withExif(validJpeg, "GPS-SYNTHETIC");
  const jpeg = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: marked.length, bytes: marked, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(jpeg.state, "ready");
  assert.equal(jpeg.scan.scanner, "content");
  assert.equal(jpeg.bytes.includes(Buffer.from("GPS-SYNTHETIC")), false);
  assert.equal(jpeg.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), true);
  assert.notEqual(jpeg.sha256, scan.sha256(marked));
  const again = await scan.contentScanner({ bytes: jpeg.bytes, detectedType: "image/jpeg" });
  assert.equal(Buffer.compare(again.bytes, jpeg.bytes), 0);
  const text = pngText(png, "GPS-SYNTHETIC");
  const image = await scan.reviewAttachment({ fileName: "diagram.png", declaredBytes: text.length, bytes: text, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(image.state, "ready");
  assert.equal(image.bytes.includes(Buffer.from("GPS-SYNTHETIC")), false);
  assert.equal(Buffer.compare(image.bytes, png), 0);
  const info = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Title (GPS-SYNTHETIC) >>\nendobj\n%%EOF\nTRAILING-GARBAGE");
  const pdf = await scan.reviewAttachment({ fileName: "notes.pdf", declaredBytes: info.length, bytes: info, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(pdf.state, "ready");
  assert.equal(pdf.bytes.includes(Buffer.from("GPS-SYNTHETIC")), false);
  assert.equal(pdf.bytes.includes(Buffer.from("TRAILING-GARBAGE")), false);
  assert.equal(pdf.bytes.includes(Buffer.from("%PDF-")), true);
  const active = Buffer.from("%PDF-1.4\n1 0 obj\n<< /JavaScript (alert) >>\nendobj\n%%EOF");
  const script = await scan.reviewAttachment({ fileName: "notes.pdf", declaredBytes: active.length, bytes: active, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(script.state, "rejected");
  assert.equal(script.code, "ACTIVE_CONTENT");
  const encoded = Buffer.from("%PDF-1.4\n1 0 obj\n<< /J#61vaScript (alert) >>\nendobj\n%%EOF");
  const escaped = await scan.reviewAttachment({ fileName: "notes.pdf", declaredBytes: encoded.length, bytes: encoded, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(escaped.code, "ACTIVE_CONTENT");
  const hexName = Buffer.from("%PDF-1.4\n1 0 obj\n<< /#4A#53 (alert) >>\nendobj\n%%EOF");
  const hex = await scan.reviewAttachment({ fileName: "notes.pdf", declaredBytes: hexName.length, bytes: hexName, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(hex.code, "ACTIVE_CONTENT");
  const head = "%PDF-1.4\n1 0 obj\n<< /Title (GPS-SYNTHETIC) >>\nendobj\n";
  const xrefAt = Buffer.byteLength(head);
  const linkedPdf = Buffer.from(`${head}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n${xrefAt}\n%%EOF\nTRAILING-GARBAGE`);
  const stable = await scan.reviewAttachment({ fileName: "notes.pdf", declaredBytes: linkedPdf.length, bytes: linkedPdf, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.contentScanner, scannerName: "content" });
  assert.equal(stable.state, "ready");
  assert.equal(stable.bytes.includes(Buffer.from("GPS-SYNTHETIC")), false);
  assert.equal(stable.bytes.includes(Buffer.from("TRAILING-GARBAGE")), false);
  assert.equal(stable.bytes.indexOf("xref"), xrefAt);
  assert.equal(stable.bytes.includes(Buffer.from(`startxref\n${xrefAt}\n`)), true);
  assert.equal(stable.byteLength, linkedPdf.length - Buffer.from("TRAILING-GARBAGE").length);
  assert.equal(script.scan.scanner, "content");
  assert.notEqual(script.code, "INTEGRITY");
  assert.notEqual(script.code, "ACCESS_REVOKED");
  assert.notEqual(script.code, "SIGNATURE_MISMATCH");
  const offline = scan.selectAttachmentScanner({ mode: "unavailable" });
  const failed = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: validJpeg.length, bytes: validJpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: offline.scan, scannerName: offline.name });
  assert.equal(failed.code, "SCAN_FAILED");
  assert.notEqual(failed.code, "INTEGRITY");
  const missing = scan.selectAttachmentScanner({ mode: "external" });
  const blocked = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: validJpeg.length, bytes: validJpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: missing.scan, scannerName: missing.name });
  assert.equal(blocked.code, "SCAN_FAILED");
  const calls = [];
  const external = scan.selectAttachmentScanner({ mode: "external", externalUrl: "https://scanner.example.test/scan" }, async (url, init) => {
    calls.push({ url, type: init.headers["x-detected-type"], body: Buffer.from(init.body) });
    return { ok: false, status: 503, json: async () => ({}) };
  });
  const remoteDown = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: marked.length, bytes: marked, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: external.scan, scannerName: external.name });
  assert.equal(remoteDown.code, "SCAN_FAILED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.includes(Buffer.from("GPS-SYNTHETIC")), false);
  const rejecting = scan.selectAttachmentScanner({ mode: "external", externalUrl: "https://scanner.example.test/scan" }, async () => ({ ok: true, status: 200, json: async () => ({ verdict: "rejected", code: "MALWARE" }) }));
  const malware = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: validJpeg.length, bytes: validJpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: rejecting.scan, scannerName: rejecting.name });
  assert.equal(malware.code, "MALWARE");
  assert.equal(malware.scan.scanner, "external");
  for (const code of ["INTEGRITY", "ACCESS_REVOKED"]) {
    const spoof = scan.selectAttachmentScanner({ mode: "external", externalUrl: "https://scanner.example.test/scan" }, async () => ({ ok: true, status: 200, json: async () => ({ verdict: "rejected", code }) }));
    const reserved = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: validJpeg.length, bytes: validJpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: spoof.scan, scannerName: spoof.name });
    assert.equal(reserved.code, "SCAN_REJECTED");
    assert.equal(reserved.scan.scanner, "external");
    assert.notEqual(reserved.code, code);
  }
  const clean = scan.selectAttachmentScanner({ mode: "content" });
  assert.equal(clean.name, "content");
  assert.equal(scan.selectAttachmentScanner({ mode: "skip" }).scan === clean.scan, false);
  const unknown = await scan.reviewAttachment({ fileName: "photo.jpg", declaredBytes: validJpeg.length, bytes: validJpeg, expiresAtMs: Date.now() + 1000, nowMs: Date.now(), scanner: scan.selectAttachmentScanner({ mode: "skip" }).scan, scannerName: "content" });
  assert.equal(unknown.code, "SCAN_FAILED");
  assert.equal(scan.abandonedAttachment({ state: "ready", createdAtMs: 1, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 5 }), false);
  assert.equal(scan.abandonedAttachment({ state: "quarantined", createdAtMs: 1, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 1 }), true);
  assert.equal(scan.abandonedAttachment({ state: "canonicalizing", createdAtMs: 1, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 1 }), true);
  assert.equal(scan.abandonedAttachment({ state: "quarantined", createdAtMs: 10_000, nowMs: 10_000 + scan.ATTACHMENT_QUARANTINE_TTL_MS - 1 }), false);
  assert.equal(scan.abandonedObject({ timeCreatedMs: 1, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 1, ready: false }), true);
  assert.equal(scan.abandonedObject({ timeCreatedMs: 1, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 1, ready: true }), false);
  assert.equal(scan.abandonedObject({ timeCreatedMs: null, nowMs: scan.ATTACHMENT_QUARANTINE_TTL_MS + 1, ready: false }), false);
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
