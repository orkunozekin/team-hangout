import {
  initializeApp,
} from 'firebase-admin/app';

import {
  getAuth,
} from 'firebase-admin/auth';

import {
  getFirestore,
} from 'firebase-admin/firestore';

import {
  HttpsError,
  onCall,
} from 'firebase-functions/v2/https';

import {
  logger,
} from 'firebase-functions';

initializeApp();

const auth = getAuth();
const db = getFirestore();

/**
 * Deletes the caller's Firebase Auth account and related Firestore data:
 * - users/{uid}
 * - teamMembers where userId == uid
 *
 * Does NOT delete teams or events the user created (orphan coach content remains).
 */
export const deleteAccount = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError(
      'unauthenticated',
      'You must be signed in to delete your account.',
    );
  }

  logger.info('deleteAccount started', { uid });

  const membersSnap = await db
    .collection('teamMembers')
    .where('userId', '==', uid)
    .get();

  const batch = db.batch();
  membersSnap.docs.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  const userRef = db.collection('users').doc(uid);
  batch.delete(userRef);
  await batch.commit();

  try {
    await auth.deleteUser(uid);
  } catch (error: unknown) {
    const code =
      typeof error === 'object'
      && error != null
      && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    // Idempotent if Auth user was already removed.
    if (code !== 'auth/user-not-found') {
      logger.error('deleteAccount Auth delete failed', { uid, error });
      throw new HttpsError(
        'internal',
        'Account data was cleaned up but Auth deletion failed. Contact support.',
      );
    }
  }

  logger.info('deleteAccount completed', {
    uid,
    membershipsRemoved: membersSnap.size,
  });

  return {
    ok: true as const,
    membershipsRemoved: membersSnap.size,
  };
});
