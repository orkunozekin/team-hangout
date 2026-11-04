import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ConversationScreen from '../ConversationScreen';
import * as api from '../../firebase/conversations';
import * as attachments from '../../firebase/attachments';
import * as transport from '../../lib/attachmentTransport';

jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: jest.fn(() => ({ id: 'request-id' })) }));
jest.mock('firebase/functions', () => ({ httpsCallable: jest.fn() }));
jest.mock('../../firebase/config', () => ({ db: {}, functions: {} }));
jest.mock('../../firebase/commands', () => ({ runCommand: jest.fn() }));
jest.mock('../../firebase/conversations');
jest.mock('../../firebase/attachments', () => ({ createAttachmentUpload: jest.fn(), finalizeAttachment: jest.fn() }));
jest.mock('../../lib/attachmentTransport', () => ({ pickConversationAttachment: jest.fn(), uploadConversationFile: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
afterEach(cleanup);

const page = {
  conversationId: 'channel', mode: 'youth' as const, youthPosting: 'closed' as const, pinnedIds: [], nextCursor: null,
  items: [{ id: 'm1', sequence: 1, authorUid: 'staff', body: 'Practice is at the north field', tombstoned: false, pinned: true, createdAt: '2026-10-20T12:00:00.000Z' }],
};

test('shows the group channel and the closed youth-posting policy', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue(page);
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Practice is at the north field')).toBeTruthy();
  expect(screen.getByText('Pinned')).toBeTruthy();
  expect(screen.getByText(/Youth posting is closed/)).toBeTruthy();
  expect(screen.queryByText('Guardian phone is private')).toBeNull();
  expect(screen.queryByText('Choose a JPEG, PNG, or PDF')).toBeNull();
});

test('names an event channel without treating it as a team conversation', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, mode: 'youth' });
  await render(<ConversationScreen orgId="org" scopeType="event" scopeId="event" />);
  expect(await screen.findByText('Event conversation')).toBeTruthy();
  expect(screen.queryByText('Team conversation')).toBeNull();
});

test('loads older messages from the returned cursor without dropping the first page', async () => {
  const older = { id: 'm0', sequence: 0, authorUid: 'staff', body: 'Earlier plan', tombstoned: false, pinned: false, createdAt: '2026-10-19T12:00:00.000Z' };
  const first = { ...page, nextCursor: 'm0' };
  (api.listConversationMessages as jest.Mock)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ ...page, items: [older], nextCursor: null });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Practice is at the north field')).toBeTruthy();
  await fireEvent.press(screen.getByText('Load older messages'));
  expect(await screen.findByText('Earlier plan')).toBeTruthy();
  expect(screen.getByText('Practice is at the north field')).toBeTruthy();
  expect(api.listConversationMessages).toHaveBeenLastCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', cursor: 'm0' });
  expect(screen.queryByText('Load older messages')).toBeNull();
});

test('shows an unavailable conversation after access is removed', async () => {
  (api.listConversationMessages as jest.Mock).mockRejectedValue(new Error('denied'));
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('This conversation is unavailable.')).toBeTruthy();
});

test('searches the channel, edits the caller’s message, and records a reaction', async () => {
  const mine = { ...page.items[0], mine: true, revision: 2, editedAt: '2026-10-20T13:00:00.000Z', reactions: [{ emoji: '👍', count: 1, mine: false }] };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [mine] });
  (api.searchConversationMessages as jest.Mock).mockResolvedValue({ items: [{ ...mine, body: 'Practice moved to the south field' }], nextCursor: 'next', partial: true });
  (api.editConversationMessage as jest.Mock).mockResolvedValue({ id: 'm1', revision: 3 });
  (api.reactToConversationMessage as jest.Mock).mockResolvedValue({ active: true, count: 2 });
  const view = await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Edited')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('React with 👍'));
  await waitFor(() => expect(api.reactToConversationMessage).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm1', emoji: '👍', expectedRevision: 2 }));
  await fireEvent.press(screen.getByText('Edit message'));
  fireEvent.changeText(screen.getByLabelText('Replacement text'), 'Practice moved to the south field');
  await waitFor(() => expect(screen.getByLabelText('Replacement text').props.value).toBe('Practice moved to the south field'));
  await fireEvent.press(screen.getByText('Save edit'));
  await waitFor(() => expect(api.editConversationMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', text: 'Practice moved to the south field', expectedRevision: 2 })));
  fireEvent.changeText(screen.getByLabelText('Search words'), 'south');
  await waitFor(() => expect(screen.getByLabelText('Search words').props.value).toBe('south'));
  await fireEvent.press(screen.getByText('Search messages'));
  await waitFor(() => expect(api.searchConversationMessages).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'south' }));
  expect(await screen.findByText('Practice moved to the south field')).toBeTruthy();
  expect(screen.getByText('More matches may remain. Continue the search.')).toBeTruthy();
  view.unmount();
});

