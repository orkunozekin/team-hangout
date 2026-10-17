import { decodePublicOperationalEvent } from '../../shared/operations';
import { mapOperationalEventDoc } from './operationalEvents';
import type { Parents } from '../../shared/contracts';
import { httpsCallable } from 'firebase/functions';
import { functions } from './config';
import { getTeam } from './teams';
const readEventCommand = async <T,>(name: string, payload: Record<string, unknown>): Promise<T> => (await httpsCallable<Record<string, unknown>, T>(functions, name)(payload)).data;

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

  if (data.schemaVersion === 2) {
    const parents = { orgId: data.orgId, programId: data.programId, seasonId: data.seasonId, divisionId: data.divisionId } as Parents;
    const teams = Object.fromEntries((data.teamIds as string[]).map(teamId => [teamId, parents]));
    const canonical = data.createdBy === undefined && data.updatedBy === undefined
      ? decodePublicOperationalEvent(id, data, parents, teams)
      : mapOperationalEventDoc(id, data, parents, teams);
    const startsAt = new Date(canonical.startsAt).toISOString();
    const zone = String(data.timeZone);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(startsAt));
    const part = (name: string) => parts.find(value => value.type === name)!.value;
    return { ...mapEventDoc(id, { ...data, schemaVersion: undefined, date: `${part('year')}-${part('month')}-${part('day')}T12:00:00.000Z`, time: `${part('hour')}:${part('minute')}` }),
      schemaVersion: 2, startsAt, endsAt: new Date(canonical.endsAt).toISOString(), timeZone: zone,
      status: data.status as TeamEvent['status'], scheduleVersion: Number(data.scheduleVersion ?? 1),
      teams: data.teams as TeamEvent['teams'], canManage: data.canManage === true,
      history: data.history as TeamEvent['history'], historyHasMore: data.historyHasMore === true };
  }
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
  try {
    const result = await readEventCommand<Record<string, unknown>>('getCanonicalEvent', { eventId });
    return mapEventDoc(eventId, result);
  } catch (error) {
    if ((error as { code?: string }).code !== 'functions/permission-denied') throw error;
  }
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

export type TeamEventPage = { items: TeamEvent[]; nextCursor: string | null; canManage?: boolean };
export async function listTeamEventPage(teamId: string, cursor: string | null = null, view: 'upcoming' | 'past' = 'upcoming', teamSchemaVersion?: number): Promise<TeamEventPage> {
  const schemaVersion = teamSchemaVersion ?? (await getTeam(teamId))?.schemaVersion;
  if (schemaVersion === 2) {
    const page = await readEventCommand<{ items: (Record<string, unknown> & { id: string })[]; nextCursor: string | null; canManage: boolean }>(
      'listCanonicalTeamEvents', { teamId, cursor, pageSize: 50, view });
    return { items: page.items.map(item => mapEventDoc(item.id, item)), nextCursor: page.nextCursor, canManage: page.canManage === true };
  }
  const q = query(
    collection(db, 'events'),
    where('teamId', '==', teamId),
    where('deletedAt', '==', null),
  );
  const snap = await getDocs(q);
  return { items: snap.docs.map(d => mapEventDoc(d.id, d.data() as Record<string, unknown>)), nextCursor: null };
}

/** Compatibility callers receive a bounded first page. Screens use the explicit page API. */
export async function listTeamEvents(teamId: string): Promise<TeamEvent[]> {
  return (await listTeamEventPage(teamId)).items;
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

export async function mutateEventSchedule(eventId: string, expectedRevision: number, action: string, patch: Record<string, unknown>, reason: string): Promise<void> {
  await runCommand('mutateEventSchedule', { eventId, expectedRevision, action, patch, reason });
}
export async function createCanonicalEvent(teamId: string, event: Record<string, unknown>): Promise<void> {
  await runCommand('createEvent', { teamId, event });
}

export async function listEventTeamChoices(teamId: string, cursor: string | null = null): Promise<{ items: { id: string; name: string }[]; nextCursor: string | null }> {
  return readEventCommand('listEventTeamChoices', { teamId, cursor, pageSize: 50 });
}
