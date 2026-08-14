import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  User,
  UserCredential,
} from 'firebase/auth';

import {
  auth,
} from '../firebase/config';

import {
  ensureUserDocument,
} from '../firebase/users';

export function subscribeToAuthChanges(
  callback: (user: User | null) => void,
): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<UserCredential> {
  return signInWithEmailAndPassword(
    auth,
    email.trim(),
    password,
  );
}

export async function registerWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<UserCredential> {
  const credential = await createUserWithEmailAndPassword(
    auth,
    email.trim(),
    password,
  );

  const name = displayName.trim();
  await updateProfile(credential.user, { displayName: name });
  await ensureUserDocument(
    credential.user.uid,
    email.trim(),
    name,
  );

  return credential;
}

export async function resetPassword(
  email: string,
): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logout(): Promise<void> {
  await firebaseSignOut(auth);
}

export function getCurrentUser(): User | null {
  return auth.currentUser;
}
