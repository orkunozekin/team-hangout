import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { EventRides as RidesData, OwnRide, RideArrangement, RideContact, RideDirection, RideKind, RideMatch } from '../../shared/rides';
import { areaProblem, RIDE_CHILDREN_MAX, RIDE_CONTACT_MAX, RIDE_DIRECTION_LABELS, RIDE_DIRECTIONS, RIDE_PICKUP_MAX, RIDE_SEATS_MAX, rideSeatsLabel } from '../../shared/rides';
import { aliasProblem } from '../../shared/volunteers';
import { confirmRideArrangement, getEventRides, getRideContacts, revokeRideConsent, rideRequestId, type RideConsent, type RideInput, saveRideRequest } from '../firebase/rides';
import { colors, radius, spacing, type } from '../theme/theme';
import { ConsentCheckbox, PrimaryButton, SecondaryButton, TextField } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

const domainCode = (error: unknown) => (error as { details?: { domainCode?: string } })?.details?.domainCode;
const uncertain = (error: unknown) => ['functions/unavailable', 'functions/deadline-exceeded'].includes((error as { code?: string })?.code ?? '');

const FAILURES: Record<string, string> = {
  RIDES_DISABLED: 'Ride coordination is not enabled for this organization.',
  RIDE_EVENT_CANCELLED: 'This event was cancelled.',
  RIDE_CLOSED: 'Ride coordination for this event has closed.',
  RIDE_SEATS_FULL: 'Those seats were just taken. The list has been refreshed.',
  RIDE_NEED_ARRANGED: 'This request already has an arrangement in progress.',
  RIDE_PARTY_UNAVAILABLE: 'The other adult can no longer take part in this ride.',
  RIDE_CONSENT_OUTDATED: 'Your organization updated its ride policy. Start a new arrangement.',
  RIDE_ARRANGEMENT_CLOSED: 'This ride arrangement was cancelled.',
  RIDE_ARRANGEMENT_ACTIVE: 'Cancel the current arrangement before changing this ride.',
  RIDE_SEATS_BELOW_RESERVED: 'Seats cannot be fewer than the seats already confirmed.',
  RIDE_NOT_ELIGIBLE: 'Only an adult guardian linked to each child, or the adult offering seats, can do this.',
  RIDE_CANCELLED: 'This ride was cancelled.',
  RIDE_MISSING: 'This ride is no longer available.',
  RIDE_DIRECTION_MISMATCH: 'This offer and request are for different directions.',
  RIDE_LIMIT: 'This ride has reached its limit. Ask your coordinator for help.',
  STALE_REVISION: 'This ride changed. The list has been refreshed.',
};

function message(error: unknown, fallback: string) {
  const code = domainCode(error);
  if (code && FAILURES[code]) return FAILURES[code];
  if ((error as { code?: string })?.code === 'functions/invalid-argument') return (error as Error).message || fallback;
  return fallback;
}

type Props = { orgId: string; eventId: string; teamId: string };
type Enabled = Extract<RidesData, { enabled: true }>;
type ContactState = { status: 'loading' } | { status: 'shown'; value: RideContact } | { status: 'unavailable' };