test('shows a removed message without its old text', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({
    ...page,
    items: [{ ...page.items[0], body: null, tombstoned: true, pinned: false }],
  });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Message removed by a moderator')).toBeTruthy();
  expect(screen.queryByText('Practice is at the north field')).toBeNull();
});

test('renders retained history from a deleted account as a non-editable tombstone identity', async () => {
  const deleted = { ...page.items[0], authorUid: null, authorLabel: 'Deleted user', mine: false };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [deleted] });
  (api.searchConversationMessages as jest.Mock).mockResolvedValue({ items: [deleted], nextCursor: null, partial: false });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Deleted user')).toBeTruthy();
  expect(screen.queryByText('Edit message')).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Search words'), 'practice');
  await waitFor(() => expect(screen.getByLabelText('Search words').props.value).toBe('practice'));
  await fireEvent.press(screen.getByText('Search messages'));
  await waitFor(() => expect(api.searchConversationMessages).toHaveBeenCalled());
  await waitFor(() => expect(screen.getAllByText('Deleted user')).toHaveLength(2));
});

test('drops search results when the channel changes', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue(page);
  (api.searchConversationMessages as jest.Mock).mockResolvedValue({
    items: [{ ...page.items[0], body: 'Practice moved to the south field' }], nextCursor: null, partial: false,
  });
  const view = await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Practice is at the north field')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search words'), 'south');
  await waitFor(() => expect(screen.getByLabelText('Search words').props.value).toBe('south'));
  await fireEvent.press(screen.getByText('Search messages'));
  expect(await screen.findByText('Practice moved to the south field')).toBeTruthy();
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [] });
  view.rerender(<ConversationScreen orgId="org" scopeType="team" scopeId="other-team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  expect(screen.queryByText('Practice moved to the south field')).toBeNull();
});

test('ignores a search that completes after the channel changes', async () => {
  let resolveSearch: (value: { items: Array<{ id: string; sequence: number; authorUid: string; body: string; tombstoned: boolean; pinned: boolean; createdAt: string }>; nextCursor: null; partial: false }) => void = () => {};
  (api.listConversationMessages as jest.Mock).mockResolvedValue(page);
  (api.searchConversationMessages as jest.Mock).mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));
  const view = await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Practice is at the north field')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search words'), 'south');
  await waitFor(() => expect(screen.getByLabelText('Search words').props.value).toBe('south'));
  fireEvent.press(screen.getByText('Search messages'));
  await waitFor(() => expect(api.searchConversationMessages).toHaveBeenCalled());
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [] });
  view.rerender(<ConversationScreen orgId="org" scopeType="team" scopeId="other-team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  resolveSearch({ items: [{ ...page.items[0], body: 'Practice moved to the south field' }], nextCursor: null, partial: false });
  await expect(screen.findByText('Practice moved to the south field', {}, { timeout: 400 })).rejects.toThrow();
  expect(screen.getByText('No messages yet.')).toBeTruthy();
});

