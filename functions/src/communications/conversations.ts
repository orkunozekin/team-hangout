import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DocumentReference, FieldPath, FieldValue, getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { accountAvailable } from "../accountAccess";
import { Data, id, invalid, keys, object, text, wire } from "../commandSupport";
import { command } from "../commandSupport";
import { messageTokens, queryTokens, reactionChoice, REACTION_CHOICES, textTokens } from "./tokens";
import { fingerprint } from "../operations/requests";
import { ATTACHMENT_LIMIT } from "./attachmentScan";
import { checkRevision, denied } from "../operations/access";
import { revision } from "../operations/revisions";
import { cacheDocumentReads } from "../operations/reads";
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
  attachments: boolean;
};
export type ConversationDecision = Decision;

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
  return {
    orgId: id(data.orgId, "orgId"),
    scopeType: scopeType(data.scopeType),
    scopeId: id(data.scopeId, "scopeId"),
  };
}
function boundedTokens(body: string): string[] {
  try { return messageTokens(body); }
  catch (error) { return invalid(error instanceof Error ? error.message : "Use 200 or fewer distinct words."); }
}
function reactionDocumentId(uid: string, code: string) {
  const actor = /^[A-Za-z0-9_-]+$/.test(uid) ? uid : createHash("sha256").update(uid).digest("hex");
  return `${actor}_${code}`;
}
function sequenceCursor(sequence: number, messageId: string) {
  return `s${sequence}_${messageId}`;
}
function parseSequenceCursor(cursor: string) {
  const match = /^s(\d+)_([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) return invalid("Invalid cursor.");
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence)) return invalid("Invalid cursor.");
  return { sequence, messageId: match[2] };
}
function searchReference(orgId: string, messageId: string) {
  return getFirestore().doc(`organizations/${orgId}/messageSearch/${messageId}`);
}
function utcInstant(value: unknown, field: string): Timestamp | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return invalid(`Invalid ${field}.`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return invalid(`Invalid ${field}.`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return invalid(`Invalid ${field}.`);
  return Timestamp.fromMillis(millis);
}
const searchCursorSecret = defineSecret("CONVERSATION_SEARCH_CURSOR_KEY");
const DEMO_CURSOR_KEYRING = JSON.stringify({
  active: 2,
  keys: {
    "1": "demo-search-cursor-previous-key-v1-do-not-use-live",
    "2": "demo-search-cursor-current-key-v2-do-not-use-live",
  },
});
function emulatorDemo() {
  return process.env.FUNCTIONS_EMULATOR === "true" && process.env.GCLOUD_PROJECT === "demo-team-hangout";
}
function cursorKeyring(): { active: number; keys: Map<number, string> } {
  let parsed: { active?: unknown; keys?: unknown };
  try { parsed = JSON.parse(emulatorDemo() ? DEMO_CURSOR_KEYRING : searchCursorSecret.value()) as { active?: unknown; keys?: unknown }; }
  catch { throw new HttpsError("failed-precondition", "Search cursor signing is not configured."); }
  if (!parsed || typeof parsed.keys !== "object" || parsed.keys == null) {
    throw new HttpsError("failed-precondition", "Search cursor signing is not configured.");
  }
  const keys = new Map<number, string>();
  for (const [version, key] of Object.entries(parsed.keys as Record<string, unknown>)) {
    const id = Number(version);
    if (!Number.isInteger(id) || id < 1 || id > 255 || typeof key !== "string" || key.length < 32) {
      throw new HttpsError("failed-precondition", "Search cursor signing is not configured.");
    }
    keys.set(id, key);
  }
  if (typeof parsed.active !== "number" || !keys.has(parsed.active)) {
    throw new HttpsError("failed-precondition", "Search cursor signing is not configured.");
  }
  return { active: parsed.active, keys };
}
function searchBinding(uid: string, conversationId: string, tokens: string[], from: string, to: string) {
  return [uid, conversationId, tokens.join("\u001f"), from, to].join("\u001e");
}
function signSearchCursor(createdAt: Timestamp, messageId: string, binding: string, restart = false) {
  const ring = cursorKeyring();
  const key = ring.keys.get(ring.active);
  if (typeof key !== "string") throw new HttpsError("failed-precondition", "Search cursor signing is not configured.");
  const idBytes = Buffer.from(messageId, "utf8");
  if (idBytes.length < 1 || idBytes.length > 64 || createdAt.seconds < 0 || createdAt.seconds > 0xffffffff) invalid("Invalid cursor.");
  const body = Buffer.alloc(12 + idBytes.length);
  body.writeUInt8(2, 0);
  body.writeUInt8(ring.active, 1);
  body.writeUInt8(restart ? 1 : 0, 2);
  body.writeUInt32BE(createdAt.seconds, 3);
  body.writeUInt32BE(createdAt.nanoseconds, 7);
  body.writeUInt8(idBytes.length, 11);
  idBytes.copy(body, 12);
  const signature = createHmac("sha256", key).update(binding).update(body).digest().subarray(0, 16);
  return Buffer.concat([body, signature]).toString("base64url");
}
function readSearchCursor(token: string, binding: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) invalid("Invalid cursor.");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length < 29 || bytes[0] !== 2) invalid("Invalid cursor.");
  const signature = bytes.subarray(bytes.length - 16);
  const body = bytes.subarray(0, bytes.length - 16);
  const key = cursorKeyring().keys.get(body[1] ?? 0);
  if (typeof key !== "string") return invalid("Invalid cursor.");
  const expected = createHmac("sha256", key).update(binding).update(body).digest().subarray(0, 16);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) invalid("Invalid cursor.");
  const idLength = body.readUInt8(11);
  if (body.length !== 12 + idLength) invalid("Invalid cursor.");
  const messageId = body.subarray(12).toString("utf8");
  if (!/^[A-Za-z0-9_-]+$/.test(messageId)) invalid("Invalid cursor.");
  return { createdAt: new Timestamp(body.readUInt32BE(3), body.readUInt32BE(7)), messageId, restart: body[2] === 1 };
}
function reactionSummaries(counts: unknown, mine: Set<string>) {
  const map = counts && typeof counts === "object" ? counts as Record<string, unknown> : {};
  return REACTION_CHOICES.flatMap((choice) => {
    const count = map[choice.code];
    const value = typeof count === "number" && Number.isSafeInteger(count) ? count : 0;
    if (value <= 0 && !mine.has(choice.code)) return [];
    return [{ emoji: choice.emoji, count: Math.max(value, 0), mine: mine.has(choice.code) }];
  });
}
function linkedAttachmentIds(row: Data): string[] {
  if (!Array.isArray(row.attachmentIds)) return [];
  return row.attachmentIds.filter((item): item is string => typeof item === "string").slice(0, ATTACHMENT_LIMIT);
}
function projectMessage(doc: { id: string; data: () => Data | undefined }, pinned: Set<string>, uid: string, mine: Set<string>, views: Map<string, { id: string; fileName: string; detectedType: string; byteLength: number; messageId: string }> = new Map()) {
  const row = doc.data() ?? {};
  const attachments = row.tombstoned === true ? [] : linkedAttachmentIds(row).flatMap((attachmentId) => {
    const view = views.get(attachmentId);
    if (!view || view.messageId !== doc.id) return [];
    return [{ id: view.id, fileName: view.fileName, detectedType: view.detectedType, byteLength: view.byteLength }];
  });
  return {
    id: doc.id,
    sequence: row.sequence,
    authorUid: row.authorUid,
    body: row.tombstoned === true ? null : row.body ?? null,
    tombstoned: row.tombstoned === true,
    pinned: pinned.has(doc.id),
    createdAt: row.createdAt ?? null,
    editedAt: row.editedAt ?? null,
    revision: row.revision ?? 0,
    mine: row.authorUid === uid,
    reactions: reactionSummaries(row.reactionCounts, mine),
    attachments,
  };
}
async function attachmentViews(reader: { getAll: (...refs: DocumentReference[]) => Promise<FirebaseFirestore.DocumentSnapshot[]> }, orgId: string, rows: { id: string; data: () => Data | undefined }[]) {
  const ids = [...new Set(rows.flatMap((row) => {
    const data = row.data();
    return !data || data.tombstoned === true ? [] : linkedAttachmentIds(data);
  }))];
  const views = new Map<string, { id: string; fileName: string; detectedType: string; byteLength: number; messageId: string }>();
  if (!ids.length) return views;
  const db = getFirestore();
  for (let index = 0; index < ids.length; index += 30) {
    const snaps = await reader.getAll(...ids.slice(index, index + 30).map((attachmentId) => db.doc(`organizations/${orgId}/attachments/${attachmentId}`)));
    for (const snap of snaps) {
      const data = snap.data() as Data | undefined;
      if (!data || data.state !== "ready" || data.orgId !== orgId || typeof data.messageId !== "string") continue;
      if (typeof data.fileName !== "string" || typeof data.detectedType !== "string" || typeof data.actualBytes !== "number") continue;
      views.set(snap.id, { id: snap.id, fileName: data.fileName, detectedType: data.detectedType, byteLength: data.actualBytes, messageId: data.messageId });
    }
  }
  return views;
}
function attachmentIdList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid("Invalid attachmentIds.");
  const items = value as unknown[];
  if (items.length > ATTACHMENT_LIMIT) {
    throw new HttpsError("failed-precondition", "A message can include 3 attachments.", { domainCode: "ATTACHMENT_LIMIT" });
  }
  const ids = items.map((item) => id(item, "attachmentId"));
  if (new Set(ids).size !== ids.length) invalid("Invalid attachmentIds.");
  return ids;
}
async function reactionMine(tx: Transaction, docs: { id: string; ref: DocumentReference }[], uid: string) {
  const refs = docs.flatMap((doc) => REACTION_CHOICES.map((choice) => doc.ref.collection("reactions").doc(reactionDocumentId(uid, choice.code))));
  const rows = [];
  for (let index = 0; index < refs.length; index += 30) rows.push(...await tx.getAll(...refs.slice(index, index + 30)));
  const mine = new Map<string, Set<string>>();
  rows.forEach((row, index) => {
    if (!row.exists) return;
    const message = docs[Math.floor(index / REACTION_CHOICES.length)];
    const choice = REACTION_CHOICES[index % REACTION_CHOICES.length];
    const codes = mine.get(message.id) ?? new Set<string>();
    codes.add(choice.code);
    mine.set(message.id, codes);
  });
  return mine;
}
function writeAudit(tx: Transaction, messageRef: DocumentReference, orgId: string, conversationId: string, messageId: string, uid: string, previousRevision: number, nextRevision: number, kind: "edit" | "tombstone") {
  tx.create(messageRef.collection("edits").doc(String(nextRevision)), {
    schemaVersion: 2, orgId, conversationId, messageId, actorUid: uid, previousRevision, revision: nextRevision, kind, editedAt: Timestamp.now(),
  });
}
function replaceSearchIndex(tx: Transaction, orgId: string, conversationId: string, messageId: string, body: string, nextRevision: number, createdAt: Timestamp, sequence: number) {
  const tokens = boundedTokens(body);
  const ref = searchReference(orgId, messageId);
  if (!tokens.length) { tx.delete(ref); return; }
  tx.set(ref, { schemaVersion: 2, orgId, conversationId, tokens, revision: nextRevision, createdAt, sequence });
}
async function liveRead(uid: string, orgId: string, scope: ScopeType, scopeId: string) {
  return getFirestore().runTransaction(async (tx) => {
    const cached = cacheDocumentReads(tx);
    await accountAvailable(cached, uid);
    const decision = await authorize(cached, orgId, scope, scopeId, uid);
    requireRead(decision);
    return decision;
  });
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
      attachments: organization.features?.attachments === true,
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
      attachments: organization.features?.attachments === true,
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
    attachments: organization.features?.attachments === true,
  };
}

