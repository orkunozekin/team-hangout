import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Text,
  View,
  StyleSheet,
} from "react-native";
import type { ParticipantCheckIn as CheckIn } from "../../shared/checkIn";
import { getParticipantCheckIn, checkInParticipant } from "../firebase/checkIn";
import { attendanceRequestId } from "../firebase/attendance";
import { currentCheckInLocation } from "../lib/checkInLocation";
import { SecondaryButton } from "./ui";
import { colors, type } from "../theme/theme";
const uncertain = (error: unknown) =>
  [
    "functions/unavailable",
    "functions/deadline-exceeded",
    "functions/internal",
  ].includes((error as { code?: string }).code ?? "");
export default function ParticipantCheckIn({
  eventId,
  participantId,
  displayName,
}: {
  eventId: string;
  participantId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<CheckIn | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    locked = useRef(false);
  const pending = useRef<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setBusy(true);
    setData(null);
    setError("");
    pending.current = null;
    locked.current = true;
    try {
      const result = await getParticipantCheckIn(eventId, participantId);
      if (token === generation.current) setData(result);
    } catch {
      if (token === generation.current)
        setError(
          "Check-in access is unavailable or changed. Reload or ask your coach for manual attendance.",
        );
    } finally {
      if (token === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }, [eventId, participantId]);
  useEffect(() => {
    if (open) void load();
    return () => {
      generation.current++;
      pending.current = null;
    };
  }, [open, load]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      // The OS permission dialog can make iOS inactive. Cancel only when actually backgrounded.
      if (state === "background") {
        generation.current++;
        pending.current = null;
        setData(null);
        locked.current = false;
        setBusy(false);
      }
      if (state === "active" && open && !locked.current) void load();
    });
    return () => sub.remove();
  }, [open, load]);
  async function save(method: "simple" | "location") {
    if (locked.current || !data || data.closedReason) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const token = generation.current;
    try {
      if (!pending.current) {
        const sample =
          method === "location"
            ? await currentCheckInLocation(() => token === generation.current)
            : null;
        if (
          token !== generation.current ||
          AppState.currentState === "background"
        )
          return;
        pending.current = {
          requestId: attendanceRequestId(),
          payload: {
            eventId,
            participantId,
            expectedRevision: data.attendanceRevision,
            eventRevision: data.eventRevision,
            scheduleVersion: data.scheduleVersion,
            method,
            sample,
          },
        };
      }
      await checkInParticipant(
        pending.current.payload,
        pending.current.requestId,
      );
      if (token === generation.current) {
        pending.current = null;
        await load();
      }
    } catch (e) {
      if (token !== generation.current) return;
      if (uncertain(e))
        setError(
          "Result unconfirmed. Retry the same check-in or reload to reconcile. No automatic absence is recorded.",
        );
      else {
        pending.current = null;
        const code = (e as { code?: string }).code;
        if (
          code === "functions/permission-denied" ||
          code === "functions/unauthenticated" ||
          code === "functions/aborted"
        ) {
          setData(null);
          setError("Access or schedule changed. Reload before checking in.");
        } else
          setError(
            (e as Error).message ||
              "Location unavailable. Use simple check-in or ask your coach for manual attendance.",
          );
      }
    } finally {
      if (token === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <View style={styles.section}>
      <SecondaryButton
        label={
          open ? `Hide check-in for ${displayName}` : `Check in ${displayName}`
        }
        onPress={() => setOpen((v) => !v)}
        disabled={busy}
      />
      {open ? (
        <>
          <Text style={styles.heading} accessibilityRole="header">
            Participant check-in
          </Text>
          <Text style={styles.copy}>
            You are asserting attendance for {displayName}. Location assistance
            is spoofable and is not identity or presence proof. Your coach can
            correct attendance.
          </Text>
          <Text style={styles.copy}>
            Location is optional and requested only when you tap Use location.
            Coordinates are discarded after the check. No background tracking.
          </Text>
          {busy ? (
            <ActivityIndicator accessibilityLabel="Checking attendance" />
          ) : null}
          {data ? (
            <>
              <Text style={styles.copy}>
                Actual attendance: {data.status}{" "}
                {data.source ? `· ${data.source}` : ""}
              </Text>
              <Text style={styles.copy}>
                Pilot settings: {data.policy.beforeMinutes} minutes before to{" "}
                {data.policy.afterMinutes} minutes after start ·{" "}
                {data.policy.radiusMeters} m radius. Location needs accuracy of
                100 m or better and a sample no older than 60 seconds.
              </Text>
              {data.closedReason ? (
                <Text style={styles.copy}>{data.closedReason}</Text>
              ) : pending.current ? (
                <SecondaryButton
                  label={`Retry same check-in for ${displayName}`}
                  disabled={busy}
                  onPress={() => void save("simple")}
                />
              ) : (
                <>
                  <SecondaryButton
                    label={`Simple check-in for ${displayName}`}
                    disabled={busy}
                    onPress={() => void save("simple")}
                  />
                  {data.locationEnabled ? (
                    <SecondaryButton
                      label={`Use location for ${displayName}`}
                      disabled={busy}
                      onPress={() => void save("location")}
                    />
                  ) : (
                    <Text style={styles.copy}>
                      Location assistance is disabled. Simple check-in is
                      available during the window.
                    </Text>
                  )}
                </>
              )}
            </>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <Text style={styles.copy}>
            If you cannot check in, ask your coach to record attendance
            manually. Missing check-in stays unknown.
          </Text>
          <SecondaryButton
            label={`Reload check-in for ${displayName}`}
            disabled={busy}
            onPress={() => void load()}
          />
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { marginVertical: 12 },
  heading: { ...type.h2, color: colors.text, marginBottom: 8 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 8 },
  error: { ...type.body, color: colors.danger, marginVertical: 8 },
});