test('uploads a picked file only when the attachment spike is enabled for a poster', async () => {
  const file = { uri: 'file:///cache/photo.jpg', size: 128 };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, attachments: 'enabled', canPost: true, youthPosting: 'open' });
  (transport.pickConversationAttachment as jest.Mock).mockResolvedValue({ file, name: 'photo.jpg', size: 128 });
  (attachments.createAttachmentUpload as jest.Mock).mockResolvedValue({ id: 'file-1', uploadUrl: 'https://example.test/upload', token: 'grant', expiresAt: '2099-01-01T00:00:00.000Z', maxBytes: 128, state: 'pending' });
  (transport.uploadConversationFile as jest.Mock).mockResolvedValue(undefined);
  (attachments.finalizeAttachment as jest.Mock).mockResolvedValue({ id: 'file-1', state: 'ready', detectedType: 'image/jpeg', byteLength: 128, sha256: 'abc', fileName: 'photo.jpg', scan: { scanner: 'fake', verdict: 'clean' }, rejectionCode: null });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.press(await screen.findByText('Choose a JPEG, PNG, or PDF'));
  expect(await screen.findByText('Ready · photo.jpg · image/jpeg · 128 bytes')).toBeTruthy();
  expect(attachments.createAttachmentUpload).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', fileName: 'photo.jpg', declaredBytes: 128 });
  expect(transport.uploadConversationFile).toHaveBeenCalledWith(file, expect.objectContaining({ token: 'grant' }));
  (transport.pickConversationAttachment as jest.Mock).mockRejectedValueOnce(new Error('This file is larger than 10 MB.'));
  await fireEvent.press(screen.getByText('Choose a JPEG, PNG, or PDF'));
  expect(await screen.findByText('This file is larger than 10 MB.')).toBeTruthy();
});

test('shows scanning then rejected, and sends ready attachment ids with the message', async () => {
  let resolveFinalize: (value: { id: string; state: string; rejectionCode?: string; detectedType?: string; byteLength?: number }) => void = () => {};
  const file = { uri: 'file:///cache/photo.jpg', size: 128 };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({
    ...page, attachments: 'enabled', canPost: true, youthPosting: 'open',
    items: [{ ...page.items[0], attachments: [{ id: 'file-1', fileName: 'photo.jpg', detectedType: 'image/jpeg', byteLength: 90 }] }],
  });
  (transport.pickConversationAttachment as jest.Mock).mockResolvedValue({ file, name: 'notes.pdf', size: 128 });
  (attachments.createAttachmentUpload as jest.Mock)
    .mockResolvedValueOnce({ id: 'file-2', uploadUrl: 'https://example.test/upload', token: 'grant', expiresAt: '2099-01-01T00:00:00.000Z', maxBytes: 128, state: 'pending' })
    .mockResolvedValueOnce({ id: 'file-3', uploadUrl: 'https://example.test/upload', token: 'grant-2', expiresAt: '2099-01-01T00:00:00.000Z', maxBytes: 128, state: 'pending' });
  (transport.uploadConversationFile as jest.Mock).mockResolvedValue(undefined);
  (attachments.finalizeAttachment as jest.Mock).mockImplementation(() => new Promise((resolve) => { resolveFinalize = resolve; }));
  (api.postConversationMessage as jest.Mock).mockResolvedValue({ id: 'm2', sequence: 2 });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('photo.jpg · image/jpeg · 90 bytes')).toBeTruthy();
  await fireEvent.press(screen.getByText('Choose a JPEG, PNG, or PDF'));
  expect(await screen.findByText('Scanning · notes.pdf')).toBeTruthy();
  resolveFinalize({ id: 'file-2', state: 'rejected', rejectionCode: 'ACTIVE_CONTENT' });
  expect(await screen.findByText('Rejected · notes.pdf · ACTIVE_CONTENT')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Message'), 'Practice photo is attached');
  await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe('Practice photo is attached'));
  await fireEvent.press(screen.getByLabelText('Send message'));
  await waitFor(() => expect(api.postConversationMessage).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'Practice photo is attached' }));
  (attachments.finalizeAttachment as jest.Mock).mockResolvedValue({ id: 'file-3', state: 'ready', detectedType: 'image/jpeg', byteLength: 90, rejectionCode: null });
  (transport.pickConversationAttachment as jest.Mock).mockResolvedValue({ file, name: 'photo.jpg', size: 128 });
  await fireEvent.press(screen.getByText('Choose a JPEG, PNG, or PDF'));
  expect(await screen.findByText('Ready · photo.jpg · image/jpeg · 90 bytes')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Message'), 'Second photo');
  await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe('Second photo'));
  await fireEvent.press(screen.getByLabelText('Send message'));
  await waitFor(() => expect(api.postConversationMessage).toHaveBeenLastCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', text: 'Second photo', attachmentIds: ['file-3'] }));
});

