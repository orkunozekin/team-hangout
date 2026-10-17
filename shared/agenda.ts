/** JSON-only v2 calendar contract. No private profile fields or unrelated team IDs. */
export type ParticipantRef = { orgId: string; participantId: string };
export type AgendaParticipant = ParticipantRef & { displayName: string };
export type AgendaTeam = {
  id: string;
  orgId: string;
  organizationName: string;
  name: string;
  seasonId: string;
  seasonName: string;
  seasonStatus: "draft" | "active" | "archived";
  archived: boolean;
  participants: AgendaParticipant[];
};
export type AgendaEvent = {
  status?: "scheduled" | "postponed" | "cancelled" | "completed";
  scheduleVersion?: number;
  id: string;
  orgId: string;
  title: string;
  type: "practice" | "match";
  startsAt: string;
  endsAt: string;
  timeZone: string;
  location: { name: string; address?: string } | null;
  teams: AgendaTeam[];
  participants: AgendaParticipant[];
};
export type AgendaRequest = {
  from: string;
  to: string;
  participantRefs?: ParticipantRef[];
  teamIds?: string[];
  orgIds?: string[];
  seasonRefs?: { orgId: string; seasonId: string }[];
  eventTypes?: ("practice" | "match")[];
  includeArchived?: boolean;
  cursor?: string;
  pageSize?: number;
};
export type AgendaPage = {
  items: AgendaEvent[];
  nextCursor: string | null;
  teams: AgendaTeam[];
  setupRequired: boolean;
  accessVersion: string;
};