export async function authorizeConversation(
  tx: Transaction,
  orgId: string,
  scope: ScopeType,
  scopeId: string,
  uid: string,
): Promise<Decision> {
  return authorize(tx, orgId, scope, scopeId, uid);
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
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "text", "attachmentIds"]);
  const scope = scopeInput(data);
  return { ...scope, text: text(data.text, "text", 4000), requestId: id(data.requestId, "requestId"), attachmentIds: attachmentIdList(data.attachmentIds) };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requirePost(decision);
  if (replay) return replay;
  const attachmentIds = payload.attachmentIds as string[];
  if (attachmentIds.length && !decision.attachments) {
    throw new HttpsError("failed-precondition", "Attachments are not enabled for this organization.", { domainCode: "FEATURE_DISABLED" });
  }
  const tokens = boundedTokens(payload.text);
  const db = getFirestore();
  const { ref, row } = await loadConversation(tx, payload.orgId, decision.conversationId);
  const attachmentRefs = attachmentIds.map((attachmentId) => db.doc(`organizations/${payload.orgId}/attachments/${attachmentId}`));
  const slotReference = db.doc(`organizations/${payload.orgId}/attachmentSlots/${fingerprint({ kind: "attachmentSlot", orgId: payload.orgId, conversationId: decision.conversationId, uid })}`);
  const snaps = attachmentRefs.length ? await tx.getAll(...attachmentRefs) : [];
  const slotSnap = attachmentRefs.length ? await tx.get(slotReference) : null;
  for (const snap of snaps) {
    const stored = snap.data() as Data | undefined;
    if (!stored || stored.orgId !== payload.orgId || stored.conversationId !== decision.conversationId || stored.ownerUid !== uid || stored.state !== "ready" || stored.messageId != null) {
      throw new HttpsError("failed-precondition", "This attachment is not available.", { domainCode: "ATTACHMENT_UNAVAILABLE" });
    }
  }
  const sequence = (row?.sequence ?? 0) + 1;
  const messageId = fingerprint({ kind: "conversationMessage", orgId: payload.orgId, conversationId: decision.conversationId, requestId: payload.requestId });
  const now = Timestamp.now();
  for (const snap of snaps) tx.update(snap.ref, { messageId, updatedAt: now });
  if (attachmentRefs.length) {
    const activeIds = Array.isArray(slotSnap?.data()?.activeIds)
      ? (slotSnap!.data() as Data).activeIds.filter((item: unknown) => typeof item === "string" && !attachmentIds.includes(item)) : [];
    tx.set(slotReference, { schemaVersion: 2, orgId: payload.orgId, ownerUid: uid, conversationId: decision.conversationId, activeIds, updatedAt: now }, { merge: true });
  }
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
    attachmentIds,
    tombstoned: false,
    revision: 0,
    idempotencyKey: payload.requestId,
    createdAt: now,
  });
  if (tokens.length) {
    tx.create(searchReference(payload.orgId, messageId), {
      schemaVersion: 2, orgId: payload.orgId, conversationId: decision.conversationId, tokens, revision: 0, createdAt: now, sequence,
    });
  }
  return { id: messageId, sequence };
});

