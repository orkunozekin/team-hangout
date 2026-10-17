import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AttendanceStatus } from "../../shared/operations";
import type {
  AttendanceRow,
  EventAttendance as Attendance,
  AttendanceHistory,
} from "../../shared/attendance";
import {
  attendanceRequestId,
  getEventAttendance,
  recordEventAttendance,
  getAttendanceHistory,
} from "../firebase/attendance";
import { SecondaryButton, TextField } from "./ui";
import { colors, type } from "../theme/theme";
const labels = {
  unknown: "Unknown",
  present: "Present",
  late: "Late",
  absent: "Absent",
  excused: "Excused",
};
const intendedLabels = {
  yes: "Yes",
  no: "No",
  maybe: "Maybe",
  unanswered: "Unanswered",
  needsReconfirmation: "Needs reconfirmation",
};
function message(e: unknown) {
  const error = e as { code?: string; message?: string };
  if (
    [
      "functions/unavailable",
      "functions/deadline-exceeded",
      "functions/internal",
    ].includes(error.code ?? "")
  )
    return "Result unconfirmed. Retry the same attendance change or reload to reconcile.";
  if (error.code === "functions/permission-denied")
    return "Attendance access changed or is unavailable for this team. Reload to check access.";
  return error.message || "Attendance unavailable. Reload before trying again.";
}
const timestamp = (date: string, timeZone: string) =>
  new Date(date).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
