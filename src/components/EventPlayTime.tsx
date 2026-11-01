import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { PlayActionPayload, PlayActionRecord, PlaySession } from '../../shared/playTime';
import { PLAY_CORRECTION_REASON_MAX } from '../../shared/playTime';
import { finalizePlaySession, getPlaySession, recordPlayAction } from '../firebase/playTime';
import { getSportPreset } from '../lib/coaching/lineupSurface';
import {
  estimateElapsedMs,
  formatGameClock,
  parseGameClock,
  playError,
  STATUS_LABELS,
  type PlayErrorKind,
} from '../lib/coaching/playClock';
import { colors, radius, spacing, type } from '../theme/theme';
import { DestructiveButton, Accordion, FieldLabel, PrimaryButton, SecondaryButton, TextField, CHIP_MAX_FONT_SCALE } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

function Chip({ label, text, selected, onPress }: { label: string; text?: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      <Text maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{text ?? label}</Text>
    </Pressable>
  );
}

type Substitution = { sequence: number; period: number; atElapsedMs: number; unitId: string; outParticipantId: string; inParticipantId: string; corrected: boolean };

/** Applies the latest correction to each substitution for display. Raw actions stay unchanged on the server. */
function substitutions(actions: PlayActionRecord[]): Substitution[] {
  const ordered = [...actions].sort((a, b) => a.sequence - b.sequence);
  const subs = new Map<number, Substitution>();
  for (const action of ordered) {
    if (action.kind === 'substitute') {
      subs.set(action.sequence, {
        sequence: action.sequence, period: action.period, atElapsedMs: action.atElapsedMs, unitId: action.unitId!,
        outParticipantId: action.outParticipantId!, inParticipantId: action.inParticipantId!, corrected: false,
      });
    } else if (action.kind === 'correct' && action.corrected && subs.has(action.targetSequence!)) {
      subs.set(action.targetSequence!, { ...subs.get(action.targetSequence!)!, ...action.corrected, corrected: true });
    }
  }
  return [...subs.values()].reverse();
}

const IN_PROGRESS = ['running', 'paused', 'periodBreak'];
const REFRESH_MS = 30_000;

type CorrectionDraft = { atElapsedMs: number; outParticipantId: string; inParticipantId: string; reason: string };

/** Owns its draft so the panel's one-second clock tick never re-renders the inputs mid-keystroke. */
const CorrectionForm = memo(function CorrectionForm({ substitution, roster, busy, onSave, onCancel }: {
  substitution: Substitution;
  roster: PlaySession['roster'];
  busy: boolean;
  onSave: (draft: CorrectionDraft) => void;
  onCancel: () => void;
}) {
  const [correctedTime, setCorrectedTime] = useState(() => formatGameClock(substitution.atElapsedMs));
  const [correctedOut, setCorrectedOut] = useState(substitution.outParticipantId);
  const [correctedIn, setCorrectedIn] = useState(substitution.inParticipantId);
  const [reason, setReason] = useState('');
  const correctionMs = parseGameClock(correctedTime);
  return (
    <View style={styles.correction}>
      <Text style={styles.subheading}>{`Correct substitution at ${formatGameClock(substitution.atElapsedMs)}`}</Text>
      <FieldLabel>Game time (m:ss)</FieldLabel>
      <TextField accessibilityLabel="Corrected game time" value={correctedTime} onChangeText={setCorrectedTime} />
      <FieldLabel>Who left</FieldLabel>
      <View style={styles.wrap}>
        {roster.map((entry) => (
          <Chip key={entry.participantId} label={`Left: ${entry.displayName}`} text={entry.displayName} selected={correctedOut === entry.participantId} onPress={() => setCorrectedOut(entry.participantId)} />
        ))}
      </View>
      <FieldLabel>Who entered</FieldLabel>
      <View style={styles.wrap}>
        {roster.filter((entry) => entry.participantId !== correctedOut).map((entry) => (
          <Chip key={entry.participantId} label={`Entered: ${entry.displayName}`} text={entry.displayName} selected={correctedIn === entry.participantId} onPress={() => setCorrectedIn(entry.participantId)} />
        ))}
      </View>
      <FieldLabel>Reason</FieldLabel>
      <TextField accessibilityLabel="Correction reason" maxLength={PLAY_CORRECTION_REASON_MAX} value={reason} onChangeText={setReason} placeholder="Required for the audit history" />
      {correctionMs === null ? <Text style={styles.error}>Enter the time as minutes:seconds.</Text> : null}
      <PrimaryButton
        label="Save correction"
        loading={busy}
        disabled={!reason.trim() || correctionMs === null || !correctedIn || correctedIn === correctedOut}
        onPress={() => onSave({ atElapsedMs: correctionMs!, outParticipantId: correctedOut, inParticipantId: correctedIn, reason: reason.trim() })}
      />
      <SecondaryButton label="Cancel correction" onPress={onCancel} />
    </View>
  );
});

