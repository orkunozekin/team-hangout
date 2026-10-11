import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './config';

/** Keep the request ID across an automatic transport retry, never retry conflicts. */
export async function runCommand<T = unknown>(name: string, payload: Record<string, unknown>): Promise<T> {
  const requestId = doc(collection(db, 'commandRequests')).id;
  const call = httpsCallable<Record<string, unknown>, T>(functions, name);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await call({ ...payload, requestId })).data;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt === 0 && ['functions/unavailable', 'functions/deadline-exceeded'].includes(code ?? '')) continue;
      if (code === 'functions/not-found' && ['not-found', 'NOT_FOUND'].includes((error as Error).message) && !(error as { details?: { domainCode?: string } }).details?.domainCode) throw new Error('This action is unavailable. Update Team Hangout and try again, or contact support.');
      throw error;
    }
  }
}
