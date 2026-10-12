import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

/** A durable tombstone also rejects cached tokens after profile/Auth deletion. */
export async function accountAvailable(tx: Transaction, uid: string) {
  const db = getFirestore();
  const [user, deletion] = await tx.getAll(db.doc(`users/${uid}`), db.doc(`accountDeletionJobs/${uid}`));
  if (!user.exists || user.data()?.accountState === 'deleting' || deletion.exists) {
    throw new HttpsError('permission-denied', 'Account is unavailable.');
  }
  return user.data()!;
}
