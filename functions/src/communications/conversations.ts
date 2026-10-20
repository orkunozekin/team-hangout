import { FieldPath, FieldValue, getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { Data, id, invalid, keys, text } from "../commandSupport";
import { command } from "../commandSupport";
import { fingerprint } from "../operations/requests";
import { denied } from "../operations/access";
import { readCommand } from "../participants/policy";
import { publishedEvent } from "../scheduling/visibility";

const SCOPES = ["organization", "division", "team", "event"] as const;
type ScopeType = (typeof SCOPES)[number];
type Decision = {
  read: boolean;
  post: boolean;
  pin: boolean;
  moderate: boolean;
  youthBlocked: boolean;
  youthPosting: "open" | "closed";
  programId: string | null;
  mode: "youth" | "adult";
  conversationId: string;
};

function scopeType(value: unknown): ScopeType {
  if (value === "direct") {
    throw new HttpsError("failed-precondition", "Direct messages are not available.", {
      domainCode: "YOUTH_POLICY",
    });
  }
  if (typeof value !== "string" || !SCOPES.includes(value as ScopeType)) invalid("Invalid scopeType.");
  return value as ScopeType;
}
function scopeInput(data: Data) {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "text", "messageId", "pinned", "reason", "pageSize", "cursor"]);
  return {
    orgId: id(data.orgId, "orgId"),
    scopeType: scopeType(data.scopeType),
    scopeId: id(data.scopeId, "scopeId"),
  };
}
function conversationIdFor(orgId: string, scope: ScopeType, scopeId: string) {
  return fingerprint({ kind: "conversation", orgId, scopeType: scope, scopeId, channel: "household" });
}
function noteScopeKey(scope: ScopeType, scopeId: string) {
  return `${scope}_${scopeId}`;
}
function youthClosed(): never {
  throw new HttpsError(
    "failed-precondition",
    "Youth channels stay closed until the organization approves the policy.",
    { domainCode: "YOUTH_POLICY" },
  );
}
function disabled(): never {
  throw new HttpsError("failed-precondition", "Conversations are not enabled for this organization.", {
    domainCode: "FEATURE_DISABLED",
  });
}

async function organizationOf(tx: Transaction, orgId: string) {
  const organization = (await tx.get(getFirestore().doc(`organizations/${orgId}`))).data();
  if (!organization || organization.schemaVersion !== 2 || organization.status !== "active") denied();
  if (organization.features?.conversations !== true) disabled();
  return organization;
}

async function membership(tx: Transaction, orgId: string, uid: string) {
  const grant = (
    await tx.get(getFirestore().doc(`organizations/${orgId}/members/${uid}`))
  ).data();
  const roles = Array.isArray(grant?.roles) ? grant.roles as string[] : [];
  const sameOrg = grant?.status === "active" && grant?.orgId === orgId;
  const staff = sameOrg && (roles.includes("orgAdmin") || roles.includes("programStaff"));
  return {
    staff,
    admin: sameOrg && roles.includes("orgAdmin"),
    programIds: sameOrg && Array.isArray(grant?.programIds) ? (grant.programIds as string[]) : [],
  };
}

async function coachOf(tx: Transaction, orgId: string, teamIds: string[], uid: string) {
  if (!teamIds.length) return false;
  const docs = await tx.getAll(
    ...teamIds.map((teamId) => getFirestore().doc(`teamMembers/${teamId}_${uid}`)),
  );
  return docs.some((doc) => {
    const row = doc.data();
    return (
      row?.status === "active" &&
      row.orgId === orgId &&
      row.userId === uid &&
      Array.isArray(row.roles) &&
      row.roles.some((role: string) => role === "coach" || role === "captain")
    );
  });
}

function guardianParticipantId(orgId: string, path: string, row: Data) {
  const participantId = typeof row.participantId === "string" ? row.participantId : "";
  const userId = typeof row.userId === "string" ? row.userId : "";
  if (
    row.orgId !== orgId ||
    row.permissions?.viewSchedule !== true ||
    path !== `organizations/${orgId}/participants/${participantId}/guardians/${userId}`
  ) return null;
  return participantId;
}

function activeParticipant(row: Data | undefined, orgId: string) {
  return !!row && row.schemaVersion === 2 && row.status === "active" && (row.orgId == null || row.orgId === orgId);
}