export default function EventAttendance({
  eventId,
  teamId,
}: {
  eventId: string;
  teamId: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Attendance | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const loadedVersion = useRef<{
    eventRevision: number;
    scheduleVersion: number;
  } | null>(null);
  const load = useCallback(
    async (cursor: string | null = null) => {
      const token = ++generation.current;
      setBusy(true);
      setError("");
      if (!cursor) setData(null);
      try {
        const result = await getEventAttendance(eventId, teamId, cursor);
        if (token === generation.current) {
          const beforeVersion = loadedVersion.current;
          if (
            cursor &&
            beforeVersion &&
            (beforeVersion.eventRevision !== result.eventRevision ||
              beforeVersion.scheduleVersion !== result.scheduleVersion)
          )
            throw new Error(
              "The event changed while paging. Reload attendance before recording.",
            );
          loadedVersion.current = result;
          setData((before) =>
            cursor && before
              ? {
                  ...result,
                  items: [
                    ...new Map(
                      [...before.items, ...result.items].map((i) => [
                        i.participantId,
                        i,
                      ]),
                    ).values(),
                  ],
                }
              : result,
          );
        }
      } catch (e) {
        if (token === generation.current) {
          setData(null);
          setError(message(e));
        }
      } finally {
        if (token === generation.current) setBusy(false);
      }
    },
    [eventId, teamId],
  );
  useEffect(() => {
    if (open) void load();
    return () => {
      generation.current++;
    };
  }, [load, open]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      generation.current++;
      setData(null);
      setBusy(false);
      if (state === "active" && open) void load();
    });
    return () => sub.remove();
  }, [load, open]);
  return (
    <View style={styles.section}>
      <SecondaryButton
        label={open ? "Hide team attendance" : "Team attendance"}
        onPress={() => setOpen((v) => !v)}
      />
      {open ? (
        <>
          <Text accessibilityRole="header" style={styles.heading}>
            Actual attendance
          </Text>
          <Text style={styles.copy}>
            Record what happened, independently of RSVP. No device or response
            is required. Missing attendance stays unknown, including after
            completion.
          </Text>
          {busy ? (
            <ActivityIndicator accessibilityLabel="Loading attendance" />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {data ? (
            <>
              <Text style={styles.copy}>
                {data.snapshot
                  ? `Completed roster frozen at event revision ${data.snapshot.capturedRevision}. Eligibility is retained for reporting.`
                  : data.status === "completed"
                    ? "No completion roster snapshot is available. The reporting denominator is unknown."
                    : "Roster eligibility will be frozen when this event is completed."}
              </Text>
              {!data.items.length ? (
                <Text style={styles.copy}>
                  No roster entries for this team.
                </Text>
              ) : null}
              {data.items.map((item) => (
                <AttendanceEntry
                  key={`${item.participantId}:${item.revision}:${data.eventRevision}:${data.scheduleVersion}`}
                  item={item}
                  data={data}
                  onSaved={() => void load()}
                  onInvalid={(e) => {
                    generation.current++;
                    setData(null);
                    setBusy(false);
                    setError(message(e));
                  }}
                />
              ))}
              {data.nextCursor ? (
                <SecondaryButton
                  label="Load more attendance"
                  disabled={busy}
                  onPress={() => void load(data.nextCursor)}
                />
              ) : null}
            </>
          ) : null}
          <SecondaryButton
            label="Reload attendance"
            disabled={busy}
            onPress={() => void load()}
          />
        </>
      ) : null}
    </View>
  );
}
function AttendanceEntry({
  item,
  data,
  onSaved,
  onInvalid,
}: {
  item: AttendanceRow;
  data: Attendance;
  onSaved: () => void;
  onInvalid: (e: unknown) => void;
}) {
  const [status, setStatus] = useState(item.status);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AttendanceHistory | null>(null);
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
    if (busy) return;
    pending.current ??= {
      requestId: attendanceRequestId(),
      payload: {
        eventId: data.eventId,
        teamId: data.teamId,
        participantId: item.participantId,
        expectedRevision: item.revision,
        eventRevision: data.eventRevision,
        scheduleVersion: data.scheduleVersion,
        status,
        reason: reason.trim() || null,
      },
    };
    setBusy(true);
    setError("");
    try {
      await recordEventAttendance(
        pending.current.payload,
        pending.current.requestId,
      );
      if (alive.current) {
        pending.current = null;
        onSaved();
      }
    } catch (e) {
      if (!alive.current) return;
      if (
        [
          "functions/unavailable",
          "functions/deadline-exceeded",
          "functions/internal",
        ].includes((e as { code?: string }).code ?? "")
      )
        setError(message(e));
      else {
        pending.current = null;
        onInvalid(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function audit(cursor: string | null = null) {
    setBusy(true);
    setError("");
    try {
      const result = await getAttendanceHistory(
        data.eventId,
        data.teamId,
        item.participantId,
        cursor,
      );
      if (alive.current)
        setHistory((h) => ({
          ...result,
          items: cursor && h ? [...h.items, ...result.items] : result.items,
        }));
    } catch (e) {
      if (alive.current) onInvalid(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const correction = item.revision > 0 || data.status === "completed";
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>
        {item.displayName}
      </Text>
      <Text style={styles.copy}>
        Intended: {intendedLabels[item.intended]} · Actual:{" "}
        {labels[item.status]}
      </Text>
      <Text style={styles.small}>
        {item.eligible
          ? "Eligible roster member"
          : "Retained roster history · Excluded from denominator"}{" "}
        · {item.rosterStatus}
      </Text>
      {item.previousStatus ? (
        <Text style={styles.copy}>
          Prior schedule attendance: {labels[item.previousStatus]}. Record again
          for this schedule.
        </Text>
      ) : null}
      {item.recordedAt ? (
        <Text style={styles.small}>
          Recorded by {item.recordedBy} ·{" "}
          {timestamp(item.recordedAt, data.timeZone)} · {item.source}
          {item.method === "location"
            ? " · Location assistance (spoofable, not presence proof)"
            : item.method === "simple"
              ? " · Simple attendance assertion"
              : ""}
        </Text>
      ) : null}
      {item.correctionReason ? (
        <Text style={styles.copy}>Correction: {item.correctionReason}</Text>
      ) : null}
      {item.canRecord ? (
        <>
          <View style={styles.choices}>
            {(Object.keys(labels) as AttendanceStatus[]).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${labels[value]} for ${item.displayName}`}
                accessibilityState={{
                  selected: status === value,
                  disabled: busy || !!pending.current,
                }}
                disabled={busy || !!pending.current}
                onPress={() => setStatus(value)}
                style={[styles.choice, status === value && styles.selected]}
              >
                <Text style={styles.choiceText}>{labels[value]}</Text>
              </Pressable>
            ))}
          </View>
          <TextField
            accessibilityLabel={`Correction reason for ${item.displayName}`}
            placeholder={
              correction
                ? "Correction reason required"
                : "Optional recording note"
            }
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            editable={!busy && !pending.current}
          />
          <SecondaryButton
            label={
              pending.current
                ? `Retry same attendance for ${item.displayName}`
                : `Save attendance for ${item.displayName}`
            }
            disabled={busy || (correction && !reason.trim())}
            onPress={() => void save()}
          />
        </>
      ) : (
        <Text style={styles.copy}>
          Recording unavailable for this event or retained roster entry.
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <SecondaryButton
        label={`Correction audit for ${item.displayName}`}
        disabled={busy || !!pending.current}
        onPress={() => void audit()}
      />
      {history ? (
        <>
          {!history.items.length ? (
            <Text style={styles.copy}>
              No attendance recorded. Actual attendance is unknown.
            </Text>
          ) : null}
          {history.items.map((h) => (
            <Text key={h.revision} style={styles.small}>
              Revision {h.revision}: {labels[h.previousStatus]} →{" "}
              {labels[h.status]}
              {h.reason ? ` · ${h.reason}` : ""}
              {"\n"}
              {h.recordedBy} · {timestamp(h.recordedAt, data.timeZone)} ·
              Schedule {h.scheduleVersion} · {h.source}
              {h.method === "location"
                ? " · Location assistance (spoofable)"
                : h.method === "simple"
                  ? " · Simple assertion"
                  : ""}
            </Text>
          ))}
          {history.nextCursor ? (
            <SecondaryButton
              label={`More audit for ${item.displayName}`}
              disabled={busy}
              onPress={() => void audit(history.nextCursor)}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { marginVertical: 16 },
  heading: { ...type.h2, color: colors.text, marginBottom: 8 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 8 },
  small: { ...type.caption, color: colors.textMuted, marginBottom: 8 },
  error: { ...type.body, color: colors.danger, marginVertical: 8 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    marginVertical: 8,
    backgroundColor: colors.card,
  },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginVertical: 8,
  },
  choice: {
    minWidth: 88,
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
});
