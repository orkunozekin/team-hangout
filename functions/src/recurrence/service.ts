import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
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
  requireProgram,
  staffScope,
} from "../operations/access";
import { cacheDocumentReads } from "../operations/reads";
import { fingerprint } from "../operations/requests";
import { audit } from "../organizations/commands";
import { overlaps } from "../facilities/intervals";
import { validateResourceAssignment } from "../facilities/service";
import { calendarDate, generateOccurrences, SeriesFields } from "./generator";
function normalize(data: Data) {
  const fields = object(data.fields);
  keys(fields, [
    "title",
    "startsOn",
    "endsOn",
    "weekdays",
    "localTime",
    "timeZone",
    "durationMinutes",
    "exclusions",
    "offsets",
    "facilityId",
    "resourceId",
  ]);
  if (
    !Array.isArray(fields.weekdays) ||
    fields.weekdays.length > 7 ||
    new Set(fields.weekdays).size !== fields.weekdays.length ||
    !Array.isArray(fields.exclusions) ||
    fields.exclusions.length > 64
  )
    invalid("Choose bounded weekdays and exclusions.");
  const offsets = object(fields.offsets);
  if (
    Object.keys(offsets).length > 64 ||
    Object.values(offsets).some(
      (n) => !Number.isInteger(n) || Math.abs(Number(n)) > 840,
    )
  )
    invalid("Invalid UTC offset choices.");
  const normalized: SeriesFields = {
    title: text(fields.title, "title"),
    startsOn: text(fields.startsOn, "startsOn", 10),
    endsOn: text(fields.endsOn, "endsOn", 10),
    weekdays: [...fields.weekdays].sort(),
    localTime: text(fields.localTime, "localTime", 5),
    timeZone: text(fields.timeZone, "timeZone", 100),
    durationMinutes: fields.durationMinutes,
    exclusions: [...fields.exclusions].sort(),
    offsets,
    facilityId:
      fields.facilityId == null ? null : id(fields.facilityId, "facilityId"),
    resourceId:
      fields.resourceId == null ? null : id(fields.resourceId, "resourceId"),
  };
  if (!!normalized.facilityId !== !!normalized.resourceId)
    invalid("Choose both facility and resource, or neither.");
  if (id(data.seriesId, "seriesId").length > 100)
    invalid("Series IDs must be at most 100 characters.");
  const result = {
    orgId: id(data.orgId, "orgId"),
    teamId: id(data.teamId, "teamId"),
    seriesId: id(data.seriesId, "seriesId"),
    expectedRevision: revision(data.expectedRevision),
    fields: normalized,
  };
  try {
    generateOccurrences(result.seriesId, normalized);
  } catch (e) {
    invalid(e instanceof Error ? e.message : "Invalid recurrence.");
  }
  return result;
}
const ref = (data: Data) =>
  getFirestore().doc(
    `organizations/${data.orgId}/scheduleSeries/${data.seriesId}`,
  );
