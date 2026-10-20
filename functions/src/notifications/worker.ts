import { randomUUID } from 'node:crypto';
import { FieldPath, FieldValue, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError } from 'firebase-functions/v2/https';
import { Data } from '../commandSupport';
import { fingerprint } from '../operations/requests';
import { accountAvailable } from '../accountAccess';
import { essentialEmailApiKey } from '../email/transport';
import { expoPushProvider, expoReceiptProvider, notificationEmailProvider, ProviderResult, ReceiptProvider } from './providers';
import { recheckExplicitRecipients } from './audience';
import { criticalUpdateRef, recordCriticalUpdate, recordDeliveryIssue } from './issues';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
export type AccessSource = { kind: 'staff'; programId: string } | { kind: 'team'; teamId: string } |
  { kind: 'household'; teamId: string; participantId: string };
export type ProviderOutcome = 'accepted' | 'retryable' | 'permanent';
export type NotificationProvider = { send(delivery: Data): Promise<ProviderOutcome | ProviderResult> };
type DeliveryOptions = { provider?: NotificationProvider; now?: number;
  authorize?: (tx: Transaction, orgId: string, uid: string, sources: AccessSource[]) => Promise<boolean> };
class AmbiguousProviderError extends Error {}

export function fakeNotificationProvider(outcome: ProviderOutcome | 'ambiguous'): NotificationProvider {
  return { async send() { if (outcome === 'ambiguous') throw new AmbiguousProviderError('Provider result unavailable.'); return { outcome }; } };
}

