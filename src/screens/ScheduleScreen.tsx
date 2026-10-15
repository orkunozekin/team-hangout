import React, {
  useCallback,
  useState,
  useRef,
} from 'react';

import {
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
  NativeStackNavigationProp,
} from '@react-navigation/native-stack';

import {
  listTeamEvents,
} from '../firebase/events';

import {
  EmptyState,
  PrimaryButton,
  Screen,
  Subtitle,
  Title,
} from '../components/ui';

import {
  applyScheduleView,
} from '../lib/eventSort';

import {
  formatEventDateLabel,
} from '../lib/eventForm';

import {
  canManageTeam,
} from '../lib/roles';

import {
  EventTypeFilter,
  TeamEvent,
  TeamMember,
  AppRole,
} from '../types/models';

import {
  colors,
  fonts,
  radius,
  shadow,
  spacing,
  type,
} from '../theme/theme';

type RootStackParamList = {
  MainTabs: undefined;
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string };
};

type Props = {
  teamId: string;
  membership: TeamMember;
  appRole?: AppRole;
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

const FILTERS: { key: EventTypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'practice', label: 'Practice' },
  { key: 'match', label: 'Match' },
];

export default function ScheduleScreen({
  teamId,
  membership,
  appRole,
  navigation,
}: Props) {
  const generation = useRef(0);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [filter, setFilter] = useState<EventTypeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const token = ++generation.current;
    setError('');
    const data = await listTeamEvents(teamId);
    if (token === generation.current) setEvents(data);
  }, [teamId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        setLoading(true); setEvents([]);
        try {
          await load();
        } catch (error) { setEvents([]); setError(error instanceof Error ? error.message : 'Schedule unavailable.'); } finally {
          if (active) setLoading(false);
        }
      })();
      return () => {
        active = false; generation.current++;
      };
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } catch (error) { setEvents([]); setError(error instanceof Error ? error.message : 'Schedule unavailable.'); } finally {
      setRefreshing(false);
    }
  }

  const visible = applyScheduleView(events, filter, 'asc');
  const canManage = canManageTeam({ membership, appRole });

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>Schedule</Title>
        <Subtitle>Practices and matches for your team.</Subtitle>

        <View style={styles.filters}>
          {FILTERS.map((item) => {
            const selected = filter === item.key;
            return (
              <Pressable
                key={item.key}
                onPress={() => setFilter(item.key)}
                style={[
                  styles.chip,
                  selected ? styles.chipSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    selected ? styles.chipTextSelected : null,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {canManage ? (
          <PrimaryButton
            label="Add event"
            onPress={() => navigation.navigate('CreateEditEvent', {})}
          />
        ) : null}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState message={error || "No events yet. Coaches can add practices and matches."} />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() =>
              navigation.navigate('EventDetail', { eventId: item.id })
            }
          >
            <View style={styles.cardTop}>
              <View
                style={[
                  styles.badge,
                  item.type === 'match'
                    ? styles.badgeMatch
                    : styles.badgePractice,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    item.type === 'match'
                      ? styles.badgeTextMatch
                      : styles.badgeTextPractice,
                  ]}
                >
                  {item.type === 'match' ? 'Match' : 'Practice'}
                </Text>
              </View>
              <Text style={styles.time}>{item.time}</Text>
            </View>
            <Text style={styles.cardTitle}>{item.title}</Text>
            {item.status ? <Text style={styles.meta}>{item.status} · Schedule version {item.scheduleVersion}</Text> : null}
            {item.teams ? <Text style={styles.meta}>{item.teams.map(team => team.name).join(' vs ')}</Text> : null}
            <Text style={styles.meta}>
              {formatEventDateLabel(item.date)}
              {item.location?.name ? ` · ${item.location.name}` : ''}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
  },
  filters: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    ...type.label,
    color: colors.textMuted,
  },
  chipTextSelected: {
    color: colors.white,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  badgePractice: {
    backgroundColor: colors.practiceBg,
  },
  badgeMatch: {
    backgroundColor: colors.matchBg,
  },
  badgeText: {
    ...type.tiny,
    textTransform: 'uppercase',
  },
  badgeTextPractice: {
    color: colors.practice,
  },
  badgeTextMatch: {
    color: colors.match,
  },
  time: {
    ...type.label,
    color: colors.textMuted,
  },
  cardTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.text,
    marginBottom: 4,
  },
  meta: {
    ...type.caption,
    color: colors.textMuted,
  },
});
