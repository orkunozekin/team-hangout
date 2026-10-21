import { createHash } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, getFirestore, Query, Timestamp, Transaction } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Data } from '../commandSupport';
import { canonicalObjectPath, configuredAttachmentBucket, storageReadFailure, uploadObjectPath } from '../communications/attachmentScan';

const PAGE_SIZE = 25;
// Future token/feed/invitation writers must use these ownership fields and the tombstone gate.
export const cleanupHooks = [
  ['importJobs', 'ownerUid'], ['calendarSubscriptions', 'ownerUid'], ['invitations', 'recipientUid'],
  ['emailOutbox', 'recipientUid'], ['notificationEndpoints', 'userId'], ['notificationDeliveries', 'recipientUid'],
  ['deliveryIssues', 'recipientUid'], ['criticalUpdates', 'recipientUid'], ['commandRequests', 'uid'],
] as const;
const projections = ['organizationLinks', 'participantLinks', 'teamAccess', 'agenda', 'notifications', 'notificationEndpoints', 'deviceTokens'];
const legacyStages = ['teamMembers', 'members', 'guardians', 'participants', ...cleanupHooks.map(([name]) => name), ...projections.map(name => `user:${name}`), 'attachmentAudit', 'auth'];
const stages = [
  'teamMembers', 'members', 'guardians', 'participants', ...cleanupHooks.map(([name]) => name),
  ...projections.map(name => `user:${name}`), 'messages', 'staffNotes', 'messageEdits',
  'messageModerators', 'reactions', 'attachmentSlots', 'attachments', 'auth',
];
const deletedIdentity = { kind: 'deleted', label: 'Deleted user' } as const;
const communicationCountFields = {
  messages: 'messagesTombstoned',
  staffNotes: 'staffNotesTombstoned',
  messageEdits: 'editActorsTombstoned',
  messageModerators: 'moderationActorsTombstoned',
  reactions: 'reactionsRemoved',
} as const;
const jobRef = (uid: string) => getFirestore().doc(`accountDeletionJobs/${uid}`);
const deletionAuditId = (uid: string) => `account-deletion-${createHash('sha256').update(uid).digest('hex').slice(0, 24)}`;

/** Server-only entry. Starting a job is atomic with loss of all app authority. */
export async function beginDeletion(uid: string) {
  const db = getFirestore();
  return db.runTransaction(async tx => {
    const job = await tx.get(jobRef(uid));
    if (job.exists) return job.data()!;
    const now = Timestamp.now();
    const data = { schemaVersion: 3, status: 'pending', stage: 0, cursor: null, pages: 0,
      membershipsRemoved: 0, recordsRemoved: 0, attempts: 0, createdAt: now, updatedAt: now, lastError: null };
    tx.create(job.ref, data);
    tx.set(db.doc(`users/${uid}`), { accountState: 'deleting', updatedAt: now }, { merge: true });
    return data;
  });
}

function queryFor(stage: string, uid: string): Query {
  const db = getFirestore();
  if (stage === 'members') return db.collectionGroup('members'); // Older canonical grants lack userId.
  if (stage === 'guardians') return db.collectionGroup('guardians').where('userId', '==', uid);
  if (stage === 'participants') return db.collectionGroup('participants').where('linkedUserId', '==', uid);
  if (stage.startsWith('user:')) return db.collection(`users/${uid}/${stage.slice(5)}`);
  if (stage === 'messages') return db.collectionGroup('messages').where('authorUid', '==', uid);
  if (stage === 'staffNotes') return db.collectionGroup('entries').where('authorUid', '==', uid);
  if (stage === 'messageEdits') return db.collectionGroup('edits').where('actorUid', '==', uid);
  if (stage === 'messageModerators') return db.collectionGroup('messages').where('moderatedBy', '==', uid);
  if (stage === 'reactions') return db.collectionGroup('reactions').where('actorUid', '==', uid);
  if (stage === 'attachmentSlots') return db.collectionGroup('attachmentSlots').where('ownerUid', '==', uid);
  if (stage === 'attachments') return db.collectionGroup('attachments').where('ownerUid', '==', uid);
  if (stage === 'teamMembers') return db.collection(stage).where('userId', '==', uid);
  const hook = cleanupHooks.find(([name]) => name === stage)!;
  const grouped = stage === 'invitations' || stage === 'deliveryIssues' || stage === 'criticalUpdates';
  return (grouped ? db.collectionGroup(stage) : db.collection(hook[0])).where(hook[1], '==', uid);
}
const bump = (row: Data) => ({ revision: (row.revision ?? 0) + 1, accessRevision: (row.accessRevision ?? 0) + 1, updatedAt: Timestamp.now() });