test('drops an in-flight attachment when the channel changes', async () => {
  let resolveFinalize: (value: { id: string; state: string; detectedType: string; byteLength: number; rejectionCode: null }) => void = () => {};
  const file = { uri: 'file:///cache/photo.jpg', size: 128 };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, attachments: 'enabled', canPost: true, youthPosting: 'open' });
  (transport.pickConversationAttachment as jest.Mock).mockResolvedValue({ file, name: 'photo.jpg', size: 128 });
  (attachments.createAttachmentUpload as jest.Mock).mockResolvedValue({ id: 'file-9', uploadUrl: 'https://example.test/upload', token: 'grant', expiresAt: '2099-01-01T00:00:00.000Z', maxBytes: 128, state: 'pending' });
  (transport.uploadConversationFile as jest.Mock).mockResolvedValue(undefined);
  (attachments.finalizeAttachment as jest.Mock).mockImplementation(() => new Promise((resolve) => { resolveFinalize = resolve; }));
  (api.postConversationMessage as jest.Mock).mockResolvedValue({ id: 'm9', sequence: 9 });
  const view = await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.press(await screen.findByText('Choose a JPEG, PNG, or PDF'));
  expect(await screen.findByText('Scanning · photo.jpg')).toBeTruthy();
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [], attachments: 'enabled', canPost: true, youthPosting: 'open' });
  view.rerender(<ConversationScreen orgId="org" scopeType="team" scopeId="other-team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  resolveFinalize({ id: 'file-9', state: 'ready', detectedType: 'image/jpeg', byteLength: 90, rejectionCode: null });
  fireEvent.changeText(screen.getByLabelText('Message'), 'Hello from the other channel');
  await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe('Hello from the other channel'));
  await fireEvent.press(screen.getByLabelText('Send message'));
  await waitFor(() => expect(api.postConversationMessage).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'other-team', text: 'Hello from the other channel' }));
  expect(screen.queryByText(/Ready · photo.jpg/)).toBeNull();
});

test('keeps the closed-policy banner when the channel has no messages yet', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [] });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  expect(screen.getByText(/Youth posting is closed/)).toBeTruthy();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
});

const parentMessage = { id: 'm2', sequence: 2, authorUid: 'parent', body: 'Unkind words', tombstoned: false, pinned: false, createdAt: '2026-10-21T12:00:00.000Z', mine: false };

test('reports another member’s message with a reason and note', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [parentMessage], canBlock: true });
  (api.reportConversationMessage as jest.Mock).mockResolvedValue({ id: 'r1', status: 'open' });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.press(await screen.findByText('Report message'));
  expect(screen.getByText('Send report')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Harassment or bullying'));
  await fireEvent.changeText(screen.getByLabelText('Report details (optional)'), ' Aimed at my child ');
  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('Reported. Organization moderators will review it.')).toBeTruthy();
  expect(api.reportConversationMessage).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm2', reason: 'harassment', note: 'Aimed at my child' });
  expect(screen.getByText('Unkind words')).toBeTruthy();
});

test('blocks an author only after confirmation and reloads the filtered page', async () => {
  (api.listConversationMessages as jest.Mock)
    .mockResolvedValueOnce({ ...page, items: [parentMessage], canBlock: true })
    .mockResolvedValueOnce({ ...page, items: [], canBlock: true });
  (api.blockConversationMember as jest.Mock).mockResolvedValue({ id: 'b1', blocked: true });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.press(await screen.findByLabelText('Block author'));
  expect(api.blockConversationMember).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Block member'));
  await waitFor(() => expect(screen.queryByText('Unkind words')).toBeNull());
  expect(api.blockConversationMember).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm2' });
});

test('hides block for staff views and safety actions on your own or removed messages', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({
    ...page,
    canBlock: false,
    items: [parentMessage, { ...parentMessage, id: 'm3', mine: true, body: 'Mine' }, { ...parentMessage, id: 'm4', tombstoned: true, body: null }],
  });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findAllByText('Report message')).toHaveLength(1);
  expect(screen.queryByLabelText('Block author')).toBeNull();
});

test('keeps reporting for a deleted author but offers no block', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, canBlock: true, items: [{ ...parentMessage, authorUid: null, authorLabel: 'Deleted user' }] });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('Report message')).toBeTruthy();
  expect(screen.queryByLabelText('Block author')).toBeNull();
});

