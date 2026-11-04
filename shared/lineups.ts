/** Wire contracts for Phase 3 saved lineups. Keep aligned with functions/src/coaching/lineups.ts. */
export type LineupPresetId = "soccer" | "basketball" | "football";

export type LineupSlot = {
  slotId: string;
  participantId: string;
  x: number;
  y: number;
};

export type LineupUnit = {
  unitId: string;
  slots: LineupSlot[];
};

export type LineupRosterEntry = {
  participantId: string;
  displayName: string;
  /** False after a roster departure or participant deactivation. Never auto-replaced. */
  available: boolean;
};

export type LineupPublication = {
  state: "private" | "published";
  /** Saved lineup revision copied into the public view, or null while private. */
  sourceRevision: number | null;
  publishedAt: string | null;
};

/** Private coach payload. Notes and roster status are never copied to the public view. */
export type PrivateLineup = {
  orgId: string;
  eventId: string;
  teamId: string;
  revision: number;
  sportPresetId: LineupPresetId | null;
  presetVersion: number | null;
  units: LineupUnit[];
  bench: string[];
  note: string;
  roster: LineupRosterEntry[];
  unavailableParticipantIds: string[];
  publication: LineupPublication;
  updatedAt: string | null;
};

export type SaveLineupPayload = {
  teamId: string;
  sportPresetId: LineupPresetId;
  units: LineupUnit[];
  bench: string[];
  note: string;
};

export type PublishedLineupView =
  | { state: "unpublished" }
  | {
      state: "published";
      sportPresetId: LineupPresetId;
      presetVersion: number;
      units: {
        unitId: string;
        slots: (LineupSlot & { displayName: string })[];
      }[];
      bench: { participantId: string; displayName: string }[];
      publicationRevision: number;
      publishedAt: string;
    };

export type LineupMutationResult = {
  requestId: string;
  revision: number;
  state: "private" | "published";
};

export const LINEUP_NOTE_MAX = 2000;