async function prepareRemoval(tx: Transaction, uid: string, stage: string, doc: FirebaseFirestore.QueryDocumentSnapshot): Promise<(() => void) | null> {
  const db = getFirestore(); const parts = doc.ref.path.split('/'); const row = doc.data();
  if (stage === 'members') {
    if (parts.length !== 4 || parts[0] !== 'organizations' || doc.id !== uid) return null;
    const orgRef = doc.ref.parent.parent!;
    const org = await tx.get(orgRef);
    let recovery = false;
    if (row.status === 'active' && row.roles?.includes('orgAdmin')) {
      const admins = await tx.get(doc.ref.parent.where('roles', 'array-contains', 'orgAdmin').limit(100));
      let survivor = false;
      for (const candidate of admins.docs) {
        if (candidate.id === uid || candidate.data().status !== 'active') continue;
        const [user, deletion] = await tx.getAll(db.doc(`users/${candidate.id}`), jobRef(candidate.id));
        if (user.exists && user.data()?.accountState !== 'deleting' && !deletion.exists) { survivor = true; break; }
      }
      recovery = !survivor;
    }
    return () => {
      tx.delete(doc.ref);
      if (org.exists && recovery) {
        tx.update(orgRef, { administrativeControl: 'recoveryRequired', ...bump(org.data()!) });
        tx.set(orgRef.collection('audit').doc(deletionAuditId(uid)), { operation: 'accountDeletionAdminRecovery', createdAt: Timestamp.now(), schemaVersion: 2 });
      }
    };
  }
  if (stage === 'guardians') {
    if (parts.length !== 6 || parts[0] !== 'organizations' || parts[2] !== 'participants' || doc.id !== uid) return null;
    const parent = doc.ref.parent.parent!; const participant = await tx.get(parent);
    const others = await tx.get(doc.ref.parent.where('status', '==', 'active').limit(2));
    const onlyGuardian = !others.docs.some(other => other.id !== uid);
    return () => {
      tx.delete(doc.ref);
      if (participant.exists) tx.update(parent, { ...bump(participant.data()!), ...(onlyGuardian ? { guardianRecoveryRequired: true } : {}) });
    };
  }
  if (stage === 'participants') {
    if (parts.length !== 4 || parts[0] !== 'organizations') return null;
    const profile = await tx.get(doc.ref.collection('private').doc('profile'));
    return () => {
      tx.update(doc.ref, { linkedUserId: null, ...bump(row) });
      if (profile.exists) tx.update(profile.ref, { contactEmail: FieldValue.delete(), contactPhone: FieldValue.delete(), ...bump(profile.data()!) });
    };
  }
  if (stage === 'messages') {
    if (parts.length !== 6 || parts[0] !== 'organizations' || parts[2] !== 'conversations' || parts[4] !== 'messages') return null;
    return () => tx.update(doc.ref, { authorUid: FieldValue.delete(), authorIdentity: deletedIdentity });
  }
  if (stage === 'staffNotes') {
    if (parts.length !== 6 || parts[0] !== 'organizations' || parts[2] !== 'staffNotes' || parts[4] !== 'entries') return null;
    return () => tx.update(doc.ref, { authorUid: FieldValue.delete(), authorIdentity: deletedIdentity });
  }
  if (stage === 'messageEdits') {
    if (parts.length !== 8 || parts[0] !== 'organizations' || parts[2] !== 'conversations' || parts[4] !== 'messages' || parts[6] !== 'edits') return null;
    return () => tx.update(doc.ref, { actorUid: FieldValue.delete(), actorIdentity: deletedIdentity });
  }
  if (stage === 'messageModerators') {
    if (parts.length !== 6 || parts[0] !== 'organizations' || parts[2] !== 'conversations' || parts[4] !== 'messages') return null;
    return () => tx.update(doc.ref, { moderatedBy: FieldValue.delete(), moderatorIdentity: deletedIdentity });
  }
  if (stage === 'reactions') {
    if (parts.length !== 8 || parts[0] !== 'organizations' || parts[2] !== 'conversations' || parts[4] !== 'messages' || parts[6] !== 'reactions') return null;
    const messageRef = doc.ref.parent.parent!;
    const message = await tx.get(messageRef);
    const code = typeof row.code === 'string' ? row.code : null;
    return () => {
      tx.delete(doc.ref);
      if (message.exists && code) {
        const current = message.data()?.reactionCounts?.[code];
        tx.update(messageRef, { [`reactionCounts.${code}`]: Math.max(0, typeof current === 'number' && Number.isSafeInteger(current) ? current - 1 : 0) });
      }
    };
  }
  if (stage === 'attachmentSlots') return () => tx.delete(doc.ref);
  if (stage === 'importJobs') {
    // Fence workers immediately; scheduled retention removes private bytes and nested rows.
    return () => tx.update(doc.ref, { ownerUid: null, status: 'expired', expiresAt: Timestamp.now(), lease: null, updatedAt: Timestamp.now() });
  }
  if (stage === 'deliveryIssues' || stage === 'criticalUpdates') {
    if (row.recipientUid !== uid) return null;
    if (parts[0] === 'organizations' && (parts.length !== 4 || parts[2] !== stage)) return null;
  }
  if (stage === 'invitations' && row.tokenHash && row.outboxId) {
    return () => {
      tx.delete(doc.ref);
      tx.delete(db.doc(`invitationTokens/${row.tokenHash}`));
      tx.delete(db.doc(`emailOutbox/${row.outboxId}`));
    };
  }
  return () => { tx.delete(doc.ref); };
}