export const listConversationMessages = readCommand((data) => {
  keys(data, ["orgId", "scopeType", "scopeId", "pageSize", "cursor"]);
  const scope = scopeInput(data);
  const pageSize = data.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid("pageSize must be 1 through 50.");
  return { ...scope, pageSize, cursor: data.cursor == null ? null : id(data.cursor, "cursor") };
}, async (tx, payload, uid) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requireRead(decision);
  const db = getFirestore();
  const messages = db.collection(`organizations/${payload.orgId}/conversations/${decision.conversationId}/messages`);
  let query = messages.orderBy("sequence", "desc").orderBy(FieldPath.documentId(), "desc").limit(payload.pageSize + 1);
  if (payload.cursor) {
    const parsed = parseSequenceCursor(payload.cursor);
    const cursor = await tx.get(messages.doc(parsed.messageId));
    if (!cursor.exists || cursor.data()?.sequence !== parsed.sequence) invalid("Invalid cursor.");
    query = query.startAfter(cursor);
  }
  const conversation = (await tx.get(db.doc(`organizations/${payload.orgId}/conversations/${decision.conversationId}`))).data();
  const rows = await tx.get(query);
  const pinned = new Set<string>(conversation?.pinnedMessageIds ?? []);
  const page = rows.docs.slice(0, payload.pageSize);
  const mine = await reactionMine(tx, page, uid);
  const views = await attachmentViews(tx, payload.orgId, page);
  return {
    conversationId: decision.conversationId,
    mode: decision.mode,
    youthPosting: decision.youthPosting,
    pinnedIds: [...pinned],
    items: page.map((doc) => projectMessage(doc, pinned, uid, mine.get(doc.id) ?? new Set(), views)),
    nextCursor: rows.size > page.length && page.length ? sequenceCursor(page[page.length - 1].data().sequence, page[page.length - 1].id) : null,
    attachments: decision.attachments ? "enabled" : "disabled",
    canPost: decision.post,
  };
});

