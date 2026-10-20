import { FieldPath, getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Data } from "../commandSupport";
import { effectiveEvent } from "../facilities/closures";
import { fingerprint } from "../operations/requests";
import { publishedEvent } from "../scheduling/visibility";
import { collectReminderRecipients } from "./audience";
import { planRsvpReminder, RSVP_REMINDER_LEAD_MS } from "./reminderPlan";

const HORIZON_MS = 16 * 7 * 24 * 60 * 60 * 1000;

function deadlineMillis(event: Data) {
  const value = event.rsvpDeadline ?? event.startsAt;
  const millis = value?.toMillis?.();
  return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
}

/** Write-only. Callers finish every read, including publication and closure, before this. */
export function stageReminder(
  tx: Transaction,
  eventId: string,
  event: Data,
  previous: Data | undefined,
  enabled: boolean,
  nowMs: number,
  published: boolean,
) {
  const deadlineMs = deadlineMillis(event);
  const plan = planRsvpReminder({
    nowMs,
    deadlineMs: deadlineMs ?? Number.NaN,
    scheduleVersion: event.scheduleVersion ?? 1,
    sentKey: typeof previous?.sentKey === "string" ? previous.sentKey : null,
    status: event.status,
    resourceClosed: event.resourceClosed === true,
    published,
  });
  const ref = getFirestore().doc(`organizations/${event.orgId}/rsvpReminders/${eventId}`);
  if (
    enabled &&
    previous?.state === "failed" &&
    previous.key === plan.key &&
    plan.action === "send"
  ) {
    return { ...plan, state: "failed" as const };
  }
  const state = !enabled
    ? "paused"
    : plan.reason === "already_sent"
      ? "sent"
      : plan.action === "skip"
        ? "skipped"
        : "scheduled";
  const dueAt =
    state === "scheduled" && plan.dueAtMs != null
      ? Timestamp.fromMillis(plan.dueAtMs)
      : null;
  tx.set(
    ref,
    {
      schemaVersion: 2,
      orgId: event.orgId,
      eventId,
      programId: event.programId ?? null,
      scheduleVersion: event.scheduleVersion ?? 1,
      deadlineMs,
      key: plan.key,
      state,
      reason: enabled ? plan.reason : "paused",
      failureCode: enabled ? null : "FEATURE_DISABLED",
      dueAt,
      sentKey: previous?.sentKey ?? null,
      updatedAt: Timestamp.fromMillis(nowMs),
    },
    { merge: true },
  );
  return { ...plan, state };
}

export async function syncRsvpReminder(orgId: string, eventId: string, nowMs: number) {
  const db = getFirestore();
  return db.runTransaction(async (tx) => {
    const event = (await tx.get(db.doc(`events/${eventId}`))).data();
    if (!event || event.orgId !== orgId || event.schemaVersion !== 2)
      return { state: "missing" as const };
    const [reminder, organization] = await tx.getAll(
      db.doc(`organizations/${orgId}/rsvpReminders/${eventId}`),
      db.doc(`organizations/${orgId}`),
    );
    const published = await publishedEvent(tx, event);
    const effective = await effectiveEvent(tx, event);
    const enabled =
      organization.data()?.features?.rsvpReminders === true &&
      organization.data()?.status === "active";
    return stageReminder(
      tx,
      eventId,
      effective,
      reminder.data(),
      enabled,
      nowMs,
      published,
    );
  });
}

