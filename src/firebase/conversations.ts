import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { runCommand } from './commands';
import { db, functions } from './config';
import type { ConversationPage, ConversationScopeType, StaffNote } from '../../shared/conversations';

export type ChannelQuery = { orgId: string; scopeType: ConversationScopeType; scopeId: string; cursor?: string };
const requestId = () => doc(collection(db, 'requestIds')).id;

export async function listConversationMessages(input: ChannelQuery): Promise<ConversationPage> {
  return (await httpsCallable<ChannelQuery & { pageSize: number }, ConversationPage>(functions, 'listConversationMessages')({ ...input, pageSize: 25 })).data;
}
export async function postConversationMessage(input: ChannelQuery & { text: string }) {
  return runCommand('postConversationMessage', input, requestId());
}
export async function listStaffNotes(input: ChannelQuery): Promise<{ items: StaffNote[]; nextCursor: string | null }> {
  return (await httpsCallable<ChannelQuery & { pageSize: number }, { items: StaffNote[]; nextCursor: string | null }>(functions, 'listStaffNotes')({ ...input, pageSize: 25 })).data;
}