const STATE_LABELS = { pending: 'Waiting for both adults', confirmed: 'Confirmed', cancelled: 'Cancelled' } as const;

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return (
    <View style={styles.wrap}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={`${label} ${option.label}`} accessibilityState={{ selected }}
            onPress={() => onChange(option.value)} style={[styles.chip, selected ? styles.chipSelected : null]}>
            <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Both adults type what to share; nothing is prefilled from a profile. */
function ConsentForm({ busy, submitLabel, onSubmit, onClose }: {
  busy: boolean; submitLabel: string; onSubmit: (consent: RideConsent) => void; onClose: () => void;
}) {
  const [alias, setAlias] = useState('');
  const [contact, setContact] = useState('');
  const [pickup, setPickup] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState('');
  const submit = () => {
    const issue = aliasProblem(alias) ?? (contact.trim() ? null : 'Enter how the other adult can reach you.')
      ?? (agreed ? null : 'Confirm that these details can be shared with the other adult in this ride.');
    setProblem(issue ?? '');
    if (!issue) onSubmit({ displayAlias: alias.trim().replace(/\s+/g, ' '), contact: contact.trim(), pickupNote: pickup.trim() || null });
  };
  return (
    <View style={styles.form}>
      <TextField accessibilityLabel="Name shown to the other adult" value={alias} onChangeText={setAlias} maxLength={40} placeholder="For example, Sam R." autoCapitalize="words" />
      <TextField accessibilityLabel="How to reach you" value={contact} onChangeText={setContact} maxLength={RIDE_CONTACT_MAX} placeholder="Phone or email" />
      <TextField accessibilityLabel="Pickup details (optional)" value={pickup} onChangeText={setPickup} maxLength={RIDE_PICKUP_MAX} placeholder="Pickup spot or time (optional)" />
      <Text style={styles.copy}>Only the other adult in this ride sees these details, and only after you both confirm. Details already viewed cannot be recalled.</Text>
      <ConsentCheckbox checked={agreed} onToggle={() => setAgreed((value) => !value)} label={<Text>Share these details with the other adult in this ride</Text>} />
      {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
      <PrimaryButton label={submitLabel} loading={busy} onPress={submit} />
      <SecondaryButton label="Close" disabled={busy} onPress={onClose} />
    </View>
  );
}

function RideForm({ data, busy, onSave }: { data: Enabled; busy: boolean; onSave: (input: RideInput) => Promise<boolean> }) {
  const [kind, setKind] = useState<RideKind>(data.children.length ? 'need' : 'offer');
  const [direction, setDirection] = useState<RideDirection>('toEvent');
  const [area, setArea] = useState('');
  const [seats, setSeats] = useState('1');
  const [children, setChildren] = useState<string[]>([]);
  const [discoverable, setDiscoverable] = useState(true);
  const [problem, setProblem] = useState('');
  const kinds = [
    ...(data.children.length ? [{ value: 'need' as const, label: 'Need a ride' }] : []),
    ...(data.canOffer ? [{ value: 'offer' as const, label: 'Offer seats' }] : []),
  ];
  if (!kinds.length) return null;
  const save = async () => {
    const count = Number(seats);
    const issue = areaProblem(area)
      ?? (kind === 'offer' && (!Number.isInteger(count) || count < 1 || count > RIDE_SEATS_MAX) ? `Seats must be 1 through ${RIDE_SEATS_MAX}.` : null)
      ?? (kind === 'need' && !children.length ? 'Choose at least one child.' : null);
    setProblem(issue ?? '');
    if (issue) return;
    const base = { direction, area: area.trim().replace(/\s+/g, ' '), discoverable };
    if (await onSave(kind === 'offer' ? { kind, ...base, seats: count } : { kind, ...base, participantIds: children })) {
      setArea(''); setChildren([]);
    }
  };
  return (
    <View style={styles.form}>
      <Text style={styles.subheading}>Add a ride request or offer</Text>
      <Choice label="Ride type" value={kind} options={kinds} onChange={setKind} />
      <Choice label="Direction" value={direction} options={RIDE_DIRECTIONS.map((value) => ({ value, label: RIDE_DIRECTION_LABELS[value] }))} onChange={setDirection} />
      <TextField accessibilityLabel="Meeting area" value={area} onChangeText={setArea} maxLength={60} placeholder="Neighborhood or landmark" />
      <Text style={styles.copy}>Use a general area only. Share exact pickup details privately after both adults confirm.</Text>
      {kind === 'offer' ? (
        <TextField accessibilityLabel="Seats offered" value={seats} onChangeText={setSeats} keyboardType="number-pad" maxLength={1} />
      ) : data.children.map((child) => (
        <ConsentCheckbox key={child.participantId} checked={children.includes(child.participantId)}
          onToggle={() => setChildren((list) => list.includes(child.participantId) ? list.filter((value) => value !== child.participantId)
            : list.length < RIDE_CHILDREN_MAX ? [...list, child.participantId] : list)}
          label={<Text>{`Ride for ${child.displayName}`}</Text>} />
      ))}
      <ConsentCheckbox checked={discoverable} onToggle={() => setDiscoverable((value) => !value)}
        label={<Text>Let other team families find this by area and seats (no names are shown)</Text>} />
      {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
      <PrimaryButton label={kind === 'offer' ? 'Offer seats' : 'Request a ride'} loading={busy} onPress={() => void save()} />
    </View>
  );
}

function rideTitle(ride: { kind: RideKind; direction: RideDirection; area: string }) {
  return `${ride.kind === 'offer' ? 'Seats offered' : 'Ride needed'}, ${RIDE_DIRECTION_LABELS[ride.direction].toLowerCase()}, near ${ride.area}`;
}

function RidesPanel({ orgId, eventId, teamId }: Props) {
  const [data, setData] = useState<RidesData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consenting, setConsenting] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Record<string, ContactState>>({});
  const live = useRef(true);
  const request = useRef(0);
  const contactRequests = useRef<Record<string, number>>({});
  // One request ID per intended change; reused only when the previous attempt's outcome is unknown.
  const pending = useRef<{ intent: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => { live.current = false; }, []);

  const load = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const value = await getEventRides(eventId, teamId);
      if (!live.current || seq !== request.current) return;
      setData(value);
      setError('');
      // Revealed contacts are dropped as soon as the arrangement is no longer confirmed for this viewer.
      const confirmed = new Set(value.enabled ? value.arrangements.filter((row) => row.state === 'confirmed').map((row) => row.arrangementId) : []);
      setContacts((current) => Object.fromEntries(Object.entries(current).filter(([arrangementId]) => confirmed.has(arrangementId))));
      for (const arrangementId of Object.keys(contactRequests.current)) {
        if (!confirmed.has(arrangementId)) contactRequests.current[arrangementId] += 1;
      }
    } catch {
      if (live.current && seq === request.current) setError('Rides could not be loaded.');
    } finally {
      if (live.current && seq === request.current) setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (intent: string, action: (requestId: string) => Promise<unknown>, done: string, fallback: string) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    if (pending.current?.intent !== intent) pending.current = { intent, requestId: rideRequestId() };
    const { requestId } = pending.current;
    setBusy(true);
    setNotice('');
    try {
      await action(requestId);
      pending.current = null;
      if (live.current) { setNotice(done); setConsenting(null); }
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

  const showContact = async (arrangementId: string) => {
    const seq = (contactRequests.current[arrangementId] ?? 0) + 1;
    contactRequests.current[arrangementId] = seq;
    setContacts((current) => ({ ...current, [arrangementId]: { status: 'loading' } }));
    let next: ContactState;
    try {
      next = { status: 'shown', value: await getRideContacts(eventId, teamId, arrangementId) };
    } catch {
      next = { status: 'unavailable' };
    }
    if (live.current && contactRequests.current[arrangementId] === seq) setContacts((current) => ({ ...current, [arrangementId]: next }));
  };

  if (!data) {
    return (
      <View>
        {loading ? <ActivityIndicator accessibilityLabel="Loading rides" /> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {error ? <SecondaryButton label="Retry loading rides" onPress={() => void load()} /> : null}
      </View>
    );
  }
  if (!data.enabled) {
    return (
      <View>
        <Text accessibilityRole="header" style={styles.heading}>Rides</Text>
        <Text style={styles.state}>Ride coordination is off. Your organization turns it on only after it records a transport policy and a ride coordinator.</Text>
      </View>
    );
  }

  const candidates = (match: RideMatch): OwnRide[] => data.mine.filter((ride) => ride.status === 'open' && ride.canEdit && ride.direction === match.direction
    && (match.kind === 'offer' ? ride.kind === 'need' && !ride.hasArrangement && ride.seats <= match.seats : ride.kind === 'offer' && (ride.seatsOpen ?? 0) >= match.seats));
  const target = (match: RideMatch, own: OwnRide) => match.kind === 'offer' ? { offerId: match.rideId, needId: own.rideId } : { offerId: own.rideId, needId: match.rideId };

  const arrangementCard = (row: RideArrangement) => {
    const contact = contacts[row.arrangementId];
    const formKey = `arrangement:${row.arrangementId}`;
    return (
      <View key={row.arrangementId} style={[styles.card, row.state === 'cancelled' ? styles.cancelled : null]}>
        <Text style={styles.title}>{`${row.role === 'driver' ? 'You drive' : 'Your ride'}: ${RIDE_DIRECTION_LABELS[row.direction]}, ${row.seats} ${row.seats === 1 ? 'seat' : 'seats'}`}</Text>
        {row.participants.length ? <Text style={styles.copy}>{`For ${row.participants.join(', ')}`}</Text> : null}
        <Text style={row.state === 'confirmed' ? styles.own : styles.state}>{STATE_LABELS[row.state]}</Text>
        {row.counterpartAlias ? <Text style={styles.copy}>{`With ${row.counterpartAlias}`}</Text> : null}
        {row.state === 'cancelled' ? <Text style={styles.copy}>Contact details are no longer available. Anything already viewed or shared cannot be recalled.</Text> : null}
        {row.state === 'pending' && !row.awaitingYou ? <Text style={styles.copy}>Waiting for the other adult to confirm.</Text> : null}
        {row.awaitingYou && consenting !== formKey ? <SecondaryButton label="Review and confirm this ride" disabled={busy} onPress={() => setConsenting(formKey)} /> : null}
        {row.awaitingYou && consenting === formKey ? (
          <ConsentForm busy={busy} submitLabel="Confirm ride and share details" onClose={() => setConsenting(null)}
            onSubmit={(consent) => void run(`${formKey}:${JSON.stringify(consent)}`,
              (requestId) => confirmRideArrangement(orgId, eventId, teamId, { arrangementId: row.arrangementId }, consent, requestId),
              'Ride confirmed.', 'Could not confirm the ride.')} />
        ) : null}
        {row.state === 'confirmed' && contact?.status !== 'shown' ? (
          <SecondaryButton label="Show contact details" disabled={contact?.status === 'loading'} onPress={() => void showContact(row.arrangementId)} />
        ) : null}
        {row.state === 'confirmed' && contact?.status === 'unavailable' ? (
          <Text accessibilityRole="alert" style={styles.state}>Contact details are unavailable. The other adult may have withdrawn, or access changed.</Text>
        ) : null}
        {row.state === 'confirmed' && contact?.status === 'shown' ? (
          <View style={styles.contact}>
            <Text style={styles.own}>{`${contact.value.counterpart.alias}: ${contact.value.counterpart.contact}`}</Text>
            {contact.value.counterpart.pickupNote ? <Text style={styles.copy}>{contact.value.counterpart.pickupNote}</Text> : null}
            <Text style={styles.copy}>Shared only with you for this ride. Do not forward it.</Text>
          </View>
        ) : null}
        {row.state !== 'cancelled' ? (
          <SecondaryButton label={row.state === 'pending' && row.awaitingYou ? 'Decline this ride' : 'Cancel ride and stop sharing'} disabled={busy}
            onPress={() => void run(`revoke:${row.arrangementId}`, (requestId) => revokeRideConsent(orgId, eventId, teamId, row.arrangementId, requestId),
              'Ride cancelled. Your details are no longer shared.', 'Could not cancel the ride.')} />
        ) : null}
      </View>
    );
  };

  const cancelled = data.eventStatus === 'cancelled';
  return (
    <View>
      <Text accessibilityRole="header" style={styles.heading}>Rides</Text>
      <Text style={styles.copy}>{`Families coordinate rides under your organization's transport policy (version ${data.policyVersion}). This is not driver screening, insurance verification or a safety guarantee.`}</Text>
      {cancelled ? <Text accessibilityRole="alert" style={styles.state}>This event was cancelled. Ride arrangements are cancelled too.</Text> : null}
      {notice ? <Text accessibilityRole="alert" style={styles.status}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{`${error} Showing the last loaded rides.`}</Text> : null}

      {data.arrangements.length ? <Text style={styles.subheading}>Your arrangements</Text> : null}
      {data.arrangements.map(arrangementCard)}

      <Text style={styles.subheading}>Your requests and offers</Text>
      {data.mine.length === 0 ? <Text style={styles.copy}>You have no ride requests or offers for this event.</Text> : null}
      {data.mine.map((ride) => (
        <View key={ride.rideId} style={[styles.card, ride.status === 'cancelled' ? styles.cancelled : null]}>
          <Text style={styles.title}>{rideTitle(ride)}</Text>
          <Text style={styles.copy}>{ride.kind === 'offer' ? `${ride.seatsOpen} of ${ride.seats} seats open` : rideSeatsLabel('need', ride.seats)}</Text>
          {ride.participants.length ? <Text style={styles.copy}>{`For ${ride.participants.map((row) => row.displayName).join(', ')}`}</Text> : null}
          <Text style={styles.copy}>{ride.discoverable ? 'Other families can find this by area and seats.' : 'Hidden from other families.'}</Text>
          {!ride.updatedByYou && ride.kind === 'need' ? <Text style={styles.copy}>{`Last changed by another guardian (version ${ride.revision}).`}</Text> : null}
          {ride.status === 'cancelled' ? <Text style={styles.state}>Cancelled</Text> : null}
          {ride.status === 'open' && ride.canEdit ? (
            <SecondaryButton label={`Cancel ${ride.kind === 'offer' ? 'offer' : 'request'} ${RIDE_DIRECTION_LABELS[ride.direction].toLowerCase()} near ${ride.area}`} disabled={busy}
              onPress={() => void run(`cancel:${ride.rideId}:${ride.revision}`, (requestId) => saveRideRequest(orgId, eventId, teamId, ride.revision, { rideId: ride.rideId, action: 'cancel' }, requestId),
                'Ride cancelled.', 'Could not cancel the ride.')} />
          ) : null}
        </View>
      ))}

      {!cancelled ? <>
        <Text style={styles.subheading}>Find a match</Text>
        {data.matches.length === 0 ? <Text style={styles.copy}>No other families have shared a matching ride yet.</Text> : null}
        {data.matches.map((match) => {
          const own = candidates(match)[0];
          const formKey = `match:${match.rideId}`;
          return (
            <View key={match.rideId} style={styles.card}>
              <Text style={styles.title}>{rideTitle(match)}</Text>
              <Text style={styles.copy}>{rideSeatsLabel(match.kind, match.seats)}</Text>
              {!own ? <Text style={styles.copy}>{match.kind === 'offer' ? 'Add a matching ride request first.' : 'Add a matching seat offer first.'}</Text> : null}
              {own && consenting !== formKey ? (
                <SecondaryButton label={match.kind === 'offer' ? `Ask for seats near ${match.area}` : `Offer to drive near ${match.area}`} disabled={busy} onPress={() => setConsenting(formKey)} />
              ) : null}
              {own && consenting === formKey ? (
                <ConsentForm busy={busy} submitLabel="Send and share my details after confirmation" onClose={() => setConsenting(null)}
                  onSubmit={(consent) => void run(`${formKey}:${own.rideId}:${JSON.stringify(consent)}`,
                    (requestId) => confirmRideArrangement(orgId, eventId, teamId, target(match, own), consent, requestId),
                    'Sent. Details are shared after the other adult confirms.', 'Could not send the ride request.')} />
              ) : null}
            </View>
          );
        })}
        <RideForm data={data} busy={busy} onSave={(input) => run(`create:${JSON.stringify(input)}`,
          (requestId) => saveRideRequest(orgId, eventId, teamId, 0, input, requestId), 'Saved.', 'Could not save the ride.')} />
      </> : null}

      {data.coordination ? (
        <View style={styles.card}>
          <Text style={styles.subheading}>Coordinator summary</Text>
          <Text style={styles.copy}>{`${data.coordination.openRequests} open requests, ${data.coordination.openSeats} open seats.`}</Text>
          {data.coordination.arrangements.map((row) => (
            <View key={row.arrangementId} style={styles.row}>
              <Text style={styles.copy}>{`${STATE_LABELS[row.state]}: ${row.driverAlias ?? 'Driver pending'} with ${row.riderAlias ?? 'family pending'}, ${row.seats} ${row.seats === 1 ? 'seat' : 'seats'}`}</Text>
              {row.state !== 'cancelled' ? (
                <SecondaryButton label={`End arrangement for ${row.riderAlias ?? 'family'}`} disabled={busy}
                  onPress={() => void run(`revoke:${row.arrangementId}`, (requestId) => revokeRideConsent(orgId, eventId, teamId, row.arrangementId, requestId),
                    'Arrangement ended.', 'Could not end the arrangement.')} />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <SecondaryButton label="Refresh rides" disabled={loading} onPress={() => void load()} />
      {loading ? <ActivityIndicator accessibilityLabel="Loading rides" /> : null}
    </View>
  );
}

/** Private ride coordination for this team's event. Nothing is cached offline; contacts are fetched on demand. */
export default function EventRides({ orgId, eventId, teamId, initiallyOpen = false }: Props & { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <SecondaryButton label={open ? 'Hide rides' : 'Rides'} onPress={() => setOpen((value) => !value)} />
      {open ? <RidesPanel orgId={orgId} eventId={eventId} teamId={teamId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  subheading: { ...type.label, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  own: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.xs },
  state: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.xs, overflow: 'hidden' },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
  status: { ...type.bodyMedium, color: colors.text, marginVertical: spacing.sm },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  cancelled: { opacity: 0.75 },
  contact: { marginTop: spacing.xs },
  row: { marginTop: spacing.xs },
  title: { ...type.bodyMedium, color: colors.text },
  form: { marginTop: spacing.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 36, justifyContent: 'center', backgroundColor: colors.card },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.label, color: colors.text },
  chipTextSelected: { color: colors.white },
});