export async function dispatchRsvpReminder(orgId: string, eventId: string, nowMs: number) {
  const db = getFirestore();
  return db.runTransaction(async (tx) => {
    const event = (await tx.get(db.doc(`events/${eventId}`))).data();
    if (!event || event.orgId !== orgId || event.schemaVersion !== 2)
      return { result: "missing" as const };
    const reminderRef = db.doc(`organizations/${orgId}/rsvpReminders/${eventId}`);
    const [reminderSnap, organization] = await tx.getAll(
      reminderRef,
      db.doc(`organizations/${orgId}`),
    );
    const previous = reminderSnap.data();
    const published = await publishedEvent(tx, event);
    const effective = await effectiveEvent(tx, event);
    const enabled =
      organization.data()?.features?.rsvpReminders === true &&
      organization.data()?.status === "active";
    const deadlineMs = deadlineMillis(effective);
    const plan = planRsvpReminder({
      nowMs,
      deadlineMs: deadlineMs ?? Number.NaN,
      scheduleVersion: effective.scheduleVersion ?? 1,
      sentKey: typeof previous?.sentKey === "string" ? previous.sentKey : null,
      status: effective.status,
      resourceClosed: effective.resourceClosed === true,
      published,
    });
    if (!enabled) {
      stageReminder(tx, eventId, effective, previous, false, nowMs, published);
      return { result: "disabled" as const };
    }
    if (previous?.state === "failed" && previous.key === plan.key && plan.action === "send")
      return { result: "failed" as const, failureCode: previous.failureCode ?? null };
    if (plan.action !== "send") {
      const staged = stageReminder(tx, eventId, effective, previous, true, nowMs, published);
      return {
        result: (staged.state === "sent" ? "already_sent" : plan.action) as
          | "already_sent"
          | "wait"
          | "skip",
        reason: plan.reason,
      };
    }
    let recipients;
    try {
      recipients = await collectReminderRecipients(tx, effective, eventId);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!["NOTIFICATION_AUDIENCE_TOO_LARGE", "NOTIFICATION_AUDIENCE_STALE"].includes(code))
        throw error;
      tx.set(
        reminderRef,
        {
          state: "failed",
          failureCode: code,
          dueAt: null,
          key: plan.key,
          updatedAt: Timestamp.fromMillis(nowMs),
        },
        { merge: true },
      );
      return { result: "failed" as const, failureCode: code };
    }
    const intentId = fingerprint({ kind: "rsvpReminder", orgId, eventId, key: plan.key });
    const intentRef = db.doc(`organizations/${orgId}/outbox/${intentId}`);
    const existing = await tx.get(intentRef);
    const now = Timestamp.fromMillis(nowMs);
    if (recipients.length && !existing.exists) {
      tx.create(intentRef, {
        schemaVersion: 2,
        orgId,
        sourceType: "event",
        sourceId: eventId,
        sourceRevision: event.revision ?? 1,
        templateKey: "rsvpReminder",
        state: "pending",
        critical: false,
        programId: event.programId ?? null,
        reminderKey: plan.key,
        audience: { mode: "explicit", teamIds: event.teamIds, recipients },
        createdAt: now,
        updatedAt: now,
        auditCorrelationId: intentId,
      });
    }
    tx.set(
      reminderRef,
      {
        schemaVersion: 2,
        orgId,
        eventId,
        programId: event.programId ?? null,
        scheduleVersion: effective.scheduleVersion ?? 1,
        deadlineMs,
        key: plan.key,
        state: "sent",
        reason: plan.reason,
        failureCode: null,
        dueAt: null,
        sentKey: plan.key,
        intentId: recipients.length ? intentId : null,
        recipientCount: recipients.length,
        updatedAt: now,
      },
      { merge: true },
    );
    return {
      result: (existing.exists ? "already_sent" : "sent") as "sent" | "already_sent",
      intentId: recipients.length ? intentId : null,
      recipientCount: recipients.length,
    };
  });
}

export async function dispatchDueRsvpReminders(nowMs: number) {
  const db = getFirestore();
  const due = await db
    .collectionGroup("rsvpReminders")
    .where("state", "==", "scheduled")
    .where("dueAt", "<=", Timestamp.fromMillis(nowMs))
    .orderBy("dueAt")
    .limit(25)
    .get();
  const results = [];
  for (const doc of due.docs) {
    const parts = doc.ref.path.split("/");
    if (parts.length !== 4 || parts[0] !== "organizations" || parts[2] !== "rsvpReminders")
      continue;
    try {
      results.push({ eventId: doc.id, ...(await dispatchRsvpReminder(parts[1], doc.id, nowMs)) });
    } catch {
      console.error("RSVP reminder dispatch failed.", { orgId: parts[1], eventId: doc.id });
    }
  }
  return { scanned: due.size, results };
}

