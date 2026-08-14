import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';

import {
  db,
} from './config';

import {
  parseAppRole,
} from '../lib/roles';

import {
  AppUser,
} from '../types/models';

function toDate(value: unknown): Date {
  if (
    value != null &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return new Date();
}

export function mapUserDoc(
  uid: string,
  data: Record<string, unknown>,
): AppUser {
  return {
    uid,
    email: String(data.email ?? ''),
    displayName: String(data.displayName ?? ''),
    appRole: parseAppRole(data.appRole),
    activeTeamId:
      data.activeTeamId == null
        ? null
        : String(data.activeTeamId),
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

export async function getUserDocument(
  uid: string,
): Promise<AppUser | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) {
    return null;
  }
  return mapUserDoc(uid, snap.data() as Record<string, unknown>);
}

export async function ensureUserDocument(
  uid: string,
  email: string,
  displayName: string,
): Promise<AppUser> {
  const existing = await getUserDocument(uid);
  if (existing) {
    return existing;
  }

  const ref = doc(db, 'users', uid);
  await setDoc(ref, {
    uid,
    email,
    displayName,
    appRole: 'user',
    activeTeamId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return {
    uid,
    email,
    displayName,
    appRole: 'user',
    activeTeamId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function updateUserDisplayName(
  uid: string,
  displayName: string,
): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    displayName: displayName.trim(),
    updatedAt: serverTimestamp(),
  });
}

export async function setActiveTeamId(
  uid: string,
  teamId: string | null,
): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    activeTeamId: teamId,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Promote/demote platform role. Only callable successfully when Firestore
 * rules allow (caller must already be a superAdmin). Bootstrap the first
 * superAdmin via Firebase console.
 */
export async function setUserAppRole(
  uid: string,
  appRole: 'user' | 'superAdmin',
): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    appRole,
    updatedAt: serverTimestamp(),
  });
}
