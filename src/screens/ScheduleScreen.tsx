import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
} from 'react';

import {
  AppState,
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
  type TeamEventPage,
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
import OfflineNotice from '../components/OfflineNotice';
import {
  clearGameDayCache,
  isGameDayCacheAccessLoss,
  loadCachedTeamSchedule,
  saveCachedTeamSchedule,
  type CachedValue,
} from '../lib/gameDayCache';

type RootStackParamList = {
  MainTabs: undefined;
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string };
};

type Props = {
  userId?: string;
  teamId: string;
  teamName?: string;
  teamSchemaVersion?: number;
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
  userId,
  teamId,
  teamName,
  teamSchemaVersion,
  membership,
  appRole,
  navigation,
}: Props) {
  const generation = useRef(0);
  const [liveCanManage, setLiveCanManage] = useState(false);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const [filter, setFilter] = useState<EventTypeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cached, setCached] = useState<CachedValue<TeamEventPage> | null>(null);
  const pendingPage = useRef(false);

  const load = useCallback(async () => {
    const token = ++generation.current;
    pendingPage.current = true;
    setLoadingMore(false); setError(''); setLiveCanManage(false);
    try {
      const page = await listTeamEventPage(teamId, null, view, teamSchemaVersion);
      if (token === generation.current) {
        setCached(null);
        setEvents(page.items); setNextCursor(page.nextCursor); setLiveCanManage(page.canManage === true);
        if (userId) void saveCachedTeamSchedule(userId, teamId, view, page).catch(() => undefined);
      }
    } catch (error) {
      const denied = isGameDayCacheAccessLoss(error);
      if (denied && userId) await clearGameDayCache(userId).catch(() => undefined);
      const copy = userId && !denied ? await loadCachedTeamSchedule(userId, teamId, view) : null;
      if (token === generation.current && copy) {
        setCached(copy);
        setEvents(copy.value.items);
        setNextCursor(null);
      } else if (token === generation.current) {
        if (denied) {
          setCached(null); setEvents([]); setNextCursor(null);
          setError('Permission removed. Reload to see your current schedule.');
        } else setError(error instanceof Error ? error.message : 'Schedule unavailable.');
      }
    } finally {
      if (token === generation.current) {
        pendingPage.current = false; setLoading(false); setRefreshing(false);
      }
    }
  }, [teamId, view, teamSchemaVersion, userId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true); setEvents([]); setNextCursor(null);
      void load();
      return () => { generation.current++; pendingPage.current = false; };
    }, [load]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { setLoading(true); void load(); }
    });
    return () => sub?.remove();
  }, [load]);

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
      const page = await listTeamEventPage(teamId, nextCursor, view, teamSchemaVersion);
      if (token !== generation.current) return;
      setEvents(previous => [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()]);
      setNextCursor(page.nextCursor); setLiveCanManage(page.canManage === true);
    } catch (error) {
      const denied = isGameDayCacheAccessLoss(error);
      const invalidCursor = ['invalid-argument', 'functions/invalid-argument']
        .includes((error as { code?: string }).code ?? '');
      if (denied && userId) await clearGameDayCache(userId).catch(() => undefined);
      if (invalidCursor) {
        if (userId) await clearGameDayCache(userId).catch(() => undefined);
        if (token === generation.current) {
          setCached(null); setEvents([]); setNextCursor(null); setLoading(true);
          pendingPage.current = false;
          await load();
        }
        return;
      }
      if (token === generation.current) {
        setLiveCanManage(false);
        if (denied) {
          setCached(null); setEvents([]); setNextCursor(null);
          setError('Permission removed. Reload to see your current schedule.');
        } else setError(error instanceof Error ? error.message : 'More events are unavailable. Please try again.');
      }
    } finally {
      if (token === generation.current) { pendingPage.current = false; setLoadingMore(false); }
    }
  }

  const visible = applyScheduleView(events, filter, view === 'past' ? 'desc' : 'asc');
  const canManage = !cached && (teamSchemaVersion === 2 ? liveCanManage : canManageTeam({ membership, appRole }));

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>Schedule</Title>
        <Subtitle>Practices and matches for {teamName || 'your team'}.</Subtitle>

        <View style={styles.filters}>
          {(['upcoming', 'past'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: view === value }} onPress={() => setView(value)} style={[styles.chip, view === value ? styles.chipSelected : null]}><Text style={[styles.chipText, view === value ? styles.chipTextSelected : null]}>{value === 'upcoming' ? 'Upcoming' : 'Past events'}</Text></Pressable>)}
        </View>

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
      {cached ? <View style={styles.cacheNotice}><OfflineNotice savedAt={cached.savedAt} olderThanTtl={cached.olderThanTtl} /></View> : null}

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
  cacheNotice: { paddingHorizontal: spacing.lg },
  header: {
    paddingHorizontal: spacing.lg,
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    flexShrink: 1,
    maxWidth: '100%',
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
