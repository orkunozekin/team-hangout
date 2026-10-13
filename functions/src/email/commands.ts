import { FieldPath, getFirestore, Timestamp } from "firebase-admin/firestore";
import { command, id, invalid, keys } from "../commandSupport";
import { adminScope, page, readCommand } from "../participants/policy";
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
  async (tx, _data, uid) => ({
    suppressed:
      (
        await tx.get(getFirestore().doc(`users/${uid}/communication/essential`))
      ).data()?.suppressed === true,
  }),
);
export const setEssentialEmailPreference = command(
  "setEssentialEmailPreference",
  (data) => {
    keys(data, ["requestId", "suppressed"]);
    if (typeof data.suppressed !== "boolean")
      invalid("Choose an email preference.");
    return { suppressed: data.suppressed };
  },
  async (tx, data, uid, _actor, replay) => {
    if (replay) return replay;
    tx.set(getFirestore().doc(`users/${uid}/communication/essential`), {
      suppressed: data.suppressed,
      updatedAt: Timestamp.now(),
      schemaVersion: 2,
    });
    return { suppressed: data.suppressed };
  },
);
