import { decodeOperationalEvent } from '../../../shared/operations';
const mockRead = jest.fn();
jest.mock('firebase/functions', () => ({ httpsCallable: () => mockRead }));
const mockGetTeam = jest.fn();
jest.mock('../teams', () => ({ getTeam: (...args: unknown[]) => mockGetTeam(...args) }));
const mockRunCommand = jest.fn();
jest.mock('../commands', () => ({ runCommand: (...args: unknown[]) => mockRunCommand(...args) }));
const mockGetDoc = jest.fn();
const mockGetDocs = jest.fn();
const mockSetDoc = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDoc = jest.fn((...args: unknown[]) => ({
  id: args[2] ?? 'event-1',
  path: args.join('/'),
}));
const mockCollection = jest.fn(() => ({ id: 'events' }));
const mockQuery = jest.fn((...args: unknown[]) => args);
const mockWhere = jest.fn((...args: unknown[]) => args);

jest.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => (mockCollection as Function)(...args),
  doc: (...args: unknown[]) => (mockDoc as Function)(...args),
  getDoc: (...args: unknown[]) => (mockGetDoc as Function)(...args),
  getDocs: (...args: unknown[]) => (mockGetDocs as Function)(...args),
  query: (...args: unknown[]) => (mockQuery as Function)(...args),
  setDoc: (...args: unknown[]) => (mockSetDoc as Function)(...args),
  updateDoc: (...args: unknown[]) => (mockUpdateDoc as Function)(...args),
  where: (...args: unknown[]) => (mockWhere as Function)(...args),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  Timestamp: {
    fromDate: (d: Date) => ({ __date: d }),
  },
}));

import {
  createEvent,
  getEvent,
  listTeamEvents,
  listTeamEventPage,
  mapEventDoc,
  softDeleteEvent,
  updateEvent,
  mutateEventSchedule,
  createCanonicalEvent,
  listEventTeamChoices,
} from '../events';

describe('firebase/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockRejectedValue({ code: 'functions/permission-denied' });
    mockGetTeam.mockResolvedValue({ id: 't1' });
  });

  it('maps event documents with date variants', () => {
    const event = mapEventDoc('e1', {
      teamId: 't1',
      type: 'match',
      title: 'Game',
      date: new Date('2026-08-20'),
      time: '19:00',
      location: { name: 'Field', address: '1 Main' },
      notes: 'Bring ball',
      createdBy: 'u1',
      createdAt: { toDate: () => new Date('2026-01-01') },
      updatedAt: '2026-01-02',
      deletedAt: null,
    });
    expect(event.type).toBe('match');
    expect(event.location?.name).toBe('Field');

    const practice = mapEventDoc('e2', {
      teamId: 't1',
      type: 'practice',
      title: 'P',
      date: 1700000000000,
      time: undefined,
      location: { address: 'only' },
      notes: null,
      createdBy: 'u1',
      createdAt: null,
      updatedAt: undefined,
      deletedAt: { toDate: () => new Date('2026-03-01') },
    });
    expect(practice.type).toBe('practice');
    expect(practice.location).toBeNull();
    expect(practice.time).toBe('00:00');
    expect(practice.deletedAt).toBeInstanceOf(Date);
  });

  it('returns null for missing or deleted events and loads active ones', async () => {
    mockGetDoc.mockResolvedValueOnce({ exists: () => false });
    await expect(getEvent('e1')).resolves.toBeNull();

    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        teamId: 't1',
        type: 'practice',
        title: 'X',
        date: new Date(),
        time: '10:00',
        deletedAt: new Date(),
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    await expect(getEvent('e1')).resolves.toBeNull();

    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        teamId: 't1',
        type: 'match',
        title: 'Live',
        date: new Date('2026-08-20'),
        time: '12:00',
        deletedAt: null,
        location: null,
        notes: null,
        createdBy: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const live = await getEvent('e1');
    expect(live?.title).toBe('Live');
  });

  it('lists team events', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 'e1',
          data: () => ({
            teamId: 't1',
            type: 'practice',
            title: 'P',
            date: new Date('2026-08-20'),
            time: '18:00',
            location: null,
            notes: null,
            createdBy: 'u1',
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        },
      ],
    });
    const events = await listTeamEvents('t1');
    expect(events).toHaveLength(1);
    expect(mockWhere).toHaveBeenCalledWith('teamId', '==', 't1');
  });

  it('sends only editable fields and the loaded revision to commands', async () => {
    mockRunCommand.mockResolvedValueOnce({ id: 'event-1', title: 'Drill', revision: 1, createdBy: 'actor' });
    const date = new Date('2026-08-20T00:00:00.000Z');
    const created = await createEvent({ teamId: 't1', type: 'practice', title: ' Drill ', date, time: '18:00', createdBy: 'forged' });
    expect(created.createdBy).toBe('actor');
    expect(created.revision).toBe(1);
    expect(mockRunCommand).toHaveBeenLastCalledWith('createEvent', { teamId: 't1', event: { title: 'Drill', type: 'practice', date: date.toISOString(), time: '18:00' } });
    await updateEvent('event-1', { title: ' Updated ', location: { name: 'Gym', address: undefined }, notes: null }, 1);
    expect(mockRunCommand).toHaveBeenLastCalledWith('updateEvent', { eventId: 'event-1', expectedRevision: 1, patch: { title: 'Updated', location: { name: 'Gym' }, notes: null } });
    await updateEvent('event-1', { location: null }, 2);
    await softDeleteEvent('event-1', 3);
    expect(mockRunCommand).toHaveBeenLastCalledWith('softDeleteEvent', { eventId: 'event-1', expectedRevision: 3 });
    expect(mockSetDoc).not.toHaveBeenCalled();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });
});

