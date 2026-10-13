import { createHash, randomUUID } from "node:crypto";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { accountAvailable } from "../accountAccess";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  object,
  revision,
  wire,
} from "../commandSupport";
import {
  denied,
  hierarchy,
  requireProgram,
  staffScope,
} from "../organizations/policy";
import {
  metadata,
  participantRef,
  prepareProjections,
  projectionSources,
  readCommand,
} from "../participants/policy";
import { parseCsv, columns, MAX_BYTES } from "./csv";

const retentionDays = Number(process.env.IMPORT_RETENTION_DAYS || "7");
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jobRef = (jobId: string) => getFirestore().doc(`importJobs/${jobId}`);
const rowRef = (jobId: string, number: number) =>
  jobRef(jobId).collection("rows").doc(String(number).padStart(5, "0"));
const source = (job: Data) =>
  getStorage()
    .bucket(
      process.env.IMPORT_BUCKET || `${process.env.GCLOUD_PROJECT}.appspot.com`,
    )
    .file(`imports/${job.orgId}/${job.id}/source.csv`);
const nameKey = (v: string) =>
  v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const publicJob = (job: Data) =>
  Object.fromEntries(
    [
      "id",
      "orgId",
      "programId",
      "seasonId",
      "status",
      "previewRevision",
      "count",
      "previewCheckpoint",
      "checkpoint",
      "unresolved",
      "previewCreates",
      "previewUpdates",
      "previewSkips",
      "created",
      "updated",
      "skipped",
      "error",
      "expiresAt",
      "templateVersion",
    ].map((k) => [k, job[k] ?? null]),
  );
