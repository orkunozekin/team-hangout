import {
  applyScheduleView,
  sortEventsByDateTime,
} from '../eventSort';

import {
  TeamEvent,
} from '../../types/models';

function makeEvent(
  partial: Partial<TeamEvent> &
    Pick<TeamEvent, 'id' | 'type' | 'title' | 'date' | 'time'>,
): TeamEvent {
  return {
    teamId: 't1',
    location: null,
    notes: null,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...partial,
  };
}

describe('eventSort', () => {
  const events = [
    makeEvent({
      id: '2',
      type: 'match',
      title: 'B',
      date: new Date('2026-08-21T00:00:00.000Z'),
      time: '10:00',
    }),
    makeEvent({
      id: '1',
      type: 'practice',
      title: 'A',
      date: new Date('2026-08-20T00:00:00.000Z'),
      time: '18:00',
    }),
    makeEvent({
      id: '3',
      type: 'practice',
      title: 'C',
      date: new Date('2026-08-20T00:00:00.000Z'),
      time: '09:00',
    }),
  ];

  it('sorts ascending by date then time', () => {
    const sorted = sortEventsByDateTime(events, 'asc');
    expect(sorted.map((e) => e.id)).toEqual(['3', '1', '2']);
  });

  it('sorts descending', () => {
    const sorted = sortEventsByDateTime(events, 'desc');
    expect(sorted.map((e) => e.id)).toEqual(['2', '1', '3']);
  });

  it('applies filter and sort together', () => {
    const result = applyScheduleView(events, 'practice', 'asc');
    expect(result.map((e) => e.id)).toEqual(['3', '1']);
  });
});

  it('keeps stable title ordering for identical timestamps', () => {
    const same = [
      makeEvent({
        id: 'b',
        type: 'practice',
        title: 'B',
        date: new Date('2026-08-20T00:00:00.000Z'),
        time: '10:00',
      }),
      makeEvent({
        id: 'a',
        type: 'practice',
        title: 'A',
        date: new Date('2026-08-20T00:00:00.000Z'),
        time: '10:00',
      }),
    ];
    expect(sortEventsByDateTime(same).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('defaults missing time during sort', () => {
    const withMissing = [
      makeEvent({
        id: '1',
        type: 'match',
        title: 'Later',
        date: new Date('2026-08-20T00:00:00.000Z'),
        time: '01:00',
      }),
      makeEvent({
        id: '2',
        type: 'match',
        title: 'Earlier',
        date: new Date('2026-08-20T00:00:00.000Z'),
        time: '',
      }),
    ];
    expect(sortEventsByDateTime(withMissing).map((e) => e.id)).toEqual([
      '2',
      '1',
    ]);
  });
