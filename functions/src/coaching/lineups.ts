import { FieldPath, getFirestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { command, Data, id, invalid, keys, object, revision } from '../commandSupport';
import { readCommand } from '../participants/policy';
import { checkRevision, denied, eventScope } from '../operations/access';
import { eligibleHousehold } from '../operations/availability';
import { publishedEvent } from '../scheduling/visibility';
import { LINEUP_PRESETS } from './presets';

const db = () => getFirestore();
const ROSTER_LIMIT = 200;
/** Keep aligned with LINEUP_NOTE_MAX in shared/lineups.ts. */
const NOTE_MAX = 2000;
const privateState = { state: 'private', sourceRevision: null, publishedAt: null, publicationRevision: 0 };

export function unavailable(participantIds: string[]): never {
  throw new HttpsError('failed-precondition', 'A lineup participant is no longer on the roster. Replace them before saving.',
    { domainCode: 'PARTICIPANT_UNAVAILABLE', participantIds });
}

async function canonicalEvent(tx: Transaction, eventId: string, teamId: string, team: Data) {
  const event = (await tx.get(db().doc(`events/${eventId}`))).data();
  if (!event || event.schemaVersion !== 2 || event.orgId !== team.orgId || event.programId !== team.programId
    || event.seasonId !== team.seasonId || !Array.isArray(event.teamIds) || !event.teamIds.includes(teamId)
    || !(await publishedEvent(tx, event))) denied();
  return event!;
}

/** Coaching capability is an active coach assignment for this team. Staff, captains, guardians and platform roles do not qualify. */
export async function coachingEvent(tx: Transaction, eventId: string, teamId: string, uid: string, writing: boolean) {
  const coach = (await tx.get(db().doc(`teamMembers/${teamId}_${uid}`))).data();
  if (coach?.teamId !== teamId || coach.userId !== uid || coach.status !== 'active'
    || !Array.isArray(coach.roles) || !coach.roles.includes('coach')) denied();
  const scope = await eventScope(tx, [teamId], uid, writing);
  if (coach!.orgId !== scope.orgId) denied();
  return { scope, event: await canonicalEvent(tx, eventId, teamId, scope.teams[0]) };
}

type RosterEntry = { participantId: string; displayName: string; available: boolean };
export async function rosterFor(tx: Transaction, orgId: string, teamId: string): Promise<Map<string, RosterEntry>> {
  const snap = await tx.get(db().collection(`teams/${teamId}/roster`).orderBy(FieldPath.documentId()).limit(ROSTER_LIMIT + 1));
  if (snap.size > ROSTER_LIMIT) {
    throw new HttpsError('resource-exhausted', `Lineups support at most ${ROSTER_LIMIT} roster entries. Ask your administrator to split the team.`);
  }
  const rows = snap.docs.filter(doc => {
    const row = doc.data();
    return row.schemaVersion === 2 && row.orgId === orgId && row.participantId === doc.id;
  });
  const people = rows.length
    ? await tx.getAll(...rows.map(doc => db().doc(`organizations/${orgId}/participants/${doc.id}`)))
    : [];
  return new Map(rows.map((doc, i) => {
    const person = people[i].data();
    const valid = person?.schemaVersion === 2 && (person.orgId == null || person.orgId === orgId);
    return [doc.id, {
      participantId: doc.id,
      displayName: valid && typeof person!.displayName === 'string' ? person!.displayName : 'Unavailable participant',
      available: valid && person!.status === 'active' && doc.data().status === 'active',
    }];
  }));
}

export function referenced(lineup: Data | undefined): string[] {
  if (!lineup) return [];
  return [...new Set([
    ...(lineup.units as Data[]).flatMap(unit => (unit.slots as Data[]).map(slot => slot.participantId as string)),
    ...(lineup.bench as string[]),
  ])];
}

function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Invalid position coordinate.');
  return Math.round(Math.min(1, Math.max(0, value as number)) * 10000) / 10000;
}

export function envelope(data: Data, payloadFields: string[]) {
  keys(data, ['requestId', 'orgId', 'resourceId', 'expectedRevision', 'payload']);
  const payload = object(data.payload);
  keys(payload, payloadFields);
  return {
    payload,
    base: {
      requestId: id(data.requestId, 'requestId'),
      orgId: id(data.orgId, 'orgId'),
      eventId: id(data.resourceId, 'eventId'),
      teamId: id(payload.teamId, 'teamId'),
      expectedRevision: revision(data.expectedRevision),
    },
  };
}

