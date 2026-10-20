import React from 'react';
import { render, screen } from '@testing-library/react-native';
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
