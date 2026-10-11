import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './config';

/** Retry one action with one ID. A later action gets a fresh ID unless explicitly supplied. */
export async function runCommand<T = unknown>(
  name: string,
  payload: Record<string, unknown>,
  requestId = doc(collection(db, 'commandRequests')).id,
): Promise<T> {
  const call = httpsCallable<Record<string, unknown>, T>(functions, name);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await call({ ...payload, requestId });
      return result.data;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const uncertain = ['functions/unavailable', 'functions/deadline-exceeded'].includes(code ?? '');
      if (attempt === 0 && uncertain) continue;
      if (code === 'functions/not-found' && ['not-found', 'NOT_FOUND'].includes((error as Error).message) && !(error as { details?: { domainCode?: string } }).details?.domainCode) throw new Error('This action is unavailable. Update Team Hangout and try again, or contact support.');
      throw error;
    }
  }
}
