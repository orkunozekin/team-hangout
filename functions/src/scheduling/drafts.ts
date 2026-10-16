import { publishedEvent } from "./visibility";
import { publicationError } from "./lease";
import { getFirestore, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  object,
  revision,
  text,
} from "../commandSupport";
import { readCommand, metadata } from "../participants/policy";
import {
  checkRevision,
  denied,
  eventScope,
  hierarchy,
  requireProgram,
  staffScope,
} from "../operations/access";
import { cacheDocumentReads } from "../operations/reads";
import { fingerprint } from "../operations/requests";
import { audit } from "../organizations/commands";
import { instant } from "../facilities/service";
import { calendarDate } from "../recurrence/generator";
import { checkInput } from "./input";
import { generatePairings } from "./pairings";
import { assignSchedule } from "./search";
import { validateSchedule } from "./validator";
import { Assignment, ScheduleInput } from "./model";
import type { DraftFields } from "./model";
const db = () => getFirestore();
const ref = (d: Data) =>
  db().doc(`organizations/${d.orgId}/scheduleDrafts/${d.draftId}`);
function bounded(n: number, max: number, label: string) {
  if (n > max)
    throw new HttpsError(
      "resource-exhausted",
      `${label} exceed ${max}. Narrow the input; nothing was truncated.`,
    );
}
function opaque(value: unknown, field: string) {
  const v = id(value, field);
  if (v.length > 80) invalid(`${field} exceeds 80 characters.`);
  return v;
}
function span(value: unknown) {
  const v = object(value);
  keys(v, ["startsAt", "endsAt"]);
  const startsAt = instant(v.startsAt, "start"),
    endsAt = instant(v.endsAt, "end");
  if (endsAt <= startsAt) invalid("End must follow start.");
  return { startsAt, endsAt };
}
function integer(value: unknown, min: number, max: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    invalid(`${label} must be ${min} through ${max}.`);
  return Number(value);
}
function fields(value: unknown): DraftFields {
  const v = object(value);
  keys(v, [
    "title",
    "startsAt",
    "endsAt",
    "durationMinutes",
    "minimumRestMinutes",
    "repetitions",
    "seed",
    "slots",
    "teamConstraints",
  ]);
  if (!Array.isArray(v.slots) || !Array.isArray(v.teamConstraints))
    invalid("Supply slots and team constraints.");
  bounded(v.slots.length, 1000, "Slots");
  bounded(v.teamConstraints.length, 32, "Team constraints");
  const range = span({ startsAt: v.startsAt, endsAt: v.endsAt });
  if (Date.parse(range.endsAt) - Date.parse(range.startsAt) > 16 * 7 * 86400000)
    invalid("The range exceeds 16 elapsed weeks.");
  const slots = v.slots.map((item: unknown) => {
    const s = object(item);
    keys(s, ["id", "facilityId", "resourceId", "startsAt", "endsAt", "late"]);
    if (typeof s.late !== "boolean")
      invalid("Declare early or late for every slot.");
    return {
      id: opaque(s.id, "slotId"),
      facilityId: id(s.facilityId, "facilityId"),
      resourceId: id(s.resourceId, "resourceId"),
      ...span({ startsAt: s.startsAt, endsAt: s.endsAt }),
      late: s.late,
    };
  });
  if (new Set(slots.map((s: Data) => s.id)).size !== slots.length)
    invalid("Duplicate slot IDs.");
  const teamConstraints = v.teamConstraints.map((item: unknown) => {
    const t = object(item);
    keys(t, ["teamId", "blackouts", "preferredSlotIds"]);
    if (!Array.isArray(t.blackouts) || !Array.isArray(t.preferredSlotIds))
      invalid("Supply blackout and preference arrays.");
    bounded(t.blackouts.length, 128, "Blackouts");
    bounded(t.preferredSlotIds.length, 1000, "Preferences");
    const preferredSlotIds = t.preferredSlotIds.map((s: unknown) =>
      opaque(s, "preferred slot"),
    );
    if (
      new Set(preferredSlotIds).size !== preferredSlotIds.length ||
      preferredSlotIds.some(
        (s: string) => !slots.some((slot: Data) => slot.id === s),
      )
    )
      invalid("Unknown or duplicate preferred slot.");
    return {
      teamId: id(t.teamId, "teamId"),
      blackouts: t.blackouts.map(span),
      preferredSlotIds,
    };
  });
  if (
    new Set(teamConstraints.map((t: Data) => t.teamId)).size !==
    teamConstraints.length
  )
    invalid("Duplicate team constraints.");
  return {
    title: text(v.title, "title"),
    ...range,
    durationMinutes: integer(v.durationMinutes, 1, 1440, "Duration"),
    minimumRestMinutes: integer(v.minimumRestMinutes, 0, 10080, "Rest"),
    repetitions: integer(v.repetitions, 1, 2, "Repetitions"),
    seed: integer(v.seed, 0, 0xffffffff, "Seed"),
    slots,
    teamConstraints,
  };
}
const identity = (d: Data) => ({
  orgId: id(d.orgId, "orgId"),
  draftId: opaque(d.draftId, "draftId"),
});
const edit = (d: Data) => ({
  ...identity(d),
  expectedRevision: revision(d.expectedRevision),
});
export async function draftScope(tx: Transaction, d: Data, uid: string) {
  const staff = await staffScope(tx, d.orgId, uid);
  if (
    staff.organization.features?.organizationV2 !== true ||
    staff.organization.features?.adminWorkspace !== true ||
    staff.organization.features?.scheduler !== true
  )
    denied();
  const division = (
    await tx.get(db().doc(`organizations/${d.orgId}/divisions/${d.divisionId}`))
  ).data();
  if (!division || division.schemaVersion !== 2 || division.orgId !== d.orgId)
    denied();
  requireProgram(staff, division.programId);
  const h = await hierarchy(
    tx,
    d.orgId,
    division.programId,
    division.seasonId,
    d.divisionId,
  );
  const rows = await tx.get(
    db()
      .collection("teams")
      .where("orgId", "==", d.orgId)
      .where("divisionId", "==", d.divisionId)
      .where("status", "==", "active")
      .limit(33),
  );
  bounded(rows.size, 32, "Active division teams");
  const teams = rows.docs.sort((a, b) => a.id.localeCompare(b.id));
  for (let n = 0; n < teams.length; n += 20) {
    const live = await eventScope(
      tx,
      teams.slice(n, n + 20).map((t) => t.id),
      uid,
    );
    if (
      live.orgId !== d.orgId ||
      live.programId !== division.programId ||
      live.seasonId !== division.seasonId
    )
      denied();
  }
  if (teams.some((t) => t.data().divisionId !== d.divisionId)) denied();
  return { ...h, teams };
}
export async function storedDraft(tx: Transaction, d: Data, uid: string) {
  const row = (await tx.get(ref(d))).data();
  if (
    !row ||
    row.schemaVersion !== 2 ||
    row.orgId !== d.orgId ||
    row.state !== "privateDraft"
  )
    denied();
  await draftScope(tx, { ...d, divisionId: row.divisionId }, uid);
  return row!;
}
function safe(d: Data, row: Data) {
  return {
    draftId: d.draftId,
    publicationOperationId: row.publicationOperationId ?? null,
    divisionId: row.divisionId,
    revision: row.revision,
    state: row.state,
    fields: row.fields,
    assignments: row.assignments,
    fixtures: row.fixtures,
    teams: row.teams,
    validation: row.validation,
    validationRevision: row.validationRevision,
    inputHash: row.inputHash,
    search: row.search,
    timeZone: row.timeZone,
  };
}
export async function draftSnapshot(
  tx: Transaction,
  d: Data,
  uid: string,
  authorized?: Awaited<ReturnType<typeof draftScope>>,
) {
  tx = cacheDocumentReads(tx);
  let count = 0;
  const query = async (q: FirebaseFirestore.Query) => {
    const r = await tx.get(q);
    count += r.size;
    bounded(count, 5000, "Snapshot query documents");
    return r;
  };
  const s = authorized || (await draftScope(tx, d, uid)),
    f = d.fields as DraftFields;
  const zone = s.season.timeZone || s.org.timeZone;
  const availabilityStart = new Date(
      Date.parse(f.startsAt) - 1440 * 60000,
    ).toISOString(),
    availabilityEnd = new Date(
      Date.parse(f.endsAt) + 1440 * 60000,
    ).toISOString();
  if (!zone) invalid("Set an organization timezone before scheduling.");
  try {
    calendarDate(s.season.startsOn);
    calendarDate(s.season.endsOn);
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    invalid(
      "Set valid canonical season dates and an IANA timezone before scheduling.",
    );
  }
  const localDate = (v: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(v));
  if (
    !s.season.startsOn ||
    !s.season.endsOn ||
    localDate(f.startsAt) < s.season.startsOn ||
    localDate(new Date(Date.parse(f.endsAt) - 1).toISOString()) >
      s.season.endsOn
  )
    invalid(
      "The range must fit explicit season dates in the canonical timezone.",
    );
  const teamIds = s.teams.map((t) => t.id);
  const internalTeamIds = new Map(
    teamIds.map((teamId) => [teamId, fingerprint({ teamId })]),
  );
  const canonicalTeamIds = new Map(
    [...internalTeamIds].map(([canonical, internal]) => [internal, canonical]),
  );
  if (f.teamConstraints.some((t) => !teamIds.includes(t.teamId)))
    invalid("A constraint references a team outside the active division.");
  const coaches = await query(
    db()
      .collection("teamMembers")
      .where("orgId", "==", d.orgId)
      .where("status", "==", "active")
      .limit(1001),
  );
  bounded(coaches.size, 1000, "Current organization staff assignments");
  // Never read another tenant. Opaque actors stay transient and never enter persisted draft/receipt payloads.
  const coachMap = new Map<string, string[]>();
  for (const doc of coaches.docs) {
    const c = doc.data();
    if (
      doc.id !== `${c.teamId}_${c.userId}` ||
      c.schemaVersion !== 2 ||
      c.orgId !== d.orgId ||
      !Array.isArray(c.roles) ||
      !c.roles.includes("coach")
    )
      continue;
    const values = coachMap.get(c.teamId) || [];
    values.push(fingerprint({ uid: c.userId }));
    coachMap.set(c.teamId, [...new Set(values)].sort());
  }
  const bindings: unknown[] = [
    s.org,
    s.program,
    s.season,
    s.division,
    s.teams.map((t) => [t.id, t.data()]),
    coaches.docs.map((t) => [t.id, t.data()]),
  ];
  const closures = await query(
    db().collection(`organizations/${d.orgId}/closures`).limit(1001),
  );
  bounded(closures.size, 1000, "Closures");
  bindings.push(closures.docs.map((t) => [t.id, t.data()]));
  const availabilityRecords = new Map<string, Data[]>();
  const resources: ScheduleInput["resources"] = [],
    resourceMap = new Map<string, string>();
  for (const slot of f.slots) {
    const key = `${slot.facilityId}/${slot.resourceId}`;
    if (resourceMap.has(key)) continue;
    bounded(resourceMap.size + 1, 32, "Resources");
    const resourceId = fingerprint({ key }),
      path = `organizations/${d.orgId}/facilities/${key.split("/")[0]}/resources/${key.split("/")[1]}`;
    const [facility, resource] = await tx.getAll(
      db().doc(`organizations/${d.orgId}/facilities/${slot.facilityId}`),
      db().doc(path),
    );
    const a = facility.data(),
      r = resource.data();
    if (
      !a ||
      !r ||
      a.schemaVersion !== 2 ||
      r.schemaVersion !== 2 ||
      a.orgId !== d.orgId ||
      r.orgId !== d.orgId ||
      r.facilityId !== slot.facilityId
    )
      denied();
    const revisions = await query(
      db()
        .collection(`${path}/availability`)
        .where("effectiveFrom", "<", availabilityEnd)
        .orderBy("effectiveFrom")
        .limit(129),
    );
    bounded(revisions.size, 128, "Availability revisions");
    availabilityRecords.set(
      key,
      revisions.docs.map((row) => row.data()),
    );
    bindings.push(
      a,
      r,
      revisions.docs.map((t) => [t.id, t.data()]),
    );
    const availability: { startsAt: string; endsAt: string }[] = [];
    for (let n = 0; n < revisions.size; n++) {
      const r = revisions.docs[n].data(),
        end = revisions.docs[n + 1]?.data().effectiveFrom || availabilityEnd;
      if (!Array.isArray(r.windows))
        invalid("Resource availability needs correction.");
      for (const w of r.windows) {
        const start = [w.startsAt, r.effectiveFrom, availabilityStart]
            .sort()
            .at(-1)!,
          finish = [w.endsAt, end, availabilityEnd].sort()[0];
        if (start < finish)
          availability.push({ startsAt: start, endsAt: finish });
      }
    }
    const availabilityBoundaries = revisions.docs
      .slice(1)
      .map((r) => r.data().effectiveFrom as string);
    resources.push({
      id: resourceId,
      active: a.status === "active" && r.status === "active",
      sports: r.sports,
      setupMinutes: r.setupMinutes,
      cleanupMinutes: r.cleanupMinutes,
      availability,
      closures: closures.docs.flatMap((doc) => {
        const c = doc.data();
        return c.status !== "cancelled" &&
          Array.isArray(c.resourceIds) &&
          c.resourceIds.includes(slot.resourceId)
          ? [
              {
                startsAt: c.startsAt?.toDate
                  ? c.startsAt.toDate().toISOString()
                  : c.startsAt,
                endsAt: c.endsAt?.toDate
                  ? c.endsAt.toDate().toISOString()
                  : c.endsAt,
              },
            ]
          : [];
      }),
      availabilityBoundaries,
    });
    resourceMap.set(key, resourceId);
  }
  // Read the finite tenant snapshot once. Overflow is explicit; a partial occupancy view is never accepted.
  const events = await query(
    db().collection("events").where("orgId", "==", d.orgId).limit(1001),
  );
  bounded(events.size, 1000, "Current event snapshot");
  const busy: ScheduleInput["busy"] = [];
  for (const doc of events.docs) {
    const e = doc.data();
    if (
      (d.excludeOperationId &&
        e.publicationOperationId === d.excludeOperationId) ||
      e.deletedAt != null ||
      !["scheduled", "completed"].includes(e.status) ||
      e.publicationState !== "published" ||
      (e.publicationOperationId != null && !(await publishedEvent(tx, e)))
    )
      continue;
    if (
      e.schemaVersion !== 2 ||
      !e.startsAt?.toDate ||
      !e.endsAt?.toDate ||
      !Array.isArray(e.teamIds)
    )
      invalid("Current occupancy needs canonical correction.");
    if (
      e.endsAt.toMillis() <=
        Date.parse(f.startsAt) - (f.minimumRestMinutes + 1440) * 60000 ||
      e.startsAt.toMillis() >=
        Date.parse(f.endsAt) + (f.minimumRestMinutes + 1440) * 60000
    )
      continue;
    bindings.push([
      doc.id,
      e.revision ?? null,
      e.scheduleVersion ?? null,
      e.publicationOperationId ?? null,
    ]);
    const actorIds = [
      ...new Set<string>(
        e.teamIds.flatMap((t: string) => coachMap.get(t) || []),
      ),
    ];
    busy.push({
      startsAt: e.startsAt.toDate().toISOString(),
      endsAt: e.endsAt.toDate().toISOString(),
      teamIds: e.teamIds
        .filter((t: string) => teamIds.includes(t))
        .map((t: string) => internalTeamIds.get(t)!),
      coachIds: actorIds,
      resourceId: resourceMap.get(`${e.facilityId}/${e.resourceId}`) || null,
      setupMinutes: e.resourceOccupancy?.setupMinutes ?? 0,
      cleanupMinutes: e.resourceOccupancy?.cleanupMinutes ?? 0,
    });
  }
  const input: ScheduleInput = {
    teams: s.teams.map((t) => ({
      id: internalTeamIds.get(t.id)!,
      coachIds: coachMap.get(t.id) || [],
      blackouts:
        f.teamConstraints.find((c) => c.teamId === t.id)?.blackouts || [],
      preferredSlotIds:
        f.teamConstraints.find((c) => c.teamId === t.id)?.preferredSlotIds ||
        [],
    })),
    resources,
    slots: f.slots.map((slot) => ({
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      late: slot.late,
      resourceId: resourceMap.get(`${slot.facilityId}/${slot.resourceId}`)!,
    })),
    busy,
    season: { startsAt: f.startsAt, endsAt: f.endsAt },
    timeZone: zone,
    sport: s.program.sportCode,
    durationMinutes: f.durationMinutes,
    minimumRestMinutes: f.minimumRestMinutes,
    repetitions: f.repetitions,
    seed: f.seed,
    crossOrganizationBusy: "notChecked",
  };
  try {
    checkInput(input);
  } catch (e) {
    invalid(e instanceof Error ? e.message : "Invalid bounded snapshot.");
  }
  return {
    input,
    inputHash: fingerprint({ input, bindings }),
    availabilityRecords,
    eventDocumentCount: events.size,
    timeZone: zone,
    teams: s.teams.map((t) => ({ id: t.id, name: t.data().name })),
    canonicalTeamIds,
    fixtures: generatePairings(
      [...internalTeamIds.values()],
      f.repetitions,
    ).fixtures.map((fixture) => ({
      ...fixture,
      homeTeamId: canonicalTeamIds.get(fixture.homeTeamId)!,
      awayTeamId: canonicalTeamIds.get(fixture.awayTeamId)!,
    })),
  };
}
function publicValidation(
  current: Awaited<ReturnType<typeof draftSnapshot>>,
  validation: import("./model").Validation,
) {
  return {
    ...validation,
    teams: validation.teams.map((team) => ({
      ...team,
      teamId: current.canonicalTeamIds.get(team.teamId)!,
    })),
  };
}
function persist(
  tx: Transaction,
  d: Data,
  uid: string,
  before: Data | undefined,
  value: Data,
) {
  if (before?.publicationOperationId)
    publicationError(
      "ALREADY_PUBLISHING",
      "This draft has a publication. Create a new draft to schedule another batch.",
    );
  const row: Data = {
    ...value,
    orgId: d.orgId,
    ...metadata(uid, before),
    state: "privateDraft",
    auditCorrelationId: d.draftId,
  };
  if (Buffer.byteLength(JSON.stringify(row), "utf8") > 800000)
    throw new HttpsError(
      "resource-exhausted",
      "Draft exceeds the safe 800 KB record budget. Narrow slots or constraints; nothing was truncated.",
    );
  tx.set(ref(d), row);
  tx.create(ref(d).collection("revisions").doc(String(row.revision)), row);
  audit(tx, d.orgId, uid, "scheduleDraft", d.draftId, row.revision);
  return safe(d, row);
}
export const generateScheduleDraft = command(
  "generateScheduleDraft",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "draftId",
      "divisionId",
      "expectedRevision",
      "fields",
    ]);
    return {
      ...edit(d),
      divisionId: id(d.divisionId, "divisionId"),
      fields: fields(d.fields),
    };
  },
  async (tx, d, uid, _actor, replay) => {
    tx = cacheDocumentReads(tx);
    const authorized = await draftScope(tx, d, uid);
    if (replay) return replay;
    const before = (await tx.get(ref(d))).data();
    if (before && before.divisionId !== d.divisionId) denied();
    checkRevision(before, d.expectedRevision);
    const current = await draftSnapshot(tx, d, uid, authorized),
      result = assignSchedule(current.input);
    const { assignments, validation, ...search } = result;
    return persist(tx, d, uid, before, {
      divisionId: d.divisionId,
      fields: d.fields,
      assignments,
      fixtures: current.fixtures,
      teams: current.teams,
      timeZone: current.timeZone,
      validation: publicValidation(current, validation),
      validationRevision: (before?.revision ?? 0) + 1,
      inputHash: current.inputHash,
      search,
    });
  },
);
export const saveScheduleDraft = command(
  "saveScheduleDraft",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "draftId",
      "expectedRevision",
      "fields",
      "assignments",
    ]);
    if (!Array.isArray(d.assignments)) invalid("Supply assignments.");
    bounded(d.assignments.length, 1000, "Assignments");
    const assignments = d.assignments.map((v: unknown) => {
      const a = object(v);
      keys(a, ["fixtureId", "slotId"]);
      return {
        fixtureId: text(a.fixtureId, "fixtureId", 180),
        slotId: opaque(a.slotId, "slotId"),
      };
    });
    return { ...edit(d), fields: fields(d.fields), assignments };
  },
  async (tx, d, uid, _actor, replay) => {
    tx = cacheDocumentReads(tx);
    const before = await storedDraft(tx, d, uid);
    if (replay) return replay;
    checkRevision(before, d.expectedRevision);
    // New constraints must also reference authoritative current inputs, even though validation is intentionally dirty.
    const current = await draftSnapshot(
      tx,
      { ...d, divisionId: before.divisionId },
      uid,
    );
    if (
      d.assignments.some(
        (a: Assignment) =>
          !current.fixtures.some((f) => f.id === a.fixtureId) ||
          !d.fields.slots.some((s: Data) => s.id === a.slotId),
      ) ||
      new Set(d.assignments.map((a: Assignment) => a.fixtureId)).size !==
        d.assignments.length
    )
      invalid(
        "Unknown or duplicate assignment. Remove obsolete assignments before saving.",
      );
    return persist(tx, d, uid, before, {
      divisionId: before.divisionId,
      fields: d.fields,
      assignments: d.assignments,
      fixtures: current.fixtures,
      teams: current.teams,
      timeZone: current.timeZone,
      validation: null,
      validationRevision: null,
      inputHash: null,
      search: null,
    });
  },
);
export const validateScheduleDraft = command(
  "validateScheduleDraft",
  (d) => {
    keys(d, ["requestId", "orgId", "draftId", "expectedRevision"]);
    return edit(d);
  },
  async (tx, d, uid, _actor, replay) => {
    tx = cacheDocumentReads(tx);
    const before = await storedDraft(tx, d, uid);
    if (replay) return replay;
    checkRevision(before, d.expectedRevision);
    const current = await draftSnapshot(
      tx,
      { ...d, divisionId: before.divisionId, fields: before.fields },
      uid,
    );
    return persist(tx, d, uid, before, {
      divisionId: before.divisionId,
      fields: before.fields,
      assignments: before.assignments,
      fixtures: current.fixtures,
      teams: current.teams,
      timeZone: current.timeZone,
      validation: publicValidation(
        current,
        validateSchedule(current.input, before.assignments),
      ),
      validationRevision: before.revision + 1,
      inputHash: current.inputHash,
      search: before.search,
    });
  },
);
export const getScheduleDraft = readCommand(
  (d) => {
    keys(d, ["orgId", "draftId"]);
    return identity(d);
  },
  async (tx, d, uid) =>
    safe(d, await storedDraft(cacheDocumentReads(tx), d, uid)),
);
