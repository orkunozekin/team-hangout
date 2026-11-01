import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { BracketNodeView, EventBracket as EventBracketData } from '../../shared/competition';
import { bracketNodeStatus, roundLabel } from '../../shared/competition';
import { getEventBracket } from '../firebase/competition';
import { colors, radius, spacing, type } from '../theme/theme';
import { Accordion, SecondaryButton, CHIP_MAX_FONT_SCALE } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

function Game({ node, ownTeamId, names }: { node: BracketNodeView; ownTeamId: string; names: (teamId: string) => string }) {
  const own = node.teams.some((team) => team?.teamId === ownTeamId);
  const side = (slot: number) => {
    const team = node.teams[slot];
    if (!team) return node.bye ? 'Bye' : 'To be decided';
    return `${team.seed !== null ? `(${team.seed}) ` : ''}${team.name}${team.teamId === ownTeamId ? ' (your team)' : ''}`;
  };
  const status = bracketNodeStatus(node, names);
  return (
    <View accessible accessibilityLabel={`${side(0)} versus ${side(1)}. ${status}`} style={[styles.game, own ? styles.own : null, node.bye ? styles.bye : null]}>
      <Text style={node.winnerTeamId && node.teams[0]?.teamId === node.winnerTeamId && !node.bye ? styles.winner : styles.team}>{side(0)}</Text>
      <Text style={node.winnerTeamId && node.teams[1]?.teamId === node.winnerTeamId ? styles.winner : styles.team}>{side(1)}</Text>
      <Text style={node.winnerPending ? styles.pending : styles.copy}>{status}</Text>
    </View>
  );
}

function BracketPanel({ eventId, teamId }: { eventId: string; teamId: string }) {
  const [data, setData] = useState<EventBracketData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  // Only the latest request may change what is shown.
  const request = useRef(0);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async (competitionId?: string) => {
    const seq = ++request.current;
    const current = () => live.current && seq === request.current;
    setLoading(true);
    setError('');
    try {
      const value = await getEventBracket(eventId, teamId, competitionId);
      if (current()) setData(value);
    } catch {
      if (current()) setError('The bracket could not be loaded.');
    } finally {
      if (current()) setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  const view = data?.bracket ?? null;
  const names = (id: string) => view?.nodes.flatMap((node) => node.teams).find((team) => team?.teamId === id)?.name ?? 'another team';
  const rounds = view?.bracket?.rounds ?? 0;
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Bracket</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{data ? `${error} Showing the last loaded bracket.` : error}</Text> : null}
      {data && data.competitions.length === 0 ? <Text style={styles.copy}>This team is not in a published bracket.</Text> : null}
      {data && data.competitions.length > 1 ? (
        <View style={styles.wrap}>
          {data.competitions.map((item) => {
            const selected = item.competitionId === view?.competitionId;
            return (
              <Pressable key={item.competitionId} accessibilityRole="button" accessibilityLabel={`Show ${item.name}`} accessibilityState={{ selected }}
                onPress={() => void load(item.competitionId)} style={[styles.chip, selected ? styles.chipSelected : null]}>
                <Text maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{item.name}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {view?.bracket ? <>
        <Text style={styles.subheading}>{view.name}</Text>
        <Text style={styles.copy}>Winners advance only from final results. A bye has no game.</Text>
        {Array.from({ length: rounds }, (_, i) => i + 1).map((round) => (
          <View key={round}>
            <Text accessibilityRole="header" style={styles.round}>{roundLabel(round, rounds)}</Text>
            {view.nodes.filter((node) => node.round === round).map((node) => <Game key={node.nodeId} node={node} ownTeamId={teamId} names={names} />)}
          </View>
        ))}
      </> : null}
      {data ? <SecondaryButton label="Refresh bracket" disabled={loading} onPress={() => void load(view?.competitionId)} /> : null}
      {!data && error ? <SecondaryButton label="Retry loading bracket" onPress={() => void load()} /> : null}
      {loading ? <ActivityIndicator accessibilityLabel="Loading bracket" /> : null}
    </View>
  );
}

/** Published bracket for viewers of this team. Nothing is cached offline. */
export default function EventBracket({ eventId, teamId, initiallyOpen = false }: { eventId: string; teamId: string; initiallyOpen?: boolean }) {
  return (
    <View style={styles.section}>
      <Accordion title="Bracket" initiallyOpen={initiallyOpen}>
        <BracketPanel eventId={eventId} teamId={teamId} />
      </Accordion>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  round: { ...type.label, color: colors.text, marginTop: spacing.sm },
  copy: { ...type.body, color: colors.textMuted, marginTop: spacing.xs },
  pending: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.xs, marginTop: spacing.xs, overflow: 'hidden' },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  game: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  bye: { borderStyle: 'dashed' },
  own: { borderColor: colors.primary, borderWidth: 2 },
  team: { ...type.body, color: colors.text },
  winner: { ...type.bodyMedium, color: colors.text, fontWeight: '700' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
});
