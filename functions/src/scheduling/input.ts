import { Interval, LIMITS, ScheduleInput } from './model';

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`SCHEDULING_INPUT: ${message}`);
}
function integer(n: number, min: number, max: number) { return Number.isSafeInteger(n) && n >= min && n <= max; }
function list<T>(values: T[], maximum: number, name: string) {
  requireValue(Array.isArray(values) && values.length <= maximum, `${name} limit is ${maximum}; split the input, never truncate it.`);
}
function id(value: string) { requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value), 'Use bounded opaque IDs.'); }
function unique(values: string[]) { values.forEach(id); requireValue(new Set(values).size === values.length, 'Duplicate ID.'); }
function instant(value: string) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), 'Use explicit UTC ISO instants; resolve local DST times before scheduling.');
  const ms = Date.parse(value);
  requireValue(Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')), 'Invalid UTC instant.');
}
function interval(value: Interval) { instant(value.startsAt); instant(value.endsAt); requireValue(Date.parse(value.startsAt) < Date.parse(value.endsAt), 'Interval must have positive duration.'); }
function intervals(values: Interval[]) { list(values, LIMITS.intervalsPerEntity, 'Intervals per entity'); values.forEach(interval); }
export function checkInput(input: ScheduleInput) {
  requireValue(input && typeof input === 'object', 'Expected snapshot.');
  list(input.teams, LIMITS.teams, 'Teams'); requireValue(input.teams.length >= 2, 'At least two teams required.');
  list(input.resources, LIMITS.resources, 'Resources'); list(input.slots, LIMITS.slots, 'Candidate slots'); list(input.busy, LIMITS.busy, 'Busy intervals');
  unique(input.teams.map(t => t.id)); unique(input.resources.map(r => r.id)); unique(input.slots.map(s => s.id));
  requireValue(['soccer', 'basketball', 'football'].includes(input.sport), 'Unsupported sport.');
  requireValue(integer(input.durationMinutes, 1, 1440) && integer(input.minimumRestMinutes, 0, 10080), 'Duration/rest outside supported range.');
  requireValue(integer(input.repetitions, 1, LIMITS.repetitions), 'Repetitions must be explicit, from 1 to 2.');
  requireValue(integer(input.seed, 0, 0xffffffff), 'Seed must be an unsigned 32-bit integer.');
  requireValue(['notChecked', 'coachApprovedBusyProvided'].includes(input.crossOrganizationBusy), 'Declare external coach busy coverage.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(0); } catch { throw new Error('SCHEDULING_INPUT: Invalid IANA timezone.'); }
  requireValue(typeof input.timeZone === 'string' && input.timeZone.length > 0 && !/^[+-]/.test(input.timeZone), 'Explicit timezone required.');
  interval(input.season); requireValue(Date.parse(input.season.endsAt) - Date.parse(input.season.startsAt) <= LIMITS.weeks * 7 * 86400000, 'Season limit is 16 elapsed weeks; split longer seasons.');
  const resourceIds = new Set(input.resources.map(r => r.id)); const slotIds = new Set(input.slots.map(s => s.id));
  input.teams.forEach(t => {
    list(t.coachIds, LIMITS.coachesPerTeam, 'Assigned coaches'); unique(t.coachIds); intervals(t.blackouts);
    if (t.preferredSlotIds !== undefined) { list(t.preferredSlotIds, LIMITS.slots, 'Preferences'); unique(t.preferredSlotIds); requireValue(t.preferredSlotIds.every(s => slotIds.has(s)), 'Unknown preferred slot.'); }
  });
  input.resources.forEach(r => {
    requireValue(typeof r.active === 'boolean', 'Resource active flag required.');
    list(r.sports, 3, 'Resource sports'); requireValue(r.sports.every(s => ['soccer', 'basketball', 'football'].includes(s)), 'Unknown resource sport.');
    requireValue(integer(r.setupMinutes, 0, 1440) && integer(r.cleanupMinutes, 0, 1440), 'Invalid resource buffers.'); intervals(r.availability); intervals(r.closures);
  });
  input.slots.forEach(s => { interval(s); requireValue(resourceIds.has(s.resourceId), 'Unknown slot resource.'); requireValue(typeof s.late === 'boolean', 'Explicit late-slot classification required.'); });
  input.busy.forEach(b => {
    interval(b); list(b.teamIds, 32, 'Busy teams'); list(b.coachIds, 256, 'Busy actors'); unique(b.teamIds); unique(b.coachIds);
    requireValue(b.resourceId === null || resourceIds.has(b.resourceId), 'Unknown busy resource.');
    requireValue(integer(b.setupMinutes, 0, 1440) && integer(b.cleanupMinutes, 0, 1440), 'Invalid busy buffers.');
  });
}
