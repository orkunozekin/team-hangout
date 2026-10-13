import { initializeApp } from 'firebase-admin/app';

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

export { resumeEssentialEmail } from "./email/worker";
export { getPrivateEventInformation } from "./email/access";
export { listEssentialEmail, getEssentialEmailPreference, setEssentialEmailPreference } from "./email/commands";