function safeCopy(intent: Data) {
  const labels: Record<string, string> = {
    'event:edit': 'Event updated', 'event:postpone': 'Event postponed', 'event:cancel': 'Event cancelled',
    'event:reschedule': 'Schedule changed', 'event:complete': 'Event completed', eventPostponed: 'Event postponed',
    facilityClosure: 'Facility closed', schedulePublished: 'Schedule published', rsvpReminder: 'RSVP reminder',
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
  if (intent.audience?.mode === 'explicit') {
    const recipients = new Map<string, AccessSource[]>();
    for (const recipient of await recheckExplicitRecipients(tx, intent)) recipients.set(recipient.uid, recipient.accessSources);
    return recipients;
  }
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
  const staff = await tx.get(db.collection(`organizations/${intent.orgId}/members`).where('status', '==', 'active').limit(101));
  if (staff.size > 100) throw new Error('NOTIFICATION_AUDIENCE_TOO_LARGE');
  for (const member of staff.docs) {
    const row = member.data();
    if (row.status !== 'active' || !Array.isArray(row.roles) || !Array.isArray(row.programIds)) continue;
    for (const programId of programs) if (row.roles.includes('orgAdmin') || row.roles.includes('programStaff') && row.programIds.includes(programId)) add(recipients, member.id, { kind: 'staff', programId });
  }
  const teamAudiences: { teamId: string; members: FirebaseFirestore.QueryDocumentSnapshot[]; roster: FirebaseFirestore.QueryDocumentSnapshot[] }[] = [];
  let memberCount = 0, rosterCount = 0;
  for (const teamId of teamIds) {
    const members = await tx.get(db.collection('teamMembers').where('teamId', '==', teamId).where('status', '==', 'active').limit(101));
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

export function notificationAccessSourceKeys(orgId: string, sources: AccessSource[]) {
  return [...new Set((sources ?? []).map(source => source.kind === 'staff' ? `${orgId}:staff:${source.programId}`
    : source.kind === 'team' ? `${orgId}:team:${source.teamId}` : `${orgId}:household:${source.teamId}:${source.participantId}`))];
}

export async function authorizeNotificationRows(tx: Transaction, uid: string, rows: { orgId: string; accessSources: AccessSource[] }[]) {
  const db = getFirestore();
  try { await accountAvailable(tx, uid); } catch (error) {
    if (error instanceof HttpsError && error.code === 'permission-denied') return rows.map(() => false);
    throw error;
  }
  const refs = new Map<string, FirebaseFirestore.DocumentReference>();
  const addRef = (path: string) => refs.set(path, db.doc(path));
  for (const { orgId, accessSources } of rows) {
    addRef(`organizations/${orgId}`);
    for (const source of accessSources ?? []) {
      if (source.kind === 'staff') {
        addRef(`organizations/${orgId}/programs/${source.programId}`); addRef(`organizations/${orgId}/members/${uid}`);
      } else if (source.kind === 'team') {
        addRef(`teams/${source.teamId}`); addRef(`teamMembers/${source.teamId}_${uid}`);
      } else {
        addRef(`teams/${source.teamId}`); addRef(`teams/${source.teamId}/roster/${source.participantId}`);
        addRef(`organizations/${orgId}/participants/${source.participantId}`);
        addRef(`organizations/${orgId}/participants/${source.participantId}/guardians/${uid}`);
      }
    }
  }
  const snapshots = refs.size ? await tx.getAll(...refs.values()) : [];
  const data = new Map(snapshots.map(snapshot => [snapshot.ref.path, snapshot.data()]));
  return rows.map(({ orgId, accessSources }) => {
    const organization = data.get(`organizations/${orgId}`);
    if (organization?.schemaVersion !== 2 || organization.status !== 'active') return false;
    for (const source of accessSources ?? []) {
      if (source.kind === 'household' && organization.features?.households !== true) continue;
      if (source.kind === 'staff') {
        const program = data.get(`organizations/${orgId}/programs/${source.programId}`), row = data.get(`organizations/${orgId}/members/${uid}`);
        if (program?.orgId === orgId && program.status === 'active'
          && row?.orgId === orgId && row.status === 'active' && Array.isArray(row.roles) && Array.isArray(row.programIds)
          && (row.roles.includes('orgAdmin') || row.roles.includes('programStaff') && row.programIds.includes(source.programId))) return true;
      } else if (source.kind === 'team') {
        const team = data.get(`teams/${source.teamId}`), row = data.get(`teamMembers/${source.teamId}_${uid}`);
        if (team?.orgId === orgId && team.status === 'active' && row?.orgId === orgId && row.teamId === source.teamId
          && row.status === 'active' && row.userId === uid && Array.isArray(row.roles) && row.roles.some((role: string) => ['coach', 'captain'].includes(role))) return true;
      } else {
        const team = data.get(`teams/${source.teamId}`), roster = data.get(`teams/${source.teamId}/roster/${source.participantId}`);
        const participant = data.get(`organizations/${orgId}/participants/${source.participantId}`);
        const guardian = data.get(`organizations/${orgId}/participants/${source.participantId}/guardians/${uid}`);
        if (team?.orgId === orgId && team.status === 'active' && roster?.orgId === orgId && roster.participantId === source.participantId
          && (roster.teamId == null || roster.teamId === source.teamId) && roster.status === 'active'
          && participant?.status === 'active' && (participant.orgId == null || participant.orgId === orgId)
          && (participant.linkedUserId === uid || guardian?.status === 'active' && guardian.orgId === orgId
            && guardian.participantId === source.participantId && guardian.userId === uid
            && guardian.permissions?.viewSchedule === true)) return true;
      }
    }
    return false;
  });
}

export async function hasNotificationAccess(tx: Transaction, orgId: string, uid: string, sources: AccessSource[]) {
  return (await authorizeNotificationRows(tx, uid, [{ orgId, accessSources: sources }]))[0];
}

export async function expandNotificationIntent(orgId: string, intentId: string) {
  const db = getFirestore(), ref = db.doc(`organizations/${orgId}/outbox/${intentId}`);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), intent = snapshot.data();
    if (!intent || intent.orgId !== orgId || intent.schemaVersion !== 2) return { state: 'missing' };
    const organization = (await tx.get(db.doc(`organizations/${orgId}`))).data();
    const features = organization?.features ?? {};
    if (organization?.schemaVersion !== 2 || organization.status !== 'active'
      || ![features.notificationInboxFake, features.notificationPush, features.notificationEmailFallback].some(value => value === true)) return { state: 'disabled' };
    if (intent.state === 'expanded') return { state: 'expanded' };
    if (intent.state !== 'pending') return { state: intent.state };
    const recipients = await resolveRecipients(tx, intent); const now = Timestamp.now(), copy = safeCopy(intent);
    const recipientIds = [...recipients.keys()];
    if ((features.notificationPush === true || features.notificationEmailFallback === true) && recipients.size > 100) {
      throw new Error('NOTIFICATION_DELIVERY_FANOUT_TOO_LARGE');
    }
    const profiles = features.notificationEmailFallback === true && recipientIds.length
      ? await tx.getAll(...recipientIds.map(uid => db.doc(`users/${uid}`))) : [];
    const endpointDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    if (features.notificationPush === true) for (let offset = 0; offset < recipientIds.length; offset += 30) {
      const page = await tx.get(db.collection('notificationEndpoints').where('userId', 'in', recipientIds.slice(offset, offset + 30)).where('permissionState', '==', 'granted').limit(201));
      endpointDocs.push(...page.docs);
      if (endpointDocs.length > 200) throw new Error('NOTIFICATION_DELIVERY_FANOUT_TOO_LARGE');
    }
    const endpoints = new Map<string, Data[]>();
    for (const endpoint of endpointDocs) {
      const row = endpoint.data(), rows = endpoints.get(row.userId) ?? [];
      if (rows.length >= 5) throw new Error('NOTIFICATION_DELIVERY_FANOUT_TOO_LARGE');
      if (row.revokedAt == null && typeof row.expoPushToken === 'string') rows.push({ id: endpoint.id, ...row });
      endpoints.set(row.userId, rows);
    }
    let plannedDeliveryCount = 0;
    for (const [index, [uid, accessSources]] of [...recipients.entries()].entries()) {
      const notificationId = fingerprint({ orgId, intentId, uid });
      const availableEndpoints = endpoints.get(uid) ?? [], email = profiles[index]?.data()?.email;
      const planned: Data[] = [];
      if (features.notificationInboxFake === true) planned.push({ channel: 'fake', deliveryId: fingerprint({ orgId, intentId, uid, channel: 'fake' }) });
      for (const endpoint of availableEndpoints) planned.push({ channel: 'push', endpointId: endpoint.id,
        projectId: endpoint.projectId, deliveryId: fingerprint({ orgId, intentId, uid, channel: 'push', installationId: endpoint.installationId }) });
      if (!availableEndpoints.length && features.notificationEmailFallback === true && typeof email === 'string') {
        planned.push({ channel: 'email', recipientEmail: email.toLowerCase(), deliveryId: fingerprint({ orgId, intentId, uid, channel: 'email' }) });
      }
      plannedDeliveryCount += planned.length;
      if (recipients.size + plannedDeliveryCount + (intent.critical === true ? index + 1 : 0) + 1 > 450) throw new Error('NOTIFICATION_DELIVERY_FANOUT_TOO_LARGE');
      tx.set(db.doc(`users/${uid}/notifications/${notificationId}`), { schemaVersion: 2, id: notificationId, orgId, intentId, recipientUid: uid,
        sourceType: intent.sourceType, sourceId: intent.sourceId, sourceRevision: intent.sourceRevision, templateKey: intent.templateKey,
        critical: intent.critical === true, ...copy, accessSources, deliveryIds: planned.map(row => row.deliveryId), deliveryStatus: planned.length ? 'queued' : 'inAppOnly', readAt: null, acknowledgedAt: null,
        programId: intent.programId ?? null, createdAt: intent.createdAt ?? now, updatedAt: now });
      if (intent.critical === true) recordCriticalUpdate(tx, orgId, notificationId, { recipientUid: uid, title: copy.title,
        sourceType: intent.sourceType, sourceId: intent.sourceId, sourceRevision: intent.sourceRevision, templateKey: intent.templateKey,
        programId: intent.programId ?? null, createdAt: intent.createdAt ?? now });
      for (const delivery of planned) tx.set(db.doc(`notificationDeliveries/${delivery.deliveryId}`), { schemaVersion: 2, id: delivery.deliveryId,
        orgId, intentId, notificationId, recipientUid: uid, ...copy, ...delivery, status: 'queued', attemptCount: 0, nextAttemptAt: now,
        accessSources, sourceRevision: intent.sourceRevision, sourceType: intent.sourceType, sourceId: intent.sourceId, templateKey: intent.templateKey,
        programId: intent.programId ?? null, emailFallbackEligible: features.notificationEmailFallback === true && typeof email === 'string',
        ...(typeof email === 'string' ? { recipientEmail: email.toLowerCase() } : {}), lease: null, leaseUntil: null,
        providerMessageId: null, failureCode: null, createdAt: now, updatedAt: now });
    }
    tx.update(ref, { state: 'expanded', recipientCount: recipients.size, expandedAt: now, updatedAt: now });
    return { state: 'expanded', recipientCount: recipients.size };
  });
}

