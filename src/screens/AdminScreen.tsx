import React, {
  useCallback,
  useState,
} from 'react';

import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  useFocusEffect,
} from '@react-navigation/native';

import {
  User,
} from 'firebase/auth';

import {
  listAllTeams,
} from '../firebase/teams';

import {
  setActiveTeamId,
} from '../firebase/users';

import {
  EmptyState,
  LinkButton,
  Screen,
  Subtitle,
  Title,
} from '../components/ui';

import {
  Team,
} from '../types/models';

import {
  colors,
  fonts,
  radius,
  spacing,
  type,
} from '../theme/theme';

type Props = {
  user: User;
  activeTeamId: string | null;
  onTeamSelected: () => void;
  onGoToOnboarding?: () => void;
};

export default function AdminScreen({
  user,
  activeTeamId,
  onTeamSelected,
  onGoToOnboarding,
}: Props) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await listAllTeams();
    setTeams(data);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => {
        Alert.alert(
          'Could not load teams',
          err instanceof Error ? err.message : 'Please try again',
        );
      });
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function enterTeam(team: Team) {
    setLoadingId(team.id);
    try {
      await setActiveTeamId(user.uid, team.id);
      onTeamSelected();
    } catch (err) {
      Alert.alert(
        'Could not enter team',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>Super Admin</Title>
        <Subtitle>
          Browse legacy teams with coach access. Organization teams use scoped administration.
        </Subtitle>
        {onGoToOnboarding ? (
          <LinkButton
            label="Create or join a team as yourself"
            onPress={onGoToOnboarding}
          />
        ) : null}
      </View>

      <FlatList
        data={teams}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState message="No teams yet." />
        }
        renderItem={({ item }) => {
          const active = item.id === activeTeamId;
          return (
            <Pressable
              style={[styles.card, active ? styles.cardActive : null]}
              onPress={() => enterTeam(item)}
              disabled={loadingId === item.id}
            >
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>
                {item.sport ? `${item.sport} · ` : ''}
                code {item.inviteCode}
                {active ? ' · active' : ''}
              </Text>
              <Text style={styles.action}>
                {loadingId === item.id ? 'Opening…' : 'Enter team'}
              </Text>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  name: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.text,
  },
  meta: {
    ...type.caption,
    color: colors.textMuted,
    marginTop: 4,
  },
  action: {
    ...type.label,
    color: colors.primary,
    marginTop: spacing.sm,
  },
});
