import { getFirestore, Transaction } from "firebase-admin/firestore";
import { Data } from "../commandSupport";
import { effectiveEvent } from "../facilities/closures";
import { publishedEvent } from "../scheduling/visibility";
import {
  isCurrentResponse,
  RSVP_REMINDER_MIN_REMAINING_MS,
  rsvpReminderKey,
} from "./reminderPlan";

export type HouseholdSource = {
  kind: "household";
  teamId: string;
  participantId: string;
};
export type ReminderRecipient = { uid: string; accessSources: HouseholdSource[] };

const MAX_TEAMS = 20;
const MAX_ROSTER = 50;
const MAX_GUARDIANS = 10;
const MAX_RECIPIENTS = 200;
const MAX_SOURCES = 50;

function addRecipient(
  map: Map<string, ReminderRecipient>,
  uid: unknown,
  source: HouseholdSource,
) {
  if (typeof uid !== "string" || !uid) return;
  const current = map.get(uid) ?? { uid, accessSources: [] };
  if (
    !current.accessSources.some(
      (row) =>
        row.teamId === source.teamId && row.participantId === source.participantId,
    )
  ) {
    if (current.accessSources.length >= MAX_SOURCES)
      throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
    current.accessSources.push(source);
  }
  map.set(uid, current);
  if (map.size > MAX_RECIPIENTS) throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
}

async function canRespond(
  tx: Transaction,
  orgId: string,
  participantId: string,
  uid: string,
  participant: Data,
) {
  if (participant.linkedUserId === uid) return true;
  const grant = (
    await tx.get(
      getFirestore().doc(
        `organizations/${orgId}/participants/${participantId}/guardians/${uid}`,
      ),
    )
  ).data();
  return (
    grant?.status === "active" &&
    grant.orgId === orgId &&
    grant.participantId === participantId &&
    grant.userId === uid &&
    grant.permissions?.respond === true
  );
}

function recipientsOf(map: Map<string, ReminderRecipient>) {
  return [...map.values()].sort((a, b) => a.uid.localeCompare(b.uid));
}

/** Current roster only. Coaches, staff and view-only guardians are not reminder recipients. */
export async function collectReminderRecipients(
  tx: Transaction,
  event: Data,
  eventId: string,
) {
  const db = getFirestore();
  const teamIds = [...new Set<string>(event.teamIds ?? [])];
  if (!teamIds.length || teamIds.length > MAX_TEAMS)
    throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
  const teams = await tx.getAll(...teamIds.map((teamId) => db.doc(`teams/${teamId}`)));
  if (
    teams.some((team) => {
      const row = team.data();
      return !row || row.orgId !== event.orgId || row.schemaVersion !== 2 || row.status !== "active";
    })
  )
    throw new Error("NOTIFICATION_AUDIENCE_STALE");
  const map = new Map<string, ReminderRecipient>();
  const prepared = new Map<string, { linkedUserId: unknown; guardianIds: string[] } | null>();
  let rosterCount = 0;
  const scheduleVersion = event.scheduleVersion ?? 1;
  for (const teamId of teamIds) {
    const roster = await tx.get(
      db.collection(`teams/${teamId}/roster`).where("status", "==", "active").limit(MAX_ROSTER + 1),
    );
    rosterCount += roster.size;
    if (rosterCount > MAX_ROSTER) throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
    for (const enrollment of roster.docs) {
      const row = enrollment.data();
      if (
        row.orgId !== event.orgId ||
        row.participantId !== enrollment.id ||
        (row.teamId != null && row.teamId !== teamId)
      )
        throw new Error("NOTIFICATION_AUDIENCE_STALE");
      const source: HouseholdSource = {
        kind: "household",
        teamId,
        participantId: enrollment.id,
      };
      if (prepared.has(enrollment.id)) {
        const prior = prepared.get(enrollment.id);
        if (prior) {
          addRecipient(map, prior.linkedUserId, source);
          for (const guardianId of prior.guardianIds) addRecipient(map, guardianId, source);
        }
        continue;
      }
      const participant = (
        await tx.get(db.doc(`organizations/${event.orgId}/participants/${enrollment.id}`))
      ).data();
      if (!participant || participant.status !== "active" || (participant.orgId != null && participant.orgId !== event.orgId)) {
        prepared.set(enrollment.id, null);
        continue;
      }
      const availability = (
        await tx.get(db.doc(`events/${eventId}/availability/${enrollment.id}`))
      ).data();
      if (isCurrentResponse(availability, scheduleVersion)) {
        prepared.set(enrollment.id, null);
        continue;
      }
      const guardianIds: string[] = [];
      addRecipient(map, participant.linkedUserId, source);
      const guardians = await tx.get(
        db
          .collection(`organizations/${event.orgId}/participants/${enrollment.id}/guardians`)
          .where("status", "==", "active")
          .limit(MAX_GUARDIANS + 1),
      );
      if (guardians.size > MAX_GUARDIANS) throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
      for (const guardian of guardians.docs) {
        const grant = guardian.data();
        if (
          grant.orgId !== event.orgId ||
          grant.participantId !== enrollment.id ||
          grant.userId !== guardian.id ||
          grant.permissions?.respond !== true
        )
          continue;
        guardianIds.push(guardian.id);
        addRecipient(map, guardian.id, source);
      }
      prepared.set(enrollment.id, { linkedUserId: participant.linkedUserId, guardianIds });
    }
  }
  return recipientsOf(map);
}

