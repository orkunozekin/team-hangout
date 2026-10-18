import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AgendaEvent, AgendaPage, AgendaParticipant, AgendaTeam } from "../../shared/agenda";
import type { TeamEvent } from "../types/models";
import type { TeamEventPage } from "../firebase/events";

const SCHEMA = 1;
const ROOT = "@team-hangout/game-day";
const CLEANUP_KEY = `${ROOT}/pending-cleanup`;
const TTL_MS = 24 * 60 * 60 * 1000;
const PAST_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 30 * 24 * 60 * 60 * 1000;

type Envelope<T> = { schema: number; savedAt: string; value: T };
export type CachedValue<T> = {
  value: T;
  savedAt: string;
  olderThanTtl: boolean;
};

const segment = (value: string) => encodeURIComponent(value);
const accountRoot = (uid: string) => `${ROOT}/account/${segment(uid)}/`;
const accountPrefix = (uid: string) => `${accountRoot(uid)}schema/${SCHEMA}/`;
const agendaIndexKey = (uid: string) => `${accountPrefix(uid)}agenda-organizations`;
const agendaKey = (uid: string, orgId: string) =>
  `${accountPrefix(uid)}organization/${segment(orgId)}/agenda`;
const scheduleKey = (uid: string, teamId: string, view: "upcoming" | "past") =>
  `${accountPrefix(uid)}team/${segment(teamId)}/schedule/${view}`;