/** Exported for pure tests. Slot order follows the preset so retries fingerprint identically. */
export function normalizeLineup(data: Data) {
  const { payload, base } = envelope(data, ['teamId', 'sportPresetId', 'units', 'bench', 'note']);
  const sportPresetId = payload.sportPresetId;
  if (typeof sportPresetId !== 'string' || !Object.hasOwn(LINEUP_PRESETS, sportPresetId)) invalid('Choose a supported sport preset.');
  const preset = LINEUP_PRESETS[sportPresetId];
  if (!Array.isArray(payload.units) || payload.units.length !== preset.units.length) invalid('Invalid lineup units.');
  const assigned = new Set<string>();
  const units = (payload.units as unknown[]).map((raw, index) => {
    const unit = object(raw);
    keys(unit, ['unitId', 'slots']);
    const definition = preset.units[index];
    if (unit.unitId !== definition.id || !Array.isArray(unit.slots) || unit.slots.length > definition.slots.length) {
      invalid('Invalid lineup units.');
    }
    const slotIds = new Set<string>();
    const participants = new Set<string>();
    const slots = (unit.slots as unknown[]).map(rawSlot => {
      const slot = object(rawSlot);
      keys(slot, ['slotId', 'participantId', 'x', 'y']);
      const slotId = id(slot.slotId, 'slotId');
      const participantId = id(slot.participantId, 'participantId');
      if (!definition.slots.includes(slotId) || slotIds.has(slotId)) invalid('Each position can hold one participant.');
      if (participants.has(participantId)) invalid('A participant can appear only once in each unit.');
      slotIds.add(slotId);
      participants.add(participantId);
      assigned.add(participantId);
      return { slotId, participantId, x: coordinate(slot.x), y: coordinate(slot.y) };
    }).sort((a, b) => definition.slots.indexOf(a.slotId) - definition.slots.indexOf(b.slotId));
    return { unitId: definition.id, slots };
  });
  if (!Array.isArray(payload.bench) || payload.bench.length > ROSTER_LIMIT) invalid('Invalid bench order.');
  const bench = (payload.bench as unknown[]).map(value => id(value, 'participantId'));
  if (new Set(bench).size !== bench.length || bench.some(participantId => assigned.has(participantId))) {
    invalid('A bench participant cannot also hold a position.');
  }
  if (typeof payload.note !== 'string' || payload.note.trim().length > NOTE_MAX) invalid('Private notes are limited to 2000 characters.');
  return { ...base, sportPresetId, presetVersion: preset.version, units, bench, note: (payload.note as string).trim() };
}

export const saveLineup = command('saveLineup', normalizeLineup, async (tx, data, uid, _actor, replay) => {
  const { scope } = await coachingEvent(tx, data.eventId, data.teamId, uid, !replay);
  if (scope.orgId !== data.orgId) denied();
  if (replay) return replay;
  const ref = db().doc(`events/${data.eventId}/coaching/${data.teamId}`);
  const current = (await tx.get(ref)).data();
  checkRevision(current, data.expectedRevision);
  const roster = await rosterFor(tx, scope.orgId, data.teamId);
  const missing = referenced(data).filter(participantId => !roster.get(participantId)?.available);
  if (missing.length) unavailable(missing);
  const now = Timestamp.now();
  const next = (current?.revision ?? 0) + 1;
  const publication = current?.publication ?? privateState;
  tx.set(ref, {
    schemaVersion: 2, orgId: scope.orgId, programId: scope.programId, seasonId: scope.seasonId,
    eventId: data.eventId, teamId: data.teamId, sportPresetId: data.sportPresetId, presetVersion: data.presetVersion,
    units: data.units, bench: data.bench, publication, revision: next,
    createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? uid, updatedAt: now, updatedBy: uid,
  });
  // Notes live in a separate private document so no publication path can read them with the lineup.
  const note = ref.collection('notes').doc('lineup');
  if (data.note) {
    tx.set(note, { schemaVersion: 2, orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, text: data.note, authorUid: uid, editedAt: now });
  } else {
    tx.delete(note);
  }
  return { requestId: data.requestId, revision: next, state: publication.state };
});

export const publishLineup = command('publishLineup', data => {
  const { payload, base } = envelope(data, ['teamId', 'action']);
  if (!['publish', 'retract'].includes(payload.action)) invalid('Invalid publication action.');
  return { ...base, action: payload.action };
}, async (tx, data, uid, _actor, replay) => {
  const { scope } = await coachingEvent(tx, data.eventId, data.teamId, uid, !replay);
  if (scope.orgId !== data.orgId) denied();
  if (replay) return replay;
  const ref = db().doc(`events/${data.eventId}/coaching/${data.teamId}`);
  const view = db().doc(`events/${data.eventId}/lineupViews/${data.teamId}`);
  const current = (await tx.get(ref)).data();
  if (!current) {
    throw new HttpsError('failed-precondition', 'Save a lineup before publishing it.', { domainCode: 'LINEUP_NOT_SAVED' });
  }
  checkRevision(current, data.expectedRevision);
  const now = Timestamp.now();
  const next = current.revision + 1;
  const prior = current.publication ?? privateState;
  let publication: Data;
  if (data.action === 'publish') {
    const roster = await rosterFor(tx, scope.orgId, data.teamId);
    const missing = referenced(current).filter(participantId => !roster.get(participantId)?.available);
    if (missing.length) unavailable(missing);
    const name = (participantId: string) => roster.get(participantId)!.displayName;
    publication = { state: 'published', sourceRevision: next, publishedAt: now, publicationRevision: prior.publicationRevision + 1 };
    // Explicit allowlist: no notes, roster status, actor IDs or contact fields reach households.
    tx.set(view, {
      schemaVersion: 2, orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId,
      sportPresetId: current.sportPresetId, presetVersion: current.presetVersion,
      units: (current.units as Data[]).map(unit => ({
        unitId: unit.unitId,
        slots: (unit.slots as Data[]).map(slot => ({
          slotId: slot.slotId, participantId: slot.participantId, displayName: name(slot.participantId), x: slot.x, y: slot.y,
        })),
      })),
      bench: (current.bench as string[]).map(participantId => ({ participantId, displayName: name(participantId) })),
      publicationRevision: publication.publicationRevision, publishedAt: now,
    });
  } else {
    publication = { ...privateState, publicationRevision: prior.publicationRevision };
    tx.delete(view);
  }
  tx.update(ref, { publication, revision: next, updatedAt: now, updatedBy: uid });
  return { requestId: data.requestId, revision: next, state: publication.state };
});

