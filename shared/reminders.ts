/** Callable JSON only. Delivery failure and human acknowledgement stay separate. */
export type DeliveryFailure = {
  id: string;
  channel: string;
  status: string;
  failureCode: string | null;
  sourceType: string | null;
  sourceId: string | null;
  templateKey: string | null;
  updatedAt: string | null;
};
export type UnacknowledgedCritical = {
  id: string;
  title: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
  templateKey: string | null;
  createdAt: string | null;
};
export type DeliveryDiagnostics = {
  failures: { items: DeliveryFailure[]; nextCursor: string | null };
  unacknowledged: { items: UnacknowledgedCritical[]; nextCursor: string | null };
};
export type ReminderCommands = {
  listDeliveryDiagnostics: {
    input: {
      orgId: string;
      failureCursor?: string;
      acknowledgementCursor?: string;
      pageSize?: number;
    };
    output: DeliveryDiagnostics;
  };
};
