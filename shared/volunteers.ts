/** Wire contracts for Phase 3 volunteer slots. Keep aligned with functions/src/volunteers/slots.ts. */
export const VOLUNTEER_KINDS = ["snacks", "setup", "scorekeeping", "cleanup", "other"] as const;
export type VolunteerKind = (typeof VOLUNTEER_KINDS)[number];

export const VOLUNTEER_KIND_LABELS: Record<VolunteerKind, string> = {
  snacks: "Snacks",
  setup: "Setup",
  scorekeeping: "Scorekeeping",
  cleanup: "Cleanup",
  other: "Other",
};

export const VOLUNTEER_ALIAS_MAX = 40;
export const VOLUNTEER_CAPACITY_MAX = 50;

export type VolunteerSlotState = "open" | "full" | "closed" | "cancelled";

/** Public assignment entry: only the alias the adult chose. Coaches also get an opaque key for removal. */
export type VolunteerAssignee = { alias: string; assigneeKey?: string };

export type VolunteerSlot = {
  slotId: string;
  kind: VolunteerKind;
  title: string;
  capacity: number;
  openCount: number;
  state: VolunteerSlotState;
  claimDeadline: string | null;
  revision: number;
  assignees: VolunteerAssignee[];
  /** The caller's own claim. "cancelled" means the slot or event was cancelled after claiming. */
  ownClaim: { alias: string; status: "active" | "cancelled" } | null;
};

export type EventVolunteers = {
  orgId: string;
  eventId: string;
  teamId: string;
  canManage: boolean;
  canClaim: boolean;
  eventStatus: string;
  slots: VolunteerSlot[];
};

export type VolunteerMutationResult = {
  requestId: string;
  revision: number;
  state: "open" | "cancelled" | "claimed" | "released";
  slotId: string;
};

/** Mirrors the backend alias check so the form can explain the rule before sending. */
export function aliasProblem(value: string): string | null {
  const alias = value.trim().replace(/\s+/g, " ");
  if (!alias) return "Enter a display name or initials.";
  if (alias.length > VOLUNTEER_ALIAS_MAX) return `Use ${VOLUNTEER_ALIAS_MAX} characters or fewer.`;
  if (/@|https?:|www\./i.test(alias) || /\d[\d\s().-]{5,}\d/.test(alias)) {
    return "Use a display name or initials only. Do not include email, phone or links.";
  }
  return null;
}

export function slotStatusLabel(slot: Pick<VolunteerSlot, "state" | "openCount" | "capacity">): string {
  if (slot.state === "cancelled") return "Cancelled";
  if (slot.state === "closed") return "Sign-up closed";
  if (slot.state === "full") return `Full (${slot.capacity} of ${slot.capacity} taken)`;
  return `${slot.openCount} of ${slot.capacity} ${slot.capacity === 1 ? "spot" : "spots"} open`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Deadline form text in the device's local time: "YYYY-MM-DD HH:MM". */
export function deadlineInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Blank means sign-up stays open until the event starts. Returns undefined for unreadable text. */
export function parseDeadline(value: string): string | null | undefined {
  const text = value.trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const at = new Date(year, month - 1, day, hour, minute);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) {
    return undefined;
  }
  return at.toISOString();
}