const eventKey = (uid: string, scopeId: string, eventId: string) =>
  `${accountPrefix(uid)}scope/${segment(scopeId)}/event/${segment(eventId)}`;

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function iso(value: unknown): string | null {
  const raw = text(value, 100);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function withinWindow(startsAt: string, now: Date): boolean {
  const time = Date.parse(startsAt);
  return time >= now.getTime() - PAST_MS && time <= now.getTime() + FUTURE_MS;
}

function participant(value: unknown): AgendaParticipant | null {
  const row = value as Partial<AgendaParticipant> | null;
  const orgId = text(row?.orgId, 200);
  const participantId = text(row?.participantId, 200);
  const displayName = text(row?.displayName, 200);
  return orgId && participantId && displayName
    ? { orgId, participantId, displayName }
    : null;
}

function agendaTeam(value: unknown): AgendaTeam | null {
  const row = value as Partial<AgendaTeam> | null;
  const id = text(row?.id, 200);
  const orgId = text(row?.orgId, 200);
  const organizationName = text(row?.organizationName, 200);
  const name = text(row?.name, 200);
  const seasonId = text(row?.seasonId, 200);
  const seasonName = text(row?.seasonName, 200);
  if (!id || !orgId || !organizationName || !name || !seasonId || !seasonName)
    return null;
  const seasonStatus = ["draft", "active", "archived"].includes(
    row?.seasonStatus ?? "",
  )
    ? row!.seasonStatus!
    : row?.archived
      ? "archived"
      : "active";
  return {
    id,
    orgId,
    organizationName,
    name,
    seasonId,
    seasonName,
    seasonStatus,
    archived: row?.archived === true,
    participants: Array.isArray(row?.participants)
      ? row.participants.slice(0, 100).map(participant).filter(Boolean) as AgendaParticipant[]
      : [],
  };
}

function agendaEvent(value: unknown, now: Date): AgendaEvent | null {
  const row = value as Partial<AgendaEvent> | null;
  const id = text(row?.id, 200);
  const orgId = text(row?.orgId, 200);
  const title = text(row?.title, 300);
  const startsAt = iso(row?.startsAt);
  const endsAt = iso(row?.endsAt);
  const timeZone = text(row?.timeZone, 100);
  if (
    !id || !orgId || !title || !startsAt || !endsAt || !timeZone ||
    !["practice", "match"].includes(row?.type ?? "") ||
    !withinWindow(startsAt, now)
  ) return null;
  const teams = Array.isArray(row?.teams)
    ? row.teams.slice(0, 20).map(agendaTeam).filter(Boolean) as AgendaTeam[]
    : [];
  return {
    id,
    orgId,
    title,
    type: row!.type!,
    startsAt,
    endsAt,
    timeZone,
    location: row?.location && text(row.location.name, 300)
      ? {
          name: text(row.location.name, 300)!,
          ...(text(row.location.address, 500)
            ? { address: text(row.location.address, 500)! }
            : {}),
        }
      : null,
    teams,
    participants: Array.isArray(row?.participants)
      ? row.participants.slice(0, 100).map(participant).filter(Boolean) as AgendaParticipant[]
      : [],
    ...(["scheduled", "postponed", "cancelled", "completed"].includes(row?.status ?? "")
      ? { status: row!.status }
      : {}),
    ...(Number.isInteger(row?.scheduleVersion) && Number(row?.scheduleVersion) > 0
      ? { scheduleVersion: Number(row?.scheduleVersion) }
      : {}),
  };
}

function safeTeamEvent(value: unknown, now: Date): TeamEvent | null {
  const row = value as Partial<TeamEvent> | null;
  const id = text(row?.id, 200);
  const teamId = text(row?.teamId, 200);
  const title = text(row?.title, 300);
  const startsAt = iso(row?.startsAt);
  const legacyDate = row?.date instanceof Date
    ? row.date
    : iso(row?.date) ? new Date(iso(row?.date)!) : null;
  const windowInstant = startsAt ?? legacyDate?.toISOString() ?? "";
  if (!id || !teamId || !title || !windowInstant || !withinWindow(windowInstant, now))
    return null;
  if (!["practice", "match"].includes(row?.type ?? "")) return null;
  const endsAt = iso(row?.endsAt);
  const timeZone = text(row?.timeZone, 100);
  const date = legacyDate ?? new Date(startsAt!);
  const teams = Array.isArray(row?.teams)
    ? row.teams.slice(0, 20).flatMap((team) => {
        const teamIdValue = text(team?.id, 200);
        const name = text(team?.name, 200);
        return teamIdValue && name ? [{ id: teamIdValue, name }] : [];
      })
    : undefined;
  return {
    id,
    teamId,
    title,
    type: row!.type!,
    date,
    time: text(row?.time, 20) ?? "00:00",
    location: row?.location && text(row.location.name, 300)
      ? {
          name: text(row.location.name, 300)!,
          ...(text(row.location.address, 500)
            ? { address: text(row.location.address, 500)! }
            : {}),
        }
      : null,
    notes: null,
    createdBy: "",
    createdAt: new Date(0),
    updatedAt: date,
    deletedAt: null,
    canManage: false,
    ...(row?.schemaVersion === 2 ? { schemaVersion: 2 } : {}),
    ...(Number.isInteger(row?.revision) ? { revision: Number(row?.revision) } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(["scheduled", "postponed", "cancelled", "completed"].includes(row?.status ?? "")
      ? { status: row!.status }
      : {}),
    ...(Number.isInteger(row?.scheduleVersion) && Number(row?.scheduleVersion) > 0
      ? { scheduleVersion: Number(row?.scheduleVersion) }
      : {}),
    ...(teams ? { teams } : {}),
  };
}

async function write<T>(key: string, value: T, now: Date) {
  const envelope: Envelope<T> = { schema: SCHEMA, savedAt: now.toISOString(), value };
  await AsyncStorage.setItem(key, JSON.stringify(envelope));
}

async function read<T>(key: string, now: Date): Promise<CachedValue<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Envelope<T>;
    if (envelope.schema !== SCHEMA || !iso(envelope.savedAt)) throw new Error("Invalid cache");
    return {
      value: envelope.value,
      savedAt: envelope.savedAt,
      olderThanTtl: now.getTime() - Date.parse(envelope.savedAt) > TTL_MS,
    };
  } catch {
    await AsyncStorage.removeItem(key);
    return null;
  }
}

export function isGameDayCacheAccessLoss(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const domainCode = (error as { details?: { domainCode?: string } } | null)
    ?.details?.domainCode;
  return [
    "permission-denied",
    "functions/permission-denied",
    "unauthenticated",
    "functions/unauthenticated",
  ].includes(code ?? "") || domainCode === "AGENDA_CHANGED";
}