export const setConversationPin = command("setConversationPin", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId", "pinned"]);
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
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId", "reason"]);
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
  if (message.data()?.tombstoned === true) return { id: payload.messageId, tombstoned: true as const };
  const previousRevision = message.data()?.revision ?? 0;
  const nextRevision = previousRevision + 1;
  const pinned = (Array.isArray(row?.pinnedMessageIds) ? row.pinnedMessageIds : []).filter((id: string) => id !== payload.messageId);
  tx.update(messageRef, {
    body: FieldValue.delete(),
    tombstoned: true,
    moderationReason: payload.reason,
    moderatedBy: uid,
    moderatedAt: Timestamp.now(),
    revision: nextRevision,
  });
  tx.delete(searchReference(payload.orgId, payload.messageId));
  writeAudit(tx, messageRef, payload.orgId, decision.conversationId, payload.messageId, uid, previousRevision, nextRevision, "tombstone");
  tx.set(ref, { pinnedMessageIds: pinned, revision: (row?.revision ?? 0) + 1, updatedAt: Timestamp.now() }, { merge: true });
  return { id: payload.messageId, tombstoned: true as const };
});

export const editConversationMessage = command("editConversationMessage", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId", "text", "expectedRevision"]);
  return {
    ...scopeInput(data),
    messageId: id(data.messageId, "messageId"),
    text: text(data.text, "text", 4000),
    expectedRevision: revision(data.expectedRevision),
    requestId: id(data.requestId, "requestId"),
  };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requirePost(decision);
  const messageRef = getFirestore().doc(`organizations/${payload.orgId}/conversations/${decision.conversationId}/messages/${payload.messageId}`);
  const message = await tx.get(messageRef);
  if (!message.exists) throw new HttpsError("not-found", "Message not found.");
  if (message.data()?.authorUid !== uid) denied();
  if (replay) return replay;
  if (message.data()?.tombstoned === true) throw new HttpsError("failed-precondition", "Removed messages cannot be edited.");
  checkRevision(message.data(), payload.expectedRevision);
  const previousRevision = message.data()?.revision ?? 0;
  const nextRevision = previousRevision + 1;
  const now = Timestamp.now();
  tx.update(messageRef, { body: payload.text, editedAt: now, revision: nextRevision });
  replaceSearchIndex(tx, payload.orgId, decision.conversationId, payload.messageId, payload.text, nextRevision, message.data()?.createdAt ?? now, message.data()?.sequence);
  writeAudit(tx, messageRef, payload.orgId, decision.conversationId, payload.messageId, uid, previousRevision, nextRevision, "edit");
  return { id: payload.messageId, revision: nextRevision, editedAt: now };
});

