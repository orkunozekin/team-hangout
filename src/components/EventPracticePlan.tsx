import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { CoachPracticePlan, CoachResource, EventPracticePlan as PlanData, HouseholdPracticePlan, PlanItem } from '../../shared/practiceResources';
import { ageLabel, NOTICE_LABELS, parseAge, plannedProblem, PRACTICE_HOUSEHOLD_NOTE_MAX, PRACTICE_NOTE_MAX } from '../../shared/practiceResources';
import { getEventPracticePlan, listTeamPracticeResources, practiceRequestId, savePracticePlan } from '../firebase/practice';
import { colors, radius, spacing, type } from '../theme/theme';
import { Accordion, FieldLabel, PrimaryButton, SecondaryButton, TextField } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

const domainCode = (error: unknown) => (error as { details?: { domainCode?: string } })?.details?.domainCode;
const uncertain = (error: unknown) => ['functions/unavailable', 'functions/deadline-exceeded'].includes((error as { code?: string })?.code ?? '');

const FAILURES: Record<string, string> = {
  PRACTICE_RESOURCE_UNAVAILABLE: 'A resource in this plan was withdrawn, expired or replaced. Remove it, or add the current version, then try again.',
  PRACTICE_PLAN_NOT_SAVED: 'Save the plan before publishing it.',
  PRACTICE_EVENT_CANCELLED: 'This practice was cancelled.',
  PRACTICE_RESOURCES_DISABLED: 'Practice resources are not enabled for this organization.',
  STALE_REVISION: 'This plan changed on another device. The latest plan has been loaded.',
};

function message(error: unknown, fallback: string) {
  const code = domainCode(error);
  if (code && FAILURES[code]) return FAILURES[code];
  if ((error as { code?: string })?.code === 'functions/invalid-argument') return (error as Error).message || fallback;
  return fallback;
}

type Props = { orgId: string; eventId: string; teamId: string };
type Draft = Pick<PlanItem, 'resourceId' | 'version' | 'title' | 'ageMin' | 'ageMax' | 'equipment' | 'instructions' | 'safetyNotes' | 'attribution'>
  & { minutes: string; notice: PlanItem['notice'] };

/** Keeps the saved version's guidance so the coach can run the activity from the plan. */
const toDraft = (item: PlanItem | CoachResource, minutes: number): Draft => ({
  resourceId: item.resourceId, version: item.version, title: item.title, ageMin: item.ageMin, ageMax: item.ageMax,
  equipment: item.equipment, instructions: item.instructions, safetyNotes: item.safetyNotes, attribution: item.attribution,
  minutes: String(minutes), notice: 'notice' in item ? item.notice ?? null : null,
});

