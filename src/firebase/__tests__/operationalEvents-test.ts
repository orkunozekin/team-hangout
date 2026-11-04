import { mapOperationalEventDoc } from '../operationalEvents';
const parentsA = { orgId: 'org-a', programId: 'program-a', seasonId: 'season-a', divisionId: 'division-a' };
const stamp = { seconds: 1791586800, nanoseconds: 123000000 };
const eventV2 = { ...parentsA, schemaVersion: 2, revision: 1, title: 'Practice', type: 'practice',
  teamId: 'team-a', teamIds: ['team-a'], startsAt: stamp, endsAt: { ...stamp, seconds: stamp.seconds + 3600 },
  timeZone: 'America/Chicago', status: 'scheduled', publicationState: 'published', publicationOperationId: null,
  createdBy: 'actor', updatedBy: 'actor', createdAt: stamp, updatedAt: stamp, deletedAt: null };

describe('canonical operational event adapter', () => {
  it('maps timestamps and preserves lifecycle and publication separately from soft deletion', () => {
    const event = mapOperationalEventDoc('event-a', { ...eventV2, status: 'completed', completedAt: stamp, deletedAt: stamp }, parentsA, { 'team-a': parentsA });
    expect(event.startsAt).toBeInstanceOf(Date);
    expect(event.endsAt.getTime() - event.startsAt.getTime()).toBe(3600000);
    expect(event.createdAt).toBeInstanceOf(Date); expect(event.updatedAt).toBeInstanceOf(Date);
    expect(event.completedAt?.toISOString()).toBe(event.deletedAt?.toISOString());
    expect(event.status).toBe('completed'); expect(event.publicationState).toBe('published');
    expect(event.publicationOperationId).toBeNull();
  });
  it('retains missing operational metadata as explicit null compatibility values', () => {
    const event = mapOperationalEventDoc('event-a', eventV2, parentsA, { 'team-a': parentsA });
    expect(event.completedAt).toBeNull(); expect(event.deletedAt).toBeNull();
    expect(event.resourceId).toBeNull(); expect(event.homeTeamId).toBeNull();
    expect(event.scheduleVersion).toBe(1);
  });
  it('fails explicitly on legacy records rather than inventing canonical time or ownership', () => {
    expect(() => mapOperationalEventDoc('legacy', { date: stamp, time: '18:00' }, parentsA, {})).toThrow();
    expect(() => mapOperationalEventDoc('foreign', eventV2, { ...parentsA, orgId: 'org-b' }, { 'team-a': parentsA })).toThrow();
  });
});
