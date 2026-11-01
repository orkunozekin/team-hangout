import EventAvailability from "./EventAvailability";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  AgendaEvent,
  AgendaPage,
  AgendaRequest,
} from "../../shared/agenda";
import { listHouseholdAgenda } from "../firebase/agenda";
import {
  addDays,
  agendaTime,
  dateInZone,
  dayBoundary,
} from "../lib/agendaTime";
import { Accordion, FieldLabel, TextField } from "./ui";
import { colors, type } from "../theme/theme";
import OfflineNotice from "./OfflineNotice";
import {
  clearGameDayCache,
  isGameDayCacheAccessLoss,
  loadCachedAgenda,
  saveCachedAgenda,
  type CachedValue,
} from "../lib/gameDayCache";

function Action({
  label,
  selected = false,
  disabled = false,
  expanded,
  onPress,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        selected && styles.selected,
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}
const emptyFilters = {
  participant: "",
  team: "",
  org: "",
  season: "",
  eventType: "",
  archived: false,
};
export default function HouseholdAgenda({
  refresh,
  onAccessDenied,
  onAccessRefreshed,
  userId,
}: {
  refresh: number;
  onAccessDenied?: () => void;
  onAccessRefreshed?: () => void;
  userId?: string;
}) {
  const deniedCallback = useRef(onAccessDenied);
  deniedCallback.current = onAccessDenied;
  const refreshedCallback = useRef(onAccessRefreshed);
  refreshedCallback.current = onAccessRefreshed;
  const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [zone, setZone] = useState(defaultZone);
  const [zoneInput, setZoneInput] = useState(defaultZone);
  const [day, setDay] = useState(() => dateInZone(new Date(), defaultZone));
  const [dayInput, setDayInput] = useState(day);
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState<AgendaPage | null>(null);
  const [items, setItems] = useState<AgendaEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [responseEvent, setResponseEvent] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [cached, setCached] = useState<CachedValue<AgendaPage> | null>(null);
  const generation = useRef(0);
  const request = useRef<AgendaRequest | null>(null);
  useEffect(() => {
    const token = ++generation.current;
    setPage(null);
    setResponseEvent(null);
    setItems([]);
    setError("");
    setCached(null);
    setBusy(true);
    const [participantOrg, participantId] = filters.participant.split("/");
    const [seasonOrg, seasonId] = filters.season.split("/");
    const input: AgendaRequest = {
      from: dayBoundary(day, zone),
      to: dayBoundary(addDays(day, 30), zone),
      ...(participantId
        ? { participantRefs: [{ orgId: participantOrg, participantId }] }
        : {}),
      ...(seasonId ? { seasonRefs: [{ orgId: seasonOrg, seasonId }] } : {}),
      ...(filters.team ? { teamIds: [filters.team] } : {}),
      ...(filters.org ? { orgIds: [filters.org] } : {}),
      ...(filters.eventType
        ? { eventTypes: [filters.eventType as "practice" | "match"] }
        : {}),
      includeArchived: filters.archived,
      pageSize: 20,
    };
    request.current = input;
    void listHouseholdAgenda(input)
      .then((result) => {
        if (generation.current !== token) return;
        refreshedCallback.current?.();
        // A preference for a removed grant cannot stay selected or masquerade as current access.
        const valid = { ...filters };
        if (
          valid.participant &&
          !result.teams.some((t) =>
            t.participants.some(
              (p) => `${p.orgId}/${p.participantId}` === valid.participant,
            ),
          )
        )
          valid.participant = "";
        if (valid.team && !result.teams.some((t) => t.id === valid.team))
          valid.team = "";
        if (valid.org && !result.teams.some((t) => t.orgId === valid.org))
          valid.org = "";
        if (
          valid.season &&
          !result.teams.some((t) => `${t.orgId}/${t.seasonId}` === valid.season)
        )
          valid.season = "";
        if (JSON.stringify(valid) !== JSON.stringify(filters)) {
          setFilters(valid);
          return;
        }
        setPage(result);
        setItems(result.items);
        if (
          userId &&
          day === dateInZone(new Date(), zone) &&
          JSON.stringify(filters) === JSON.stringify(emptyFilters)
        ) void saveCachedAgenda(userId, result).catch(() => undefined);
      })
      .catch(async (e) => {
        const denied = isGameDayCacheAccessLoss(e);
        if (denied && userId) await clearGameDayCache(userId).catch(() => undefined);
        if (generation.current !== token) return;
        const eligible = userId && day === dateInZone(new Date(), zone) &&
          JSON.stringify(filters) === JSON.stringify(emptyFilters);
        const copy = eligible ? await loadCachedAgenda(userId) : null;
        if (generation.current !== token) return;
        if (copy && !denied) {
          setCached(copy);
          setPage(copy.value);
          setItems(copy.value.items);
          setError("");
          return;
        }
        fail(e);
      })
      .finally(() => {
        if (generation.current === token) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [refresh, version, day, zone, filters, userId]);
  function fail(e: unknown) {
    setPage(null);
    setResponseEvent(null);
    setItems([]);
    const denied = isGameDayCacheAccessLoss(e);
    if (denied)
      deniedCallback.current?.();
    setError(
      denied
        ? "Permission removed or agenda access changed. Reload to see your current household."
        : "Unable to load your agenda. Check your connection and try again.",
    );
  }
  async function more() {
    if (!page?.nextCursor || !request.current || busy) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await listHouseholdAgenda({
        ...request.current,
        cursor: page.nextCursor,
      });
      if (token !== generation.current) return;
      if (result.accessVersion !== page.accessVersion) {
        if (userId) await clearGameDayCache(userId).catch(() => undefined);
        fail({ details: { domainCode: "AGENDA_CHANGED" } });
        return;
      }
      setItems((previous) => [
        ...new Map(
          [...previous, ...result.items].map((item) => [item.id, item]),
        ).values(),
      ]);
      setPage(result);
    } catch (e) {
      if (isGameDayCacheAccessLoss(e) && userId) {
        await clearGameDayCache(userId).catch(() => undefined);
      }
      if (token === generation.current) fail(e);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  function applyWindow() {
    try {
      dayBoundary(dayInput, zoneInput.trim());
      dayBoundary(addDays(dayInput, 30), zoneInput.trim());
      setZone(zoneInput.trim());
      setDay(dayInput);
      setVersion((n) => n + 1);
      setError("");
    } catch {
      setError(
        "Enter a valid date (YYYY-MM-DD) and IANA timezone, such as America/Chicago.",
      );
    }
  }
  const teams = page?.teams ?? [];
  const participants = [
    ...new Map(
      teams
        .flatMap((t) => t.participants)
        .map((p) => [`${p.orgId}/${p.participantId}`, p]),
    ).values(),
  ];
  const organizations = [
    ...new Map(teams.map((t) => [t.orgId, t.organizationName])).entries(),
  ];
  const seasons = [
    ...new Map(
      teams.map((t) => [
        `${t.orgId}/${t.seasonId}`,
        `${t.seasonName} · ${t.organizationName}`,
      ]),
    ).entries(),
  ];
  function choose(field: keyof typeof emptyFilters, value: string | boolean) {
    setFilters((previous) => ({ ...previous, [field]: value }));
  }
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>Household calendar</Text>
      <Text style={styles.copy}>
        {day} through {addDays(day, 29)}
      </Text>
      <Text style={styles.small}>Display timezone: {zone}</Text>
      <Text style={styles.small}>
        Published schedules for your approved participants and team roles. Times
        use the display timezone below.
      </Text>
      <Accordion title="Calendar filters">
        <View>
          <FieldLabel>First day (YYYY-MM-DD)</FieldLabel>
          <TextField
            accessibilityLabel="Calendar first day"
            value={dayInput}
            onChangeText={setDayInput}
            autoCapitalize="none"
          />
          <FieldLabel>Display timezone</FieldLabel>
          <TextField
            accessibilityLabel="Display timezone"
            value={zoneInput}
            onChangeText={setZoneInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Action label="Apply dates and timezone" onPress={applyWindow} />
          <FieldLabel>Participant</FieldLabel>
          <View style={styles.wrap}>
            <Action
              label="All participants"
              selected={!filters.participant}
              onPress={() => choose("participant", "")}
            />
            {participants.map((p) => (
              <Action
                key={`${p.orgId}/${p.participantId}`}
                label={p.displayName}
                selected={
                  filters.participant === `${p.orgId}/${p.participantId}`
                }
                onPress={() =>
                  choose("participant", `${p.orgId}/${p.participantId}`)
                }
              />
            ))}
          </View>
          <FieldLabel>Team</FieldLabel>
          <View style={styles.wrap}>
            <Action
              label="All teams"
              selected={!filters.team}
              onPress={() => choose("team", "")}
            />
            {teams.map((t) => (
              <Action
                key={t.id}
                label={t.name}
                selected={filters.team === t.id}
                onPress={() => choose("team", t.id)}
              />
            ))}
          </View>
          <FieldLabel>Organization</FieldLabel>
          <View style={styles.wrap}>
            <Action
              label="All organizations"
              selected={!filters.org}
              onPress={() => choose("org", "")}
            />
            {organizations.map(([id, name]) => (
              <Action
                key={id}
                label={name}
                selected={filters.org === id}
                onPress={() => choose("org", id)}
              />
            ))}
          </View>
          <FieldLabel>Season</FieldLabel>
          <View style={styles.wrap}>
            <Action
              label={filters.archived ? "All seasons" : "All current seasons"}
              selected={!filters.season}
              onPress={() => choose("season", "")}
            />
            {seasons.map(([id, name]) => (
              <Action
                key={id}
                label={name}
                selected={filters.season === id}
                onPress={() => choose("season", id)}
              />
            ))}
          </View>
          <FieldLabel>Event type</FieldLabel>
          <View style={styles.wrap}>
            {[
              ["", "All event types"],
              ["practice", "Practice"],
              ["match", "Match"],
            ].map(([value, label]) => (
              <Action
                key={value}
                label={label}
                selected={filters.eventType === value}
                onPress={() => choose("eventType", value)}
              />
            ))}
          </View>
          <Action
            label={
              filters.archived
                ? "Hide archived seasons"
                : "Include archived seasons"
            }
            selected={filters.archived}
            onPress={() => choose("archived", !filters.archived)}
          />
          <Action
            label="Reset calendar filters"
            onPress={() => setFilters(emptyFilters)}
          />
        </View>
      </Accordion>
      {error ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {cached ? <OfflineNotice savedAt={cached.savedAt} olderThanTtl={cached.olderThanTtl} /> : null}
      {busy ? (
        <ActivityIndicator accessibilityLabel="Loading household agenda" />
      ) : null}
      {page?.setupRequired ? (
        <Text style={styles.notice}>
          Some legacy schedules need setup. Ask your administrator to confirm
          event times and publish the migrated schedule. Use Teams for existing
          single-team schedules.
        </Text>
      ) : null}
      {page && !items.length ? (
        <Text style={styles.copy}>
          No published events match this date window and these filters.
        </Text>
      ) : null}
      {items.map((event) => (
        <View key={event.id} style={styles.card}>
          <Text style={styles.eventTitle}>{event.title}</Text>
          {event.status ? <Text style={styles.copy}>{event.status === "postponed" ? "Postponed: awaiting a new schedule" : event.status === "cancelled" ? "Cancelled" : event.status === "completed" ? "Completed" : "Scheduled"} · Schedule version {event.scheduleVersion ?? 1}</Text> : null}
          <Text style={styles.copy}>
            {event.participants.map((p) => p.displayName).join(" · ") ||
              "Your team role"}
          </Text>
          <Text style={styles.time}>
            {agendaTime(event.startsAt, event.endsAt, zone)}
          </Text>
          <Text style={styles.small}>Event timezone: {event.timeZone}</Text>
          <Text style={styles.copy}>
            {event.type === "practice" ? "Practice" : "Match"} ·{" "}
            {event.teams.map((t) => t.name).join(" · ")}
          </Text>
          <Text style={styles.small}>
            {event.teams
              .map(
                (t) =>
                  `${t.organizationName} · ${t.seasonName}${t.archived ? " (archived)" : ""}`,
              )
              .filter((v, i, all) => all.indexOf(v) === i)
              .join("\n")}
          </Text>
          {cached ? (
            <Text style={styles.small}>Responses and check-in require a connection. No offline changes are queued.</Text>
          ) : (
            <>
              <Action label={responseEvent === event.id ? "Hide responses" : `Responses for ${event.title}`} onPress={() => setResponseEvent(value => value === event.id ? null : event.id)} />
              {responseEvent === event.id ? <EventAvailability eventId={event.id} /> : null}
            </>
          )}
          <Text style={styles.copy}>
            {event.location?.name || "Location to be confirmed"}
            {event.location?.address ? `\n${event.location.address}` : ""}
          </Text>
        </View>
      ))}
      {page?.nextCursor ? (
        <Action
          label="Load more events"
          disabled={busy}
          onPress={() => void more()}
        />
      ) : null}
      <Action
        label="Reload calendar"
        disabled={busy}
        onPress={() => setVersion((n) => n + 1)}
      />
      <Text style={styles.small}>
        Legacy schedules appear in Teams until their event times are confirmed
        and published. Calendar access is checked when loaded; reload after
        access changes.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  section: { marginTop: 20, marginBottom: 24 },
  heading: { ...type.h2, color: colors.text, marginBottom: 12 },
  eventTitle: { ...type.h2, color: colors.text, marginBottom: 8 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 8 },
  small: { ...type.caption, color: colors.textMuted, marginBottom: 8 },
  time: { ...type.bodyMedium, color: colors.text, marginBottom: 8 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    marginVertical: 8,
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  action: {
    backgroundColor: colors.primarySoft,
    padding: 12,
    minHeight: 48,
    borderRadius: 12,
    marginVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selected: { borderColor: colors.primary, borderWidth: 2 },
  actionText: { ...type.bodyMedium, color: colors.primary },
  error: { ...type.body, color: colors.danger, marginVertical: 12 },
  notice: {
    ...type.body,
    color: colors.text,
    backgroundColor: colors.primarySoft,
    padding: 16,
    borderRadius: 12,
    marginVertical: 12,
  },
});
