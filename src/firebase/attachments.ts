import { collection, doc } from 'firebase/firestore';
import type { AttachmentFinalize, AttachmentUpload } from '../../shared/attachments';
import type { ConversationScopeType } from '../../shared/conversations';
import { runCommand } from './commands';
import { db } from './config';

const requestId = () => doc(collection(db, 'requestIds')).id;
type Scope = { orgId: string; scopeType: ConversationScopeType; scopeId: string };

export function createAttachmentUpload(input: Scope & { fileName: string; declaredBytes: number }) {
  return runCommand<AttachmentUpload>('createAttachmentUpload', input, requestId());
}

export function finalizeAttachment(input: Scope & { attachmentId: string }) {
  return runCommand<AttachmentFinalize>('finalizeAttachment', input, requestId());
}
