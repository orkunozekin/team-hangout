import { agendaTime } from '../lib/agendaTime';
import { eventConversationTarget } from '../lib/conversationNavigation';
import EventAttendance from '../components/EventAttendance';
import EventAvailability from "../components/EventAvailability";
import EventLineup from "../components/EventLineup";
import EventPlayTime from "../components/EventPlayTime";
import EventResult from "../components/EventResult";
import EventStandings from "../components/EventStandings";
import EventBracket from "../components/EventBracket";
import EventVolunteers from "../components/EventVolunteers";
import EventPracticePlan from "../components/EventPracticePlan";
import EventRides from "../components/EventRides";
import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
} from 'react';

import {
  Alert,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  useFocusEffect,
} from '@react-navigation/native';

import {
  NativeStackNavigationProp,
} from '@react-navigation/native-stack';

import {
  RouteProp,
} from '@react-navigation/native';

import {
  getEvent,
  softDeleteEvent,
  mutateEventSchedule,
} from '../firebase/events';

import {
  EmptyState,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Title,
} from '../components/ui';

import {
  formatEventDateLabel,
} from '../lib/eventForm';

import {
  canManageTeam,
} from '../lib/roles';

import {
  AppRole,
  TeamEvent,
  TeamMember,
} from '../types/models';

import {
  colors,
  radius,
  spacing,
  type,
} from '../theme/theme';
import OfflineNotice from '../components/OfflineNotice';
import {
  clearGameDayCache,
  isGameDayCacheAccessLoss,
  loadCachedEvent,
  saveCachedEvent,
  type CachedValue,
} from '../lib/gameDayCache';

type RootStackParamList = {
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string; action?: 'reschedule' };
  Conversation: { orgId: string; scopeType: 'organization' | 'division' | 'team' | 'event'; scopeId: string };
};

