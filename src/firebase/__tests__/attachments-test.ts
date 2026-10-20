jest.mock('firebase/functions', () => ({ httpsCallable: () => jest.fn() }));
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: () => ({ id: 'request-attachment' }) }));
jest.mock('../config', () => ({ db: {}, functions: {} }));
jest.mock('../commands', () => ({ runCommand: jest.fn(async (name: string, input: object, requestId: string) => ({ name, input, requestId })) }));

import { createAttachmentUpload, finalizeAttachment } from '../attachments';
import { runCommand } from '../commands';

test('attachment commands use a fresh request id and do not send a client MIME type', async () => {
  await createAttachmentUpload({ orgId: 'org', scopeType: 'team', scopeId: 'team', fileName: 'photo.jpg', declaredBytes: 128 });
  await finalizeAttachment({ orgId: 'org', scopeType: 'team', scopeId: 'team', attachmentId: 'file-1' });
  expect(runCommand).toHaveBeenNthCalledWith(1, 'createAttachmentUpload', { orgId: 'org', scopeType: 'team', scopeId: 'team', fileName: 'photo.jpg', declaredBytes: 128 }, 'request-attachment');
  expect(runCommand).toHaveBeenNthCalledWith(2, 'finalizeAttachment', { orgId: 'org', scopeType: 'team', scopeId: 'team', attachmentId: 'file-1' }, 'request-attachment');
  expect(JSON.stringify((runCommand as jest.Mock).mock.calls)).not.toContain('mime');
});
