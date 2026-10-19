import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { authorizeNotificationRows, hasNotificationAccess, notificationAccessSourceKeys } from './worker';

const MAX_PAGE_ACCESS_SOURCES = 100;

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
  const pageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [], sourceKeys = new Set<string>();
  for (const doc of rows.docs.slice(0, data.pageSize)) {
    const keysForRow = notificationAccessSourceKeys(doc.data().orgId, doc.data().accessSources);
    const added = keysForRow.filter(key => !sourceKeys.has(key));
    if (pageDocs.length && sourceKeys.size + added.length > MAX_PAGE_ACCESS_SOURCES) break;
    if (sourceKeys.size + added.length > MAX_PAGE_ACCESS_SOURCES) throw new HttpsError('resource-exhausted', 'This notification has too many access sources.');
    added.forEach(key => sourceKeys.add(key)); pageDocs.push(doc);
  }
  const access = await authorizeNotificationRows(tx, uid, pageDocs.map(doc => ({ orgId: doc.data().orgId, accessSources: doc.data().accessSources })));
  const revoked: FirebaseFirestore.DocumentReference[] = [];
  const boundary = rows.size > pageDocs.length ? pageDocs[pageDocs.length - 1] : null;
  for (const [index, doc] of pageDocs.entries()) {
    const row = doc.data();
    if (!access[index]) { if (doc.id !== boundary?.id) revoked.push(doc.ref); continue; }
    items.push({ id: doc.id, title: row.title, body: row.body, critical: row.critical, sourceType: row.sourceType, sourceId: row.sourceId,
      sourceRevision: row.sourceRevision, createdAt: row.createdAt, readAt: row.readAt, acknowledgedAt: row.acknowledgedAt, deliveryStatus: row.deliveryStatus });
  }
  revoked.forEach(ref => tx.delete(ref));
  return { items, unreadCount: items.filter(row => row.readAt == null).length, nextCursor: boundary?.id ?? null };
});

export const registerPushDevice = command('registerPushDevice', data => {
  keys(data, ['requestId', 'installationId', 'platform', 'projectId', 'permissionState', 'expoPushToken']);
  const platform = data.platform;
  if (!['ios', 'android'].includes(platform)) invalid('Invalid platform.');
  const permissionState = data.permissionState;
  if (!['granted', 'denied', 'undetermined'].includes(permissionState)) invalid('Invalid permissionState.');
  const token = data.expoPushToken;
  if (permissionState === 'granted') {
    if (typeof token !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) invalid('Invalid expoPushToken.');
  } else if (token != null) invalid('A denied or undetermined endpoint cannot include a token.');
  return { installationId: id(data.installationId, 'installationId'), platform, projectId: id(data.projectId, 'projectId'), permissionState, expoPushToken: token ?? null };
}, async (tx, payload, uid, _actor, replay) => {
  if (replay) return replay;
  const db = getFirestore(), ref = db.doc(`notificationEndpoints/${uid}_${payload.installationId}`), before = (await tx.get(ref)).data();
  const duplicates = payload.expoPushToken ? await tx.get(db.collection('notificationEndpoints').where('expoPushToken', '==', payload.expoPushToken).limit(6)) : null;
  if (duplicates && duplicates.size > 5) throw new HttpsError('resource-exhausted', 'This device token requires support review.');
  const now = Timestamp.now();
  for (const duplicate of duplicates?.docs ?? []) if (duplicate.id !== ref.id) tx.update(duplicate.ref, {
    permissionState: 'revoked', expoPushToken: null, revokedAt: now, updatedAt: now,
  });
  tx.set(ref, { schemaVersion: 2, userId: uid, installationId: payload.installationId, platform: payload.platform,
    projectId: payload.projectId, permissionState: payload.permissionState, expoPushToken: payload.expoPushToken,
    tokenUpdatedAt: payload.expoPushToken !== before?.expoPushToken ? now : before?.tokenUpdatedAt ?? now,
    revokedAt: payload.permissionState === 'granted' ? null : before?.revokedAt ?? null,
    createdAt: before?.createdAt ?? now, updatedAt: now });
  return { installationId: payload.installationId, permissionState: payload.permissionState };
});

export const revokePushDevice = command('revokePushDevice', data => {
  keys(data, ['requestId', 'installationId']); return { installationId: id(data.installationId, 'installationId') };
}, async (tx, payload, uid, _actor, replay) => {
  if (replay) return replay;
  const ref = getFirestore().doc(`notificationEndpoints/${uid}_${payload.installationId}`), row = (await tx.get(ref)).data();
  if (row?.userId === uid && row.installationId === payload.installationId) tx.update(ref, { permissionState: 'revoked', expoPushToken: null, revokedAt: Timestamp.now(), updatedAt: Timestamp.now() });
  return { installationId: payload.installationId, revoked: true };
});

export const resolveNotificationTarget = readCommand(data => {
  keys(data, ['notificationId', 'sourceRevision']);
  if (!Number.isSafeInteger(data.sourceRevision) || data.sourceRevision < 1) invalid('Invalid sourceRevision.');
  return { notificationId: id(data.notificationId, 'notificationId'), sourceRevision: data.sourceRevision };
}, async (tx, payload, uid) => {
  try {
    const { row } = await load(tx, uid, payload.notificationId);
    if (row.sourceRevision !== payload.sourceRevision || row.sourceType !== 'event' || typeof row.sourceId !== 'string') return { available: false, target: null };
    const teamId = (row.accessSources ?? []).map((source: Data) => source.teamId).find((value: unknown) => typeof value === 'string');
    return { available: true, target: { type: 'event', id: id(row.sourceId, 'sourceId'), teamId: teamId ? id(teamId, 'teamId') : null } };
  } catch (error) {
    if (error instanceof HttpsError && error.code === 'permission-denied') return { available: false, target: null };
    throw error;
  }
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