describe('legacy event compatibility contract', () => {
  it.each([
    ['Date', new Date('2026-10-11T00:00:00.000Z')],
    ['callable ISO', '2026-10-11T00:00:00.000Z'],
    ['Firestore Timestamp', { toDate: () => new Date('2026-10-11T00:00:00.000Z') }],
    ['epoch milliseconds', Date.parse('2026-10-11T00:00:00.000Z')],
  ])('preserves split date/time from %s without timezone or duration inference', (_label, date) => {
    const event = mapEventDoc('legacy-a', { teamId: 'team-a', type: 'match', title: 'Legacy match', date,
      time: '18:30', createdAt: date, updatedAt: date, deletedAt: null });
    expect(event.date.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(event.time).toBe('18:30'); expect(event.revision).toBe(0);
    expect(event).not.toHaveProperty('startsAt'); expect(event).not.toHaveProperty('endsAt');
    expect(event).not.toHaveProperty('status'); expect(event.deletedAt).toBeNull();
  });
  it('preserves revisioned migrated records and soft deletion independently of lifecycle', () => {
    const deletedAt = new Date('2026-10-12T00:00:00.000Z');
    const event = mapEventDoc('legacy-b', { revision: 4, deletedAt, status: 'cancelled', date: deletedAt, time: '10:00' });
    expect(event.revision).toBe(4); expect(event.deletedAt).toBe(deletedAt);
    expect(event).not.toHaveProperty('status');
  });
});

test('canonical adapter renders the event timezone, both team labels and lifecycle without guessing legacy times', () => {
  const event = mapEventDoc('shared-match', { schemaVersion: 2, revision: 1, orgId: 'org', programId: 'program', seasonId: 'season', divisionId: 'division', teamId: 'a', teamIds: ['a'], createdBy: 'actor', updatedBy: 'actor', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', title: 'Match', type: 'match', publicationState: 'published', publicationOperationId: null, deletedAt: null, startsAt: '2026-10-20T23:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z', timeZone: 'America/Chicago', status: 'postponed', scheduleVersion: 2, teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  expect(event.time).toBe('18:00'); expect(event.date.toISOString().slice(0, 10)).toBe('2026-10-20');
  expect(event.status).toBe('postponed'); expect(event.teams).toHaveLength(2);
});

describe('canonical callable readers and writers', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const event = { id: 'shared', schemaVersion: 2, revision: 1, orgId: 'org', programId: 'program', seasonId: 'season', divisionId: 'division', teamId: 'a', teamIds: ['a'], createdBy: 'actor', updatedBy: 'actor', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', title: 'Match', type: 'match', publicationState: 'published', publicationOperationId: null, deletedAt: null, startsAt: '2026-10-20T23:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z', timeZone: 'America/Chicago', status: 'scheduled', teams: [{ id: 'a', name: 'A' }], canManage: true };
  it('opens a canonical event and does not use legacy Firestore reads', async () => {
    mockRead.mockResolvedValue({ data: event });
    expect((await getEvent('shared'))?.time).toBe('18:00');
    expect(mockGetDoc).not.toHaveBeenCalled();
    mockRead.mockRejectedValue(new Error('Network unavailable'));
    await expect(getEvent('shared')).rejects.toThrow('Network unavailable');
  });
  it('paginates canonical team events and choices', async () => {
    mockGetTeam.mockResolvedValue({ schemaVersion: 2 });
    mockRead.mockResolvedValueOnce({ data: { items: [event], nextCursor: 'shared' } }).mockResolvedValueOnce({ data: { items: [{ ...event, id: 'second' }], nextCursor: null } });
    expect((await listTeamEventPage('a')).items.map(event => event.id)).toEqual(['shared']);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect((await listTeamEventPage('a', 'shared')).items.map(event => event.id)).toEqual(['second']);
    expect(mockRead).toHaveBeenLastCalledWith({ teamId: 'a', cursor: 'shared', pageSize: 50, view: 'upcoming' });
    mockRead.mockResolvedValueOnce({ data: { items: [{ id: 'a', name: 'A' }], nextCursor: 'a' } }).mockResolvedValueOnce({ data: { items: [{ id: 'b', name: 'B' }], nextCursor: null } });
    expect((await listEventTeamChoices('a')).items).toHaveLength(1);
    expect((await listEventTeamChoices('a', 'a')).items).toHaveLength(1);
  });
  it('decodes family projections without audit identities while storage readers remain strict', async () => {
    const { createdBy, updatedBy, ...publicEvent } = event;
    expect(() => decodeOperationalEvent('shared', publicEvent, publicEvent, { a: publicEvent })).toThrow('Invalid createdBy');
    mockRead.mockResolvedValue({ data: publicEvent });
    expect(await getEvent('shared')).toEqual(expect.objectContaining({ title: 'Match', notes: null, createdBy: '', startsAt: event.startsAt }));
  });
  it('sends revisioned lifecycle commands and canonical creation', async () => {
    await mutateEventSchedule('shared', 3, 'postpone', {}, 'Rain');
    expect(mockRunCommand).toHaveBeenLastCalledWith('mutateEventSchedule', { eventId: 'shared', expectedRevision: 3, action: 'postpone', patch: {}, reason: 'Rain' });
    await createCanonicalEvent('a', { teamIds: ['a', 'b'], title: 'Shared match' });
    expect(mockRunCommand).toHaveBeenLastCalledWith('createEvent', { teamId: 'a', event: { teamIds: ['a', 'b'], title: 'Shared match' } });
  });
});


test('resolved canonical pages use one live callable without repeating team discovery', async () => {
  jest.clearAllMocks();
  mockRead.mockResolvedValueOnce({ data: { items: [], nextCursor: 'next', canManage: true } })
    .mockResolvedValueOnce({ data: { items: [], nextCursor: null, canManage: false } });
  expect((await listTeamEventPage('a', null, 'upcoming', 2)).canManage).toBe(true);
  expect((await listTeamEventPage('a', 'next', 'upcoming', 2)).canManage).toBe(false);
  expect(mockGetTeam).not.toHaveBeenCalled();
  expect(mockRead).toHaveBeenCalledTimes(2);
  expect(mockGetDocs).not.toHaveBeenCalled();
});