export async function saveCachedAgenda(uid: string, page: AgendaPage, now = new Date()) {
  const teams = page.teams.slice(0, 100).map(agendaTeam).filter(Boolean) as AgendaTeam[];
  const items = page.items.slice(0, 100).map((item) => agendaEvent(item, now)).filter(Boolean) as AgendaEvent[];
  const orgIds = [...new Set([...teams.map((team) => team.orgId), ...items.map((item) => item.orgId)])].sort();
  const previous = await read<string[]>(agendaIndexKey(uid), now);
  const removed = (previous?.value ?? []).filter((orgId) => !orgIds.includes(orgId));
  if (removed.length) await AsyncStorage.multiRemove(removed.map((orgId) => agendaKey(uid, orgId)));
  await Promise.all(orgIds.map((orgId) => write(agendaKey(uid, orgId), {
    items: items.filter((item) => item.orgId === orgId),
    teams: teams.filter((team) => team.orgId === orgId),
    nextCursor: null,
    setupRequired: page.setupRequired === true,
    accessVersion: text(page.accessVersion, 500) ?? "cached",
  } satisfies AgendaPage, now)));
  await write(agendaIndexKey(uid), orgIds, now);
}

export async function loadCachedAgenda(uid: string, now = new Date()): Promise<CachedValue<AgendaPage> | null> {
  const index = await read<string[]>(agendaIndexKey(uid), now);
  if (!index || !Array.isArray(index.value) || index.value.length > 100) return null;
  const rows = (await Promise.all(index.value.map((orgId) => read<AgendaPage>(agendaKey(uid, orgId), now))))
    .filter(Boolean) as CachedValue<AgendaPage>[];
  if (!rows.length) return null;
  const savedAt = rows.map((row) => row.savedAt).sort()[0];
  const items = rows.flatMap((row) => row.value.items)
    .slice(0, 100)
    .map((item) => agendaEvent(item, now))
    .filter(Boolean) as AgendaEvent[];
  const teams = rows.flatMap((row) => row.value.teams)
    .slice(0, 100)
    .map(agendaTeam)
    .filter(Boolean) as AgendaTeam[];
  return {
    value: {
      items: [...new Map(items.map((item) => [item.id, item])).values()],
      teams: [...new Map(teams.map((team) => [team.id, team])).values()],
      nextCursor: null,
      setupRequired: rows.some((row) => row.value.setupRequired),
      accessVersion: "cached",
    },
    savedAt,
    olderThanTtl: rows.some((row) => row.olderThanTtl),
  };
}

export async function saveCachedTeamSchedule(
  uid: string,
  teamId: string,
  view: "upcoming" | "past",
  page: TeamEventPage,
  now = new Date(),
) {
  const items = page.items.slice(0, 100).map((item) => safeTeamEvent(item, now)).filter(Boolean) as TeamEvent[];
  await write(scheduleKey(uid, teamId, view), { items, nextCursor: null, canManage: false } satisfies TeamEventPage, now);
}

export async function loadCachedTeamSchedule(
  uid: string,
  teamId: string,
  view: "upcoming" | "past",
  now = new Date(),
) {
  const cached = await read<TeamEventPage>(scheduleKey(uid, teamId, view), now);
  if (!cached || !Array.isArray(cached.value.items)) return null;
  return {
    ...cached,
    value: {
      items: cached.value.items.slice(0, 100).map((item) => safeTeamEvent(item, now)).filter(Boolean) as TeamEvent[],
      nextCursor: null,
      canManage: false,
    },
  };
}

export async function saveCachedEvent(
  uid: string,
  scopeId: string,
  event: TeamEvent,
  now = new Date(),
) {
  const safe = safeTeamEvent(event, now);
  if (safe) await write(eventKey(uid, scopeId, event.id), safe, now);
}

export async function loadCachedEvent(
  uid: string,
  scopeId: string,
  eventId: string,
  now = new Date(),
) {
  const cached = await read<TeamEvent>(eventKey(uid, scopeId, eventId), now);
  if (!cached) return null;
  const safe = safeTeamEvent(cached.value, now);
  return safe ? { ...cached, value: safe } : null;
}

export async function clearGameDayCache(uid: string) {
  await AsyncStorage.setItem(CLEANUP_KEY, uid);
  const prefix = accountRoot(uid);
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
  if (keys.length) await AsyncStorage.multiRemove(keys);
  await AsyncStorage.removeItem(CLEANUP_KEY);
}

export async function reconcileGameDayCacheAccount(
  previousUid: string | null,
  nextUid: string | null,
) {
  const pendingUid = await AsyncStorage.getItem(CLEANUP_KEY);
  if (pendingUid) await clearGameDayCache(pendingUid);
  if (previousUid && previousUid !== nextUid) await clearGameDayCache(previousUid);
}

