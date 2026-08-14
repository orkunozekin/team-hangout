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
  mapEventDoc,
  softDeleteEvent,
  updateEvent,
} from '../events';

describe('firebase/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('creates, updates, and soft-deletes events', async () => {
    mockSetDoc.mockResolvedValue(undefined);
    mockUpdateDoc.mockResolvedValue(undefined);
    mockDoc.mockReturnValue({ id: 'event-1', path: 'events/event-1' });

    const created = await createEvent({
      teamId: 't1',
      type: 'practice',
      title: '  Drill  ',
      date: new Date('2026-08-20T00:00:00.000Z'),
      time: '18:00',
      createdBy: 'u1',
      notes: '  note ',
    });
    expect(created.id).toBe('event-1');
    expect(created.title).toBe('Drill');

    const createdBare = await createEvent({
      teamId: 't1',
      type: 'match',
      title: 'Game',
      date: new Date('2026-08-21T00:00:00.000Z'),
      time: '19:00',
      createdBy: 'u1',
    });
    expect(createdBare.notes).toBeNull();
    expect(createdBare.location).toBeNull();

    await updateEvent('event-1', {
      title: ' Updated ',
      type: 'match',
      date: new Date('2026-08-21T00:00:00.000Z'),
      time: '19:00',
      location: { name: 'Gym' },
      notes: 'x',
    });
    await updateEvent('event-1', {
      notes: '   ',
      location: null,
    });
    expect(mockUpdateDoc).toHaveBeenCalled();

    await softDeleteEvent('event-1');
    expect(mockUpdateDoc).toHaveBeenCalledTimes(3);
  });
});
