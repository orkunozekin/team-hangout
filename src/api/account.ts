import {
  httpsCallable,
} from 'firebase/functions';

import {
  functions,
} from '../firebase/config';

import {
  getCurrentUser,
  logout,
} from './auth';
import { clearGameDayCache } from '../lib/gameDayCache';

type DeleteAccountResult = {
  ok: true;
  membershipsRemoved: number;
};

/**
 * Calls the deleteAccount Cloud Function, then signs out locally.
 * Requires the Function to be deployed (`firebase deploy --only functions`).
 */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const uid = getCurrentUser()?.uid;
  if (uid) await clearGameDayCache(uid);
  const callable = httpsCallable<unknown, DeleteAccountResult>(
    functions,
    'deleteAccount',
  );
  const result = await callable();
  try {
    await logout();
  } catch {
    // Auth user may already be gone; ignore local sign-out failures.
  }
  return result.data;
}

export function getDeleteAccountErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error != null
    && 'code' in error
  ) {
    const code = String((error as { code: unknown }).code);
    if (
      code === 'functions/not-found'
      || code === 'functions/unavailable'
    ) {
      return 'Account deletion is not available yet. Please try again later or contact support.';
    }
    if (code === 'functions/unauthenticated') {
      return 'You must be signed in to delete your account.';
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Could not delete account. Please try again.';
}
