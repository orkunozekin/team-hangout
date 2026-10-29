import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventRides from '../EventRides';
import { confirmRideArrangement, getEventRides, getRideContacts, revokeRideConsent, rideRequestId, saveRideRequest } from '../../firebase/rides';
import type { EventRides as Data, OwnRide, RideArrangement, RideMatch } from '../../../shared/rides';
import { areaProblem, rideSeatsLabel } from '../../../shared/rides';

jest.mock('../../firebase/rides', () => ({
  getEventRides: jest.fn(), getRideContacts: jest.fn(), saveRideRequest: jest.fn(), confirmRideArrangement: jest.fn(), revokeRideConsent: jest.fn(), rideRequestId: jest.fn(),
}));
const read = getEventRides as jest.Mock;
const contacts = getRideContacts as jest.Mock;
const save = saveRideRequest as jest.Mock;
const confirm = confirmRideArrangement as jest.Mock;
const revoke = revokeRideConsent as jest.Mock;
let ids = 0;

const base = { orgId: 'o', eventId: 'e', teamId: 't', eventStatus: 'scheduled' };
const need: OwnRide = {
  rideId: 'need1', kind: 'need', direction: 'toEvent', area: 'Elm school', seats: 1, seatsOpen: null, discoverable: true, status: 'open', revision: 1,
  participants: [{ participantId: 'p1', displayName: 'Synthetic Avery' }], canEdit: true, updatedByYou: true, hasArrangement: false,
};
const match: RideMatch = { rideId: 'offer1', kind: 'offer', direction: 'toEvent', area: 'North park', seats: 2, revision: 1 };
const arrangement = (patch: Partial<RideArrangement> = {}): RideArrangement => ({
  arrangementId: 'a1', role: 'rider', state: 'confirmed', direction: 'toEvent', seats: 1, revision: 2, counterpartAlias: 'Coach K',
  yourAlias: 'Sam R.', awaitingYou: false, participants: ['Synthetic Avery'], ...patch,
});
const enabled = (patch: Partial<Extract<Data, { enabled: true }>> = {}): Data => ({
  ...base, enabled: true, policyVersion: 'synthetic-1', consentVersion: 'c1', canOffer: false,
  children: [{ participantId: 'p1', displayName: 'Synthetic Avery' }], mine: [need], matches: [match], arrangements: [], coordination: null, ...patch,
});
const open = async () => {
  await render(<EventRides orgId="o" eventId="e" teamId="t" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Rides' }));
};

beforeEach(() => {
  jest.resetAllMocks();
  ids = 0;
  (rideRequestId as jest.Mock).mockImplementation(() => `r${++ids}`);
});

test('explains that rides stay off until the organization records a policy', async () => {
  read.mockResolvedValue({ ...base, enabled: false });
  await open();
  expect(await screen.findByText(/Ride coordination is off/)).toBeTruthy();
  expect(screen.queryByText('Find a match')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Request a ride' })).toBeNull();
});

test('opt-in discovery shows only area and seats and asks for explicit consent before sending', async () => {
  read.mockResolvedValue(enabled());
  confirm.mockResolvedValue({ requestId: 'r1', revision: 1, state: 'pending', arrangementId: 'a1' });
  await open();
  expect(await screen.findByText('Seats offered, to the event, near North park')).toBeTruthy();
  expect(screen.getByText('2 seats open')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Ask for seats near North park' }));
  await fireEvent.changeText(screen.getByLabelText('Name shown to the other adult'), 'Sam R.');
  await fireEvent.changeText(screen.getByLabelText('How to reach you'), 'synthetic@example.test');
  await fireEvent.press(screen.getByRole('button', { name: 'Send and share my details after confirmation' }));
  expect(await screen.findByText('Confirm that these details can be shared with the other adult in this ride.')).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Share these details with the other adult in this ride'));
  await fireEvent.press(screen.getByRole('button', { name: 'Send and share my details after confirmation' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('o', 'e', 't', { offerId: 'offer1', needId: 'need1' },
    { displayAlias: 'Sam R.', contact: 'synthetic@example.test', pickupNote: null }, 'r1'));
  expect(await screen.findByText('Sent. Details are shared after the other adult confirms.')).toBeTruthy();
});

test('a capacity conflict refreshes the list and keeps the same request only for uncertain retries', async () => {
  read.mockResolvedValue(enabled({ arrangements: [arrangement({ role: 'driver', state: 'pending', awaitingYou: true, participants: [] })], canOffer: true }));
  confirm.mockRejectedValueOnce({ code: 'functions/unavailable' })
    .mockRejectedValueOnce({ code: 'functions/failed-precondition', details: { domainCode: 'RIDE_SEATS_FULL' } });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Review and confirm this ride' }));
  await fireEvent.changeText(screen.getByLabelText('Name shown to the other adult'), 'Coach K');
  await fireEvent.changeText(screen.getByLabelText('How to reach you'), 'synthetic-coach@example.test');
  await fireEvent.press(screen.getByText('Share these details with the other adult in this ride'));
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm ride and share details' }));
  expect(await screen.findByText(/may not have been saved/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm ride and share details' }));
  expect(await screen.findByText('Those seats were just taken. The list has been refreshed.')).toBeTruthy();
  expect(confirm.mock.calls.map((call) => call[5])).toEqual(['r1', 'r1']);
  expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
});

test('confirmed rides reveal contacts on demand and hide them after cancellation', async () => {
  read.mockResolvedValue(enabled({ arrangements: [arrangement()] }));
  contacts.mockResolvedValue({ arrangementId: 'a1', counterpart: { role: 'driver', alias: 'Coach K', contact: 'synthetic-coach@example.test', pickupNote: 'Synthetic north gate' } });
  await open();
  expect(await screen.findByText('Confirmed')).toBeTruthy();
  expect(screen.queryByText(/synthetic-coach/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Show contact details' }));
  expect(await screen.findByText('Coach K: synthetic-coach@example.test')).toBeTruthy();
  expect(screen.getByText('Synthetic north gate')).toBeTruthy();
  read.mockResolvedValue(enabled({ arrangements: [arrangement({ state: 'cancelled' })] }));
  revoke.mockResolvedValue({ requestId: 'r1', revision: 3, state: 'cancelled', arrangementId: 'a1' });
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel ride and stop sharing' }));
  expect(await screen.findByText('Ride cancelled. Your details are no longer shared.')).toBeTruthy();
  expect(screen.queryByText(/synthetic-coach/)).toBeNull();
  expect(screen.getByText(/cannot be recalled/)).toBeTruthy();
  expect(revoke).toHaveBeenCalledWith('o', 'e', 't', 'a1', 'r1');
});

test('an unavailable contact shows a clear state and a late contact response is ignored after the ride ends', async () => {
  read.mockResolvedValue(enabled({ arrangements: [arrangement()] }));
  contacts.mockRejectedValueOnce({ code: 'functions/failed-precondition', details: { domainCode: 'RIDE_CONTACT_UNAVAILABLE' } });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Show contact details' }));
  expect(await screen.findByText(/Contact details are unavailable/)).toBeTruthy();
  let resolve: (value: unknown) => void = () => {};
  contacts.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await fireEvent.press(screen.getByRole('button', { name: 'Show contact details' }));
  read.mockResolvedValue(enabled({ arrangements: [arrangement({ state: 'cancelled' })] }));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh rides' }));
  expect(await screen.findByText('Cancelled')).toBeTruthy();
  resolve({ arrangementId: 'a1', counterpart: { role: 'driver', alias: 'Coach K', contact: 'synthetic-late@example.test', pickupNote: null } });
  await waitFor(() => expect(contacts).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/synthetic-late/)).toBeNull();
});

test('a cancelled event marks arrangements cancelled and hides new matches', async () => {
  read.mockResolvedValue(enabled({ eventStatus: 'cancelled', matches: [], arrangements: [arrangement({ state: 'cancelled' })] }));
  await open();
  expect(await screen.findByText('This event was cancelled. Ride arrangements are cancelled too.')).toBeTruthy();
  expect(screen.queryByText('Find a match')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show contact details' })).toBeNull();
});

test('ride requests need a coarse area and a linked child, and stale edits explain the conflict', async () => {
  read.mockResolvedValue(enabled({ mine: [{ ...need, updatedByYou: false, revision: 3 }] }));
  save.mockResolvedValue({ requestId: 'r1', revision: 1, state: 'open', rideId: 'need2' });
  await open();
  expect(await screen.findByText('Last changed by another guardian (version 3).')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Meeting area'), '12 Main Street');
  await fireEvent.press(screen.getByRole('button', { name: 'Request a ride' }));
  expect(await screen.findByText(/Do not include an address/)).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Meeting area'), 'Library');
  await fireEvent.press(screen.getByRole('button', { name: 'Request a ride' }));
  expect(await screen.findByText('Choose at least one child.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Ride for Synthetic Avery'));
  await fireEvent.press(screen.getByRole('button', { name: 'Request a ride' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 0,
    { kind: 'need', direction: 'toEvent', area: 'Library', discoverable: true, participantIds: ['p1'] }, 'r1'));
  save.mockRejectedValueOnce({ code: 'functions/failed-precondition', details: { domainCode: 'STALE_REVISION' } });
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel request to the event near Elm school' }));
  expect(await screen.findByText('This ride changed. The list has been refreshed.')).toBeTruthy();
});

test('shared helpers mirror backend area and seat rules', () => {
  expect(areaProblem('North park')).toBeNull();
  expect(areaProblem('Gate 3')).toBeNull();
  expect(areaProblem('60614')).toMatch(/Do not include/);
  expect(areaProblem('meet@example.test')).toMatch(/Do not include/);
  expect(areaProblem(' ')).toMatch(/Enter a meeting area/);
  expect(rideSeatsLabel('offer', 1)).toBe('1 seat open');
  expect(rideSeatsLabel('need', 2)).toBe('Needs 2 seats');
});

test('a guardian with two matching requests chooses which child the seats are for before consenting', async () => {
  const second: OwnRide = { ...need, rideId: 'need2', area: 'Library', participants: [{ participantId: 'p2', displayName: 'Synthetic Blake' }] };
  read.mockResolvedValue(enabled({ mine: [need, second], children: [...need.participants, ...second.participants] }));
  confirm.mockResolvedValue({ requestId: 'r1', revision: 1, state: 'pending', arrangementId: 'a1' });
  await open();
  expect(await screen.findByText('For Synthetic Avery from Elm school')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Use Synthetic Blake from Library' }));
  expect(screen.getByText('For Synthetic Blake from Library')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Ask for seats near North park' }));
  await fireEvent.changeText(screen.getByLabelText('Name shown to the other adult'), 'Sam R.');
  await fireEvent.changeText(screen.getByLabelText('How to reach you'), 'synthetic@example.test');
  await fireEvent.press(screen.getByText('Share these details with the other adult in this ride'));
  await fireEvent.press(screen.getByRole('button', { name: 'Send and share my details after confirmation' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('o', 'e', 't', { offerId: 'offer1', needId: 'need2' },
    { displayAlias: 'Sam R.', contact: 'synthetic@example.test', pickupNote: null }, 'r1'));
});

test('an existing ride can be edited with its current revision', async () => {
  const offer: OwnRide = { ...need, rideId: 'offer9', kind: 'offer', seats: 3, seatsOpen: 2, participants: [], area: 'North park', revision: 4, hasArrangement: true };
  read.mockResolvedValue(enabled({ mine: [offer], canOffer: true, matches: [] }));
  save.mockResolvedValue({ requestId: 'r1', revision: 5, state: 'open', rideId: 'offer9' });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Edit offer to the event near North park' }));
  await fireEvent.changeText(screen.getByLabelText('Edit offer to the event near North park: seats offered'), '2');
  await fireEvent.press(screen.getAllByText('Let other team families find this by area and seats (no names are shown)')[0]);
  await fireEvent.press(screen.getByRole('button', { name: 'Save ride changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 4,
    { rideId: 'offer9', kind: 'offer', direction: 'toEvent', area: 'North park', discoverable: false, seats: 2 }, 'r1'));
  expect(await screen.findByText('Ride updated.')).toBeTruthy();
});
