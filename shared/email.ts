export type PrivateEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  revision: number;
  location: { name: string; address?: string } | null;
  teams: { id: string; name: string }[];
};
export type EmailDelivery = {
  id: string;
  kind: string;
  status: string;
  attemptCount: number;
  failureCode: string | null;
  nextAttemptAt: string | null;
};
export type EmailCommands = {
  getPrivateEventInformation: {
    input: { eventId: string };
    output: PrivateEvent;
  };
  listEssentialEmail: {
    input: { orgId: string; cursor?: string; pageSize?: number };
    output: { items: EmailDelivery[]; nextCursor: string | null };
  };
  getEssentialEmailPreference: {
    input: Record<string, never>;
    output: { suppressed: boolean };
  };
  setEssentialEmailPreference: {
    input: { requestId: string; suppressed: boolean };
    output: { suppressed: boolean };
  };
};
