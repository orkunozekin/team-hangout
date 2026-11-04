import { scheduleMutation } from '../scheduling/lease';
import { createHash } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { accountAvailable } from "../accountAccess";
import { command, Data, id, invalid, keys, revision } from "../commandSupport";
import {
  denied,
  hierarchy,
  requireProgram,
  staffScope,
} from "../organizations/policy";
import { householdAccess, readCommand } from "../participants/policy";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function normalize(data: Data) {
  if (
    !Array.isArray(data.numbers) ||
    !data.numbers.length ||
    data.numbers.length > 10
  )
    invalid("Select 1 through 10 draft rows for each publication.");
  const numbers = data.numbers
    .map((n: unknown) => revision(n))
    .sort((a: number, b: number) => a - b);
  if (
    new Set(numbers).size !== numbers.length ||
    numbers.some((n: number) => n < 1 || n > 5000)
  )
    invalid("Invalid publication row selection.");
  return {
    orgId: id(data.orgId, "orgId"),
    jobId: id(data.jobId, "jobId"),
    numbers,
  };
}
async function scope(
  tx: Transaction,
  payload: Data,
  uid: string,
  writing = false,
) {
  const db = getFirestore(),
    job = (await tx.get(db.doc(`importJobs/${payload.jobId}`))).data();
  if (
    !job ||
    job.orgId !== payload.orgId ||
    job.ownerUid !== uid ||
    job.kind !== "schedule"
  )
    denied();
  const access = await staffScope(tx, job.orgId, uid);
  requireProgram(access, job.programId);
  if (
    access.organization.features?.organizationV2 !== true ||
    access.organization.features?.imports !== true
  )
    denied();
  await hierarchy(tx, job.orgId, job.programId, job.seasonId, null, writing);
  if (
    writing &&
    (job.status !== "complete" || job.expiresAt.toMillis() <= Date.now())
  )
    invalid("Complete an unexpired draft import before publication.");
  return job;
}
async function recipients(tx: Transaction, event: Data) {
  const db = getFirestore(),
    uids = new Set<string>();
  const roster = await tx.get(
    db
      .collection(`teams/${event.teamId}/roster`)
      .where("status", "==", "active")
      .limit(101),
  );
  if (roster.size > 100)
    throw new HttpsError(
      "resource-exhausted",
      "Publication needs a reviewed larger recipient workflow.",
    );
  for (const enrollment of roster.docs) {
    const r = enrollment.data();
    if (r.orgId !== event.orgId || r.participantId !== enrollment.id) continue;
    const ref = db.doc(
        `organizations/${event.orgId}/participants/${enrollment.id}`,
      ),
      participant = (await tx.get(ref)).data();
    if (
      !participant ||
      participant.schemaVersion !== 2 ||
      participant.status !== "active" ||
      (participant.orgId != null && participant.orgId !== event.orgId)
    )
      continue;
    const guardians = await tx.get(
      ref.collection("guardians").where("status", "==", "active").limit(11),
    );
    if (guardians.size > 10)
      throw new HttpsError(
        "resource-exhausted",
        "Participant guardian scope exceeds the supported publication limit.",
      );
    for (const target of [
      ...guardians.docs.map((d) => d.id),
      ...(participant.linkedUserId ? [participant.linkedUserId] : []),
    ]) {
      try {
        await householdAccess(
          tx,
          event.orgId,
          enrollment.id,
          target,
          "viewSchedule",
        );
        if (!uids.has(target)) await accountAvailable(tx, target);
        uids.add(target);
      } catch (e) {
        if (
          !(e instanceof HttpsError) ||
          ![
            "permission-denied",
            "unauthenticated",
            "failed-precondition",
          ].includes(e.code)
        )
          throw e;
      }
    }
  }
  if (uids.size > 200)
    throw new HttpsError(
      "resource-exhausted",
      "Recipient scope exceeds 200 accounts. Use a reviewed bulk publication workflow.",
    );
  const ids = [...uids].sort();
  const batches = [];
  for (let start = 0; start < ids.length; start += 100)
    batches.push(
      getAuth().getUsers(ids.slice(start, start + 100).map((uid) => ({ uid }))),
    );
  const resolved = await Promise.all(batches);
  return resolved
    .flatMap((batch) => batch.users)
    .filter((user) => !user.disabled && user.emailVerified && user.email)
    .map((user) => ({ uid: user.uid, email: user.email!.toLowerCase() }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
}
async function prepare(tx: Transaction, job: Data, numbers: number[]) {
  const db = getFirestore(),
    entries: {
      number: number;
      eventId: string;
      event: Data;
      recipients: { uid: string; email: string }[];
    }[] = [];
  const teamRecipients = new Map<
    string,
    Awaited<ReturnType<typeof recipients>>
  >();
  for (const number of numbers) {
    const rawRow = (
      await tx.get(
        db.doc(`importJobs/${job.id}/rows/${String(number).padStart(5, "0")}`),
      )
    ).data();
    if (
      !rawRow ||
      !["created", "updated"].includes(rawRow.outcome) ||
      !rawRow.eventId
    )
      invalid("Select successfully committed schedule rows.");
    const row = rawRow!;
    const event = (await tx.get(db.doc(`events/${row.eventId}`))).data();
    if (
      !event ||
      event.schemaVersion !== 2 ||
      event.orgId !== job.orgId ||
      event.programId !== job.programId ||
      event.seasonId !== job.seasonId ||
      event.revision !== row.eventRevision ||
      event.publicationState !== "staged" ||
      event.status !== "scheduled" ||
      event.deletedAt != null ||
      event.publicationOperationId != null ||
      event.resourceId != null ||
      event.teamId !== row.teamId ||
      event.teamIds?.length !== 1 ||
      event.teamIds[0] !== row.teamId
    )
      throw new HttpsError(
        "aborted",
        "A draft changed or is already published. Upload a fresh schedule preview to review current events.",
        { domainCode: "SCHEDULE_DRAFT_CHANGED" },
      );
    const team = (await tx.get(db.doc(`teams/${event.teamId}`))).data();
    if (
      !team ||
      team.schemaVersion !== 2 ||
      team.orgId !== job.orgId ||
      team.programId !== job.programId ||
      team.seasonId !== job.seasonId ||
      team.status !== "active" ||
      team.divisionId !== event.divisionId
    )
      denied();
    await hierarchy(
      tx,
      job.orgId,
      job.programId,
      job.seasonId,
      team.divisionId,
      true,
    );
    if (!teamRecipients.has(event.teamId))
      teamRecipients.set(event.teamId, await recipients(tx, event));
    entries.push({
      number,
      eventId: row.eventId,
      event,
      recipients: teamRecipients.get(event.teamId)!,
    });
  }
  if (entries.reduce((n, e) => n + e.recipients.length, 0) > 200)
    throw new HttpsError(
      "resource-exhausted",
      "Select fewer drafts; one confirmation supports at most 200 recipient updates.",
    );
  return {
    entries,
    binding: hash(
      entries.map((e) => [e.number, e.eventId, e.event.revision, e.recipients]),
    ),
  };
}
export const prepareSchedulePublication = readCommand(
  (data) => {
    keys(data, ["orgId", "jobId", "numbers"]);
    return normalize(data);
  },
  async (tx, payload, uid) => {
    const job = await scope(tx, payload, uid, true),
      prepared = await prepare(tx, job, payload.numbers);
    return {
      binding: prepared.binding,
      recipientCount: prepared.entries.reduce(
        (n, e) => n + e.recipients.length,
        0,
      ),
      events: prepared.entries.map((e) => ({
        number: e.number,
        eventId: e.eventId,
        title: e.event.title,
        startsAt: e.event.startsAt,
        endsAt: e.event.endsAt,
        timeZone: e.event.timeZone,
        location: e.event.location,
        revision: e.event.revision,
        recipientCount: e.recipients.length,
      })),
    };
  },
);
export const publishScheduleImport = command(
  "publishScheduleImport",
  (data) => {
    keys(data, [
      "requestId",
      "orgId",
      "jobId",
      "numbers",
      "binding",
      "confirmed",
    ]);
    if (
      data.confirmed !== true ||
      typeof data.binding !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.binding)
    )
      invalid("Review and explicitly confirm the current draft publication.");
    return { ...normalize(data), binding: data.binding, confirmed: true };
  },
  async (tx, payload, uid, _actor, replay) => {
    const job = await scope(tx, payload, uid);
    if (replay) return replay;
    await scope(tx, payload, uid, true);
    const fence = await scheduleMutation(tx, job.orgId);
    const prepared = await prepare(tx, job, payload.numbers);
    if (prepared.binding !== payload.binding)
      throw new HttpsError(
        "aborted",
        "Notification contacts changed. Review publication again.",
        { domainCode: "SCHEDULE_RECIPIENTS_CHANGED" },
      );
    fence();
    let queued = 0;
    // All reads finish before any event/outbox writes. Transaction retries cannot send mail.
    for (const e of prepared.entries) {
      const nextRevision = e.event.revision + 1;
      tx.update(getFirestore().doc(`events/${e.eventId}`), {
        publicationState: "published",
        revision: nextRevision,
        updatedAt: Timestamp.now(),
        updatedBy: uid,
      });
      tx.update(
        getFirestore().doc(
          `importJobs/${job.id}/rows/${String(e.number).padStart(5, "0")}`,
        ),
        { publishedRevision: nextRevision },
      );
      for (const r of e.recipients) {
        tx.create(
          getFirestore().doc(
            `emailOutbox/${hash(["publishedEvent", e.eventId, nextRevision, r.uid])}`,
          ),
          {
            kind: "publishedEvent",
            orgId: job.orgId,
            eventId: e.eventId,
            eventRevision: nextRevision,
            recipientUid: r.uid,
            recipientEmail: r.email,
            status: "queued",
            attemptCount: 0,
            nextAttemptAt: Timestamp.now(),
            transportMessageId: null,
            failureCode: null,
            createdAt: Timestamp.now(),
          },
        );
        queued++;
      }
    }
    return { published: prepared.entries.length, queued };
  },
);