async function scope(tx: Transaction, job: Data, uid: string, writing = false) {
  await accountAvailable(tx, uid);
  const access = await staffScope(tx, job.orgId, uid);
  requireProgram(access, job.programId);
  if (
    job.ownerUid !== uid ||
    access.organization.features?.imports !== true ||
    access.organization.features?.organizationV2 !== true
  )
    denied();
  await hierarchy(tx, job.orgId, job.programId, job.seasonId, null, writing);
  if (writing && job.expiresAt.toMillis() <= Date.now())
    throw new HttpsError(
      "failed-precondition",
      "Import expired. Upload a new file.",
    );
  return access;
}
function identity(data: Data) {
  return { orgId: id(data.orgId, "orgId"), jobId: id(data.jobId, "jobId") };
}
async function owned(
  tx: Transaction,
  payload: Data,
  uid: string,
  writing = false,
) {
  const job = (await tx.get(jobRef(payload.jobId))).data();
  if (!job || job.orgId !== payload.orgId) denied();
  await scope(tx, job, uid, writing);
  return job;
}
function mappingFor(rows: string[][], raw: unknown) {
  const mapping = object(raw);
  keys(mapping, columns);
  for (const key of columns) {
    if (
      mapping[key] != null &&
      (typeof mapping[key] !== "string" || !rows[0].includes(mapping[key]))
    )
      invalid(`Choose a CSV header for ${key}.`);
  }
  for (const key of ["participantName", "kind", "teamExternalId"])
    if (!mapping[key]) invalid(`Map ${key} before previewing.`);
  const selected = Object.values(mapping).filter(Boolean);
  if (new Set(selected).size !== selected.length)
    invalid("Each source header can be mapped only once.");
  return Object.fromEntries(columns.map((k) => [k, mapping[k] ?? null]));
}
/** Authenticated server upload avoids public download tokens and independently parses exact bytes. */
export const uploadRosterImport = onCall(
  { timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
    const data = object(request.data);
    keys(data, [
      "requestId",
      "orgId",
      "programId",
      "seasonId",
      "csvBase64",
      "mapping",
      "templateVersion",
    ]);
    if (data.templateVersion !== 1) invalid("Use roster template version 1.");
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 30
    )
      throw new HttpsError(
        "failed-precondition",
        "Import retention requires a reviewed 1 to 30 day setting.",
      );
    const requestId = id(data.requestId, "requestId");
    if (
      typeof data.csvBase64 !== "string" ||
      data.csvBase64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        data.csvBase64,
      )
    )
      invalid("Upload a valid CSV of at most 5 MB.");
    const bytes = Buffer.from(data.csvBase64, "base64");
    let rows: string[][];
    try {
      rows = parseCsv(bytes);
    } catch (e) {
      invalid((e as Error).message);
    }
    const mapping = mappingFor(rows!, data.mapping);
    const orgId = id(data.orgId, "orgId"),
      programId = id(data.programId, "programId"),
      seasonId = id(data.seasonId, "seasonId");
    const jobId = hash(`${uid}:${orgId}:${requestId}`),
      checksum = hash(bytes);
    const binding = hash(
      JSON.stringify({
        checksum,
        mapping,
        programId,
        seasonId,
        templateVersion: 1,
        policyRevision: 1,
      }),
    );
    const ref = jobRef(jobId);
    const db = getFirestore();
    let job = await db.runTransaction(async (tx) => {
      const saved = (await tx.get(ref)).data();
      const next: Data = saved ?? {
        id: jobId,
        orgId,
        programId,
        seasonId,
        ownerUid: uid,
        kind: "roster",
        templateVersion: 1,
        fileChecksum: checksum,
        mapping,
        mappingHash: hash(JSON.stringify(mapping)),
        binding,
        policyRevision: 1,
        status: "uploading",
        previewRevision: 1,
        count: rows!.length - 1,
        previewCheckpoint: 0,
        checkpoint: 0,
        unresolved: 0,
        previewCreates: 0,
        previewUpdates: 0,
        previewSkips: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        error: null,
        expiresAt: Timestamp.fromMillis(Date.now() + retentionDays * 86400000),
        lease: null,
        ...metadata(uid),
      };
      await scope(tx, next, uid, !saved);
      if (saved && saved.binding !== binding)
        throw new HttpsError(
          "already-exists",
          "This upload request ID belongs to another file or mapping.",
        );
      if (!saved) tx.create(ref, next);
      return next;
    });
    if (job.status === "uploading") {
      try {
        await source(job).save(bytes, {
          resumable: false,
          contentType: "text/csv; charset=utf-8",
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 412)
          throw new HttpsError(
            "unavailable",
            "Upload interrupted. Retry the same upload.",
          );
      }
      job = await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data()!;
        await scope(tx, current, uid, true);
        if (current.status === "uploading")
          tx.update(ref, { status: "previewing", updatedAt: Timestamp.now() });
        return {
          ...current,
          status:
            current.status === "uploading" ? "previewing" : current.status,
        };
      });
    }
    return wire({ job: publicJob(job) });
  },
);