function PlayTimePanel({ orgId, eventId, teamId }: { orgId: string; eventId: string; teamId: string }) {
  const [session, setSession] = useState<PlaySession | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: PlayErrorKind; message: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState('');
  const [periodCount, setPeriodCount] = useState(2);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<Substitution | null>(null);
  const [older, setOlder] = useState<{ actions: PlayActionRecord[]; before: number | null } | null>(null);
  const saveCorrectionRef = useRef<(draft: CorrectionDraft) => void>(() => undefined);
  const saveCorrection = useCallback((draft: CorrectionDraft) => saveCorrectionRef.current(draft), []);
  const cancelCorrection = useCallback(() => setCorrecting(null), []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await getPlaySession(eventId, teamId);
      setSession(result);
      setReceivedAt(Date.now());
      setNow(Date.now());
      setStale(false);
      setLeaving(null);
      setOlder(null);
      setError(null);
    } catch (e) {
      const failure = playError(e);
      setError(failure.kind === 'offline' ? { kind: 'offline', message: 'Playing time could not be refreshed. Reconnect, then reload.' } : failure);
      if (failure.kind === 'offline') setStale(true);
    } finally {
      setBusy(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  // Read-only refresh so another coach's actions appear and a lost connection is labeled stale.
  const inGame = !!session && IN_PROGRESS.includes(session.status);
  useEffect(() => {
    if (!inGame) return undefined;
    const timer = setInterval(() => {
      getPlaySession(eventId, teamId)
        .then((result) => {
          setSession(result);
          setReceivedAt(Date.now());
          setNow(Date.now());
          setStale(false);
          setOlder(null);
        })
        .catch(() => setStale(true));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [inGame, eventId, teamId]);

  const loadOlder = async (before: number) => {
    setBusy(true);
    try {
      const page = await getPlaySession(eventId, teamId, before);
      setOlder((current) => ({ actions: [...(current?.actions ?? []), ...page.actions], before: page.olderBeforeSequence }));
    } catch (e) {
      setError(playError(e).kind === 'offline' ? { kind: 'offline', message: 'Earlier actions could not load. Reconnect, then try again.' } : playError(e));
    } finally {
      setBusy(false);
    }
  };

  // Render-only tick while visible and running. It never writes; background resume recomputes from the anchor.
  const running = session?.status === 'running' && !stale;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const names = useMemo(() => new Map((session?.roster ?? []).map((entry) => [entry.participantId, entry])), [session]);
  const nameOf = (participantId: string) => names.get(participantId)?.displayName ?? 'Unavailable participant';

  if (!session) {
    return (
      <View>
        {busy ? <ActivityIndicator accessibilityLabel="Loading playing time" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
        {error ? <SecondaryButton label="Retry loading playing time" onPress={() => void load()} /> : null}
      </View>
    );
  }

  const mutate = async (call: () => Promise<{ affectedParticipantIds?: string[] }>, message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setStatus(result.affectedParticipantIds?.length
        ? `${message} Review playing time for ${result.affectedParticipantIds.map(nameOf).join(', ')}.`
        : message);
      setCorrecting(null);
      setBusy(false);
      await load();
    } catch (e) {
      const failure = playError(e);
      setError(failure);
      if (failure.kind === 'offline') setStale(true);
      setBusy(false);
    }
  };
  const record = (action: PlayActionPayload, message: string) =>
    mutate(() => recordPlayAction(orgId, eventId, teamId, session.revision, action), message);
  saveCorrectionRef.current = (draft) => {
    if (correcting) void record({ kind: 'correct', targetSequence: correcting.sequence, ...draft }, 'Correction recorded.');
  };

  const elapsed = estimateElapsedMs(session, receivedAt, stale ? receivedAt : now);
  const preset = session.sportPresetId ? getSportPreset(session.sportPresetId) : null;
  const unitLabel = (unitId: string) => preset?.units.find((unit) => unit.id === unitId)?.label ?? unitId;
  const active = session.units.find((unit) => unit.unitId === session.activeUnitId);
  const inProgress = IN_PROGRESS.includes(session.status);
  const counting = session.status === 'running' || session.status === 'paused';
  const onField = new Set(counting ? active?.participantIds ?? [] : []);
  const bench = session.roster.filter((entry) => entry.available && !active?.participantIds.includes(entry.participantId));
  const subs = substitutions([...session.actions, ...(older?.actions ?? [])]);
  const olderCursor = older ? older.before : session.olderBeforeSequence;
  const extra = elapsed - session.elapsedMs;
  const periodLabel = session.periodCount ? ` · Period ${session.currentPeriod} of ${session.periodCount}` : '';

  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Playing time</Text>
      <Text style={styles.copy}>Coaches only. Families cannot see individual playing time.</Text>
      <Text accessibilityRole="timer" accessibilityLiveRegion="polite" style={styles.clock}>
        {`${STATUS_LABELS[session.status]}${periodLabel} · ${formatGameClock(elapsed)}`}
      </Text>
      {stale ? (
        <Text style={styles.badge}>{`Offline or not refreshed. Showing the last confirmed clock from ${new Date(receivedAt).toLocaleTimeString()}. Actions are not recorded until you reconnect.`}</Text>
      ) : null}

      {session.status === 'notStarted' ? (
        session.lineupRevision === 0 ? <Text style={styles.copy}>Save a lineup before starting the clock.</Text> : (
          <>
            <FieldLabel>Periods</FieldLabel>
            <View style={styles.wrap}>
              {[1, 2, 3, 4].map((count) => (
                <Chip key={count} label={`${count} period${count === 1 ? '' : 's'}`} text={String(count)} selected={periodCount === count} onPress={() => setPeriodCount(count)} />
              ))}
            </View>
            <PrimaryButton label="Start game clock" loading={busy} onPress={() => void record({ kind: 'start', periodCount }, 'Clock started.')} />
          </>
        )
      ) : null}
      {session.status === 'running' ? <SecondaryButton label="Pause clock" disabled={busy} onPress={() => void record({ kind: 'pause' }, 'Clock paused.')} /> : null}
      {session.status === 'paused' ? <SecondaryButton label="Resume clock" disabled={busy} onPress={() => void record({ kind: 'resume' }, 'Clock resumed.')} /> : null}
      {counting ? <SecondaryButton label={`End period ${session.currentPeriod}`} disabled={busy} onPress={() => void record({ kind: 'endPeriod' }, `Period ${session.currentPeriod} ended.`)} /> : null}
      {session.status === 'periodBreak' ? (
        <PrimaryButton label={`Start period ${session.currentPeriod + 1}`} loading={busy} onPress={() => void record({ kind: 'start' }, `Period ${session.currentPeriod + 1} started.`)} />
      ) : null}
      {session.status === 'ended' ? (
        <DestructiveButton label="Finalize playing time" loading={busy} confirm={{ title: 'Finalize playing time?', message: 'Final totals are locked and can no longer be corrected.', confirmLabel: 'Finalize' }} onPress={() => void mutate(() => finalizePlaySession(orgId, eventId, teamId, session.revision), 'Playing time finalized.')} />
      ) : null}
      {session.status === 'finalized' ? <Text style={styles.copy}>Final totals are locked.</Text> : null}

      {inProgress && session.units.length > 1 ? (
        <>
          <Text style={styles.subheading}>Active unit</Text>
          <View style={styles.wrap}>
            {session.units.map((unit) => (
              <Chip
                key={unit.unitId}
                label={unit.unitId === session.activeUnitId ? `${unitLabel(unit.unitId)} active` : `Switch to ${unitLabel(unit.unitId)}`}
                text={unitLabel(unit.unitId)}
                selected={unit.unitId === session.activeUnitId}
                onPress={() => { if (unit.unitId !== session.activeUnitId) void record({ kind: 'switchUnit', unitId: unit.unitId }, `${unitLabel(unit.unitId)} on the field.`); }}
              />
            ))}
          </View>
        </>
      ) : null}

      {inProgress && active ? (
        <>
          <Text style={styles.subheading}>{`${unitLabel(active.unitId)}: tap who leaves, then who enters`}</Text>
          <View style={styles.wrap}>
            {active.participantIds.map((participantId) => (
              <Chip key={participantId} label={`Sub out ${nameOf(participantId)}`} text={nameOf(participantId)} selected={leaving === participantId} onPress={() => setLeaving(leaving === participantId ? null : participantId)} />
            ))}
          </View>
          {leaving ? (
            <View style={styles.wrap}>
              {bench.length ? bench.map((entry) => (
                <Chip
                  key={entry.participantId}
                  label={`Sub in ${entry.displayName} for ${nameOf(leaving)}`}
                  text={`In: ${entry.displayName}`}
                  onPress={() => void record(
                    { kind: 'substitute', unitId: active.unitId, outParticipantId: leaving, inParticipantId: entry.participantId },
                    `${entry.displayName} in for ${nameOf(leaving)}.`,
                  )}
                />
              )) : <Text style={styles.copy}>No available bench participants.</Text>}
            </View>
          ) : null}
        </>
      ) : null}

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
      {status && !error ? <Text accessibilityLiveRegion="polite" style={styles.copy}>{status}</Text> : null}
      <SecondaryButton label="Reload latest clock" disabled={busy} onPress={() => void load()} />

      <Text style={styles.subheading}>Totals</Text>
      {session.totals.length ? session.totals.map((row) => (
        <View key={row.participantId} style={styles.row}>
          <Text style={styles.name}>{row.displayName}</Text>
          <Text style={styles.total}>{formatGameClock(row.ms + (onField.has(row.participantId) ? extra : 0))}</Text>
        </View>
      )) : <Text style={styles.copy}>No playing time recorded yet.</Text>}

      {subs.length ? <Text style={styles.subheading}>Substitutions</Text> : null}
      {subs.map((sub) => (
        <View key={sub.sequence} style={styles.row}>
          <Text style={styles.name}>
            {`P${sub.period} ${formatGameClock(sub.atElapsedMs)} · ${nameOf(sub.inParticipantId)} in for ${nameOf(sub.outParticipantId)}${sub.corrected ? ' (corrected)' : ''}`}
          </Text>
          {session.status !== 'finalized' ? (
            <Chip label={`Correct substitution at ${formatGameClock(sub.atElapsedMs)}`} text="Correct" onPress={() => setCorrecting(sub)} />
          ) : null}
        </View>
      ))}
      {olderCursor ? <SecondaryButton label="Show earlier actions" disabled={busy} onPress={() => void loadOlder(olderCursor)} /> : null}
      {correcting ? (
        <CorrectionForm key={correcting.sequence} substitution={correcting} roster={session.roster} busy={busy} onSave={saveCorrection} onCancel={cancelCorrection} />
      ) : null}
    </View>
  );
}

/** Coach-only playing-time entry. Writes need online acknowledgment; nothing is queued offline. */
export default function EventPlayTime({ orgId, eventId, teamId, initiallyOpen = false }: { orgId: string; eventId: string; teamId: string; initiallyOpen?: boolean }) {
  return (
    <View style={styles.section}>
      <Accordion title="Playing time" initiallyOpen={initiallyOpen}>
        <PlayTimePanel orgId={orgId} eventId={eventId} teamId={teamId} />
      </Accordion>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  clock: { ...type.h2, color: colors.text, marginVertical: spacing.sm },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  badge: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.sm, overflow: 'hidden' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  name: { ...type.body, color: colors.text, flexGrow: 1, flexShrink: 1 },
  total: { ...type.bodyMedium, color: colors.text },
  correction: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
});
