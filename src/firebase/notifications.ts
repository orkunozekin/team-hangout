import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { runCommand } from './commands';
import { db, functions } from './config';
export type NotificationRow = { id: string; title: string; body: string; critical: boolean; sourceType: string; sourceId: string; sourceRevision: number;
  createdAt: string; readAt: string | null; acknowledgedAt: string | null; deliveryStatus: string };
export async function listNotifications(cursor?: string): Promise<{ items: NotificationRow[]; unreadCount: number; nextCursor: string | null }> {
  return (await httpsCallable<{ pageSize: number; cursor?: string }, { items: NotificationRow[]; unreadCount: number; nextCursor: string | null }>(functions, 'listNotifications')({ pageSize: 50, ...(cursor ? { cursor } : {}) })).data;
}
const requestId = () => doc(collection(db, 'requestIds')).id;
export async function markNotificationRead(notificationId: string, sourceRevision: number) {
  return runCommand('markNotificationRead', { notificationId, sourceRevision }, requestId());
}
export async function acknowledgeCriticalUpdate(notificationId: string, sourceRevision: number) {
  return runCommand('acknowledgeCriticalUpdate', { notificationId, sourceRevision }, requestId());
}
