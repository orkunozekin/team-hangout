import { checkRevision } from './operations/revisions';
import { eventScope } from './organizations/policy';
import { v2Fields, teamIds, validateStoredEvent, storageFields, eventAudit } from './organizations/events';
import { Data, invalid, object, keys, text, id, optional, revision, command } from './commandSupport';
import { randomInt } from 'node:crypto';
import { getFirestore, Timestamp, Transaction, DocumentData } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

function eventFields(value: unknown, partial = false): Data {
  const data = object(value);
  keys(data, ['title', 'type', 'date', 'time', 'location', 'notes']);
  const out: Data = {};
  for (const field of ['title', 'type', 'date', 'time']) {
    if (partial && data[field] === undefined) continue;
    if (field === 'title') out.title = text(data.title, 'title');
    if (field === 'type') {
      if (!['practice', 'match'].includes(data.type)) invalid('Invalid event type.');
      out.type = data.type;
    }
    if (field === 'time') {
      if (typeof data.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)) invalid('Use HH:mm for time.');
      out.time = data.time;
    }
    if (field === 'date') {
      // Preserve legacy calendar-date instants; timezone conversion belongs to Step 4.
      if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.date)
        || !Number.isFinite(Date.parse(data.date)) || new Date(data.date).toISOString() !== data.date) invalid('Invalid date.');
      out.date = data.date;
    }
  }
  if (!partial || data.location !== undefined) {
    out.location = null;
    if (data.location != null) {
      const location = object(data.location); keys(location, ['name', 'address']);
      out.location = { name: text(location.name, 'location name'), ...(location.address ? { address: text(location.address, 'address', 500) } : {}) };
    }
  }
  if (!partial || data.notes !== undefined) out.notes = optional(typeof data.notes === 'string' ? data.notes.trim() : data.notes, 'notes', 5000);
  if (partial && !Object.keys(out).length) invalid('No event changes supplied.');
  return out;
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() { return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
function legacy(data: Data) {
  if (data.schemaVersion === 2 || data.orgId != null) throw new HttpsError('failed-precondition', 'Organization commands are required.', { domainCode: 'ORGANIZATION_SETUP_REQUIRED' });
}
async function managedTeam(tx: Transaction, teamId: string, uid: string, admin: boolean) {
  const db = getFirestore();
  const [team, member] = await tx.getAll(db.doc(`teams/${teamId}`), db.doc(`teamMembers/${teamId}_${uid}`));
  if (!team.exists || (!admin && !(member.data()?.role === 'coach' && member.data()?.teamId === teamId && member.data()?.userId === uid))) {
    throw new HttpsError('permission-denied', 'Only a team coach or platform administrator can do this.');
  }
  legacy(team.data()!);
  return team;
}
export const createTeam = command('createTeam', data => {
  keys(data, ['requestId', 'name', 'sport']);
  return { name: text(data.name, 'team name'), sport: optional(data.sport, 'sport', 100) };
}, async (tx, payload, uid, actor, replay) => {
  if (replay) {
    await managedTeam(tx, replay.team.id, uid, actor.appRole === 'superAdmin');
    return replay;
  }
  const db = getFirestore(); const ref = db.collection('teams').doc();
  const code = inviteCode();
  if ((await tx.get(db.doc(`inviteCodes/${code}`))).exists) throw new HttpsError('aborted', 'Please try again.');
  const now = Timestamp.now();
  const team = { ...payload, inviteCode: code, createdBy: uid, createdAt: now, updatedAt: now };
  const membership = { teamId: ref.id, userId: uid, role: 'coach', displayName: actor.displayName ?? '', joinedAt: now };
  tx.create(ref, team);
  tx.create(db.doc(`inviteCodes/${code}`), { code, teamId: ref.id, createdBy: uid, createdAt: now });
  tx.create(db.doc(`teamMembers/${ref.id}_${uid}`), membership);
  tx.update(db.doc(`users/${uid}`), { activeTeamId: ref.id, updatedAt: now });
  return { team: { id: ref.id, ...team }, membership: { id: `${ref.id}_${uid}`, ...membership } };
});
export const joinTeamWithInvite = command('joinTeamWithInvite', data => {
  keys(data, ['requestId', 'code']); const code = text(data.code, 'invite code').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) invalid('Invalid invite code format.');
  return { code };
}, async (tx, payload, uid, actor, replay) => {
  const db = getFirestore();
  const lookup = await tx.get(db.doc(`inviteCodes/${payload.code}`));
  // A successful join replay is allowed only while the original membership remains valid.
  const teamId = replay?.team?.id ?? lookup.data()?.teamId;
  if (typeof teamId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(teamId)) throw new HttpsError('not-found', 'Invite code is invalid or no longer active.', { domainCode: 'INVITE_UNAVAILABLE' });
  const [team, member] = await tx.getAll(db.doc(`teams/${teamId}`), db.doc(`teamMembers/${teamId}_${uid}`));
  if (!team.exists) throw new HttpsError('not-found', 'Invite code is invalid or no longer active.', { domainCode: 'INVITE_UNAVAILABLE' });
  legacy(team.data()!);
  if (replay) {
    if (!member.exists || member.data()?.teamId !== teamId || member.data()?.userId !== uid) throw new HttpsError('permission-denied', 'Team access was removed.');
    return replay;
  }
  if (!lookup.exists || team.data()?.inviteCode !== payload.code) throw new HttpsError('not-found', 'Invite code is invalid or no longer active.', { domainCode: 'INVITE_UNAVAILABLE' });
  if (member.exists && (member.data()?.teamId !== teamId || member.data()?.userId !== uid || !['coach', 'player'].includes(member.data()?.role))) {
    throw new HttpsError('failed-precondition', 'Team membership needs support review.');
  }
  const now = Timestamp.now();
  const membership = member.data() ?? { teamId, userId: uid, role: 'player', displayName: actor.displayName ?? '', joinedAt: now };
  if (!member.exists) tx.create(member.ref, membership);
  tx.update(db.doc(`users/${uid}`), { activeTeamId: teamId, updatedAt: now });
  return { team: { id: teamId, ...team.data() }, membership: { id: member.id, ...membership } };
});
export const regenerateInvite = command('regenerateInvite', data => {
  keys(data, ['requestId', 'teamId']); return { teamId: id(data.teamId, 'teamId') };
}, async (tx, payload, uid, actor, replay) => {
  const team = await managedTeam(tx, payload.teamId, uid, actor.appRole === 'superAdmin');
  if (replay) return replay;
  const db = getFirestore(); const code = inviteCode();
  if ((await tx.get(db.doc(`inviteCodes/${code}`))).exists) throw new HttpsError('aborted', 'Please try again.');
  const oldRef = team.data()!.inviteCode ? db.doc(`inviteCodes/${id(team.data()!.inviteCode, 'stored invite code')}`) : null;
  const oldLookup = oldRef ? await tx.get(oldRef) : null;
  if (oldLookup?.exists && oldLookup.data()?.teamId !== team.id) throw new HttpsError('failed-precondition', 'Invite mapping needs support review.');
  const now = Timestamp.now();
  if (oldRef) tx.delete(oldRef);
  tx.create(db.doc(`inviteCodes/${code}`), { code, teamId: team.id, createdBy: uid, createdAt: now });
  tx.update(team.ref, { inviteCode: code, updatedAt: now });
  return { inviteCode: code };
});
export const renameTeam = command('renameTeam', data => {
  keys(data, ['requestId', 'teamId', 'name']); return { teamId: id(data.teamId, 'teamId'), name: text(data.name, 'team name') };
}, async (tx, payload, uid, actor, replay) => {
  const team = await managedTeam(tx, payload.teamId, uid, actor.appRole === 'superAdmin');
  if (replay) return replay;
  tx.update(team.ref, { name: payload.name, updatedAt: Timestamp.now() }); return { ok: true };
});
export const createEvent = command('createEvent', data => {
  keys(data, ['requestId', 'teamId', 'event']);
  const fields = object(data.event);
  return { teamId: id(data.teamId, 'teamId'), event: fields.startsAt !== undefined ? v2Fields(fields) : eventFields(fields) };
}, async (tx, payload, uid, actor, replay) => {
  const team = await tx.get(getFirestore().doc(`teams/${payload.teamId}`));
  if (!team.exists) throw new HttpsError('permission-denied', 'Team is unavailable.');
  let event: Data; const now = Timestamp.now();
  if (team.data()?.schemaVersion === 2 || team.data()?.orgId != null) {
    if (payload.event.startsAt === undefined) throw new HttpsError('failed-precondition', 'Organization event times are required.');
    const ids = teamIds(payload.event.teamIds);
    if (ids[0] !== payload.teamId) invalid('teamId must match the first teamIds entry.');
    const scope = await eventScope(tx, ids, uid, !replay);
    event = { ...storageFields(payload.event), orgId: scope.orgId, programId: scope.programId, seasonId: scope.seasonId,
      divisionId: scope.teams.every(team => team.divisionId === scope.teams[0].divisionId) ? scope.teams[0].divisionId : null,
      schemaVersion: 2, publicationOperationId: null, teamId: ids[0], scheduleVersion: 1,
      homeTeamId: payload.event.type === 'match' && ids.length === 2 ? ids[0] : null,
      awayTeamId: payload.event.type === 'match' && ids.length === 2 ? ids[1] : null };
    validateStoredEvent(event, scope);
  } else {
    await managedTeam(tx, payload.teamId, uid, actor.appRole === 'superAdmin');
    eventFields(payload.event);
    event = { ...payload.event, date: Timestamp.fromDate(new Date(payload.event.date)), teamId: payload.teamId };
  }
  if (replay) return replay;
  const ref = getFirestore().collection('events').doc();
  event = { ...event, revision: 1, createdBy: uid, updatedBy: uid, createdAt: now, updatedAt: now, deletedAt: null };
  tx.create(ref, event);
  if (event.schemaVersion === 2) eventAudit(tx, event, uid, 'createEvent', ref.id, 1);
  return { id: ref.id, ...event };
});
function changeEvent(deleting: boolean) {
  return command(deleting ? 'softDeleteEvent' : 'updateEvent', data => {
    keys(data, deleting ? ['requestId', 'eventId', 'expectedRevision'] : ['requestId', 'eventId', 'expectedRevision', 'patch']);
    return { eventId: id(data.eventId, 'eventId'), expectedRevision: revision(data.expectedRevision), ...(deleting ? {} : { patch: object(data.patch) }) };
  }, async (tx, payload, uid, actor, replay) => {
    const ref = getFirestore().doc(`events/${payload.eventId}`); const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('permission-denied', 'Event is unavailable.');
    const event = snap.data()!;
    const v2 = event.schemaVersion === 2 || event.orgId != null;
    let changes: Data = {};
    if (v2) {
      const scope = await eventScope(tx, teamIds(event.teamIds), uid, !replay);
      validateStoredEvent(event, scope);
      // Reauthorize against current state, but never reapply an old patch to a later edit.
      if (replay) return replay;
      if (!deleting) {
        if (event.publicationState === 'published') {
          throw new HttpsError('failed-precondition', 'Use the event lifecycle command to edit published events.', { domainCode: 'LIFECYCLE_COMMAND_REQUIRED' });
        }
        if (['startsAt', 'endsAt', 'timeZone', 'status'].some(field => payload.patch[field] !== undefined)) {
          invalid('Use the revisioned event lifecycle command for schedule changes.');
        }
        changes = v2Fields(payload.patch, true);
        if (changes.publicationState !== undefined && changes.publicationState !== 'published') invalid('Published events cannot be staged again.');
        // Compatibility edits are restricted to unpublished, server-owned single-event drafts.
        if (event.status !== 'scheduled') throw new HttpsError('failed-precondition', 'This lifecycle is not editable yet.');
        changes = storageFields({ ...event, ...changes });
      }
    } else {
      await managedTeam(tx, id(event.teamId, 'stored teamId'), uid, actor.appRole === 'superAdmin');
      if (!deleting) changes = eventFields(payload.patch, true);
    }
    if (replay) return replay;
    const currentRevision = event.revision ?? 0;
    checkRevision(event, payload.expectedRevision);
    if (event.deletedAt != null) throw new HttpsError('failed-precondition', 'This event was deleted. Reload the schedule.');
    const now = Timestamp.now(); const patch: DocumentData = deleting ? { deletedAt: now } : changes;
    if (patch.date) patch.date = Timestamp.fromDate(new Date(patch.date));
    tx.update(ref, { ...patch, revision: currentRevision + 1, updatedAt: now, updatedBy: uid });
    if (v2) eventAudit(tx, event, uid, deleting ? 'softDeleteEvent' : 'updateEvent', ref.id, currentRevision + 1);
    return { ok: true, revision: currentRevision + 1 };
  });
}
export const updateEvent = changeEvent(false);
export const softDeleteEvent = changeEvent(true);
