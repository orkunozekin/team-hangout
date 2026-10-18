const mockStorage = new Map<string, string>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  getAllKeys: jest.fn(async () => [...mockStorage.keys()]),
  multiRemove: jest.fn(async (keys: string[]) => {
    keys.forEach((key) => mockStorage.delete(key));
  }),
  removeItem: jest.fn(async (key: string) => {
    mockStorage.delete(key);
  }),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  clearGameDayCache,
  loadCachedAgenda,
  loadCachedEvent,
  loadCachedTeamSchedule,
  reconcileGameDayCacheAccount,
  saveCachedAgenda,
  saveCachedEvent,
  saveCachedTeamSchedule,
} from "../gameDayCache";

const now = new Date("2026-10-17T18:00:00.000Z");
const participant = {
  orgId: "org-a",
  participantId: "participant-a",
  displayName: "Jamie",
};
const team = {
  id: "team-a",
  orgId: "org-a",
  organizationName: "Demo Club",
  name: "Stars",
  seasonId: "fall",
  seasonName: "Fall",
  seasonStatus: "active" as const,
  archived: false,
  participants: [participant],
};
const agendaEvent = {
  id: "event-a",
  orgId: "org-a",
  title: "Saturday match",
  type: "match" as const,
  startsAt: "2026-10-18T15:00:00.000Z",
  endsAt: "2026-10-18T16:00:00.000Z",
  timeZone: "America/Chicago",
  status: "scheduled" as const,
  scheduleVersion: 2,
  location: { name: "Field 1", address: "100 Sample Street" },
  teams: [team],
  participants: [participant],
};
const event = {
  id: "event-a",
  teamId: "team-a",
  schemaVersion: 2,
  revision: 4,
  title: "Saturday match",
  type: "match" as const,
  date: new Date("2026-10-18T12:00:00.000Z"),
  time: "10:00",
  startsAt: "2026-10-18T15:00:00.000Z",
  endsAt: "2026-10-18T16:00:00.000Z",
  timeZone: "America/Chicago",
  status: "scheduled" as const,
  scheduleVersion: 2,
  teams: [{ id: "team-a", name: "Stars" }],
  canManage: true,
  location: { name: "Field 1", address: "100 Sample Street" },
  notes: "Private coach note",
  history: [{
    revision: 3,
    action: "edit",
    previousStatus: "scheduled",
    status: "scheduled",
    previousStartsAt: "2026-10-18T14:00:00.000Z",
    startsAt: "2026-10-18T15:00:00.000Z",
  }],
  createdBy: "staff",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T17:00:00.000Z"),
  deletedAt: null,
};

beforeEach(() => mockStorage.clear());

test("restores a bounded account and organization agenda after a forced restart", async () => {
  await saveCachedAgenda(
    "user-a",
    {
      items: [
        agendaEvent,
        {
          ...agendaEvent,
          id: "too-old",
          startsAt: "2026-10-09T15:00:00.000Z",
          endsAt: "2026-10-09T16:00:00.000Z",
        },
        {
          ...agendaEvent,
          id: "too-far",
          startsAt: "2026-11-17T15:00:00.000Z",
          endsAt: "2026-11-17T16:00:00.000Z",
        },
      ],
      teams: [team],
      accessVersion: "access-4",
      nextCursor: "server-only-cursor",
      setupRequired: false,
    },
    now,
  );

  const restored = await loadCachedAgenda("user-a", now);
  expect(restored?.value.items.map((item) => item.id)).toEqual(["event-a"]);
  expect(restored?.value.nextCursor).toBeNull();
  expect(restored?.savedAt).toBe(now.toISOString());
  expect(restored?.olderThanTtl).toBe(false);
  expect(await loadCachedAgenda("user-b", now)).toBeNull();
});

test("persists only whitelisted event fields and always removes cached authority", async () => {
  await saveCachedTeamSchedule(
    "user-a",
    "team-a",
    "upcoming",
    { items: [event], nextCursor: "next", canManage: true },
    now,
  );
  await saveCachedEvent("user-a", "team-a", event, now);

  const schedule = await loadCachedTeamSchedule(
    "user-a",
    "team-a",
    "upcoming",
    now,
  );
  const detail = await loadCachedEvent(
    "user-a",
    "team-a",
    "event-a",
    now,
  );
  expect(schedule?.value.nextCursor).toBeNull();
  expect(schedule?.value.canManage).toBe(false);
  expect(schedule?.value.items[0].notes).toBeNull();
  expect(schedule?.value.items[0].history).toBeUndefined();
  expect(detail?.value.canManage).toBe(false);
  expect(detail?.value.notes).toBeNull();
  expect(detail?.value.history).toBeUndefined();
  expect(JSON.stringify([...mockStorage.values()])).not.toContain("Private coach note");
  expect(JSON.stringify([...mockStorage.values()])).not.toContain("staff");
});

test("marks old copies stale and clears every schema key before account exit", async () => {
  await saveCachedAgenda("user-a", {
    items: [agendaEvent],
    teams: [team],
    accessVersion: "access-4",
    nextCursor: null,
    setupRequired: false,
  }, now);
  await saveCachedEvent("user-a", "team-a", event, now);
  await saveCachedEvent("user-b", "team-a", event, now);
  mockStorage.set("@team-hangout/game-day/account/user-a/schema/0/legacy", "old");

  expect(
    (await loadCachedAgenda(
      "user-a",
      new Date("2026-10-18T18:00:00.001Z"),
    ))?.olderThanTtl,
  ).toBe(true);
  await clearGameDayCache("user-a");
  expect(await loadCachedAgenda("user-a", now)).toBeNull();
  expect(await loadCachedEvent("user-a", "team-a", "event-a", now)).toBeNull();
  expect([...mockStorage.keys()].some((key) => key.includes("account/user-a/"))).toBe(false);
  expect(await loadCachedEvent("user-b", "team-a", "event-a", now)).not.toBeNull();
});