/** Prepare at most 25 soonest published events per run. A saved cursor continues the season. */
export async function scanUpcomingReminders(nowMs: number) {
  const db = getFirestore();
  const scanRef = db.doc("rsvpReminderScans/upcoming");
  const saved = (await scanRef.get()).data();
  const earliest = Timestamp.fromMillis(nowMs - 60 * 60 * 1000);
  let query = db
    .collection("events")
    .where("publicationState", "==", "published")
    .where("status", "==", "scheduled")
    .where("startsAt", ">=", earliest)
    .where("startsAt", "<=", Timestamp.fromMillis(nowMs + HORIZON_MS))
    .orderBy("startsAt")
    .orderBy(FieldPath.documentId())
    .limit(25);
  if (typeof saved?.cursorPath === "string") {
    const cursor = await db.doc(saved.cursorPath).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const page = await query.get();
  let prepared = 0;
  for (const doc of page.docs) {
    const event = doc.data();
    if (event.deletedAt != null || event.schemaVersion !== 2 || typeof event.orgId !== "string")
      continue;
    const organization = (await db.doc(`organizations/${event.orgId}`).get()).data();
    if (organization?.features?.rsvpReminders !== true || organization.status !== "active")
      continue;
    await syncRsvpReminder(event.orgId, doc.id, nowMs);
    prepared += 1;
  }
  await scanRef.set({
    schemaVersion: 2,
    cursorPath: page.size === 25 ? page.docs[24].ref.path : null,
    prepared,
    updatedAt: Timestamp.fromMillis(nowMs),
  });
  const deadlines = await scanDeadlineReminders(nowMs);
  return {
    examined: page.size + deadlines.examined,
    prepared: prepared + deadlines.prepared,
  };
}

/** A deadline can be due while the event start is still outside the 16-week horizon. */
async function scanDeadlineReminders(nowMs: number) {
  const db = getFirestore();
  const scanRef = db.doc("rsvpReminderScans/deadlines");
  const saved = (await scanRef.get()).data();
  let query = db
    .collection("events")
    .where("publicationState", "==", "published")
    .where("status", "==", "scheduled")
    .where("rsvpDeadline", ">=", Timestamp.fromMillis(nowMs))
    .where("rsvpDeadline", "<=", Timestamp.fromMillis(nowMs + RSVP_REMINDER_LEAD_MS + 60 * 60 * 1000))
    .orderBy("rsvpDeadline")
    .orderBy(FieldPath.documentId())
    .limit(25);
  if (typeof saved?.cursorPath === "string") {
    const cursor = await db.doc(saved.cursorPath).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const page = await query.get();
  let prepared = 0;
  for (const doc of page.docs) {
    const event = doc.data();
    if (event.deletedAt != null || event.schemaVersion !== 2 || typeof event.orgId !== "string")
      continue;
    const organization = (await db.doc(`organizations/${event.orgId}`).get()).data();
    if (organization?.features?.rsvpReminders !== true || organization.status !== "active")
      continue;
    await syncRsvpReminder(event.orgId, doc.id, nowMs);
    prepared += 1;
  }
  await scanRef.set({
    schemaVersion: 2,
    cursorPath: page.size === 25 ? page.docs[24].ref.path : null,
    prepared,
    updatedAt: Timestamp.fromMillis(nowMs),
  });
  return { examined: page.size, prepared };
}

export const resumeRsvpReminders = onSchedule({ schedule: "every 5 minutes" }, async () => {
  const now = Date.now();
  try {
    await scanUpcomingReminders(now);
  } catch {
    console.error("RSVP reminder scan failed.");
  }
  try {
    await dispatchDueRsvpReminders(now);
  } catch {
    console.error("RSVP reminder dispatch failed.");
  }
});
