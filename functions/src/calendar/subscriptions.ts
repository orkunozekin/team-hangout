import { createHash, randomBytes } from "node:crypto";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import {
  Data,
  id,
  invalid,
  keys,
  object,
  revision,
  wire,
} from "../commandSupport";
import { accountAvailable } from "../accountAccess";
import { readCommand } from "../participants/policy";
import { readAgenda } from "./agenda";
import { encodeCalendar } from "./ics";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function denied(): never {
  throw new HttpsError(
    "permission-denied",
    "Subscription or selected access is unavailable.",
  );
}
const DAY = 86400000;
export const FEED_LIMIT = 499;
function config() {
  const emulator =
    process.env.FUNCTIONS_EMULATOR === "true" &&
    process.env.GCLOUD_PROJECT === "demo-team-hangout";
  const base =
    process.env.CALENDAR_FEED_BASE_URL ||
    (emulator
      ? "http://127.0.0.1:5001/demo-team-hangout/us-central1/calendarFeed"
      : "");
  const domain =
    process.env.CALENDAR_UID_DOMAIN ||
    (emulator ? "calendar.example.test" : "");
  try {
    const url = new URL(base);
    if (
      (!emulator && url.protocol !== "https:") ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)
    )
      throw new Error();
  } catch {
    throw new HttpsError(
      "failed-precondition",
      "Calendar subscriptions need administrator endpoint setup.",
    );
  }
  return { base: base.replace(/\/$/, ""), domain };
}
function scope(data: Data): Data {
  const teamIds = data.teamIds;
  if (!Array.isArray(teamIds) || !teamIds.length || teamIds.length > 20)
    invalid("Select 1 through 20 teams.");
  const teams = [
    ...new Set((teamIds as unknown[]).map((v) => id(v, "teamId"))),
  ].sort();
  const refs = data.participantRefs ?? [];
  if (!Array.isArray(refs) || refs.length > 20)
    invalid("Select at most 20 participants.");
  const participants = (refs as unknown[]).map((v) => {
    const r = object(v);
    keys(r, ["orgId", "participantId"]);
    return {
      orgId: id(r.orgId, "orgId"),
      participantId: id(r.participantId, "participantId"),
    };
  });
  const participantRefs = [
    ...new Map(
      participants.map((p) => [`${p.orgId}/${p.participantId}`, p]),
    ).values(),
  ].sort((a, b) =>
    `${a.orgId}/${a.participantId}`.localeCompare(
      `${b.orgId}/${b.participantId}`,
    ),
  );
  const types = data.eventTypes ?? ["practice", "match"];
  if (
    !Array.isArray(types) ||
    !types.length ||
    types.some((v) => !["practice", "match"].includes(v))
  )
    invalid("Select practice or match.");
  if (
    data.includeParticipantNames !== undefined &&
    typeof data.includeParticipantNames !== "boolean"
  )
    invalid("Invalid name preference.");
  if (data.includeParticipantNames === true && !participantRefs.length)
    invalid("Select specific participants before including names.");
  return {
    teamIds: teams,
    participantRefs,
    eventTypes: [...new Set(types)].sort(),
    includeParticipantNames: data.includeParticipantNames === true,
  };
}
function query(selection: Data, now = Date.now()): Data {
  return {
    ...selection,
    from: new Date(now - 30 * DAY).toISOString(),
    to: new Date(now + 365 * DAY).toISOString(),
    pageSize: FEED_LIMIT,
    cursor: null,
    includeArchived: false,
    orgIds: [],
    seasonRefs: [],
  };
}
async function authorized(
  tx: Transaction,
  uid: string,
  selection: Data,
  now?: number,
) {
  const agenda = await readAgenda(tx, query(selection, now), uid);
  const selected = agenda.teams.filter(
    (t: Data) =>
      selection.teamIds.includes(t.id) &&
      !t.archived &&
      t.seasonStatus === "active",
  );
  if (
    selected.length !== selection.teamIds.length ||
    selection.participantRefs.some(
      (p: Data) =>
        !selected.some((t: Data) =>
          t.participants.some(
            (label: Data) =>
              label.orgId === p.orgId &&
              label.participantId === p.participantId,
          ),
        ),
    )
  )
    denied();
  // Every selected team must match the selected participant subset, if one is present.
  if (
    selection.participantRefs.length &&
    selected.some(
      (t: Data) =>
        !t.participants.some((label: Data) =>
          selection.participantRefs.some(
            (p: Data) =>
              p.orgId === label.orgId &&
              p.participantId === label.participantId,
          ),
        ),
    )
  )
    denied();
  for (const orgId of new Set<string>(selected.map((t: Data) => t.orgId))) {
    if (
      (await tx.get(getFirestore().doc(`organizations/${orgId}`))).data()
        ?.features?.calendarSubscriptions !== true
    )
      denied();
  }
  if (agenda.nextCursor)
    throw new HttpsError(
      "resource-exhausted",
      "This feed exceeds 499 events. Select fewer teams or event types.",
    );
  return agenda;
}
function summary(hash: string, row: Data): Data {
  return {
    id: hash,
    revision: row.revision,
    status: row.revokedAt ? "revoked" : "active",
    createdAt: row.createdAt,
    scope: row.scope,
    previousDays: 30,
    nextDays: 365,
    eventLimit: FEED_LIMIT,
  };
}
// The bearer is returned only by the transaction that creates it. Receipts contain metadata only.
function issue(rotate: boolean) {
  return onCall(async (request) => {
    if (!request.auth?.uid)
      throw new HttpsError("unauthenticated", "Sign in to continue.");
    const uid = request.auth.uid,
      data = object(request.data);
    keys(
      data,
      rotate
        ? ["requestId", "subscriptionId", "expectedRevision"]
        : [
            "requestId",
            "teamIds",
            "participantRefs",
            "eventTypes",
            "includeParticipantNames",
          ],
    );
    const requestId = id(data.requestId, "requestId");
    const selection = rotate ? null : scope(data);
    const subscriptionId = rotate ? tokenId(data.subscriptionId) : null;
    const expectedRevision = rotate ? revision(data.expectedRevision) : null;
    const { base } = config();
    const token = randomBytes(32).toString("base64url"),
      tokenHash = sha(token);
    const db = getFirestore(),
      receipt = db.doc(
        `commandRequests/${sha(`${uid}:calendar:${rotate}:${requestId}`)}`,
      );
    const fingerprint = sha(
      JSON.stringify({ selection, subscriptionId, expectedRevision }),
    );
    return db.runTransaction(async (tx) => {
      await accountAvailable(tx, uid);
      const previous = await tx.get(receipt);
      if (previous.exists) {
        if (previous.data()?.fingerprint !== fingerprint)
          throw new HttpsError(
            "already-exists",
            "Request ID already used for another action.",
          );
        const result = previous.data()!.result;
        const current = (
          await tx.get(
            db.doc(`calendarSubscriptions/${result.subscription.id}`),
          )
        ).data();
        if (!current || current.ownerUid !== uid || current.revokedAt) denied();
        await authorized(tx, uid, current.scope);
        return wire({
          subscription: summary(result.subscription.id, current),
          url: null,
        });
      }
      const oldRef = subscriptionId
        ? db.doc(`calendarSubscriptions/${subscriptionId}`)
        : null;
      const old = oldRef ? (await tx.get(oldRef)).data() : null;
      if (rotate && (!old || old.ownerUid !== uid || old.revokedAt)) denied();
      if (old && old.revision !== expectedRevision)
        throw new HttpsError(
          "failed-precondition",
          "Subscription changed. Reload before rotating.",
        );
      const selectedScope = old?.scope ?? selection!;
      await authorized(tx, uid, selectedScope);
      const active = await tx.get(
        db
          .collection("calendarSubscriptions")
          .where("ownerUid", "==", uid)
          .where("revokedAt", "==", null)
          .limit(11),
      );
      if (!rotate && active.size >= 10)
        throw new HttpsError(
          "resource-exhausted",
          "Remove a subscription before creating another.",
        );
      const now = Timestamp.now();
      const row = {
        schemaVersion: 2,
        ownerUid: uid,
        scope: selectedScope,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      };
      if (oldRef)
        tx.update(oldRef, {
          revokedAt: now,
          updatedAt: now,
          revision: old!.revision + 1,
        });
      tx.create(db.doc(`calendarSubscriptions/${tokenHash}`), row);
      const result = { subscription: summary(tokenHash, row) };
      tx.create(receipt, {
        uid,
        operation: rotate
          ? "rotateCalendarSubscription"
          : "createCalendarSubscription",
        fingerprint,
        result,
        createdAt: now,
      });
      return wire({ ...result, url: `${base}?token=${token}` });
    });
  });
}
function tokenId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    invalid("Invalid subscription ID.");
  return value as string;
}
export const createCalendarSubscription = issue(false);
export const rotateCalendarSubscription = issue(true);
export const listCalendarSubscriptions = readCommand(
  (data) => {
    keys(data, []);
    return {};
  },
  async (tx, _data, uid) => {
    // Only active records need management. Revoked URLs remain tombstones until account cleanup.
    const rows = await tx.get(
      getFirestore()
        .collection("calendarSubscriptions")
        .where("ownerUid", "==", uid)
        .where("revokedAt", "==", null)
        .limit(11),
    );
    if (rows.size > 10)
      throw new HttpsError(
        "resource-exhausted",
        "Subscription cleanup is required.",
      );
    return { items: rows.docs.map((d) => summary(d.id, d.data())) };
  },
);
export const calendarSubscriptionOptions = readCommand(
  (data) => {
    keys(data, []);
    return {};
  },
  async (tx, _data, uid) => {
    const agenda = await readAgenda(
      tx,
      query({ teamIds: [], participantRefs: [], eventTypes: [] }),
      uid,
      { events: false },
    );
    const teams: Data[] = [];
    for (const team of agenda.teams) {
      const org = (
        await tx.get(getFirestore().doc(`organizations/${team.orgId}`))
      ).data();
      if (
        !team.archived &&
        team.seasonStatus === "active" &&
        org?.features?.calendarSubscriptions === true
      )
        teams.push(team);
    }
    return { teams };
  },
);
export const revokeCalendarSubscription = onCall(async (request) => {
  if (!request.auth?.uid)
    throw new HttpsError("unauthenticated", "Sign in to continue.");
  const uid = request.auth.uid,
    data = object(request.data);
  keys(data, ["subscriptionId", "expectedRevision", "requestId"]);
  id(data.requestId, "requestId");
  const ref = getFirestore().doc(
      `calendarSubscriptions/${tokenId(data.subscriptionId)}`,
    ),
    expected = revision(data.expectedRevision);
  return getFirestore().runTransaction(async (tx) => {
    await accountAvailable(tx, uid);
    const row = (await tx.get(ref)).data();
    if (!row || row.ownerUid !== uid) denied();
    if (row!.revokedAt) return { ok: true };
    if (row!.revision !== expected)
      throw new HttpsError(
        "failed-precondition",
        "Subscription changed. Reload before removing.",
      );
    tx.update(ref, {
      revokedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      revision: row!.revision + 1,
    });
    return { ok: true };
  });
});
/** No request, URL, bearer, provider error or private data is written to application logs. */
export const calendarFeed = onRequest(
  { cors: false, timeoutSeconds: 120 },
  async (req, res) => {
    res.set({
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": 'inline; filename="team-hangout.ics"',
    });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).end("Feed unavailable.");
      return;
    }
    const token = req.query.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      res.status(404).end("Feed unavailable.");
      return;
    }
    try {
      const { domain } = config(),
        db = getFirestore();
      const calendar = await db.runTransaction(async (tx) => {
        const row = (
          await tx.get(db.doc(`calendarSubscriptions/${sha(token)}`))
        ).data();
        if (!row || row.revokedAt) denied();
        await accountAvailable(tx, row!.ownerUid);
        const result = await authorized(tx, row!.ownerUid, row!.scope);
        return encodeCalendar(
          result.items,
          domain,
          row!.scope.includeParticipantNames,
        );
      });
      res.status(200).type("text/calendar; charset=utf-8").end(calendar);
    } catch (error) {
      const code = error instanceof HttpsError ? error.code : "internal";
      res
        .status(code === "permission-denied" ? 404 : 503)
        .type("text/plain")
        .end("Feed unavailable.");
    }
  },
);
