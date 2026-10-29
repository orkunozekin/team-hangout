import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventVolunteers from '../EventVolunteers';
import { claimVolunteerSlot, getEventVolunteers, releaseVolunteerSlot, saveVolunteerSlot, volunteerRequestId } from '../../firebase/volunteers';
import type { EventVolunteers as Data, VolunteerSlot } from '../../../shared/volunteers';
import { aliasProblem, deadlineInput, parseDeadline, VOLUNTEER_KINDS } from '../../../shared/volunteers';

jest.mock('../../firebase/volunteers', () => ({
  getEventVolunteers: jest.fn(), claimVolunteerSlot: jest.fn(), releaseVolunteerSlot: jest.fn(), saveVolunteerSlot: jest.fn(), volunteerRequestId: jest.fn(),
}));
const read = getEventVolunteers as jest.Mock;
const claim = claimVolunteerSlot as jest.Mock;
const release = releaseVolunteerSlot as jest.Mock;
const save = saveVolunteerSlot as jest.Mock;
let ids = 0;

const slot = (patch: Partial<VolunteerSlot> = {}): VolunteerSlot => ({
  slotId: 's1', kind: 'snacks', title: 'Halftime oranges', capacity: 2, openCount: 2, state: 'open', claimDeadline: null, revision: 1,
  assignees: [], ownClaim: null, ...patch,
});
const data = (slots: VolunteerSlot[], patch: Partial<Data> = {}): Data => ({
  orgId: 'o', eventId: 'e', teamId: 't', canManage: false, canClaim: true, eventStatus: 'scheduled', slots, ...patch,
});
const open = async () => {
  await render(<EventVolunteers orgId="o" eventId="e" teamId="t" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Volunteers' }));
};
const fill = async (alias: string, consent = true) => {
  await fireEvent.press(await screen.findByRole('button', { name: 'Volunteer for Halftime oranges' }));
  await fireEvent.changeText(screen.getByLabelText('Name shown to the team'), alias);
  if (consent) await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm volunteer spot' }));
};

beforeEach(() => {
  jest.resetAllMocks();
  ids = 0;
  (volunteerRequestId as jest.Mock).mockImplementation(() => `r${++ids}`);
});

test('open and full slots show counts and aliases only, and an adult claims with a consented alias', async () => {
  read.mockResolvedValueOnce(data([slot({ assignees: [{ alias: 'Jo K.' }], openCount: 1 }), slot({ slotId: 's2', title: 'Field setup', kind: 'setup', state: 'full', openCount: 0, capacity: 1, assignees: [{ alias: 'Pat' }] })]))
    .mockResolvedValueOnce(data([slot({ assignees: [{ alias: 'Jo K.' }, { alias: 'Sam R.' }], openCount: 0, state: 'full', ownClaim: { alias: 'Sam R.', status: 'active' } })]));
  claim.mockResolvedValue({ state: 'claimed' });
  await open();
  expect(await screen.findByText('1 of 2 spots open')).toBeTruthy();
  expect(screen.getByText('Full (1 of 1 taken)')).toBeTruthy();
  expect(screen.getByText('Volunteers: Jo K.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Volunteer for Field setup' })).toBeNull();
  await fill('  Sam   R. ');
  await waitFor(() => expect(claim).toHaveBeenCalledWith('o', 'e', 't', 's1', 'Sam R.', 'r1'));
  expect(await screen.findByText('You are signed up as Sam R.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Release my spot for Halftime oranges' })).toBeTruthy();
});

test('a lost last-seat race explains the loss and refreshes; consent and contact checks stop sending', async () => {
  read.mockResolvedValueOnce(data([slot({ openCount: 1 })])).mockResolvedValueOnce(data([slot({ openCount: 0, state: 'full', assignees: [{ alias: 'Jo' }] })]));
  claim.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'functions/failed-precondition', details: { domainCode: 'VOLUNTEER_SLOT_FULL' } }));
  await open();
  await fill('Sam', false);
  expect(screen.getByText('Confirm that this name can appear on the volunteer list.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Name shown to the team'), 'sam@example.test');
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm volunteer spot' }));
  expect(screen.getByText('Use a display name or initials only. Do not include email, phone or links.')).toBeTruthy();
  expect(claim).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Name shown to the team'), 'Sam');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm volunteer spot' }));
  expect(await screen.findByText('Someone else took the last spot. The list has been refreshed.')).toBeTruthy();
  expect(await screen.findByText('Full (2 of 2 taken)')).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
});

test('an uncertain claim retries with the same request ID', async () => {
  read.mockResolvedValue(data([slot()]));
  claim.mockRejectedValueOnce(Object.assign(new Error('lost'), { code: 'functions/unavailable' })).mockResolvedValueOnce({ state: 'claimed' });
  await open();
  await fill('Sam');
  expect(await screen.findByText('Could not sign you up. The change may not have been saved. Try again to confirm.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm volunteer spot' }));
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
  expect(claim.mock.calls[0][5]).toBe(claim.mock.calls[1][5]);
});

