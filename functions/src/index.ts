import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { deleteAccount, resumeAccountDeletions } from './accounts/deletion';

export { createTeam, joinTeamWithInvite, regenerateInvite, renameTeam, createEvent, updateEvent, softDeleteEvent } from './commands';

export { createOrganization, saveHierarchyEntity, saveTeam, setStaffAssignment, archiveSeason, listMyOrganizations, listOrganizationHierarchy, listLegacyTeams, getAdminWorkspace, listOrganizationStaff } from './organizations/commands';

export { saveParticipant, saveParticipantPrivateProfile, approveSelfLink, approveGuardian, revokeGuardian, setRosterEnrollment, getParticipantProfile, editParticipantProfile, listRoster } from './participants/commands';
export { listMyParticipants } from './participants/policy';
