import { scheduleMutation } from '../scheduling/lease';
/** Offline, reviewed tooling only. No callable exports and no email/rollout writes. */
import { createHash } from 'node:crypto';
import { Firestore, Timestamp } from 'firebase-admin/firestore';

type Data = Record<string, any>;
export type Inventory = Record<string, Data>;
export type Mapping = { teamId: string; orgId: string; programId: string; seasonId: string; divisionId: string; timeZone: string; confirmedBy: string; defaultDurationMinutes: number };
export type Manifest = { version: 1; noEmail: true; confirmedAt: string; mappings: Mapping[] };
type Operation = { path: string; before: Data | null; after: Data; dependencyPaths: string[] };
export type Plan = { version: 1; manifestChecksum: string; runId: string; dependencies: Inventory; operations: Operation[]; report: Data };
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function id(value: unknown): asserts value is string { requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'Invalid document ID'); }
function iso(value: unknown): string {
  const date = value instanceof Timestamp ? value.toDate() : value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(NaN);
  requireValue(Number.isFinite(date.getTime()), 'Invalid timestamp');
  if (typeof value === 'string') requireValue(date.toISOString() === value, 'Timestamp must be exact UTC ISO');
  return date.toISOString();
}
/** Stable JSON and lossless Firestore timestamps for review files/checkpoints. */
export function encode(value: any): any {
  if (value instanceof Timestamp) return { __timestamp: [value.seconds, value.nanoseconds] };
  if (value instanceof Date) return { __timestamp: [Timestamp.fromDate(value).seconds, Timestamp.fromDate(value).nanoseconds] };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, encode(value[key])]));
  return value;
}
export function decode(value: any): any {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && Array.isArray(value.__timestamp)) return new Timestamp(...value.__timestamp as [number, number]);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
export const checksum = (value: any): string => createHash('sha256').update(JSON.stringify(encode(value))).digest('hex');
export const participantId = (orgId: string, uid: string): string => `legacy_${checksum([orgId, uid]).slice(0, 40)}`;

/** Interpret the retained UTC calendar-date label + HH:mm in the reviewed IANA zone.
 * Enumerate offsets around that date and round-trip; gaps and folds never guess. */
