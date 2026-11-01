import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { EventStandings as EventStandingsData, StandingsRow } from '../../shared/competition';
import { formatDifferential, STANDINGS_STATUS_LABELS, tieNote } from '../../shared/competition';
import { getEventStandings } from '../firebase/competition';
import { colors, radius, spacing, type } from '../theme/theme';
import { SecondaryButton, CHIP_MAX_FONT_SCALE } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

const domainCode = (error: unknown) => (error as { details?: { domainCode?: string } })?.details?.domainCode;

function Row({ row, ownTeamId, names }: { row: StandingsRow; ownTeamId: string; names: (teamId: string) => string }) {
  const rank = row.sharedRank ? `T-${row.rank}` : String(row.rank);
  const note = tieNote(row, names);
  const forfeits = row.forfeitWins || row.forfeitLosses ? `Forfeits: ${row.forfeitWins} won, ${row.forfeitLosses} lost` : null;
  const own = row.teamId === ownTeamId;
  const record = `Played ${row.played}, won ${row.wins}, drew ${row.draws}, lost ${row.losses}, differential ${formatDifferential(row.differential)}`;
  return (
    <View
      accessible
      accessibilityLabel={`Rank ${row.sharedRank ? `${row.rank}, shared` : row.rank}. ${row.teamName}${own ? ', your team' : ''}. ${row.points} ${row.points === 1 ? 'point' : 'points'}. ${record}.${note ? ` ${note}.` : ''}${forfeits ? ` ${forfeits}.` : ''}`}
      style={[styles.row, own ? styles.own : null]}
    >
      <View style={styles.rowHead}>
        <Text style={styles.rank}>{rank}</Text>
        <Text style={styles.team}>{row.teamName}{own ? ' (your team)' : ''}</Text>
        <Text style={styles.points}>{`${row.points} ${row.points === 1 ? 'pt' : 'pts'}`}</Text>
      </View>
      <Text style={styles.copy}>{`P ${row.played} · W ${row.wins} · D ${row.draws} · L ${row.losses} · ${row.scoresFor}-${row.scoresAgainst} · Diff ${formatDifferential(row.differential)}`}</Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {forfeits ? <Text style={styles.note}>{forfeits}</Text> : null}
    </View>
  );
}

function StandingsPanel({ eventId, teamId }: { eventId: string; teamId: string }) {
  const [data, setData] = useState<EventStandingsData | null>(null);
  const [rows, setRows] = useState<StandingsRow[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  // Every load or page request takes a sequence number; only the latest one may change what is shown.
  const request = useRef(0);
  useEffect(() => () => { live.current = false; }, []);
  const current = (seq: number) => live.current && seq === request.current;

  const load = useCallback(async (competitionId?: string) => {
    const seq = ++request.current;
    setLoading(true);
    setError('');
    try {
      const value = await getEventStandings(eventId, teamId, competitionId ? { competitionId } : {});
      if (!current(seq)) return;
      setData(value);
      setRows(value.standings?.rows ?? []);
    } catch {
      if (current(seq)) setError('Standings could not be loaded.');
    } finally {
      if (current(seq)) setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  const standings = data?.standings ?? null;
  const more = async () => {
    if (loading || !standings?.generation || !standings.nextCursor) return;
    const cursor = standings.nextCursor;
    const seq = ++request.current;
    setLoading(true);
    setError('');
    try {
      // Pinned to the generation already shown so pages never mix two tables.
      const value = await getEventStandings(eventId, teamId, { competitionId: standings.competitionId, generationId: standings.generation.generationId, cursor });
      if (!current(seq)) return;
      setRows((shown) => [...shown, ...(value.standings?.rows ?? [])]);
      setData((shown) => shown && value.standings ? { ...shown, standings: { ...shown.standings!, nextCursor: value.standings.nextCursor } } : shown);
    } catch (reason) {
      if (!current(seq)) return;
      if (domainCode(reason) === 'STANDINGS_CHANGED') {
        setNotice('Standings were updated. Showing the latest table from the top.');
        await load(standings.competitionId);
        return;
      }
      setError('More standings could not be loaded.');
    } finally {
      if (current(seq)) setLoading(false);
    }
  };

  if (!data) {
    return (
      <View>
        {loading ? <ActivityIndicator accessibilityLabel="Loading standings" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {error ? <SecondaryButton label="Retry loading standings" onPress={() => void load()} /> : null}
      </View>
    );
  }
  const names = (id: string) => rows.find((row) => row.teamId === id)?.teamName ?? 'another team';
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Standings</Text>
      {data.competitions.length === 0 ? <Text style={styles.copy}>This team is not in a competition with published standings.</Text> : null}
      {data.competitions.length > 1 ? (
        <View style={styles.wrap}>
          {data.competitions.map((item) => {
            const selected = item.competitionId === standings?.competitionId;
            return (
              <Pressable key={item.competitionId} accessibilityRole="button" accessibilityLabel={`Show ${item.name}`} accessibilityState={{ selected }}
                onPress={() => { setNotice(''); void load(item.competitionId); }} style={[styles.chip, selected ? styles.chipSelected : null]}>
                <Text maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{item.name}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {notice ? <Text accessibilityRole="alert" style={styles.status}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{`${error} Showing the last loaded table.`}</Text> : null}
      {standings ? <>
        <Text style={styles.subheading}>{standings.name}</Text>
        <Text accessibilityRole={standings.status === 'current' ? undefined : 'alert'} style={standings.status === 'current' ? styles.copy : styles.pending}>
          {`${STANDINGS_STATUS_LABELS[standings.status]}${(standings.status === 'updating' || standings.status === 'stale') && standings.sourceUpdatedAt ? ` Latest result change ${new Date(standings.sourceUpdatedAt).toLocaleString()}.` : ''}`}
        </Text>
        {standings.generation ? <>
          <Text style={styles.copy}>{`From ${standings.generation.countedResults} final results. Tied teams share a rank; list order inside a tie is not a ranking.`}</Text>
          {rows.map((row) => <Row key={row.teamId} row={row} ownTeamId={teamId} names={names} />)}
          {standings.nextCursor ? <SecondaryButton label="Show more teams" disabled={loading} onPress={() => void more()} /> : null}
        </> : standings.status !== 'unconfirmed' ? <Text style={styles.copy}>No complete table yet.</Text> : null}
        <SecondaryButton label="Refresh standings" onPress={() => { setNotice(''); void load(standings.competitionId); }} />
      </> : null}
      {loading ? <ActivityIndicator accessibilityLabel="Loading standings" /> : null}
    </View>
  );
}

/** Published standings for viewers of this team. Shows only one complete generation; nothing is cached offline. */
export default function EventStandings({ eventId, teamId, initiallyOpen = false }: { eventId: string; teamId: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <SecondaryButton label={open ? 'Hide standings' : 'Standings'} onPress={() => setOpen((value) => !value)} />
      {open ? <StandingsPanel eventId={eventId} teamId={teamId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  note: { ...type.body, color: colors.text, marginTop: spacing.xs },
  pending: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.sm, overflow: 'hidden' },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  status: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.sm },
  row: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  own: { borderColor: colors.primary, borderWidth: 2 },
  rowHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing.sm },
  rank: { ...type.label, color: colors.text, minWidth: 36 },
  team: { ...type.bodyMedium, color: colors.text, flexShrink: 1, flexGrow: 1 },
  points: { ...type.label, color: colors.text },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
});