function ResourcePicker({ orgId, teamId, chosen, onAdd }: { orgId: string; teamId: string; chosen: Set<string>; onAdd: (row: CoachResource) => void }) {
  const [ageText, setAgeText] = useState('');
  const [rows, setRows] = useState<CoachResource[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [shownAge, setShownAge] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const request = useRef(0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const search = async (more: boolean) => {
    const age = more ? shownAge : parseAge(ageText);
    if (age === undefined) return setProblem('Enter an age from 4 to 19, or leave it blank.');
    setProblem('');
    // Only the newest search may update the list, so a slow earlier response cannot replace a later filter.
    const seq = ++request.current;
    setLoading(true);
    try {
      const page = await listTeamPracticeResources(orgId, teamId, age, more ? cursor : null);
      if (!live.current || seq !== request.current) return;
      setRows((current) => (more && current ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setShownAge(age);
    } catch (reason) {
      if (live.current && seq === request.current) setProblem(message(reason, 'Resources could not be loaded.'));
    } finally {
      if (live.current && seq === request.current) setLoading(false);
    }
  };
  return (
    <View style={styles.form}>
      <Text style={styles.subheading}>Add reviewed resources</Text>
      <TextField accessibilityLabel="Player age filter" value={ageText} onChangeText={setAgeText} keyboardType="number-pad" maxLength={2} placeholder="Player age (optional)" />
      <SecondaryButton label="Show resources" onPress={() => void search(false)} />
      {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
      {loading ? <ActivityIndicator accessibilityLabel="Loading practice resources" /> : null}
      {rows && rows.length === 0 && !cursor ? (
        <Text style={styles.copy}>{shownAge != null ? `No reviewed resources for age ${shownAge} yet.` : 'No reviewed resources for this program yet.'}</Text>
      ) : null}
      {rows?.map((row) => (
        <View key={row.resourceId} style={styles.card}>
          <Text style={styles.title}>{row.title}</Text>
          <Text style={styles.copy}>{`${ageLabel(row)} · ${row.durationMinutes} min · Version ${row.version}`}</Text>
          <Text style={styles.copy}>{row.objectives.join(' · ')}</Text>
          {row.attribution ? <Text style={styles.copy}>{`Source: ${row.attribution}`}</Text> : null}
          <SecondaryButton label={chosen.has(row.resourceId) ? `${row.title} is in the plan` : `Add ${row.title}`} disabled={chosen.has(row.resourceId)} onPress={() => onAdd(row)} />
        </View>
      ))}
      {cursor ? <SecondaryButton label="Show more resources" disabled={loading} onPress={() => void search(true)} /> : null}
    </View>
  );
}

function CoachPanel({ orgId, eventId, teamId, data, reload }: Props & { data: CoachPracticePlan; reload: () => Promise<void> }) {
  const [items, setItems] = useState<Draft[]>([]);
  const [householdNote, setHouseholdNote] = useState('');
  const [privateNote, setPrivateNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const pending = useRef<{ intent: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // A new server revision replaces local edits; a failed save keeps them for another attempt.
  useEffect(() => {
    setItems(data.items.map((item) => toDraft(item, item.plannedMinutes)));
    setHouseholdNote(data.householdNote);
    setPrivateNote(data.privateNote);
  }, [data]);

  const run = async (intent: string, action: (requestId: string) => Promise<unknown>, done: string, fallback: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (pending.current?.intent !== intent) pending.current = { intent, requestId: practiceRequestId() };
    const { requestId } = pending.current;
    setBusy(true);
    setNotice('');
    let refresh = true;
    try {
      await action(requestId);
      pending.current = null;
      if (live.current) setNotice(done);
    } catch (reason) {
      if (!uncertain(reason)) pending.current = null;
      // Keep the coach's unsaved edits unless the server copy changed underneath them.
      refresh = domainCode(reason) === 'STALE_REVISION';
      if (live.current) setNotice(uncertain(reason) ? `${fallback} The change may not have been saved. Try again to confirm.` : message(reason, fallback));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
    if (refresh) await reload();
  };

  const save = () => {
    const input = items.map((item) => ({ resourceId: item.resourceId, version: item.version, plannedMinutes: Number(item.minutes) }));
    const problem = plannedProblem(input);
    if (problem) return setNotice(problem);
    const payload = { action: 'save' as const, items: input, householdNote: householdNote.trim(), privateNote: privateNote.trim() };
    void run(`save:${data.revision}:${JSON.stringify(payload)}`, (requestId) => savePracticePlan(orgId, eventId, teamId, data.revision, payload, requestId),
      'Practice plan saved.', 'Could not save the practice plan.');
  };
  const publication = (action: 'publish' | 'retract') => void run(`${action}:${data.revision}`,
    (requestId) => savePracticePlan(orgId, eventId, teamId, data.revision, { action }, requestId),
    action === 'publish' ? 'Shared with households.' : 'No longer shared with households.', 'Could not change sharing.');
  const update = (index: number, patch: Partial<Draft>) => setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const total = items.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
  const published = data.publication.state === 'published';
  return (
    <View>
      <Text style={styles.copy}>Only reviewed resources with recorded permission can be added. Private notes are never shared.</Text>
      {notice ? <Text accessibilityRole="alert" style={styles.status}>{notice}</Text> : null}
      <Text style={styles.state}>
        {published
          ? data.publication.sourceRevision === data.revision ? 'Shared with households.' : 'Shared with households. Publish again to share later changes.'
          : 'Private to coaches.'}
      </Text>
      {items.length === 0 ? <Text style={styles.copy}>No activities yet. Add reviewed resources below.</Text> : null}
      {items.map((item, index) => (
        <View key={item.resourceId} style={[styles.card, item.notice === 'withdrawn' || item.notice === 'expired' ? styles.blocked : null]}>
          <Text style={styles.title}>{`${index + 1}. ${item.title}`}</Text>
          <Text style={styles.copy}>{`${ageLabel(item)} · Version ${item.version}`}</Text>
          {item.notice ? <Text accessibilityRole="alert" style={styles.warning}>{NOTICE_LABELS[item.notice]}</Text> : null}
          {item.equipment.length ? <Text style={styles.copy}>{`Equipment: ${item.equipment.join(', ')}`}</Text> : null}
          <Text style={styles.copy}>{item.instructions}</Text>
          <Text style={styles.copy}>{`Safety: ${item.safetyNotes}`}</Text>
          {item.attribution ? <Text style={styles.copy}>{`Source: ${item.attribution}`}</Text> : null}
          <FieldLabel>Minutes</FieldLabel>
          <TextField accessibilityLabel={`Minutes for ${item.title}`} value={item.minutes} onChangeText={(minutes) => update(index, { minutes })} keyboardType="number-pad" maxLength={3} />
          <SecondaryButton label={`Remove ${item.title}`} disabled={busy} onPress={() => setItems((rows) => rows.filter((_, i) => i !== index))} />
        </View>
      ))}
      <Text style={styles.copy}>{`Planned total: ${total} min`}</Text>
      <FieldLabel>Household note (shared when published)</FieldLabel>
      <TextField accessibilityLabel="Note shared with households" value={householdNote} onChangeText={setHouseholdNote} maxLength={PRACTICE_HOUSEHOLD_NOTE_MAX} multiline placeholder="Note for households (shared when published)" />
      <FieldLabel>Private coach note (never shared)</FieldLabel>
      <TextField accessibilityLabel="Private coach note" value={privateNote} onChangeText={setPrivateNote} maxLength={PRACTICE_NOTE_MAX} multiline placeholder="Private coach note (never shared)" />
      <PrimaryButton label="Save practice plan" loading={busy} onPress={save} />
      {data.revision > 0 ? (
        published
          ? <><SecondaryButton label="Publish latest plan" disabled={busy} onPress={() => publication('publish')} /><SecondaryButton label="Stop sharing with households" disabled={busy} onPress={() => publication('retract')} /></>
          : <SecondaryButton label="Share with households" disabled={busy} onPress={() => publication('publish')} />
      ) : null}
      <ResourcePicker orgId={orgId} teamId={teamId} chosen={new Set(items.map((item) => item.resourceId))}
        onAdd={(row) => setItems((rows) => (rows.some((item) => item.resourceId === row.resourceId) ? rows : [...rows, toDraft(row, row.durationMinutes)]))} />
    </View>
  );
}

function HouseholdPanel({ data }: { data: HouseholdPracticePlan }) {
  if (data.state !== 'published') return <Text style={styles.copy}>No practice plan has been shared for this practice.</Text>;
  return (
    <View>
      {data.householdNote ? <Text style={styles.copy}>{data.householdNote}</Text> : null}
      {data.items?.map((item, index) => (
        <View key={`${index}:${item.title}`} style={styles.card}>
          <Text style={styles.title}>{`${index + 1}. ${item.title} · ${item.plannedMinutes} min`}</Text>
          {item.notice === 'withdrawn' || item.notice === 'expired'
            ? <Text style={styles.warning}>This activity is no longer available. Your coach will update the plan.</Text>
            : <>
              {item.equipment?.length ? <Text style={styles.copy}>{`Equipment: ${item.equipment.join(', ')}`}</Text> : null}
              <Text style={styles.copy}>{item.instructions}</Text>
              <Text style={styles.copy}>{`Safety: ${item.safetyNotes}`}</Text>
              {item.attribution ? <Text style={styles.copy}>{`Source: ${item.attribution}`}</Text> : null}
            </>}
        </View>
      ))}
    </View>
  );
}

function PlanPanel({ orgId, eventId, teamId }: Props) {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const value = await getEventPracticePlan(eventId, teamId);
      if (!live.current || seq !== request.current) return;
      setData(value);
      setError('');
    } catch {
      if (live.current && seq === request.current) setError('The practice plan could not be loaded.');
    } finally {
      if (live.current && seq === request.current) setLoading(false);
    }
  }, [eventId, teamId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Practice plan</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{data ? `${error} Showing the last loaded plan.` : error}</Text> : null}
      {error && !data ? <SecondaryButton label="Retry loading the practice plan" onPress={() => void load()} /> : null}
      {loading && !data ? <ActivityIndicator accessibilityLabel="Loading practice plan" /> : null}
      {data && !data.enabled ? <Text style={styles.copy}>Practice resources are not enabled for this organization.</Text> : null}
      {data?.enabled && data.canManage ? <CoachPanel orgId={orgId} eventId={eventId} teamId={teamId} data={data} reload={load} /> : null}
      {data?.enabled && !data.canManage ? <HouseholdPanel data={data} /> : null}
    </View>
  );
}

/** Practice plan for this team's practice. Coaches build it from reviewed resources; households see only the shared copy. */
export default function EventPracticePlan({ orgId, eventId, teamId, initiallyOpen = false }: Props & { initiallyOpen?: boolean }) {
  return (
    <View style={styles.section}>
      <Accordion title="Practice plan" initiallyOpen={initiallyOpen}>
        <PlanPanel orgId={orgId} eventId={eventId} teamId={teamId} />
      </Accordion>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  title: { ...type.bodyMedium, color: colors.text, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  state: { ...type.bodyMedium, color: colors.text, marginBottom: spacing.xs },
  status: { ...type.body, color: colors.text, marginBottom: spacing.xs },
  warning: { ...type.body, color: colors.danger, marginBottom: spacing.xs },
  error: { ...type.body, color: colors.danger, marginBottom: spacing.xs },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  blocked: { borderColor: colors.danger },
  form: { marginTop: spacing.md },
});
