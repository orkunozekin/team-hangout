import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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

test('keeps the closed-policy banner when the channel has no messages yet', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [] });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  expect(screen.getByText(/Youth posting is closed/)).toBeTruthy();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
});