async function householdOnTeams(tx: Transaction, orgId: string, teamIds: string[], uid: string) {
  const db = getFirestore();
  const [guardians, linked] = await Promise.all([
    tx.get(
      db
        .collectionGroup("guardians")
        .where("orgId", "==", orgId)
        .where("userId", "==", uid)
        .where("status", "==", "active")
        .limit(11),
    ),
    tx.get(db.collectionGroup("participants").where("linkedUserId", "==", uid).limit(21)),
  ]);
  if (guardians.size > 10 || linked.size > 20) {
    throw new HttpsError("resource-exhausted", "This household has too many active relationships.");
  }
  const participantIds = new Set<string>();
  for (const grant of guardians.docs) {
    const participantId = guardianParticipantId(orgId, grant.ref.path, grant.data());
    if (participantId) participantIds.add(participantId);
  }
  for (const participant of linked.docs) {
    const row = participant.data();
    if (
      activeParticipant(row, orgId) &&
      participant.ref.path === `organizations/${orgId}/participants/${participant.id}`
    )
      participantIds.add(participant.id);
  }
  const candidates = [...participantIds];
  const participantRows = candidates.length
    ? await tx.getAll(...candidates.map((participantId) => db.doc(`organizations/${orgId}/participants/${participantId}`)))
    : [];
  const activeIds = new Set(participantRows.filter((doc) => activeParticipant(doc.data(), orgId)).map((doc) => doc.id));
  for (const participantId of activeIds) {
    for (const teamId of teamIds) {
      const roster = (
        await tx.get(db.doc(`teams/${teamId}/roster/${participantId}`))
      ).data();
      if (
        roster?.status === "active" &&
        roster.orgId === orgId &&
        roster.participantId === participantId
      )
        return true;
    }
  }
  return false;
}

async function authorize(
  tx: Transaction,
  orgId: string,
  scope: ScopeType,
  scopeId: string,
  uid: string,
): Promise<Decision> {
  const db = getFirestore();
  const organization = await organizationOf(tx, orgId);
  const member = await membership(tx, orgId, uid);
  const youthApproved = organization.policies?.youthChannels === "approved";
  const conversationId = conversationIdFor(orgId, scope, scopeId);
  if (scope === "organization") {
    if (scopeId !== orgId) denied();
    const orgHousehold = member.staff ? false : await orgHouseholdRead(tx, orgId, uid);
    return {
      read: member.staff || orgHousehold,
      post: member.staff,
      pin: member.staff,
      moderate: member.staff,
      youthBlocked: false,
      youthPosting: "closed" as const,
      programId: null,
      mode: "adult",
      conversationId,
    };
  }
  if (scope === "division") {
    const division = (await tx.get(db.doc(`organizations/${orgId}/divisions/${scopeId}`))).data();
    if (!division || division.orgId !== orgId || division.schemaVersion !== 2 || division.status !== "active")
      denied();
    const programId = typeof division.programId === "string" ? division.programId : null;
    const staff = member.admin || (member.staff && programId != null && member.programIds.includes(programId));
    const teams = await tx.get(
      db.collection("teams").where("orgId", "==", orgId).where("divisionId", "==", scopeId).where("status", "==", "active").limit(33),
    );
    if (teams.size > 32) throw new HttpsError("resource-exhausted", "This division has too many teams.");
    const household = await householdOnTeams(tx, orgId, teams.docs.map((doc) => doc.id), uid);
    return {
      read: staff || household,
      post: staff,
      pin: staff,
      moderate: staff,
      youthBlocked: false,
      youthPosting: "closed" as const,
      programId,
      mode: "adult" as const,
      conversationId,
    };
  }
  let programId: string | null = null;
  let teamIds: string[] = [];
  let eventPublished = true;
  if (scope === "team") {
    const team = (await tx.get(db.doc(`teams/${scopeId}`))).data();
    if (!team || team.orgId !== orgId || team.schemaVersion !== 2 || team.status !== "active") denied();
    programId = typeof team.programId === "string" ? team.programId : null;
    teamIds = [scopeId];
  } else {
    const event = (await tx.get(db.doc(`events/${scopeId}`))).data();
    if (!event || event.orgId !== orgId || event.schemaVersion !== 2 || event.deletedAt != null) denied();
    programId = typeof event.programId === "string" ? event.programId : null;
    teamIds = Array.isArray(event.teamIds) ? event.teamIds.filter((teamId: unknown) => typeof teamId === "string") : [];
    eventPublished = await publishedEvent(tx, event);
  }
  const staff = member.admin || (member.staff && programId != null && member.programIds.includes(programId));
  const coach = await coachOf(tx, orgId, teamIds, uid);
  if (!eventPublished && !staff && !coach) denied();
  const household = eventPublished ? await householdOnTeams(tx, orgId, teamIds, uid) : false;
  const adultPoster = staff || coach;
  return {
    read: staff || coach || household,
    post: adultPoster || (household && youthApproved),
    pin: adultPoster,
    moderate: staff,
    youthBlocked: household && !adultPoster && !youthApproved,
    youthPosting: youthApproved ? "open" as const : "closed" as const,
    programId,
    mode: "youth" as const,
    conversationId,
  };
}

