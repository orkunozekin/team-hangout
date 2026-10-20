const mockFetch = jest.fn();
const mockPick = jest.fn();
const sizes: Record<string, number> = {};
const written: { uri: string; bytes: Uint8Array }[] = [];

jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (...args: unknown[]) => mockPick(...args) }));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get size() { return sizes[this.uri] ?? 0; }
    get type() { return 'image/jpeg'; }
    write(bytes: Uint8Array) { written.push({ uri: this.uri, bytes }); }
  },
}));

import { File } from 'expo-file-system';
import { downloadConversationFile, pickConversationAttachment, uploadConversationFile } from '../attachmentTransport';

const grant = { uploadUrl: 'https://example.test/attachmentTransport', token: 'signed-token', expiresAt: '2099-01-01T00:00:00.000Z', maxBytes: 32 };

beforeEach(() => {
  mockFetch.mockReset();
  mockPick.mockReset();
  written.length = 0;
  for (const key of Object.keys(sizes)) delete sizes[key];
});

test('picks one cached JPEG, PNG, or PDF and uploads those bytes with expo fetch', async () => {
  sizes['file:///cache/photo.jpg'] = 32;
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/photo.jpg', name: 'photo.jpg', mimeType: 'text/html', size: 1 }] });
  const picked = await pickConversationAttachment();
  expect(mockPick).toHaveBeenCalledWith({ type: ['image/jpeg', 'image/png', 'application/pdf'], copyToCacheDirectory: true, multiple: false });
  expect(picked?.name).toBe('photo.jpg');
  expect(picked?.size).toBe(32);
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  await uploadConversationFile(picked!.file, grant);
  expect(mockFetch).toHaveBeenCalledWith(grant.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: 'Attachment signed-token', 'Content-Type': 'application/octet-stream' },
    body: expect.any(File),
  });
});

test('a cancelled picker and an oversized or empty file never start an upload', async () => {
  mockPick.mockResolvedValueOnce({ canceled: true, assets: null });
  await expect(pickConversationAttachment()).resolves.toBeNull();
  sizes['file:///cache/huge.jpg'] = 10 * 1024 * 1024 + 1;
  mockPick.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///cache/huge.jpg', name: 'huge.jpg' }] });
  await expect(pickConversationAttachment()).rejects.toThrow('This file is larger than 10 MB.');
  sizes['file:///cache/empty.jpg'] = 0;
  mockPick.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///cache/empty.jpg', name: 'empty.jpg' }] });
  await expect(pickConversationAttachment()).rejects.toThrow('This file is empty.');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('an expired grant or a rejected upload does not pretend the file transferred', async () => {
  sizes['file:///cache/photo.jpg'] = 32;
  const file = new File('file:///cache/photo.jpg');
  await expect(uploadConversationFile(file, { ...grant, expiresAt: '2000-01-01T00:00:00.000Z' })).rejects.toThrow('This upload expired');
  sizes['file:///cache/photo.jpg'] = 31;
  await expect(uploadConversationFile(file, grant)).rejects.toThrow('does not match the reserved upload');
  expect(mockFetch).not.toHaveBeenCalled();
  sizes['file:///cache/photo.jpg'] = 32;
  mockFetch.mockResolvedValueOnce({ ok: false, status: 410 });
  await expect(uploadConversationFile(file, grant)).rejects.toThrow('This upload expired');
  mockFetch.mockResolvedValueOnce({ ok: false, status: 413 });
  await expect(uploadConversationFile(file, grant)).rejects.toThrow('larger than 10 MB');
  mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
  await expect(uploadConversationFile(file, grant)).rejects.toThrow('was not uploaded');
});

test('downloads the authenticated response into a local file', async () => {
  const destination = new File('file:///cache/saved.jpg');
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, bytes: async () => new Uint8Array([1, 2, 3]) });
  await downloadConversationFile(destination, { downloadUrl: grant.uploadUrl, idToken: 'firebase-token', orgId: 'org', scopeType: 'team', scopeId: 'team', attachmentId: 'file-1' });
  expect(mockFetch).toHaveBeenCalledWith(grant.uploadUrl, expect.objectContaining({
    method: 'GET',
    headers: expect.objectContaining({ Authorization: 'Bearer firebase-token', 'X-Attachment-Id': 'file-1' }),
  }));
  expect(written[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
  mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
  await expect(downloadConversationFile(destination, { downloadUrl: grant.uploadUrl, idToken: 'firebase-token', orgId: 'org', scopeType: 'team', scopeId: 'team', attachmentId: 'file-1' })).rejects.toThrow('unavailable');
});