export const reactToConversationMessage = command("reactToConversationMessage", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId", "emoji", "expectedRevision"]);
  const choice = reactionChoice(typeof data.emoji === "string" ? data.emoji : "");
  if (!choice) return invalid("Choose an allowed reaction.");
  return {
    ...scopeInput(data),
    messageId: id(data.messageId, "messageId"),
    emoji: choice.emoji,
    code: choice.code,
    expectedRevision: revision(data.expectedRevision),
    requestId: id(data.requestId, "requestId"),
  };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorize(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  requirePost(decision);
  const messageRef = getFirestore().doc(`organizations/${payload.orgId}/conversations/${decision.conversationId}/messages/${payload.messageId}`);
  const reactionRef = messageRef.collection("reactions").doc(reactionDocumentId(uid, payload.code));
  const [message, reaction] = await tx.getAll(messageRef, reactionRef);
  if (!message.exists) throw new HttpsError("not-found", "Message not found.");
  if (replay) return replay;
  if (message.data()?.tombstoned === true) throw new HttpsError("failed-precondition", "Removed messages cannot be reacted to.");
  checkRevision(message.data(), payload.expectedRevision);
  const active = !reaction.exists;
  const counts = message.data()?.reactionCounts ?? {};
  const current = typeof counts[payload.code] === "number" && Number.isSafeInteger(counts[payload.code]) ? counts[payload.code] : 0;
  const count = Math.max(0, current + (active ? 1 : -1));
  if (active) {
    tx.create(reactionRef, {
      schemaVersion: 2, orgId: payload.orgId, conversationId: decision.conversationId, messageId: payload.messageId,
      actorUid: uid, emoji: payload.emoji, code: payload.code, createdAt: Timestamp.now(),
    });
  } else tx.delete(reactionRef);
  tx.update(messageRef, { [`reactionCounts.${payload.code}`]: count });
  return { messageId: payload.messageId, emoji: payload.emoji, active, count };
});

