import {
  filterEventsByType,
  isEventType,
  parseEventTypeFilter,
} from '../eventFilters';

import {
  TeamEvent,
} from '../../types/models';

function makeEvent(
  partial: Partial<TeamEvent> & Pick<TeamEvent, 'id' | 'type'>,
): TeamEvent {
  return {
    teamId: 't1',
    title: 'Event',
    date: new Date('2026-08-20T00:00:00.000Z'),
    time: '18:00',
    location: null,
    notes: null,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...partial,
  };
}

describe('eventFilters', () => {
  const events = [
    makeEvent({ id: '1', type: 'practice', title: 'P' }),
    makeEvent({ id: '2', type: 'match', title: 'M' }),
  ];

  it('returns all events for all filter', () => {
    expect(filterEventsByType(events, 'all')).toHaveLength(2);
  });

  it('filters practices and matches', () => {
    expect(filterEventsByType(events, 'practice')).toEqual([
      events[0],
    ]);
    expect(filterEventsByType(events, 'match')).toEqual([events[1]]);
  });

  it('checks event type guards', () => {
    expect(isEventType('practice')).toBe(true);
    expect(isEventType('match')).toBe(true);
    expect(isEventType('scrimmage')).toBe(false);
  });

  it('parses filter values with fallback', () => {
    expect(parseEventTypeFilter('match')).toBe('match');
    expect(parseEventTypeFilter('nope')).toBe('all');
  });
});
