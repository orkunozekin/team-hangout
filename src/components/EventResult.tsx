import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { EventResults, KnockoutDecider, ResultOutcome } from '../../shared/competition';
import { DECIDER_LABELS, describeResult, KNOCKOUT_DECIDERS_ALL, tiedNeedsDecider } from '../../shared/competition';
import { getEventResults, proposeResult } from '../firebase/competition';
import { lineupRequestId } from '../firebase/lineups';
import { draftFromValues, resultError, resultFromDraft, scoresTied, type ResultDraft, type ResultErrorKind } from '../lib/competition/resultDraft';
import { colors, radius, spacing, type } from '../theme/theme';
import { FieldLabel, PrimaryButton, SecondaryButton, TextField } from './ui';

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
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{text ?? label}</Text>
    </Pressable>
  );
}

const OUTCOMES: { id: ResultOutcome; label: string }[] = [
  { id: 'played', label: 'Played' },
  { id: 'forfeit', label: 'Forfeit' },
  { id: 'void', label: 'Void' },
];

type Competition = EventResults['competitions'][number];

function CompetitionResult({ data, competition, onChanged }: { data: EventResults; competition: Competition; onChanged: () => Promise<void> }) {
  const result = competition.result;
  const [draft, setDraft] = useState<ResultDraft>(() => draftFromValues(result?.proposal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: ResultErrorKind; message: string } | null>(null);
  const [status, setStatus] = useState('');
  const requestId = useRef<string | null>(null);
  const home = data.homeTeamId!;
  const away = data.awayTeamId!;
  const name = (teamId: string) => data.teams?.find((team) => team.teamId === teamId)?.name ?? 'Unavailable team';
  const update = (patch: Partial<ResultDraft>) => {
    // The request ID belongs to the submitted values; edits are locked while a proposal is in flight or uncertain.
    if (busy || error?.kind === 'offline') return;
    requestId.current = null;
    setDraft((current) => ({ ...current, ...patch }));
  };

  if (result?.status === 'final' && result.final) {
    return (
      <View style={styles.card}>
        <Text style={styles.subheading}>{competition.name}</Text>
        <Text style={styles.final}>{`Final: ${describeResult(result.final, name)}`}</Text>
        {result.final.correctedAt ? <Text style={styles.copy}>Corrected by a scorer.</Text> : null}
        <Text style={styles.copy}>Final results are changed only by a competition scorer with a reason.</Text>
      </View>
    );
  }

  const built = resultFromDraft(draft, competition.format, competition.rules);
  const needsDecider = draft.outcome === 'played' && scoresTied(draft) && tiedNeedsDecider(competition.format, competition.rules);
  const locked = busy || error?.kind === 'offline';
  const deciders: KnockoutDecider[] = competition.rules ? competition.rules.knockoutDeciders : KNOCKOUT_DECIDERS_ALL;

  const submit = async () => {
    if (busy || 'error' in built) return;
    setBusy(true);
    setError(null);
    requestId.current ??= lineupRequestId();
    try {
      await proposeResult(data.orgId, competition.competitionId, data.eventId, data.teamId, result?.revision ?? 0, built.values, requestId.current);
      requestId.current = null;
      setStatus('Result proposed. A competition scorer will finalize it.');
      await onChanged();
    } catch (e) {
      const failure = resultError(e);
      // Keep the same request ID only when the outcome is uncertain so a retry cannot record twice.
      if (failure.kind !== 'offline') requestId.current = null;
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.subheading}>{competition.name}</Text>
      <Text style={styles.copy}>{competition.format === 'knockout' ? 'Knockout' : 'League'}{competition.rules ? ` · Rules version ${competition.rules.version}` : ' · Rules not confirmed yet'}</Text>
      {result?.proposal ? (
        <Text style={styles.pending}>{`Pending proposal: ${describeResult(result.proposal, name)}. Waiting for a scorer to finalize.`}</Text>
      ) : (
        <Text style={styles.copy}>No result proposed yet.</Text>
      )}
      <FieldLabel>Outcome</FieldLabel>
      <View style={styles.wrap}>
        {OUTCOMES.map((item) => (
          <Chip key={item.id} label={`Outcome ${item.label}`} text={item.label} selected={draft.outcome === item.id} onPress={() => update({ outcome: item.id })} />
        ))}
      </View>
      {draft.outcome === 'played' ? (
        <View style={styles.scores}>
          <View style={styles.score}>
            <FieldLabel>{name(home)}</FieldLabel>
            <TextField editable={!locked} accessibilityLabel={`${name(home)} score`} keyboardType="number-pad" value={draft.homeScore} onChangeText={(value) => update({ homeScore: value })} />
          </View>
          <View style={styles.score}>
            <FieldLabel>{name(away)}</FieldLabel>
            <TextField editable={!locked} accessibilityLabel={`${name(away)} score`} keyboardType="number-pad" value={draft.awayScore} onChangeText={(value) => update({ awayScore: value })} />
          </View>
        </View>
      ) : null}
      {needsDecider ? (
        <>
          <FieldLabel>Winner</FieldLabel>
          <View style={styles.wrap}>
            {[home, away].map((teamId) => (
              <Chip key={teamId} label={`Winner ${name(teamId)}`} text={name(teamId)} selected={draft.winnerTeamId === teamId} onPress={() => update({ winnerTeamId: teamId })} />
            ))}
          </View>
          <FieldLabel>Decided by</FieldLabel>
          <View style={styles.wrap}>
            {deciders.map((decider) => (
              <Chip key={decider} label={`Decided by ${DECIDER_LABELS[decider]}`} text={DECIDER_LABELS[decider]} selected={draft.decider === decider} onPress={() => update({ decider })} />
            ))}
          </View>
        </>
      ) : null}
      {draft.outcome === 'forfeit' ? (
        <>
          <FieldLabel>Team that forfeited</FieldLabel>
          <View style={styles.wrap}>
            {[home, away].map((teamId) => (
              <Chip key={teamId} label={`Forfeited ${name(teamId)}`} text={name(teamId)} selected={draft.forfeitingTeamId === teamId} onPress={() => update({ forfeitingTeamId: teamId })} />
            ))}
          </View>
          <Text style={styles.copy}>The forfeit score comes from the confirmed league rules.</Text>
        </>
      ) : null}
      {draft.outcome === 'void' ? <Text style={styles.copy}>A void result counts for nothing. Use it for cancelled or abandoned matches.</Text> : null}
      {'error' in built && (draft.homeScore || draft.awayScore || draft.outcome !== 'played') ? <Text style={styles.hint}>{built.error}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
      {status ? <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text> : null}
      <PrimaryButton
        label={error?.kind === 'offline' ? 'Retry same proposal' : result?.proposal ? 'Replace proposal' : 'Propose result'}
        loading={busy}
        disabled={'error' in built}
        onPress={() => void submit()}
      />
      {error?.kind === 'offline' ? <SecondaryButton label="Discard and reload" onPress={() => { requestId.current = null; setError(null); void onChanged(); }} /> : null}
      {error?.kind === 'conflict' ? <SecondaryButton label="Reload result" onPress={() => { setError(null); void onChanged(); }} /> : null}
    </View>
  );
}

function ResultPanel({ eventId, teamId }: { eventId: string; teamId: string }) {
  const [data, setData] = useState<EventResults | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getEventResults(eventId, teamId));
      setGeneration((value) => value + 1);
      setError('');
    } catch (e) {
      setError(resultError(e).message);
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  if (!data) {
    return (
      <View>
        {loading ? <ActivityIndicator accessibilityLabel="Loading results" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {error ? <SecondaryButton label="Retry loading results" onPress={() => void load()} /> : null}
      </View>
    );
  }
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Match result</Text>
      <Text style={styles.copy}>Coaches propose. A competition scorer finalizes the official result.</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{`${error} Showing the last loaded result.`}</Text> : null}
      {error ? <SecondaryButton label="Retry loading results" onPress={() => void load()} /> : null}
      {data.externalOpponent ? <Text style={styles.copy}>This game has an external opponent, so it is not part of a league competition.</Text> : null}
      {!data.externalOpponent && data.competitions.length === 0 ? <Text style={styles.copy}>This match is not part of a competition.</Text> : null}
      {data.competitions.map((competition) => (
        <CompetitionResult key={`${competition.competitionId}:${generation}`} data={data} competition={competition} onChanged={load} />
      ))}
    </View>
  );
}

/** Coach-only score proposal for canonical match events. Nothing is queued offline. */
export default function EventResult({ eventId, teamId, initiallyOpen = false }: { eventId: string; teamId: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <SecondaryButton label={open ? 'Hide match result' : 'Match result'} onPress={() => setOpen((value) => !value)} />
      {open ? <ResultPanel eventId={eventId} teamId={teamId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  final: { ...type.h2, color: colors.text, marginVertical: spacing.xs },
  pending: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.sm, overflow: 'hidden' },
  hint: { ...type.body, color: colors.textMuted, marginVertical: spacing.xs },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  status: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.sm },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  scores: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  score: { flexGrow: 1, flexBasis: 140 },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
});
