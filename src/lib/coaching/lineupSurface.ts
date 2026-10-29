export const SPORT_PRESET_IDS = ['soccer', 'basketball', 'football'] as const;

export type SportPresetId = typeof SPORT_PRESET_IDS[number];

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type SurfaceSize = {
  width: number;
  height: number;
};

export type SurfaceViewport = SurfaceSize & {
  fontScale: number;
};

export const DRAG_ACTIVATION_MS = 220;
export const DRAG_TOUCH_SLOP = 8;

export type SurfaceSlot = {
  id: string;
  label: string;
  point: NormalizedPoint;
};

export type SportPreset = {
  id: SportPresetId;
  label: string;
  unitLabel: string;
  capacity: number;
  aspectRatio: number;
  surfaceColor: string;
  lineColor: string;
  slots: readonly SurfaceSlot[];
};

export type SyntheticParticipant = {
  id: string;
  displayName: string;
  jerseyNumber: number;
};

export type SurfacePlacement = {
  slotId: string;
  participantId: string;
  point: NormalizedPoint;
};

function slot(id: string, label: string, x: number, y: number): SurfaceSlot {
  return { id, label, point: { x, y } };
}

const PRESETS: Record<SportPresetId, SportPreset> = {
  soccer: {
    id: 'soccer',
    label: 'Soccer',
    unitLabel: 'Starting eleven',
    capacity: 11,
    aspectRatio: 0.68,
    surfaceColor: '#267A4A',
    lineColor: '#EAF7EE',
    slots: [
      slot('gk', 'Goalkeeper', 0.5, 0.91),
      slot('lb', 'Left back', 0.18, 0.72),
      slot('lcb', 'Left center back', 0.39, 0.76),
      slot('rcb', 'Right center back', 0.61, 0.76),
      slot('rb', 'Right back', 0.82, 0.72),
      slot('lm', 'Left midfield', 0.2, 0.48),
      slot('cm', 'Center midfield', 0.5, 0.52),
      slot('rm', 'Right midfield', 0.8, 0.48),
      slot('lw', 'Left wing', 0.2, 0.23),
      slot('st', 'Striker', 0.5, 0.14),
      slot('rw', 'Right wing', 0.8, 0.23),
    ],
  },
  basketball: {
    id: 'basketball',
    label: 'Basketball',
    unitLabel: 'On court',
    capacity: 5,
    aspectRatio: 0.62,
    surfaceColor: '#C7772F',
    lineColor: '#FFF5E8',
    slots: [
      slot('pg', 'Point guard', 0.5, 0.76),
      slot('sg', 'Shooting guard', 0.23, 0.54),
      slot('sf', 'Small forward', 0.77, 0.54),
      slot('pf', 'Power forward', 0.3, 0.25),
      slot('c', 'Center', 0.7, 0.21),
    ],
  },
  football: {
    id: 'football',
    label: 'Football',
    unitLabel: 'Offense',
    capacity: 11,
    aspectRatio: 1.45,
    surfaceColor: '#386D43',
    lineColor: '#F5F0D7',
    slots: [
      slot('qb', 'Quarterback', 0.5, 0.67),
      slot('rb', 'Running back', 0.5, 0.82),
      slot('wr-l', 'Left wide receiver', 0.08, 0.47),
      slot('wr-r', 'Right wide receiver', 0.92, 0.47),
      slot('te', 'Tight end', 0.76, 0.53),
      slot('lt', 'Left tackle', 0.28, 0.54),
      slot('lg', 'Left guard', 0.39, 0.54),
      slot('c', 'Center', 0.5, 0.54),
      slot('rg', 'Right guard', 0.61, 0.54),
      slot('rt', 'Right tackle', 0.72, 0.54),
      slot('slot', 'Slot receiver', 0.16, 0.65),
    ],
  },
};

const SYNTHETIC_NAMES = [
  'Alexis Montgomery-Washington',
  'Jordan Ellison',
  'Taylor Rivera',
  'Morgan Okafor',
  'Cameron Jean-Baptiste',
  'Riley Nakamura',
  'Avery Christensen',
  'Parker Williams',
  'Quinn Hernández-Santos',
  'Rowan McAllister',
  'Sage Thompson',
  'Emerson Patel',
  'Drew Anderson',
  'Casey Kowalski',
  'Reese Adeyemi',
  'Finley O’Connell',
  'Skyler Robertson',
  'Dakota Nguyen',
  'Marley Ibrahim',
  'Hayden van der Meer',
  'Arden López',
  'Remy Sullivan',
  'Kendall Park',
  'Blake D’Amico',
  'Phoenix Campbell',
  'Charlie Mensah',
  'Jamie Sinclair',
  'Robin Choudhury',
  'Micah García',
  'Samira Abdullah-Rahman',
] as const;

export function getSportPreset(id: SportPresetId): SportPreset {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`Unsupported sport preset: ${id}`);
  return preset;
}

export function createSyntheticRoster(): SyntheticParticipant[] {
  return SYNTHETIC_NAMES.map((displayName, index) => ({
    id: `synthetic-participant-${index + 1}`,
    displayName,
    jerseyNumber: index + 1,
  }));
}

export function clampNormalizedPoint(point: NormalizedPoint): NormalizedPoint {
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  };
}

function assertSurfaceSize(size: SurfaceSize) {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error('Surface dimensions must be positive finite numbers.');
  }
}

export function normalizePoint(point: NormalizedPoint, size: SurfaceSize): NormalizedPoint {
  assertSurfaceSize(size);
  return clampNormalizedPoint({
    x: point.x / size.width,
    y: point.y / size.height,
  });
}

export function denormalizePoint(point: NormalizedPoint, size: SurfaceSize): NormalizedPoint {
  assertSurfaceSize(size);
  const normalized = clampNormalizedPoint(point);
  return {
    x: normalized.x * size.width,
    y: normalized.y * size.height,
  };
}

export function resolveSurfaceFrame(viewport: SurfaceViewport, preset: SportPreset): SurfaceSize {
  assertSurfaceSize(viewport);
  const horizontalInset = viewport.fontScale >= 1.5 ? 64 : 32;
  const availableWidth = Math.max(240, viewport.width - horizontalInset);
  const maxHeight = viewport.height * 0.68;
  const widthFromHeight = maxHeight * preset.aspectRatio;
  const width = Math.min(620, availableWidth, Math.max(240, widthFromHeight));
  return {
    width: Math.round(width),
    height: Math.round(Math.max(180, Math.min(maxHeight, width / preset.aspectRatio))),
  };
}

export function placeParticipant(
  current: readonly SurfacePlacement[],
  next: SurfacePlacement,
  capacity: number,
): SurfacePlacement[] {
  const previousParticipantPlacement = current.find((placement) => placement.participantId === next.participantId);
  const displacedPlacement = current.find((placement) => (
    placement.slotId === next.slotId && placement.participantId !== next.participantId
  ));
  const withoutParticipantOrSlot = current.filter((placement) => (
    placement.participantId !== next.participantId && placement.slotId !== next.slotId
  ));
  const result = [...withoutParticipantOrSlot];
  if (previousParticipantPlacement && displacedPlacement) {
    result.push({
      ...displacedPlacement,
      slotId: previousParticipantPlacement.slotId,
      point: previousParticipantPlacement.point,
    });
  }
  result.push({
    ...next,
    point: clampNormalizedPoint(next.point),
  });
  if (result.length > capacity) throw new Error('Unit capacity exceeded.');
  return result;
}
