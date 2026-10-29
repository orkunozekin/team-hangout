import React, { useCallback, useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Line, Rect } from 'react-native-svg';

import {
  createSyntheticRoster,
  denormalizePoint,
  DRAG_ACTIVATION_MS,
  DRAG_TOUCH_SLOP,
  getSportPreset,
  normalizePoint,
  placeParticipant,
  resolveSurfaceFrame,
  SPORT_PRESET_IDS,
  type NormalizedPoint,
  type SportPreset,
  type SportPresetId,
  type SurfacePlacement,
  type SurfaceSize,
  type SyntheticParticipant,
} from '../lib/coaching/lineupSurface';
import { colors, fonts, radius, shadow, spacing, type } from '../theme/theme';
import { Screen } from '../components/ui';

type EditorMode = 'surface' | 'list';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

function createInitialPlacements(preset: SportPreset, roster: readonly SyntheticParticipant[]): SurfacePlacement[] {
  return preset.slots.map((surfaceSlot, index) => ({
    slotId: surfaceSlot.id,
    participantId: roster[index].id,
    point: surfaceSlot.point,
  }));
}

function nearestSlot(preset: SportPreset, point: NormalizedPoint) {
  return preset.slots.reduce((best, candidate) => {
    const candidateDistance = ((candidate.point.x - point.x) ** 2) + ((candidate.point.y - point.y) ** 2);
    const bestDistance = ((best.point.x - point.x) ** 2) + ((best.point.y - point.y) ** 2);
    return candidateDistance < bestDistance ? candidate : best;
  });
}

function SurfaceMarkings({ preset, frame }: { preset: SportPreset; frame: SurfaceSize }) {
  const strokeWidth = 2;
  return (
    <Svg width={frame.width} height={frame.height} pointerEvents="none" accessibilityElementsHidden>
      <Rect x={1} y={1} width={frame.width - 2} height={frame.height - 2} rx={16} fill={preset.surfaceColor} stroke={preset.lineColor} strokeWidth={strokeWidth} />
      {preset.id === 'football' ? (
        <>
          {[0.2, 0.4, 0.6, 0.8].map((ratio) => <Line key={ratio} x1={frame.width * ratio} x2={frame.width * ratio} y1={8} y2={frame.height - 8} stroke={preset.lineColor} strokeWidth={1} />)}
          <Line x1={frame.width / 2} x2={frame.width / 2} y1={2} y2={frame.height - 2} stroke={preset.lineColor} strokeWidth={strokeWidth} />
        </>
      ) : (
        <>
          <Line x1={2} x2={frame.width - 2} y1={frame.height / 2} y2={frame.height / 2} stroke={preset.lineColor} strokeWidth={strokeWidth} />
          <Circle cx={frame.width / 2} cy={frame.height / 2} r={Math.min(frame.width, frame.height) * 0.13} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
          {preset.id === 'soccer' ? (
            <>
              <Rect x={frame.width * 0.22} y={2} width={frame.width * 0.56} height={frame.height * 0.13} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
              <Rect x={frame.width * 0.22} y={frame.height * 0.87} width={frame.width * 0.56} height={frame.height * 0.13 - 2} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
            </>
          ) : null}
        </>
      )}
    </Svg>
  );
}