async function preview(
  tx: Transaction,
  job: Data,
  raw: string[],
  header: string[],
  duplicates: Set<string>,
  number: number,
) {
  const fields: Data = Object.fromEntries(
    columns.map((k) => [
      k,
      job.mapping[k] ? raw[header.indexOf(job.mapping[k])].trim() : "",
    ]),
  );
  const errors: string[] = [],
    warnings: string[] = [];
  for (const [k, v] of Object.entries(fields))
    if (
      typeof v !== "string" ||
      v.length >
        (k === "participantName"
          ? 200
          : k.startsWith("guardian")
            ? 254
            : 128) ||
      /^[\s]*[=+@-]/.test(v) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    )
      errors.push(`Invalid or formula-like ${k}.`);
  if (!fields.participantName) errors.push("Participant name is required.");
  if (!["youth", "adult", "unknown"].includes(fields.kind))
    errors.push("Kind must be youth, adult or unknown.");
  if (!fields.teamExternalId) errors.push("Team external ID is required.");
  for (const k of ["guardianEmail1", "guardianEmail2"])
    if (fields[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[k]))
      errors.push(`Invalid ${k}.`);
  if (fields.guardianEmail1 || fields.guardianEmail2)
    warnings.push(
      "Guardian emails do not grant access or send invitations. Explicit invitation confirmation is required after import.",
    );
  if (
    duplicates.has(fields.externalId && `external:${fields.externalId}`) ||
    duplicates.has(`row:${JSON.stringify(raw)}`)
  )
    errors.push(
      "Repeated external ID or exact source row. Skip duplicate rows and upload corrected data if needed.",
    );
  const db = getFirestore();
  const teams = await tx.get(
    db
      .collection("teams")
      .where("orgId", "==", job.orgId)
      .where("externalId", "==", fields.teamExternalId)
      .limit(2),
  );
  const teamDoc = teams.size === 1 ? teams.docs[0] : null;
  const team = teamDoc?.data();
  if (
    !team ||
    team.schemaVersion !== 2 ||
    team.programId !== job.programId ||
    team.seasonId !== job.seasonId ||
    team.status !== "active"
  )
    errors.push(
      "Team external ID must identify one active team in the selected program and season.",
    );
  if (team)
    await hierarchy(
      tx,
      job.orgId,
      job.programId,
      job.seasonId,
      team.divisionId,
      true,
    );
  // Names are only review candidates. Never establish identity from a name or email.
  const access = await staffScope(tx, job.orgId, job.ownerUid);
  let matches;
  if (fields.externalId)
    matches = await tx.get(
      db
        .collection(`organizations/${job.orgId}/participants`)
        .where("externalId", "==", fields.externalId)
        .limit(11),
    );
  else
    matches = await tx.get(
      db.collection(`organizations/${job.orgId}/participants`).limit(5001),
    );
  if (!fields.externalId && matches.size > 5000)
    errors.push(
      "Organization identity review exceeds 5,000 records. Supply trusted external IDs.",
    );
  // Include older command-created identities with exact names, without a tenant-wide scan.
  const exact = !fields.externalId
    ? await tx.get(
        db
          .collection(`organizations/${job.orgId}/participants`)
          .where("displayName", "==", fields.participantName)
          .limit(11),
      )
    : null;
  const docs = [
    ...new Map(
      [
        ...matches.docs.filter(
          (d) =>
            fields.externalId ||
            nameKey(d.data().displayName ?? "") ===
              nameKey(fields.participantName),
        ),
        ...(exact?.docs ?? []),
      ].map((d) => [d.id, d]),
    ).values(),
  ];
  const candidates: Data[] = [];
  if (!access.admin)
    warnings.push(
      "Program staff import only enrollment. Existing participant identity fields are preserved.",
    );
  for (const d of docs) {
    const p = d.data();
    if (p.schemaVersion !== 2 || (p.orgId != null && p.orgId !== job.orgId))
      continue;
    if (!access.admin) {
      const roster = teamDoc
        ? (await tx.get(db.doc(`teams/${teamDoc.id}/roster/${d.id}`))).data()
        : null;
      if (roster?.orgId !== job.orgId || roster?.status !== "active") continue;
    }
    candidates.push({
      id: d.id,
      displayName: p.displayName,
      revision: p.revision ?? 0,
      status: p.status,
      kind: p.kind,
    });
  }
  if (docs.length > 10)
    errors.push(
      "Too many identity matches. Correct the external ID before importing.",
    );
  if (fields.externalId && docs.length > 1)
    errors.push(
      "External ID is not unique. Ask an administrator to repair identities.",
    );
  if (!access.admin && (!fields.externalId || candidates.length !== 1))
    errors.push(
      "Program staff can enroll an existing trusted external ID on this roster. An administrator must create or resolve identities.",
    );
  if (candidates.some((c) => c.status !== "active"))
    errors.push("Archived identity requires an administrator review.");
  if (candidates.some((c) => c.kind !== fields.kind && c.kind === "adult"))
    errors.push(
      "Changing an adult identity kind requires a separate reviewed edit.",
    );
  const matched =
    fields.externalId && candidates.length === 1 ? candidates[0] : null;
  const participantId =
    matched?.id ??
    hash(
      `${job.orgId}:roster:${fields.externalId || `${job.id}:${number}`}`,
    ).slice(0, 40);
  const current = (
    await tx.get(participantRef(job.orgId, participantId))
  ).data();
  if (!matched && current)
    errors.push("Identity already exists. Refresh the preview to review it.");
  const enrollment = teamDoc
    ? (
        await tx.get(db.doc(`teams/${teamDoc.id}/roster/${participantId}`))
      ).data()
    : null;
  return {
    number,
    fields,
    errors,
    warnings,
    candidates,
    teamId: teamDoc?.id ?? null,
    teamRevision: team?.revision ?? 0,
    participantId,
    participantRevision: matched?.revision ?? 0,
    rosterRevision: enrollment?.revision ?? 0,
    resolution:
      errors.length || (!fields.externalId && candidates.length)
        ? null
        : matched
          ? "update"
          : "create",
    outcome: null,
    previewRevision: job.previewRevision,
  };
}
function duplicateKeys(rows: string[][], mapping: Data): Set<string> {
  const seen = new Set<string>(),
    repeated = new Set<string>();
  const external = rows[0].indexOf(mapping.externalId);
  for (const raw of rows.slice(1)) {
    for (const key of [
      `row:${JSON.stringify(raw)}`,
      ...(external >= 0 && raw[external].trim()
        ? [`external:${raw[external].trim()}`]
        : []),
    ]) {
      if (seen.has(key)) repeated.add(key);
      seen.add(key);
    }
  }
  return repeated;
}
export const getRosterImport = readCommand(
  (data) => {
    keys(data, ["orgId", "jobId", "offset"]);
    const offset = data.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000)
      invalid("Invalid page offset.");
    return { ...identity(data), offset };
  },
  async (tx, payload, uid) => {
    const job = await owned(tx, payload, uid);
    const rows = await tx.get(
      jobRef(job.id)
        .collection("rows")
        .orderBy("number")
        .startAt(payload.offset + 1)
        .limit(50),
    );
    return {
      job: publicJob(job),
      rows: rows.docs.map((d) => d.data()),
      nextOffset:
        payload.offset + rows.size < job.previewCheckpoint
          ? payload.offset + rows.size
          : null,
    };
  },
);
export const resolveRosterImportRow = command(
  "resolveRosterImportRow",
  (data) => {
    keys(data, [
      "requestId",
      "orgId",
      "jobId",
      "number",
      "previewRevision",
      "resolution",
      "participantId",
    ]);
    const number = revision(data.number);
    if (number < 1 || number > 5000) invalid("Invalid row number.");
    if (!["create", "update", "skip"].includes(data.resolution))
      invalid("Choose create, match or skip.");
    return {
      ...identity(data),
      number,
      previewRevision: revision(data.previewRevision),
      resolution: data.resolution,
      participantId:
        data.participantId == null
          ? null
          : id(data.participantId, "participantId"),
    };
  },
  async (tx, payload, uid, _actor, replay) => {
    const job = await owned(tx, payload, uid);
    if (replay) return replay;
    await scope(tx, job, uid, true);
    if (
      job.status !== "preview" ||
      job.previewRevision !== payload.previewRevision
    )
      invalid("Wait for or refresh the current preview.");
    const ref = rowRef(job.id, payload.number),
      row = (await tx.get(ref)).data()!;
    if (!row || row.outcome) invalid("Row is unavailable.");
    const access = await staffScope(tx, job.orgId, uid);
    const candidate = row.candidates.find(
      (c: Data) => c.id === payload.participantId,
    );
    if (
      payload.resolution !== "skip" &&
      (row.errors.length || (!access.admin && payload.resolution === "create"))
    )
      invalid("Invalid rows must be skipped or corrected in a new upload.");
    if (
      payload.resolution === "create" &&
      row.fields.externalId &&
      row.candidates.length
    )
      invalid("A trusted external ID must match its existing identity.");
    if (
      payload.resolution === "update" &&
      (!candidate || candidate.status !== "active")
    )
      invalid("Choose one of the reviewed active candidates.");
    const next: Data = { ...row, resolution: payload.resolution };
    if (payload.resolution === "update") {
      next.participantId = candidate.id;
      next.participantRevision = candidate.revision;
      next.rosterRevision =
        (
          await tx.get(
            getFirestore().doc(`teams/${row.teamId}/roster/${candidate.id}`),
          )
        ).data()?.revision ?? 0;
    }
    if (payload.resolution === "create") {
      next.participantId = hash(
        `${job.orgId}:roster:${row.fields.externalId || `${job.id}:${row.number}`}`,
      ).slice(0, 40);
      next.participantRevision = 0;
      next.rosterRevision = 0;
    }
    tx.set(ref, next);
    tx.update(jobRef(job.id), {
      unresolved: job.unresolved + (row.resolution ? 0 : -1),
      previewCreates:
        (job.previewCreates ?? 0) -
        (row.resolution === "create" ? 1 : 0) +
        (payload.resolution === "create" ? 1 : 0),
      previewUpdates:
        (job.previewUpdates ?? 0) -
        (row.resolution === "update" ? 1 : 0) +
        (payload.resolution === "update" ? 1 : 0),
      previewSkips:
        (job.previewSkips ?? 0) -
        (row.resolution === "skip" ? 1 : 0) +
        (payload.resolution === "skip" ? 1 : 0),
      updatedAt: Timestamp.now(),
    });
    return { ok: true };
  },
);
export const commitRosterImport = command(
  "commitRosterImport",
  (data) => {
    keys(data, ["requestId", "orgId", "jobId", "previewRevision", "confirmed"]);
    if (data.confirmed !== true)
      invalid("Confirm the exact import preview first.");
    return {
      ...identity(data),
      previewRevision: revision(data.previewRevision),
      confirmed: true,
    };
  },
  async (tx, payload, uid, _actor, replay) => {
    const job = await owned(tx, payload, uid);
    if (replay) return replay;
    await scope(tx, job, uid, true);
    if (
      job.status !== "preview" ||
      job.previewRevision !== payload.previewRevision ||
      job.unresolved
    )
      invalid("Resolve every row in the current preview before committing.");
    tx.update(jobRef(job.id), {
      status: "committing",
      confirmedBinding: job.binding,
      confirmedPreviewRevision: job.previewRevision,
      lease: null,
      error: null,
      updatedAt: Timestamp.now(),
    });
    return { ok: true };
  },
);
export const refreshRosterImport = command(
  "refreshRosterImport",
  (data) => {
    keys(data, ["requestId", "orgId", "jobId"]);
    return identity(data);
  },
  async (tx, payload, uid, _actor, replay) => {
    const job = await owned(tx, payload, uid);
    if (replay) return replay;
    await scope(tx, job, uid, true);
    if (!["preview", "needs-review", "paused"].includes(job.status))
      invalid("This job cannot be refreshed yet.");
    tx.update(jobRef(job.id), {
      status: "previewing",
      previewRevision: job.previewRevision + 1,
      previewCheckpoint: job.checkpoint,
      unresolved: 0,
      previewCreates: 0,
      previewUpdates: 0,
      previewSkips: 0,
      lease: null,
      error: null,
      updatedAt: Timestamp.now(),
    });
    return { ok: true };
  },
);

