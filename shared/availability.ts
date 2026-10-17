export type AvailabilityStatus = "yes" | "no" | "maybe";
export type ParticipantAvailability = {
  participantId: string;
  displayName: string;
  relationship: "self" | "guardian";
  teams: { id: string; name: string }[];
  canRespond: boolean;
  closedReason: string | null;
  revision: number;
  status: AvailabilityStatus | "unanswered" | "needsReconfirmation";
  previousStatus: AvailabilityStatus | null;
  lateNote: string | null;
  scheduleVersion: number | null;
  updatedAt: string | null;
  actor: string | null;
};
export type EventAvailability = {
  eventId: string;
  canManage: boolean;
  eventRevision: number;
  scheduleVersion: number;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  deadline: string;
  items: ParticipantAvailability[];
  summaries: {
    teamId: string;
    teamName: string;
    counts: Record<ParticipantAvailability["status"], number>;
  }[];
};
