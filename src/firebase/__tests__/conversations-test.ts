const mockCall = jest.fn();
jest.mock('firebase/functions', () => ({ httpsCallable: () => mockCall }));
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: () => ({ id: 'request-conversation' }) }));
jest.mock('../config', () => ({ db: {}, functions: {} }));
jest.mock('../commands', () => ({ runCommand: jest.fn(async (name, input, requestId) => ({ name, input, requestId })) }));
import { blockConversationMember, editConversationMessage, listConversationBlocks, listConversationMessages, listConversationReports, listModeratedOrganizations, moderateConversationMessage, reportConversationMessage, resolveConversationReport, unblockConversationMember, listStaffNotes, postConversationMessage, reactToConversationMessage, searchConversationMessages } from '../conversations';
import { runCommand } from '../commands';

beforeEach(() => jest.clearAllMocks());

test('loads one sequence page and searches without downloading history', async () => {
  mockCall.mockResolvedValueOnce({ data: { items: [], nextCursor: null } }).mockResolvedValueOnce({ data: { items: [], nextCursor: null, partial: false } });
  await listConversationMessages({ orgId: 'org', scopeType: 'team', scopeId: 'team', cursor: 's2_message' });
  await searchConversationMessages({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'south', cursor: 'cursor' });
  expect(mockCall.mock.calls[0][0]).toEqual({ orgId: 'org', scopeType: 'team', scopeId: 'team', cursor: 's2_message', pageSize: 25 });
  expect(mockCall.mock.calls[1][0]).toEqual({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'south', cursor: 'cursor' });
});

test('edits and reactions use a fresh request id', async () => {
  await postConversationMessage({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'Hello' });
  mockCall.mockResolvedValueOnce({ data: { items: [], nextCursor: null } });
  await listStaffNotes({ orgId: 'org', scopeType: 'team', scopeId: 'team' });
  await editConversationMessage({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm1', text: 'Moved', expectedRevision: 1 });
  await reactToConversationMessage({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm1', emoji: '👍', expectedRevision: 1 });
  expect(runCommand).toHaveBeenNthCalledWith(1, 'postConversationMessage', expect.objectContaining({ text: 'Hello' }), 'request-conversation');
  expect(runCommand).toHaveBeenNthCalledWith(2, 'editConversationMessage', expect.objectContaining({ text: 'Moved', expectedRevision: 1 }), 'request-conversation');
  expect(runCommand).toHaveBeenNthCalledWith(3, 'reactToConversationMessage', expect.objectContaining({ emoji: '👍' }), 'request-conversation');
  expect(mockCall.mock.calls.at(-1)?.[0]).toEqual({ orgId: 'org', scopeType: 'team', scopeId: 'team', pageSize: 25 });
});

test('safety commands send one request id each and reads page the queue', async () => {
  const channel = { orgId: 'org', scopeType: 'team' as const, scopeId: 'team' };
  await reportConversationMessage({ ...channel, messageId: 'm1', reason: 'spam' });
  await blockConversationMember({ ...channel, messageId: 'm1' });
  await unblockConversationMember({ orgId: 'org', blockId: 'b1' });
  await moderateConversationMessage({ ...channel, messageId: 'm1', reason: 'Report: Spam' });
  await resolveConversationReport({ orgId: 'org', reportId: 'r1', resolution: 'removed' });
  expect((runCommand as jest.Mock).mock.calls.map(call => call[0])).toEqual([
    'reportConversationMessage', 'blockConversationMember', 'unblockConversationMember', 'moderateConversationMessage', 'resolveConversationReport',
  ]);
  mockCall
    .mockResolvedValueOnce({ data: { items: [] } })
    .mockResolvedValueOnce({ data: { items: [], nextCursor: null } })
    .mockResolvedValueOnce({ data: { items: [
      { id: 'staff-org', name: 'Staff League', roles: ['programStaff'] },
      { id: 'admin-org', roles: ['orgAdmin'] },
      { id: 'home-org', name: 'Home', roles: ['guardian'] },
    ] } });
  await listConversationBlocks('org');
  await listConversationReports({ orgId: 'org', cursor: 'r0' });
  expect(await listModeratedOrganizations()).toEqual([{ orgId: 'staff-org', organizationName: 'Staff League' }, { orgId: 'admin-org' }]);
  expect(mockCall.mock.calls.map(call => call[0])).toEqual([{ orgId: 'org' }, { orgId: 'org', cursor: 'r0', pageSize: 25 }, { pageSize: 50 }]);
});

test('moderated organization discovery follows cursors past pages with no staff organizations', async () => {
  mockCall
    .mockResolvedValueOnce({ data: { items: [], nextCursor: 'link-50' } })
    .mockResolvedValueOnce({ data: { items: [{ id: 'home', roles: ['guardian'] }], nextCursor: 'link-100' } })
    .mockResolvedValueOnce({ data: { items: [{ id: 'late-org', name: 'Late League', roles: ['orgAdmin'] }], nextCursor: null } });
  expect(await listModeratedOrganizations()).toEqual([{ orgId: 'late-org', organizationName: 'Late League' }]);
  expect(mockCall.mock.calls.map(call => call[0])).toEqual([{ pageSize: 50 }, { pageSize: 50, cursor: 'link-50' }, { pageSize: 50, cursor: 'link-100' }]);
});
