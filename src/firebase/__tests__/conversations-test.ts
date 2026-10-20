const mockCall = jest.fn();
jest.mock('firebase/functions', () => ({ httpsCallable: () => mockCall }));
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: () => ({ id: 'request-conversation' }) }));
jest.mock('../config', () => ({ db: {}, functions: {} }));
jest.mock('../commands', () => ({ runCommand: jest.fn(async (name, input, requestId) => ({ name, input, requestId })) }));
import { editConversationMessage, listConversationMessages, listStaffNotes, postConversationMessage, reactToConversationMessage, searchConversationMessages } from '../conversations';
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
