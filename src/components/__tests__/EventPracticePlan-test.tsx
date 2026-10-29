import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EventPracticePlan from '../EventPracticePlan';
import { getEventPracticePlan, listTeamPracticeResources, practiceRequestId, savePracticePlan } from '../../firebase/practice';
import type { CoachPracticePlan, CoachResource, HouseholdPracticePlan, PlanItem } from '../../../shared/practiceResources';
import { parseAge, plannedProblem } from '../../../shared/practiceResources';

jest.mock('../../firebase/practice', () => ({
  getEventPracticePlan: jest.fn(), listTeamPracticeResources: jest.fn(), savePracticePlan: jest.fn(), practiceRequestId: jest.fn(),
}));
const read = getEventPracticePlan as jest.Mock;
const list = listTeamPracticeResources as jest.Mock;
const save = savePracticePlan as jest.Mock;
let ids = 0;

const content = { objectives: ['Synthetic objective'], ageMin: 6, ageMax: 8, durationMinutes: 15, equipment: ['Cones'], instructions: 'Synthetic steps.', safetyNotes: 'Synthetic spacing.' };
const resource = (patch: Partial<CoachResource> = {}): CoachResource => ({ resourceId: 'r1', version: 1, sportCode: 'soccer', title: 'Passing gates', attribution: null, ...content, ...patch });
const item = (patch: Partial<PlanItem> = {}): PlanItem => ({ resourceId: 'r1', version: 1, title: 'Passing gates', attribution: null, plannedMinutes: 20, notice: null, ...content, ...patch });
const coach = (patch: Partial<CoachPracticePlan> = {}): CoachPracticePlan => ({
  enabled: true, canManage: true, orgId: 'o', programId: 'p', eventId: 'e', teamId: 't', eventType: 'practice', revision: 0, items: [],
  householdNote: '', privateNote: '', publication: { state: 'private', sourceRevision: null, publishedAt: null }, ...patch,
});
const open = async () => {
  await render(<EventPracticePlan orgId="o" eventId="e" teamId="t" />);
  await fireEvent.press(screen.getByRole('button', { name: 'Practice plan' }));
};

beforeEach(() => {
  jest.resetAllMocks();
  ids = 0;
  (practiceRequestId as jest.Mock).mockImplementation(() => `q${++ids}`);
});

