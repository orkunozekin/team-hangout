import React, { useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import type { CheckInPolicy } from "../../shared/checkIn";
import { setEventCheckInPolicy } from "../firebase/checkIn";
import { SecondaryButton, TextField } from "./ui";
import { colors, type } from "../theme/theme";
export default function CheckInPolicyEditor({
  eventId,
  eventRevision,
  policy,
  onSaved,
}: {
  eventId: string;
  eventRevision: number;
  policy: CheckInPolicy;
  onSaved: () => void;
}) {
  const [before, setBefore] = useState(String(policy.beforeMinutes)),
    [after, setAfter] = useState(String(policy.afterMinutes));
  const [radius, setRadius] = useState(String(policy.radiusMeters)),
    [location, setLocation] = useState(policy.locationEnabled);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    if (![before, after, radius].every((value) => /^\d+$/.test(value))) {
      setError("Enter whole minutes and meters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await setEventCheckInPolicy(eventId, eventRevision, {
        beforeMinutes: Number(before),
        afterMinutes: Number(after),
        radiusMeters: Number(radius),
        locationEnabled: location,
      });
      onSaved();
    } catch {
      setError(
        "Policy save was not confirmed. Reload responses before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ marginVertical: 12 }}>
      <Text style={styles.heading}>Pilot check-in settings</Text>
      <Text style={styles.copy}>
        Staff settings for this event. Location also requires organization
        rollout approval. Defaults: 40 minutes before, 120 after, 500 m.
      </Text>
      <Text style={styles.copy}>Minutes before start (0–120)</Text>
      <TextField
        accessibilityLabel="Check-in minutes before start"
        value={before}
        onChangeText={setBefore}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Text style={styles.copy}>Minutes after start (0–240)</Text>
      <TextField
        accessibilityLabel="Check-in minutes after start"
        value={after}
        onChangeText={setAfter}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Text style={styles.copy}>Location radius in meters (50–1000)</Text>
      <TextField
        accessibilityLabel="Check-in radius meters"
        value={radius}
        onChangeText={setRadius}
        keyboardType="number-pad"
        editable={!busy}
      />
      <SecondaryButton
        label={
          location
            ? "Disable event location assistance"
            : "Allow event location assistance"
        }
        onPress={() => setLocation((v) => !v)}
        disabled={busy}
      />
      <SecondaryButton
        label="Save check-in settings"
        onPress={() => void save()}
        disabled={busy}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  heading: { ...type.h2, color: colors.text, marginBottom: 8 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 8 },
  error: { ...type.body, color: colors.danger },
});