function readScope(data: Data) {
  keys(data, ['eventId', 'teamId', 'participantId']);
  return {
    eventId: id(data.eventId, 'eventId'),
    teamId: id(data.teamId, 'teamId'),
    participantId: data.participantId == null ? null : id(data.participantId, 'participantId'),
  };
}

export const getLineup = readCommand(readScope, async (tx, data, uid) => {
  const { scope } = await coachingEvent(tx, data.eventId, data.teamId, uid, false);
  const ref = db().doc(`events/${data.eventId}/coaching/${data.teamId}`);
  const [lineupDoc, noteDoc] = await tx.getAll(ref, ref.collection('notes').doc('lineup'));
  const lineup = lineupDoc.data();
  const roster = await rosterFor(tx, scope.orgId, data.teamId);
  const used = referenced(lineup);
  const entries = [...roster.values()].filter(entry => entry.available || used.includes(entry.participantId));
  for (const participantId of used) {
    if (!roster.has(participantId)) entries.push({ participantId, displayName: 'Unavailable participant', available: false });
  }
  const publication = lineup?.publication ?? privateState;
  return {
    orgId: scope.orgId, eventId: data.eventId, teamId: data.teamId, revision: lineup?.revision ?? 0,
    sportPresetId: lineup?.sportPresetId ?? null, presetVersion: lineup?.presetVersion ?? null,
    units: lineup?.units ?? [], bench: lineup?.bench ?? [], note: noteDoc.data()?.text ?? '',
    roster: entries.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.participantId.localeCompare(b.participantId)),
    unavailableParticipantIds: used.filter(participantId => !roster.get(participantId)?.available),
    publication: { state: publication.state, sourceRevision: publication.sourceRevision, publishedAt: publication.publishedAt },
    updatedAt: lineup?.updatedAt ?? null,
  };
});

/** Relevant team viewers: active team members, scoped staff, or a household of an active rostered participant. */
/** Team viewers from a canonical event: active team members, scoped staff, or a household whose participant is rostered on the team. */
export async function teamViewer(tx: Transaction, eventId: string, teamId: string, participantId: string | null, uid: string) {
  const team = (await tx.get(db().doc(`teams/${teamId}`))).data();
  if (!team || team.schemaVersion !== 2) denied();
  const event = await canonicalEvent(tx, eventId, teamId, team!);
  const [member, staff] = await tx.getAll(
    db().doc(`teamMembers/${teamId}_${uid}`),
    db().doc(`organizations/${team!.orgId}/members/${uid}`),
  );
  const m = member.data();
  const s = staff.data();
  const allowed = (m?.status === 'active' && m.orgId === team!.orgId && m.teamId === teamId && m.userId === uid)
    || (s?.status === 'active' && s.orgId === team!.orgId && Array.isArray(s.roles) && Array.isArray(s.programIds)
      && (s.roles.includes('orgAdmin') || (s.roles.includes('programStaff') && s.programIds.includes(team!.programId))));
  if (!allowed) {
    if (!participantId) denied();
    await eligibleHousehold(tx, event, [{ ...team, id: teamId }], participantId!, uid);
  }
  return team!;
}

export const getLineupView = readCommand(readScope, async (tx, data, uid) => {
  await teamViewer(tx, data.eventId, data.teamId, data.participantId ?? null, uid);
  const view = (await tx.get(db().doc(`events/${data.eventId}/lineupViews/${data.teamId}`))).data();
  if (!view) return { state: 'unpublished' };
  return {
    state: 'published', sportPresetId: view.sportPresetId, presetVersion: view.presetVersion,
    units: view.units, bench: view.bench, publicationRevision: view.publicationRevision, publishedAt: view.publishedAt,
  };
});
