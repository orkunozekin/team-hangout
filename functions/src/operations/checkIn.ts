import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  object,
  revision,
} from "../commandSupport";
import { readCommand } from "../participants/policy";
import { householdEvent, eligibleHousehold } from "./availability";
import { checkRevision, eventScope } from "./access";
import { requireOpenInterval } from "../facilities/closures";
import { checkInPolicy, locationOutcome } from "./checkInPolicy";

import { cacheDocumentReads } from "./reads";
const db = () => getFirestore();
function identity(data: Data) {
  return {
    eventId: id(data.eventId, "eventId"),
    participantId: id(data.participantId, "participantId"),
  };
}
async function context(
  tx: Parameters<typeof householdEvent>[0],
  data: Data,
  uid: string,
) {
  const { event, teams } = await householdEvent(tx, data.eventId);
  const allowed = await eligibleHousehold(
    tx,
    event,
    teams,
    data.participantId,
    uid,
    true,
  );
  const policy = checkInPolicy(event.checkInPolicy);
  const now = Timestamp.now().toMillis();
  const starts = event.startsAt.toMillis();
  const reason =
    allowed.access.organization.features?.attendance !== true
      ? "Check-in is not enabled. Ask your coach for manual attendance."
      : event.status !== "scheduled" ||
          event.resourceClosed ||
          allowed.enrolled.some((t) => t.archived)
        ? "Check-in is closed for this event. Ask your coach for help."
        : now < starts - policy.beforeMinutes * 60000 ||
            now > starts + policy.afterMinutes * 60000
          ? "Outside the check-in window. Ask your coach for manual attendance."
          : null;
  const locationEnabled =
    allowed.access.organization.features?.locationAssistance === true &&
    policy.locationEnabled;
  return { event, allowed, policy, reason, locationEnabled };
}
export const getParticipantCheckIn = readCommand(
  (data) => {
    keys(data, ["eventId", "participantId"]);
    return identity(data);
  },
  async (tx, data, uid) => {
    tx = cacheDocumentReads(tx);
    const { event, policy, reason, locationEnabled } = await context(
      tx,
      data,
      uid,
    );
    const row = (
      await tx.get(
        db().doc(`events/${data.eventId}/attendance/${data.participantId}`),
      )
    ).data();
    const current = row?.scheduleVersion === (event.scheduleVersion ?? 1);
    return {
      ...data,
      eventRevision: event.revision,
      scheduleVersion: event.scheduleVersion ?? 1,
      attendanceRevision: row?.revision ?? 0,
      status: current ? row!.status : "unknown",
      source: current ? row!.source : null,
      policy,
      locationEnabled,
      closedReason:
        reason ??
        (current && row
          ? "Attendance is already recorded. Ask your coach for corrections."
          : null),
    };
  },
);
export const checkInParticipant = command(
  "checkInParticipant",
  (data) => {
    keys(data, [
      "requestId",
      "eventId",
      "participantId",
      "eventRevision",
      "scheduleVersion",
      "expectedRevision",
      "method",
      "sample",
    ]);
    if (!["simple", "location"].includes(data.method))
      invalid("Choose a check-in method.");
    if (data.method === "simple" && data.sample != null)
      invalid("Simple check-in does not accept location.");
    let sample = null;
    if (data.method === "location") {
      const value = object(data.sample);
      keys(value, ["latitude", "longitude", "accuracy", "timestamp"]);
      sample = {
        latitude: value.latitude,
        longitude: value.longitude,
        accuracy: value.accuracy,
        timestamp: value.timestamp,
      };
      if (
        Object.values(sample).some(
          (v) => typeof v !== "number" || !Number.isFinite(v),
        ) ||
        Math.abs(sample.latitude) > 90 ||
        Math.abs(sample.longitude) > 180 ||
        sample.accuracy <= 0
      )
        invalid(
          "Invalid location sample. Use simple check-in or ask your coach.",
        );
    }
    return {
      ...identity(data),
      eventRevision: revision(data.eventRevision),
      scheduleVersion: revision(data.scheduleVersion),
      expectedRevision: revision(data.expectedRevision),
      method: data.method,
      sample,
    };
  },
  async (tx, data, uid, _actor, replay) => {
    const { event, allowed, policy, reason, locationEnabled } = await context(
      tx,
      data,
      uid,
    );
    // Receipt replay rechecks live household, enrollment and publication authority first.
    if (replay) return replay;
    if (reason) throw new HttpsError("failed-precondition", reason);
    checkRevision(event, data.eventRevision);
    if (data.scheduleVersion !== (event.scheduleVersion ?? 1))
      throw new HttpsError("aborted", "Schedule changed. Reload check-in.");
    await requireOpenInterval(tx, event);
    const now = Timestamp.now();
    if (data.method === "location") {
      if (!locationEnabled)
        throw new HttpsError(
          "failed-precondition",
          "Location assistance is disabled. Use simple check-in.",
        );
      const outcome = locationOutcome(
        data.sample,
        event.resourceDetails,
        now.toMillis(),
        policy.radiusMeters,
      );
      if (outcome) throw new HttpsError("failed-precondition", outcome);
    }
    const ref = db().doc(
      `events/${data.eventId}/attendance/${data.participantId}`,
    );
    const before = (await tx.get(ref)).data();
    checkRevision(before, data.expectedRevision);
    if (before?.scheduleVersion === data.scheduleVersion)
      throw new HttpsError(
        "failed-precondition",
        "Attendance is already recorded. Ask your coach for corrections.",
      );
    const next = {
      schemaVersion: 2,
      orgId: event.orgId,
      eventId: data.eventId,
      participantId: data.participantId,
      teamId: allowed.enrolled[0].id,
      status: "present",
      source: allowed.access.self ? "self" : "guardian",
      method: data.method,
      assistanceOutcome:
        data.method === "location" ? "within-pilot-radius" : "self-asserted",
      recordedBy: uid,
      revision: (before?.revision ?? 0) + 1,
      scheduleVersion: data.scheduleVersion,
      eventRevision: event.revision,
      previousStatus: before?.status ?? "unknown",
      previousScheduleVersion: before?.scheduleVersion ?? null,
      correctionReason: before
        ? "Participant check-in for changed schedule"
        : null,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
      auditCorrelationId: `${data.eventId}:${data.participantId}:${(before?.revision ?? 0) + 1}`,
    };
    tx.set(ref, next);
    tx.create(ref.collection("history").doc(String(next.revision)), next);
    return {
      participantId: data.participantId,
      revision: next.revision,
      status: "present",
      method: data.method,
    };
  },
);
export const setEventCheckInPolicy = command(
  "setEventCheckInPolicy",
  (data) => {
    keys(data, ["requestId", "eventId", "expectedRevision", "policy"]);
    const policy = object(data.policy);
    keys(policy, [
      "beforeMinutes",
      "afterMinutes",
      "radiusMeters",
      "locationEnabled",
    ]);
    if (
      !Number.isInteger(policy.beforeMinutes) ||
      policy.beforeMinutes < 0 ||
      policy.beforeMinutes > 120 ||
      !Number.isInteger(policy.afterMinutes) ||
      policy.afterMinutes < 0 ||
      policy.afterMinutes > 240 ||
      !Number.isInteger(policy.radiusMeters) ||
      policy.radiusMeters < 50 ||
      policy.radiusMeters > 1000 ||
      typeof policy.locationEnabled !== "boolean"
    )
      invalid(
        "Use before 0–120 minutes, after 0–240 minutes and radius 50–1000 meters.",
      );
    return {
      eventId: id(data.eventId, "eventId"),
      expectedRevision: revision(data.expectedRevision),
      policy,
    };
  },
  async (tx, data, uid, _actor, replay) => {
    const { event } = await householdEvent(tx, data.eventId);
    await eventScope(tx, event.teamIds, uid, !replay);
    if (replay) return replay;
    checkRevision(event, data.expectedRevision);
    if (event.status !== "scheduled" || event.resourceClosed)
      throw new HttpsError(
        "failed-precondition",
        "Check-in policy is closed for this event.",
      );
    const ref = db().doc(`events/${data.eventId}`),
      now = Timestamp.now(),
      nextRevision = event.revision + 1;
    tx.update(ref, {
      checkInPolicy: data.policy,
      revision: nextRevision,
      updatedAt: now,
      updatedBy: uid,
    });
    tx.create(
      ref.collection("checkInPolicyHistory").doc(String(nextRevision)),
      {
        schemaVersion: 2,
        previous: event.checkInPolicy ?? null,
        policy: data.policy,
        actorUid: uid,
        createdAt: now,
        revision: nextRevision,
      },
    );
    return { id: ref.id, revision: nextRevision };
  },
);
