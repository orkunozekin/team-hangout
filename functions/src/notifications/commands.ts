import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, keys } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { hasNotificationAccess } from './worker';

function stale(): never { throw new HttpsError('failed-precondition', 'This notification changed. Reload and try again.', { domainCode: 'STALE_REVISION' }); }
const normalizeMutation = (data: Data) => { keys(data, ['requestId', 'notificationId', 'sourceRevision']);
  if (!Number.isSafeInteger(data.sourceRevision) || data.sourceRevision < 1) throw new HttpsError('invalid-argument', 'Invalid sourceRevision.');
  return { notificationId: id(data.notificationId, 'notificationId'), sourceRevision: data.sourceRevision }; };
async function load(tx: FirebaseFirestore.Transaction, uid: string, notificationId: string) {
  const ref = getFirestore().doc(`users/${uid}/notifications/${notificationId}`), row = (await tx.get(ref)).data();
  if (!row || row.recipientUid !== uid || !await hasNotificationAccess(tx, row.orgId, uid, row.accessSources)) throw new HttpsError('permission-denied', 'Notification unavailable.');
  return { ref, row };
}
export const listNotifications = readCommand(data => { keys(data, ['pageSize', 'cursor']); const pageSize = data.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new HttpsError('invalid-argument', 'pageSize must be 1 through 50.');
  return { pageSize, cursor: data.cursor == null ? null : id(data.cursor, 'cursor') }; }, async (tx, data, uid) => {
  let query = getFirestore().collection(`users/${uid}/notifications`).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(data.pageSize + 1);
  if (data.cursor) { const cursor = await tx.get(getFirestore().doc(`users/${uid}/notifications/${data.cursor}`)); if (!cursor.exists) throw new HttpsError('invalid-argument', 'Invalid cursor.'); query = query.startAfter(cursor); }
  const rows = await tx.get(query), items: Data[] = [];
  const revoked: FirebaseFirestore.DocumentReference[] = [];
  for (const doc of rows.docs.slice(0, data.pageSize)) {
    const row = doc.data();
    if (!await hasNotificationAccess(tx, row.orgId, uid, row.accessSources)) { revoked.push(doc.ref); continue; }
    items.push({ id: doc.id, title: row.title, body: row.body, critical: row.critical, sourceType: row.sourceType, sourceId: row.sourceId,
      sourceRevision: row.sourceRevision, createdAt: row.createdAt, readAt: row.readAt, acknowledgedAt: row.acknowledgedAt, deliveryStatus: row.deliveryStatus });
  }
  revoked.forEach(ref => tx.delete(ref));
  return { items, unreadCount: items.filter(row => row.readAt == null).length, nextCursor: rows.size > data.pageSize ? rows.docs[data.pageSize - 1].id : null };
});
export const markNotificationRead = command('markNotificationRead', normalizeMutation, async (tx, data, uid, _actor, replay) => {
  const { ref, row } = await load(tx, uid, data.notificationId); if (row.sourceRevision !== data.sourceRevision) stale(); if (replay) return replay;
  const readAt = row.readAt ?? Timestamp.now(); tx.update(ref, { readAt, updatedAt: Timestamp.now() }); return { id: ref.id, readAt, acknowledgedAt: row.acknowledgedAt ?? null };
});
export const acknowledgeCriticalUpdate = command('acknowledgeCriticalUpdate', normalizeMutation, async (tx, data, uid, _actor, replay) => {
  const { ref, row } = await load(tx, uid, data.notificationId); if (row.sourceRevision !== data.sourceRevision) stale(); if (row.critical !== true) throw new HttpsError('failed-precondition', 'Only critical updates require acknowledgement.'); if (replay) return replay;
  const acknowledgedAt = row.acknowledgedAt ?? Timestamp.now(), readAt = row.readAt ?? acknowledgedAt;
  tx.update(ref, { readAt, acknowledgedAt, updatedAt: Timestamp.now() }); return { id: ref.id, readAt, acknowledgedAt };
});
