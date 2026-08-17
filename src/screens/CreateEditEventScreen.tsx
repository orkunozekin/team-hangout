import React, {
  useEffect,
  useState,
} from 'react';

import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  NativeStackNavigationProp,
} from '@react-navigation/native-stack';

import {
  RouteProp,
} from '@react-navigation/native';

import {
  createEvent,
  getEvent,
  updateEvent,
} from '../firebase/events';

import {
  FieldLabel,
  PrimaryButton,
  Screen,
  TextField,
  Title,
} from '../components/ui';

import {
  hasEventErrors,
  parseEventDate,
  validateEventForm,
} from '../lib/eventForm';

import {
  EventType,
  TeamMember,
} from '../types/models';

import {
  colors,
  radius,
  spacing,
  type,
} from '../theme/theme';

type RootStackParamList = {
  CreateEditEvent: { eventId?: string };
};

type Props = {
  teamId: string;
  membership: TeamMember;
  navigation: NativeStackNavigationProp<RootStackParamList, 'CreateEditEvent'>;
  route: RouteProp<RootStackParamList, 'CreateEditEvent'>;
};

export default function CreateEditEventScreen({
  teamId,
  membership,
  navigation,
  route,
}: Props) {
  const eventId = route.params?.eventId;
  const isEdit = Boolean(eventId);

  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<EventType>('practice');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<import('../lib/eventForm').EventFormErrors>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!eventId) return;
    (async () => {
      const event = await getEvent(eventId);
      if (!event) return;
      setTitle(event.title);
      setEventType(event.type);
      setDate(event.date.toISOString().slice(0, 10));
      setTime(event.time);
      setLocationName(event.location?.name ?? '');
      setLocationAddress(event.location?.address ?? '');
      setNotes(event.notes ?? '');
    })();
  }, [eventId]);

  async function onSubmit() {
    const nextErrors = validateEventForm({
      title,
      type: eventType,
      date,
      time,
      locationName,
      locationAddress,
      notes,
    });
    setErrors(nextErrors);
    if (hasEventErrors(nextErrors)) {
      return;
    }

    setLoading(true);
    try {
      const location = locationName.trim()
        ? {
            name: locationName.trim(),
            address: locationAddress.trim() || undefined,
          }
        : null;

      if (isEdit && eventId) {
        await updateEvent(eventId, {
          title,
          type: eventType,
          date: parseEventDate(date),
          time,
          location,
          notes,
        });
      } else {
        await createEvent({
          teamId,
          title,
          type: eventType,
          date: parseEventDate(date),
          time,
          location,
          notes,
          createdBy: membership.userId,
        });
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert(
        'Could not save event',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen edges={['bottom']}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Title>{isEdit ? 'Edit event' : 'New event'}</Title>

        <FieldLabel>Type</FieldLabel>
        <View style={styles.typeRow}>
          {(['practice', 'match'] as EventType[]).map((value) => {
            const selected = eventType === value;
            return (
              <Pressable
                key={value}
                onPress={() => setEventType(value)}
                style={[
                  styles.typeChip,
                  selected ? styles.typeChipSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    selected ? styles.typeChipTextSelected : null,
                  ]}
                >
                  {value === 'practice' ? 'Practice' : 'Match'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {errors.type ? (
          <Text style={styles.error}>{errors.type}</Text>
        ) : null}

        <FieldLabel>Title</FieldLabel>
        <TextField
          value={title}
          onChangeText={setTitle}
          error={errors.title}
          placeholder="Evening practice"
        />

        <FieldLabel>Date (YYYY-MM-DD)</FieldLabel>
        <TextField
          value={date}
          onChangeText={setDate}
          error={errors.date}
          placeholder="2026-08-20"
          autoCapitalize="none"
        />

        <FieldLabel>Time (HH:mm)</FieldLabel>
        <TextField
          value={time}
          onChangeText={setTime}
          error={errors.time}
          placeholder="18:30"
          autoCapitalize="none"
        />

        <FieldLabel>Location name (optional)</FieldLabel>
        <TextField
          value={locationName}
          onChangeText={setLocationName}
          placeholder="Central Park Field 2"
        />

        <FieldLabel>Address (optional)</FieldLabel>
        <TextField
          value={locationAddress}
          onChangeText={setLocationAddress}
          placeholder="123 Park Ave"
        />

        <FieldLabel>Notes (optional)</FieldLabel>
        <TextField
          value={notes}
          onChangeText={setNotes}
          placeholder="Bring pinnies"
          multiline
        />

        <PrimaryButton
          label={isEdit ? 'Save changes' : 'Create event'}
          onPress={onSubmit}
          loading={loading}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  typeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  typeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  typeChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  typeChipText: {
    ...type.label,
    color: colors.textMuted,
  },
  typeChipTextSelected: {
    color: colors.white,
  },
  error: {
    ...type.caption,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
});
