/** Pure callable JSON contracts shared by the browser and native clients. */
export type Participant = {
  id: string;
  displayName: string;
  kind: "youth" | "adult" | "unknown";
  status: "active" | "archived";
  revision: number;
};
export type HouseholdParticipant = Participant & {
  orgId: string;
  organizationName: string;
  relationship: "self" | "guardian";
};
export type ParticipantProfile = {
  participant: Participant;
  profile: {
    revision: number;
    birthDate?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    guardianContactDetails?: string | null;
    operationalNotes?: string | null;
  } | null;
  guardians: {
    displayName: string;
    isYou: boolean;
    userId?: string;
    permissions?: GuardianPermissions;
  }[];
  relationship: "self" | "guardian" | "staff";
  canEdit: boolean;
};
export type GuardianPermissions = {
  viewSchedule: boolean;
  viewProfile: boolean;
  editProfile: boolean;
  respond: boolean;
};
export type RosterEntry = {
  participantId: string;
  displayName: string;
  jerseyNumber: string | null;
  status: "active" | "removed";
  revision: number;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Identity = { orgId: string; participantId: string };
type Command = { requestId: string; expectedRevision: number };
export type ParticipantCommands = {
  listOrganizationParticipants: {
    input: { orgId: string; cursor?: string };
    output: Page<Participant>;
  };
  listMyParticipants: {
    input: { cursor?: string };
    output: Page<HouseholdParticipant>;
  };
  getParticipantProfile: {
    input: Identity & { staffPrivate?: boolean };
    output: ParticipantProfile;
  };
  listRoster: {
    input: {
      orgId: string;
      teamId: string;
      cursor?: string;
      includeRemoved?: boolean;
    };
    output: Page<RosterEntry>;
  };
  saveParticipant: {
    input: Command & {
      orgId: string;
      participantId?: string;
      fields: Pick<Participant, "displayName" | "kind" | "status">;
    };
    output: { participant: Participant };
  };
  saveParticipantPrivateProfile: {
    input: Command &
      Identity & {
        fields: NonNullable<ParticipantProfile["profile"]> extends infer P
          ? Omit<P, "revision">
          : never;
      };
    output: { revision: number };
  };
  editParticipantProfile: {
    input: Command &
      Identity & {
        fields: { contactEmail: string | null; contactPhone: string | null };
      };
    output: { revision: number };
  };
  setRosterEnrollment: {
    input: Command &
      Identity & {
        teamId: string;
        status: "active" | "removed";
        jerseyNumber?: string | null;
      };
    output: { participantRevision: number };
  };
  approveGuardian: {
    input: Command &
      Identity & { userId: string; permissions?: GuardianPermissions };
    output: { participantRevision: number };
  };
  revokeGuardian: {
    input: Command & Identity & { userId: string };
    output: { participantRevision: number };
  };
};