test('a coach filters by age, sees the empty state, adds a resource and saves a private plan', async () => {
  read.mockResolvedValueOnce(coach()).mockResolvedValueOnce(coach({ revision: 1, items: [item({ plannedMinutes: 15 })], privateNote: 'Private' }));
  list.mockResolvedValueOnce({ programId: 'p', items: [], nextCursor: null })
    .mockResolvedValueOnce({ programId: 'p', items: [resource()], nextCursor: 'r1' })
    .mockResolvedValueOnce({ programId: 'p', items: [resource({ resourceId: 'r2', title: 'Rondo' })], nextCursor: null });
  save.mockResolvedValue({ revision: 1, state: 'private' });
  await open();
  expect(await screen.findByText('No activities yet. Add reviewed resources below.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Player age filter'), '99');
  await fireEvent.press(screen.getByRole('button', { name: 'Show resources' }));
  expect(screen.getByText('Enter an age from 4 to 19, or leave it blank.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Player age filter'), '15');
  await fireEvent.press(screen.getByRole('button', { name: 'Show resources' }));
  expect(await screen.findByText('No reviewed resources for age 15 yet.')).toBeTruthy();
  expect(list).toHaveBeenLastCalledWith('o', 't', 15, null);
  await fireEvent.changeText(screen.getByLabelText('Player age filter'), '7');
  await fireEvent.press(screen.getByRole('button', { name: 'Show resources' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Show more resources' }));
  expect(list).toHaveBeenLastCalledWith('o', 't', 7, 'r1');
  expect(await screen.findByText('Rondo')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Add Passing gates' }));
  expect(screen.getByRole('button', { name: 'Passing gates is in the plan' })).toBeTruthy();
  // The coach sees the activity's steps, equipment and safety guidance in the plan.
  expect(screen.getByText('Synthetic steps.')).toBeTruthy();
  expect(screen.getByText('Equipment: Cones')).toBeTruthy();
  expect(screen.getByText('Safety: Synthetic spacing.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Private coach note'), ' Private ');
  await fireEvent.press(screen.getByRole('button', { name: 'Save practice plan' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('o', 'e', 't', 0,
    { action: 'save', items: [{ resourceId: 'r1', version: 1, plannedMinutes: 15 }], householdNote: '', privateNote: 'Private' }, 'q1'));
  expect(await screen.findByText('Practice plan saved.')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Share with households' })).toBeTruthy();
});

test('withdrawn activities are flagged and a rejected save keeps the coach edits without a reload', async () => {
  read.mockResolvedValueOnce(coach({ revision: 3, items: [item({ notice: 'withdrawn' }), item({ resourceId: 'r2', title: 'Cool down', notice: 'superseded' })] }));
  save.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'functions/failed-precondition', details: { domainCode: 'PRACTICE_RESOURCE_UNAVAILABLE' } }))
    .mockResolvedValueOnce({ revision: 4, state: 'private' });
  await open();
  expect(await screen.findByText('This resource was withdrawn. Remove it before saving or publishing.')).toBeTruthy();
  expect(screen.getByText('A newer reviewed version exists. This plan keeps the version it was built with.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Minutes for Cool down'), '9');
  await fireEvent.press(screen.getByRole('button', { name: 'Save practice plan' }));
  expect(await screen.findByText(/withdrawn, expired or replaced/)).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Minutes for Cool down').props.value).toBe('9');
  await fireEvent.press(screen.getByRole('button', { name: 'Remove Passing gates' }));
  read.mockResolvedValueOnce(coach({ revision: 4, items: [item({ resourceId: 'r2', title: 'Cool down', plannedMinutes: 9 })] }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save practice plan' }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith('o', 'e', 't', 3,
    expect.objectContaining({ items: [{ resourceId: 'r2', version: 1, plannedMinutes: 9 }] }), 'q2'));
  expect(await screen.findByText('Practice plan saved.')).toBeTruthy();
});

test('an older resource search cannot replace a newer one', async () => {
  read.mockResolvedValueOnce(coach());
  let slow: (value: unknown) => void = () => {};
  list.mockImplementationOnce(() => new Promise((resolve) => { slow = resolve; }))
    .mockResolvedValueOnce({ programId: 'p', items: [resource({ title: 'Newest' })], nextCursor: null });
  await open();
  await screen.findByText('No activities yet. Add reviewed resources below.');
  await fireEvent.changeText(screen.getByLabelText('Player age filter'), '6');
  await fireEvent.press(screen.getByRole('button', { name: 'Show resources' }));
  await fireEvent.changeText(screen.getByLabelText('Player age filter'), '7');
  await fireEvent.press(screen.getByRole('button', { name: 'Show resources' }));
  expect(await screen.findByText('Newest')).toBeTruthy();
  await act(async () => slow({ programId: 'p', items: [resource({ title: 'Stale' })], nextCursor: null }));
  expect(screen.queryByText('Stale')).toBeNull();
});

test('households see only the shared copy, and withdrawn activities lose their instructions', async () => {
  const view: HouseholdPracticePlan = {
    enabled: true, canManage: false, eventId: 'e', teamId: 't', eventType: 'practice', state: 'published', householdNote: 'Bring water.',
    items: [
      { title: 'Passing gates', plannedMinutes: 20, notice: null, objectives: ['o'], equipment: ['Cones'], instructions: 'Synthetic steps.', safetyNotes: 'Synthetic spacing.', attribution: null },
      { title: 'Old drill', plannedMinutes: 10, notice: 'withdrawn' },
    ],
  };
  read.mockResolvedValueOnce(view);
  await open();
  expect(await screen.findByText('Bring water.')).toBeTruthy();
  expect(screen.getByText('Synthetic steps.')).toBeTruthy();
  expect(screen.getByText('This activity is no longer available. Your coach will update the plan.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save practice plan' })).toBeNull();
  expect(screen.queryByLabelText('Private coach note')).toBeNull();
});

test('an unpublished plan explains itself', async () => {
  read.mockResolvedValueOnce({ enabled: true, canManage: false, eventId: 'e', teamId: 't', eventType: 'practice', state: 'unpublished' });
  await open();
  expect(await screen.findByText('No practice plan has been shared for this practice.')).toBeTruthy();
});

test('a disabled organization shows no plan controls', async () => {
  read.mockResolvedValueOnce({ enabled: false, canManage: false, eventId: 'e', teamId: 't' });
  await open();
  expect(await screen.findByText('Practice resources are not enabled for this organization.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save practice plan' })).toBeNull();
});

test('a failed load offers a retry', async () => {
  read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ enabled: true, canManage: false, eventId: 'e', teamId: 't', eventType: 'practice', state: 'unpublished' });
  await open();
  await fireEvent.press(await screen.findByRole('button', { name: 'Retry loading the practice plan' }));
  expect(await screen.findByText('No practice plan has been shared for this practice.')).toBeTruthy();
});

test('pure helpers mirror backend limits', () => {
  expect(parseAge('')).toBeNull();
  expect(parseAge(' 7 ')).toBe(7);
  expect(parseAge('3')).toBeUndefined();
  expect(parseAge('7.5')).toBeUndefined();
  expect(plannedProblem([{ plannedMinutes: 0 }])).toMatch(/1 to 180/);
  expect(plannedProblem(Array.from({ length: 4 }, () => ({ plannedMinutes: 180 })))).toMatch(/600 minutes/);
  expect(plannedProblem(Array.from({ length: 21 }, () => ({ plannedMinutes: 1 })))).toMatch(/at most 20/);
  expect(plannedProblem([{ plannedMinutes: 30 }])).toBeNull();
});
