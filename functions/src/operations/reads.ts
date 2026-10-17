import { DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';

/** Read-only transaction-attempt cache. Never retain snapshots across requests or retries. */
export function cacheDocumentReads(tx: Transaction): Transaction {
  const documents = new Map<string, Promise<DocumentSnapshot>>();
  function getAll(...refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
    const missing = [...new Map(refs.filter(ref => !documents.has(ref.path)).map(ref => [ref.path, ref])).values()];
    if (missing.length) {
      const batch = tx.getAll(...missing);
      missing.forEach((ref, index) => documents.set(ref.path, batch.then(rows => rows[index])));
    }
    return Promise.all(refs.map(ref => documents.get(ref.path)!));
  }
  return new Proxy(tx, {
    get(target, name) {
      if (name === 'getAll') return (...refs: DocumentReference[]) =>
        refs.every(ref => ref instanceof DocumentReference) ? getAll(...refs) : target.getAll(...refs);
      if (name === 'get') return (ref: any) => ref instanceof DocumentReference ? getAll(ref).then(rows => rows[0]) : target.get(ref);
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
