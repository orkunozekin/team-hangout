import { runCommand } from './commands';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';

import {
  db,
} from './config';

import {
  CreateEventInput,
  TeamEvent,
  UpdateEventInput,
} from '../types/models';

function toDate(value: unknown): Date {
  if (
    value != null &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return new Date();
}

export function mapEventDoc(
  id: string,
  data: Record<string, unknown>,
): TeamEvent {
  const locationRaw = data.location as Record<string, unknown> | null | undefined;

  return {
    id,
    revision: typeof data.revision === 'number' ? data.revision : 0,
    teamId: String(data.teamId ?? ''),
    type: data.type === 'match' ? 'match' : 'practice',
    title: String(data.title ?? ''),
    date: toDate(data.date),
    time: String(data.time ?? '00:00'),
    location:
      locationRaw && typeof locationRaw.name === 'string'
        ? {
            name: locationRaw.name,
            address:
              locationRaw.address == null
                ? undefined
                : String(locationRaw.address),
          }
        : null,
    notes: data.notes == null ? null : String(data.notes),
    createdBy: String(data.createdBy ?? ''),
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
    deletedAt:
      data.deletedAt == null ? null : toDate(data.deletedAt),
  };
}

export async function getEvent(
  eventId: string,
): Promise<TeamEvent | null> {
  const snap = await getDoc(doc(db, 'events', eventId));
  if (!snap.exists()) {
    return null;
  }
  const event = mapEventDoc(
    snap.id,
    snap.data() as Record<string, unknown>,
  );
  if (event.deletedAt) {
    return null;
  }
  return event;
}

export async function listTeamEvents(
  teamId: string,
): Promise<TeamEvent[]> {
  const q = query(
    collection(db, 'events'),
    where('teamId', '==', teamId),
    where('deletedAt', '==', null),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    mapEventDoc(d.id, d.data() as Record<string, unknown>),
  );
}

function eventPayload(input: UpdateEventInput) {
  const payload: Record<string, unknown> = {};
  for (const field of ['type', 'title', 'time', 'notes'] as const) {
    if (input[field] !== undefined) payload[field] = typeof input[field] === 'string' ? input[field]?.trim() : input[field];
  }
  if (input.date !== undefined) payload.date = input.date.toISOString();
  if (input.location !== undefined) payload.location = input.location ? { name: input.location.name, ...(input.location.address ? { address: input.location.address } : {}) } : null;
  return payload;
}

export async function createEvent(input: CreateEventInput): Promise<TeamEvent> {
  const result = await runCommand<Record<string, unknown> & { id: string }>('createEvent', { teamId: input.teamId, event: eventPayload(input) });
  return mapEventDoc(result.id, result);
}

export async function updateEvent(eventId: string, input: UpdateEventInput, expectedRevision: number): Promise<void> {
  await runCommand('updateEvent', { eventId, expectedRevision, patch: eventPayload(input) });
}

export async function softDeleteEvent(eventId: string, expectedRevision: number): Promise<void> {
  await runCommand('softDeleteEvent', { eventId, expectedRevision });
}