async function commitRow(tx: Transaction, job: Data, row: Data) {
  const db = getFirestore();
  if (row.resolution === "skip")
    return () => tx.update(rowRef(job.id, row.number), { outcome: "skipped" });
  const access = await scope(tx, job, job.ownerUid, true);
  if (
    job.confirmedBinding !== job.binding ||
    job.confirmedPreviewRevision !== job.previewRevision ||
    row.previewRevision !== job.previewRevision
  )
    invalid("Preview binding changed.");
  const team = (await tx.get(db.doc(`teams/${row.teamId}`))).data();
  if (
    !team ||
    team.orgId !== job.orgId ||
    team.schemaVersion !== 2 ||
    team.programId !== job.programId ||
    team.seasonId !== job.seasonId ||
    team.status !== "active" ||
    (team.revision ?? 0) !== row.teamRevision ||
    team.externalId !== row.fields.teamExternalId
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
  const ref = participantRef(job.orgId, row.participantId),
    before = (await tx.get(ref)).data();
  const rosterRef = db.doc(`teams/${row.teamId}/roster/${row.participantId}`),
    enrollment = (await tx.get(rosterRef)).data();
  if (
    (before?.revision ?? 0) !== row.participantRevision ||
    (enrollment?.revision ?? 0) !== row.rosterRevision ||
    (before &&
      (before.schemaVersion !== 2 ||
        (before.orgId != null && before.orgId !== job.orgId) ||
        before.status !== "active")) ||
    (enrollment &&
      (enrollment.orgId !== job.orgId ||
        enrollment.participantId !== row.participantId))
  )
    throw new HttpsError(
      "aborted",
      "Participant or enrollment changed. Refresh the preview.",
    );
  if (!access.admin && (!before || enrollment?.status !== "active")) denied();
  if (row.fields.externalId) {
    const matches = await tx.get(
      db
        .collection(`organizations/${job.orgId}/participants`)
        .where("externalId", "==", row.fields.externalId)
        .limit(2),
    );
    if (
      matches.docs.some((d) => d.id !== row.participantId) ||
      (before && before.externalId !== row.fields.externalId)
    )
      throw new HttpsError(
        "aborted",
        "External ID changed. Refresh the preview.",
      );
  }
  const oldSources = before
    ? await projectionSources(tx, job.orgId, row.participantId, before)
    : { grants: {}, teamIds: [], linkedUserId: null };
  const teamIds = [...new Set([...oldSources.teamIds, row.teamId])];
  if (teamIds.length > 20)
    throw new HttpsError(
      "resource-exhausted",
      "Participant enrollment limit reached.",
    );
  const accessRevision = (before?.accessRevision ?? 0) + 1;
  const projections = await prepareProjections(
    tx,
    job.orgId,
    row.participantId,
    oldSources,
    { ...oldSources, teamIds },
    true,
    accessRevision,
    job.ownerUid,
  );
  const participant = {
    ...before,
    ...(access.admin
      ? {
          displayName: row.fields.participantName,
          kind: row.fields.kind,
          externalId: row.fields.externalId || before?.externalId || null,
          importNameKey: nameKey(row.fields.participantName),
        }
      : {}),
    orgId: job.orgId,
    status: "active",
    linkedUserId: before?.linkedUserId ?? null,
    accessRevision,
    ...metadata(job.ownerUid, before),
  };
  const ledger = db.doc(
    `importLedger/${hash(`${job.orgId}:roster:${row.fields.externalId || `${job.id}:${row.number}`}`)}`,
  );
  await tx.get(ledger); // Fences concurrent jobs through their canonical participant transaction.
  return () => {
    tx.set(ref, participant);
    projections();
    tx.set(rosterRef, {
      ...enrollment,
      orgId: job.orgId,
      participantId: row.participantId,
      status: "active",
      jerseyNumber: enrollment?.jerseyNumber ?? null,
      joinedAt: enrollment?.joinedAt ?? Timestamp.now(),
      removedAt: null,
      ...metadata(job.ownerUid, enrollment),
    });
    tx.set(ledger, {
      orgId: job.orgId,
      kind: "roster",
      participantId: row.participantId,
      lastJobId: job.id,
      lastRow: row.number,
      updatedAt: Timestamp.now(),
    });
    tx.update(rowRef(job.id, row.number), {
      outcome: row.resolution === "create" ? "created" : "updated",
      participantId: row.participantId,
    });
  };
}
/** Leased, bounded service worker. Every row transaction rechecks live authority and revisions. */
export async function runRosterImport(jobId: string, budget = 25) {
  const db = getFirestore(),
    ref = jobRef(jobId),
    lease = randomUUID();
  const initial = await db.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (
      !job ||
      !["previewing", "committing"].includes(job.status) ||
      (job.lease && job.leaseUntil.toMillis() > Date.now())
    )
      return null;
    tx.update(ref, {
      lease,
      leaseUntil: Timestamp.fromMillis(Date.now() + 120000),
    });
    return job;
  });
  if (!initial) return;
  try {
    let rows: string[][] | null = null,
      duplicates = new Set<string>();
    if (initial.status === "previewing") {
      const [bytes] = await source(initial).download();
      if (hash(bytes) !== initial.fileChecksum)
        invalid("Uploaded source checksum changed.");
      rows = parseCsv(bytes);
      duplicates = duplicateKeys(rows, initial.mapping);
    }
    for (let i = 0; i < budget; i++) {
      const more = await db.runTransaction(async (tx) => {
        const job = (await tx.get(ref)).data()!;
        if (job.lease !== lease || job.status !== initial.status) return false;
        await scope(tx, job, job.ownerUid, true);
        const checkpoint =
          job.status === "previewing" ? job.previewCheckpoint : job.checkpoint;
        if (checkpoint >= job.count) {
          tx.update(ref, {
            status: job.status === "previewing" ? "preview" : "complete",
            lease: null,
            validatedAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
          });
          return false;
        }
        const number = checkpoint + 1;
        if (job.status === "previewing") {
          const next = await preview(
            tx,
            job,
            rows![number],
            rows![0],
            duplicates,
            number,
          );
          tx.set(rowRef(jobId, number), next);
          tx.update(ref, {
            previewCheckpoint: number,
            unresolved: job.unresolved + (next.resolution ? 0 : 1),
            previewCreates:
              (job.previewCreates ?? 0) +
              (next.resolution === "create" ? 1 : 0),
            previewUpdates:
              (job.previewUpdates ?? 0) +
              (next.resolution === "update" ? 1 : 0),
            updatedAt: Timestamp.now(),
          });
        } else {
          const row = (await tx.get(rowRef(jobId, number))).data()!;
          if (!row?.resolution) invalid("Unresolved import row.");
          const write = await commitRow(tx, job, row);
          write();
          const key =
            row.resolution === "skip"
              ? "skipped"
              : row.resolution === "create"
                ? "created"
                : "updated";
          tx.update(ref, {
            checkpoint: number,
            [key]: job[key] + 1,
            updatedAt: Timestamp.now(),
          });
        }
        return true;
      });
      if (!more) break;
    }
    await db.runTransaction(async (tx) => {
      const job = (await tx.get(ref)).data();
      if (job?.lease === lease)
        tx.update(ref, { lease: null, updatedAt: Timestamp.now() });
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    await db.runTransaction(async (tx) => {
      const job = (await tx.get(ref)).data();
      if (job?.lease !== lease) return;
      tx.update(ref, {
        status:
          code === "aborted" || code === "failed-precondition"
            ? "needs-review"
            : "paused",
        lease: null,
        error:
          code === "permission-denied"
            ? "Access removed. Completed rows are retained; an authorized owner must review before resuming."
            : code
              ? (e as Error).message
              : "Import interrupted. Refresh the pending preview to resume safely.",
        updatedAt: Timestamp.now(),
      });
    });
  }
}
export const processRosterImports = onDocumentWritten(
  { document: "importJobs/{jobId}", timeoutSeconds: 120, memory: "512MiB" },
  async (event) => {
    await runRosterImport(event.params.jobId);
  },
);
export const resumeRosterImports = onSchedule("every 5 minutes", async () => {
  const jobs = await getFirestore()
    .collection("importJobs")
    .where("status", "in", ["previewing", "committing"])
    .limit(25)
    .get();
  for (const job of jobs.docs) await runRosterImport(job.id);
});
export const expireRosterImports = onSchedule("every 24 hours", async () => {
  const jobs = await getFirestore()
    .collection("importJobs")
    .where("expiresAt", "<=", Timestamp.now())
    .limit(25)
    .get();
  for (const snap of jobs.docs) {
    const job = snap.data();
    await snap.ref.update({ status: "expired", lease: null });
    await source(job).delete({ ignoreNotFound: true });
    await getFirestore().recursiveDelete(snap.ref);
  }
});
