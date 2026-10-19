import { randomUUID } from 'node:crypto';
import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError } from 'firebase-functions/v2/https';
import { Data } from '../commandSupport';
import { fingerprint } from '../operations/requests';
import { accountAvailable } from '../accountAccess';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
type AccessSource = { kind: 'staff'; programId: string } | { kind: 'team'; teamId: string } |
  { kind: 'household'; teamId: string; participantId: string };
export type ProviderOutcome = 'accepted' | 'retryable' | 'permanent';
export type NotificationProvider = { send(delivery: Data): Promise<ProviderOutcome> };
type DeliveryOptions = { provider?: NotificationProvider; now?: number;
  authorize?: (tx: Transaction, orgId: string, uid: string, sources: AccessSource[]) => Promise<boolean> };
class AmbiguousProviderError extends Error {}

export function fakeNotificationProvider(outcome: ProviderOutcome | 'ambiguous'): NotificationProvider {
  return { async send() { if (outcome === 'ambiguous') throw new AmbiguousProviderError('Provider result unavailable.'); return outcome; } };
}

function safeCopy(intent: Data) {
  const labels: Record<string, string> = {
    'event:edit': 'Event updated', 'event:postpone': 'Event postponed', 'event:cancel': 'Event cancelled',
    'event:reschedule': 'Schedule changed', 'event:complete': 'Event completed', eventPostponed: 'Event postponed',
    facilityClosure: 'Facility closed', schedulePublished: 'Schedule published',
  };
  return { title: labels[intent.templateKey] ?? 'Team update', body: 'Open Team Hangout for current details.' };
}
function add(map: Map<string, AccessSource[]>, uid: unknown, source: AccessSource) {
  if (typeof uid !== 'string' || !uid) return;
  const rows = map.get(uid) ?? [];
  if (rows.length >= 50) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
  if (!rows.some(row => JSON.stringify(row) === JSON.stringify(source))) rows.push(source);
  map.set(uid, rows);
}

async function resolveRecipients(tx: Transaction, intent: Data) {
  const db = getFirestore(); const recipients = new Map<string, AccessSource[]>();
  let teamIds = intent.audience?.teamIds ?? intent.audienceScope?.teamIds ?? [];
  if ((!Array.isArray(teamIds) || !teamIds.length) && intent.sourceType === 'closure' && intent.operationId) {
    const operation = (await tx.get(db.doc(`organizations/${intent.orgId}/scheduleOperations/${intent.operationId}`))).data();
    teamIds = [...new Set((operation?.expected ?? []).flatMap((row: Data) => row.teamIds ?? []))];
  }
  if ((!Array.isArray(teamIds) || !teamIds.length) && intent.audienceScope?.divisionId) {
    const rows = await tx.get(db.collection('teams').where('orgId', '==', intent.orgId).where('divisionId', '==', intent.audienceScope.divisionId).limit(21));
    if (rows.size > 20) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
    teamIds = rows.docs.filter(row => row.data().status === 'active').map(row => row.id);
  }
  teamIds = [...new Set(Array.isArray(teamIds) ? teamIds : [])].sort();
  if (!teamIds.length || teamIds.length > 20) throw new Error('NOTIFICATION_AUDIENCE_UNSUPPORTED');
  const teams = await tx.getAll(...teamIds.map((teamId: string) => db.doc(`teams/${teamId}`)));
  if (teams.some(team => { const row = team.data() as Data | undefined; return !row || row.orgId !== intent.orgId || row.status !== 'active'
    || typeof row.programId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.programId); })) throw new Error('NOTIFICATION_AUDIENCE_STALE');
  const programs = new Set(teams.map(team => (team.data() as Data).programId as string));
  const staff = await tx.get(db.collection(`organizations/${intent.orgId}/members`).limit(101));
  if (staff.size > 100) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
  for (const member of staff.docs) {
    const row = member.data();
    if (row.status !== 'active' || !Array.isArray(row.roles) || !Array.isArray(row.programIds)) continue;
    for (const programId of programs) if (row.roles.includes('orgAdmin') || row.roles.includes('programStaff') && row.programIds.includes(programId)) add(recipients, member.id, { kind: 'staff', programId });
  }
  const teamAudiences: { teamId: string; members: FirebaseFirestore.QueryDocumentSnapshot[]; roster: FirebaseFirestore.QueryDocumentSnapshot[] }[] = [];
  let memberCount = 0, rosterCount = 0;
  for (const teamId of teamIds) {
    const members = await tx.get(db.collection('teamMembers').where('teamId', '==', teamId).limit(101));
    const roster = await tx.get(db.collection(`teams/${teamId}/roster`).where('status', '==', 'active').limit(51));
    memberCount += members.size; rosterCount += roster.size;
    if (memberCount > 100 || rosterCount > 50) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
    teamAudiences.push({ teamId, members: members.docs, roster: roster.docs });
  }
  for (const { teamId, members, roster } of teamAudiences) {
    for (const member of members) {
      const row = member.data();
      if (row.orgId === intent.orgId && row.status === 'active' && Array.isArray(row.roles) && row.roles.some((role: string) => ['coach', 'captain'].includes(role))) add(recipients, row.userId, { kind: 'team', teamId });
    }
    for (const enrollment of roster) {
      const enrollmentData = enrollment.data();
      if (enrollmentData.orgId !== intent.orgId || enrollmentData.participantId !== enrollment.id
        || (enrollmentData.teamId != null && enrollmentData.teamId !== teamId)) throw new Error('NOTIFICATION_AUDIENCE_STALE');
      const participant = (await tx.get(db.doc(`organizations/${intent.orgId}/participants/${enrollment.id}`))).data();
      if (!participant || participant.status !== 'active' || (participant.orgId != null && participant.orgId !== intent.orgId)) continue;
      const source: AccessSource = { kind: 'household', teamId, participantId: enrollment.id };
      add(recipients, participant.linkedUserId, source);
      const guardians = await tx.get(db.collection(`organizations/${intent.orgId}/participants/${enrollment.id}/guardians`).where('status', '==', 'active').limit(11));
      if (guardians.size > 10) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
      for (const guardian of guardians.docs) {
        const grant = guardian.data();
        if (grant.orgId !== intent.orgId || grant.participantId !== enrollment.id || grant.userId !== guardian.id) throw new Error('NOTIFICATION_AUDIENCE_STALE');
        if (grant.permissions?.viewSchedule === true) add(recipients, guardian.id, source);
      }
    }
  }
  if (recipients.size > 200) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
  return recipients;
}

