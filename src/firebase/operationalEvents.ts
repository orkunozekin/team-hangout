import { decodeOperationalEvent } from '../../shared/operations';
import type { Data, Parents } from '../../shared/contracts';

/** Strict canonical reader for the future event service. Does not convert legacy date/time. */
export function mapOperationalEventDoc(id: string, data: Data, canonical: Parents, teams: Record<string, Parents>) {
  const event = decodeOperationalEvent(id, data, canonical, teams);
  return { ...event, startsAt: new Date(event.startsAt), endsAt: new Date(event.endsAt),
    createdAt: new Date(event.createdAt), updatedAt: new Date(event.updatedAt),
    deletedAt: event.deletedAt === null ? null : new Date(event.deletedAt),
    completedAt: event.completedAt === null ? null : new Date(event.completedAt) };
}
export type CanonicalTeamEvent = ReturnType<typeof mapOperationalEventDoc>;
