import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { getMembershipsForUser, getTeam } from '../firebase/teams';
import { EmptyState, Screen, SecondaryButton, Title } from '../components/ui';
import { colors, fonts, spacing, type } from '../theme/theme';
import type { AppRole, Team, TeamMember } from '../types/models';
import TeamScreen from './TeamScreen';

export type TeamListEntry = { team: Team; membership: TeamMember };

export async function loadUserTeams(userId: string, active: TeamListEntry): Promise<TeamListEntry[]> {
  const memberships = await getMembershipsForUser(userId);
  const others = memberships.filter(m => m.teamId !== active.team.id);
  const teams = await Promise.allSettled(others.map(m => getTeam(m.teamId)));
  const entries: TeamListEntry[] = [active];
  teams.forEach((result, index) => {
    // A team we can no longer read is a revoked grant; it must not appear as a destination.
    if (result.status === 'fulfilled' && result.value) entries.push({ team: result.value, membership: others[index] });
  });
  return entries.sort((a, b) => a.team.name.localeCompare(b.team.name));
}

export default function TeamsScreen({
  userId,
  activeTeam,
  activeMembership,
  appRole,
  onOpenTeam,
}: {
  userId: string;
  activeTeam: Team;
  activeMembership: TeamMember;
  appRole?: AppRole;
  onOpenTeam: (entry: TeamListEntry) => void;
}) {
  const [entries, setEntries] = useState<TeamListEntry[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setError('');
    loadUserTeams(userId, { team: activeTeam, membership: activeMembership })
      .then(next => { if (active) setEntries(next); })
      .catch(() => {
        if (!active) return;
        // Fall back to the team the app already resolved so the screen stays usable offline.
        setEntries([{ team: activeTeam, membership: activeMembership }]);
        setError('Unable to load all of your teams. Check your connection and try again.');
      });
    return () => { active = false; };
  }, [userId, activeTeam, activeMembership, version]);

  const reload = useCallback(() => setVersion(v => v + 1), []);
  // Memberships change outside this screen, and the single-team shortcut has no refresh control.
  const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focused.current) reload();
    focused.current = true;
  }, [reload]));

  if (!entries) return <Screen><EmptyState message="Loading teams..." /></Screen>;

  if (entries.length === 1 && !error) {
    return <TeamScreen teamId={entries[0].team.id} membership={entries[0].membership} appRole={appRole} />;
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.list}>
        <Title>Your teams</Title>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {entries.map(entry => (
          <Pressable
            key={entry.team.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${entry.team.name}`}
            onPress={() => onOpenTeam(entry)}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
          >
            <View style={styles.cardText}>
              <Text style={styles.name}>{entry.team.name}</Text>
              {entry.team.sport ? <Text style={styles.meta}>{entry.team.sport}</Text> : null}
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
          </Pressable>
        ))}
        <SecondaryButton label="Refresh teams" onPress={reload} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: spacing.xl, gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardText: { flex: 1 },
  name: { fontFamily: fonts.semiBold, fontSize: 16, color: colors.text },
  meta: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  error: { ...type.body, color: colors.danger },
});
