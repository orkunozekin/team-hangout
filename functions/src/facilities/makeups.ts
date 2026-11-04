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
import {
  checkRevision,
  denied,
  eventScope,
  requireProgram,
  staffScope,
} from "../operations/access";
import { fingerprint } from "../operations/requests";
import { publishedEvent } from "../scheduling/visibility";
import { lockRef, publicationError as fail } from "../scheduling/lease";
import { instant, validateResourceAssignment } from "./service";
import { teamIds as canonicalTeamIds } from "../organizations/events";
import { overlaps } from "./intervals";
import { lifecycleMutation } from "../operations/events";
const db = () => getFirestore();
async function load(tx: Transaction, d: Data, uid: string) {
  const e = (await tx.get(db().doc(`events/${d.eventId}`))).data();
  if (!e || e.schemaVersion !== 2 || e.orgId !== d.orgId) denied();
  const staff = await staffScope(tx, d.orgId, uid);
  requireProgram(staff, e.programId);
  if (staff.organization.features?.adminWorkspace !== true) denied();
  const s = await eventScope(tx, e.teamIds, uid);
  if (s.orgId !== d.orgId || !(await publishedEvent(tx, e))) denied();
  return { e: e!, s, organization: staff.organization };
}
async function validate(tx: Transaction, d: Data, uid: string) {
  const { e, s, organization } = await load(tx, d, uid);
  checkRevision(e, d.expectedRevision);
  if (e.status !== "postponed")
    fail(
      "MAKEUP_REQUIRES_POSTPONEMENT",
      "Only postponed events can receive a reviewed makeup.",
    );
  const lock = (await tx.get(lockRef(d.orgId))).data();
  if (lock?.operationId)
    fail(
      "SCHEDULING_BUSY",
      "Finish or recover the current schedule operation first.",
    );
  const publication = e.publicationOperationId
    ? (
        await tx.get(
          db().doc(
            `organizations/${d.orgId}/scheduleOperations/${e.publicationOperationId}`,
          ),
        )
      ).data()
    : null;
  const publishedDraft = publication?.draftId
    ? (
        await tx.get(
          db().doc(
            `organizations/${d.orgId}/scheduleDrafts/${publication.draftId}`,
          ),
        )
      ).data()
    : null;
  const policy = publishedDraft?.fields ?? null;
  const durationMinutes =
    policy?.durationMinutes ??
    (e.endsAt.toMillis() - e.startsAt.toMillis()) / 60000;
  const restMinutes = policy?.minimumRestMinutes ?? 0;
  if (
    Date.parse(d.patch.endsAt) - Date.parse(d.patch.startsAt) !==
    durationMinutes * 60000
  )
    invalid("Preserve the reviewed event duration when choosing a makeup.");
  if (
    policy?.teamConstraints?.some(
      (c: Data) =>
        e.teamIds.includes(c.teamId) &&
        c.blackouts.some((b: Data) =>
          overlaps(d.patch, { startsAt: b.startsAt, endsAt: b.endsAt }),
        ),
    )
  )
    fail("SCHEDULE_CONFLICT", "The makeup overlaps a reviewed team blackout.");
  const next = {
    ...e,
    ...d.patch,
    startsAt: Timestamp.fromDate(new Date(d.patch.startsAt)),
    endsAt: Timestamp.fromDate(new Date(d.patch.endsAt)),
    status: "scheduled",
  };
  const season = (
    await tx.get(db().doc(`organizations/${d.orgId}/seasons/${e.seasonId}`))
  ).data()!;
  const localDate = (v: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: season.timeZone || organization.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(v));
  if (
    !season.startsOn ||
    !season.endsOn ||
    localDate(d.patch.startsAt) < season.startsOn ||
    localDate(new Date(Date.parse(d.patch.endsAt) - 1).toISOString()) >
      season.endsOn
  )
    invalid("The makeup must fit the canonical season dates.");
  const assignment = await validateResourceAssignment(
    tx,
    next,
    d.eventId,
    s.teams.map((t) => t.sport),
  );
  const events = await tx.get(
    db()
      .collection("events")
      .where("orgId", "==", d.orgId)
      .where("status", "in", ["scheduled", "completed"])
      .where("publicationState", "==", "published")
      .where("deletedAt", "==", null)
      .where(
        "endsAt",
        ">",
        Timestamp.fromMillis(
          Date.parse(d.patch.startsAt) - restMinutes * 60000,
        ),
      )
      .where(
        "startsAt",
        "<",
        Timestamp.fromMillis(Date.parse(d.patch.endsAt) + restMinutes * 60000),
      )
      .limit(1001),
  );
  if (events.size > 1000)
    throw new HttpsError(
      "resource-exhausted",
      "Makeup interval exceeds the safe 1,000 event snapshot limit. Nothing was truncated.",
    );
  const overlapping: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const doc of events.docs) {
    const other = doc.data();
    if (
      doc.id !== d.eventId &&
      ["scheduled", "completed"].includes(other.status) &&
      (await publishedEvent(tx, other))
    )
      overlapping.push(doc);
  }
  const relevantTeams = [
    ...new Set<string>([
      ...e.teamIds,
      ...overlapping.flatMap((doc) => canonicalTeamIds(doc.data().teamIds)),
    ]),
  ].sort();
  if (relevantTeams.length > 200)
    throw new HttpsError(
      "resource-exhausted",
      "Makeup interval includes more than 200 teams. Narrow the reviewed interval; nothing was truncated.",
    );
  const teamRecords = await tx.getAll(
    ...relevantTeams.map((t) => db().doc(`teams/${t}`)),
  );
  if (
    teamRecords.some(
      (t) => t.data()?.schemaVersion !== 2 || t.data()?.orgId !== d.orgId,
    )
  )
    denied();
  const grants: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let n = 0; n < relevantTeams.length; n += 10) {
    const rows = await tx.get(
      db()
        .collection("teamMembers")
        .where("orgId", "==", d.orgId)
        .where("status", "==", "active")
        .where("teamId", "in", relevantTeams.slice(n, n + 10))
        .where("roles", "array-contains", "coach")
        .limit(1001),
    );
    grants.push(...rows.docs);
    if (grants.length > 1000)
      throw new HttpsError(
        "resource-exhausted",
        "Makeup interval exceeds 1,000 relevant coach assignments. Nothing was truncated.",
      );
  }
  const coaches = new Map<string, Set<string>>();
  for (const doc of grants) {
    const g = doc.data();
    if (
      g.schemaVersion === 2 &&
      g.orgId === d.orgId &&
      doc.id === `${g.teamId}_${g.userId}` &&
      g.roles?.includes("coach")
    ) {
      const set = coaches.get(g.teamId) ?? new Set<string>();
      set.add(g.userId);
      coaches.set(g.teamId, set);
    }
  }
  const actors = new Set<string>(
    e.teamIds.flatMap((t: string) => [...(coaches.get(t) ?? [])]),
  );
  for (const doc of overlapping) {
    const other = doc.data();
    if (
      doc.id === d.eventId ||
      !["scheduled", "completed"].includes(other.status) ||
      !(await publishedEvent(tx, other))
    )
      continue;
    const otherInterval = {
      startsAt: other.startsAt.toDate().toISOString(),
      endsAt: other.endsAt.toDate().toISOString(),
    };
    const teamSpan = {
      startsAt: new Date(
        Date.parse(d.patch.startsAt) - restMinutes * 60000,
      ).toISOString(),
      endsAt: new Date(
        Date.parse(d.patch.endsAt) + restMinutes * 60000,
      ).toISOString(),
    };
    if (
      (overlaps(teamSpan, otherInterval) &&
        other.teamIds.some((t: string) => e.teamIds.includes(t))) ||
      (overlaps(d.patch, otherInterval) &&
        other.teamIds.some((t: string) =>
          [...(coaches.get(t) ?? [])].some((u) => actors.has(u)),
        ))
    )
      fail(
        "SCHEDULE_CONFLICT",
        "A participating team or assigned coach conflicts with this interval or the reviewed team rest requirement.",
      );
  }
  // Bind every current canonical input. Private coach identities never enter preview/receipt responses.
  const { resourceFence, ...safeAssignment } = assignment;
  return {
    e,
    hash: fingerprint({
      proposal: d,
      policy,
      event: e,
      teams: s.teams,
      relevantTeams: teamRecords.map((t) => [t.id, t.data()]),
      season,
      assignment: safeAssignment,
      grants: grants.map((g) => [g.id, g.data()]),
      events: events.docs.map((r) => [r.id, r.data().revision ?? null]),
      inputRevision: lock?.inputRevision ?? 0,
    }),
  };
}
function proposal(d: Data) {
  const p = object(d.patch);
  keys(p, ["startsAt", "endsAt", "timeZone", "facilityId", "resourceId"]);
  const startsAt = instant(p.startsAt, "startsAt"),
    endsAt = instant(p.endsAt, "endsAt"),
    timeZone = text(p.timeZone, "timeZone", 100);
  if (
    startsAt >= endsAt ||
    Date.parse(endsAt) - Date.parse(startsAt) > 86400000
  )
    invalid("Choose an ordered makeup interval of at most 24 hours.");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    invalid("Supply an IANA timezone.");
  }
  return {
    orgId: id(d.orgId, "orgId"),
    eventId: id(d.eventId, "eventId"),
    expectedRevision: revision(d.expectedRevision),
    reason: text(d.reason, "reason", 500),
    patch: {
      startsAt,
      endsAt,
      timeZone,
      facilityId: id(p.facilityId, "facilityId"),
      resourceId: id(p.resourceId, "resourceId"),
    },
  };
}
export const previewEventMakeup = command(
  "previewEventMakeup",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "eventId",
      "expectedRevision",
      "patch",
      "reason",
    ]);
    return proposal(d);
  },
  async (tx, d, uid, _actor, replay) => {
    await load(tx, d, uid);
    if (replay) return replay;
    const current = await validate(tx, d, uid),
      ref = db().collection(`organizations/${d.orgId}/makeupPreviews`).doc();
    const result = {
      previewId: ref.id,
      previewHash: current.hash,
      eventId: d.eventId,
      title: current.e.title,
      teamIds: current.e.teamIds,
      previousStartsAt: current.e.startsAt,
      startsAt: d.patch.startsAt,
      endsAt: d.patch.endsAt,
      timeZone: d.patch.timeZone,
      facilityId: d.patch.facilityId,
      resourceId: d.patch.resourceId,
      crossOrganizationBusy: "notChecked",
    };
    tx.create(ref, {
      schemaVersion: 2,
      orgId: d.orgId,
      fields: d,
      ...result,
      createdAt: Timestamp.now(),
    });
    return result;
  },
);
export const confirmEventMakeup = command(
  "confirmEventMakeup",
  (d) => {
    keys(d, ["requestId", "orgId", "previewId", "previewHash", "confirmed"]);
    if (d.confirmed !== true)
      invalid("Explicitly confirm the reviewed makeup.");
    return {
      orgId: id(d.orgId, "orgId"),
      previewId: id(d.previewId, "previewId"),
      previewHash: text(d.previewHash, "previewHash", 64),
      confirmed: true,
    };
  },
  async (tx, d, uid, actor, replay) => {
    const p = (
      await tx.get(
        db().doc(`organizations/${d.orgId}/makeupPreviews/${d.previewId}`),
      )
    ).data();
    if (!p || p.orgId !== d.orgId || p.schemaVersion !== 2) denied();
    await load(tx, p.fields, uid);
    if (replay) return replay;
    const current = await validate(tx, p.fields, uid);
    if (current.hash !== p.previewHash || p.previewHash !== d.previewHash)
      fail("STALE_PREVIEW", "Makeup inputs changed. Review a new preview.");
    return lifecycleMutation(
      tx,
      { ...p.fields, action: "reschedule" },
      uid,
      actor,
      null,
      true,
    );
  },
);