export function permanentExpansionFailure(error: unknown) {
  return error instanceof Error && ['NOTIFICATION_AUDIENCE_TOO_LARGE', 'NOTIFICATION_AUDIENCE_UNSUPPORTED', 'NOTIFICATION_AUDIENCE_STALE', 'NOTIFICATION_DELIVERY_FANOUT_TOO_LARGE'].includes(error.message)
    ? error.message : null;
}

async function finish(deliveryId: string, lease: string, status: string, patch: Data = {}) {
  const db = getFirestore(), ref = db.doc(`notificationDeliveries/${deliveryId}`);
  await db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data(); if (!row || row.status !== 'sending' || row.lease !== lease) return;
    const notification = await tx.get(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
    tx.update(ref, { status, ...patch, lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
    if (status === 'permanentFailure' || status === 'unknownOutcome') recordDeliveryIssue(tx, { ...row, id: row.id ?? deliveryId }, status, patch.failureCode ?? null);
    if (notification.exists) {
      const current = notification.data()?.deliveryStatus;
      const success = ['providerAccepted', 'providerReceiptOk'].includes(current);
      tx.update(notification.ref, { [`deliveryStatuses.${row.channel ?? 'fake'}`]: status,
        deliveryStatus: success && !['providerAccepted', 'providerReceiptOk'].includes(status) ? current : status, updatedAt: Timestamp.now() });
    }
  });
}

function retryAt(deliveryId: string, attemptCount: number, now: number) {
  const parsed = parseInt(deliveryId.slice(0, 4), 16), jitter = Number.isFinite(parsed) ? parsed % 10_001 : 0;
  return Timestamp.fromMillis(now + Math.min(3_600_000, 30_000 * 2 ** attemptCount) + jitter);
}

function enabledFor(row: Data, features: Data) {
  return (row.channel == null || row.channel === 'fake') ? features.notificationInboxFake === true
    : row.channel === 'push' ? features.notificationPush === true
      : row.channel === 'email' ? features.notificationEmailFallback === true : false;
}

const pushTokenFingerprint = (token: string) => fingerprint({ expoPushToken: token });

async function finishPermanentWithCleanup(deliveryId: string, expectedStatus: 'sending' | 'providerAccepted',
  leaseField: 'lease' | 'receiptLease', lease: string, failureCode: string, tokenFingerprint?: string) {
  const db = getFirestore(), ref = db.doc(`notificationDeliveries/${deliveryId}`);
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), row = snapshot.data();
    if (!row || row.status !== expectedStatus || row[leaseField] !== lease) return false;
    const notificationRef = db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`);
    const fallbackEligible = row.channel === 'push' && row.emailFallbackEligible === true && typeof row.recipientEmail === 'string';
    const fallbackId = fallbackEligible ? fingerprint({ orgId: row.orgId, intentId: row.intentId, uid: row.recipientUid, channel: 'email' }) : null;
    const fallbackRef = fallbackId ? db.doc(`notificationDeliveries/${fallbackId}`) : null;
    const endpointRef = row.endpointId && tokenFingerprint ? db.doc(`notificationEndpoints/${row.endpointId}`) : null;
    const notification = await tx.get(notificationRef);
    const fallback = fallbackRef ? await tx.get(fallbackRef) : null;
    const endpoint = endpointRef ? await tx.get(endpointRef) : null;
    const now = Timestamp.now();
    tx.update(ref, { status: 'permanentFailure', failureCode, nextAttemptAt: null, nextReceiptAt: null,
      lease: null, leaseUntil: null, receiptLease: null, receiptLeaseUntil: null,
      ...(expectedStatus === 'providerAccepted' ? { receiptCheckedAt: now } : {}), updatedAt: now });
    recordDeliveryIssue(tx, { ...row, id: row.id ?? deliveryId }, 'permanentFailure', failureCode);
    if (fallbackRef && fallbackId && !fallback?.exists) tx.create(fallbackRef, { ...row, id: fallbackId, deliveryId: fallbackId,
      channel: 'email', status: 'queued', attemptCount: 0, nextAttemptAt: now, nextReceiptAt: null,
      endpointId: null, endpointToken: null, endpointTokenFingerprint: null, providerMessageId: null, failureCode: null,
      lease: null, leaseUntil: null, receiptLease: null, receiptLeaseUntil: null, createdAt: now, updatedAt: now });
    if (notification.exists) {
      const current = notification.data()?.deliveryStatus;
      const deliveryStatuses = notification.data()?.deliveryStatuses ?? {};
      const otherChannelSucceeded = Object.entries(deliveryStatuses).some(([channel, status]) => channel !== row.channel
        && ['providerAccepted', 'providerReceiptOk'].includes(status as string));
      tx.update(notificationRef, { [`deliveryStatuses.${row.channel ?? 'fake'}`]: 'permanentFailure',
        deliveryStatus: otherChannelSucceeded && typeof current === 'string' ? current : 'permanentFailure',
        ...(fallbackId ? { deliveryIds: FieldValue.arrayUnion(fallbackId) } : {}), updatedAt: now });
    }
    const endpointData = endpoint?.data();
    if (endpointRef && endpointData && endpointData.userId === row.recipientUid && typeof endpointData.expoPushToken === 'string'
      && pushTokenFingerprint(endpointData.expoPushToken) === tokenFingerprint) {
      tx.update(endpointRef, { permissionState: 'revoked', expoPushToken: null, revokedAt: now, updatedAt: now });
    }
    return true;
  });
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
      recordDeliveryIssue(tx, { ...row, id: row.id ?? deliveryId }, 'unknownOutcome', 'LEASE_EXPIRED');
      if (notification.exists) {
        const current = notification.data()?.deliveryStatus;
        tx.update(notification.ref, { [`deliveryStatuses.${row.channel ?? 'fake'}`]: 'unknownOutcome',
          deliveryStatus: ['providerAccepted', 'providerReceiptOk'].includes(current) ? current : 'unknownOutcome', updatedAt: Timestamp.now() });
      }
      return 'unknownOutcome';
    }
    if (!['queued', 'retryableFailure'].includes(row.status) || row.nextAttemptAt?.toMillis() > now || (row.attemptCount ?? 0) >= MAX_ATTEMPTS) return 'skipped';
    const organization = (await tx.get(db.doc(`organizations/${orgId}`))).data();
    if (organization?.schemaVersion !== 2 || organization.status !== 'active' || !enabledFor(row, organization.features ?? {})) {
      const notification = await tx.get(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
      tx.update(ref, { status: 'paused', failureCode: 'FEATURE_DISABLED', nextAttemptAt: null, lease: null, leaseUntil: null, updatedAt: Timestamp.now() });
      if (notification.exists) {
        const current = notification.data()?.deliveryStatus;
        tx.update(notification.ref, { [`deliveryStatuses.${row.channel ?? 'fake'}`]: 'paused',
          deliveryStatus: ['providerAccepted', 'providerReceiptOk'].includes(current) ? current : 'paused', updatedAt: Timestamp.now() });
      }
      return 'disabled';
    }
    tx.update(ref, { status: 'sending', lease, leaseUntil: Timestamp.fromMillis(now + LEASE_MS), attemptCount: (row.attemptCount ?? 0) + 1, updatedAt: Timestamp.now() });
    return 'claimed';
  });
  if (claim !== 'claimed') return claim;
  const row = (await ref.get()).data();
  if (!row) return 'skipped';
  let gate: { enabled: boolean; authorized: boolean; channelAvailable: boolean; endpointToken?: string };
  try {
    gate = await db.runTransaction(async tx => {
      const enabled = enabledFor(row, (await tx.get(db.doc(`organizations/${orgId}`))).data()?.features ?? {});
      let channelAvailable = true;
      let endpointToken: string | undefined;
      if (enabled && row.channel === 'push') {
        const endpoint = row.endpointId ? (await tx.get(db.doc(`notificationEndpoints/${row.endpointId}`))).data() : null;
        channelAvailable = !!endpoint && endpoint.userId === row.recipientUid && endpoint.permissionState === 'granted'
          && typeof endpoint.expoPushToken === 'string' && endpoint.revokedAt == null;
        if (channelAvailable) endpointToken = endpoint!.expoPushToken;
      } else if (enabled && row.channel === 'email') {
        channelAvailable = (await tx.get(db.doc(`users/${row.recipientUid}/communication/essential`))).data()?.suppressed !== true;
      }
      return { enabled, channelAvailable, endpointToken,
        authorized: enabled ? await (options.authorize ?? hasNotificationAccess)(tx, orgId, row.recipientUid, row.accessSources) : false };
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
      tx.delete(db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`));
      recordDeliveryIssue(tx, { ...row, id: row.id ?? deliveryId }, 'permanentFailure', 'ACCESS_REVOKED');
      if (typeof row.orgId === 'string' && typeof row.notificationId === 'string') tx.delete(criticalUpdateRef(row.orgId, row.notificationId)); });
    return 'revoked';
  }
  if (!gate.channelAvailable) {
    const applied = await finishPermanentWithCleanup(deliveryId, 'sending', 'lease', lease, 'CHANNEL_UNAVAILABLE');
    return applied ? 'permanentFailure' : 'skipped';
  }
  let result: ProviderResult;
  try {
    const provider = options.provider ?? (row.channel === 'push' ? process.env.PUSH_DELIVERY_ENABLED === 'true' ? expoPushProvider() : null
      : row.channel === 'email' ? notificationEmailProvider() : fakeNotificationProvider('accepted'));
    if (!provider) { await finish(deliveryId, lease, 'paused', { failureCode: 'PROVIDER_NOT_CONFIGURED', nextAttemptAt: null }); return 'disabled'; }
    const raw = await provider.send({ ...row, ...(gate.endpointToken ? { endpointToken: gate.endpointToken } : {}) });
    result = typeof raw === 'string' ? { outcome: raw } : raw;
  } catch {
    await finish(deliveryId, lease, 'unknownOutcome', { failureCode: 'AMBIGUOUS_PROVIDER_RESULT' });
    return 'unknownOutcome';
  }
  const endpointTokenFingerprint = gate.endpointToken ? pushTokenFingerprint(gate.endpointToken) : undefined;
  if (result.outcome === 'accepted') { await finish(deliveryId, lease, 'providerAccepted', { providerMessageId: result.messageId ?? `fake:${deliveryId}`,
    ...(endpointTokenFingerprint ? { endpointTokenFingerprint } : {}),
    nextReceiptAt: row.channel === 'push' ? Timestamp.fromMillis(now + 15 * 60_000) : null, failureCode: null }); return 'providerAccepted'; }
  if (result.outcome === 'permanent') {
    const applied = await finishPermanentWithCleanup(deliveryId, 'sending', 'lease', lease, result.errorCode ?? 'PROVIDER_REJECTED',
      result.errorCode === 'DeviceNotRegistered' ? endpointTokenFingerprint : undefined);
    return applied ? 'permanentFailure' : 'skipped';
  }
  if ((row.attemptCount ?? 0) >= MAX_ATTEMPTS) {
    const applied = await finishPermanentWithCleanup(deliveryId, 'sending', 'lease', lease, 'RETRY_LIMIT_REACHED');
    return applied ? 'permanentFailure' : 'skipped';
  }
  await finish(deliveryId, lease, 'retryableFailure', { failureCode: 'PROVIDER_RETRY', nextAttemptAt: result.retryAfterMs
    ? Timestamp.fromMillis(now + result.retryAfterMs) : retryAt(deliveryId, row.attemptCount ?? 1, now) });
  return 'retryableFailure';
}