function PlayerMarker({
  participant,
  point,
  frame,
  selected,
  onSelect,
  onMove,
}: {
  participant: SyntheticParticipant;
  point: NormalizedPoint;
  frame: SurfaceSize;
  selected: boolean;
  onSelect: () => void;
  onMove: (point: NormalizedPoint) => void;
}) {
  const pixels = denormalizePoint(point, frame);
  const pan = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(DRAG_ACTIVATION_MS)
    .minDistance(DRAG_TOUCH_SLOP)
    .runOnJS(true)
    .onStart(onSelect)
    .onUpdate((event) => {
      onMove(normalizePoint({
        x: pixels.x + event.translationX,
        y: pixels.y + event.translationY,
      }, frame));
    }), [frame, onMove, onSelect, pixels.x, pixels.y]);

  return (
    <GestureDetector gesture={pan}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${participant.displayName} marker, ${selected ? 'selected' : 'not selected'}`}
        accessibilityHint="Double tap to select. Hold, then drag to move. You can also use accessible list mode."
        accessibilityState={{ selected }}
        onPress={onSelect}
        hitSlop={8}
        style={[
          styles.marker,
          selected ? styles.markerSelected : null,
          { left: pixels.x - 22, top: pixels.y - 22 },
        ]}
      >
        <NativeText maxFontSizeMultiplier={1.25} style={styles.markerNumber}>{participant.jerseyNumber}</NativeText>
      </Pressable>
    </GestureDetector>
  );
}

export default function Phase3SurfaceHarnessScreen() {
  const roster = useMemo(() => createSyntheticRoster(), []);
  const rosterById = useMemo(() => new Map(roster.map((participant) => [participant.id, participant])), [roster]);
  const viewport = useWindowDimensions();
  const [presetId, setPresetId] = useState<SportPresetId>('soccer');
  const preset = getSportPreset(presetId);
  const proposedFrame = resolveSurfaceFrame(viewport, preset);
  const [measuredFrame, setMeasuredFrame] = useState<SurfaceSize | null>(null);
  const frame = measuredFrame ?? proposedFrame;
  const [mode, setMode] = useState<EditorMode>('surface');
  const [selectedParticipantId, setSelectedParticipantId] = useState(roster[0].id);
  const [placements, setPlacements] = useState(() => createInitialPlacements(preset, roster));
  const [announcement, setAnnouncement] = useState('Select a participant, then tap the surface, drag a marker, or use accessible list mode.');

  const selectPreset = useCallback((nextPresetId: SportPresetId) => {
    const nextPreset = getSportPreset(nextPresetId);
    setPresetId(nextPresetId);
    setMeasuredFrame(null);
    setSelectedParticipantId(roster[0].id);
    setPlacements(createInitialPlacements(nextPreset, roster));
    setAnnouncement(`${nextPreset.label} preset selected. ${nextPreset.capacity} positions are filled.`);
  }, [roster]);

  const updatePlacement = useCallback((participantId: string, slotId: string, point: NormalizedPoint) => {
    setPlacements((current) => placeParticipant(current, { participantId, slotId, point }, preset.capacity));
  }, [preset.capacity]);

  const placeSelectedAtSlot = useCallback((slotId: string) => {
    const target = preset.slots.find((surfaceSlot) => surfaceSlot.id === slotId);
    const participant = rosterById.get(selectedParticipantId);
    if (!target || !participant) return;
    updatePlacement(participant.id, target.id, target.point);
    setAnnouncement(`${participant.displayName} is now ${target.label}.`);
  }, [preset.slots, rosterById, selectedParticipantId, updatePlacement]);

  const onSurfacePress = useCallback((event: { nativeEvent: { locationX: number; locationY: number } }) => {
    const participant = rosterById.get(selectedParticipantId);
    if (!participant) return;
    const point = normalizePoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, frame);
    const target = nearestSlot(preset, point);
    updatePlacement(participant.id, target.id, point);
    setAnnouncement(`${participant.displayName} moved on the ${preset.label.toLowerCase()} surface.`);
  }, [frame, preset, rosterById, selectedParticipantId, updatePlacement]);

  const onSurfaceLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0 && (width !== frame.width || height !== frame.height)) setMeasuredFrame({ width, height });
  }, [frame.height, frame.width]);

  const selectedParticipant = rosterById.get(selectedParticipantId)!;
  const activeParticipantIds = new Set(placements.map((placement) => placement.participantId));

  return (
    <Screen style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Lineup surface lab content"
      >
        <Text accessibilityRole="header" style={styles.title}>Lineup surface lab</Text>
        <Text style={styles.devBadge}>INTERNAL DEVELOPMENT HARNESS</Text>
        <Text style={styles.intro}>Synthetic roster only. Nothing here is saved or published.</Text>

        <View accessibilityRole="radiogroup" accessibilityLabel="Sport preset" style={styles.choiceRow}>
          {SPORT_PRESET_IDS.map((id) => {
            const option = getSportPreset(id);
            const selected = id === presetId;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityLabel={`${option.label} preset`}
                accessibilityState={{ selected }}
                onPress={() => selectPreset(id)}
                style={[styles.choice, selected ? styles.choiceSelected : null]}
              >
                <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View accessibilityRole="radiogroup" accessibilityLabel="Editing mode" style={styles.choiceRow}>
          <Pressable accessibilityRole="radio" accessibilityLabel="Visual surface mode" accessibilityState={{ selected: mode === 'surface' }} onPress={() => setMode('surface')} style={[styles.choice, mode === 'surface' ? styles.choiceSelected : null]}>
            <Text style={[styles.choiceText, mode === 'surface' ? styles.choiceTextSelected : null]}>Surface</Text>
          </Pressable>
          <Pressable accessibilityRole="radio" accessibilityLabel="Accessible list mode" accessibilityState={{ selected: mode === 'list' }} onPress={() => setMode('list')} style={[styles.choice, mode === 'list' ? styles.choiceSelected : null]}>
            <Text style={[styles.choiceText, mode === 'list' ? styles.choiceTextSelected : null]}>Accessible list</Text>
          </Pressable>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryText}>
            <Text style={styles.sectionLabel}>{preset.label} · {preset.unitLabel}</Text>
            <Text style={styles.capacity}>{placements.length} of {preset.capacity} {preset.unitLabel.toLowerCase()}</Text>
          </View>
          <View style={styles.selectedCard}>
            <Text style={styles.selectedEyebrow}>Selected #{selectedParticipant.jerseyNumber}</Text>
            <Text style={styles.selectedName}>{selectedParticipant.displayName}</Text>
          </View>
        </View>

        <Text accessibilityLiveRegion="polite" style={styles.announcement}>{announcement}</Text>

        {mode === 'surface' ? (
          <View style={styles.surfaceCenter}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${preset.label} lineup surface`}
              accessibilityHint={`Double tap to place ${selectedParticipant.displayName}. Hold and drag a marker to move it.`}
              onPress={onSurfacePress}
              onLayout={onSurfaceLayout}
              style={[styles.surface, { width: proposedFrame.width, height: proposedFrame.height }]}
            >
              <SurfaceMarkings preset={preset} frame={frame} />
              {placements.map((placement) => {
                const participant = rosterById.get(placement.participantId);
                if (!participant) return null;
                return (
                  <PlayerMarker
                    key={participant.id}
                    participant={participant}
                    point={placement.point}
                    frame={frame}
                    selected={participant.id === selectedParticipantId}
                    onSelect={() => setSelectedParticipantId(participant.id)}
                    onMove={(point) => updatePlacement(participant.id, placement.slotId, point)}
                  />
                );
              })}
            </Pressable>
            <Text style={styles.dragHelp}>Scroll normally. Hold a marker briefly before dragging, or switch to the accessible list.</Text>
          </View>
        ) : (
          <View accessibilityLabel={`${preset.label} position list`} style={styles.slotList}>
            {preset.slots.map((surfaceSlot) => {
              const placement = placements.find((row) => row.slotId === surfaceSlot.id);
              const participant = placement ? rosterById.get(placement.participantId) : undefined;
              const selected = participant?.id === selectedParticipantId;
              return (
                <Pressable
                  key={surfaceSlot.id}
                  accessibilityRole="button"
                  accessibilityLabel={selected && participant ? `${participant.displayName} at ${surfaceSlot.label}, selected` : `Place ${selectedParticipant.displayName} at ${surfaceSlot.label}`}
                  accessibilityHint={selected ? 'This participant is selected.' : 'Moves the selected participant to this position.'}
                  accessibilityState={{ selected }}
                  onPress={() => placeSelectedAtSlot(surfaceSlot.id)}
                  style={[styles.slotRow, selected ? styles.slotRowSelected : null]}
                >
                  <View style={styles.slotCopy}>
                    <Text style={styles.slotLabel}>{surfaceSlot.label}</Text>
                    <Text style={styles.slotName}>{participant?.displayName ?? 'Open position'}</Text>
                  </View>
                  <Text style={styles.slotAction}>{selected ? 'Selected' : 'Place here'}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text accessibilityRole="header" style={styles.rosterHeading}>Synthetic roster · 30</Text>
        <View style={styles.rosterList}>
          {roster.map((participant) => {
            const selected = participant.id === selectedParticipantId;
            const active = activeParticipantIds.has(participant.id);
            return (
              <Pressable
                key={participant.id}
                accessibilityRole="button"
                accessibilityLabel={`${participant.displayName}, synthetic roster participant ${participant.jerseyNumber}`}
                accessibilityHint={active ? 'Select this placed participant.' : 'Select this bench participant to place.'}
                accessibilityState={{ selected }}
                onPress={() => {
                  setSelectedParticipantId(participant.id);
                  setAnnouncement(`${participant.displayName} selected from the ${active ? 'active unit' : 'bench'}.`);
                }}
                style={[styles.rosterRow, selected ? styles.rosterRowSelected : null]}
              >
                <Text style={styles.jersey}>#{participant.jerseyNumber}</Text>
                <Text style={styles.rosterName}>{participant.displayName}</Text>
                <Text style={styles.rosterStatus}>{active ? 'Active' : 'Bench'}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: 0 },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  title: { ...type.display, color: colors.text },
  devBadge: { ...type.tiny, alignSelf: 'flex-start', color: colors.primaryDark, backgroundColor: colors.primarySoft, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, letterSpacing: 0.6 },
  intro: { ...type.body, color: colors.textMuted },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  choiceSelected: { borderColor: colors.primary, backgroundColor: colors.primary },
  choiceText: { ...type.bodyMedium, color: colors.text },
  choiceTextSelected: { color: colors.white },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', gap: spacing.sm },
  summaryText: { minWidth: 150, flex: 1, justifyContent: 'center' },
  sectionLabel: { ...type.h2, color: colors.text },
  capacity: { ...type.caption, color: colors.textMuted, marginTop: spacing.xs },
  selectedCard: { minWidth: 190, flex: 1, backgroundColor: colors.accentSoft, borderRadius: radius.md, padding: spacing.md },
  selectedEyebrow: { ...type.tiny, color: colors.warning, textTransform: 'uppercase' },
  selectedName: { ...type.bodyMedium, color: colors.text, marginTop: spacing.xs },
  announcement: { ...type.caption, color: colors.primaryDark, backgroundColor: colors.primarySoft, borderRadius: radius.sm, padding: spacing.sm },
  surfaceCenter: { alignItems: 'center', gap: spacing.sm },
  surface: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.primary, ...shadow.card },
  marker: { position: 'absolute', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 2, borderColor: colors.primaryDark, ...shadow.button },
  markerSelected: { borderWidth: 4, borderColor: colors.accent, backgroundColor: colors.accentSoft, transform: [{ scale: 1.12 }] },
  markerNumber: { fontFamily: fonts.bold, fontSize: 14, color: colors.primaryDark },
  dragHelp: { ...type.caption, maxWidth: 560, color: colors.textMuted, textAlign: 'center' },
  slotList: { gap: spacing.sm },
  slotRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.card, padding: spacing.md },
  slotRowSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  slotCopy: { flex: 1, minWidth: 0 },
  slotLabel: { ...type.label, color: colors.textMuted },
  slotName: { ...type.bodyMedium, color: colors.text, marginTop: spacing.xs },
  slotAction: { ...type.caption, color: colors.primary, flexShrink: 0 },
  rosterHeading: { ...type.h2, color: colors.text, marginTop: spacing.sm },
  rosterList: { gap: spacing.sm },
  rosterRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rosterRowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  jersey: { ...type.label, width: 34, color: colors.primary },
  rosterName: { ...type.body, flex: 1, minWidth: 0, color: colors.text },
  rosterStatus: { ...type.caption, color: colors.textMuted, flexShrink: 0 },
});
