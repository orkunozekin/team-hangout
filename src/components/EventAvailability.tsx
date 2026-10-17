import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  AvailabilityStatus,
  EventAvailability as Availability,
  ParticipantAvailability,
} from "../../shared/availability";
import {
  availabilityRequestId,
  getEventAvailability,
  respondToEvent,
  setEventRsvpDeadline,
} from "../firebase/availability";
import { agendaTime } from "../lib/agendaTime";
import { TextField, SecondaryButton } from "./ui";
import { colors, type } from "../theme/theme";
const label = {
  yes: "Yes",
  no: "No",
  maybe: "Maybe",
  unanswered: "Unanswered",
  needsReconfirmation: "Needs reconfirmation",
};
function message(error: unknown): string {
  const e = error as { code?: string; details?: { domainCode?: string } };
  if (
    ["STALE_REVISION", "SCHEDULE_CHANGED"].includes(e.details?.domainCode ?? "")
  )
    return "Another guardian or the schedule changed. Reload responses and review before saving.";
  if (e.details?.domainCode === "RSVP_CLOSED")
    return "Responses are closed. Reload to see the current deadline and schedule.";
  if (
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      e.code ?? "",
    )
  )
    return "Access changed. Reload to confirm your current participant access.";
  return "Unable to confirm the result. Retry the same response or reload before making another change.";
}
export default function EventAvailability({
  eventId,
  canManage = false,
}: {
  eventId: string;
  canManage?: boolean;
}) {
  const [data, setData] = useState<Availability | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setData(null);
    setError("");
    setBusy(true);
    try {
      const row = await getEventAvailability(eventId);
      if (token === generation.current) setData(row);
    } catch (e) {
      if (token === generation.current) setError(message(e));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }, [eventId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, version]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      generation.current++;
      setData(null);
      setError("");
      if (state === "active") setVersion((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  async function policy(hours: number | null) {
    if (!data || busy) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      await setEventRsvpDeadline(
        eventId,
        data.eventRevision,
        hours == null
          ? null
          : new Date(Date.parse(data.startsAt) - hours * 3600000).toISOString(),
      );
      if (token === generation.current) setVersion((n) => n + 1);
    } catch (e) {
      if (token === generation.current) {
        setData(null);
        setError(message(e));
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        Participant availability
      </Text>
      <Text style={styles.copy}>
        Responses describe plans to attend. Each participant has a separate
        response.
      </Text>
      {busy ? (
        <ActivityIndicator accessibilityLabel="Loading responses" />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {data ? (
        <>
          <Text style={styles.copy}>
            {agendaTime(data.startsAt, data.endsAt, data.timeZone)}
          </Text>
          <Text style={styles.copy}>
            RSVP deadline:{" "}
            {new Date(data.deadline).toLocaleString("en-US", {
              timeZone: data.timeZone,
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </Text>
          <Text style={styles.small}>
            Event timezone: {data.timeZone} · Schedule version{" "}
            {data.scheduleVersion}
          </Text>
          {data.items.map((item) => (
            <Response
              key={`${item.participantId}:${item.revision}:${data.scheduleVersion}`}
              item={item}
              eventId={eventId}
              scheduleVersion={data.scheduleVersion}
              onSaved={() => setVersion((n) => n + 1)}
              onDenied={(e) => {
                generation.current++;
                setData(null);
                setBusy(false);
                setError(message(e));
              }}
            />
          ))}
          {data.summaries.map((summary) => (
            <View key={summary.teamId} style={styles.card}>
              <Text style={styles.heading}>{summary.teamName} responses</Text>
              {Object.entries(summary.counts).map(([status, count]) => (
                <Text key={status} style={styles.copy}>
                  {label[status as keyof typeof label]}: {count}
                </Text>
              ))}
            </View>
          ))}
          {canManage && data.canManage ? (
            <>
              <Text style={styles.heading}>Response deadline</Text>
              <Text style={styles.small}>
                Edits close at the deadline. Rescheduling resets the deadline to
                the new event start.
              </Text>
              <SecondaryButton
                label="Close 24 hours before start"
                disabled={busy}
                onPress={() => void policy(24)}
              />
              <SecondaryButton
                label="Close 1 hour before start"
                disabled={busy}
                onPress={() => void policy(1)}
              />
              <SecondaryButton
                label="Use event start deadline"
                disabled={busy}
                onPress={() => void policy(null)}
              />
            </>
          ) : null}
        </>
      ) : null}
      <SecondaryButton
        label="Reload responses"
        disabled={busy}
        onPress={() => setVersion((n) => n + 1)}
      />
    </View>
  );
}
function Response({
  item,
  eventId,
  scheduleVersion,
  onSaved,
  onDenied,
}: {
  item: ParticipantAvailability;
  eventId: string;
  scheduleVersion: number;
  onSaved: () => void;
  onDenied: (e: unknown) => void;
}) {
  const [status, setStatus] = useState<AvailabilityStatus | null>(
    ["yes", "no", "maybe"].includes(item.status)
      ? (item.status as AvailabilityStatus)
      : null,
  );
  const [note, setNote] = useState(item.lateNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save() {
    if (busy || !status || !item.canRespond) return;
    pending.current ??= {
      requestId: availabilityRequestId(),
      payload: {
        eventId,
        participantId: item.participantId,
        expectedRevision: item.revision,
        scheduleVersion,
        status,
        lateNote: note.trim() || null,
      },
    };
    setBusy(true);
    setError("");
    try {
      await respondToEvent(pending.current.payload, pending.current.requestId);
      if (alive.current) {
        pending.current = null;
        onSaved();
      }
    } catch (e) {
      if (!alive.current) return;
      const code = (e as { code?: string }).code;
      if (
        ["functions/permission-denied", "functions/unauthenticated"].includes(
          code ?? "",
        )
      ) {
        onDenied(e);
        return;
      }
      if (
        ![
          "functions/unavailable",
          "functions/deadline-exceeded",
          "functions/internal",
        ].includes(code ?? "")
      )
        pending.current = null;
      setError(message(e));
      if ((e as { details?: { domainCode?: string } }).details?.domainCode) {
        onDenied(e);
        return;
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        {item.displayName}
      </Text>
      <Text style={styles.small}>
        {item.teams.map((t) => t.name).join(" · ")} ·{" "}
        {item.relationship === "self"
          ? "Responding for yourself"
          : "Acting as guardian"}
      </Text>
      <Text style={styles.copy}>
        {label[item.status]}
        {item.actor ? ` · Last response: ${item.actor}` : ""}
      </Text>
      {item.status === "needsReconfirmation" ? (
        <Text style={styles.notice}>
          The schedule changed. Previous response:{" "}
          {item.previousStatus ? label[item.previousStatus] : ""}. Choose again
          for this time; the previous response is excluded from current totals.
        </Text>
      ) : null}
      {item.closedReason ? (
        <Text style={styles.copy}>{item.closedReason}</Text>
      ) : null}
      <View style={styles.choices}>
        {(["yes", "maybe", "no"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`${label[value]} for ${item.displayName}`}
            accessibilityState={{
              selected: status === value,
              disabled: busy || !item.canRespond || !!pending.current,
            }}
            disabled={busy || !item.canRespond || !!pending.current}
            onPress={() => setStatus(value)}
            style={[styles.choice, status === value && styles.selected]}
          >
            <Text style={styles.choiceText}>{label[value]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.small}>
        Optional late-arrival note (240 characters)
      </Text>
      <TextField
        accessibilityLabel={`Late-arrival note for ${item.displayName}`}
        value={note}
        onChangeText={setNote}
        maxLength={240}
        editable={item.canRespond && !busy && !pending.current}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {item.canRespond ? (
        <SecondaryButton
          label={
            busy
              ? "Saving response..."
              : pending.current
                ? `Retry same response for ${item.displayName}`
                : `${item.status === "needsReconfirmation" ? "Reconfirm" : "Save response for"} ${item.displayName}`
          }
          disabled={busy || !status}
          onPress={() => void save()}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { marginVertical: 16 },
  heading: { ...type.h2, color: colors.text, marginBottom: 8 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 8 },
  small: { ...type.caption, color: colors.textMuted, marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    marginVertical: 8,
    backgroundColor: colors.card,
  },
  choices: { flexDirection: "row", gap: 8, marginVertical: 8 },
  choice: {
    flex: 1,
    minHeight: 48,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  selected: {
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  choiceText: { ...type.bodyMedium, color: colors.primary },
  notice: { ...type.body, color: colors.text, marginVertical: 8 },
  error: { ...type.body, color: colors.danger, marginVertical: 8 },
});
