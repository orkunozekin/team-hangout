import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  serverTimestamp,
  Timestamp,
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

export async function createEvent(
  input: CreateEventInput,
): Promise<TeamEvent> {
  const ref = doc(collection(db, 'events'));
  const payload = {
    teamId: input.teamId,
    type: input.type,
    title: input.title.trim(),
    date: Timestamp.fromDate(input.date),
    time: input.time.trim(),
    location: input.location ?? null,
    notes: input.notes?.trim() || null,
    createdBy: input.createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  };

  await setDoc(ref, payload);

  return {
    id: ref.id,
    teamId: input.teamId,
    type: input.type,
    title: input.title.trim(),
    date: input.date,
    time: input.time.trim(),
    location: input.location ?? null,
    notes: input.notes?.trim() || null,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

export async function updateEvent(
  eventId: string,
  input: UpdateEventInput,
): Promise<void> {
  const patch: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };

  if (input.type !== undefined) patch.type = input.type;
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.date !== undefined) {
    patch.date = Timestamp.fromDate(input.date);
  }
  if (input.time !== undefined) patch.time = input.time.trim();
  if (input.location !== undefined) patch.location = input.location;
  if (input.notes !== undefined) {
    patch.notes = input.notes?.trim() || null;
  }

  await updateDoc(doc(db, 'events', eventId), patch);
}

export async function softDeleteEvent(
  eventId: string,
): Promise<void> {
  await updateDoc(doc(db, 'events', eventId), {
    deletedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