async function orgHouseholdRead(tx: Transaction, orgId: string, uid: string) {
  const db = getFirestore();
  const [guardians, linked] = await Promise.all([
    tx.get(
      db.collectionGroup("guardians").where("orgId", "==", orgId).where("userId", "==", uid).where("status", "==", "active").limit(11),
    ),
    tx.get(db.collectionGroup("participants").where("linkedUserId", "==", uid).limit(21)),
  ]);
  if (guardians.size > 10 || linked.size > 20) {
    throw new HttpsError("resource-exhausted", "This household has too many active relationships.");
  }
  const participantIds = guardians.docs.flatMap((doc) => {
    const participantId = guardianParticipantId(orgId, doc.ref.path, doc.data());
    return participantId ? [participantId] : [];
  });
  const rows = participantIds.length
    ? await tx.getAll(...participantIds.map((participantId) => db.doc(`organizations/${orgId}/participants/${participantId}`)))
    : [];
  if (rows.some((doc) => activeParticipant(doc.data(), orgId))) return true;
  return linked.docs.some(
    (doc) =>
      activeParticipant(doc.data(), orgId) &&
      doc.ref.path === `organizations/${orgId}/participants/${doc.id}`,
  );
}

function requireRead(decision: Decision) {
  if (!decision.read) denied();
}
function requirePost(decision: Decision) {
  if (decision.youthBlocked) youthClosed();
  if (!decision.post) denied();
}

async function loadConversation(tx: Transaction, orgId: string, conversationId: string) {
  const ref = getFirestore().doc(`organizations/${orgId}/conversations/${conversationId}`);
  return { ref, row: (await tx.get(ref)).data() };
}

export const postConversationMessage = command("postConversationMessage", (data) => {
  const scope = scopeInput(data);
  return { ...scope, text: text(data.text, "text", 4000), requestId: id(data.requestId, "requestId") };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requirePost(decision);
  if (replay) return replay;
  const { ref, row } = await loadConversation(tx, payload.orgId, decision.conversationId);
  const sequence = (row?.sequence ?? 0) + 1;
  const messageId = fingerprint({ kind: "conversationMessage", orgId: payload.orgId, conversationId: decision.conversationId, requestId: payload.requestId });
  const now = Timestamp.now();
  tx.set(ref, {
    schemaVersion: 2,
    orgId: payload.orgId,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    programId: decision.programId,
    mode: decision.mode,
    sequence,
    pinnedMessageIds: row?.pinnedMessageIds ?? [],
    revision: (row?.revision ?? 0) + 1,
    updatedAt: now,
    createdAt: row?.createdAt ?? now,
  }, { merge: true });
  tx.create(ref.collection("messages").doc(messageId), {
    schemaVersion: 2,
    orgId: payload.orgId,
    conversationId: decision.conversationId,
    authorUid: uid,
    sequence,
    body: payload.text,
    tombstoned: false,
    createdAt: now,
  });
  return { id: messageId, sequence };
});

export const listConversationMessages = readCommand((data) => {
  const scope = scopeInput(data);
  const pageSize = data.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid("pageSize must be 1 through 50.");
  return { ...scope, pageSize, cursor: data.cursor == null ? null : id(data.cursor, "cursor") };
}, async (tx, payload, uid) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requireRead(decision);
  const db = getFirestore();
  let query = db.collection(`organizations/${payload.orgId}/conversations/${decision.conversationId}/messages`)
    .orderBy("sequence", "desc").orderBy(FieldPath.documentId(), "desc").limit(payload.pageSize + 1);
  if (payload.cursor) {
    const cursor = await tx.get(db.doc(`organizations/${payload.orgId}/conversations/${decision.conversationId}/messages/${payload.cursor}`));
    if (!cursor.exists) invalid("Invalid cursor.");
    query = query.startAfter(cursor);
  }
  const conversation = (await tx.get(db.doc(`organizations/${payload.orgId}/conversations/${decision.conversationId}`))).data();
  const rows = await tx.get(query);
  const pinned = new Set<string>(conversation?.pinnedMessageIds ?? []);
  const page = rows.docs.slice(0, payload.pageSize);
  return {
    conversationId: decision.conversationId,
    mode: decision.mode,
    youthPosting: decision.youthPosting,
    pinnedIds: [...pinned],
    items: page.map((doc) => {
      const row = doc.data();
      return {
        id: doc.id,
        sequence: row.sequence,
        authorUid: row.authorUid,
        body: row.tombstoned === true ? null : row.body,
        tombstoned: row.tombstoned === true,
        pinned: pinned.has(doc.id),
        createdAt: row.createdAt,
      };
    }),
    nextCursor: rows.size > page.length ? page[page.length - 1]?.id ?? null : null,
  };
});