type Props = {
  userId?: string;
  cacheScope?: string;
  membership: TeamMember;
  appRole?: AppRole;
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

export default function EventDetailScreen({
  userId,
  cacheScope,
  membership,
  appRole,
  navigation,
  route,
}: Props) {
  const generation = useRef(0);
  const [event, setEvent] = useState<TeamEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [cached, setCached] = useState<CachedValue<TeamEvent> | null>(null);
  const canManage = !cached && (event?.schemaVersion === 2 ? event.canManage : canManageTeam({ membership, appRole }));

  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const data = await getEvent(route.params.eventId);
      if (token === generation.current) {
        setCached(null);
        setEvent(data);
        if (data && userId && cacheScope) void saveCachedEvent(userId, cacheScope, data).catch(() => undefined);
      }
    } catch (error) {
      const denied = isGameDayCacheAccessLoss(error);
      if (denied && userId) await clearGameDayCache(userId).catch(() => undefined);
      const copy = userId && cacheScope && !denied
        ? await loadCachedEvent(userId, cacheScope, route.params.eventId)
        : null;
      if (token === generation.current && copy) {
        setCached(copy);
        setEvent(copy.value);
        setError('');
        return;
      }
      throw error;
    }
  }, [route.params.eventId, userId, cacheScope]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        setLoading(true); setEvent(null); setError('');
        try {
          await load();
        } catch (error) { setError(error instanceof Error ? error.message : 'Event unavailable.'); setEvent(null); } finally {
          if (active) setLoading(false);
        }
      })();
      return () => {
        active = false; generation.current++;
      };
    }, [load]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setLoading(true);
        void load()
          .catch(error => {
            setError(error instanceof Error ? error.message : 'Event unavailable.');
            setEvent(null);
          })
          .finally(() => setLoading(false));
      }
    });
    return () => sub?.remove();
  }, [load]);

  async function lifecycle(action: string) {
    if (!event) return;
    setSaving(true); setError('');
    try {
      await mutateEventSchedule(event.id, event.revision ?? 0, action, {}, reason);
      setReason(''); await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setSaving(false); }
  }

  async function onDelete() {
    Alert.alert(
      'Delete event?',
      'This removes the event from the team schedule.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (!event) throw new Error('Reload the event before deleting.');
              await softDeleteEvent(route.params.eventId, event.revision ?? 0);
              navigation.goBack();
            } catch (error) {
              Alert.alert('Could not delete event', error instanceof Error ? error.message : 'Please try again');
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <Screen edges={['bottom']}>
        <EmptyState message="Loading event..." />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen edges={['bottom']}>
        <EmptyState message={error || "Event not found."} />
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView>
        {cached ? <OfflineNotice savedAt={cached.savedAt} olderThanTtl={cached.olderThanTtl} /> : null}
        <View
          style={[
            styles.badge,
            event.type === 'match' ? styles.badgeMatch : styles.badgePractice,
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              event.type === 'match'
                ? styles.badgeTextMatch
                : styles.badgeTextPractice,
            ]}
          >
            {event.type === 'match' ? 'Match' : 'Practice'}
          </Text>
        </View>

        <Title>{event.title}</Title>
        {event.schemaVersion === 2 ? <>
          <Text style={styles.row}>{event.status} · Schedule version {event.scheduleVersion}</Text>
          <Text style={styles.row}>{event.teams?.map(team => team.name).join(' vs ')} · {event.timeZone}</Text>
          {event.status === 'postponed' ? <Text style={styles.row}>Awaiting a new schedule. The previous time is shown below.</Text> : null}
          {event.status === 'cancelled' ? <Text style={styles.row}>Cancelled. This event is retained in schedule history.</Text> : null}
        </> : null}

        <Text style={styles.row}>
          {event.schemaVersion === 2 && event.startsAt && event.endsAt && event.timeZone ? agendaTime(event.startsAt, event.endsAt, event.timeZone) : `${formatEventDateLabel(event.date)} at ${event.time}`}
        </Text>

        {event.location?.name ? (
          <Text style={styles.row}>
            {event.location.name}
            {event.location.address ? `\n${event.location.address}` : ''}
          </Text>
        ) : null}

        {event.notes ? (
          <Text style={styles.notes}>{event.notes}</Text>
        ) : null}

        {cached ? <Text style={styles.row}>Updates, responses, check-in, and attendance require a connection. No offline changes are queued.</Text> : null}
        {!cached && event.schemaVersion === 2 ? <EventAvailability key={`${event.id}:${event.revision}`} eventId={event.id} canManage={canManage} /> : null}
        {!cached && eventConversationTarget(event) ? <SecondaryButton label="Open event conversation" onPress={() => navigation.navigate('Conversation', { orgId: event.orgId!, scopeType: 'event', scopeId: event.id })} /> : null}
        {!cached && event.schemaVersion === 2 ? <EventAttendance key={`attendance:${event.id}:${event.revision}`} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId ? <EventLineup key={`lineup:${event.id}:${membership.teamId}`} orgId={event.orgId} eventId={event.id} teamId={membership.teamId} canCoach={membership.role === 'coach'} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId && membership.role === 'coach' ? <EventPlayTime key={`playtime:${event.id}:${membership.teamId}`} orgId={event.orgId} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId && event.type === 'match' && membership.role === 'coach' ? <EventResult key={`result:${event.id}:${membership.teamId}`} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId && event.type === 'match' ? <EventStandings key={`standings:${event.id}:${membership.teamId}`} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId && event.type === 'practice' ? <EventPracticePlan key={`practice:${event.id}:${membership.teamId}`} orgId={event.orgId} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId ? <EventVolunteers key={`volunteers:${event.id}:${membership.teamId}`} orgId={event.orgId} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId ? <EventRides key={`rides:${event.id}:${membership.teamId}`} orgId={event.orgId} eventId={event.id} teamId={membership.teamId} /> : null}
        {!cached && event.schemaVersion === 2 && event.orgId && event.type === 'match' ? <EventBracket key={`bracket:${event.id}:${membership.teamId}`} eventId={event.id} teamId={membership.teamId} /> : null}
        {event.history?.length ? <>
          <Text style={styles.row}>Schedule history{event.historyHasMore ? ' (latest 20)' : ''}</Text>
          {event.history.map(row => <Text key={row.revision} style={styles.row}>
            Revision {row.revision}: {row.action} · {row.previousStatus} → {row.status}{row.reason ? `\n${row.reason}` : ''}
            {row.action === 'reschedule' ? `\n${new Date(row.previousStartsAt).toLocaleString('en-US', { timeZone: row.previousTimeZone ?? event.timeZone })} → ${new Date(row.startsAt).toLocaleString('en-US', { timeZone: row.timeZone ?? event.timeZone })}` : ''}
          </Text>)}
        </> : null}
        {error ? <><Text accessibilityRole="alert" style={styles.row}>{error}</Text>
          <SecondaryButton label="Reload event" onPress={async () => { try { setError(''); await load(); } catch (error) { setError(error instanceof Error ? error.message : 'Event unavailable.'); } }} />
        </> : null}
        {canManage && !['cancelled', 'completed'].includes(event.status ?? '') ? (
          <>
            <PrimaryButton
              label="Edit event"
              onPress={() =>
                navigation.navigate('CreateEditEvent', {
                  eventId: event.id,
                })
              }
            />
            {event.schemaVersion === 2 ? <>
              <SecondaryButton label="Reschedule" onPress={() => navigation.navigate('CreateEditEvent', { eventId: event.id, action: 'reschedule' })} />
              <Text style={styles.row}>Reason for status change</Text>
              <TextInput accessibilityLabel="Reason for status change" value={reason} onChangeText={setReason} maxLength={500} style={{ ...styles.row, borderWidth: 1, borderColor: colors.border, padding: spacing.sm }} />
              {event.status === 'scheduled' ? <SecondaryButton label="Postpone" disabled={saving || !reason.trim()} onPress={() => lifecycle('postpone')} /> : null}
              <SecondaryButton label="Cancel event" disabled={saving || !reason.trim()} onPress={() => lifecycle('cancel')} />
              {event.status === 'scheduled' ? <SecondaryButton label="Complete event" disabled={saving || !reason.trim()} onPress={() => lifecycle('complete')} /> : null}
            </> : <SecondaryButton label="Delete event" onPress={onDelete} />}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    marginBottom: spacing.sm,
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
  row: {
    ...type.body,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  notes: {
    ...type.body,
    color: colors.text,
    marginBottom: spacing.lg,
  },
});
