import { HttpsError } from 'firebase-functions/v2/https';

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpsError('invalid-argument', 'Reload the record before saving.');
  }
  return value as number;
}
export function stale(currentRevision: number): never {
  throw new HttpsError('aborted', 'This record changed. Reload before saving.', { domainCode: 'STALE_REVISION', currentRevision });
}
/** Zero is only the compatibility baseline for records predating revisions or creation. */
export function checkRevision(record: { revision?: unknown } | undefined, expected: number): void {
  const current = revision(record?.revision ?? 0);
  if (current !== revision(expected)) stale(current);
  if (current === Number.MAX_SAFE_INTEGER) {
    throw new HttpsError('failed-precondition', 'This record needs support before another edit.');
  }
}
