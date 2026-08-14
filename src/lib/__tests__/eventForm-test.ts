import {
  formatEventDateLabel,
  hasEventErrors,
  isValidEventType,
  parseEventDate,
  validateEventForm,
  validateTeamName,
} from '../eventForm';

describe('eventForm', () => {
  it('validates event types', () => {
    expect(isValidEventType('practice')).toBe(true);
    expect(isValidEventType('game')).toBe(false);
  });

  it('validates a complete event form', () => {
    expect(
      validateEventForm({
        title: 'Practice',
        type: 'practice',
        date: '2026-08-20',
        time: '18:30',
      }),
    ).toEqual({});
  });

  it('returns field errors for bad input', () => {
    const errors = validateEventForm({
      title: ' ',
      type: 'scrimmage',
      date: '20-08-2026',
      time: '25:99',
    });
    expect(errors.title).toBeDefined();
    expect(errors.type).toBeDefined();
    expect(errors.date).toBeDefined();
    expect(errors.time).toBeDefined();
  });

  it('rejects impossible clock values', () => {
    expect(
      validateEventForm({
        title: 'X',
        type: 'match',
        date: '2026-08-20',
        time: '23:60',
      }).time,
    ).toBe('Enter a valid time');
  });

  it('parses and formats dates', () => {
    const date = parseEventDate('2026-08-20');
    expect(date.toISOString().startsWith('2026-08-20')).toBe(true);
    expect(formatEventDateLabel(date)).toContain('2026');
  });

  it('validates team names', () => {
    expect(validateTeamName('')).toBe('Team name is required');
    expect(validateTeamName('A')).toBe(
      'Team name must be at least 2 characters',
    );
    expect(validateTeamName('A'.repeat(61))).toBe(
      'Team name must be 60 characters or fewer',
    );
    expect(validateTeamName('Tigers')).toBeNull();
  });

  it('detects event errors', () => {
    expect(hasEventErrors({})).toBe(false);
    expect(hasEventErrors({ title: 'x' })).toBe(true);
  });
});

  it('rejects invalid calendar dates', () => {
    expect(
      validateEventForm({
        title: 'X',
        type: 'match',
        date: '2026-13-40',
        time: '10:00',
      }).date,
    ).toBeDefined();
  });

  it('accepts boundary times', () => {
    expect(
      validateEventForm({
        title: 'X',
        type: 'practice',
        date: '2026-08-20',
        time: '00:00',
      }),
    ).toEqual({});
    expect(
      validateEventForm({
        title: 'X',
        type: 'practice',
        date: '2026-08-20',
        time: '23:59',
      }),
    ).toEqual({});
  });
