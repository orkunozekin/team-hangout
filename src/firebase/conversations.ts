import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { runCommand } from './commands';
import { db, functions } from './config';
import type { ConversationBlock, ConversationPage, ConversationReport, ConversationReportReason, ConversationScopeType, ConversationSearchPage, StaffNote } from '../../shared/conversations';

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
export async function reportConversationMessage(input: ChannelQuery & { messageId: string; reason: ConversationReportReason; note?: string }) {
  return runCommand('reportConversationMessage', input, requestId());
}
export async function blockConversationMember(input: ChannelQuery & { messageId: string }) {
  return runCommand('blockConversationMember', input, requestId());
}
export async function unblockConversationMember(input: { orgId: string; blockId: string }) {
  return runCommand('unblockConversationMember', input, requestId());
}
export async function listConversationBlocks(orgId: string): Promise<{ items: ConversationBlock[] }> {
  return (await httpsCallable<{ orgId: string }, { items: ConversationBlock[] }>(functions, 'listConversationBlocks')({ orgId })).data;
}
export async function listConversationReports(input: { orgId: string; cursor?: string }): Promise<{ items: ConversationReport[]; nextCursor: string | null }> {
  return (await httpsCallable<{ orgId: string; cursor?: string; pageSize: number }, { items: ConversationReport[]; nextCursor: string | null }>(functions, 'listConversationReports')({ ...input, pageSize: 25 })).data;
}
export async function moderateConversationMessage(input: ChannelQuery & { messageId: string; reason: string }) {
  return runCommand('moderateConversationMessage', input, requestId());
}
export async function resolveConversationReport(input: { orgId: string; reportId: string; resolution: 'dismissed' | 'removed' }) {
  return runCommand<{ id: string; status: string; remaining: boolean }>('resolveConversationReport', input, requestId());
}
/** Organizations where the caller is current staff, so moderators without household channels reach the report queue. */
const MAX_ORGANIZATION_PAGES = 20;
export async function listModeratedOrganizations(): Promise<{ orgId: string; organizationName?: string }[]> {
  const call = httpsCallable<{ pageSize: number; cursor?: string }, { items: { id: string; name?: string; roles: string[] }[]; nextCursor?: string | null }>(functions, 'listMyOrganizations');
  const found: { orgId: string; organizationName?: string }[] = [];
  let cursor: string | undefined;
  // Discovery pages count stale and household links too, so a page can be empty while later pages still hold staff organizations.
  for (let page = 0; page < MAX_ORGANIZATION_PAGES; page++) {
    const result = (await call({ pageSize: 50, ...(cursor ? { cursor } : {}) })).data;
    for (const item of result.items) {
      if (item.roles.includes('orgAdmin') || item.roles.includes('programStaff')) found.push({ orgId: item.id, ...(item.name ? { organizationName: item.name } : {}) });
    }
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return found;
}
