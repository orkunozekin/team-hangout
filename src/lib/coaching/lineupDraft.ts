import type {
  LineupPresetId,
  LineupRosterEntry,
  PrivateLineup,
  SaveLineupPayload,
} from '../../../shared/lineups';
import { getSportPreset, placeParticipant, type SurfacePlacement } from './lineupSurface';

/** Editable copy of a saved lineup. Bench order is explicit; RSVP never reorders it. */
export type LineupDraft = {
  sportPresetId: LineupPresetId;
  units: Record<string, SurfacePlacement[]>;
  bench: string[];
  note: string;
};

export function emptyDraft(sportPresetId: LineupPresetId, bench: string[] = [], note = ''): LineupDraft {
  const preset = getSportPreset(sportPresetId);
  return {
    sportPresetId,
    units: Object.fromEntries(preset.units.map((unit) => [unit.id, []])),
    bench,
    note,
  };
}

export function draftFromLineup(lineup: PrivateLineup, fallback: LineupPresetId = 'soccer'): LineupDraft {
  const draft = emptyDraft(lineup.sportPresetId ?? fallback, [...lineup.bench], lineup.note);
  for (const unit of lineup.units) {
    if (!(unit.unitId in draft.units)) continue;
    draft.units[unit.unitId] = unit.slots.map((slot) => ({
      slotId: slot.slotId,
      participantId: slot.participantId,
      point: { x: slot.x, y: slot.y },
    }));
  }
  return draft;
}

/** Switching sport clears positions because slot identities differ; bench and note are kept. */
export function changePreset(draft: LineupDraft, sportPresetId: LineupPresetId): LineupDraft {
  if (draft.sportPresetId === sportPresetId) return draft;
  const placed = new Set(Object.values(draft.units).flat().map((p) => p.participantId));
  return emptyDraft(sportPresetId, [...draft.bench, ...[...placed].filter((id) => !draft.bench.includes(id))], draft.note);
}

function unitSlots(draft: LineupDraft, unitId: string) {
  const unit = getSportPreset(draft.sportPresetId).units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new Error(`Unknown unit: ${unitId}`);
  return unit.slots;
}

export function assignToSlot(draft: LineupDraft, unitId: string, slotId: string, participantId: string): LineupDraft {
  const slots = unitSlots(draft, unitId);
  const slot = slots.find((candidate) => candidate.id === slotId);
  if (!slot) throw new Error(`Unknown slot: ${slotId}`);
  const current = draft.units[unitId] ?? [];
  const existing = current.find((p) => p.slotId === slotId);
  const units = {
    ...draft.units,
    [unitId]: placeParticipant(current, { slotId, participantId, point: existing?.point ?? slot.point }, slots.length),
  };
  return { ...draft, units, bench: draft.bench.filter((id) => id !== participantId) };
}

export function clearSlot(draft: LineupDraft, unitId: string, slotId: string): LineupDraft {
  return {
    ...draft,
    units: { ...draft.units, [unitId]: (draft.units[unitId] ?? []).filter((p) => p.slotId !== slotId) },
  };
}

/** Bench participants hold no position in any unit. */
export function addToBench(draft: LineupDraft, participantId: string): LineupDraft {
  const units = Object.fromEntries(
    Object.entries(draft.units).map(([unitId, placements]) => [unitId, placements.filter((p) => p.participantId !== participantId)]),
  );
  return { ...draft, units, bench: draft.bench.includes(participantId) ? draft.bench : [...draft.bench, participantId] };
}

export function removeFromBench(draft: LineupDraft, participantId: string): LineupDraft {
  return { ...draft, bench: draft.bench.filter((id) => id !== participantId) };
}

export function moveBench(draft: LineupDraft, participantId: string, delta: -1 | 1): LineupDraft {
  const index = draft.bench.indexOf(participantId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= draft.bench.length) return draft;
  const bench = [...draft.bench];
  [bench[index], bench[target]] = [bench[target], bench[index]];
  return { ...draft, bench };
}

export function draftToPayload(draft: LineupDraft, teamId: string): SaveLineupPayload {
  const preset = getSportPreset(draft.sportPresetId);
  return {
    teamId,
    sportPresetId: draft.sportPresetId,
    units: preset.units.map((unit) => ({
      unitId: unit.id,
      slots: unit.slots.flatMap((slot) => {
        const placement = (draft.units[unit.id] ?? []).find((p) => p.slotId === slot.id);
        return placement ? [{ slotId: slot.id, participantId: placement.participantId, x: placement.point.x, y: placement.point.y }] : [];
      }),
    })),
    bench: [...draft.bench],
    note: draft.note,
  };
}

/** Available roster entries that hold no slot and are not on the bench. */
export function unassignedParticipants(draft: LineupDraft, roster: readonly LineupRosterEntry[]): LineupRosterEntry[] {
  const used = new Set([...draft.bench, ...Object.values(draft.units).flat().map((p) => p.participantId)]);
  return roster.filter((entry) => entry.available && !used.has(entry.participantId));
}

export type LineupErrorKind = 'offline' | 'conflict' | 'unavailable' | 'denied' | 'other';

export function lineupError(error: unknown): { kind: LineupErrorKind; message: string } {
  const e = error as { code?: string; message?: string; details?: { domainCode?: string } };
  if (['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(e.code ?? '')) {
    return { kind: 'offline', message: 'Not saved. You appear to be offline. Your draft is kept on this screen; retry when connected.' };
  }
  if (e.details?.domainCode === 'STALE_REVISION') {
    return { kind: 'conflict', message: 'Another coach saved this lineup first. Reload the latest lineup, then reapply your changes.' };
  }
  if (e.details?.domainCode === 'PARTICIPANT_UNAVAILABLE') {
    return { kind: 'unavailable', message: 'A participant in this lineup is no longer on the roster. Replace them before saving or publishing.' };
  }
  if (e.code === 'functions/permission-denied') {
    return { kind: 'denied', message: 'Coaching access changed or is unavailable for this team.' };
  }
  return { kind: 'other', message: e.message || 'Lineup unavailable. Reload before trying again.' };
}