async function noteAccess(tx: Transaction, orgId: string, scope: ScopeType, scopeId: string, uid: string) {
  const decision = await authorize(tx, orgId, scope, scopeId, uid);
  if (!decision.moderate) denied();
  return decision;
}

export const postStaffNote = command("postStaffNote", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "text"]);
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
  keys(data, ["orgId", "scopeType", "scopeId", "pageSize", "cursor"]);
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

const SEARCH_BATCH = 200;
const SEARCH_CAP = 1000;
const SEARCH_PAGE = 50;
const BACKFILL_BATCH = 100;

function writeFreshIndex(tx: Transaction, orgId: string, conversationId: string, messageId: string, row: Data | undefined) {
  const ref = searchReference(orgId, messageId);
  const createdAt = row?.createdAt;
  const tokens = textTokens(typeof row?.body === "string" ? row.body : "").slice(0, 200);
  if (!row || row.tombstoned === true || !tokens.length || !(createdAt instanceof Timestamp) || typeof row.sequence !== "number") {
    tx.delete(ref);
    return;
  }
  tx.set(ref, {
    schemaVersion: 2, orgId, conversationId, tokens, revision: row.revision ?? 0, createdAt, sequence: row.sequence,
  });
}

async function backfillSearchIndex(uid: string, orgId: string, scope: ScopeType, scopeId: string, conversationId: string) {
  const db = getFirestore();
  const conversationRef = db.doc(`organizations/${orgId}/conversations/${conversationId}`);
  const conversation = await conversationRef.get();
  if (conversation.get("searchIndexComplete") === true) return true;
  const stored = conversation.get("searchIndexCursor");
  const messages = db.collection(`organizations/${orgId}/conversations/${conversationId}/messages`);
  let query = messages.orderBy("sequence", "desc").orderBy(FieldPath.documentId(), "desc").limit(BACKFILL_BATCH + 1);
  if (stored && typeof stored === "object" && typeof stored.sequence === "number" && typeof stored.messageId === "string") {
    query = query.startAfter(stored.sequence, stored.messageId);
  }
  const snap = await query.get();
  const page = snap.docs.slice(0, BACKFILL_BATCH);
  const complete = snap.size <= BACKFILL_BATCH;
  await liveRead(uid, orgId, scope, scopeId);
  if (conversation.exists || page.length) {
    await db.runTransaction(async (tx) => {
      const fresh = [];
      for (const doc of page) fresh.push(await tx.get(doc.ref));
      const currentConversation = await tx.get(conversationRef);
      for (const doc of fresh) writeFreshIndex(tx, orgId, conversationId, doc.id, doc.data());
      if (currentConversation.get("searchIndexComplete") === true) return;
      const last = page[page.length - 1];
      tx.set(conversationRef, {
        searchIndexComplete: complete,
        ...(last ? { searchIndexCursor: { sequence: last.get("sequence"), messageId: last.id } } : {}),
      }, { merge: true });
    });
  }
  return complete;
}

