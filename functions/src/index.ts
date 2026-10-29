import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';

// Bound the isolated staging project without changing production resource settings.
if (process.env.GCLOUD_PROJECT === 'team-hangout-staging') {
  setGlobalOptions({ region: 'us-central1', minInstances: 0, maxInstances: 2, concurrency: 1 });
}

initializeApp();

export { deleteAccount, resumeAccountDeletions } from './accounts/deletion';

export { createTeam, joinTeamWithInvite, regenerateInvite, renameTeam, createEvent, updateEvent, softDeleteEvent } from './commands';

export { createOrganization, saveHierarchyEntity, saveTeam, setStaffAssignment, archiveSeason, listMyOrganizations, listOrganizationHierarchy, listLegacyTeams, getAdminWorkspace, listOrganizationStaff } from './organizations/commands';

export { saveParticipant, saveParticipantPrivateProfile, approveSelfLink, approveGuardian, revokeGuardian, setRosterEnrollment, getParticipantProfile, editParticipantProfile, listRoster, listOrganizationParticipants } from './participants/commands';
export { listMyParticipants } from './participants/policy';

export { createInvitation, resendInvitation, revokeInvitation, listInvitations, inspectInvitation, acceptInvitation } from './invitations/commands';

export { listHouseholdAgenda } from './calendar/agenda';

export { createCalendarSubscription, listCalendarSubscriptions, revokeCalendarSubscription, rotateCalendarSubscription, calendarSubscriptionOptions, calendarFeed } from './calendar/subscriptions';

export { uploadRosterImport, getRosterImport, resolveRosterImportRow, commitRosterImport, refreshRosterImport, processRosterImports, resumeRosterImports, expireRosterImports } from './imports/roster';

export { uploadScheduleImport, getScheduleImport, resolveScheduleImportRow, commitScheduleImport, refreshScheduleImport } from "./imports/roster";
export { prepareSchedulePublication, publishScheduleImport } from "./imports/publication";

// Do not register provider secrets or a sending schedule in isolated staging.
export const resumeEssentialEmail: typeof import('./email/worker').resumeEssentialEmail | undefined =
  process.env.GCLOUD_PROJECT === 'team-hangout-staging'
    ? undefined
    : require('./email/worker').resumeEssentialEmail;
export { getPrivateEventInformation } from "./email/access";
export { listEssentialEmail, getEssentialEmailPreference, setEssentialEmailPreference } from "./email/commands";

export { getNativeTeam, listEventTeamChoices, listCanonicalTeamEvents, getCanonicalEvent, mutateEventSchedule } from './operations/events';

export { listFacilities, listFacilityResources, saveFacility, saveFacilityResource, listResourceAvailability, appendResourceAvailability } from './facilities/service';

export { previewRecurrenceDraft, saveRecurrenceDraft, getRecurrenceDraft } from './recurrence/service';

export { generateScheduleDraft, saveScheduleDraft, validateScheduleDraft, getScheduleDraft } from './scheduling/drafts';

export { publishScheduleDraft, getSchedulePublication, advanceSchedulePublication } from './scheduling/publication';

export { previewFacilityClosure, applyFacilityClosure, getFacilityClosureOperation, advanceFacilityClosure } from './facilities/closures';
export { previewEventMakeup, confirmEventMakeup } from './facilities/makeups';

export { getEventAvailability, respondToEvent, setEventRsvpDeadline } from './operations/availability';

export { getEventAttendance, recordEventAttendance, getAttendanceHistory } from './operations/attendance';

export { getParticipantCheckIn, checkInParticipant, setEventCheckInPolicy } from "./operations/checkIn";
export { listNotifications, markNotificationRead, acknowledgeCriticalUpdate, registerPushDevice, revokePushDevice, resolveNotificationTarget } from './notifications/commands';
export { listDeliveryDiagnostics } from './notifications/diagnostics';
export { listPilotOperations, applyPilotRollback } from './operations/pilot';
export { monitorPhase2Pilot } from './operations/monitoring';
export { monitorPhase3Pilot } from './operations/phase3Monitoring';
export { postConversationMessage, listConversationMessages, setConversationPin, moderateConversationMessage, editConversationMessage, reactToConversationMessage, searchConversationMessages, postStaffNote, listStaffNotes } from './communications/conversations';
export { createAttachmentUpload, finalizeAttachment, attachmentTransport, purgeAttachmentQuarantine } from './communications/attachments';
export { resumeNotificationInbox } from './notifications/worker';
export { resumeRsvpReminders } from './notifications/reminders';
export { getLineup, saveLineup, publishLineup, getLineupView } from './coaching/lineups';
export { recordPlayAction, finalizePlaySession, getPlaySession } from './coaching/playTime';
export { saveCompetitionRules, proposeResult, finalizeResult, correctResult, listCompetitions, getCompetition, getEventResults } from './competition/results';
export { rebuildStandings, reconcileStandings, getStandings, getEventStandings } from './competition/generations';
export { previewBracket, publishBracket, linkBracketEvent, getBracket, getEventBracket, previewBracketCorrection, correctBracket } from './competition/brackets';
export { saveVolunteerSlot, claimVolunteerSlot, releaseVolunteerSlot, getEventVolunteers } from './volunteers/slots';
export { requestReport, rebuildReport, getReportRun, exportReport, listReportRuns, runReport, reconcileReports, reportScheduleChanged, reportResourceChanged, reportAttendanceChanged, reportClosureChanged, reportAvailabilityChanged } from './reports/runs';
export { savePracticeResource, publishPracticeResource, listPracticeResources, getPracticeResource, savePracticePlan, getEventPracticePlan } from './resources/practice';
export { previewRollover, commitRollover, resumeRollover, listRolloverJobs, runRollover, reconcileRollovers } from './seasons/rollover';
export { saveRideRequest, confirmRideArrangement, revokeRideConsent, getEventRides, getRideContacts } from './volunteers/rides';
