import { decodeEvent, opaqueId, timestampToIso } from './contracts';
import type { Data, Parents } from './contracts';

export type EventStatus = 'scheduled' | 'postponed' | 'cancelled' | 'completed';
export type PublicationState = 'staged' | 'published';
export type AvailabilityStatus = 'yes' | 'no' | 'maybe';
export type AttendanceStatus = 'unknown' | 'present' | 'late' | 'absent' | 'excused';
export type AttendanceSource = 'coach' | 'self' | 'guardian' | 'geoAssisted';
export type OperationState = 'pending' | 'running' | 'committed' | 'failed' | 'aborted';
export type RevisionRequest = { requestId: string; expectedRevision: number };
export type OperationalEvent = Omit<ReturnType<typeof decodeEvent>, 'status' | 'publicationState'> & {
  status: EventStatus;
  publicationState: PublicationState;
  location: { name: string; address?: string } | null;
  notes: string | null;
  id: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  facilityId: string | null;
  resourceId: string | null;
  scheduleVersion: number;
  rescheduledFromRevision: number | null;
  completedAt: string | null;
};
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${field}`);
  return value as number;
}
const nullableId = (value: unknown, field: string): string | null => value == null ? null : opaqueId(value, field);
/** Reader only. Parent/team data must come from authorized canonical storage, never request claims.
 * Phase 1 records omit operational metadata. Nulls do not invent venue or matchup assignments.
 * Publication decoding is not authorization: readers must check live access and commit markers.
 */
export function decodeOperationalEvent(id: string, data: Data, canonical: Parents, teams: Record<string, Parents>): OperationalEvent {
  const event = decodeEvent(data, canonical, teams);
  if (event.teamIds.length > 20) throw new Error('Invalid teamIds');
  const homeTeamId = nullableId(data.homeTeamId, 'homeTeamId');
  const awayTeamId = nullableId(data.awayTeamId, 'awayTeamId');
  if ((homeTeamId === null) !== (awayTeamId === null)
    || (homeTeamId !== null && (homeTeamId === awayTeamId || !event.teamIds.includes(homeTeamId)
      || !event.teamIds.includes(awayTeamId!)))) throw new Error('Invalid matchup');
  const facilityId = nullableId(data.facilityId, 'facilityId');
  const resourceId = nullableId(data.resourceId, 'resourceId');
  if (resourceId !== null && facilityId === null) throw new Error('Invalid facilityId');
  const rescheduledFromRevision = data.rescheduledFromRevision == null ? null : positiveInteger(data.rescheduledFromRevision, 'rescheduledFromRevision');
  if (rescheduledFromRevision !== null && rescheduledFromRevision >= event.revision) throw new Error('Invalid rescheduledFromRevision');
  let location: OperationalEvent['location'] = null;
  if (data.location != null) {
    const raw = data.location as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw) || typeof raw.name !== 'string' || !raw.name.trim()
      || (raw.address !== undefined && typeof raw.address !== 'string')) throw new Error('Invalid location');
    location = { name: raw.name, ...(raw.address === undefined ? {} : { address: raw.address as string }) };
  }
  if (data.notes != null && typeof data.notes !== 'string') throw new Error('Invalid notes');
  return { ...event, status: event.status as EventStatus, publicationState: event.publicationState as PublicationState,
    location, notes: data.notes == null ? null : data.notes as string, id: opaqueId(id), homeTeamId, awayTeamId, facilityId, resourceId,
    scheduleVersion: data.scheduleVersion === undefined ? 1 : positiveInteger(data.scheduleVersion, 'scheduleVersion'),
    rescheduledFromRevision, completedAt: data.completedAt == null ? null : timestampToIso(data.completedAt) };
}
