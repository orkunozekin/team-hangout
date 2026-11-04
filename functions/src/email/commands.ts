import { checkRevision } from "../organizations/policy";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { command, id, invalid, keys, revision } from "../commandSupport";
import {
  adminScope,
  metadata,
  page,
  readCommand,
} from "../participants/policy";
export const listEssentialEmail = readCommand(
  (data) => {
    keys(data, ["orgId", "cursor", "pageSize"]);
    return { orgId: id(data.orgId, "orgId"), ...page(data) };
  },
  async (tx, data, uid) => {
    await adminScope(tx, data.orgId, uid);
    let query = getFirestore()
      .collection("emailOutbox")
      .where("orgId", "==", data.orgId)
      .orderBy(FieldPath.documentId())
      .limit(data.pageSize + 1);
    if (data.cursor) query = query.startAfter(data.cursor);
    const rows = await tx.get(query);
    return {
      items: rows.docs.slice(0, data.pageSize).map((d) => {
        const r = d.data();
        return {
          id: d.id,
          kind: r.kind,
          status: r.status,
          attemptCount: r.attemptCount ?? 0,
          failureCode: r.failureCode ?? null,
          nextAttemptAt: r.nextAttemptAt ?? null,
        };
      }),
      nextCursor:
        rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null,
    };
  },
);
export const getEssentialEmailPreference = readCommand(
  (data) => {
    keys(data, []);
    return {};
  },
  async (tx, _data, uid) => {
    const row = (
      await tx.get(getFirestore().doc(`users/${uid}/communication/essential`))
    ).data();
    return {
      suppressed: row?.suppressed === true,
      revision: row?.revision ?? 0,
    };
  },
);

export const setEssentialEmailPreference = command(
  "setEssentialEmailPreference",
  (data) => {
    keys(data, ["requestId", "suppressed", "expectedRevision"]);
    if (typeof data.suppressed !== "boolean")
      invalid("Choose an email preference.");
    return {
      suppressed: data.suppressed,
      expectedRevision: revision(data.expectedRevision),
    };
  },
  async (tx, data, uid, _actor, replay) => {
    if (replay) return replay;
    const ref = getFirestore().doc(`users/${uid}/communication/essential`);
    const before = (await tx.get(ref)).data();
    checkRevision(before, data.expectedRevision);
    const next = metadata(uid, before);
    next.suppressed = data.suppressed;
    tx.set(ref, next);
    return { suppressed: next.suppressed, revision: next.revision };
  },
);
