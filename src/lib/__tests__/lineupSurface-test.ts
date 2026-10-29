import {
  clampNormalizedPoint,
  createSyntheticRoster,
  DRAG_ACTIVATION_MS,
  DRAG_TOUCH_SLOP,
  denormalizePoint,
  getSportPreset,
  normalizePoint,
  placeParticipant,
  resolveSurfaceFrame,
  SPORT_PRESET_IDS,
} from '../coaching/lineupSurface';

describe('Phase 3 lineup surface contracts', () => {
  test.each([
    ['soccer', 11],
    ['basketball', 5],
    ['football', 11],
  ] as const)('%s exposes a bounded playable unit', (presetId, capacity) => {
    const preset = getSportPreset(presetId);

    expect(preset.capacity).toBe(capacity);
    expect(preset.slots).toHaveLength(capacity);
    expect(new Set(preset.slots.map((slot) => slot.id)).size).toBe(capacity);
    expect(preset.slots.every((slot) => slot.point.x >= 0 && slot.point.x <= 1)).toBe(true);
    expect(preset.slots.every((slot) => slot.point.y >= 0 && slot.point.y <= 1)).toBe(true);
  });

  test('all supported presets remain explicit and closed', () => {
    expect(SPORT_PRESET_IDS).toEqual(['soccer', 'basketball', 'football']);
    expect(() => getSportPreset('baseball' as never)).toThrow('Unsupported sport preset');
  });

  test.each([
    { x: 0, y: 0 },
    { x: 0.25, y: 0.75 },
    { x: 1, y: 1 },
  ])('normalized coordinates round-trip through a measured surface: %p', (point) => {
    const size = { width: 287, height: 463 };
    const pixels = denormalizePoint(point, size);

    expect(normalizePoint(pixels, size)).toEqual(point);
  });

  test('coordinates are clamped and invalid measurements are rejected', () => {
    expect(clampNormalizedPoint({ x: -0.5, y: 1.4 })).toEqual({ x: 0, y: 1 });
    expect(() => normalizePoint({ x: 10, y: 10 }, { width: 0, height: 100 })).toThrow('Surface dimensions');
  });

  test('placing a participant preserves one marker per participant and unit capacity', () => {
    const preset = getSportPreset('basketball');
    const roster = createSyntheticRoster();
    let placements = preset.slots.map((slot, index) => ({
      slotId: slot.id,
      participantId: roster[index].id,
      point: slot.point,
    }));

    placements = placeParticipant(placements, {
      slotId: preset.slots[1].id,
      participantId: roster[0].id,
      point: { x: 0.4, y: 0.6 },
    }, preset.capacity);

    expect(placements).toHaveLength(preset.capacity);
    expect(placements.filter((row) => row.participantId === roster[0].id)).toHaveLength(1);
    expect(placements.find((row) => row.participantId === roster[0].id)?.slotId).toBe(preset.slots[1].id);
    expect(() => placeParticipant(placements, {
      slotId: 'extra',
      participantId: roster[10].id,
      point: { x: 0.5, y: 0.5 },
    }, preset.capacity)).toThrow('Unit capacity');
  });

  test('synthetic roster is large, non-sensitive and stresses long labels', () => {
    const roster = createSyntheticRoster();

    expect(roster).toHaveLength(30);
    expect(new Set(roster.map((participant) => participant.id)).size).toBe(30);
    expect(roster.some((participant) => participant.displayName.length > 25)).toBe(true);
    expect(roster.every((participant) => participant.id.startsWith('synthetic-participant-'))).toBe(true);
  });

  test.each([
    [{ width: 320, height: 700, fontScale: 1 }, 'soccer', 288],
    [{ width: 844, height: 390, fontScale: 1 }, 'football', 523],
    [{ width: 390, height: 844, fontScale: 2 }, 'basketball', 326],
  ] as const)('surface frame stays usable at viewport %p', (viewport, presetId, maxWidth) => {
    const frame = resolveSurfaceFrame(viewport, getSportPreset(presetId));

    expect(frame.width).toBeGreaterThanOrEqual(240);
    expect(frame.width).toBeLessThanOrEqual(maxWidth);
    expect(frame.height).toBeGreaterThanOrEqual(180);
    expect(frame.height).toBeLessThanOrEqual(viewport.height * 0.68);
  });

  test.each([
    { width: 320, height: 568, fontScale: 1 },
    { width: 390, height: 844, fontScale: 1 },
    { width: 390, height: 844, fontScale: 2 },
  ])('preset markers keep separate 44pt touch targets at %o', (viewport) => {
    const markerSize = 44;
    for (const presetId of SPORT_PRESET_IDS) {
      const preset = getSportPreset(presetId);
      const frame = resolveSurfaceFrame(viewport, preset);
      const centers = preset.slots.map((slot) => ({ id: slot.id, ...denormalizePoint(slot.point, frame) }));
      for (const [index, a] of centers.entries()) {
        for (const b of centers.slice(index + 1)) {
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          expect({ presetId, pair: `${a.id}/${b.id}`, clear: distance >= markerSize })
            .toEqual({ presetId, pair: `${a.id}/${b.id}`, clear: true });
        }
      }
    }
  });

  test('drag activation yields scrolling until an intentional hold and movement', () => {
    expect(DRAG_ACTIVATION_MS).toBeGreaterThanOrEqual(180);
    expect(DRAG_TOUCH_SLOP).toBeGreaterThanOrEqual(6);
  });
});