export function localInstant(dateValue: unknown, time: unknown, timeZone: string): Timestamp {
  const date = iso(dateValue).slice(0, 10);
  requireValue(typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'Invalid local time');
  requireValue(timeZone === 'UTC' || timeZone.includes('/'), 'Use an IANA timezone');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const partsAt = (ms: number) => Object.fromEntries(format.formatToParts(ms).map(part => [part.type, part.value]));
  const localMs = Date.parse(`${date}T${time}:00.000Z`);
  const candidates = new Set<number>();
  for (let hour = -48; hour <= 48; hour++) {
    const probe = localMs + hour * 3600000; const p = partsAt(probe);
    const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`) - probe;
    const instant = localMs - offset; const result = partsAt(instant);
    if (`${result.year}-${result.month}-${result.day} ${result.hour}:${result.minute}` === `${date} ${time}`) candidates.add(instant);
  }
  requireValue(candidates.size === 1, candidates.size === 0 ? 'Nonexistent local time (DST gap)' : 'Ambiguous local time (DST fold)');
  return Timestamp.fromMillis([...candidates][0]);
}
export function buildPlan(manifest: Manifest, inventory: Inventory): Plan {
  requireValue(manifest.version === 1 && manifest.noEmail === true && Array.isArray(manifest.mappings), 'Version 1 and noEmail:true required');
  iso(manifest.confirmedAt);
  const mappings = [...manifest.mappings].sort((a, b) => a.teamId.localeCompare(b.teamId));
  const manifestChecksum = checksum({ ...manifest, mappings });
  const runId = `legacy_${manifestChecksum.slice(0, 40)}`;
  const operations = new Map<string, Operation>(); const dependencies: Inventory = {};
  const report: Data = { issues: [], orphanPaths: [], unmappedTeamIds: [], counts: {}, noEmail: true };
  const issue = (path: string, reason: string) => report.issues.push({ path, reason });
  const get = (path: string) => { const data = inventory[path]; requireValue(data, `Missing ${path}`); dependencies[path] = data; return data; };
  const put = (path: string, after: Data) => {
    const existing = operations.get(path);
    if (existing) { requireValue(checksum(existing.after) === checksum({ ...after, migrationRunId: runId }), `Conflicting target ${path}`); return; }
    requireValue(!inventory[path] || path.startsWith('teams/') && path.split('/').length === 2 || path.startsWith('teamMembers/') || path.startsWith('events/') || path.startsWith('inviteCodes/'), `Target already exists: ${path}`);
    const mapping = mappings.find(row => row.orgId === after.orgId && (!after.teamId || row.teamId === after.teamId));
    const dependencyPaths = mapping ? [
      `organizations/${mapping.orgId}`, `organizations/${mapping.orgId}/programs/${mapping.programId}`,
      `organizations/${mapping.orgId}/seasons/${mapping.seasonId}`, `organizations/${mapping.orgId}/divisions/${mapping.divisionId}`,
      ...[after.createdBy, after.userId, after.linkedUserId].filter(Boolean).map(uid => `users/${uid}`),
    ] : [];
    operations.set(path, { path, before: inventory[path] ?? null, after: { ...after, migrationRunId: runId }, dependencyPaths: [...new Set(dependencyPaths)].sort() });
  };
  const mapped = new Set<string>();
  for (const mapping of mappings) {
    const { teamId, orgId, programId, seasonId, divisionId, timeZone, confirmedBy, defaultDurationMinutes } = mapping;
    try {
      [teamId, orgId, programId, seasonId, divisionId, confirmedBy].forEach(id);
      requireValue(!mapped.has(teamId), 'Duplicate team mapping'); mapped.add(teamId);
      requireValue(Number.isInteger(defaultDurationMinutes) && defaultDurationMinutes > 0 && defaultDurationMinutes <= 1440, 'Invalid reviewed duration');
      localInstant('2026-01-15T00:00:00.000Z', '12:00', timeZone);
      const team = get(`teams/${teamId}`);
      requireValue(team.orgId == null && team.schemaVersion !== 2, 'Team already mapped; reuse the saved plan');
      const org = get(`organizations/${orgId}`);
      const program = get(`organizations/${orgId}/programs/${programId}`);
      const season = get(`organizations/${orgId}/seasons/${seasonId}`);
      const division = get(`organizations/${orgId}/divisions/${divisionId}`);
      requireValue([org, program, season, division].every(row => row.schemaVersion === 2 && row.status === 'active') && org.features?.organizationV2 === true, 'Hierarchy inactive or rollout unavailable');
      requireValue(program.orgId === orgId && season.orgId === orgId && season.programId === programId && division.orgId === orgId && division.programId === programId && division.seasonId === seasonId, 'Cross-organization or inconsistent hierarchy');
      id(team.createdBy); get(`users/${team.createdBy}`); iso(team.createdAt); iso(team.updatedAt);
      requireValue(typeof team.name === 'string' && team.name.trim(), 'Missing team name');
      const parents = { orgId, programId, seasonId, divisionId };
      const metadata = { schemaVersion: 2, revision: 1, createdAt: team.createdAt, updatedAt: team.updatedAt, createdBy: team.createdBy, updatedBy: confirmedBy };
      put(`teams/${teamId}`, { ...team, ...parents, ...metadata, status: 'active' });
      requireValue(typeof team.inviteCode === 'string' && /^[A-Z2-9]{8}$/.test(team.inviteCode), 'Invalid invite code');
      const invite = get(`inviteCodes/${team.inviteCode}`);
      requireValue(invite.teamId === teamId, 'Invite lookup points to another team');
      put(`inviteCodes/${team.inviteCode}`, { ...invite, orgId, schemaVersion: 2, legacyIntent: 'playerJoinOnly' });
      for (const [path, member] of Object.entries(inventory).filter(([path, row]) => path.startsWith('teamMembers/') && row.teamId === teamId).sort()) {
        try {
          id(member.userId); requireValue(path === `teamMembers/${teamId}_${member.userId}`, 'Noncanonical membership ID');
          const user = get(`users/${member.userId}`); iso(member.joinedAt);
          requireValue(member.orgId == null && member.schemaVersion !== 2 && ['player', 'coach'].includes(member.role), 'Invalid legacy membership');
          put(path, { ...member, orgId, schemaVersion: 2, roles: member.role === 'coach' ? ['coach'] : [], status: 'active' });
          if (member.role !== 'player') continue;
          const pid = participantId(orgId, member.userId);
          // User profile is canonical across teams; names never establish identity.
          requireValue(typeof user.displayName === 'string' && user.displayName.trim(), 'Missing canonical player name');
          put(`organizations/${orgId}/participants/${pid}`, { displayName: user.displayName, kind: 'unknown', linkedUserId: member.userId, externalId: null, status: 'active', schemaVersion: 2 });
          put(`teams/${teamId}/roster/${pid}`, { orgId, participantId: pid, status: 'active', jerseyNumber: null, joinedAt: member.joinedAt, removedAt: null, schemaVersion: 2 });
        } catch (error) { issue(path, (error as Error).message); }
      }
      for (const [path, event] of Object.entries(inventory).filter(([path, row]) => path.startsWith('events/') && row.teamId === teamId).sort()) {
        try {
          requireValue(event.orgId == null && event.schemaVersion !== 2, 'Event already mapped');
          id(event.createdBy); get(`users/${event.createdBy}`); iso(event.createdAt); iso(event.updatedAt);
          if (event.deletedAt != null) iso(event.deletedAt);
          requireValue(typeof event.title === 'string' && event.title.trim() && ['practice', 'match'].includes(event.type), 'Invalid event title/type');
          requireValue(event.revision == null || Number.isSafeInteger(event.revision) && event.revision >= 0, 'Invalid event revision');
          const startsAt = localInstant(event.date, event.time, timeZone);
          put(path, { ...event, ...parents, schemaVersion: 2, revision: (event.revision ?? 0) + 1, updatedBy: confirmedBy, teamIds: [teamId], startsAt, endsAt: Timestamp.fromMillis(startsAt.toMillis() + defaultDurationMinutes * 60000), timeZone, timeSource: 'legacyConverted', durationSource: 'migrationDefault', status: 'scheduled', publicationState: 'staged', publicationOperationId: null, deletedAt: event.deletedAt ?? null });
        } catch (error) { issue(path, (error as Error).message); }
      }
    } catch (error) { issue(`teams/${teamId}`, (error as Error).message); }
  }
  for (const [path, row] of Object.entries(inventory).sort()) {
    if (path.startsWith('teams/') && path.split('/').length === 2 && !mapped.has(path.split('/')[1]) && row.orgId == null) report.unmappedTeamIds.push(path.split('/')[1]);
    const kind = path.split('/')[0];
    if (['teamMembers', 'events', 'inviteCodes'].includes(kind) && !inventory[`teams/${row.teamId}`]
      || kind === 'teamMembers' && !inventory[`users/${row.userId}`]
      || ['teams', 'events'].includes(kind) && path.split('/').length === 2 && !inventory[`users/${row.createdBy}`]) report.orphanPaths.push(path);
  }
  const sorted = [...operations.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const op of sorted) {
    const kind = op.path.includes('/participants/') ? 'participants' : op.path.includes('/roster/') ? 'roster' : op.path.split('/')[0];
    report.counts[kind] = (report.counts[kind] ?? 0) + 1;
  }
  report.sourceCounts = Object.fromEntries(['teams', 'teamMembers', 'events', 'inviteCodes', 'users'].map(kind => [kind, Object.keys(inventory).filter(path => path.split('/')[0] === kind && path.split('/').length === 2).length]));
  return { version: 1, manifestChecksum, runId, dependencies, operations: sorted, report };
}

/** Each bounded transaction stores its preimage and completion marker atomically.
 * Replays verify targets, source dependencies and the exact approved plan. */
export async function applyPlan(db: Firestore, plan: Plan, approvedChecksum: string, maxOperations = Infinity) {
  const digest = checksum(plan);
  requireValue(digest === approvedChecksum && plan.version === 1, 'Approved plan checksum mismatch');
  requireValue(plan.report.issues.length === 0 && plan.report.orphanPaths.length === 0 && plan.report.noEmail === true, 'Review blocking rows/orphans first');
  const run = db.doc(`legacyMigrationRuns/${plan.runId}`);
  await db.runTransaction(async tx => {
    const existing = await tx.get(run);
    requireValue(!existing.exists || existing.data()?.checksum === digest, 'Run ID already has a different plan');
    if (!existing.exists) tx.create(run, { checksum: digest, manifestChecksum: plan.manifestChecksum, status: 'applying', noEmail: true, total: plan.operations.length });
  });
  let applied = 0;
  for (let index = 0; index < plan.operations.length && applied < maxOperations; index++) {
    const operation = plan.operations[index];
    const wrote = await db.runTransaction(async tx => {
      const target = db.doc(operation.path); const checkpoint = run.collection('checkpoints').doc(String(index).padStart(8, '0'));
      const [saved, current] = await tx.getAll(checkpoint, target);
      const dependencyPaths = operation.dependencyPaths;
      const dependencies = dependencyPaths.length ? await tx.getAll(...dependencyPaths.map(path => db.doc(path))) : [];
      dependencies.forEach(doc => requireValue(checksum(doc.data() ?? null) === checksum(plan.dependencies[doc.ref.path]), `Dependency changed: ${doc.ref.path}`));
      if (saved.exists) {
        requireValue(saved.data()?.checksum === digest && checksum(current.data() ?? null) === checksum(operation.after), `Completed target changed: ${operation.path}`);
        return false;
      }
      requireValue(checksum(current.data() ?? null) === checksum(operation.before), `Source/target changed: ${operation.path}`);
      const orgId = operation.after?.orgId;
      const fence = orgId ? await scheduleMutation(tx, orgId, false, db) : null;
      if (fence) fence();
      tx.set(target, operation.after);
      tx.create(checkpoint, { checksum: digest, path: operation.path, before: operation.before, after: operation.after });
      return true;
    });
    if (wrote) applied++;
  }
  const checkpoints = await run.collection('checkpoints').get();
  const complete = checkpoints.size === plan.operations.length;
  if (complete) {
    for (const operation of plan.operations) {
      const current = await db.doc(operation.path).get();
      requireValue(checksum(current.data() ?? null) === checksum(operation.after), `Reconciliation failed: ${operation.path}`);
    }
  }
  await run.update({ status: complete ? 'complete' : 'applying', completed: checkpoints.size });
  return { complete, completed: checkpoints.size, expected: plan.operations.length };
}