/** One bounded, atomic page. Cursor and audit counters commit with the cleanup. */
async function cleanupPage(uid: string) {
  const db = getFirestore();
  return db.runTransaction(async tx => {
    const job = await tx.get(jobRef(uid)); const state = job.data();
    if (!state || state.status === 'complete' || stages[state.stage] === 'auth') return false;
    const stage = stages[state.stage];
    let query = queryFor(stage, uid).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (state.cursor) query = query.startAfter(db.doc(state.cursor));
    const page = await tx.get(query);
    const removals: (() => void)[] = [];
    for (const doc of page.docs) {
      const remove = await prepareRemoval(tx, uid, stage, doc);
      if (remove) removals.push(remove);
    }
    for (const remove of removals) remove();
    const countField = communicationCountFields[stage as keyof typeof communicationCountFields];
    tx.update(job.ref, { stage: page.size < PAGE_SIZE ? state.stage + 1 : state.stage,
      cursor: page.size < PAGE_SIZE ? null : page.docs[page.size - 1].ref.path,
      pages: state.pages + 1, recordsRemoved: state.recordsRemoved + removals.length,
      membershipsRemoved: state.membershipsRemoved + (stage === 'teamMembers' ? removals.length : 0),
      ...(countField ? { [`communicationCounts.${countField}`]: FieldValue.increment(removals.length) } : {}),
      updatedAt: Timestamp.now(), lastError: null });
    return true;
  });
}

function attachmentBucket() {
  const name = configuredAttachmentBucket(getStorage().app.options.storageBucket);
  if (!name) throw new Error('Attachment storage is not configured.');
  return getStorage().bucket(name);
}

