import { collection, doc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from './config';

const uncertainRequests = new Map<string, string>();
let requestActor: string | null = null;

/** Preserve uncertain requests across transport and user retries in this session. */
export async function runCommand<T = unknown>(name: string, payload: Record<string, unknown>): Promise<T> {
  const actor = auth.currentUser?.uid ?? null;
  if (requestActor !== actor) {
    uncertainRequests.clear();
    requestActor = actor;
  }
  const key = JSON.stringify([actor, name, payload]);
  const requestId = uncertainRequests.get(key) ?? doc(collection(db, 'commandRequests')).id;
  uncertainRequests.set(key, requestId);
  const call = httpsCallable<Record<string, unknown>, T>(functions, name);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await call({ ...payload, requestId });
      uncertainRequests.delete(key);
      return result.data;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const uncertain = ['functions/unavailable', 'functions/deadline-exceeded'].includes(code ?? '');
      if (attempt === 0 && uncertain) continue;
      if (!uncertain) uncertainRequests.delete(key);
      if (code === 'functions/not-found' && ['not-found', 'NOT_FOUND'].includes((error as Error).message) && !(error as { details?: { domainCode?: string } }).details?.domainCode) throw new Error('This action is unavailable. Update Team Hangout and try again, or contact support.');
      throw error;
    }
  }
}
