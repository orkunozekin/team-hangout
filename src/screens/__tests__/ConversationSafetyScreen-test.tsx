import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ConversationSafetyScreen from '../ConversationSafetyScreen';
import * as api from '../../firebase/conversations';

jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: jest.fn(() => ({ id: 'request-id' })) }));
jest.mock('firebase/functions', () => ({ httpsCallable: jest.fn() }));
jest.mock('../../firebase/config', () => ({ db: {}, functions: {} }));
jest.mock('../../firebase/commands', () => ({ runCommand: jest.fn() }));
jest.mock('../../firebase/conversations');
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
afterEach(() => { cleanup(); jest.resetAllMocks(); });

const report = {
  id: 'r1', scopeType: 'team' as const, scopeId: 'team', messageId: 'm1', authorUid: 'parent', reporterUid: 'guardian',
  reason: 'harassment' as const, note: 'Aimed at my child', reportedBody: 'Unkind words', messageRemoved: false, editedSinceReport: false,
  createdAt: '2026-10-21T12:00:00.000Z',
};
const block = { id: 'b1', scopeType: 'team' as const, scopeId: 'team', createdAt: '2026-10-21T12:00:00.000Z' };

test('households see only their blocked members and can unblock', async () => {
  (api.listConversationReports as jest.Mock).mockRejectedValue(Object.assign(new Error('denied'), { code: 'functions/permission-denied' }));
  (api.listConversationBlocks as jest.Mock).mockResolvedValueOnce({ items: [block] }).mockResolvedValueOnce({ items: [] });
  (api.unblockConversationMember as jest.Mock).mockResolvedValue({ id: 'b1', blocked: false });
  await render(<ConversationSafetyScreen orgId="org" organizationName="Synthetic League" />);
  expect(await screen.findByText('Member blocked from a team conversation')).toBeTruthy();
  expect(screen.queryByText('Reported messages')).toBeNull();
  await fireEvent.press(screen.getByText('Unblock member'));
  expect(await screen.findByText('You have not blocked anyone.')).toBeTruthy();
  expect(api.unblockConversationMember).toHaveBeenCalledWith({ orgId: 'org', blockId: 'b1' });
});

test('moderators see the reporter and remove a message after confirming, continuing until related reports close', async () => {
  (api.listConversationBlocks as jest.Mock).mockResolvedValue({ items: [] });
  (api.listConversationReports as jest.Mock).mockResolvedValueOnce({ items: [report], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null });
  (api.resolveConversationReport as jest.Mock)
    .mockResolvedValueOnce({ id: 'r1', status: 'removed', remaining: true })
    .mockResolvedValueOnce({ id: 'r1', status: 'removed', remaining: false });
  await render(<ConversationSafetyScreen orgId="org" />);
  expect(await screen.findByText('Unkind words')).toBeTruthy();
  expect(screen.getByText(/Reported by guardian/)).toBeTruthy();
  expect(screen.getByText('Reporter note: Aimed at my child')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Remove message'));
  expect(api.resolveConversationReport).not.toHaveBeenCalled();
  await fireEvent.press(screen.getAllByText('Remove message')[1]);
  expect(await screen.findByText('No open reports.')).toBeTruthy();
  expect(api.resolveConversationReport).toHaveBeenCalledTimes(2);
  expect(api.resolveConversationReport).toHaveBeenCalledWith({ orgId: 'org', reportId: 'r1', resolution: 'removed' });
});

test('moderators dismiss a report and see an error when it fails', async () => {
  (api.listConversationBlocks as jest.Mock).mockResolvedValue({ items: [] });
  (api.listConversationReports as jest.Mock).mockResolvedValue({ items: [report], nextCursor: null });
  (api.resolveConversationReport as jest.Mock).mockRejectedValue(new Error('denied'));
  await render(<ConversationSafetyScreen orgId="org" />);
  await fireEvent.press(await screen.findByLabelText('Dismiss report'));
  await fireEvent.press(screen.getAllByText('Dismiss report')[1]);
  expect(await screen.findByText('The report was not dismissed. Try again.')).toBeTruthy();
  await waitFor(() => expect(api.resolveConversationReport).toHaveBeenCalledWith({ orgId: 'org', reportId: 'r1', resolution: 'dismissed' }));
});

test('a failed queue load shows a retry instead of hiding the queue', async () => {
  (api.listConversationBlocks as jest.Mock).mockResolvedValue({ items: [] });
  (api.listConversationReports as jest.Mock)
    .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'functions/unavailable' }))
    .mockResolvedValueOnce({ items: [report], nextCursor: null });
  await render(<ConversationSafetyScreen orgId="org" />);
  expect(await screen.findByText('Reported messages could not be loaded.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Retry loading reports'));
  expect(await screen.findByText('Unkind words')).toBeTruthy();
  expect(screen.queryByText('Reported messages could not be loaded.')).toBeNull();
});

test('a permission denial hides the queue without an error', async () => {
  (api.listConversationBlocks as jest.Mock).mockResolvedValue({ items: [] });
  (api.listConversationReports as jest.Mock).mockRejectedValue(Object.assign(new Error('denied'), { code: 'functions/permission-denied' }));
  await render(<ConversationSafetyScreen orgId="org" />);
  expect(await screen.findByText('You have not blocked anyone.')).toBeTruthy();
  expect(screen.queryByText('Reported messages')).toBeNull();
  expect(screen.queryByText('Reported messages could not be loaded.')).toBeNull();
});
