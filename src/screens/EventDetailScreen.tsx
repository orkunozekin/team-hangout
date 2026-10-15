import React, {
  useCallback,
  useState,
  useRef,
} from 'react';

import {
  Alert,
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

type RootStackParamList = {
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string; action?: 'reschedule' };
};

type Props = {
  membership: TeamMember;
  appRole?: AppRole;
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

export default function EventDetailScreen({
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
  const canManage = event?.schemaVersion === 2 ? event.canManage : canManageTeam({ membership, appRole });

  const load = useCallback(async () => {
    const token = ++generation.current;
    const data = await getEvent(route.params.eventId);
    if (token === generation.current) setEvent(data);
  }, [route.params.eventId]);

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
          {formatEventDateLabel(event.date)} at {event.time}
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

        {event.history?.length ? <>
          <Text style={styles.row}>Schedule history{event.historyHasMore ? ' (latest 20)' : ''}</Text>
          {event.history.map(row => <Text key={row.revision} style={styles.row}>
            Revision {row.revision}: {row.action} · {row.previousStatus} → {row.status}{'\n'}{row.reason}
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
