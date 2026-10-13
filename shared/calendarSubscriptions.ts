import type { AgendaTeam, ParticipantRef } from "./agenda";
export type CalendarScope = {
  teamIds: string[];
  participantRefs: ParticipantRef[];
  eventTypes: ("practice" | "match")[];
  includeParticipantNames?: boolean;
};
export type CalendarSubscription = {
  id: string;
  revision: number;
  status: "active" | "revoked";
  createdAt: string;
  scope: CalendarScope;
  previousDays: number;
  nextDays: number;
  eventLimit: number;
};
export type CalendarIssue = {
  subscription: CalendarSubscription;
  url: string | null;
};
export type CalendarCommands = {
  calendarSubscriptionOptions: {
    input: Record<string, never>;
    output: { teams: AgendaTeam[] };
  };
  listCalendarSubscriptions: {
    input: Record<string, never>;
    output: { items: CalendarSubscription[] };
  };
  createCalendarSubscription: {
    input: CalendarScope & { requestId: string };
    output: CalendarIssue;
  };
  rotateCalendarSubscription: {
    input: {
      subscriptionId: string;
      expectedRevision: number;
      requestId: string;
    };
    output: CalendarIssue;
  };
  revokeCalendarSubscription: {
    input: {
      subscriptionId: string;
      expectedRevision: number;
      requestId: string;
    };
    output: { ok: true };
  };
};
export const calendarPrivacy =
  "Anyone with your private URL can read its selected schedule. Keep it private. Names are excluded unless you explicitly select participants and include their names.";
export const calendarCoverage =
  "Includes published upcoming events for the selected teams, from the previous 30 days through the next 365 days, up to 499 events. New teams and participants are never added automatically.";
export const calendarRemoval =
  "Remove revokes this URL immediately on our server. Also delete the subscribed calendar in your calendar app. Calendar apps choose their own refresh timing and may keep downloaded entries after access is removed. Rotate revokes the old URL and creates a replacement for the same scope.";
export const calendarInstructions =
  "Use a calendar app that supports subscriptions by URL. In Apple Calendar, add a Subscription Calendar; in Google Calendar, use Other calendars → From URL on the web; in Outlook, use Add calendar → Subscribe from web. Paste the private URL. Other compatible apps can use their subscribe-by-URL option. Importing an .ics file only creates a one-time copy.";
