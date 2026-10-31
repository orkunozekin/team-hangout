import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { EventVolunteers as VolunteersData, VolunteerKind, VolunteerSlot } from '../../shared/volunteers';
import { aliasProblem, deadlineInput, parseDeadline, slotStatusLabel, VOLUNTEER_CAPACITY_MAX, VOLUNTEER_KIND_LABELS, VOLUNTEER_KINDS } from '../../shared/volunteers';
import { claimVolunteerSlot, getEventVolunteers, releaseVolunteerSlot, saveVolunteerSlot, type SlotInput, volunteerRequestId } from '../firebase/volunteers';
import { colors, radius, spacing, type } from '../theme/theme';
import { ConsentCheckbox, FieldLabel, PrimaryButton, SecondaryButton, TextField } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

const domainCode = (error: unknown) => (error as { details?: { domainCode?: string } })?.details?.domainCode;
const uncertain = (error: unknown) => ['functions/unavailable', 'functions/deadline-exceeded'].includes((error as { code?: string })?.code ?? '');

const FAILURES: Record<string, string> = {
  VOLUNTEER_SLOT_FULL: 'Someone else took the last spot. The list has been refreshed.',
  VOLUNTEER_CLOSED: 'Sign-up for this slot has closed.',
  VOLUNTEER_SLOT_CANCELLED: 'This slot was cancelled.',
  VOLUNTEER_SLOT_MISSING: 'This slot no longer exists.',
  VOLUNTEER_NOT_ELIGIBLE: 'Only an adult guardian or coach of this team can volunteer.',
  VOLUNTEER_CAPACITY_BELOW_CLAIMS: 'Capacity cannot be lower than the number of volunteers already signed up.',
  VOLUNTEER_SLOT_LIMIT: 'This team already has the maximum number of volunteer slots for this event.',
  STALE_REVISION: 'This slot changed. The list has been refreshed.',
};

function message(error: unknown, fallback: string) {
  const code = domainCode(error);
  if (code && FAILURES[code]) return FAILURES[code];
  if ((error as { code?: string })?.code === 'functions/invalid-argument') return (error as Error).message || fallback;
  return fallback;
}

type Props = { orgId: string; eventId: string; teamId: string };