export async function processPushReceipt(deliveryId: string, provider: ReceiptProvider = expoReceiptProvider(), now = Date.now()) {
  const db = getFirestore(), ref = db.doc(`notificationDeliveries/${deliveryId}`), receiptLease = randomUUID();
  const row = await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current || current.channel !== 'push' || current.status !== 'providerAccepted' || typeof current.providerMessageId !== 'string'
      || (current.nextReceiptAt?.toMillis() ?? 0) > now || (current.receiptLeaseUntil?.toMillis() ?? 0) > now) return null;
    tx.update(ref, { receiptLease, receiptLeaseUntil: Timestamp.fromMillis(now + LEASE_MS), updatedAt: Timestamp.now() });
    return current;
  });
  if (!row) return 'skipped';
  let result;
  try { result = await provider.get(row.providerMessageId); }
  catch { result = { outcome: 'retryable' as const, errorCode: 'RECEIPT_UNAVAILABLE' }; }
  if (result.outcome === 'ok') { const applied = await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data(); if (current?.status !== 'providerAccepted' || current.receiptLease !== receiptLease) return false;
    const notification = await tx.get(db.doc(`users/${current.recipientUid}/notifications/${current.notificationId}`));
    tx.update(ref, { status: 'providerReceiptOk', receiptCheckedAt: Timestamp.now(), nextReceiptAt: null, failureCode: null,
      receiptLease: null, receiptLeaseUntil: null, updatedAt: Timestamp.now() });
    if (notification.exists) tx.update(notification.ref, { 'deliveryStatuses.push': 'providerReceiptOk', deliveryStatus: 'providerReceiptOk', updatedAt: Timestamp.now() });
    return true;
  }); return applied ? 'providerReceiptOk' : 'skipped'; }
  if (result.outcome === 'permanent') {
    const applied = await finishPermanentWithCleanup(deliveryId, 'providerAccepted', 'receiptLease', receiptLease,
      result.errorCode ?? 'PUSH_RECEIPT_REJECTED', result.errorCode === 'DeviceNotRegistered' ? row.endpointTokenFingerprint : undefined);
    return applied ? 'permanentFailure' : 'skipped';
  }
  const attempts = (row.receiptAttempts ?? 0) + 1;
  const applied = await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.status !== 'providerAccepted' || current.receiptLease !== receiptLease) return false;
    tx.update(ref, attempts >= 5 ? { status: 'unknownOutcome', receiptAttempts: attempts, nextReceiptAt: null,
      failureCode: 'RECEIPT_RETRY_LIMIT', receiptLease: null, receiptLeaseUntil: null, updatedAt: Timestamp.now() }
      : { receiptAttempts: attempts, nextReceiptAt: Timestamp.fromMillis(now + Math.min(3_600_000, 60_000 * 2 ** attempts)),
        failureCode: result.errorCode ?? 'RECEIPT_RETRY', receiptLease: null, receiptLeaseUntil: null, updatedAt: Timestamp.now() });
    if (attempts >= 5) recordDeliveryIssue(tx, { ...current, id: current.id ?? deliveryId }, 'unknownOutcome', 'RECEIPT_RETRY_LIMIT');
    return true;
  });
  return !applied ? 'skipped' : attempts >= 5 ? 'unknownOutcome' : 'retryableFailure';
}

/** Fake-adapter worker stays inert until an organization explicitly enables the development-only server flag. */
export const resumeNotificationInbox = onSchedule({ schedule: 'every 1 minutes',
  secrets: process.env.GCLOUD_PROJECT === 'team-hangout-staging' ? [] : [essentialEmailApiKey] }, async () => {
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
    for (const delivery of deliveries.docs) try { await processNotificationDelivery(delivery.data().orgId, delivery.id); } catch {}
  }
  const expired = await db.collection('notificationDeliveries').where('status', '==', 'sending').where('leaseUntil', '<=', Timestamp.now()).orderBy('leaseUntil').limit(25).get();
  for (const delivery of expired.docs) try { await processNotificationDelivery(delivery.data().orgId, delivery.id); } catch {}
  if (process.env.PUSH_DELIVERY_ENABLED === 'true') {
    const receipts = await db.collection('notificationDeliveries').where('status', '==', 'providerAccepted').where('nextReceiptAt', '<=', Timestamp.now())
      .orderBy('nextReceiptAt').limit(25).get();
    for (const delivery of receipts.docs) try { await processPushReceipt(delivery.id); } catch {}
  }
});
