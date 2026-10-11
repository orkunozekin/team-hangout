/** Pure boundary contracts. Not connected to live adapters until a later cutover. */
export type Data = Record<string, unknown>;
export type TimestampLike = { seconds: number; nanoseconds: number };
export type Parents = { orgId: string; programId: string; seasonId: string; divisionId: string | null };

function requireValue(condition: boolean, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid ${field}`);
}
export function opaqueId(value: unknown, field = 'id'): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && !value.includes('/'), field);
  return value;
}
function text(value: unknown, field: string): string {
  requireValue(typeof value === 'string' && value.trim().length > 0, field);
  return value;
}
function choice(value: unknown, options: readonly string[], field: string): string {
  requireValue(typeof value === 'string' && options.includes(value), field);
  return value;
}
/** Exact UTC ISO JSON, valid Dates or Timestamp-shaped storage values; never substitute now. */
export function timestampToIso(value: unknown): string {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') {
    date = new Date(value);
    requireValue(Number.isFinite(date.getTime()) && date.toISOString() === value, 'timestamp');
  } else {
    requireValue(value !== null && typeof value === 'object', 'timestamp');
    const { seconds, nanoseconds } = value as TimestampLike;
    requireValue(Number.isSafeInteger(seconds) && seconds >= -62135596800 && seconds <= 253402300799 && Number.isInteger(nanoseconds)
      && nanoseconds >= 0 && nanoseconds < 1e9, 'timestamp');
    date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6));
  }
  requireValue(Number.isFinite(date.getTime()), 'timestamp');
  const iso = date.toISOString();
  requireValue(date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999, 'timestamp');
  return iso;
}
export function isoToTimestamp(value: unknown): TimestampLike {
  const milliseconds = new Date(timestampToIso(value)).getTime();
  const seconds = Math.floor(milliseconds / 1000);
  return { seconds, nanoseconds: (milliseconds - seconds * 1000) * 1e6 };
}
function common(data: Data) {
  requireValue(data.schemaVersion === 2, 'schemaVersion');
  requireValue(Number.isSafeInteger(data.revision) && (data.revision as number) >= 1, 'revision');
  return {
    schemaVersion: 2 as const, revision: data.revision as number,
    createdBy: opaqueId(data.createdBy, 'createdBy'), updatedBy: opaqueId(data.updatedBy, 'updatedBy'),
    createdAt: timestampToIso(data.createdAt), updatedAt: timestampToIso(data.updatedAt),
  };
}
export function decodeParents(data: Data): Parents {
  return {
    orgId: opaqueId(data.orgId, 'orgId'), programId: opaqueId(data.programId, 'programId'),
    seasonId: opaqueId(data.seasonId, 'seasonId'),
    divisionId: data.divisionId === null ? null : opaqueId(data.divisionId, 'divisionId'),
  };
}
/** Callers must provide canonical parents loaded from storage, never claimed client scope. */
export function assertParents(actual: Parents, canonical: Parents): void {
  for (const field of ['orgId', 'programId', 'seasonId', 'divisionId'] as const) {
    requireValue(actual[field] === canonical[field], field);
  }
}
export function decodeTeam(data: Data, canonical: Parents) {
  const parents = decodeParents(data);
  assertParents(parents, canonical);
  requireValue(parents.divisionId !== null, 'divisionId');
  return { ...common(data), ...parents, name: text(data.name, 'name'),
    sport: data.sport === null ? null : text(data.sport, 'sport'),
    inviteCode: data.inviteCode === null ? null : text(data.inviteCode, 'inviteCode'),
    status: choice(data.status, ['active', 'archived'], 'status') };
}
export function decodeStaff(data: Data, orgId: string) {
  requireValue(data.orgId === opaqueId(orgId), 'orgId');
  requireValue(Array.isArray(data.roles) && data.roles.length > 0
    && new Set(data.roles).size === data.roles.length, 'roles');
  const roles = data.roles.map((role) => choice(role, ['orgAdmin', 'programStaff'], 'roles'));
  requireValue(Array.isArray(data.programIds), 'programIds');
  const programIds = data.programIds.map((id) => opaqueId(id, 'programIds'));
  requireValue(new Set(programIds).size === programIds.length
    && (!roles.includes('programStaff') || programIds.length > 0), 'programIds');
  return { ...common(data), orgId, roles, programIds,
    status: choice(data.status, ['active', 'revoked'], 'status') };
}
/** Events may span divisions; an explicit event division still restricts every team. */
function assertEventParents(event: Parents, canonical: Parents): void {
  for (const field of ['orgId', 'programId', 'seasonId'] as const) {
    requireValue(event[field] === canonical[field], field);
  }
  if (event.divisionId !== null) requireValue(event.divisionId === canonical.divisionId, 'divisionId');
}
export function decodeEvent(data: Data, canonical: Parents, teams: Record<string, Parents>) {
  const parents = decodeParents(data);
  assertEventParents(parents, canonical);
  requireValue(Array.isArray(data.teamIds) && data.teamIds.length > 0, 'teamIds');
  const teamIds = data.teamIds.map((id) => opaqueId(id, 'teamIds'));
  requireValue(new Set(teamIds).size === teamIds.length && data.teamId === teamIds[0], 'teamId');
  teamIds.forEach((id) => {
    requireValue(Object.hasOwn(teams, id), 'teamIds');
    assertEventParents(parents, teams[id]);
  });
  const startsAt = timestampToIso(data.startsAt);
  const endsAt = timestampToIso(data.endsAt);
  requireValue(Date.parse(endsAt) > Date.parse(startsAt), 'endsAt');
  requireValue(typeof data.timeZone === 'string', 'timeZone');
  new Intl.DateTimeFormat('en', { timeZone: data.timeZone });
  return { ...common(data), ...parents, teamId: teamIds[0], teamIds, startsAt, endsAt,
    title: text(data.title, 'title'), type: choice(data.type, ['practice', 'match'], 'type'),
    timeZone: data.timeZone, status: choice(data.status, ['scheduled', 'postponed', 'cancelled', 'completed'], 'status'),
    publicationState: choice(data.publicationState, ['staged', 'published'], 'publicationState'),
    publicationOperationId: data.publicationOperationId === null ? null : opaqueId(data.publicationOperationId),
    deletedAt: data.deletedAt === null ? null : timestampToIso(data.deletedAt) };
}
/** Review tool for legacy dates. Live legacy mappers remain unchanged in Step 1. */
export function decodeLegacyDates(data: Data, fields: string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, timestampToIso(data[field])]));
}

/** Hierarchy command inputs. Authority and parent references are independently checked by the server. */
export type HierarchyKind = 'organization' | 'program' | 'season' | 'division';
export type OrganizationKind = 'municipal' | 'communityCenter' | 'club';
export type SportCode = 'soccer' | 'basketball' | 'football' | 'other';
export type SeasonStatus = 'draft' | 'active' | 'archived';
export type HierarchyFields = {
  organization: { name: string; kind: OrganizationKind; timeZone: string; status: 'active' | 'archived' };
  program: { name: string; sportCode: SportCode; sportLabel?: string | null; status: 'active' | 'archived' };
  season: { name: string; programId: string; startsOn: string; endsOn: string; status: 'draft' | 'active' };
  division: { name: string; programId: string; seasonId: string; ageBandLabel?: string | null; status: 'active' | 'archived' };
};
export type SaveHierarchyEntityInput<K extends HierarchyKind> = {
  requestId: string; orgId: string; kind: K; entityId?: string; expectedRevision: number; fields: HierarchyFields[K];
};
export type HierarchyPageInput = {
  orgId: string; kind?: 'program' | 'season' | 'division' | 'team'; programId?: string;
  seasonStatus?: SeasonStatus; pageSize?: number; cursor?: string;
};
