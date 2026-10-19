export const RSVP_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
export const RSVP_REMINDER_MIN_REMAINING_MS = 60 * 60 * 1000;

export type ReminderPlan = {
  key: string;
  action: "wait" | "send" | "skip";
  reason:
    | "before_window"
    | "due"
    | "immediate"
    | "too_late"
    | "already_sent"
    | "closed"
    | "unpublished";
  dueAtMs: number | null;
};

/** One server-owned reminder per schedule version and deadline. Not a device timer. */
export function planRsvpReminder(input: {
  nowMs: number;
  deadlineMs: number;
  scheduleVersion: number;
  sentKey: string | null;
  status: string;
  resourceClosed: boolean;
  published: boolean;
}): ReminderPlan {
  const scheduleVersion =
    Number.isSafeInteger(input.scheduleVersion) && input.scheduleVersion > 0
      ? input.scheduleVersion
      : 1;
  const key = `${scheduleVersion}:${input.deadlineMs}`;
  if (!input.published)
    return { key, action: "skip", reason: "unpublished", dueAtMs: null };
  if (
    input.status !== "scheduled" ||
    input.resourceClosed ||
    !Number.isFinite(input.deadlineMs)
  ) {
    return { key, action: "skip", reason: "closed", dueAtMs: null };
  }
  if (input.sentKey === key)
    return { key, action: "skip", reason: "already_sent", dueAtMs: null };
  const leadAt = input.deadlineMs - RSVP_REMINDER_LEAD_MS;
  if (input.nowMs < leadAt)
    return {
      key,
      action: "wait",
      reason: "before_window",
      dueAtMs: leadAt,
    };
  if (input.nowMs >= input.deadlineMs - RSVP_REMINDER_MIN_REMAINING_MS) {
    return { key, action: "skip", reason: "too_late", dueAtMs: null };
  }
  return {
    key,
    action: "send",
    reason: input.nowMs > leadAt ? "immediate" : "due",
    dueAtMs: input.nowMs,
  };
}

/** Yes, no and maybe count as a response. A mismatched schedule version still needs reconfirmation. */
export function isCurrentResponse(
  row: { status?: string; scheduleVersion?: number } | undefined,
  scheduleVersion: number,
) {
  if (!row || row.scheduleVersion !== scheduleVersion) return false;
  return row.status === "yes" || row.status === "no" || row.status === "maybe";
}