function currentTextMatches(index: Data, message: Data | undefined, tokens: string[], conversationId: string) {
  if (!message || message.tombstoned === true || typeof message.body !== "string") return false;
  if (message.conversationId != null && message.conversationId !== conversationId) return false;
  if ((message.revision ?? 0) !== index.revision) return false;
  const indexed = Array.isArray(index.tokens) ? index.tokens : [];
  const current = textTokens(message.body);
  return tokens.every((token) => indexed.includes(token) && current.includes(token));
}

export const searchConversationMessages = onCall(emulatorDemo() ? {} : { secrets: [searchCursorSecret] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const data = object(request.data);
  keys(data, ["orgId", "scopeType", "scopeId", "text", "cursor", "from", "to"]);
  const scope = scopeInput(data);
  const tokens = (() => {
    try { return queryTokens(text(data.text, "text", 200)); }
    catch (error) { return invalid(error instanceof Error ? error.message : "Enter a word of at least 2 letters or numbers."); }
  })();
  const from = utcInstant(data.from, "from");
  const to = utcInstant(data.to, "to");
  if (from && to && from.toMillis() > to.toMillis()) invalid("Invalid date range.");
  const fromKey = from ? from.toDate().toISOString() : "";
  const toKey = to ? to.toDate().toISOString() : "";
  let decision = await liveRead(uid, scope.orgId, scope.scopeType, scope.scopeId);
  const binding = searchBinding(uid, decision.conversationId, tokens, fromKey, toKey);
  const decoded = data.cursor == null ? null : readSearchCursor(id(data.cursor, "cursor"), binding);
  let position = decoded == null || decoded.restart ? null : { createdAt: decoded.createdAt, messageId: decoded.messageId };
  const indexComplete = await backfillSearchIndex(uid, scope.orgId, scope.scopeType, scope.scopeId, decision.conversationId);
  const db = getFirestore();
  const collection = db.collection(`organizations/${scope.orgId}/messageSearch`);
  const candidates = (limit: number, after: { createdAt: Timestamp; messageId: string } | null) => {
    let query = collection.where("conversationId", "==", decision.conversationId).where("tokens", "array-contains", tokens[0]);
    if (from) query = query.where("createdAt", ">=", from);
    if (to) query = query.where("createdAt", "<=", to);
    query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(limit);
    if (after) query = query.startAfter(after.createdAt, after.messageId);
    return query;
  };
  let scanned = 0;
  let exhausted = false;
  const matches: { createdAt: Timestamp; messageId: string; message: Data }[] = [];
  while (matches.length < SEARCH_PAGE && scanned < SEARCH_CAP) {
    const take = Math.min(SEARCH_BATCH, SEARCH_CAP - scanned);
    const snap = await candidates(take, position).get();
    const batchExhausted = snap.size < take;
    if (snap.empty) { exhausted = true; break; }
    const messages = await db.getAll(...snap.docs.map((doc) => db.doc(`organizations/${scope.orgId}/conversations/${decision.conversationId}/messages/${doc.id}`)));
    let stoppedEarly = false;
    for (let index = 0; index < snap.docs.length; index += 1) {
      const doc = snap.docs[index];
      const createdAt = doc.get("createdAt");
      scanned += 1;
      if (createdAt instanceof Timestamp) position = { createdAt, messageId: doc.id };
      if (createdAt instanceof Timestamp && currentTextMatches(doc.data(), messages[index]?.data(), tokens, decision.conversationId)) {
        matches.push({ createdAt, messageId: doc.id, message: messages[index].data()! });
      }
      if (matches.length >= SEARCH_PAGE || scanned >= SEARCH_CAP) {
        stoppedEarly = index < snap.docs.length - 1;
        break;
      }
    }
    if (stoppedEarly) { exhausted = false; break; }
    if (matches.length >= SEARCH_PAGE || scanned >= SEARCH_CAP) {
      if (!position || batchExhausted) { exhausted = true; break; }
      const probe = await candidates(1, position).get();
      exhausted = probe.empty;
      break;
    }
    if (batchExhausted) { exhausted = true; break; }
    decision = await liveRead(uid, scope.orgId, scope.scopeType, scope.scopeId);
  }
  decision = await liveRead(uid, scope.orgId, scope.scopeType, scope.scopeId);
  const conversation = (await db.doc(`organizations/${scope.orgId}/conversations/${decision.conversationId}`).get()).data();
  const pinned = new Set<string>(Array.isArray(conversation?.pinnedMessageIds) ? conversation.pinnedMessageIds : []);
  const messageRefs = matches.map((match) => db.doc(`organizations/${scope.orgId}/conversations/${decision.conversationId}/messages/${match.messageId}`));
  const mine = new Map<string, Set<string>>();
  const reactionRefs = messageRefs.flatMap((ref) => REACTION_CHOICES.map((choice) => ref.collection("reactions").doc(reactionDocumentId(uid, choice.code))));
  for (let index = 0; index < reactionRefs.length; index += 100) {
    const rows = await db.getAll(...reactionRefs.slice(index, index + 100));
    rows.forEach((row, offset) => {
      if (!row.exists) return;
      const absolute = index + offset;
      const messageId = matches[Math.floor(absolute / REACTION_CHOICES.length)]?.messageId;
      const choice = REACTION_CHOICES[absolute % REACTION_CHOICES.length];
      if (!messageId) return;
      const codes = mine.get(messageId) ?? new Set<string>();
      codes.add(choice.code);
      mine.set(messageId, codes);
    });
  }
  const backfillRemains = !indexComplete;
  const restart = backfillRemains || position == null;
  const resume = !exhausted && position != null && !backfillRemains;
  const more = resume || backfillRemains;
  const cursorAt = restart || position == null ? new Timestamp(0, 0) : position.createdAt;
  const cursorId = restart || position == null ? "restart" : position.messageId;
  const views = await attachmentViews(db, scope.orgId, matches.map((match) => ({ id: match.messageId, data: () => match.message })));
  return wire({
    items: matches.map((match) => projectMessage({ id: match.messageId, data: () => match.message }, pinned, uid, mine.get(match.messageId) ?? new Set(), views)),
    nextCursor: more ? signSearchCursor(cursorAt, cursorId, binding, restart) : null,
    partial: (scanned >= SEARCH_CAP && resume) || backfillRemains,
  });
});