test('cancelled assignments are explained and offer no release or claim', async () => {
  read.mockResolvedValue(data([slot({ state: 'cancelled', ownClaim: { alias: 'Sam R.', status: 'cancelled' }, assignees: [{ alias: 'Sam R.' }] })], { eventStatus: 'cancelled' }));
  await open();
  expect(await screen.findByText('This event was cancelled. Volunteer assignments are cancelled too.')).toBeTruthy();
  expect(screen.getByText('Your assignment as Sam R. was cancelled. No action is needed.')).toBeTruthy();
  expect(screen.getByText('Cancelled')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Release my spot/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Volunteer for/ })).toBeNull();
});

test('coaches add slots, remove a volunteer by key and cancel a slot; households cannot', async () => {
  read.mockResolvedValue(data([slot({ assignees: [{ alias: 'Jo', assigneeKey: 'k1' }], openCount: 1 })], { canManage: true }));
  save.mockResolvedValue({ state: 'open' });
  release.mockResolvedValue({ state: 'released' });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Remove Jo' }));
  await waitFor(() => expect(release).toHaveBeenCalledWith('o', 'e', 't', 's1', 'r1', 'k1'));
  await fireEvent.press(screen.getByRole('button', { name: 'Slot kind Scorekeeping' }));
  await fireEvent.changeText(screen.getByLabelText('Slot title'), 'Scoreboard');
  await fireEvent.changeText(screen.getByLabelText('Number of volunteers needed'), '0');
  await fireEvent.press(screen.getByRole('button', { name: 'Add slot' }));
  expect(screen.getByText('Capacity must be 1 through 50.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Number of volunteers needed'), '2');
  await fireEvent.press(screen.getByRole('button', { name: 'Add slot' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 0, { kind: 'scorekeeping', title: 'Scoreboard', capacity: 2, claimDeadline: null }, 'r2'));
  await fireEvent.press(await screen.findByRole('button', { name: 'Cancel slot Halftime oranges' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 1, { slotId: 's1', action: 'cancel' }, 'r3'));
});

test('coaches edit an existing slot with its current revision and a local deadline', async () => {
  read.mockResolvedValue(data([slot({ revision: 4, assignees: [{ alias: 'Jo', assigneeKey: 'k1' }], openCount: 1 })], { canManage: true }));
  save.mockResolvedValue({ state: 'open' });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Edit slot Halftime oranges' }));
  expect(screen.getByLabelText('Edit Halftime oranges: Slot title').props.value).toBe('Halftime oranges');
  await fireEvent.changeText(screen.getByLabelText('Edit Halftime oranges: Number of volunteers needed'), '3');
  await fireEvent.changeText(screen.getByLabelText('Edit Halftime oranges: Sign-up deadline'), 'tomorrow');
  await fireEvent.press(screen.getByRole('button', { name: 'Save slot changes' }));
  expect(screen.getByText('Enter the deadline as YYYY-MM-DD HH:MM, or leave it blank.')).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Edit Halftime oranges: Sign-up deadline'), '2027-03-19 18:30');
  await fireEvent.press(screen.getByRole('button', { name: 'Save slot changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 4,
    { slotId: 's1', kind: 'snacks', title: 'Halftime oranges', capacity: 3, claimDeadline: new Date(2027, 2, 19, 18, 30).toISOString() }, 'r1'));
  expect(await screen.findByRole('button', { name: 'Edit slot Halftime oranges' })).toBeTruthy();
});

test('deadline text round-trips in local time and rejects impossible dates', () => {
  const iso = parseDeadline('2027-03-19 18:30')!;
  expect(deadlineInput(iso)).toBe('2027-03-19 18:30');
  expect(parseDeadline('')).toBeNull();
  expect(parseDeadline('2027-02-30 10:00')).toBeUndefined();
  expect(parseDeadline('19/03/2027')).toBeUndefined();
  expect(deadlineInput(null)).toBe('');
});

test('households without manage rights see no staff controls, and load failures offer retry', async () => {
  read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(data([], { canClaim: false }));
  await open();
  expect(await screen.findByText('Volunteer slots could not be loaded.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading volunteer slots' }));
  expect(await screen.findByText('No volunteer slots for this event.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add slot' })).toBeNull();
});

test('alias rules and slot kinds stay aligned with the backend', () => {
  expect(aliasProblem('Sam R.')).toBeNull();
  expect(aliasProblem('Call 555-123-4567')).not.toBeNull();
  expect(aliasProblem('x'.repeat(41))).not.toBeNull();
  const backend = readFileSync(join(__dirname, '../../../functions/src/volunteers/slots.ts'), 'utf8');
  expect(backend).toContain(`VOLUNTEER_KINDS = [${VOLUNTEER_KINDS.map((kind) => `'${kind}'`).join(', ')}] as const`);
});
