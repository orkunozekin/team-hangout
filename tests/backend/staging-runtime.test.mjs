import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function metadata(projectId) {
  const env = { ...process.env, GCLOUD_PROJECT: projectId };
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'FUNCTIONS_EMULATOR', 'FIREBASE_TOKEN']) delete env[key];
  const result = spawnSync(process.execPath, ['-e', `
    const functions = require('./functions/lib/index.js');
    const endpoints = Object.entries(functions).filter(([,fn]) => fn?.__endpoint).map(([name,fn]) => ({name, max:fn.__endpoint.maxInstances, min:fn.__endpoint.minInstances, concurrency:fn.__endpoint.concurrency}));
    console.log(JSON.stringify({endpoints, mailLoaded:!!require.cache[require.resolve('./functions/lib/email/worker.js')]}));
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('staging discovery bounds every export and never loads the email provider worker', () => {
  const result = metadata('team-hangout-staging');
  assert.equal(result.mailLoaded, false);
  for (const name of ['previewRecurrenceDraft', 'saveRecurrenceDraft', 'getRecurrenceDraft', 'generateScheduleDraft', 'saveScheduleDraft', 'validateScheduleDraft', 'getScheduleDraft', 'publishScheduleDraft', 'previewFacilityClosure', 'applyFacilityClosure', 'getFacilityClosureOperation', 'advanceFacilityClosure', 'previewEventMakeup', 'confirmEventMakeup', 'getEventAvailability', 'respondToEvent', 'setEventRsvpDeadline', 'getParticipantCheckIn', 'checkInParticipant', 'setEventCheckInPolicy', 'listNotifications', 'markNotificationRead', 'acknowledgeCriticalUpdate', 'registerPushDevice', 'revokePushDevice', 'resolveNotificationTarget', 'resumeNotificationInbox', 'listDeliveryDiagnostics', 'resumeRsvpReminders', 'postConversationMessage', 'listConversationMessages', 'setConversationPin', 'moderateConversationMessage', 'editConversationMessage', 'reactToConversationMessage', 'searchConversationMessages', 'postStaffNote', 'listStaffNotes', 'createAttachmentUpload', 'finalizeAttachment', 'attachmentTransport', 'purgeAttachmentQuarantine', 'listPilotOperations', 'applyPilotRollback', 'monitorPhase2Pilot', 'getLineup', 'saveLineup', 'publishLineup', 'getLineupView', 'recordPlayAction', 'finalizePlaySession', 'getPlaySession', 'saveCompetitionRules', 'proposeResult', 'finalizeResult', 'correctResult', 'listCompetitions', 'getCompetition', 'getEventResults']) assert.ok(result.endpoints.some(e => e.name === name));
  assert.equal(result.endpoints.length, 137);
  assert.equal(result.endpoints.some(e => e.name === 'resumeEssentialEmail'), false);
  for (const endpoint of result.endpoints) {
    assert.equal(endpoint.max, 2, endpoint.name);
    assert.equal(endpoint.min, 0, endpoint.name);
    assert.equal(endpoint.concurrency, 1, endpoint.name);
  }
});

test('other project discovery keeps the email worker and existing scaling defaults', () => {
  for (const project of ['demo-team-hangout', 'non-staging-project']) {
    const result = metadata(project);
    assert.equal(result.mailLoaded, true);
    assert.equal(result.endpoints.length, 138);
    assert.ok(result.endpoints.some(e => e.name === 'resumeEssentialEmail'));
    const agenda = result.endpoints.find(e => e.name === 'listHouseholdAgenda');
    assert.equal(agenda.max, null);
    assert.equal(agenda.min, null);
  }
});

test('Firestore index config uses the collection-group state override without redundant composites', () => {
  const config = JSON.parse(readFileSync('firestore.indexes.json', 'utf8'));
  const outboxState = config.fieldOverrides.find((override) => (
    override.collectionGroup === 'outbox' && override.fieldPath === 'state'
  ));
  assert.deepEqual(outboxState?.indexes, [{ order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' }]);

  const redundant = config.indexes.filter((index) => (
    index.fields.length === 2
    && index.fields[1].fieldPath === '__name__'
    && index.fields[0].order === index.fields[1].order
  ));
  assert.deepEqual(redundant, []);
});
