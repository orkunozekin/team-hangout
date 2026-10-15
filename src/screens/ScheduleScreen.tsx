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
  listTeamEventPage,
} from '../firebase/events';

import {
  EmptyState,
  PrimaryButton,
  SecondaryButton,
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
  teamName?: string;
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
  teamName,
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pendingPage = useRef(false);

  const load = useCallback(async () => {
    const token = ++generation.current;
    pendingPage.current = true;
    setLoadingMore(false); setError('');
    try {
      const page = await listTeamEventPage(teamId);
      if (token === generation.current) {
        setEvents(page.items); setNextCursor(page.nextCursor);
      }
    } catch (error) {
      if (token === generation.current) setError(error instanceof Error ? error.message : 'Schedule unavailable.');
    } finally {
      if (token === generation.current) {
        pendingPage.current = false; setLoading(false); setRefreshing(false);
      }
    }
  }, [teamId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true); setEvents([]); setNextCursor(null);
      void load();
      return () => { generation.current++; pendingPage.current = false; };
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
  }

  async function onLoadMore() {
    if (!nextCursor || pendingPage.current) return;
    const token = generation.current;
    pendingPage.current = true;
    setLoadingMore(true); setError('');
    try {
      const page = await listTeamEventPage(teamId, nextCursor);
      if (token !== generation.current) return;
      setEvents(previous => [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (token === generation.current) setError(error instanceof Error ? error.message : 'More events are unavailable. Please try again.');
    } finally {
      if (token === generation.current) { pendingPage.current = false; setLoadingMore(false); }
    }
  }

  const visible = applyScheduleView(events, filter, 'asc');
  const canManage = canManageTeam({ membership, appRole });

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>Schedule</Title>
        <Subtitle>Practices and matches for {teamName || 'your team'}.</Subtitle>

        <View style={styles.filters}>
          {FILTERS.map((item) => {
            const selected = filter === item.key;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
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

      {nextCursor ? <Text style={styles.meta}>More events are available. Load more to include them in this view.</Text> : null}

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
        ListFooterComponent={
          <View>
            {error && events.length ? <Text accessibilityRole="alert">{error}</Text> : null}
            {nextCursor ? <SecondaryButton label={loadingMore ? 'Loading events...' : 'Load more events'} onPress={() => { void onLoadMore(); }} disabled={loadingMore || refreshing || loading} /> : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            accessibilityRole="button"
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
              {item.timeZone ? ` · ${item.timeZone.replace(/_/g, ' ')}` : ''}
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
