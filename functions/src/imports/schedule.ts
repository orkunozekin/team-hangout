import { createHash } from "node:crypto";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { Data, invalid } from "../commandSupport";
import { hierarchy } from "../organizations/policy";
import { metadata } from "../participants/policy";
import { scheduleColumns } from "./scheduleColumns";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const rowRef = (job: Data, number: number) =>
  getFirestore().doc(
    `importJobs/${job.id}/rows/${String(number).padStart(5, "0")}`,
  );
const identityKey = (job: Data, external: string, number: number) =>
  hash(
    JSON.stringify([
      job.orgId,
      job.programId,
      job.seasonId,
      "schedule",
      external || [job.id, number],
    ]),
  );
/** Enumerate real zone offsets and round-trip. An explicit offset must select a real candidate. */
export function scheduleInstant(
  date: string,
  time: string,
  zone: string,
  offset = "",
): Timestamp {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    invalid("Use YYYY-MM-DD and HH:mm local time.");
  const local = Date.parse(`${date}T${time}:00.000Z`);
  if (
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 10) !== date
  )
    invalid("Invalid local date.");
  if (zone !== "UTC" && !zone.includes("/")) invalid("Use an IANA timeZone.");
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    invalid("Invalid timeZone.");
  }
  const parts = (ms: number) =>
    Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
  const candidates = new Map<number, number>();
  for (let hour = -48; hour <= 48; hour++) {
    const probe = local + hour * 3600000,
      p = parts(probe);
    const delta =
      Date.parse(
        `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`,
      ) - probe;
    const instant = local - delta,
      r = parts(instant);
    if (
      `${r.year}-${r.month}-${r.day} ${r.hour}:${r.minute}` ===
      `${date} ${time}`
    )
      candidates.set(instant, delta / 60000);
  }
  if (offset) {
    if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(offset))
      invalid("Offset must be signed HH:mm.");
    const minutes =
      (offset[0] === "-" ? -1 : 1) *
      (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4)));
    for (const [instant, delta] of candidates)
      if (delta === minutes) return Timestamp.fromMillis(instant);
    invalid("Offset does not match this local time and timeZone.");
  }
  if (candidates.size !== 1)
    invalid(
      candidates.size
        ? "Ambiguous local time (DST fold). Supply a validated startOffset/endOffset."
        : "Nonexistent local time (DST gap).",
    );
  return Timestamp.fromMillis([...candidates.keys()][0]);
}
function instants(fields: Data) {
  const startsAt = scheduleInstant(
    fields.localDate,
    fields.localStartTime,
    fields.timeZone,
    fields.startOffset,
  );
  const endsAt = scheduleInstant(
    fields.localDate,
    fields.localEndTime,
    fields.timeZone,
    fields.endOffset,
  );
  if (endsAt.toMillis() <= startsAt.toMillis())
    invalid("End time must follow start time on the same local date.");
  return { startsAt, endsAt };
}
export async function previewScheduleRow(
  tx: Transaction,
  job: Data,
  raw: string[],
  header: string[],
  duplicates: Set<string>,
  number: number,
  overlaps = new Set<number>(),
) {
  const fields: Data = Object.fromEntries(
    scheduleColumns.map((k) => [
      k,
      job.mapping[k] ? raw[header.indexOf(job.mapping[k])].trim() : "",
    ]),
  );
  const errors: string[] = [],
    warnings: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const max =
      k === "notes"
        ? 5000
        : k === "address"
          ? 500
          : ["title", "locationName"].includes(k)
            ? 200
            : 128;
    if (
      v.length > max ||
      (/^[\s]*[=+@-]/.test(v) && !["startOffset", "endOffset"].includes(k)) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    )
      errors.push(`Invalid or formula-like ${k}; maximum ${max} characters.`);
    if (v.length > max) {
      fields[k] = v.slice(0, max);
      warnings.push(
        `${k} shows a bounded invalid excerpt; full invalid value cannot commit.`,
      );
    }
  }
  if (!fields.title) errors.push("Title is required.");
  if (!["practice", "match"].includes(fields.eventType))
    errors.push("eventType must be practice or match.");
  if (!fields.locationName && fields.address)
    errors.push("locationName is required with an address.");
  let times: ReturnType<typeof instants> | null = null;
  try {
    times = instants(fields);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (
    duplicates.has(`external:${fields.externalId}`) ||
    duplicates.has(`row:${JSON.stringify(raw)}`)
  )
    errors.push(
      "Repeated external ID or exact source row. Skip duplicate rows.",
    );
  const db = getFirestore();
  const teams = await tx.get(
    db
      .collection("teams")
      .where("orgId", "==", job.orgId)
      .where("programId", "==", job.programId)
      .where("seasonId", "==", job.seasonId)
      .where("status", "==", "active")
      .where("externalId", "==", fields.teamExternalId)
      .limit(2),
  );
  const teamDoc = teams.size === 1 ? teams.docs[0] : null,
    team = teamDoc?.data();
  if (!team || team.schemaVersion !== 2)
    errors.push(
      "Team external ID must identify one active team in the selected program and season.",
    );
  if (team)
    try {
      await hierarchy(
        tx,
        job.orgId,
        job.programId,
        job.seasonId,
        team.divisionId,
        true,
      );
    } catch (e) {
      if (
        !(e instanceof HttpsError) ||
        !["permission-denied", "failed-precondition"].includes(e.code)
      )
        throw e;
      errors.push("Team division is unavailable or archived.");
    }
  const titleKey = (v: string) =>
    v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const names =
    !fields.externalId && teamDoc
      ? await tx.get(
          db
            .collection("events")
            .where("orgId", "==", job.orgId)
            .where("teamId", "==", teamDoc.id)
            .where("programId", "==", job.programId)
            .where("seasonId", "==", job.seasonId)
            .limit(1001),
        )
      : null;
  if (names && names.size > 1000)
    errors.push(
      "Name review exceeds 1,000 team events. Supply trusted external IDs.",
    );
  const sameTitle = names?.docs.some(
    (d) =>
      d.data().deletedAt == null &&
      typeof d.data().title === "string" &&
      titleKey(d.data().title) === titleKey(fields.title),
  );
  if (sameTitle)
    warnings.push(
      "An event with this title exists. Explicitly choose a separate draft or skip; a title never establishes identity.",
    );
  if (overlaps.has(number))
    warnings.push(
      "Possible overlap with another source row for this team, local date and zone. Review it manually.",
    );
  const identity = identityKey(job, fields.externalId, number),
    ledger = (await tx.get(db.doc(`importLedger/${identity}`))).data();
  const eventId = ledger?.eventId ?? identity.slice(0, 40),
    before = (await tx.get(db.doc(`events/${eventId}`))).data();
  // Imported external IDs map only in this immutable season/program scope; names never establish identity.
  if (
    before &&
    (before.orgId !== job.orgId ||
      before.programId !== job.programId ||
      before.seasonId !== job.seasonId ||
      before.schemaVersion !== 2 ||
      before.deletedAt != null ||
      before.status !== "scheduled" ||
      before.publicationOperationId != null ||
      before.teamIds?.length !== 1 ||
      before.teamId !== teamDoc?.id ||
      before.teamIds[0] !== teamDoc?.id ||
      before.externalId !== (fields.externalId || null))
  )
    errors.push(
      "Existing event has incompatible scope or lifecycle. Review it separately.",
    );
  if (!fields.externalId)
    warnings.push(
      "No trusted external ID: a new upload creates a separate event, even with the same title.",
    );
  if (before?.publicationState === "published")
    warnings.push(
      "This update becomes an unpublished draft until separately published again.",
    );
  if (times && teamDoc) {
    const events = await tx.get(
      db
        .collection("events")
        .where("orgId", "==", job.orgId)
        .where("teamIds", "array-contains", teamDoc.id)
        .where("startsAt", "<", times.endsAt)
        .where("endsAt", ">", times.startsAt)
        .limit(101),
    );
    if (events.size > 100)
      warnings.push(
        "Overlap review is bounded; check this busy date manually.",
      );
    if (
      events.docs.some(
        (d) =>
          d.id !== eventId &&
          d.data().deletedAt == null &&
          d.data().status === "scheduled" &&
          d.data().endsAt?.toMillis() > times!.startsAt.toMillis(),
      )
    )
      warnings.push(
        "Overlaps an existing event for this team. This is a warning, not automatic scheduling.",
      );
    // Compare the source rows without persisting unbounded neighbor lists.
    warnings.push(
      "Warnings do not cover other teams or replace manual schedule review. No automatic scheduling is performed.",
    );
  }
  return {
    number,
    fields,
    errors,
    warnings,
    candidates: [],
    teamId: teamDoc?.id ?? null,
    teamRevision: team?.revision ?? 0,
    eventId,
    eventRevision: before?.revision ?? 0,
    participantId: "",
    resolution:
      errors.length || sameTitle ? null : before ? "update" : "create",
    outcome: null,
    previewRevision: job.previewRevision,
  };
}
export async function resolveScheduleRow(
  tx: Transaction,
  job: Data,
  row: Data,
  payload: Data,
) {
  if (
    payload.participantId ||
    (payload.resolution !== "skip" &&
      (row.errors.length ||
        payload.resolution !== (row.eventRevision ? "update" : "create")))
  )
    invalid("Skip invalid rows or keep the reviewed event identity.");
  tx.update(rowRef(job, row.number), { resolution: payload.resolution });
  tx.update(getFirestore().doc(`importJobs/${job.id}`), {
    planRevision: job.planRevision + 1,
    unresolved: job.unresolved + (row.resolution ? 0 : -1),
    previewCreates:
      job.previewCreates -
      (row.resolution === "create" ? 1 : 0) +
      (payload.resolution === "create" ? 1 : 0),
    previewUpdates:
      job.previewUpdates -
      (row.resolution === "update" ? 1 : 0) +
      (payload.resolution === "update" ? 1 : 0),
    previewSkips:
      job.previewSkips -
      (row.resolution === "skip" ? 1 : 0) +
      (payload.resolution === "skip" ? 1 : 0),
    updatedAt: Timestamp.now(),
  });
  return { ok: true };
}
export async function commitScheduleRow(tx: Transaction, job: Data, row: Data) {
  if (row.resolution === "skip")
    return () => tx.update(rowRef(job, row.number), { outcome: "skipped" });
  if (
    job.confirmedBinding !== job.binding ||
    job.confirmedPreviewRevision !== job.previewRevision ||
    job.confirmedPlanRevision !== job.planRevision ||
    row.previewRevision !== job.previewRevision ||
    row.errors.length
  )
    invalid("Preview binding changed.");
  const db = getFirestore(),
    team = (await tx.get(db.doc(`teams/${row.teamId}`))).data();
  if (
    !team ||
    team.orgId !== job.orgId ||
    team.programId !== job.programId ||
    team.seasonId !== job.seasonId ||
    team.schemaVersion !== 2 ||
    team.status !== "active" ||
    team.externalId !== row.fields.teamExternalId ||
    team.revision !== row.teamRevision
  )
    throw new HttpsError("aborted", "Team changed. Refresh the preview.");
  await hierarchy(
    tx,
    job.orgId,
    job.programId,
    job.seasonId,
    team.divisionId,
    true,
  );
  const ref = db.doc(`events/${row.eventId}`),
    before = (await tx.get(ref)).data(),
    ledgerRef = db.doc(
      `importLedger/${identityKey(job, row.fields.externalId, row.number)}`,
    ),
    ledger = (await tx.get(ledgerRef)).data();
  if (
    (before?.revision ?? 0) !== row.eventRevision ||
    (ledger && ledger.eventId !== row.eventId) ||
    (before &&
      (before.orgId !== job.orgId ||
        before.programId !== job.programId ||
        before.seasonId !== job.seasonId ||
        before.schemaVersion !== 2 ||
        before.teamId !== row.teamId ||
        before.teamIds?.length !== 1 ||
        before.teamIds[0] !== row.teamId ||
        before.status !== "scheduled" ||
        before.deletedAt != null ||
        before.publicationOperationId != null ||
        before.externalId !== (row.fields.externalId || null)))
  )
    throw new HttpsError("aborted", "Event changed. Refresh the preview.");
  const event: Data = {
    ...before,
    orgId: job.orgId,
    programId: job.programId,
    seasonId: job.seasonId,
    divisionId: team.divisionId,
    teamId: row.teamId,
    teamIds: [row.teamId],
    title: row.fields.title,
    type: row.fields.eventType,
    ...instants(row.fields),
    timeZone: row.fields.timeZone,
    location: row.fields.locationName
      ? {
          name: row.fields.locationName,
          ...(row.fields.address ? { address: row.fields.address } : {}),
        }
      : null,
    notes: row.fields.notes || null,
    status: "scheduled",
    publicationState: "staged",
    publicationOperationId: null,
    deletedAt: null,
    externalId: row.fields.externalId || null,
    ...metadata(job.ownerUid, before),
  };
  return () => {
    tx.set(ref, event);
    tx.set(ledgerRef, {
      orgId: job.orgId,
      programId: job.programId,
      seasonId: job.seasonId,
      kind: "schedule",
      eventId: row.eventId,
      lastJobId: job.id,
      updatedAt: Timestamp.now(),
    });
    tx.update(rowRef(job, row.number), {
      outcome: row.resolution === "create" ? "created" : "updated",
      eventRevision: event.revision,
    });
  };
}

/** Civil-time warning only; different zones/offsets and other teams still require manual review. */
export function sourceScheduleOverlaps(
  rows: string[][],
  mapping: Data,
): Set<number> {
  const get = (raw: string[], key: string) =>
    mapping[key] ? raw[rows[0].indexOf(mapping[key])].trim() : "";
  const entries = rows
    .slice(1)
    .map((raw, i) => ({
      number: i + 1,
      scope: JSON.stringify(
        ["teamExternalId", "localDate", "timeZone"].map((k) => get(raw, k)),
      ),
      start: get(raw, "localStartTime"),
      end: get(raw, "localEndTime"),
    }))
    .filter(
      (e) =>
        /^([01]\d|2[0-3]):[0-5]\d$/.test(e.start) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(e.end) &&
        e.end > e.start,
    )
    .sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) || a.start.localeCompare(b.start),
    );
  const overlaps = new Set<number>();
  let previous: (typeof entries)[number] | null = null;
  for (const entry of entries) {
    if (previous?.scope === entry.scope && entry.start < previous.end) {
      overlaps.add(previous.number);
      overlaps.add(entry.number);
    }
    if (!previous || previous.scope !== entry.scope || entry.end > previous.end)
      previous = entry;
  }
  return overlaps;
}