async function deleteAttachmentBytes(orgId: string, attachmentId: string, objectPath: unknown) {
  const safePrefix = `quarantine/${orgId}/${attachmentId}/`;
  const paths = new Set([uploadObjectPath(orgId, attachmentId), canonicalObjectPath(orgId, attachmentId)]);
  if (typeof objectPath === 'string' && objectPath.startsWith(safePrefix)) paths.add(objectPath);
  for (const path of paths) {
    try { await attachmentBucket().file(path).delete({ ignoreNotFound: true }); }
    catch (error) { if (storageReadFailure(error) !== 'missing') throw error; }
  }
}

async function linkedMessage(doc: FirebaseFirestore.QueryDocumentSnapshot) {
  const row = doc.data();
  const parts = doc.ref.path.split('/');
  if (parts.length !== 4 || parts[0] !== 'organizations' || parts[2] !== 'attachments') return null;
  const orgId = parts[1];
  const messageId = typeof row.messageId === 'string' ? row.messageId : null;
  const conversationId = typeof row.conversationId === 'string' ? row.conversationId : null;
  if (!messageId || !conversationId) return null;
  const message = await getFirestore().doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}`).get();
  const attachmentIds = message.data()?.attachmentIds;
  return message.exists && Array.isArray(attachmentIds) && attachmentIds.includes(doc.id) ? message.ref : null;
}

/** Storage deletion happens before the Firestore checkpoint so retries never leave private orphan bytes. */
async function cleanupAttachmentPage(uid: string) {
  const db = getFirestore();
  const job = await jobRef(uid).get();
  const state = job.data();
  if (!state || state.status === 'complete' || stages[state.stage] !== 'attachments') return false;
  const page = await queryFor('attachments', uid).orderBy(FieldPath.documentId()).limit(PAGE_SIZE).get();
  const linked = new Set<string>();
  for (const doc of page.docs) {
    if (await linkedMessage(doc)) linked.add(doc.ref.path);
    else {
      const parts = doc.ref.path.split('/');
      await deleteAttachmentBytes(parts[1], doc.id, doc.data().objectPath);
    }
  }
  await db.runTransaction(async tx => {
    const currentJob = await tx.get(jobRef(uid));
    const current = currentJob.data();
    if (!current || current.status === 'complete' || stages[current.stage] !== 'attachments') return;
    const liveDocs = page.docs.length ? await tx.getAll(...page.docs.map(doc => doc.ref)) : [];
    let linkedRetained = 0; let unlinkedDeleted = 0;
    for (const live of liveDocs) {
      if (!live.exists || live.data()?.ownerUid !== uid) continue;
      if (linked.has(live.ref.path)) {
        tx.update(live.ref, { ownerUid: FieldValue.delete(), ownerIdentity: deletedIdentity });
        linkedRetained += 1;
      } else {
        tx.delete(live.ref);
        unlinkedDeleted += 1;
      }
    }
    tx.update(currentJob.ref, {
      stage: page.empty ? current.stage + 1 : current.stage,
      cursor: null,
      pages: current.pages + 1,
      recordsRemoved: current.recordsRemoved + unlinkedDeleted,
      'attachmentCounts.linkedRetained': FieldValue.increment(linkedRetained),
      'attachmentCounts.unlinkedDeleted': FieldValue.increment(unlinkedDeleted),
      updatedAt: Timestamp.now(), lastError: null,
    });
  });
  return true;
}

async function migratePendingJob(uid: string) {
  const ref = jobRef(uid);
  await getFirestore().runTransaction(async tx => {
    const job = await tx.get(ref); const state = job.data();
    if (!state || state.status === 'complete' || state.schemaVersion === 3) return;
    const legacyStage = legacyStages[state.stage];
    const stage = legacyStage === 'attachmentAudit' || legacyStage === 'auth'
      ? stages.indexOf('messages')
      : Math.max(0, stages.indexOf(legacyStage));
    tx.update(ref, { schemaVersion: 3, stage, cursor: null, residualAttachments: FieldValue.delete(), residualAudit: FieldValue.delete(), updatedAt: Timestamp.now() });
  });
}

type AuthCleanup = Pick<ReturnType<typeof getAuth>, 'deleteUser'>;
/** Service identity resumes without any caller token; concurrent invocations are idempotent. */
export async function resumeDeletion(uid: string, maxPages = 30, auth: AuthCleanup = getAuth()) {
  const db = getFirestore(); const ref = jobRef(uid);
  try {
    await migratePendingJob(uid);
    await db.runTransaction(async tx => {
      const job = await tx.get(ref);
      if (job.exists && job.data()?.status !== 'complete') tx.update(ref, { attempts: FieldValue.increment(1), updatedAt: Timestamp.now() });
    });
    for (let i = 0; i < maxPages; i++) {
      const current = (await ref.get()).data();
      if (current?.status === 'pending' && stages[current.stage] === 'attachments') {
        if (!await cleanupAttachmentPage(uid)) break;
      } else if (!await cleanupPage(uid)) break;
    }
    let state = (await ref.get()).data();
    if (state?.status === 'pending' && stages[state.stage] === 'auth') {
      try { await auth.deleteUser(uid); }
      catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
      await db.runTransaction(async tx => {
        const job = await tx.get(ref);
        if (job.data()?.status === 'complete') return;
        const row = job.data() ?? {};
        const communication = row.communicationCounts ?? {};
        const attachment = row.attachmentCounts ?? {};
        tx.delete(db.doc(`users/${uid}/communication/essential`));
        tx.delete(db.doc(`users/${uid}`)); tx.delete(db.doc(`organizationOwners/${uid}`));
        tx.update(ref, {
          status: 'complete', completedAt: Timestamp.now(), updatedAt: Timestamp.now(), lastError: null,
          residualAudit: {
            communications: {
              messagesTombstoned: communication.messagesTombstoned ?? 0,
              staffNotesTombstoned: communication.staffNotesTombstoned ?? 0,
              editActorsTombstoned: communication.editActorsTombstoned ?? 0,
              moderationActorsTombstoned: communication.moderationActorsTombstoned ?? 0,
              reactionsRemoved: communication.reactionsRemoved ?? 0,
            },
            attachments: {
              linkedRetained: attachment.linkedRetained ?? 0,
              unlinkedDeleted: attachment.unlinkedDeleted ?? 0,
              bytesRetained: true,
            },
          },
        });
      });
      state = (await ref.get()).data();
    }
    return state;
  } catch (error) {
    // Redacted operational code only; never persist provider errors, contacts, or token values.
    const failed = (await ref.get()).data();
    console.error('Account deletion cleanup failed.', {
      stage: typeof failed?.stage === 'number' ? stages[failed.stage] ?? 'unknown' : 'unknown',
      code: error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown',
    });
    await ref.update({ lastError: 'CLEANUP_RETRY_REQUIRED', updatedAt: Timestamp.now() });
    return (await ref.get()).data();
  }
}

export const deleteAccount = onCall({ timeoutSeconds: 120 }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to delete your account.');
  const previous = await jobRef(uid).get();
  if (previous.data()?.status === 'complete') return { ok: true, membershipsRemoved: 0 };
  if (!previous.exists) {
    const authTime = request.auth?.token.auth_time;
    const age = Date.now() / 1000 - Number(authTime);
    if (!Number.isFinite(age) || age < -60 || age > 300) {
      throw new HttpsError('failed-precondition', 'Sign out and sign in again before deleting your account.', { domainCode: 'RECENT_LOGIN_REQUIRED' });
    }
  }
  await beginDeletion(uid);
  const result = await resumeDeletion(uid);
  return { ok: true, membershipsRemoved: result?.membershipsRemoved ?? 0,
    ...(result?.status === 'complete' ? {} : { jobStatus: 'pending' }) };
});

export const resumeAccountDeletions = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 540 }, async () => {
  // Oldest attempted jobs move behind others so one failed job cannot starve the queue.
  const jobs = await getFirestore().collection('accountDeletionJobs').where('status', '==', 'pending').orderBy('updatedAt').limit(10).get();
  for (const job of jobs.docs) await resumeDeletion(job.id);
});