function SlotCard({ slot, data, busy, onClaim, onRelease, onRemove, onCancel, onEdit }: {
  slot: VolunteerSlot; data: VolunteersData; busy: boolean;
  onClaim: (slot: VolunteerSlot, alias: string) => void; onRelease: (slot: VolunteerSlot) => void;
  onRemove: (slot: VolunteerSlot, key: string, alias: string) => void; onCancel: (slot: VolunteerSlot) => void;
  onEdit: (slot: VolunteerSlot, input: SlotInput) => Promise<boolean>;
}) {
  const [claiming, setClaiming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState('');
  const [consent, setConsent] = useState(false);
  const [problem, setProblem] = useState('');
  const own = slot.ownClaim;
  const status = slotStatusLabel(slot);
  const names = slot.assignees.map((row) => row.alias).join(', ');
  const confirm = () => {
    const issue = aliasProblem(alias) ?? (consent ? null : 'Confirm that this name can appear on the volunteer list.');
    setProblem(issue ?? '');
    if (!issue) onClaim(slot, alias.trim().replace(/\s+/g, ' '));
  };
  // A finished claim closes the form; a failed one keeps the typed alias for another attempt.
  useEffect(() => { if (own) setClaiming(false); }, [own]);
  return (
    <View style={[styles.card, slot.state === 'cancelled' ? styles.cancelled : null]}>
      <View style={styles.cardHead}>
        <Text style={styles.title}>{slot.title}</Text>
        <Text style={styles.kind}>{VOLUNTEER_KIND_LABELS[slot.kind] ?? slot.kind}</Text>
      </View>
      <Text accessibilityLabel={`${slot.title}: ${status}`} style={slot.state === 'open' ? styles.copy : styles.state}>{status}</Text>
      {slot.claimDeadline && slot.state !== 'cancelled' ? <Text style={styles.copy}>{`Sign up by ${new Date(slot.claimDeadline).toLocaleString()}`}</Text> : null}
      <Text style={styles.copy}>{names ? `Volunteers: ${names}` : 'No volunteers yet.'}</Text>
      {own?.status === 'active' ? <>
        <Text style={styles.own}>{`You are signed up as ${own.alias.replace(/\.$/, '')}.`}</Text>
        {slot.state === 'open' || slot.state === 'full' ? <SecondaryButton label={`Release my spot for ${slot.title}`} disabled={busy} onPress={() => onRelease(slot)} /> : null}
      </> : null}
      {own?.status === 'cancelled' ? <Text accessibilityRole="alert" style={styles.state}>{`Your assignment as ${own.alias} was cancelled. No action is needed.`}</Text> : null}
      {!own && data.canClaim && slot.state === 'open' && !claiming ? (
        <SecondaryButton label={`Volunteer for ${slot.title}`} disabled={busy} onPress={() => setClaiming(true)} />
      ) : null}
      {!own && claiming && slot.state === 'open' ? (
        <View style={styles.form}>
          <Text style={styles.label}>Name shown to the team</Text>
          <TextField accessibilityLabel="Name shown to the team" value={alias} onChangeText={setAlias} maxLength={40} placeholder="For example, Sam R." autoCapitalize="words" />
          <Text style={styles.copy}>Only this name appears on the list. Your email, phone and children are never shown.</Text>
          <ConsentCheckbox checked={consent} onToggle={() => setConsent((value) => !value)} label={<Text>Show this name on the volunteer list</Text>} />
          {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
          <PrimaryButton label="Confirm volunteer spot" loading={busy} onPress={confirm} />
          <SecondaryButton label="Cancel" disabled={busy} onPress={() => { setClaiming(false); setProblem(''); }} />
        </View>
      ) : null}
      {data.canManage && slot.state !== 'cancelled' ? <>
        {slot.assignees.map((row) => row.assigneeKey ? (
          <SecondaryButton key={row.assigneeKey} label={`Remove ${row.alias}`} disabled={busy} onPress={() => onRemove(slot, row.assigneeKey!, row.alias)} />
        ) : null)}
        {editing
          ? <SlotForm key={slot.revision} initial={slot} busy={busy} onSave={(input) => onEdit(slot, input)} onClose={() => setEditing(false)} />
          : <SecondaryButton label={`Edit slot ${slot.title}`} disabled={busy} onPress={() => setEditing(true)} />}
        <SecondaryButton label={`Cancel slot ${slot.title}`} disabled={busy} onPress={() => onCancel(slot)} />
      </> : null}
    </View>
  );
}

function SlotForm({ initial, busy, onSave, onClose }: {
  initial?: VolunteerSlot; busy: boolean; onSave: (input: SlotInput) => Promise<boolean>; onClose?: () => void;
}) {
  const [kind, setKind] = useState<VolunteerKind>(initial?.kind ?? 'snacks');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 1));
  const [deadline, setDeadline] = useState(deadlineInput(initial?.claimDeadline ?? null));
  const [problem, setProblem] = useState('');
  const editing = !!initial;
  const save = async () => {
    const count = Number(capacity);
    const claimDeadline = parseDeadline(deadline);
    if (!title.trim()) return setProblem('Enter a slot title.');
    if (!Number.isInteger(count) || count < 1 || count > VOLUNTEER_CAPACITY_MAX) return setProblem(`Capacity must be 1 through ${VOLUNTEER_CAPACITY_MAX}.`);
    if (claimDeadline === undefined) return setProblem('Enter the deadline as YYYY-MM-DD HH:MM, or leave it blank.');
    setProblem('');
    if (await onSave({ kind, title: title.trim(), capacity: count, claimDeadline })) {
      if (editing) onClose?.();
      else { setTitle(''); setCapacity('1'); setDeadline(''); }
    }
  };
  const prefix = editing ? `Edit ${initial!.title}: ` : '';
  return (
    <View style={styles.form}>
      <Text style={styles.subheading}>{editing ? 'Edit volunteer slot' : 'Add a volunteer slot'}</Text>
      <View style={styles.wrap}>
        {VOLUNTEER_KINDS.map((value) => {
          const selected = value === kind;
          return (
            <Pressable key={value} accessibilityRole="button" accessibilityLabel={`${prefix}Slot kind ${VOLUNTEER_KIND_LABELS[value]}`} accessibilityState={{ selected }}
              onPress={() => setKind(value)} style={[styles.chip, selected ? styles.chipSelected : null]}>
              <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{VOLUNTEER_KIND_LABELS[value]}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextField accessibilityLabel={`${prefix}Slot title`} value={title} onChangeText={setTitle} maxLength={80} placeholder="Slot title" />
      <FieldLabel>Volunteers needed</FieldLabel>
      <TextField accessibilityLabel={`${prefix}Number of volunteers needed`} value={capacity} onChangeText={setCapacity} keyboardType="number-pad" maxLength={2} />
      <TextField accessibilityLabel={`${prefix}Sign-up deadline`} value={deadline} onChangeText={setDeadline} maxLength={16} placeholder="Deadline YYYY-MM-DD HH:MM (optional)" />
      <Text style={styles.copy}>Leave the deadline blank to keep sign-up open until the event starts.</Text>
      {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
      <PrimaryButton label={editing ? 'Save slot changes' : 'Add slot'} loading={busy} onPress={() => void save()} />
      {editing ? <SecondaryButton label="Close edit form" disabled={busy} onPress={() => onClose?.()} /> : null}
    </View>
  );
}

function VolunteersPanel({ orgId, eventId, teamId }: Props) {
  const [data, setData] = useState<VolunteersData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const request = useRef(0);
  // One request ID per intended change; reused only when the previous attempt's outcome is unknown.
  const pending = useRef<{ intent: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const value = await getEventVolunteers(eventId, teamId);
      if (!live.current || seq !== request.current) return;
      setData(value);
      setError('');
    } catch {
      if (live.current && seq === request.current) setError('Volunteer slots could not be loaded.');
    } finally {
      if (live.current && seq === request.current) setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (intent: string, action: (requestId: string) => Promise<unknown>, done: string, fallback: string) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    if (pending.current?.intent !== intent) pending.current = { intent, requestId: volunteerRequestId() };
    const { requestId } = pending.current;
    setBusy(true);
    setNotice('');
    try {
      await action(requestId);
      pending.current = null;
      if (live.current) setNotice(done);
      return true;
    } catch (reason) {
      if (!uncertain(reason)) pending.current = null;
      if (live.current) setNotice(uncertain(reason) ? `${fallback} The change may not have been saved. Try again to confirm.` : message(reason, fallback));
      return false;
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
      await load();
    }
  };

  if (!data) {
    return (
      <View>
        {loading ? <ActivityIndicator accessibilityLabel="Loading volunteer slots" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {error ? <SecondaryButton label="Retry loading volunteer slots" onPress={() => void load()} /> : null}
      </View>
    );
  }
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Volunteers</Text>
      {data.eventStatus === 'cancelled' ? <Text accessibilityRole="alert" style={styles.state}>This event was cancelled. Volunteer assignments are cancelled too.</Text> : null}
      {notice ? <Text accessibilityRole="alert" style={styles.status}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{`${error} Showing the last loaded list.`}</Text> : null}
      {data.slots.length === 0 ? <Text style={styles.copy}>{data.canManage ? 'No volunteer slots yet. Add one below.' : 'No volunteer slots for this event.'}</Text> : null}
      {data.slots.map((slot) => (
        <SlotCard
          key={slot.slotId}
          slot={slot}
          data={data}
          busy={busy}
          onClaim={(target, alias) => void run(`claim:${target.slotId}:${alias}`,
            (requestId) => claimVolunteerSlot(orgId, eventId, teamId, target.slotId, alias, requestId), `You are signed up for ${target.title}.`, 'Could not sign you up.')}
          onRelease={(target) => void run(`release:${target.slotId}`,
            (requestId) => releaseVolunteerSlot(orgId, eventId, teamId, target.slotId, requestId), `You released your spot for ${target.title}.`, 'Could not release your spot.')}
          onRemove={(target, key, alias) => void run(`remove:${target.slotId}:${key}`,
            (requestId) => releaseVolunteerSlot(orgId, eventId, teamId, target.slotId, requestId, key), `Removed ${alias} from ${target.title}.`, 'Could not remove the volunteer.')}
          onEdit={(target, input) => run(`edit:${target.slotId}:${target.revision}:${JSON.stringify(input)}`,
            (requestId) => saveVolunteerSlot(orgId, eventId, teamId, target.revision, { slotId: target.slotId, ...input }, requestId), `Saved ${input.title}.`, 'Could not save the slot.')}
          onCancel={(target) => void run(`cancel:${target.slotId}:${target.revision}`,
            (requestId) => saveVolunteerSlot(orgId, eventId, teamId, target.revision, { slotId: target.slotId, action: 'cancel' }, requestId), `Cancelled ${target.title}.`, 'Could not cancel the slot.')}
        />
      ))}
      {data.canManage && data.eventStatus !== 'cancelled' ? (
        <SlotForm busy={busy} onSave={(input) => run(`create:${JSON.stringify(input)}`,
          (requestId) => saveVolunteerSlot(orgId, eventId, teamId, 0, input, requestId), `Added ${input.title}.`, 'Could not add the slot.')} />
      ) : null}
      <SecondaryButton label="Refresh volunteer slots" disabled={loading} onPress={() => void load()} />
      {loading ? <ActivityIndicator accessibilityLabel="Loading volunteer slots" /> : null}
    </View>
  );
}

/** Volunteer slots for this team's event. Public lists show only the alias each adult chose; nothing is cached offline. */
export default function EventVolunteers({ orgId, eventId, teamId, initiallyOpen = false }: Props & { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <SecondaryButton label={open ? 'Hide volunteers' : 'Volunteers'} onPress={() => setOpen((value) => !value)} />
      {open ? <VolunteersPanel orgId={orgId} eventId={eventId} teamId={teamId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  label: { ...type.label, color: colors.text, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  own: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.xs },
  state: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.xs, overflow: 'hidden' },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  status: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.sm },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  cancelled: { opacity: 0.75 },
  cardHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing.sm },
  title: { ...type.bodyMedium, color: colors.text, flexShrink: 1, flexGrow: 1 },
  kind: { ...type.label, color: colors.textMuted },
  form: { marginTop: spacing.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
});