export async function hasNotificationAccess(tx: Transaction, orgId: string, uid: string, sources: AccessSource[]) {
  const db = getFirestore();
  try { await accountAvailable(tx, uid); } catch (error) {
    if (error instanceof HttpsError && error.code === 'permission-denied') return false;
    throw error;
  }
  const organization = (await tx.get(db.doc(`organizations/${orgId}`))).data();
  if (organization?.schemaVersion !== 2 || organization.status !== 'active') return false;
  for (const source of sources ?? []) {
    if (source.kind === 'household' && organization.features?.households !== true) continue;
    if (source.kind === 'staff') {
      const [program, member] = await tx.getAll(db.doc(`organizations/${orgId}/programs/${source.programId}`), db.doc(`organizations/${orgId}/members/${uid}`));
      const row = member.data();
      if (program.data()?.orgId === orgId && program.data()?.status === 'active'
        && row?.orgId === orgId && row.status === 'active' && Array.isArray(row.roles) && Array.isArray(row.programIds)
        && (row.roles.includes('orgAdmin') || row.roles.includes('programStaff') && row.programIds.includes(source.programId))) return true;
    } else if (source.kind === 'team') {
      const [team, member] = await tx.getAll(db.doc(`teams/${source.teamId}`), db.doc(`teamMembers/${source.teamId}_${uid}`));
      const row = member.data();
      if (team.data()?.orgId === orgId && team.data()?.status === 'active' && row?.orgId === orgId && row.teamId === source.teamId
        && row.status === 'active' && row.userId === uid && Array.isArray(row.roles) && row.roles.some((role: string) => ['coach', 'captain'].includes(role))) return true;
    } else {
      const [team, roster, participant, guardian] = await tx.getAll(db.doc(`teams/${source.teamId}`), db.doc(`teams/${source.teamId}/roster/${source.participantId}`),
        db.doc(`organizations/${orgId}/participants/${source.participantId}`), db.doc(`organizations/${orgId}/participants/${source.participantId}/guardians/${uid}`));
      if (team.data()?.orgId === orgId && team.data()?.status === 'active' && roster.data()?.orgId === orgId && roster.data()?.participantId === source.participantId
        && (roster.data()?.teamId == null || roster.data()?.teamId === source.teamId) && roster.data()?.status === 'active'
        && participant.data()?.status === 'active' && (participant.data()?.orgId == null || participant.data()?.orgId === orgId)
        && (participant.data()?.linkedUserId === uid || guardian.data()?.status === 'active' && guardian.data()?.orgId === orgId
          && guardian.data()?.participantId === source.participantId && guardian.data()?.userId === uid
          && guardian.data()?.permissions?.viewSchedule === true)) return true;
    }
  }
  return false;
}

