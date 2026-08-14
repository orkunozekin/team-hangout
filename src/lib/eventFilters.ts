import {
  EventType,
  EventTypeFilter,
  TeamEvent,
} from '../types/models';

export function filterEventsByType(
  events: TeamEvent[],
  filter: EventTypeFilter,
): TeamEvent[] {
  if (filter === 'all') {
    return events;
  }
  return events.filter((event) => event.type === filter);
}

export function isEventType(value: string): value is EventType {
  return value === 'practice' || value === 'match';
}

export function parseEventTypeFilter(
  value: string,
): EventTypeFilter {
  if (value === 'all' || isEventType(value)) {
    return value;
  }
  return 'all';
}
