import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
  View,
} from 'react-native';

import type { LineupPresetId, PrivateLineup, PublishedLineupView } from '../../shared/lineups';
import { LINEUP_NOTE_MAX } from '../../shared/lineups';
import {
  getLineup,
  getLineupView,
  lineupRequestId,
  publishLineup,
  saveLineup,
} from '../firebase/lineups';
import {
  addToBench,
  assignToSlot,
  changePreset,
  clearSlot,
  draftFromLineup,
  draftToPayload,
  lineupError,
  moveBench,
  removeFromBench,
  unassignedParticipants,
  type LineupDraft,
  type LineupErrorKind,
} from '../lib/coaching/lineupDraft';
import {
  denormalizePoint,
  getSportPreset,
  resolveSurfaceFrame,
  SPORT_PRESET_IDS,
  type SportPreset,
} from '../lib/coaching/lineupSurface';
import { colors, radius, spacing, type } from '../theme/theme';
import SurfaceMarkings from './LineupSurfaceMarkings';
import { FieldLabel, PrimaryButton, SecondaryButton, TextField } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

type Marker = { slotId: string; participantId: string; x: number; y: number; name: string; unavailable?: boolean };

/** Visual summary only. The position list below exposes every placement to assistive technology. */
function SurfacePreview({ preset, markers }: { preset: SportPreset; markers: Marker[] }) {
  const window = useWindowDimensions();
  // A compact preview keeps the accessible position list within reach on phones.
  const frame = resolveSurfaceFrame({ width: Math.min(window.width, 520), height: Math.min(window.height, 560), fontScale: window.fontScale }, preset);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.surface, { width: frame.width, height: frame.height }]}>
      <SurfaceMarkings preset={preset} frame={frame} />
      {markers.map((marker) => {
        const pixels = denormalizePoint(marker, frame);
        return (
          <View key={marker.slotId} style={[styles.marker, marker.unavailable ? styles.markerWarning : null, { left: pixels.x - 36, top: pixels.y - 11 }]}>
            <NativeText numberOfLines={1} maxFontSizeMultiplier={1.25} style={styles.markerText}>
              {marker.name.split(' ')[0]}
            </NativeText>
          </View>
        );
      })}
    </View>
  );
}

/** `text` is the short visible caption; `label` is always the full accessible name. */
function Chip({ label, text, selected, onPress, hint }: { label: string; text?: string; selected?: boolean; onPress: () => void; hint?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{text ?? label}</Text>
    </Pressable>
  );
}

function PublishedLineup({ eventId, teamId, participantId }: { eventId: string; teamId: string; participantId?: string }) {
  const [view, setView] = useState<PublishedLineupView | null>(null);
  const [error, setError] = useState('');
  // iOS keeps cached text measurements when Dynamic Type changes; remount text on scale change.
  const { fontScale } = useWindowDimensions();
  useEffect(() => {
    let live = true;
    getLineupView(eventId, teamId, participantId)
      .then((result) => { if (live) setView(result); })
      .catch((e) => {
        if (!live) return;
        const { kind, message } = lineupError(e);
        setError(kind === 'denied'
          ? 'Lineup access is unavailable for this team.'
          : kind === 'offline' ? 'Lineup unavailable while offline. Reconnect and reopen the lineup.' : message);
      });
    return () => { live = false; };
  }, [eventId, teamId, participantId]);
  if (error) return <Text accessibilityRole="alert" style={styles.error}>{error}</Text>;
  if (!view) return <ActivityIndicator accessibilityLabel="Loading lineup" />;
  if (view.state === 'unpublished') return <Text style={styles.copy}>The coach has not published a lineup for this event.</Text>;
  const preset = getSportPreset(view.sportPresetId);
  return (
    <View key={`text-scale-${fontScale}`}>
      <Text accessibilityRole="header" style={styles.heading}>Published lineup</Text>
      {view.units.map((unit) => {
        const definition = preset.units.find((candidate) => candidate.id === unit.unitId);
        return (
          <View key={unit.unitId}>
            <Text style={styles.subheading}>{definition?.label ?? unit.unitId}</Text>
            <SurfacePreview preset={preset} markers={unit.slots.map((slot) => ({ ...slot, name: slot.displayName }))} />
            {unit.slots.map((slot) => (
              <Text key={slot.slotId} style={styles.copy}>
                {`${definition?.slots.find((s) => s.id === slot.slotId)?.label ?? slot.slotId}: ${slot.displayName}`}
              </Text>
            ))}
          </View>
        );
      })}
      <Text style={styles.subheading}>Bench</Text>
      {view.bench.length
        ? view.bench.map((entry, index) => <Text key={entry.participantId} style={styles.copy}>{`${index + 1}. ${entry.displayName}`}</Text>)
        : <Text style={styles.copy}>No bench order published.</Text>}
    </View>
  );
}

