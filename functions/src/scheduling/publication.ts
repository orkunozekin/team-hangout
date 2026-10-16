import { audit } from "../organizations/commands";
import { publicationPass, payloadHash } from "./protocol";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { command, Data, id, keys, revision } from "../commandSupport";
import { readCommand } from "../participants/policy";
import { cacheDocumentReads } from "../operations/reads";
import { checkRevision, denied } from "../operations/access";
import { fingerprint } from "../operations/requests";
import { storedDraft, draftSnapshot } from "./drafts";
import { validateSchedule } from "./validator";
import { lockRef, publicationError as fail } from "./lease";
const db = () => getFirestore();
const opRef = (d: Data) =>
  db().doc(`organizations/${d.orgId}/scheduleOperations/${d.operationId}`);
const identity = (d: Data) => ({
  orgId: id(d.orgId, "orgId"),
  draftId: id(d.draftId, "draftId"),
});
function progress(row: Data) {
  return {
    operationId: row.operationId,
    draftId: row.draftId,
    revision: row.revision,
    state: row.state,
    stagingCursor: row.stagingCursor,
    promotionCursor: row.promotionCursor,
    total: row.expected.length,
    fencingToken: row.fencingToken,
    expiresAt: row.expiresAt,
    committedAt: row.committedAt ?? null,
  };
}
async function live(
  tx: Transaction,
  d: Data,
  uid: string,
  row: Data,
  excludeOperationId?: string,
) {
  const current = await draftSnapshot(
    tx,
    {
      ...d,
      divisionId: row.divisionId,
      fields: row.fields,
      excludeOperationId,
    },
    uid,
  );
  const validation = validateSchedule(current.input, row.assignments);
  if (!validation.valid || validation.unscheduledFixtureIds.length)
    fail(
      "SCHEDULE_CONFLICT",
      "Revalidate a complete schedule with no hard conflicts before publishing.",
    );
  return current;
}
async function eventPayload(
  tx: Transaction,
  d: Data,
  row: Data,
  current: Awaited<ReturnType<typeof draftSnapshot>>,
  fixtureId: string,
  uid: string,
) {
  const fixture = current.fixtures.find((f) => f.id === fixtureId)!;
  const a = row.assignments.find((a: Data) => a.fixtureId === fixtureId)!;
  const slot = row.fields.slots.find((s: Data) => s.id === a.slotId)!;
  const facility = (
    await tx.get(
      db().doc(`organizations/${d.orgId}/facilities/${slot.facilityId}`),
    )
  ).data()!;
  const resource = (
    await tx.get(
      db().doc(
        `organizations/${d.orgId}/facilities/${slot.facilityId}/resources/${slot.resourceId}`,
      ),
    )
  ).data()!;
  const endsAt = Timestamp.fromMillis(
    Date.parse(slot.startsAt) + row.fields.durationMinutes * 60000,
  );
  return {
    schemaVersion: 2,
    orgId: d.orgId,
    programId: (
      await tx.get(
        db().doc(`organizations/${d.orgId}/divisions/${row.divisionId}`),
      )
    ).data()!.programId,
    seasonId: (
      await tx.get(
        db().doc(`organizations/${d.orgId}/divisions/${row.divisionId}`),
      )
    ).data()!.seasonId,
    divisionId: row.divisionId,
    teamId: fixture.homeTeamId,
    teamIds: [fixture.homeTeamId, fixture.awayTeamId],
    homeTeamId: fixture.homeTeamId,
    awayTeamId: fixture.awayTeamId,
    title: row.fields.title,
    type: "match",
    startsAt: Timestamp.fromDate(new Date(slot.startsAt)),
    endsAt,
    timeZone: current.timeZone,
    status: "scheduled",
    publicationOperationId: d.operationId,
    publicationState: "staged",
    revision: 1,
    scheduleVersion: 1,
    facilityId: slot.facilityId,
    resourceId: slot.resourceId,
    location: {
      name: `${facility.name} · ${resource.label}`,
      address: facility.address ?? "",
    },
    resourceDetails: {
      facilityName: facility.name,
      label: resource.label,
      address: facility.address ?? "",
      timeZone: facility.timeZone,
      latitude: facility.latitude ?? null,
      longitude: facility.longitude ?? null,
      parking: facility.parking ?? null,
      accessibility: facility.accessibility ?? null,
    },
    resourceOccupancy: {
      startsAt: Timestamp.fromMillis(
        Date.parse(slot.startsAt) - resource.setupMinutes * 60000,
      ),
      endsAt: Timestamp.fromMillis(
        endsAt.toMillis() + resource.cleanupMinutes * 60000,
      ),
      setupMinutes: resource.setupMinutes,
      cleanupMinutes: resource.cleanupMinutes,
      resourceRevision: resource.revision,
      sports: [current.input.sport],
    },
    notes: null,
    deletedAt: null,
    createdBy: uid,
    updatedBy: uid,
  };
}

