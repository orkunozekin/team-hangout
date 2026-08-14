import React, {
  useCallback,
  useState,
} from 'react';

import {
  Alert,
  ScrollView,
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
  RouteProp,
} from '@react-navigation/native';

import {
  getEvent,
  softDeleteEvent,
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
  CreateEditEvent: { eventId?: string };
};

type Props = {
  membership: TeamMember;
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

export default function EventDetailScreen({
  membership,
  navigation,
  route,
}: Props) {
  const [event, setEvent] = useState<TeamEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const isCoach = membership.role === 'coach';

  const load = useCallback(async () => {
    const data = await getEvent(route.params.eventId);
    setEvent(data);
  }, [route.params.eventId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        setLoading(true);
        try {
          await load();
        } finally {
          if (active) setLoading(false);
        }
      })();
      return () => {
        active = false;
      };
    }, [load]),
  );

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
            await softDeleteEvent(route.params.eventId);
            navigation.goBack();
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <Screen>
        <EmptyState message="Loading event..." />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen>
        <EmptyState message="Event not found." />
      </Screen>
    );
  }

  return (
    <Screen>
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

        {isCoach ? (
          <>
            <PrimaryButton
              label="Edit event"
              onPress={() =>
                navigation.navigate('CreateEditEvent', {
                  eventId: event.id,
                })
              }
            />
            <SecondaryButton label="Delete event" onPress={onDelete} />
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
