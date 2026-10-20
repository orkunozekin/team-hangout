import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ConversationScreen from '../ConversationScreen';
import * as api from '../../firebase/conversations';

jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: jest.fn(() => ({ id: 'request-id' })) }));
jest.mock('firebase/functions', () => ({ httpsCallable: jest.fn() }));
jest.mock('../../firebase/config', () => ({ db: {}, functions: {} }));
jest.mock('../../firebase/commands', () => ({ runCommand: jest.fn() }));
jest.mock('../../firebase/conversations');
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

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

test('keeps the closed-policy banner when the channel has no messages yet', async () => {
  (api.listConversationMessages as jest.Mock).mockResolvedValue({ ...page, items: [] });
  await render(<ConversationScreen orgId="org" scopeType="team" scopeId="team" />);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
  expect(screen.getByText(/Youth posting is closed/)).toBeTruthy();
  expect(screen.getByLabelText('Send message')).toBeTruthy();
});