export const setConversationPin = command("setConversationPin", (data) => {
  const scope = scopeInput(data);
  if (typeof data.pinned !== "boolean") invalid("Invalid pinned.");
  return { ...scope, messageId: id(data.messageId, "messageId"), pinned: data.pinned };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  if (!decision.pin) denied();
  if (replay) return replay;
  const { ref, row } = await loadConversation(tx, payload.orgId, decision.conversationId);
  const message = await tx.get(ref.collection("messages").doc(payload.messageId));
  if (!message.exists || message.data()?.tombstoned === true) {
    throw new HttpsError("failed-precondition", "That message cannot be pinned.");
  }
  const current = Array.isArray(row?.pinnedMessageIds) ? [...row.pinnedMessageIds] : [];
  const next = payload.pinned
    ? [...new Set([...current, payload.messageId])].slice(0, 3)
    : current.filter((id) => id !== payload.messageId);
  if (payload.pinned && !current.includes(payload.messageId) && current.length >= 3) {
    throw new HttpsError("resource-exhausted", "Unpin a message before pinning another.");
  }
  tx.set(ref, { pinnedMessageIds: next, revision: (row?.revision ?? 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  return { pinnedIds: next };
});

export const moderateConversationMessage = command("moderateConversationMessage", (data) => {
  const scope = scopeInput(data);
  return { ...scope, messageId: id(data.messageId, "messageId"), reason: text(data.reason, "reason", 200) };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  if (!decision.moderate) denied();
  if (replay) return replay;
  const { ref, row } = await loadConversation(tx, payload.orgId, decision.conversationId);
  const messageRef = ref.collection("messages").doc(payload.messageId);
  const message = await tx.get(messageRef);
  if (!message.exists) throw new HttpsError("not-found", "Message not found.");
  const pinned = (Array.isArray(row?.pinnedMessageIds) ? row.pinnedMessageIds : []).filter((id: string) => id !== payload.messageId);
  tx.update(messageRef, {
    body: FieldValue.delete(),
    tombstoned: true,
    moderationReason: payload.reason,
    moderatedBy: uid,
    moderatedAt: Timestamp.now(),
    revision: (message.data()?.revision ?? 0) + 1,
  });
  tx.set(ref, { pinnedMessageIds: pinned, revision: (row?.revision ?? 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  return { id: payload.messageId, tombstoned: true as const };
});

async function noteAccess(tx: Transaction, orgId: string, scope: ScopeType, scopeId: string, uid: string) {
  const decision = await authorize(tx, orgId, scope, scopeId, uid);
  if (!decision.moderate) denied();
  return decision;
}

export const postStaffNote = command("postStaffNote", (data) => {
  const scope = scopeInput(data);
  return { ...scope, text: text(data.text, "text", 4000), requestId: id(data.requestId, "requestId") };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await noteAccess(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  if (replay) return replay;
  const noteId = fingerprint({ kind: "staffNote", orgId: payload.orgId, scopeType: payload.scopeType, scopeId: payload.scopeId, requestId: payload.requestId });
  const ref = getFirestore().doc(`organizations/${payload.orgId}/staffNotes/${noteScopeKey(payload.scopeType, payload.scopeId)}/entries/${noteId}`);
  tx.create(ref, {
    schemaVersion: 2,
    orgId: payload.orgId,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    programId: decision.programId,
    authorUid: uid,
    body: payload.text,
    createdAt: Timestamp.now(),
  });
  return { id: noteId };
});

export const listStaffNotes = readCommand((data) => {
  const scope = scopeInput(data);
  const pageSize = data.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid("pageSize must be 1 through 50.");
  return { ...scope, pageSize, cursor: data.cursor == null ? null : id(data.cursor, "cursor") };
}, async (tx, payload, uid) => {
  await noteAccess(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  const db = getFirestore();
  const collection = db.collection(`organizations/${payload.orgId}/staffNotes/${noteScopeKey(payload.scopeType, payload.scopeId)}/entries`);
  let query = collection.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(payload.pageSize + 1);
  if (payload.cursor) {
    const cursor = await tx.get(collection.doc(payload.cursor));
    if (!cursor.exists) invalid("Invalid cursor.");
    query = query.startAfter(cursor);
  }
  const rows = await tx.get(query);
  const page = rows.docs.slice(0, payload.pageSize);
  return {
    items: page.map((doc) => ({ id: doc.id, body: doc.data().body, authorUid: doc.data().authorUid, createdAt: doc.data().createdAt })),
    nextCursor: rows.size > page.length ? page[page.length - 1]?.id ?? null : null,
  };
});
