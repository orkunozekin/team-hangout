const mockCall = jest.fn();
let mockId = 0;
jest.mock('firebase/functions', () => ({ httpsCallable: () => mockCall }));
jest.mock('firebase/firestore', () => ({ collection: jest.fn(), doc: () => ({ id: `request-${++mockId}` }) }));
import { runCommand } from '../commands';
beforeEach(() => jest.clearAllMocks());
it('reuses the request ID after uncertain transport failures', async () => {
  mockCall.mockRejectedValueOnce({ code: 'functions/unavailable' }).mockResolvedValueOnce({ data: { ok: true } });
  await expect(runCommand('createTeam', { name: 'Tigers' })).resolves.toEqual({ ok: true });
  expect(mockCall.mock.calls[0][0]).toEqual(mockCall.mock.calls[1][0]);
  expect(mockCall.mock.calls[0][0].requestId).toMatch(/^request-/);
});
it('surfaces conflicts without retry and explains missing backend deployment', async () => {
  mockCall.mockRejectedValueOnce(new Error('Reload the event'));
  await expect(runCommand('updateEvent', {})).rejects.toThrow('Reload');
  expect(mockCall).toHaveBeenCalledTimes(1);
  mockCall.mockRejectedValueOnce({ code: 'functions/not-found', message: 'not-found' });
  await expect(runCommand('createTeam', {})).rejects.toThrow('Update Team Hangout');
});
it('bounds transport retries and handles deadline exceeded', async () => {
  mockCall.mockRejectedValue({ code: 'functions/deadline-exceeded' });
  await expect(runCommand('createTeam', {})).rejects.toEqual({ code: 'functions/deadline-exceeded' });
  expect(mockCall).toHaveBeenCalledTimes(2);
});

it('preserves domain not-found messages such as expired invitation codes', async () => {
  const error = { code: 'functions/not-found', details: { domainCode: 'INVITE_UNAVAILABLE' }, message: 'Invite code is invalid or no longer active.' };
  mockCall.mockRejectedValueOnce(error);
  await expect(runCommand('joinTeamWithInvite', {})).rejects.toEqual(error);
});

it('reuses uncertain request IDs when the user retries, then releases them on success', async () => {
  mockCall.mockRejectedValue({ code: 'functions/unavailable' });
  await expect(runCommand('createTeam', { name: 'Retry team' })).rejects.toEqual({ code: 'functions/unavailable' });
  const originalId = mockCall.mock.calls[0][0].requestId;
  mockCall.mockResolvedValue({ data: { ok: true } });
  await runCommand('createTeam', { name: 'Retry team' });
  expect(mockCall.mock.calls[2][0].requestId).toBe(originalId);
  await runCommand('createTeam', { name: 'Retry team' });
  expect(mockCall.mock.calls[3][0].requestId).not.toBe(originalId);
});