function timestampMillis(value: { toMillis?: () => number } | null | undefined) {
  const millis = value?.toMillis?.();
  return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
}

/** A queued reminder may expand only while that same key is still eligible. */
async function reminderStillEligible(tx: Transaction, intent: Data, event: Data) {
  const organization = (
    await tx.get(getFirestore().doc(`organizations/${intent.orgId}`))
  ).data();
  if (organization?.features?.rsvpReminders !== true || organization.status !== "active")
    return false;
  if (!(await publishedEvent(tx, event))) return false;
  const effective = await effectiveEvent(tx, event);
  const deadlineMs = timestampMillis(effective.rsvpDeadline ?? effective.startsAt);
  if (
    effective.status !== "scheduled" ||
    effective.resourceClosed === true ||
    deadlineMs == null ||
    Date.now() >= deadlineMs - RSVP_REMINDER_MIN_REMAINING_MS
  )
    return false;
  return intent.reminderKey === rsvpReminderKey(effective.scheduleVersion ?? 1, deadlineMs);
}

/** Drop recipients who responded, lost respond access, or whose reminder is no longer eligible. */
export async function recheckExplicitRecipients(tx: Transaction, intent: Data) {
  const db = getFirestore();
  const listed = intent.audience?.recipients;
  if (!Array.isArray(listed) || listed.length > MAX_RECIPIENTS)
    throw new Error("NOTIFICATION_AUDIENCE_TOO_LARGE");
  const eventId = intent.sourceId;
  if (typeof eventId !== "string" || intent.sourceType !== "event")
    throw new Error("NOTIFICATION_AUDIENCE_STALE");
  const event = (await tx.get(db.doc(`events/${eventId}`))).data();
  if (!event || event.orgId !== intent.orgId || event.schemaVersion !== 2)
    throw new Error("NOTIFICATION_AUDIENCE_STALE");
  if (intent.templateKey === "rsvpReminder" && !(await reminderStillEligible(tx, intent, event)))
    return [];
  const scheduleVersion = event.scheduleVersion ?? 1;
  const map = new Map<string, ReminderRecipient>();
  for (const entry of listed) {
    if (typeof entry?.uid !== "string" || !Array.isArray(entry.accessSources))
      throw new Error("NOTIFICATION_AUDIENCE_STALE");
    for (const source of entry.accessSources) {
      if (
        source?.kind !== "household" ||
        typeof source.teamId !== "string" ||
        typeof source.participantId !== "string" ||
        !event.teamIds?.includes(source.teamId)
      )
        throw new Error("NOTIFICATION_AUDIENCE_STALE");
      const [roster, participant, availability] = (
        await tx.getAll(
          db.doc(`teams/${source.teamId}/roster/${source.participantId}`),
          db.doc(`organizations/${intent.orgId}/participants/${source.participantId}`),
          db.doc(`events/${eventId}/availability/${source.participantId}`),
        )
      ).map((row) => row.data());
      if (
        !roster ||
        roster.orgId !== intent.orgId ||
        roster.participantId !== source.participantId ||
        (roster.teamId != null && roster.teamId !== source.teamId) ||
        roster.status !== "active" ||
        !participant ||
        participant.status !== "active" ||
        (participant.orgId != null && participant.orgId !== intent.orgId)
      )
        continue;
      if (isCurrentResponse(availability, scheduleVersion)) continue;
      if (!(await canRespond(tx, intent.orgId, source.participantId, entry.uid, participant)))
        continue;
      addRecipient(map, entry.uid, {
        kind: "household",
        teamId: source.teamId,
        participantId: source.participantId,
      });
    }
  }
  return recipientsOf(map);
}