test("retries interrupted account cleanup before exposing the next account", async () => {
  await saveCachedEvent("user-a", "team-a", event, now);
  (AsyncStorage.multiRemove as jest.Mock).mockRejectedValueOnce(new Error("Storage busy"));
  await expect(clearGameDayCache("user-a")).rejects.toThrow("Storage busy");
  expect(mockStorage.get("@team-hangout/game-day/pending-cleanup")).toBe("user-a");
  await reconcileGameDayCacheAccount(null, "user-b");
  expect([...mockStorage.keys()].some((key) => key.includes("account/user-a/"))).toBe(false);
  expect(mockStorage.has("@team-hangout/game-day/pending-cleanup")).toBe(false);

  await saveCachedEvent("user-b", "team-a", event, now);
  await reconcileGameDayCacheAccount("user-b", "user-c");
  expect([...mockStorage.keys()].some((key) => key.includes("account/user-b/"))).toBe(false);
});

test("finishes an in-flight snapshot write before account cleanup removes it", async () => {
  let releaseIndexRead: (value: string | null) => void = () => {};
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(
    () => new Promise<string | null>((resolve) => { releaseIndexRead = resolve; }),
  );
  const saving = saveCachedAgenda("user-a", {
    items: [agendaEvent], teams: [team], accessVersion: "access-4",
    nextCursor: null, setupRequired: false,
  }, now);
  const clearing = clearGameDayCache("user-a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseIndexRead(null);
  await Promise.all([saving, clearing]);
  expect([...mockStorage.keys()].some((key) => key.includes("account/user-a/"))).toBe(false);
});

test("prunes revoked organizations and tolerates minimal safe rows", async () => {
  await saveCachedAgenda("user-a", {
    items: [agendaEvent],
    teams: [team],
    accessVersion: "access-a",
    nextCursor: null,
    setupRequired: false,
  }, now);
  const minimalTeam = {
    ...team,
    id: "team-b",
    orgId: "org-b",
    archived: true,
    seasonStatus: undefined,
    participants: undefined,
  } as unknown as typeof team;
  const minimalEvent = {
    ...agendaEvent,
    id: "event-b",
    orgId: "org-b",
    teams: undefined,
    participants: undefined,
    location: null,
    status: undefined,
    scheduleVersion: undefined,
  } as unknown as typeof agendaEvent;
  await saveCachedAgenda("user-a", {
    items: [minimalEvent, { ...minimalEvent, id: "", startsAt: "not-a-date" }],
    teams: [minimalTeam, { ...minimalTeam, id: "" }],
    accessVersion: "",
    nextCursor: null,
    setupRequired: true,
  }, now);

  expect([...mockStorage.keys()].some((key) => key.includes("org-a"))).toBe(false);
  const restored = await loadCachedAgenda("user-a", now);
  expect(restored?.value.items).toHaveLength(1);
  expect(restored?.value.items[0].location).toBeNull();
  expect(restored?.value.teams[0].seasonStatus).toBe("archived");
  expect(restored?.value.teams[0].participants).toEqual([]);
  expect(restored?.value.setupRequired).toBe(true);
});

test("rejects malformed envelopes and invalid cached event shapes", async () => {
  expect(await loadCachedAgenda("missing-user", now)).toBeNull();
  await clearGameDayCache("missing-user");

  await saveCachedTeamSchedule("user-a", "team-a", "past", {
    items: [
      {
        ...event,
        id: "legacy",
        schemaVersion: undefined,
        startsAt: undefined,
        endsAt: undefined,
        timeZone: undefined,
        status: undefined,
        scheduleVersion: undefined,
        revision: undefined,
        time: "",
        location: null,
        teams: undefined,
      },
      { ...event, id: "bad-type", type: "meeting" },
      { ...event, id: "bad-window", startsAt: "invalid", date: "invalid" },
      { ...event, id: "missing-team", teamId: "" },
    ] as any,
    nextCursor: null,
  }, now);
  const legacy = await loadCachedTeamSchedule("user-a", "team-a", "past", now);
  expect(legacy?.value.items).toHaveLength(1);
  expect(legacy?.value.items[0].time).toBe("00:00");
  expect(legacy?.value.items[0].schemaVersion).toBeUndefined();

  const scheduleStorageKey = [...mockStorage.keys()].find((key) => key.endsWith("/schedule/past"))!;
  mockStorage.set(scheduleStorageKey, "not-json");
  expect(await loadCachedTeamSchedule("user-a", "team-a", "past", now)).toBeNull();
  expect(mockStorage.has(scheduleStorageKey)).toBe(false);

  await saveCachedEvent("user-a", "team-a", event, now);
  const eventStorageKey = [...mockStorage.keys()].find((key) => key.includes("/event/event-a"))!;
  const envelope = JSON.parse(mockStorage.get(eventStorageKey)!);
  envelope.value.type = "meeting";
  mockStorage.set(eventStorageKey, JSON.stringify(envelope));
  expect(await loadCachedEvent("user-a", "team-a", "event-a", now)).toBeNull();

  mockStorage.set(eventStorageKey, JSON.stringify({ schema: 99, savedAt: "bad", value: event }));
  expect(await loadCachedEvent("user-a", "team-a", "event-a", now)).toBeNull();
  await saveCachedEvent("user-a", "team-a", { ...event, startsAt: "2027-01-01T00:00:00.000Z" }, now);
});