export async function expandNotificationIntent(orgId: string, intentId: string) {
  const db = getFirestore(), ref = db.doc(`organizations/${orgId}/outbox/${intentId}`);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), intent = snapshot.data();
    if (!intent || intent.orgId !== orgId || intent.schemaVersion !== 2) return { state: 'missing' };
    const organization = (await tx.get(db.doc(`organizations/${orgId}`))).data();
    if (organization?.schemaVersion !== 2 || organization.status !== 'active' || organization.features?.notificationInboxFake !== true) return { state: 'disabled' };
    if (intent.state === 'expanded') return { state: 'expanded' };
    if (intent.state !== 'pending') return { state: intent.state };
    const recipients = await resolveRecipients(tx, intent); const now = Timestamp.now(), copy = safeCopy(intent);
    for (const [uid, accessSources] of recipients) {
      const notificationId = fingerprint({ orgId, intentId, uid });
      const deliveryId = fingerprint({ orgId, intentId, uid, channel: 'fake' });
      tx.set(db.doc(`users/${uid}/notifications/${notificationId}`), { schemaVersion: 2, id: notificationId, orgId, intentId, recipientUid: uid,
        sourceType: intent.sourceType, sourceId: intent.sourceId, sourceRevision: intent.sourceRevision, templateKey: intent.templateKey,
        critical: intent.critical === true, ...copy, accessSources, deliveryId, deliveryStatus: 'queued', readAt: null, acknowledgedAt: null,
        createdAt: intent.createdAt ?? now, updatedAt: now });
      tx.set(db.doc(`notificationDeliveries/${deliveryId}`), { schemaVersion: 2, id: deliveryId, orgId, intentId, notificationId, recipientUid: uid,
        channel: 'fake', status: 'queued', attemptCount: 0, nextAttemptAt: now, accessSources, sourceRevision: intent.sourceRevision,
        lease: null, leaseUntil: null, providerMessageId: null, failureCode: null, createdAt: now, updatedAt: now });
    }
    tx.update(ref, { state: 'expanded', recipientCount: recipients.size, expandedAt: now, updatedAt: now });
    return { state: 'expanded', recipientCount: recipients.size };
  });
}

export function permanentExpansionFailure(error: unknown) {
  return error instanceof Error && ['NOTIFICATION_AUDIENCE_TOO_LARGE', 'NOTIFICATION_AUDIENCE_UNSUPPORTED', 'NOTIFICATION_AUDIENCE_STALE'].includes(error.message)
    ? error.message : null;
}

async function finish(deliveryId: string, lease: string, status: string, patch: Data = {}) {
  const db = getFirestore(), ref = db.doc(`notificationDeliveries/${deliveryId}`);
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data(); if (!row || row.status !== 'sending' || row.lease !== lease) return;
    const notification = await tx.get(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
    tx.update(ref, { status, ...patch, lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
    if (notification.exists) tx.update(notification.ref, { deliveryStatus: status, updatedAt: Timestamp.now() });
  });
}

function retryAt(deliveryId: string, attemptCount: number, now: number) {
  const parsed = parseInt(deliveryId.slice(0, 4), 16), jitter = Number.isFinite(parsed) ? parsed % 10_001 : 0;
  return Timestamp.fromMillis(now + Math.min(3_600_000, 30_000 * 2 ** attemptCount) + jitter);
}

async function releaseUnsent(deliveryId: string, lease: string, now: number) {
  const ref = getFirestore().doc(`notificationDeliveries/${deliveryId}`);
  await getFirestore().runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || row.status !== 'sending' || row.lease !== lease) return;
    const attemptCount = Math.max(0, (row.attemptCount ?? 1) - 1);
    tx.update(ref, { status: 'retryableFailure', attemptCount, failureCode: 'ACCESS_CHECK_RETRY', nextAttemptAt: retryAt(deliveryId, attemptCount + 1, now),
      lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
  });
}