function LineupEditor({ orgId, eventId, teamId, onDenied }: { orgId: string; eventId: string; teamId: string; onDenied: () => void }) {
  const [lineup, setLineup] = useState<PrivateLineup | null>(null);
  const { fontScale } = useWindowDimensions();
  const [draft, setDraft] = useState<LineupDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: LineupErrorKind; message: string } | null>(null);
  const [status, setStatus] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  // One ID per intended change, reused only when retrying that same change.
  const requestId = useRef<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await getLineup(eventId, teamId);
      const next = draftFromLineup(result);
      setLineup(result);
      setDraft(next);
      setDirty(false);
      setUnitId(getSportPreset(next.sportPresetId).units[0].id);
      setSelected(null);
      setRefreshFailed(false);
      requestId.current = null;
    } catch (e) {
      const failure = lineupError(e);
      if (failure.kind === 'denied') onDenied();
      else {
        setError(failure);
        setRefreshFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }, [eventId, teamId, onDenied]);

  useEffect(() => { void load(); }, [load]);

  const names = useMemo(() => new Map((lineup?.roster ?? []).map((entry) => [entry.participantId, entry])), [lineup]);
  const nameOf = (participantId: string) => names.get(participantId)?.displayName ?? 'Unavailable participant';
  const isUnavailable = (participantId: string) => names.get(participantId)?.available !== true;

  if (!lineup || !draft) {
    return (
      <View>
        {busy ? <ActivityIndicator accessibilityLabel="Loading lineup" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
        {error ? <SecondaryButton label="Retry loading lineup" onPress={() => void load()} /> : null}
      </View>
    );
  }

  const preset = getSportPreset(draft.sportPresetId);
  const unit = preset.units.find((candidate) => candidate.id === unitId) ?? preset.units[0];
  const placements = draft.units[unit.id] ?? [];
  const available = unassignedParticipants(draft, lineup.roster, unit.id);
  // Edits are frozen while a mutation and its refresh run, so the refresh cannot discard them.
  const update = (next: LineupDraft, message: string) => {
    if (busy) return;
    setDraft(next);
    setDirty(true);
    setStatus(message);
    requestId.current = null;
  };
  const publication = lineup.publication;
  const publishedStale = publication.state === 'published' && publication.sourceRevision !== lineup.revision;

  const save = async () => {
    requestId.current ??= lineupRequestId();
    setBusy(true);
    setError(null);
    try {
      const result = await saveLineup(orgId, eventId, lineup.revision, draftToPayload(draft, teamId), requestId.current);
      requestId.current = null;
      // Apply the acknowledged revision first so a failed refresh cannot leave stale state.
      setLineup((before) => before && { ...before, revision: result.revision });
      setDirty(false);
      setStatus(publication.state === 'published' ? 'Saved privately. Republish to update families.' : 'Lineup saved privately.');
      await load();
    } catch (e) {
      const failure = lineupError(e);
      // A retry after an uncertain transport failure must reuse the same request ID.
      if (failure.kind !== 'offline') requestId.current = null;
      setError(failure);
      setBusy(false);
    }
  };

  const changePublication = async (action: 'publish' | 'retract') => {
    setBusy(true);
    setError(null);
    try {
      const result = await publishLineup(orgId, eventId, teamId, lineup.revision, action, lineupRequestId());
      // Reflect the acknowledged publication even if the refresh below fails.
      setLineup((before) => before && {
        ...before,
        revision: result.revision,
        publication: result.state === 'published'
          ? { state: 'published', sourceRevision: result.revision, publishedAt: before.publication.publishedAt ?? new Date().toISOString() }
          : { state: 'private', sourceRevision: null, publishedAt: null },
      });
      setStatus(action === 'publish' ? 'Lineup published to families.' : 'Publication retracted. Families no longer see this lineup.');
      await load();
    } catch (e) {
      setError(lineupError(e));
      setBusy(false);
    }
  };

  return (
    <View key={`text-scale-${fontScale}`}>
      <Text accessibilityRole="header" style={styles.heading}>Private lineup</Text>
      <Text style={styles.copy}>
        Only assigned coaches see this lineup and its notes. RSVP and attendance never change it.
      </Text>
      <Text style={[styles.badge, publication.state === 'published' ? styles.badgePublished : null]}>
        {publication.state === 'private'
          ? 'Private. Families cannot see this lineup.'
          : publishedStale
            ? 'Published view is older than your saved lineup. Republish to update families.'
            : 'Published. Families see positions and bench order, never notes.'}
      </Text>
      {!lineup.roster.length ? (
        <Text style={styles.copy}>
          No active roster participants yet. Ask your administrator to add participants before building a lineup.
        </Text>
      ) : (
        <>
          <FieldLabel>Sport</FieldLabel>
          <View style={styles.wrap}>
            {SPORT_PRESET_IDS.map((id: LineupPresetId) => (
              <Chip
                key={id}
                label={getSportPreset(id).label}
                selected={draft.sportPresetId === id}
                onPress={() => {
                  if (id === draft.sportPresetId) return;
                  const next = changePreset(draft, id);
                  setUnitId(getSportPreset(id).units[0].id);
                  update(next, `${getSportPreset(id).label} selected. Positions were moved to the bench.`);
                }}
              />
            ))}
          </View>
          {preset.units.length > 1 ? (
            <>
              <FieldLabel>Unit</FieldLabel>
              <View style={styles.wrap}>
                {preset.units.map((candidate) => (
                  <Chip key={candidate.id} label={candidate.label} selected={candidate.id === unit.id} onPress={() => setUnitId(candidate.id)} />
                ))}
              </View>
            </>
          ) : null}
          <SurfacePreview
            preset={preset}
            markers={placements.map((p) => ({ ...p, ...p.point, name: nameOf(p.participantId), unavailable: isUnavailable(p.participantId) }))}
          />
          <Text accessibilityLiveRegion="polite" style={styles.copy}>
            {selected ? `Selected ${nameOf(selected)}. Choose a position or add to bench.` : status || 'Select a participant, then choose a position.'}
          </Text>
          <Text style={styles.subheading}>{`${unit.label} positions`}</Text>
          {unit.slots.map((slot) => {
            const placement = placements.find((p) => p.slotId === slot.id);
            const label = placement
              ? `${slot.label}: ${nameOf(placement.participantId)}${isUnavailable(placement.participantId) ? ', left the roster. Replace before saving' : ''}`
              : `${slot.label}: open`;
            return (
              <View key={slot.id} style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityHint={selected ? `Places ${nameOf(selected)} here.` : 'Select a participant first.'}
                  disabled={!selected}
                  onPress={() => {
                    if (!selected) return;
                    update(assignToSlot(draft, unit.id, slot.id, selected), `${nameOf(selected)} is now ${slot.label}.`);
                    setSelected(null);
                  }}
                  style={[styles.slot, placement && isUnavailable(placement.participantId) ? styles.slotWarning : null]}
                >
                  <Text style={styles.slotText}>{label}</Text>
                </Pressable>
                {placement ? (
                  <Chip label={`Clear ${slot.label}`} text="Clear" onPress={() => update(clearSlot(draft, unit.id, slot.id), `${slot.label} cleared.`)} />
                ) : null}
              </View>
            );
          })}
          <Text style={styles.subheading}>Available participants</Text>
          <View style={styles.wrap}>
            {available.length
              ? available.map((entry) => (
                <Chip
                  key={entry.participantId}
                  label={entry.displayName}
                  selected={selected === entry.participantId}
                  onPress={() => setSelected(selected === entry.participantId ? null : entry.participantId)}
                />
              ))
              : <Text style={styles.copy}>Everyone available is placed or on the bench.</Text>}
          </View>
          {selected ? (
            <SecondaryButton label={`Add ${nameOf(selected)} to bench`} onPress={() => { update(addToBench(draft, selected), `${nameOf(selected)} added to bench.`); setSelected(null); }} />
          ) : null}
          <Text style={styles.subheading}>Bench order</Text>
          {draft.bench.length ? draft.bench.map((participantId, index) => (
            <View key={participantId} style={styles.row}>
              <Text style={[styles.benchName, isUnavailable(participantId) ? styles.warningText : null]}>
                {`${index + 1}. ${nameOf(participantId)}${isUnavailable(participantId) ? ' (left the roster)' : ''}`}
              </Text>
              <Chip label={`Move ${nameOf(participantId)} up`} text="Up" onPress={() => update(moveBench(draft, participantId, -1), `${nameOf(participantId)} moved up.`)} />
              <Chip label={`Move ${nameOf(participantId)} down`} text="Down" onPress={() => update(moveBench(draft, participantId, 1), `${nameOf(participantId)} moved down.`)} />
              <Chip label={`Remove ${nameOf(participantId)} from bench`} text="Remove" onPress={() => update(removeFromBench(draft, participantId), `${nameOf(participantId)} removed from bench.`)} />
            </View>
          )) : <Text style={styles.copy}>No bench order yet.</Text>}
          <FieldLabel>Private coach note</FieldLabel>
          <TextField
            accessibilityLabel="Private coach note"
            multiline
            editable={!busy}
            maxLength={LINEUP_NOTE_MAX}
            value={draft.note}
            onChangeText={(note) => update({ ...draft, note }, 'Note edited.')}
            placeholder="Visible only to assigned coaches"
          />
        </>
      )}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
      {error?.kind === 'conflict' || refreshFailed ? <SecondaryButton label="Reload latest lineup" onPress={() => void load()} /> : null}
      {lineup.roster.length ? <PrimaryButton label={error?.kind === 'offline' ? 'Retry save' : 'Save lineup'} loading={busy} disabled={!dirty} onPress={() => void save()} /> : null}
      {lineup.revision > 0 && !dirty ? (
        <View style={styles.actions}>
          <SecondaryButton
            label={publication.state === 'private' ? 'Publish to families' : 'Republish to families'}
            disabled={busy || (publication.state === 'published' && !publishedStale)}
            onPress={() => void changePublication('publish')}
          />
          {publication.state === 'published' ? (
            <SecondaryButton label="Retract publication" disabled={busy} onPress={() => void changePublication('retract')} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Event/team lineup entry. Coaches edit privately; everyone else sees only an explicit publication. */
export default function EventLineup({
  orgId,
  eventId,
  teamId,
  canCoach,
  participantId,
  initiallyOpen = false,
}: {
  orgId: string;
  eventId: string;
  teamId: string;
  canCoach: boolean;
  participantId?: string;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [viewer, setViewer] = useState(!canCoach);
  const onDenied = useCallback(() => setViewer(true), []);
  return (
    <View style={styles.section}>
      <SecondaryButton label={open ? 'Hide lineup' : 'Team lineup'} onPress={() => setOpen((value) => !value)} />
      {open ? (
        viewer
          ? <PublishedLineup eventId={eventId} teamId={teamId} participantId={participantId} />
          : <LineupEditor orgId={orgId} eventId={eventId} teamId={teamId} onDenied={onDenied} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  badge: { ...type.label, color: colors.text, backgroundColor: colors.primarySoft, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.sm, overflow: 'hidden' },
  badgePublished: { backgroundColor: colors.accentSoft },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
  surface: { alignSelf: 'center', marginVertical: spacing.sm },
  marker: { position: 'absolute', width: 72, height: 22, borderRadius: radius.full, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary },
  markerWarning: { borderColor: colors.warning, backgroundColor: colors.warningBg },
  markerText: { ...type.tiny, color: colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  slot: { flexGrow: 1, flexShrink: 1, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.sm, backgroundColor: colors.card },
  slotWarning: { borderColor: colors.warning, backgroundColor: colors.warningBg },
  slotText: { ...type.body, color: colors.text },
  benchName: { ...type.body, color: colors.text, flexGrow: 1, flexShrink: 1 },
  warningText: { color: colors.warning },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
});
