import {
  FieldPath,
  getFirestore,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  revision,
  text,
} from "../commandSupport";
import { readCommand, page } from "../participants/policy";
import { checkRevision, denied, eventScope } from "./access";
import { cacheDocumentReads } from "./reads";
import { validateStoredEvent } from "../organizations/events";
import { publishedEvent } from "../scheduling/visibility";
import { requireOpenInterval } from "../facilities/closures";

const db = () => getFirestore();
const exhausted = () => {
  throw new HttpsError(
    "resource-exhausted",
    "Completion supports at most 200 retained roster entries. Ask your administrator for a reviewed bulk completion.",
  );
};
async function eventFor(
  tx: Transaction,
  eventId: string,
  teamId: string,
  uid: string,
  writing = false,
) {
  const event = (await tx.get(db().doc(`events/${eventId}`))).data();
  if (
    !event ||
    event.schemaVersion !== 2 ||
    !Array.isArray(event.teamIds) ||
    !event.teamIds.includes(teamId) ||
    !(await publishedEvent(tx, event))
  )
    denied();
  // Validate every reference, but authority is only for the requested private team roster.
  const scope = await attendanceScope(tx, teamId, uid, writing);
  const teams = await tx.getAll(
    ...event.teamIds.map((t: string) =>
      db().doc(`teams/${id(t, "stored teamId")}`),
    ),
  );
  if (
    teams.some(
      (t) =>
        t.data()?.schemaVersion !== 2 ||
        t.data()?.orgId !== event.orgId ||
        t.data()?.programId !== event.programId ||
        t.data()?.seasonId !== event.seasonId,
    )
  )
    denied();
  validateStoredEvent(
    { ...event, publicationOperationId: null },
    { ...scope, teamIds: event.teamIds, teams: teams.map((t) => t.data()!) },
  );
  return event;
}
async function attendanceScope(
  tx: Transaction,
  teamId: string,
  uid: string,
  writing = false,
) {
  const scope = await eventScope(tx, [teamId], uid, writing);
  const grant = (
    await tx.get(db().doc(`organizations/${scope.orgId}/members/${uid}`))
  ).data();
  const staff =
    grant?.status === "active" &&
    grant.orgId === scope.orgId &&
    Array.isArray(grant.roles) &&
    Array.isArray(grant.programIds) &&
    (grant.roles.includes("orgAdmin") ||
      (grant.roles.includes("programStaff") &&
        grant.programIds.includes(scope.programId)));
  if (!staff) {
    const coach = (
      await tx.get(db().doc(`teamMembers/${teamId}_${uid}`))
    ).data();
    if (!Array.isArray(coach?.roles) || !coach.roles.includes("coach"))
      denied();
  }
  return scope;
}
function rosterValid(
  row: Data | undefined,
  orgId: string,
  participantId: string,
) {
  return (
    row?.schemaVersion === 2 &&
    row.orgId === orgId &&
    row.participantId === participantId &&
    ["active", "removed"].includes(row.status)
  );
}
function participantValid(row: Data | undefined, orgId: string) {
  return row?.schemaVersion === 2 && (row.orgId == null || row.orgId === orgId);
}
/** Prepare all reads before any lifecycle writes. A single transaction freezes the denominator. */
export async function prepareRosterSnapshot(
  tx: Transaction,
  eventId: string,
  event: Data,
  actorUid: string,
  capturedRevision: number,
  now: Timestamp,
) {
  const participants = new Map<string, Data>();
  let scanned = 0;
  for (const teamId of event.teamIds) {
    const roster = await tx.get(
      db()
        .collection(`teams/${teamId}/roster`)
        .orderBy(FieldPath.documentId())
        .limit(201),
    );
    scanned += roster.size;
    if (scanned > 200) exhausted();
    for (const doc of roster.docs) {
      const r = doc.data();
      if (!rosterValid(r, event.orgId, doc.id)) denied();
      let item = participants.get(doc.id);
      if (!item) {
        const p = (
          await tx.get(
            db().doc(`organizations/${event.orgId}/participants/${doc.id}`),
          )
        ).data();
        if (!participantValid(p, event.orgId)) denied();
        item = {
          schemaVersion: 2,
          orgId: event.orgId,
          eventId,
          participantId: doc.id,
          displayName: p!.displayName,
          participantStatus: p!.status,
          teamIds: [],
          enrollments: [],
          eligible: false,
          capturedRevision,
          scheduleVersion: event.scheduleVersion ?? 1,
          capturedAt: now,
          recordedBy: actorUid,
          auditCorrelationId: `${eventId}:completion:${capturedRevision}`,
        };
        participants.set(doc.id, item);
      }
      const eligible =
        r.status === "active" && item.participantStatus === "active";
      item.teamIds.push(teamId);
      item.enrollments.push({
        teamId,
        status: r.status,
        eligible,
        revision: r.revision ?? 0,
        joinedAt: r.joinedAt ?? null,
        removedAt: r.removedAt ?? null,
      });
      item.eligible ||= eligible;
    }
  }
  const rows = [...participants.values()];
  return {
    metadata: {
      schemaVersion: 2,
      capturedRevision,
      scheduleVersion: event.scheduleVersion ?? 1,
      capturedAt: now,
      participantCount: rows.length,
      eligibleCount: rows.filter((r) => r.eligible).length,
    },
    write: () => {
      for (const row of rows)
        tx.create(
          db().doc(`events/${eventId}/rosterSnapshots/${row.participantId}`),
          row,
        );
    },
  };
}
function enrollmentFromRows(
  event: Data,
  teamId: string,
  participantId: string,
  rosterOrSnapshot: Data | undefined,
  participant?: Data,
) {
  if (event.status === "completed") {
    const snap = rosterOrSnapshot;
    if (
      !snap ||
      !event.rosterSnapshot ||
      snap.capturedRevision !== event.rosterSnapshot.capturedRevision ||
      snap.orgId !== event.orgId
    )
      denied();
    const e = snap.enrollments?.find((e: Data) => e.teamId === teamId);
    if (!e) denied();
    return { row: snap!, eligible: e.eligible === true };
  }
  const r = rosterOrSnapshot;
  const p = participant;
  if (
    !rosterValid(r, event.orgId, participantId) ||
    !participantValid(p, event.orgId)
  )
    denied();
  return {
    row: { ...r, displayName: p!.displayName },
    eligible: r!.status === "active" && p!.status === "active",
  };
}
async function enrollment(
  tx: Transaction,
  event: Data,
  eventId: string,
  teamId: string,
  participantId: string,
) {
  if (event.status === "completed") {
    const snapshot = (
      await tx.get(
        db().doc(`events/${eventId}/rosterSnapshots/${participantId}`),
      )
    ).data();
    return enrollmentFromRows(
      event,
      teamId,
      participantId,
      snapshot,
    );
  }
  const [roster, participant] = await tx.getAll(
    db().doc(`teams/${teamId}/roster/${participantId}`),
    db().doc(`organizations/${event.orgId}/participants/${participantId}`),
  );
  return enrollmentFromRows(
    event,
    teamId,
    participantId,
    roster.data(),
    participant.data(),
  );
}
function attendance(row: Data | undefined, version: number) {
  return {
    status: row?.scheduleVersion === version ? row.status : "unknown",
    revision: row?.revision ?? 0,
    previousStatus: row && row.scheduleVersion !== version ? row.status : null,
    recordedBy: row?.recordedBy ?? null,
    recordedAt: row?.updatedAt ?? null,
    source: row?.source ?? null,
    correctionReason: row?.correctionReason ?? null,
  };
}
export const getEventAttendance = readCommand(
  (data) => {
    keys(data, ["eventId", "teamId", "cursor", "pageSize"]);
    return {
      eventId: id(data.eventId, "eventId"),
      teamId: id(data.teamId, "teamId"),
      ...page(data),
    };
  },
  async (tx, data, uid) => {
    tx = cacheDocumentReads(tx);
    const event = await eventFor(tx, data.eventId, data.teamId, uid);
    let query =
      event.status === "completed"
        ? db()
            .collection(`events/${data.eventId}/rosterSnapshots`)
            .where("teamIds", "array-contains", data.teamId)
        : db().collection(`teams/${data.teamId}/roster`);
    query = query.orderBy(FieldPath.documentId());
    if (data.cursor) query = query.startAfter(data.cursor);
    const rows = await tx.get(query.limit(data.pageSize + 1));
    const version = event.scheduleVersion ?? 1;
    let canWrite = true;
    try {
      await attendanceScope(tx, data.teamId, uid, true);
    } catch (e) {
      if (
        !(e instanceof HttpsError) ||
        !["permission-denied", "failed-precondition"].includes(e.code)
      )
        throw e;
      canWrite = false;
    }
    const org = (await tx.get(db().doc(`organizations/${event.orgId}`))).data();
    canWrite &&=
      org?.features?.attendance === true &&
      ["scheduled", "completed"].includes(event.status);
    if (canWrite) {
      try {
        await requireOpenInterval(tx, event);
      } catch (e) {
        if (!(e instanceof HttpsError) || e.code !== "failed-precondition")
          throw e;
        canWrite = false;
      }
    }
    const pageRows = rows.docs.slice(0, data.pageSize);
    const detailRefs = pageRows.flatMap((doc) => [
      ...(event.status === "completed"
        ? []
        : [
            db().doc(
              `organizations/${event.orgId}/participants/${doc.id}`,
            ),
          ]),
      db().doc(`events/${data.eventId}/attendance/${doc.id}`),
      db().doc(`events/${data.eventId}/availability/${doc.id}`),
    ]);
    const detailSnapshots = detailRefs.length
      ? await tx.getAll(...detailRefs)
      : [];
    const details = new Map(
      detailSnapshots.map((snapshot) => [snapshot.ref.path, snapshot.data()]),
    );
    const items = [];
    for (const doc of pageRows) {
      const enrolled = enrollmentFromRows(
        event,
        data.teamId,
        doc.id,
        doc.data(),
        details.get(
          `organizations/${event.orgId}/participants/${doc.id}`,
        ),
      );
      const row = details.get(
        `events/${data.eventId}/attendance/${doc.id}`,
      );
      const intended = details.get(
        `events/${data.eventId}/availability/${doc.id}`,
      );
      items.push({
        participantId: doc.id,
        displayName: enrolled.row.displayName,
        eligible: enrolled.eligible,
        rosterStatus:
          event.status === "completed"
            ? enrolled.row.enrollments.find(
                (e: Data) => e.teamId === data.teamId,
              ).status
            : enrolled.row.status,
        canRecord: canWrite && (enrolled.eligible || !!row),
        intended: !intended
          ? "unanswered"
          : intended.scheduleVersion === version
            ? intended.status
            : "needsReconfirmation",
        ...attendance(row, version),
      });
    }
    return {
      eventId: data.eventId,
      teamId: data.teamId,
      eventRevision: event.revision,
      scheduleVersion: version,
      status: event.status,
      timeZone: event.timeZone,
      snapshot: event.rosterSnapshot
        ? {
            schemaVersion: 2,
            capturedRevision: event.rosterSnapshot.capturedRevision,
            scheduleVersion: event.rosterSnapshot.scheduleVersion,
            capturedAt: event.rosterSnapshot.capturedAt,
          }
        : null,
      items,
      nextCursor:
        rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null,
    };
  },
);
export const recordEventAttendance = command(
  "recordEventAttendance",
  (data) => {
    keys(data, [
      "requestId",
      "eventId",
      "teamId",
      "participantId",
      "expectedRevision",
      "eventRevision",
      "scheduleVersion",
      "status",
      "reason",
    ]);
    if (
      !["unknown", "present", "late", "absent", "excused"].includes(data.status)
    )
      invalid("Invalid attendance status.");
    return {
      eventId: id(data.eventId, "eventId"),
      teamId: id(data.teamId, "teamId"),
      participantId: id(data.participantId, "participantId"),
      expectedRevision: revision(data.expectedRevision),
      eventRevision: revision(data.eventRevision),
      scheduleVersion: revision(data.scheduleVersion),
      status: data.status,
      reason:
        data.reason == null || data.reason === ""
          ? null
          : text(data.reason, "correction reason", 500),
    };
  },
  async (tx, data, uid, _actor, replay) => {
    const event = await eventFor(tx, data.eventId, data.teamId, uid, !replay);
    const enrolled = await enrollment(
      tx,
      event,
      data.eventId,
      data.teamId,
      data.participantId,
    );
    const ref = db().doc(
      `events/${data.eventId}/attendance/${data.participantId}`,
    );
    const before = (await tx.get(ref)).data();
    if (!enrolled.eligible && !before) denied();
    if (replay) return replay;
    const org = (await tx.get(db().doc(`organizations/${event.orgId}`))).data();
    if (org?.features?.attendance !== true)
      throw new HttpsError(
        "failed-precondition",
        "Attendance recording is not enabled.",
      );
    if (!["scheduled", "completed"].includes(event.status))
      throw new HttpsError(
        "failed-precondition",
        "Attendance is closed for this event.",
      );
    await requireOpenInterval(tx, event);
    checkRevision(event, data.eventRevision);
    checkRevision(before, data.expectedRevision);
    if (data.scheduleVersion !== (event.scheduleVersion ?? 1))
      throw new HttpsError("aborted", "Reload the changed schedule.", {
        domainCode: "SCHEDULE_CHANGED",
      });
    if ((before || event.status === "completed") && !data.reason)
      invalid("A correction reason is required.");
    const now = Timestamp.now();
    const next = {
      schemaVersion: 2,
      orgId: event.orgId,
      eventId: data.eventId,
      participantId: data.participantId,
      status: data.status,
      source: "coach",
      recordedBy: uid,
      teamId: data.teamId,
      revision: (before?.revision ?? 0) + 1,
      scheduleVersion: data.scheduleVersion,
      eventRevision: event.revision,
      correctionReason: data.reason,
      previousStatus: before?.status ?? "unknown",
      previousScheduleVersion: before?.scheduleVersion ?? null,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      auditCorrelationId: `${data.eventId}:${data.participantId}:${(before?.revision ?? 0) + 1}`,
    };
    tx.set(ref, next);
    tx.create(ref.collection("history").doc(String(next.revision)), next);
    return { participantId: data.participantId, revision: next.revision };
  },
);
export const getAttendanceHistory = readCommand(
  (data) => {
    keys(data, ["eventId", "teamId", "participantId", "cursor", "pageSize"]);
    return {
      eventId: id(data.eventId, "eventId"),
      teamId: id(data.teamId, "teamId"),
      participantId: id(data.participantId, "participantId"),
      ...page(data),
    };
  },
  async (tx, data, uid) => {
    tx = cacheDocumentReads(tx);
    const event = await eventFor(tx, data.eventId, data.teamId, uid);
    await enrollment(tx, event, data.eventId, data.teamId, data.participantId);
    if (
      data.cursor &&
      (!/^[1-9][0-9]*$/.test(data.cursor) ||
        !Number.isSafeInteger(Number(data.cursor)))
    )
      invalid("Invalid history cursor.");
    let query = db()
      .collection(
        `events/${data.eventId}/attendance/${data.participantId}/history`,
      )
      .orderBy("revision");
    if (data.cursor) query = query.startAfter(Number(data.cursor));
    const rows = await tx.get(query.limit(data.pageSize + 1));
    return {
      items: rows.docs.slice(0, data.pageSize).map((d) => {
        const r = d.data();
        return {
          revision: r.revision,
          status: r.status,
          previousStatus: r.previousStatus,
          recordedBy: r.recordedBy,
          recordedAt: r.updatedAt,
          source: r.source,
          reason: r.correctionReason,
          scheduleVersion: r.scheduleVersion,
        };
      }),
      nextCursor:
        rows.size > data.pageSize
          ? String(rows.docs[data.pageSize - 1].data().revision)
          : null,
    };
  },
);