async function access(tx: Transaction, data: Data, uid: string) {
  const staff = await staffScope(tx, data.orgId, uid);
  if (
    staff.organization.features?.organizationV2 !== true ||
    staff.organization.features?.adminWorkspace !== true
  )
    denied();
  const scope = await eventScope(tx, [data.teamId], uid);
  if (scope.orgId !== data.orgId) denied();
  requireProgram(staff, scope.programId);
  return scope;
}
async function preview(tx: Transaction, data: Data, uid: string) {
  const cached = cacheDocumentReads(tx);
  let queryDocuments = 0;
  tx = new Proxy(cached, {
    get(target, name) {
      if (name === "get")
        return async (reference: any) => {
          const result = await target.get(reference);
          if ("size" in result) queryDocuments += result.size;
          if (queryDocuments > 1000)
            throw new HttpsError(
              "resource-exhausted",
              "This preview exceeds 1,000 query documents. Narrow the range before reviewing.",
            );
          return result;
        };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scope = await access(tx, data, uid);
  const before = (await tx.get(ref(data))).data();
  if (
    before &&
    (before.orgId !== data.orgId ||
      before.teamId !== data.teamId ||
      before.schemaVersion !== 2)
  )
    denied();
  checkRevision(before, data.expectedRevision);
  const season = (
    await tx.get(
      getFirestore().doc(
        `organizations/${data.orgId}/seasons/${scope.seasonId}`,
      ),
    )
  ).data()!;
  try {
    calendarDate(season.startsOn);
    calendarDate(season.endsOn);
  } catch {
    invalid("Set explicit season dates before reviewing recurrence.");
  }
  if (
    data.fields.startsOn < season.startsOn ||
    data.fields.endsOn > season.endsOn
  )
    invalid("The reviewed range must be within the season dates.");
  const occurrences = generateOccurrences(
    fingerprint({ orgId: data.orgId, seriesId: data.seriesId }),
    data.fields,
  );
  if (!occurrences.length)
    invalid("The range must include at least one occurrence.");
  const diagnostics: Data[] = [];
  const resources: Data[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.issue || !data.fields.resourceId) continue;
    try {
      const assignment = await validateResourceAssignment(
        tx,
        {
          ...data.fields,
          orgId: data.orgId,
          startsAt: Timestamp.fromDate(new Date(occurrence.startsAt!)),
          endsAt: Timestamp.fromDate(new Date(occurrence.endsAt!)),
        },
        occurrence.id,
        scope.teams.map((team) => team.sport),
      );
      const { resourceFence: _fence, ...snapshot } = assignment;
      resources.push({ occurrenceId: occurrence.id, ...snapshot });
    } catch (e) {
      if (
        !(e instanceof HttpsError) ||
        (e.details as Data | undefined)?.domainCode !== "SCHEDULE_CONFLICT"
      )
        throw e;
      diagnostics.push({ occurrenceId: occurrence.id, message: e.message });
    }
  }
  for (let i = 0; i < occurrences.length; i++)
    for (let j = i + 1; j < occurrences.length; j++) {
      const a = occurrences[i],
        b = occurrences[j];
      if (
        a.startsAt &&
        a.endsAt &&
        b.startsAt &&
        b.endsAt &&
        overlaps(
          { startsAt: a.startsAt, endsAt: a.endsAt },
          { startsAt: b.startsAt, endsAt: b.endsAt },
        )
      )
        diagnostics.push({
          occurrenceId: b.id,
          message: "Overlaps another practice in this draft.",
        });
      const ar = resources.find(
          (r) => r.occurrenceId === a.id,
        )?.resourceOccupancy,
        br = resources.find((r) => r.occurrenceId === b.id)?.resourceOccupancy;
      if (
        ar &&
        br &&
        overlaps(
          {
            startsAt: ar.startsAt.toDate().toISOString(),
            endsAt: ar.endsAt.toDate().toISOString(),
          },
          {
            startsAt: br.startsAt.toDate().toISOString(),
            endsAt: br.endsAt.toDate().toISOString(),
          },
        )
      )
        diagnostics.push({
          occurrenceId: b.id,
          message:
            "Setup or cleanup overlaps another occurrence in this draft.",
        });
    }
  const summary = { occurrences, diagnostics, resourceSnapshots: resources };
  const previewHash = fingerprint({
    ...data,
    ...summary,
    seasonRevision: season.revision,
  });
  return { scope, before, ...summary, previewHash };
}
export const previewRecurrenceDraft = readCommand(
  (data) => {
    keys(data, ["orgId", "teamId", "seriesId", "expectedRevision", "fields"]);
    return normalize(data);
  },
  async (tx, data, uid) => {
    const {
      scope: _scope,
      before: _before,
      resourceSnapshots: _resources,
      ...result
    } = await preview(tx, data, uid);
    return result;
  },
);
export const saveRecurrenceDraft = command(
  "saveRecurrenceDraft",
  (data) => {
    keys(data, [
      "requestId",
      "orgId",
      "teamId",
      "seriesId",
      "expectedRevision",
      "fields",
      "previewHash",
      "reviewed",
    ]);
    if (data.reviewed !== true)
      invalid("Explicitly review the finite range and every occurrence.");
    return {
      ...normalize(data),
      previewHash: text(data.previewHash, "previewHash", 64),
      reviewed: true,
    };
  },
  async (tx, data, uid, _actor, replay) => {
    // Even successful receipt replay rechecks current tenant, team, hierarchy and rollout access.
    await access(tx, data, uid);
    if (replay) return replay;
    const { previewHash: _hash, reviewed: _reviewed, ...input } = data;
    const result = await preview(tx, input, uid);
    if (result.previewHash !== data.previewHash)
      throw new HttpsError(
        "failed-precondition",
        "The preview changed. Review it again.",
        { domainCode: "STALE_PREVIEW" },
      );
    if (result.occurrences.some((o) => o.issue))
      invalid(
        "Correct nonexistent times and select repeated-time offsets before saving.",
      );
    const row: Data = {
      ...input,
      ...metadata(uid, result.before),
      programId: result.scope.programId,
      seasonId: result.scope.seasonId,
      divisionId: result.scope.teams[0].divisionId,
      state: "reviewedDraft",
      occurrences: result.occurrences,
      diagnostics: result.diagnostics,
      resourceSnapshots: result.resourceSnapshots,
      previewHash: result.previewHash,
      reviewedBy: uid,
      reviewedAt: Timestamp.now(),
      auditCorrelationId: data.seriesId,
    };
    tx.set(ref(data), row);
    tx.create(ref(data).collection("revisions").doc(String(row.revision)), row);
    audit(
      tx,
      data.orgId,
      uid,
      "saveRecurrenceDraft",
      data.seriesId,
      row.revision,
    );
    return {
      seriesId: data.seriesId,
      revision: row.revision,
      occurrences: result.occurrences,
      diagnostics: result.diagnostics,
    };
  },
);
export const getRecurrenceDraft = readCommand(
  (data) => {
    keys(data, ["orgId", "seriesId"]);
    return {
      orgId: id(data.orgId, "orgId"),
      seriesId: id(data.seriesId, "seriesId"),
    };
  },
  async (tx, data, uid) => {
    const row = (await tx.get(ref(data))).data();
    if (!row || row.orgId !== data.orgId || row.schemaVersion !== 2) denied();
    await access(tx, { ...data, teamId: row!.teamId }, uid);
    return {
      seriesId: data.seriesId,
      teamId: row!.teamId,
      revision: row!.revision,
      fields: row!.fields,
      occurrences: row!.occurrences,
      diagnostics: row!.diagnostics,
      state: row!.state,
    };
  },
);
