import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore as clientDb, connectFirestoreEmulator, doc, getDoc, setDoc } from 'firebase/firestore';
import { projectId, requireEmulators, operationalEventFields } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
requireEmulators();
let admin, db, seq = 0; const apps = {};
const orgId = 'p208-org', scope = { orgId, programId: 'p208-program', seasonId: 'p208-season', divisionId: 'p208-division' };
const meta = { schemaVersion: 2, revision: 1, status: 'active' };
const at = (day, hour = 0, minute = 0) => `2035-01-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00.000Z`;
const req = p => ({ requestId: `p208-${++seq}`, ...p });
const call = async (name, p, uid = 'p208-owner') => (await httpsCallable(getFunctions(apps[uid]), name)(p)).data;
const code = (p, domain) => assert.rejects(p, e => e.details?.domainCode === domain);
const deny = p => assert.rejects(p, { code: 'functions/permission-denied' });
async function fixture(extra = {}, count = 1) {
  const f = `facility-${++seq}`;
  await db.doc(`organizations/${orgId}/facilities/${f}`).set({ ...meta, orgId, name: 'Cedar Park', address: 'Synthetic street', timeZone: 'UTC', latitude: null, longitude: null, parking: null, accessibility: null });
  for (let i = 0; i < count; i++) {
    await db.doc(`organizations/${orgId}/facilities/${f}/resources/r${i}`).set({ ...meta, orgId, facilityId: f, label: `Field ${i+1}`, sports: ['soccer'], setupMinutes: 15, cleanupMinutes: 10 });
    await db.doc(`organizations/${orgId}/facilities/${f}/resources/r${i}/availability/1`).set({ schemaVersion: 2, orgId, facilityId: f, resourceId: `r${i}`, revision: 1, effectiveFrom: at(1), windows: [{ startsAt: at(1), endsAt: at(31,23) }] });
  }
  const created = await call('createEvent', req({ teamId: 'p208-a', event: { ...operationalEventFields, title: 'Falcons vs Comets', type: 'match', teamIds: ['p208-a','p208-b'], publicationState: 'published', startsAt: at(2,23), endsAt: at(3), facilityId: f, resourceId: 'r0', ...extra } }));
  return { f, event: created };
}
const preview = (f, more = {}, uid) => call('previewFacilityClosure', req({ orgId, facilityId: f, resourceIds: null, startsAt: at(3), endsAt: at(3,2), reason: 'Staff reviewed unsafe field', ...more }), uid);
const apply = (p, more = {}) => call('applyFacilityClosure', req({ orgId, previewId: p.previewId, previewHash: p.previewHash, confirmed: true, ...more }));
const advance = (o, action = 'advance', more = {}) => call('advanceFacilityClosure', req({ orgId, operationId: o.operationId, expectedRevision: o.revision, fencingToken: o.fencingToken, action, ...more }));
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['p208-owner','p208-staff','p208-guardian','p208-coach','p208-outsider','p208-support']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001); connectFirestoreEmulator(clientDb(app), '127.0.0.1', 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'p208-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc(`organizations/${orgId}`).set({ ...meta, name: 'League', timeZone: 'UTC', features: { organizationV2: true, households: true, adminWorkspace: true, scheduler: true } });
  for (const [kind, name] of [['programs','p208-program'],['seasons','p208-season'],['divisions','p208-division']]) await db.doc(`organizations/${orgId}/${kind}/${name}`).set({ ...meta, ...scope, name, sportCode: 'soccer', timeZone: 'UTC', startsOn: '2035-01-01', endsOn: '2035-01-31' });
  await db.doc(`organizations/${orgId}/members/p208-owner`).set({ ...meta, orgId, roles: ['orgAdmin'], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p208-staff`).set({ ...meta, orgId, roles: ['programStaff'], programIds: ['p208-program'] });
  for (const [id, name] of [['p208-a','Falcons'],['p208-b','Comets'],['p208-c','Owls']]) await db.doc(`teams/${id}`).set({ ...meta, ...scope, name, sport: 'soccer' });
  for (const t of ['p208-a', 'p208-c']) await db.doc(`teamMembers/${t}_p208-coach`).set({ ...meta, orgId, teamId: t, userId: 'p208-coach', roles: ['coach'] });
  await db.doc(`organizations/${orgId}/participants/child`).set({ ...meta, orgId, displayName: 'Synthetic child' });
  await db.doc(`organizations/${orgId}/participants/child/guardians/p208-guardian`).set({ ...meta, orgId, participantId: 'child', userId: 'p208-guardian', permissions: { viewSchedule: true, respond: false } });
  await db.doc('teams/p208-a/roster/child').set({ ...meta, orgId, participantId: 'child' });
});
beforeEach(async () => { await db.doc(`organizations/${orgId}/schedulingLock/current`).set({ operationId: null }, { merge: true }); });
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
test('closure is immediate across midnight and buffers, preserves family history, and blocks actions before materialization', async () => {
  const { f, event } = await fixture(), p = await preview(f);
  assert.equal(p.impacted.length, 1); assert.deepEqual(p.impacted[0].teamNames, ['Falcons','Comets']);
  const adjacent = await preview(f, { startsAt: at(3,0,10), endsAt: at(3,1) }); assert.equal(adjacent.impacted.length, 0);
  const operation = await apply(p);
  assert.equal((await db.doc(`events/${event.id}`).get()).data().status, 'scheduled');
  const family = await call('getCanonicalEvent', { eventId: event.id }, 'p208-guardian');
  assert.equal(family.status, 'postponed'); assert.equal(family.closureUpdatePending, true); assert.equal(family.notes, undefined);
  assert.equal((await call('listCanonicalTeamEvents', { teamId: 'p208-a' }, 'p208-guardian')).items.find(e => e.id === event.id).status, 'postponed');
  const { readAgenda } = require('./lib/calendar/agenda');
  const agenda = await call('listHouseholdAgenda', { from: at(2), to: at(4) }, 'p208-guardian');
  assert.equal(agenda.items.find(e => e.id === event.id).status, 'postponed');
  const feed = await db.runTransaction(tx => readAgenda(tx, { from: at(2), to: at(4), pageSize: 50, includeArchived: false, cursor: null, participantRefs: [], seasonRefs: [], teamIds: [], orgIds: [], eventTypes: [] }, 'p208-guardian', { scheduledOnly: true }));
  assert.ok(!feed.items.some(e => e.id === event.id));
  await deny(call('getPrivateEventInformation', { eventId: event.id }, 'p208-outsider'));
  await code(call('getPrivateEventInformation', { eventId: event.id }, 'p208-guardian'), 'RESOURCE_CLOSED');
  await code(call('mutateEventSchedule', req({ eventId: event.id, expectedRevision: 1, action: 'complete', reason: 'Unsafe' })), 'RESOURCE_CLOSED');
  const done = await advance(operation); assert.equal(done.postponed, 1); assert.equal(done.state, 'committed');
  const stored = (await db.doc(`events/${event.id}`).get()).data();
  assert.equal(stored.status, 'postponed'); assert.equal(stored.deletedAt, null);
  const materialized = await call('getCanonicalEvent', { eventId: event.id }, 'p208-guardian');
  assert.equal(materialized.resourceClosed, true); assert.equal(materialized.closureUpdatePending, false);
  assert.equal(done.expiresAt, (await db.doc(`organizations/${orgId}/schedulingLock/current`).get()).data().expiresAt.toDate().toISOString()); assert.equal(stored.publicationOperationId, null);
  assert.equal((await db.collection(`events/${event.id}/scheduleHistory`).get()).size, 1);
  assert.equal((await db.collection(`events/${event.id}/resourceHistory`).get()).size, 2);
  await code(call('createEvent', req({ teamId: 'p208-a', event: { ...operationalEventFields, teamIds: ['p208-a'], publicationState: 'published', startsAt: at(3), endsAt: at(3,1), facilityId: f, resourceId: 'r0' } })), 'RESOURCE_CLOSED');
});
test('stale preview, concurrent staff edit, explicit confirmation and single apply are enforced', async () => {
  const { f, event } = await fixture(), p = await preview(f);
  await call('mutateEventSchedule', req({ eventId: event.id, expectedRevision: 1, action: 'edit', patch: { title: 'Changed by staff' }, reason: 'Correction' }));
  await code(apply(p), 'STALE_PREVIEW');
  const fresh = await preview(f); await assert.rejects(apply(fresh, { confirmed: false }), { code: 'functions/invalid-argument' });
  const results = await Promise.allSettled([apply(fresh), call('mutateEventSchedule', req({ eventId: event.id, expectedRevision: 2, action: 'edit', patch: { title: 'Concurrent staff edit' }, reason: 'Correction' }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  if (results[0].status === 'fulfilled') await advance(results[0].value); else await code(apply(fresh), 'STALE_PREVIEW');
});
test('one whole-facility closure resolves more than fifty resources without truncation or same-ID foreign facility leakage', async () => {
  const { f } = await fixture({}, 55), other = await fixture();
  const p = await preview(f); assert.equal(p.resourceIds.length, 55); assert.equal(p.impacted.length, 1);
  const o = await apply(p); await advance(o);
  assert.equal((await call('getCanonicalEvent', { eventId: other.event.id })).status, 'scheduled');
  await assert.rejects(preview(f, { resourceIds: ['foreign'] }), { code: 'functions/permission-denied' });
});
test('failed event transaction and lost response recover with fencing, exact replay, no duplicate history or outbox', async () => {
  const { f, event } = await fixture();
  const second = await call('createEvent', req({ teamId: 'p208-a', event: { ...operationalEventFields, teamIds: ['p208-a'], publicationState: 'published', startsAt: at(3,1), endsAt: at(3,2), facilityId: f, resourceId: 'r0' } }));
  const p = await preview(f, { endsAt: at(3,3) }), payload = req({ orgId, previewId: p.previewId, previewHash: p.previewHash, confirmed: true });
  let o = await call('applyFacilityClosure', payload);
  await code(call('mutateEventSchedule', req({ eventId: event.id, expectedRevision: 1, action: 'cancel', reason: 'Competing edit' })), 'SCHEDULING_BUSY');
  const damagedId = p.impacted[0].eventId;
  await db.doc(`events/${damagedId}/scheduleHistory/2`).set({ injected: 'conflicting write simulates failed chunk' });
  await assert.rejects(advance(o));
  assert.equal((await call('getFacilityClosureOperation', { orgId, operationId: o.operationId })).cursor, 0);
  assert.equal((await db.doc(`events/${damagedId}`).get()).data().status, 'scheduled');
  await db.doc(`events/${damagedId}/scheduleHistory/2`).delete();
  await db.doc(`organizations/${orgId}/schedulingLock/current`).update({ expiresAt: Timestamp.fromMillis(0) });
  await code(advance(o), 'LEASE_EXPIRED'); const old = o; o = await advance(o, 'resume');
  await code(advance(old), 'STALE_REVISION');
  const advancePayload = req({ orgId, operationId: o.operationId, expectedRevision: o.revision, fencingToken: o.fencingToken, action: 'advance' });
  o = await call('advanceFacilityClosure', advancePayload); // discard a successful response, then retry its exact payload
  assert.deepEqual(await call('advanceFacilityClosure', advancePayload), o);
  assert.equal((await call('applyFacilityClosure', payload)).cursor, 1);
  o = await advance(o); assert.equal(o.state, 'committed'); assert.equal(o.postponed, 2);
  for (const e of [event, second]) assert.equal((await db.collection(`events/${e.id}/scheduleHistory`).get()).size, 1);
  const intents = await db.collection(`organizations/${orgId}/outbox`).where('operationId','==',o.operationId).get(); assert.equal(intents.size, 3);
  assert.equal((await db.collection(`organizations/${orgId}/deliveries`).get()).size, 0);
});
test('changed canonical event is explicitly reconciled without overwrite and closure remains effective', async () => {
  const { f, event } = await fixture(), p = await preview(f), o = await apply(p);
  await db.doc(`events/${event.id}`).update({ revision: 2, title: 'Trusted maintenance edit' });
  const done = await advance(o); assert.deepEqual(done.mismatches, [event.id]); assert.equal(done.postponed, 0);
  const stored = (await db.doc(`events/${event.id}`).get()).data(); assert.equal(stored.title, 'Trusted maintenance edit'); assert.equal(stored.revision, 2);
  assert.equal((await call('getCanonicalEvent', { eventId: event.id })).status, 'postponed');
});
test('live access, revocation, cross-tenant denial, deleting accounts and server-only rules protect previews and recovery', async () => {
  const { f } = await fixture();
  for (const u of ['p208-staff','p208-coach','p208-guardian','p208-support','p208-outsider']) await deny(preview(f, {}, u));
  await deny(preview(f, { orgId: 'foreign' }));
  const p = await preview(f), payload = req({ orgId, previewId: p.previewId, previewHash: p.previewHash, confirmed: true }), o = await call('applyFacilityClosure', payload);
  await db.doc(`organizations/${orgId}/members/p208-owner`).update({ status: 'revoked' });
  await deny(call('applyFacilityClosure', payload)); await deny(advance(o)); await deny(call('getFacilityClosureOperation', { orgId, operationId: o.operationId }));
  await db.doc(`organizations/${orgId}/members/p208-owner`).update({ status: 'active' });
  await db.doc('users/p208-owner').update({ accountState: 'deleting' }); await deny(advance(o)); await db.doc('users/p208-owner').update({ accountState: 'active' });
  await advance(o);
  for (const path of [`organizations/${orgId}/closures/${p.previewId}`,`organizations/${orgId}/closurePreviews/${p.previewId}`,`organizations/${orgId}/scheduleOperations/${o.operationId}`]) {
    await assert.rejects(getDoc(doc(clientDb(apps['p208-owner']),path)), { code: 'permission-denied' });
    await assert.rejects(setDoc(doc(clientDb(apps['p208-owner']),path),{ status:'cancelled' },{ merge:true }), { code: 'permission-denied' });
  }
});
test('reviewed makeups revalidate current resources, closure buffers, team and coach conflicts, revision, replay and identity', async () => {
  const { f, event } = await fixture(), p = await preview(f), o = await apply(p); await advance(o);
  const input = () => req({ orgId, eventId: event.id, expectedRevision: 2, patch: { facilityId:f, resourceId:'r0', startsAt:at(8,12), endsAt:at(8,13), timeZone:'UTC' }, reason:'Staff reviewed makeup' });
  await code(call('previewEventMakeup', { ...input(), patch:{ ...input().patch, startsAt:at(3,1), endsAt:at(3,2) } }), 'RESOURCE_CLOSED');
  const proposed = await call('previewEventMakeup', input());
  await call('saveFacilityResource', req({ orgId, facilityId:f, resourceId:'r0', expectedRevision:1, fields:{ label:'Field renamed', sports:['soccer'], setupMinutes:15, cleanupMinutes:10, status:'active' } }));
  const confirm = p => req({ orgId, previewId:p.previewId, previewHash:p.previewHash, confirmed:true });
  await code(call('confirmEventMakeup', confirm(proposed)), 'STALE_PREVIEW');
  const fresh = await call('previewEventMakeup', input());
  const conflict = await call('createEvent', req({ teamId:'p208-c', event:{ ...operationalEventFields, teamIds:['p208-c'], publicationState:'published', startsAt:at(8,12), endsAt:at(8,13) } }));
  await code(call('confirmEventMakeup', confirm(fresh)), 'SCHEDULE_CONFLICT');
  await call('mutateEventSchedule', req({ eventId:conflict.id, expectedRevision:1, action:'cancel', reason:'Remove coach conflict' }));
  const final = await call('previewEventMakeup', input(), 'p208-staff'), payload = confirm(final);
  await assert.rejects(call('confirmEventMakeup', { ...payload, confirmed:false }), { code:'functions/invalid-argument' });
  const moved = await call('confirmEventMakeup', payload, 'p208-staff'); assert.equal(moved.id,event.id); assert.equal(moved.revision,3);
  assert.deepEqual(await call('confirmEventMakeup', payload, 'p208-staff'),moved);
  const stored = (await db.doc(`events/${event.id}`).get()).data(); assert.equal(stored.status,'scheduled'); assert.equal(stored.scheduleVersion,2); assert.equal(stored.rescheduledFromRevision,2);
  assert.equal(stored.originalInterval.startsAt.toDate().toISOString(),at(2,23)); assert.equal((await db.collection(`events/${event.id}/scheduleHistory`).get()).size,2);
  await db.doc(`organizations/${orgId}/members/p208-staff`).update({ programIds:[] }); await deny(call('confirmEventMakeup',payload,'p208-staff'));
  await db.doc(`organizations/${orgId}/members/p208-staff`).update({ programIds:['p208-program'] });
});
test('publication makeups preserve reviewed duration, blackouts and team rest policy', async () => {
  const { f, event } = await fixture();
  await db.doc(`events/${event.id}`).update({ publicationOperationId:'p208-policy' });
  await db.doc(`organizations/${orgId}/scheduleOperations/p208-policy`).set({ schemaVersion:2, orgId, state:'committed', action:'publishScheduleDraft', draftId:'p208-policy-draft' });
  await db.doc(`organizations/${orgId}/scheduleDrafts/p208-policy-draft`).set({ schemaVersion:2, orgId, fields:{ durationMinutes:60, minimumRestMinutes:120, teamConstraints:[{ teamId:'p208-a', blackouts:[{ startsAt:at(10), endsAt:at(11) }] }] } });
  await advance(await apply(await preview(f)));
  const proposed = (start,end) => req({ orgId, eventId:event.id, expectedRevision:2, patch:{ startsAt:start, endsAt:end, timeZone:'UTC', facilityId:f, resourceId:'r0' }, reason:'Reviewed policy makeup' });
  await assert.rejects(call('previewEventMakeup',proposed(at(12,12),at(12,12,30))),{ code:'functions/invalid-argument' });
  await code(call('previewEventMakeup',proposed(at(10,12),at(10,13))),'SCHEDULE_CONFLICT');
  await call('createEvent',req({ teamId:'p208-a', event:{ ...operationalEventFields, teamIds:['p208-a'], publicationState:'published', startsAt:at(12,15), endsAt:at(12,16) } }));
  await code(call('previewEventMakeup',proposed(at(12,13),at(12,14))),'SCHEDULE_CONFLICT');
  assert.ok((await call('previewEventMakeup',proposed(at(12,12),at(12,13)))).previewId);
});
test('makeup confirmation serializes on the publication fence and increments the shared input revision exactly once', async () => {
  const { f, event } = await fixture(), closure = await apply(await preview(f)); await advance(closure);
  const p = await call('previewEventMakeup', req({ orgId, eventId:event.id, expectedRevision:2, patch:{ startsAt:at(25,12), endsAt:at(25,13), timeZone:'UTC', facilityId:f, resourceId:'r0' }, reason:'Reviewed makeup' }));
  const payload = req({ orgId, previewId:p.previewId, previewHash:p.previewHash, confirmed:true });
  const lock = db.doc(`organizations/${orgId}/schedulingLock/current`), before = (await lock.get()).data();
  await lock.update({ operationId:'publication-in-progress' });
  await code(call('confirmEventMakeup',payload),'SCHEDULING_BUSY');
  assert.equal((await db.doc(`events/${event.id}`).get()).data().revision,2);
  await lock.update({ operationId:null });
  const concurrent = await Promise.all([call('confirmEventMakeup',payload), call('confirmEventMakeup',payload)]);
  assert.deepEqual(concurrent[0],concurrent[1]); assert.equal((await lock.get()).data().inputRevision,before.inputRevision+1);
  await call('confirmEventMakeup',payload); assert.equal((await lock.get()).data().inputRevision,before.inputRevision+1);
});
test('retained facility history and unrelated coaches do not disable current reads, closure review or makeups', async () => {
  const { f, event } = await fixture(), stored = (await db.doc(`events/${event.id}`).get()).data();
  let batch = db.batch(), writes = 0;
  const put = async (ref, value) => { batch.set(ref,value); if (++writes === 400) { await batch.commit(); batch=db.batch(); writes=0; } };
  for (let i=0;i<1001;i++) {
    await put(db.doc(`organizations/${orgId}/closures/history-${f}-${i}`),{ schemaVersion:2, orgId, facilityId:f, resourceIds:['r0'], status:'applied', startsAt:'2020-01-01T00:00:00.000Z', endsAt:'2020-01-02T00:00:00.000Z' });
    await put(db.doc(`organizations/${orgId}/closures/cancelled-${f}-${i}`),{ schemaVersion:2, orgId, facilityId:f, resourceIds:['r0'], status:'cancelled', startsAt:at(2), endsAt:at(4) });
    await put(db.doc(`events/p208-history-${f}-${i}`),{ ...stored, teamId:'p208-c', teamIds:['p208-c'], type:'practice', homeTeamId:null, awayTeamId:null,
      startsAt:Timestamp.fromDate(new Date('2020-01-01T00:00:00.000Z')),endsAt:Timestamp.fromDate(new Date('2020-01-01T01:00:00.000Z')),
      resourceOccupancy:{ ...stored.resourceOccupancy,startsAt:Timestamp.fromDate(new Date('2019-12-31T23:45:00.000Z')),endsAt:Timestamp.fromDate(new Date('2020-01-01T01:10:00.000Z')) },
      status:['scheduled','completed','cancelled'][i%3],publicationState:i%2?'published':'staged',deletedAt:i%3===0?Timestamp.now():null });
    await put(db.doc(`teamMembers/p208-c_unrelated-${i}`),{ ...meta,orgId,teamId:'p208-c',userId:`unrelated-${i}`,roles:['coach'] });
  }
  if(writes) await batch.commit();
  const transact=db.runTransaction.bind(db);
  async function instrument(handler,data) {
    const reads={};
    db.runTransaction=(callback,options)=>transact(tx=>callback(new Proxy(tx,{get(target,name){
      if(name==='get') return async ref=>{const result=await target.get(ref),kind=ref._queryOptions?.collectionId; if(kind){const count=reads[kind]??={queries:0,documents:0};count.queries++;count.documents+=result.size;}return result;};
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
    }})),options);
    try { return { result:await handler.run({data,auth:{uid:'p208-owner'}}),reads }; }
    finally {db.runTransaction=transact;}
  }
  const {getCanonicalEvent}=require('./lib/operations/events'), {previewFacilityClosure}=require('./lib/facilities/closures'), {previewEventMakeup}=require('./lib/facilities/makeups');
  const detail=await instrument(getCanonicalEvent,{eventId:event.id});assert.equal(detail.result.status,'scheduled');assert.equal(detail.reads.closures.documents,0);
  const reviewed=await instrument(previewFacilityClosure,req({orgId,facilityId:f,resourceIds:null,startsAt:at(3),endsAt:at(3,2),reason:'Reviewed current window'}));
  assert.equal(reviewed.result.impacted.length,1);assert.equal(reviewed.reads.events.documents,1);
  await advance(await apply(reviewed.result));
  const proposal=req({orgId,eventId:event.id,expectedRevision:2,patch:{startsAt:at(28,12),endsAt:at(28,13),timeZone:'UTC',facilityId:f,resourceId:'r0'},reason:'Reviewed makeup'});
  const makeup=await instrument(previewEventMakeup,proposal);assert.ok(makeup.result.previewId);assert.equal(makeup.reads.teamMembers.documents,1);
  const moved=await call('confirmEventMakeup',req({orgId,previewId:makeup.result.previewId,previewHash:makeup.result.previewHash,confirmed:true}));assert.equal(moved.id,event.id);
});
test('real fifty-event reads share one facility closure scan and refresh across transactions and revoked grants', async () => {
  const { f, event } = await fixture(), base = (await db.doc(`events/${event.id}`).get()).data();
  const batch = db.batch();
  for (let i = 0; i < 50; i++) batch.set(db.doc(`events/p208-cache-${i}`), { ...base, startsAt: Timestamp.fromMillis(Date.parse(at(1,1)) + i*60000), endsAt: Timestamp.fromMillis(Date.parse(at(1,2)) + i*60000), resourceOccupancy: { ...base.resourceOccupancy, startsAt: Timestamp.fromMillis(Date.parse(at(1,0,45)) + i*60000), endsAt: Timestamp.fromMillis(Date.parse(at(1,2,10)) + i*60000) } });
  await batch.commit();
  const { listCanonicalTeamEvents } = require('./lib/operations/events');
  const transact = db.runTransaction.bind(db); let closureQueries = 0;
  db.runTransaction = (callback, options) => transact(tx => callback(new Proxy(tx, { get(target, name) {
    if (name === 'get') return ref => { if (ref._queryOptions?.collectionId === 'closures') closureQueries++; return target.get(ref); };
    const value = Reflect.get(target,name); return typeof value === 'function' ? value.bind(target) : value;
  } })), options);
  let result;
  try { result = await listCanonicalTeamEvents.run({ data:{ teamId:'p208-a', pageSize:50 }, auth:{ uid:'p208-guardian' } }); }
  finally { db.runTransaction = transact; }
  assert.equal(result.items.length,50); assert.equal(closureQueries,1); assert.ok(result.items.every(e => e.status === 'scheduled'));
  await db.doc(`organizations/${orgId}/closures/cache-fresh`).set({ schemaVersion:2, orgId, facilityId:f, resourceIds:['r0'], status:'applied', startsAt:at(1), endsAt:at(1,3) });
  const fresh = await call('listCanonicalTeamEvents',{ teamId:'p208-a',pageSize:50 },'p208-guardian'); assert.ok(fresh.items.every(e => e.status === 'postponed'));
  await db.doc(`organizations/${orgId}/participants/child/guardians/p208-guardian`).update({ status:'revoked' });
  await deny(call('listCanonicalTeamEvents',{ teamId:'p208-a',pageSize:50 },'p208-guardian'));
});
