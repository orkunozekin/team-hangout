import { createHash } from 'node:crypto';
import { getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

export type Data = Record<string, any>;
export const invalid = (message: string): never => { throw new HttpsError('invalid-argument', message); };
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.');
  return value as Data;
}
export function keys(data: Data, allowed: string[]) {
  if (Object.keys(data).some(key => !allowed.includes(key))) invalid('Unsupported fields. Update the app and try again.');
}
export function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`Invalid ${field}.`);
  return (value as string).trim();
}
export function id(value: unknown, field: string): string {
  const result = text(value, field, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid(`Invalid ${field}.`);
  return result;
}
export function optional(value: unknown, field: string, max: number): string | null {
  return value == null || value === '' ? null : text(value, field, max);
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('Reload the record before saving.');
  return value as number;
}
export function wire(value: any): any {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]));
  return value;
}
function stable(value: any): string {
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Every command rechecks current authority before replaying a stored response.
export function command(name: string, normalize: (data: Data) => Data,
  execute: (tx: Transaction, payload: Data, uid: string, actor: Data, replay: Data | null) => Promise<Data>) {
  return onCall(async request => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    const data = object(request.data);
    const requestId = id(data.requestId, 'requestId');
    const payload = normalize(data);
    const fingerprint = hash(stable(payload));
    const db = getFirestore();
    const scope = payload.orgId ? `${payload.orgId}:` : "";
    const receipt = db.doc(`commandRequests/${hash(`${uid}:${name}:${scope}${requestId}`)}`);
    return db.runTransaction(async tx => {
      const [user, previous] = await tx.getAll(db.doc(`users/${uid}`), receipt);
      if (!user.exists || user.data()?.accountState === 'deleting') throw new HttpsError('permission-denied', 'Account is unavailable.');
      if (previous.exists && previous.data()?.fingerprint !== fingerprint) {
        throw new HttpsError('already-exists', 'This request ID was used for another change.', { domainCode: 'REQUEST_ID_REUSED' });
      }
      const result = wire(await execute(tx, payload, uid, user.data()!, previous.data()?.result ?? null));
      if (!previous.exists) tx.create(receipt, { uid, operation: name, fingerprint, result, createdAt: Timestamp.now() });
      return result;
    });
  });
}