export async function processNotificationDelivery(orgId: string, deliveryId: string, options: DeliveryOptions = {}) {
  const db = getFirestore(), ref = db.doc(`notificationDeliveries/${deliveryId}`), lease = randomUUID(), now = options.now ?? Date.now();
  const claim = await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || row.orgId !== orgId) return 'skipped';
    if (row.status === 'sending' && row.leaseUntil?.toMillis() <= now) {
      const notification = await tx.get(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
      tx.update(ref, { status: 'unknownOutcome', failureCode: 'LEASE_EXPIRED', lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
      if (notification.exists) tx.update(notification.ref, { deliveryStatus: 'unknownOutcome', updatedAt: Timestamp.now() });
      return 'unknownOutcome';
    }
    if (!['queued', 'retryableFailure'].includes(row.status) || row.nextAttemptAt?.toMillis() > now || (row.attemptCount ?? 0) >= MAX_ATTEMPTS) return 'skipped';
    const organization = (await tx.get(db.doc(`organizations/${orgId}`))).data();
    if (organization?.schemaVersion !== 2 || organization.status !== 'active' || organization.features?.notificationInboxFake !== true) {
      const notification = await tx.get(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
      tx.update(ref, { status: 'paused', failureCode: 'FEATURE_DISABLED', nextAttemptAt: null, lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
      if (notification.exists) tx.update(notification.ref, { deliveryStatus: 'paused', updatedAt: Timestamp.now() });
      return 'disabled';
    }
    tx.update(ref, { status: 'sending', lease, leaseUntil: Timestamp.fromMillis(now + LEASE_MS), attemptCount: (row.attemptCount ?? 0) + 1, updatedAt: Timestamp.now() });
    return 'claimed';
  });
  if (claim !== 'claimed') return claim;
  const row = (await ref.get()).data();
  if (!row) return 'skipped';
  let gate: { enabled: boolean; authorized: boolean };
  try {
    gate = await db.runTransaction(async tx => {
      const enabled = (await tx.get(db.doc(`organizations/${orgId}`))).data()?.features?.notificationInboxFake === true;
      return { enabled, authorized: enabled ? await (options.authorize ?? hasNotificationAccess)(tx, orgId, row.recipientUid, row.accessSources) : false };
    });
  } catch {
    await releaseUnsent(deliveryId, lease, now);
    return 'retryableFailure';
  }
  if (!gate.enabled) { await finish(deliveryId, lease, 'paused', { failureCode: 'FEATURE_DISABLED', nextAttemptAt: null }); return 'disabled'; }
  const authorized = gate.authorized;
  if (!authorized) {
    await db.runTransaction(async tx => { const current = (await tx.get(ref)).data(); if (current?.status !== 'sending' || current.lease !== lease) return;
      tx.update(ref, { status: 'permanentFailure', failureCode: 'ACCESS_REVOKED', lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
      tx.delete(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`)); });
    return 'revoked';
  }
  try {
    const outcome = await (options.provider ?? fakeNotificationProvider('accepted')).send(row);
    if (outcome === 'accepted') { await finish(deliveryId, lease, 'providerAccepted', { providerMessageId: `fake:${deliveryId}`, failureCode: null }); return 'providerAccepted'; }
    if (outcome === 'permanent') { await finish(deliveryId, lease, 'permanentFailure', { failureCode: 'PROVIDER_REJECTED' }); return 'permanentFailure'; }
    if ((row.attemptCount ?? 0) >= MAX_ATTEMPTS) {
      await finish(deliveryId, lease, 'permanentFailure', { failureCode: 'RETRY_LIMIT_REACHED' });
      return 'permanentFailure';
    }
    await finish(deliveryId, lease, 'retryableFailure', { failureCode: 'PROVIDER_RETRY', nextAttemptAt: retryAt(deliveryId, row.attemptCount ?? 1, now) });
    return 'retryableFailure';
  } catch {
    await finish(deliveryId, lease, 'unknownOutcome', { failureCode: 'AMBIGUOUS_PROVIDER_RESULT' });
    return 'unknownOutcome';
  }
}

/** Fake-adapter worker stays inert until an organization explicitly enables the development-only server flag. */
export const resumeNotificationInbox = onSchedule('every 1 minutes', async () => {
  const db = getFirestore();
  const scan = db.doc('notificationWorkerScans/intents'), cursor = (await scan.get()).data()?.cursor;
  let query = db.collectionGroup('outbox').where('state', '==', 'pending').orderBy(FieldPath.documentId()).limit(25);
  if (cursor) query = query.startAfter(cursor);
  const intents = await query.get();
  for (const intent of intents.docs) {
    const parts = intent.ref.path.split('/');
    if (intent.data().state !== 'pending' || parts.length !== 4 || parts[0] !== 'organizations' || parts[2] !== 'outbox') continue;
    try { await expandNotificationIntent(parts[1], intent.id); }
    catch (error) {
      const code = permanentExpansionFailure(error);
      if (code) await intent.ref.update({ state: 'failed', failureCode: code, updatedAt: Timestamp.now() });
      else console.error('Notification intent expansion failed transiently.', { orgId: parts[1], intentId: intent.id });
    }
  }
  await scan.set({ cursor: intents.size === 25 ? intents.docs[24].ref.path : null, updatedAt: Timestamp.now() });
  for (const status of ['queued', 'retryableFailure']) {
    const deliveries = await db.collection('notificationDeliveries').where('status', '==', status).where('nextAttemptAt', '<=', Timestamp.now()).orderBy('nextAttemptAt').limit(25).get();
    for (const delivery of deliveries.docs) try { await processNotificationDelivery(delivery.data().orgId, delivery.id, { provider: fakeNotificationProvider('accepted') }); } catch {}
  }
  const expired = await db.collection('notificationDeliveries').where('status', '==', 'sending').where('leaseUntil', '<=', Timestamp.now()).orderBy('leaseUntil').limit(25).get();
  for (const delivery of expired.docs) try { await processNotificationDelivery(delivery.data().orgId, delivery.id, { provider: fakeNotificationProvider('accepted') }); } catch {}
});
