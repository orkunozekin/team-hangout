import { createHash } from 'node:crypto';

// Preserve Phase 1 receipt hashes, including the indexed-object encoding of arrays.
function stable(value: any): string {
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Normalized JSON payload only. Array order is meaningful; object key order is not. */
export const fingerprint = (payload: Record<string, unknown>): string => hash(stable(payload));
/** Server-derived actor and operation; keep receipts in commandRequests for account deletion. */
export function receiptId(uid: string, operation: string, requestId: string, orgId?: string): string {
  return hash(`${uid}:${operation}:${orgId ? `${orgId}:` : ''}${requestId}`);
}
