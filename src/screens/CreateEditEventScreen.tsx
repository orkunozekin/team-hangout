import React, {
  useEffect,
  useState,
  useRef,
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
  mutateEventSchedule,
  createCanonicalEvent,
  listEventTeamChoices,
} from '../firebase/events';

import { eventInterval } from '../lib/eventTime';
import { getTeam } from '../firebase/teams';

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
  CreateEditEvent: { eventId?: string; action?: 'reschedule' };
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
  const reschedule = route.params?.action === 'reschedule';
  const [canonical, setCanonical] = useState(false);
  const [duration, setDuration] = useState('60');
  const [timeZone, setTimeZone] = useState('UTC');
  const [chooseZone, setChooseZone] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [occurrence, setOccurrence] = useState<'earlier' | 'later' | undefined>();
  const [teamChoices, setTeamChoices] = useState<{ id: string; name: string }[]>([]);
  const choicesGeneration = useRef(0);
  const choicesBusy = useRef(false);
  const [choicesLoaded, setChoicesLoaded] = useState(false);
  const [choicesCursor, setChoicesCursor] = useState<string | null>(null);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [choicesError, setChoicesError] = useState('');
  const [opponent, setOpponent] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<EventType>('practice');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<import('../lib/eventForm').EventFormErrors>({});
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false); setLoadError('');
    choicesGeneration.current++; choicesBusy.current = false;
    setTeamChoices([]); setChoicesLoaded(false); setChoicesCursor(null); setChoicesLoading(false); setChoicesError(''); setOpponent(null);
    (async () => {
      if (!eventId) {
        const team = await getTeam(teamId);
        if (team?.schemaVersion === 2 && !team.timeZone) throw new Error('Organization time zone is unavailable. Reload before creating an event.');
        if (active) {
          if (team?.schemaVersion === 2) setTimeZone(team.timeZone!);
          setCanonical(team?.schemaVersion === 2); setReady(true);
        }
        return;
      }
      const event = await getEvent(eventId);
      if (!active) return;
      if (!event) throw new Error('Event unavailable.');
      setCanonical(event.schemaVersion === 2);
      if (event.timeZone) setTimeZone(event.timeZone);
      if (event.startsAt && event.endsAt) setDuration(String((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60000));
      setReady(true);
      setRevision(event.revision ?? 0);
      setTitle(event.title);
      setEventType(event.type);
      setDate(event.date.toISOString().slice(0, 10));
      setTime(event.time);
      setLocationName(event.location?.name ?? '');
      setLocationAddress(event.location?.address ?? '');
      setNotes(event.notes ?? '');
    })().catch(error => { if (active) setLoadError(error instanceof Error ? error.message : 'Event unavailable.'); });
    return () => { active = false; choicesGeneration.current++; };
  }, [eventId, teamId, reloadVersion]);

  async function loadChoices() {
    if (!ready || choicesBusy.current || (choicesLoaded && !choicesCursor)) return;
    const token = choicesGeneration.current;
    choicesBusy.current = true; setChoicesLoading(true); setChoicesError('');
    try {
      const page = await listEventTeamChoices(teamId, choicesCursor);
      if (token !== choicesGeneration.current) return;
      setTeamChoices(previous => [...new Map([...previous, ...page.items].map(team => [team.id, team])).values()]);
      setChoicesCursor(page.nextCursor); setChoicesLoaded(true);
    } catch (error) {
      if (token === choicesGeneration.current) setChoicesError('Unable to load opponent teams. Please try again.');
    } finally {
      if (token === choicesGeneration.current) { choicesBusy.current = false; setChoicesLoading(false); }
    }
  }

  async function onSubmit() {
    if (!ready || loading) return;
    if (canonical) {
      if (!ready || revision === null && isEdit) return;
      setLoading(true); setLoadError('');
      try {
        const location = locationName.trim() ? { name: locationName.trim(), ...(locationAddress.trim() ? { address: locationAddress.trim() } : {}) } : null;
        const interval = reschedule || !isEdit ? eventInterval(date, time, timeZone, duration, occurrence) : null;
        if (isEdit && eventId) await mutateEventSchedule(eventId, revision!, reschedule ? 'reschedule' : 'edit',
          reschedule ? interval! : { title, type: eventType, location, notes }, reason);
        else await createCanonicalEvent(teamId, { title, type: eventType, teamIds: eventType === 'match' && opponent ? [teamId, opponent] : [teamId], ...interval!, status: 'scheduled', publicationState: 'published', location, notes });
        navigation.goBack();
      } catch (error) { const message = error instanceof Error ? error.message : 'Please try again.'; setLoadError(message); setAmbiguous(message.includes('occurs twice')); }
      finally { setLoading(false); }
      return;
    }
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
        if (revision === null) throw new Error('Reload the event before saving.');
        await updateEvent(eventId, {
          title,
          type: eventType,
          date: parseEventDate(date),
          time,
          location,
          notes,
        }, revision);
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
        <Title>{reschedule ? 'Reschedule event' : isEdit ? 'Edit event' : 'New event'}</Title>
        {loadError ? <>
          <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
          <Pressable accessibilityRole="button" onPress={() => setReloadVersion(value => value + 1)}><Text style={styles.error}>Reload event</Text></Pressable>
        </> : null}
        {!ready && !loadError ? <Text>Loading event...</Text> : null}
        {canonical && (reschedule || !isEdit) ? <>
          <FieldLabel>Date (YYYY-MM-DD)</FieldLabel><TextField accessibilityLabel="Event date" value={date} onChangeText={value => { setDate(value); setOccurrence(undefined); setAmbiguous(false); }} placeholder="2026-10-20" autoCapitalize="none" />
          <FieldLabel>Local time (HH:mm)</FieldLabel><TextField accessibilityLabel="Local time" value={time} onChangeText={value => { setTime(value); setOccurrence(undefined); setAmbiguous(false); }} placeholder="18:00" autoCapitalize="none" />
          <FieldLabel>Duration in minutes</FieldLabel><TextField accessibilityLabel="Duration in minutes" value={duration} onChangeText={setDuration} keyboardType="number-pad" />
          <FieldLabel>Event time zone: {timeZone.replace(/_/g, ' ')}</FieldLabel>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: chooseZone }} onPress={() => setChooseZone(value => !value)} style={styles.typeChip}><Text style={styles.typeChipText}>Change time zone</Text></Pressable>
          {chooseZone ? [...new Set([timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC'])].map(zone =>
            <Pressable key={zone} accessibilityRole="button" accessibilityState={{ selected: timeZone === zone }} onPress={() => { setTimeZone(zone); setOccurrence(undefined); setChooseZone(false); }} style={styles.typeChip}>
              <Text style={styles.typeChipText}>{timeZone === zone ? '✓ ' : ''}{zone.replace(/_/g, ' ')}</Text>
            </Pressable>) : null}
          {ambiguous ? <>
          <FieldLabel>If clocks repeat this time</FieldLabel>
          <View style={styles.typeRow}>{(['earlier', 'later'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: occurrence === value }} onPress={() => setOccurrence(value)} style={styles.typeChip}>
            <Text style={styles.typeChipText}>{occurrence === value ? '✓ ' : ''}{value === 'earlier' ? 'First occurrence' : 'Second occurrence'}</Text>
          </Pressable>)}</View>
          </> : null}
        </> : null}
        {canonical && isEdit ? <><FieldLabel>Reason for change</FieldLabel><TextField accessibilityLabel="Reason for change" value={reason} onChangeText={setReason} maxLength={500} /></> : null}
        {!reschedule ? <>

        <FieldLabel>Type</FieldLabel>
        <View style={styles.typeRow}>
          {(['practice', 'match'] as EventType[]).map((value) => {
            const selected = eventType === value;
            return (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
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

        {canonical && !isEdit && eventType === 'match' ? <>
          <FieldLabel>Opponent (optional)</FieldLabel>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: opponent === null }} onPress={() => setOpponent(null)} style={styles.typeChip}><Text style={styles.typeChipText}>{opponent === null ? '✓ ' : ''}Single-team match</Text></Pressable>
          {teamChoices.filter(team => team.id !== teamId).map(team => <Pressable key={team.id} accessibilityRole="button" accessibilityState={{ selected: opponent === team.id }} onPress={() => setOpponent(team.id)} style={styles.typeChip}>
            <Text style={styles.typeChipText}>{opponent === team.id ? '✓ ' : ''}{team.name}</Text>
          </Pressable>)}
          {choicesError ? <Text accessibilityRole="alert">{choicesError}</Text> : null}
          {!choicesLoaded || choicesCursor ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: choicesLoading }} disabled={choicesLoading} onPress={() => { void loadChoices(); }}><Text>{choicesLoading ? 'Loading opponent teams...' : choicesLoaded ? 'Load more opponent teams' : 'Load opponent teams'}</Text></Pressable> : null}
          <Text>Only teams you can manage in this program and season appear.</Text>
        </> : null}
        <FieldLabel>Title</FieldLabel>
        <TextField
          value={title}
          onChangeText={setTitle}
          error={errors.title}
          placeholder="Evening practice"
        />

        {!canonical ? <>
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

        </> : null}
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

        </> : null}
        <PrimaryButton
          label={isEdit ? 'Save changes' : 'Create event'}
          onPress={onSubmit}
          loading={loading}
          disabled={!ready}
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
