import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, getFirestore, Query, Timestamp, Transaction } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Data } from '../commandSupport';

const PAGE_SIZE = 25;
// Future token/feed/invitation writers must use these ownership fields and the tombstone gate.
export const cleanupHooks = [
  ['importJobs', 'ownerUid'], ['calendarSubscriptions', 'ownerUid'], ['invitations', 'recipientUid'],
  ['emailOutbox', 'recipientUid'], ['notificationEndpoints', 'userId'], ['notificationDeliveries', 'recipientUid'],
  ['deliveryIssues', 'recipientUid'], ['criticalUpdates', 'recipientUid'], ['commandRequests', 'uid'],
] as const;
const projections = ['organizationLinks', 'participantLinks', 'teamAccess', 'agenda', 'notifications', 'notificationEndpoints', 'deviceTokens'];
const stages = ['teamMembers', 'members', 'guardians', 'participants', ...cleanupHooks.map(([name]) => name), ...projections.map(name => `user:${name}`), 'auth'];
const jobRef = (uid: string) => getFirestore().doc(`accountDeletionJobs/${uid}`);

/** Server-only entry. Starting a job is atomic with loss of all app authority. */
export async function beginDeletion(uid: string) {
  const db = getFirestore();
  return db.runTransaction(async tx => {
    const job = await tx.get(jobRef(uid));
    if (job.exists) return job.data()!;
    const now = Timestamp.now();
    const data = { schemaVersion: 2, status: 'pending', stage: 0, cursor: null, pages: 0,
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
        tx.set(orgRef.collection('audit').doc(`account-deletion-${uid}`), { operation: 'accountDeletionAdminRecovery', createdAt: Timestamp.now(), schemaVersion: 2 });
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
    tx.update(job.ref, { stage: page.size < PAGE_SIZE ? state.stage + 1 : state.stage,
      cursor: page.size < PAGE_SIZE ? null : page.docs[page.size - 1].ref.path,
      pages: state.pages + 1, recordsRemoved: state.recordsRemoved + removals.length,
      membershipsRemoved: state.membershipsRemoved + (stage === 'teamMembers' ? removals.length : 0),
      updatedAt: Timestamp.now(), lastError: null });
    return true;
  });
}

type AuthCleanup = Pick<ReturnType<typeof getAuth>, 'deleteUser'>;
/** Service identity resumes without any caller token; concurrent invocations are idempotent. */
export async function resumeDeletion(uid: string, maxPages = 30, auth: AuthCleanup = getAuth()) {
  const db = getFirestore(); const ref = jobRef(uid);
  try {
    await db.runTransaction(async tx => {
      const job = await tx.get(ref);
      if (job.exists && job.data()?.status !== 'complete') tx.update(ref, { attempts: FieldValue.increment(1), updatedAt: Timestamp.now() });
    });
    for (let i = 0; i < maxPages; i++) if (!await cleanupPage(uid)) break;
    let state = (await ref.get()).data();
    if (state?.status === 'pending' && stages[state.stage] === 'auth') {
      try { await auth.deleteUser(uid); }
      catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
      await db.runTransaction(async tx => {
        const job = await tx.get(ref);
        if (job.data()?.status === 'complete') return;
        tx.delete(db.doc(`users/${uid}/communication/essential`));
        tx.delete(db.doc(`users/${uid}`)); tx.delete(db.doc(`organizationOwners/${uid}`));
        tx.update(ref, { status: 'complete', completedAt: Timestamp.now(), updatedAt: Timestamp.now(), lastError: null });
      });
      state = (await ref.get()).data();
    }
    return state;
  } catch {
    // Redacted operational code only; never persist provider errors, contacts, or token values.
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
