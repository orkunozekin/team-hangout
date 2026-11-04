import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { runCommand } from './commands';
import { db, functions } from './config';
import type { ConversationPage, ConversationScopeType, ConversationSearchPage, StaffNote } from '../../shared/conversations';

export type ChannelQuery = { orgId: string; scopeType: ConversationScopeType; scopeId: string; cursor?: string };
const requestId = () => doc(collection(db, 'requestIds')).id;

export async function listConversationMessages(input: ChannelQuery): Promise<ConversationPage> {
  return (await httpsCallable<ChannelQuery & { pageSize: number }, ConversationPage>(functions, 'listConversationMessages')({ ...input, pageSize: 25 })).data;
}
export async function postConversationMessage(input: ChannelQuery & { text: string; attachmentIds?: string[] }) {
  return runCommand('postConversationMessage', input, requestId());
}
export async function editConversationMessage(input: ChannelQuery & { messageId: string; text: string; expectedRevision: number }) {
  return runCommand('editConversationMessage', input, requestId());
}
export async function reactToConversationMessage(input: ChannelQuery & { messageId: string; emoji: string; expectedRevision: number }) {
  return runCommand('reactToConversationMessage', input, requestId());
}
export async function searchConversationMessages(input: ChannelQuery & { text: string; from?: string; to?: string }): Promise<ConversationSearchPage> {
  return (await httpsCallable<ChannelQuery & { text: string; from?: string; to?: string }, ConversationSearchPage>(functions, 'searchConversationMessages')(input)).data;
}
export async function listStaffNotes(input: ChannelQuery): Promise<{ items: StaffNote[]; nextCursor: string | null }> {
  return (await httpsCallable<ChannelQuery & { pageSize: number }, { items: StaffNote[]; nextCursor: string | null }>(functions, 'listStaffNotes')({ ...input, pageSize: 25 })).data;
}