test('an older page still loading when a block completes cannot re-add the blocked author', async () => {
  let finishOlder: (value: unknown) => void = () => {};
  (api.listConversationMessages as jest.Mock)
    .mockResolvedValueOnce({ ...page, items: [parentMessage], canBlock: true, nextCursor: 's1_m1' })
    .mockReturnValueOnce(new Promise(resolve => { finishOlder = resolve; }))
    .mockResolvedValueOnce({ ...page, items: [], canBlock: true, nextCursor: null });
  (api.blockConversationMember as jest.Mock).mockResolvedValue({ id: 'b1', blocked: true });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.press(await screen.findByText('Load older messages'));
  await fireEvent.press(screen.getByLabelText('Block author'));
  await fireEvent.press(screen.getByText('Block member'));
  await waitFor(() => expect(screen.queryByText('Unkind words')).toBeNull());
  await act(async () => {
    finishOlder({ ...page, items: [{ ...parentMessage, id: 'm-old', body: 'Older unkind words' }], canBlock: true, nextCursor: null });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(screen.queryByText('Older unkind words')).toBeNull();
});

test('blocking during a search clears the pending search so it can run again', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [parentMessage], canBlock: true });
  (api.searchConversationMessages as jest.Mock).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({ items: [], nextCursor: null, partial: false });
  (api.blockConversationMember as jest.Mock).mockResolvedValue({ id: 'b1', blocked: true });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.changeText(await screen.findByLabelText('Search words'), 'field');
  await fireEvent.press(screen.getByText('Search messages'));
  expect(await screen.findByText('Searching messages')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Block author'));
  await fireEvent.press(screen.getByText('Block member'));
  expect(await screen.findByText('Search messages')).toBeTruthy();
  await fireEvent.press(screen.getByText('Search messages'));
  expect(await screen.findByText('No matching messages.')).toBeTruthy();
});

test('search results outside the loaded pages can be reported and their author blocked', async () => {
  const found = { ...parentMessage, id: 'm-found', body: 'Hidden far back' };
  const orphan = { ...parentMessage, id: 'm-orphan', authorUid: null, authorLabel: 'Deleted user', body: 'Orphaned far back' };
  const own = { ...parentMessage, id: 'm-own', mine: true, body: 'My far back note' };
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [], canBlock: true });
  (api.searchConversationMessages as jest.Mock).mockResolvedValue({ items: [found, orphan, own], nextCursor: null, partial: false });
  (api.reportConversationMessage as jest.Mock).mockResolvedValue({ id: 'r1', status: 'open' });
  (api.blockConversationMember as jest.Mock).mockResolvedValue({ id: 'b1', blocked: true });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  await fireEvent.changeText(await screen.findByLabelText('Search words'), 'far');
  await fireEvent.press(screen.getByText('Search messages'));
  expect(await screen.findByText('Hidden far back')).toBeTruthy();
  expect(screen.getAllByText('Report message')).toHaveLength(2);
  expect(screen.getAllByLabelText('Block author')).toHaveLength(1);
  await fireEvent.press(screen.getAllByText('Report message')[0]);
  await fireEvent.press(screen.getByLabelText('Spam'));
  await fireEvent.press(screen.getByText('Send report'));
  expect(await screen.findByText('Reported. Organization moderators will review it.')).toBeTruthy();
  expect(api.reportConversationMessage).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm-found', reason: 'spam' });
  await fireEvent.press(screen.getByLabelText('Block author'));
  expect(api.blockConversationMember).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm-found' }));
  await fireEvent.press(screen.getByText('Block member'));
  await waitFor(() => expect(screen.queryByText('Hidden far back')).toBeNull());
  expect(api.blockConversationMember).toHaveBeenCalledWith({ orgId: 'org', scopeType: 'team', scopeId: 'team', messageId: 'm-found' });
});

test('staff and announcement search results offer report but never block', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, mode: 'adult', items: [], canBlock: false });
  (api.searchConversationMessages as jest.Mock).mockResolvedValue({ items: [{ ...parentMessage, id: 'm-ann', body: 'Season notice' }], nextCursor: null, partial: false });
  await render(<ConversationScreen orgId="org" scopeType="organization" scopeId="org" />);
  await fireEvent.changeText(await screen.findByLabelText('Search words'), 'season');
  await fireEvent.press(screen.getByText('Search messages'));
  expect(await screen.findByText('Season notice')).toBeTruthy();
  expect(screen.getByText('Report message')).toBeTruthy();
  expect(screen.queryByLabelText('Block author')).toBeNull();
});