export const publishScheduleDraft = command(
  "publishScheduleDraft",
  (d) => {
    keys(d, ["requestId", "orgId", "draftId", "expectedRevision", "confirmed"]);
    if (d.confirmed !== true)
      fail("CONFIRM_PUBLICATION", "Explicitly confirm publication.");
    return {
      ...identity(d),
      expectedRevision: revision(d.expectedRevision),
      confirmed: true,
      requestId: id(d.requestId, "requestId"),
    };
  },
  async (tx, d, uid, _actor, replay) => {
    tx = cacheDocumentReads(tx);
    const row = await storedDraft(tx, d, uid);
    if (replay)
      return progress(
        (
          await tx.get(opRef({ ...d, operationId: replay.operationId }))
        ).data()!,
      );
    checkRevision(row, d.expectedRevision);
    if (row.publicationOperationId)
      fail(
        "ALREADY_PUBLISHING",
        "Load the existing publication to recover or inspect its progress.",
      );
    if (row.validationRevision !== row.revision || !row.validation?.valid)
      fail(
        "VALIDATION_REQUIRED",
        "Save and revalidate this draft before publishing.",
      );
    const lock = (await tx.get(lockRef(d.orgId))).data();
    if (lock?.operationId)
      fail(
        "SCHEDULING_BUSY",
        "Recover or abort the existing publication first.",
      );
    const operationId = fingerprint({
      orgId: d.orgId,
      draftId: d.draftId,
      revision: row.revision,
    });
    d = { ...d, operationId };
    const current = await live(tx, d, uid, row);
    const expected = [];
    for (const a of row.assignments) {
      const eventId = fingerprint({ operationId, fixtureId: a.fixtureId });
      expected.push({
        eventId,
        fixtureId: a.fixtureId,
        revision: 1,
        hash: payloadHash(
          await eventPayload(tx, d, row, current, a.fixtureId, uid),
        ),
      });
    }
    const now = Timestamp.now(),
      expiresAt = Timestamp.fromMillis(now.toMillis() + 120000);
    const operation = {
      schemaVersion: 2,
      orgId: d.orgId,
      draftId: d.draftId,
      operationId,
      action: "publishScheduleDraft",
      actorUid: uid,
      requestId: d.requestId,
      createdBy: uid,
      updatedBy: uid,
      inputHash: current.inputHash,
      inputRevision: lock?.inputRevision ?? 0,
      draftRevision: row.revision,
      expected,
      manifestHash: fingerprint({ expected }),
      fencingToken: (lock?.fencingToken ?? 0) + 1,
      expiresAt,
      revision: 1,
      state: "staging",
      stagingCursor: 0,
      promotionCursor: 0,
      createdAt: now,
      updatedAt: now,
      auditCorrelationId: operationId,
    };
    audit(tx, d.orgId, uid, "beginSchedulePublication", operationId, 1);
    tx.create(opRef(d), operation);
    tx.set(lockRef(d.orgId), {
      schemaVersion: 2,
      orgId: d.orgId,
      operationId,
      fencingToken: operation.fencingToken,
      inputRevision: operation.inputRevision,
      visibilityRevision: lock?.visibilityRevision ?? 0,
      expiresAt,
    });
    tx.update(
      db().doc(`organizations/${d.orgId}/scheduleDrafts/${d.draftId}`),
      { publicationOperationId: operationId },
    );
    return progress(operation);
  },
);
export const getSchedulePublication = readCommand(
  (d) => {
    keys(d, ["orgId", "draftId"]);
    return identity(d);
  },
  async (tx, d, uid) => {
    tx = cacheDocumentReads(tx);
    const row = await storedDraft(tx, d, uid);
    if (!row.publicationOperationId) return { operation: null };
    return {
      operation: progress(
        (
          await tx.get(opRef({ ...d, operationId: row.publicationOperationId }))
        ).data()!,
      ),
    };
  },
);
export const advanceSchedulePublication = command(
  "advanceSchedulePublication",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "draftId",
      "operationId",
      "expectedRevision",
      "fencingToken",
      "action",
    ]);
    if (!["advance", "resume", "abort"].includes(d.action))
      fail("INVALID_ACTION", "Choose advance, resume or abort.");
    return {
      ...identity(d),
      operationId: id(d.operationId, "operationId"),
      expectedRevision: revision(d.expectedRevision),
      fencingToken: revision(d.fencingToken),
      action: d.action,
    };
  },
  async (tx, d, uid, _actor, replay) => {
    tx = cacheDocumentReads(tx);
    const draft = await storedDraft(tx, d, uid),
      ref = opRef(d),
      op = (await tx.get(ref)).data();
    if (
      !op ||
      op.orgId !== d.orgId ||
      op.draftId !== d.draftId ||
      (draft.publicationOperationId !== d.operationId &&
        !(op.state === "aborted" && replay))
    )
      denied();
    if (replay || op.state === "committed" || op.state === "aborted")
      return progress(op);
    checkRevision(op, d.expectedRevision);
    const lock = (await tx.get(lockRef(d.orgId))).data();
    if (
      lock?.operationId !== d.operationId ||
      lock?.fencingToken !== op.fencingToken ||
      d.fencingToken !== op.fencingToken
    )
      fail(
        "STALE_LEASE",
        "This worker has lost the scheduling lease. Reload publication progress.",
      );
    if (d.action === "abort") {
      tx.update(ref, {
        state: "aborted",
        revision: op.revision + 1,
        updatedAt: Timestamp.now(),
      });
      tx.update(lockRef(d.orgId), { operationId: null });
      tx.update(
        db().doc(`organizations/${d.orgId}/scheduleDrafts/${d.draftId}`),
        { publicationOperationId: null },
      );
      return progress({ ...op, state: "aborted", revision: op.revision + 1 });
    }
    if (
      draft.revision !== op.draftRevision ||
      lock?.inputRevision !== op.inputRevision
    )
      fail(
        "INPUT_CHANGED",
        "Publication inputs changed. Abort and review a new draft.",
      );
    if (
      fingerprint({ expected: op.expected }) !== op.manifestHash ||
      op.expected.length !== draft.assignments.length ||
      new Set(op.expected.map((e: Data) => e.fixtureId)).size !==
        op.expected.length ||
      op.expected.some(
        (e: Data) =>
          e.eventId !==
            fingerprint({
              operationId: d.operationId,
              fixtureId: e.fixtureId,
            }) ||
          !draft.assignments.some((a: Data) => a.fixtureId === e.fixtureId),
      )
    )
      fail("EVENT_CHANGED", "Expected event manifest changed.");
    const current = await live(tx, d, uid, draft, d.operationId);
    if (current.inputHash !== op.inputHash)
      fail(
        "INPUT_CHANGED",
        "Resource, team, coach, closure or scheduling inputs changed. Abort and revalidate.",
      );
    const now = Timestamp.now(),
      expiresAt = Timestamp.fromMillis(now.toMillis() + 120000);
    if (d.action === "resume") {
      const next = {
        ...op,
        fencingToken: op.fencingToken + 1,
        expiresAt,
        revision: op.revision + 1,
        updatedAt: now,
      };
      tx.update(ref, next);
      tx.update(lockRef(d.orgId), {
        fencingToken: next.fencingToken,
        expiresAt,
      });
      return progress(next);
    }
    if (op.expiresAt.toMillis() <= now.toMillis())
      fail(
        "STALE_LEASE",
        "Lease expired. Resume publication to acquire a new fence.",
      );
    const next: Data = {
      ...op,
      expiresAt,
      updatedAt: now,
      revision: op.revision + 1,
    };
    const pass = await publicationPass(tx, op, (fixtureId) =>
      eventPayload(tx, d, draft, current, fixtureId, op.actorUid),
    );
    Object.assign(next, pass, {
      expiresAt,
      updatedAt: now,
      revision: op.revision + 1,
    });
    if (pass.state === "committed") {
      next.state = "committed";
      next.committedAt = now;
      tx.create(db().doc(`organizations/${d.orgId}/outbox/${d.operationId}`), {
        schemaVersion: 2,
        orgId: d.orgId,
        operationId: d.operationId,
        sourceType: "schedulePublication",
        sourceId: d.draftId,
        sourceRevision: op.draftRevision,
        revision: 1,
        state: "pending",
        templateKey: "schedulePublished",
        createdAt: now,
        updatedAt: now,
        auditCorrelationId: d.operationId,
      });
    }
    audit(
      tx,
      d.orgId,
      uid,
      "advanceSchedulePublication",
      d.operationId,
      next.revision,
    );
    tx.update(ref, { ...next, updatedBy: uid });
    tx.update(lockRef(d.orgId), {
      expiresAt,
      ...(next.state === "committed"
        ? {
            operationId: null,
            inputRevision: op.inputRevision + 1,
            visibilityRevision: (lock?.visibilityRevision ?? 0) + 1,
          }
        : {}),
    });
    return progress(next);
  },
);
