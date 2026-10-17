import {
  FieldPath,
  getFirestore,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { command, Data, id, invalid, keys, revision } from "../commandSupport";
import { checkRevision, denied, eventScope, hierarchy } from "./access";
import { householdAccess, metadata, readCommand } from "../participants/policy";
import { readAgenda } from "../calendar/agenda";
import { publishedEvent } from "../scheduling/visibility";
import { effectiveEvent } from "../facilities/closures";
import { cacheDocumentReads } from "./reads";

async function eventFor(tx: Transaction, eventId: string) {
  const event = (await tx.get(getFirestore().doc(`events/${eventId}`))).data();
  if (!event || event.schemaVersion !== 2 || !(await publishedEvent(tx, event)))
    denied();
  if (
    !Array.isArray(event.teamIds) ||
    !event.teamIds.length ||
    event.teamIds.length > 20 ||
    new Set(event.teamIds).size !== event.teamIds.length ||
    event.teamId !== event.teamIds[0]
  )
    denied();
  const teams: Data[] = [];
  for (const teamId of event.teamIds) {
    const team = (
      await tx.get(getFirestore().doc(`teams/${id(teamId, "teamId")}`))
    ).data();
    if (
      !team ||
      team.schemaVersion !== 2 ||
      team.orgId !== event.orgId ||
      team.programId !== event.programId ||
      team.seasonId !== event.seasonId ||
      (event.divisionId != null && team.divisionId !== event.divisionId)
    )
      denied();
    const parents = await hierarchy(
      tx,
      event.orgId,
      event.programId,
      event.seasonId,
      team.divisionId,
      false,
    );
    if (
      parents.org.features?.organizationV2 !== true ||
      parents.org.features?.households !== true
    )
      denied();
    teams.push({
      ...team,
      id: teamId,
      archived: [
        team,
        parents.org,
        parents.program,
        parents.season,
        parents.division,
      ].some((row) => row?.status !== "active"),
    });
  }
  return { event: await effectiveEvent(tx, event), teams };
}
function deadline(event: Data): Timestamp {
  return event.rsvpDeadline ?? event.startsAt;
}
function closedReason(event: Data, archived: boolean): string | null {
  if (archived) return "This team or season is archived. Responses are closed.";
  if (event.resourceClosed || event.status !== "scheduled")
    return "Responses are closed while this event is not scheduled or its resource is closed.";
  if (Timestamp.now().toMillis() >= deadline(event).toMillis())
    return "The RSVP deadline has passed. Responses are closed.";
  return null;
}
async function eligible(
  tx: Transaction,
  event: Data,
  teams: Data[],
  participantId: string,
  uid: string,
  responding = false,
) {
  const access = await householdAccess(
    tx,
    event.orgId,
    participantId,
    uid,
    "viewSchedule",
  );
  const rosters = await tx.getAll(
    ...teams.map((team) =>
      getFirestore().doc(`teams/${team.id}/roster/${participantId}`),
    ),
  );
  const enrolled = teams.filter((team, i) => {
    const row = rosters[i].data();
    return (
      row?.schemaVersion === 2 &&
      row.orgId === event.orgId &&
      row.participantId === participantId &&
      row.status === "active"
    );
  });
  if (!enrolled.length) denied();
  const canRespond =
    access.self ||
    (access.guardian?.status === "active" &&
      access.guardian.permissions?.respond === true);
  if (responding && !canRespond) denied();
  return { access, enrolled, canRespond };
}
function response(row: Data | undefined, event: Data, uid: string): Data {
  const needsReconfirmation =
    !!row && row.scheduleVersion !== (event.scheduleVersion ?? 1);
  return {
    revision: row?.revision ?? 0,
    status: !row
      ? "unanswered"
      : needsReconfirmation
        ? "needsReconfirmation"
        : row.status,
    previousStatus: needsReconfirmation ? row!.status : null,
    lateNote: row?.lateNote ?? null,
    scheduleVersion: row?.scheduleVersion ?? null,
    updatedAt: row?.updatedAt ?? null,
    actor: !row
      ? null
      : row.actorUid === uid
        ? "You"
        : row.actorRelationship === "self"
          ? "Participant"
          : "Another guardian",
  };
}
export const getEventAvailability = readCommand(
  (data) => {
    keys(data, ["eventId"]);
    return { eventId: id(data.eventId, "eventId") };
  },
  async (tx, data, uid) => {
    tx = cacheDocumentReads(tx);
    const { event, teams } = await eventFor(tx, data.eventId);
    const agenda = await readAgenda(tx, {}, uid, { events: false });
    const candidates = new Set<string>();
    for (const team of agenda.teams)
      if (teams.some((t) => t.id === team.id && t.orgId === team.orgId)) {
        for (const p of team.participants) candidates.add(p.participantId);
      }
    const items: Data[] = [];
    for (const participantId of candidates) {
      const { access, enrolled, canRespond } = await eligible(
        tx,
        event,
        teams,
        participantId,
        uid,
      );
      const row = (
        await tx.get(
          getFirestore().doc(
            `events/${data.eventId}/availability/${participantId}`,
          ),
        )
      ).data();
      const reason = closedReason(
        event,
        enrolled.some((t) => t.archived),
      );
      items.push({
        participantId,
        displayName: access.row.displayName,
        relationship: access.self ? "self" : "guardian",
        teams: enrolled.map((t) => ({ id: t.id, name: t.name })),
        canRespond: canRespond && !reason,
        closedReason:
          reason ?? (!canRespond ? "Your guardian access is view only." : null),
        ...response(row, event, uid),
      });
    }
    // Only authorized team staff receive aggregates, never the opposing private roster.
    const summaries: Data[] = [];
    let totalRoster = 0;
    for (const team of teams) {
      try {
        await eventScope(tx, [team.id], uid, false);
      } catch (error) {
        if (error instanceof HttpsError && error.code === "permission-denied")
          continue;
        throw error;
      }
      const roster = await tx.get(
        getFirestore()
          .collection(`teams/${team.id}/roster`)
          .where("status", "==", "active")
          .orderBy(FieldPath.documentId())
          .limit(201),
      );
      totalRoster += roster.size;
      if (totalRoster > 200)
        throw new HttpsError(
          "resource-exhausted",
          "This team needs a paged availability summary. Contact your administrator.",
        );
      const counts: Data = {
        yes: 0,
        no: 0,
        maybe: 0,
        unanswered: 0,
        needsReconfirmation: 0,
      };
      for (const doc of roster.docs) {
        const r = doc.data();
        if (
          r.schemaVersion !== 2 ||
          r.orgId !== event.orgId ||
          r.participantId !== doc.id
        )
          continue;
        const p = (
          await tx.get(
            getFirestore().doc(
              `organizations/${event.orgId}/participants/${doc.id}`,
            ),
          )
        ).data();
        if (
          p?.schemaVersion !== 2 ||
          p.status !== "active" ||
          (p.orgId != null && p.orgId !== event.orgId)
        )
          continue;
        const row = (
          await tx.get(
            getFirestore().doc(`events/${data.eventId}/availability/${doc.id}`),
          )
        ).data();
        counts[response(row, event, uid).status]++;
      }
      summaries.push({ teamId: team.id, teamName: team.name, counts });
    }
    if (!items.length && !summaries.length) denied();
    let canManage = false;
    try {
      await eventScope(tx, event.teamIds, uid);
      canManage = event.status === "scheduled" && !event.resourceClosed;
    } catch (error) {
      if (
        !(error instanceof HttpsError) ||
        !["permission-denied", "failed-precondition"].includes(error.code)
      )
        throw error;
    }
    return {
      eventId: data.eventId,
      canManage,
      eventRevision: event.revision,
      scheduleVersion: event.scheduleVersion ?? 1,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone,
      deadline: deadline(event),
      items,
      summaries,
    };
  },
);
export const respondToEvent = command(
  "respondToEvent",
  (data) => {
    keys(data, [
      "requestId",
      "eventId",
      "participantId",
      "expectedRevision",
      "scheduleVersion",
      "status",
      "lateNote",
    ]);
    if (!["yes", "no", "maybe"].includes(data.status))
      invalid("Choose yes, no or maybe.");
    if (
      data.lateNote != null &&
      (typeof data.lateNote !== "string" || data.lateNote.trim().length > 240)
    )
      invalid("Late note must be at most 240 characters.");
    return {
      eventId: id(data.eventId, "eventId"),
      participantId: id(data.participantId, "participantId"),
      expectedRevision: revision(data.expectedRevision),
      scheduleVersion: revision(data.scheduleVersion),
      status: data.status,
      lateNote: data.lateNote?.trim() || null,
    };
  },
  async (tx, data, uid, _actor, replay) => {
    const { event, teams } = await eventFor(tx, data.eventId);
    const { access, enrolled } = await eligible(
      tx,
      event,
      teams,
      data.participantId,
      uid,
      true,
    );
    // Replays still require current publication, household and roster access. A committed response remains a receipt after deadline/reschedule.
    if (replay) return replay;
    const reason = closedReason(
      event,
      enrolled.some((t) => t.archived),
    );
    if (reason)
      throw new HttpsError("failed-precondition", reason, {
        domainCode: "RSVP_CLOSED",
      });
    if (data.scheduleVersion !== (event.scheduleVersion ?? 1))
      throw new HttpsError(
        "aborted",
        "The schedule changed. Reload and reconfirm for the new time.",
        { domainCode: "SCHEDULE_CHANGED" },
      );
    const ref = getFirestore().doc(
      `events/${data.eventId}/availability/${data.participantId}`,
    );
    const before = (await tx.get(ref)).data();
    checkRevision(before, data.expectedRevision);
    const next: Data = {
      ...metadata(uid, before),
      orgId: event.orgId,
      eventId: data.eventId,
      participantId: data.participantId,
      status: data.status,
      lateNote: data.lateNote,
      scheduleVersion: data.scheduleVersion,
      actorUid: uid,
      actorRelationship: access.self ? "self" : "guardian",
      auditCorrelationId: `${data.eventId}:${data.participantId}:${(before?.revision ?? 0) + 1}`,
    };
    tx.set(ref, next);
    tx.create(ref.collection("history").doc(String(next.revision)), next);
    return {
      participantId: data.participantId,
      revision: next.revision,
      scheduleVersion: data.scheduleVersion,
    };
  },
);
export const setEventRsvpDeadline = command(
  "setEventRsvpDeadline",
  (data) => {
    keys(data, ["requestId", "eventId", "expectedRevision", "deadline"]);
    if (
      data.deadline != null &&
      (typeof data.deadline !== "string" ||
        !Number.isFinite(Date.parse(data.deadline)) ||
        new Date(data.deadline).toISOString() !== data.deadline)
    )
      invalid("Use a UTC deadline instant.");
    return {
      eventId: id(data.eventId, "eventId"),
      expectedRevision: revision(data.expectedRevision),
      deadline: data.deadline ?? null,
    };
  },
  async (tx, data, uid, _actor, replay) => {
    const { event } = await eventFor(tx, data.eventId);
    await eventScope(tx, event.teamIds, uid, !replay);
    if (replay) return replay;
    checkRevision(event, data.expectedRevision);
    if (event.status !== "scheduled" || event.resourceClosed)
      throw new HttpsError(
        "failed-precondition",
        "Only open scheduled events allow deadline edits.",
      );
    const value = data.deadline
      ? Timestamp.fromDate(new Date(data.deadline))
      : null;
    if (value && value.toMillis() > event.startsAt.toMillis())
      invalid("The deadline must be at or before event start.");
    const nextRevision = event.revision + 1;
    const ref = getFirestore().doc(`events/${data.eventId}`);
    tx.update(ref, {
      rsvpDeadline: value,
      revision: nextRevision,
      updatedAt: Timestamp.now(),
      updatedBy: uid,
    });
    tx.create(ref.collection("rsvpPolicyHistory").doc(String(nextRevision)), {
      schemaVersion: 2,
      revision: nextRevision,
      previousDeadline: event.rsvpDeadline ?? null,
      deadline: value,
      actorUid: uid,
      createdAt: Timestamp.now(),
      auditCorrelationId: `${ref.id}:${nextRevision}`,
    });
    return { id: ref.id, revision: nextRevision };
  },
);
