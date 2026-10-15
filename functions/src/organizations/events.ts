import { Timestamp, Transaction } from 'firebase-admin/firestore';
import { Data, id, invalid, keys, object, optional, text } from '../commandSupport';
import { eventScope, denied } from './policy';
import { audit } from './commands';

export function teamIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) invalid('Supply 1 through 20 teamIds.');
  const result = (value as unknown[]).map(value => id(value, 'teamIds'));
  if (new Set(result).size !== result.length) invalid('Duplicate teamIds.');
  return result;
}
function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(`Invalid ${field}.`);
  return value as string;
}
export function v2Fields(value: unknown, partial = false): Data {
  const fields = object(value);
  keys(fields, ['title', 'type', 'startsAt', 'endsAt', 'timeZone', 'status', 'publicationState', 'location', 'notes', ...(partial ? [] : ['teamIds'])]);
  const result: Data = {};
  for (const field of ['title', 'type', 'startsAt', 'endsAt', 'timeZone', 'status', 'publicationState']) {
    if (partial && fields[field] === undefined) continue;
    const value = fields[field];
    if (field === 'title') result[field] = text(value, field);
    else if (field === 'startsAt' || field === 'endsAt') result[field] = instant(value, field);
    else if (field === 'timeZone') {
      result[field] = text(value, field, 100);
      try { new Intl.DateTimeFormat('en', { timeZone: result[field] }); } catch { invalid('Invalid timeZone.'); }
    } else {
      const choices = field === 'type' ? ['practice', 'match'] : field === 'status' ? ['scheduled'] : ['staged', 'published'];
      if (!choices.includes(value)) invalid(`Invalid ${field}.`);
      result[field] = value;
    }
  }
  if (!partial) result.teamIds = teamIds(fields.teamIds);
  if (!partial || fields.location !== undefined) {
    result.location = null;
    if (fields.location != null) {
      const location = object(fields.location); keys(location, ['name', 'address']);
      result.location = { name: text(location.name, 'location name'), ...(location.address ? { address: text(location.address, 'address', 500) } : {}) };
    }
  }
  if (!partial || fields.notes !== undefined) result.notes = optional(typeof fields.notes === 'string' ? fields.notes.trim() : fields.notes, 'notes', 5000);
  if (partial && !Object.keys(result).length) invalid('No changes supplied.');
  return result;
}
export function validateStoredEvent(event: Data, scope: Awaited<ReturnType<typeof eventScope>>) {
  const ids = teamIds(event.teamIds);
  if (event.orgId !== scope.orgId || event.programId !== scope.programId || event.seasonId !== scope.seasonId
    || event.teamId !== ids[0] || ids.length !== scope.teamIds.length || ids.some((id, index) => id !== scope.teamIds[index])
    || (event.divisionId !== null && scope.teams.some(team => team.divisionId !== event.divisionId))) denied();
  if (!['scheduled', 'postponed', 'cancelled', 'completed'].includes(event.status)
    || !['staged', 'published'].includes(event.publicationState) || event.publicationOperationId !== null) {
    invalid('Unsupported event lifecycle or publication operation.');
  }
}
export function storageFields(event: Data): Data {
  const startsAt = instant(event.startsAt instanceof Timestamp ? event.startsAt.toDate().toISOString() : event.startsAt, 'startsAt');
  const endsAt = instant(event.endsAt instanceof Timestamp ? event.endsAt.toDate().toISOString() : event.endsAt, 'endsAt');
  if (endsAt <= startsAt) invalid('endsAt must follow startsAt.');
  return { ...event, startsAt: Timestamp.fromDate(new Date(startsAt)), endsAt: Timestamp.fromDate(new Date(endsAt)) };
}
export function eventAudit(tx: Transaction, event: Data, uid: string, operation: string, eventId: string, revision: number) {
  audit(tx, event.orgId, uid, operation, eventId, revision);
}
