import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "../firebase/config";
import { runCommand } from "../firebase/commands";
import type {
  HouseholdParticipant,
  ParticipantProfile,
} from "../../shared/participants";
import {
  Screen,
  Title,
  Subtitle,
  FieldLabel,
  TextField,
} from "../components/ui";
import { colors, type } from "../theme/theme";

function errorMessage(e: unknown) {
  const code = (e as { code?: string }).code;
  if (code === "functions/permission-denied")
    return "Permission removed or profile unavailable. Contact your organization administrator.";
  if (
    (e as { details?: { domainCode?: string } }).details?.domainCode ===
    "STALE_REVISION"
  )
    return "This profile changed. Reload and review the latest details before saving.";
  return "Unable to load or save this profile. Check your connection and try again.";
}
function Button({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
export default function HouseholdScreen({
  user,
  onTeams,
}: {
  user: User;
  onTeams: () => void;
}) {
  const [items, setItems] = useState<HouseholdParticipant[] | null>(null);
  const [selected, setSelected] = useState<HouseholdParticipant | null>(null);
  const [version, setVersion] = useState(0);
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setVersion((n) => n + 1);
      return () => {
        setFocused(false);
        setSelected(null);
        setItems(null);
      };
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setSelected(null);
      setItems(null);
      setAppActive(state === "active");
      if (state === "active") setVersion((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!focused || !appActive) return;
    let active = true;
    setItems(null);
    async function load() {
      const rows: HouseholdParticipant[] = [];
      let cursor: string | undefined;
      do {
        const result = (
          await httpsCallable<
            { cursor?: string },
            { items: HouseholdParticipant[]; nextCursor: string | null }
          >(
            functions,
            "listMyParticipants",
          )(cursor ? { cursor } : {})
        ).data;
        rows.push(...result.items);
        cursor = result.nextCursor || undefined;
      } while (cursor);
      if (active) setItems(rows);
    }
    void load().catch((e) => {
      if (active) setError(errorMessage(e));
    });
    return () => {
      active = false;
    };
  }, [user.uid, version, focused, appActive]);
  function reload() {
    setSelected(null);
    setError("");
    setVersion((n) => n + 1);
  }
  return (
    <Screen>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <Title>Household</Title>
        <Subtitle>
          Signed in as {user.email || user.displayName || "your account"}
        </Subtitle>
        <Button label="Open Teams" onPress={onTeams} />
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {selected && focused && appActive ? (
          <Profile
            key={`${selected.orgId}:${selected.id}`}
            user={user}
            selected={selected}
            onBack={reload}
            onDenied={() => {
              reload();
              setError(
                "Permission removed or profile unavailable. Your household has been refreshed.",
              );
            }}
          />
        ) : (
          <>
            <Text style={styles.heading}>Your participants</Text>
            <Text style={styles.copy}>
              Choose who you are acting for. Team roles stay separate.
            </Text>
            {!items && !error ? (
              <ActivityIndicator accessibilityLabel="Loading household" />
            ) : null}
            {items?.length === 0 ? (
              <Text style={styles.copy}>
                No household participants are available. Ask your organization
                administrator about approved access. You can still use Teams.
              </Text>
            ) : null}
            {items?.map((item) => (
              <Pressable
                key={`${item.orgId}:${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={`View ${item.displayName}, ${item.relationship === "self" ? "your profile" : "guardian access"}`}
                onPress={() => {
                  setError("");
                  setSelected(item);
                }}
                style={styles.card}
              >
                <Text style={styles.heading}>{item.displayName}</Text>
                <Text style={styles.copy}>
                  {item.relationship === "self"
                    ? "Your profile"
                    : "Guardian access"}
                </Text>
                <Text style={styles.small}>
                  {item.organizationName || "Your organization"}
                </Text>
              </Pressable>
            ))}
          </>
        )}
        <Button label="Reload household" onPress={reload} />
      </ScrollView>
    </Screen>
  );
}
function Profile({
  user,
  selected,
  onBack,
  onDenied,
}: {
  user: User;
  selected: HouseholdParticipant;
  onBack: () => void;
  onDenied: () => void;
}) {
  const [data, setData] = useState<ParticipantProfile | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const alive = useRef(true);
  const pending = useRef<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    pending.current = null;
    httpsCallable(
      functions,
      "getParticipantProfile",
    )({ orgId: selected.orgId, participantId: selected.id })
      .then((result) => {
        if (!active) return;
        const row = result.data as ParticipantProfile;
        setData(row);
        setEmail(row.profile?.contactEmail || "");
        setPhone(row.profile?.contactPhone || "");
      })
      .catch((e) => {
        if (!active) return;
        if ((e as { code?: string }).code === "functions/permission-denied")
          onDenied();
        else setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [selected.orgId, selected.id, version]);
  async function save() {
    if (!data || busy || !alive.current) return;
    if (!pending.current)
      pending.current = {
        requestId: doc(collection(db, "commandRequests")).id,
        payload: {
          orgId: selected.orgId,
          participantId: selected.id,
          expectedRevision: data.profile?.revision || 0,
          fields: {
            contactEmail: email.trim() || null,
            contactPhone: phone.trim() || null,
          },
        },
      };
    setBusy(true);
    setError("");
    try {
      await runCommand(
        "editParticipantProfile",
        pending.current.payload,
        pending.current.requestId,
      );
      if (alive.current) {
        pending.current = null;
        setNotice("Profile saved.");
        setVersion((n) => n + 1);
      }
    } catch (e) {
      if (!alive.current) return;
      const code = (e as { code?: string }).code;
      if (
        code === "functions/permission-denied" ||
        code === "functions/unauthenticated"
      ) {
        setData(null);
        onDenied();
        return;
      }
      if (
        ![
          "functions/unavailable",
          "functions/deadline-exceeded",
          "functions/internal",
        ].includes(code || "")
      )
        pending.current = null;
      setError(errorMessage(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <View style={styles.card}>
      <Button label="Back to participants" onPress={onBack} />
      {!data && !error ? (
        <ActivityIndicator accessibilityLabel="Loading profile" />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text accessibilityRole="alert" style={styles.copy}>
          {notice}
        </Text>
      ) : null}
      {data ? (
        <>
          <Text style={styles.heading}>{data.participant.displayName}</Text>
          <Text style={styles.copy}>
            Acting as {user.email || user.displayName} for{" "}
            {data.participant.displayName}
          </Text>
          <Text style={styles.copy}>
            {data.relationship === "self"
              ? "Your participant profile"
              : "Approved guardian access"}{" "}
            · {data.canEdit ? "Contact editing allowed" : "View only"}
          </Text>
          <Text style={styles.heading}>Approved guardians</Text>
          {data.guardians.length ? (
            data.guardians.map((g, i) => (
              <Text key={i} style={styles.copy}>
                {g.displayName}
                {g.isYou ? " (you)" : ""}
              </Text>
            ))
          ) : (
            <Text style={styles.copy}>No approved guardians</Text>
          )}
          <Text style={styles.copy}>
            Birth date: {data.profile?.birthDate || "Not provided"}
          </Text>
          <FieldLabel>Participant email</FieldLabel>
          <TextField
            accessibilityLabel="Participant email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            editable={data.canEdit && !busy && !pending.current}
          />
          <FieldLabel>Participant phone</FieldLabel>
          <TextField
            accessibilityLabel="Participant phone"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            editable={data.canEdit && !busy && !pending.current}
          />
          {data.canEdit ? (
            <Button
              label={
                busy
                  ? "Saving…"
                  : pending.current
                    ? "Retry same save"
                    : "Review and save contact details"
              }
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  "Save participant contact details?",
                  `${user.email || user.displayName} is acting for ${data.participant.displayName}.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Save", onPress: () => void save() },
                  ],
                )
              }
            />
          ) : null}
        </>
      ) : null}
      <Button
        label="Reload profile"
        disabled={busy}
        onPress={() => setVersion((n) => n + 1)}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  heading: { ...type.h2, color: colors.text, marginVertical: 12 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 12 },
  small: { ...type.caption, color: colors.textMuted },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: {
    padding: 16,
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    marginVertical: 8,
    minHeight: 48,
  },
  buttonText: {
    ...type.bodyMedium,
    color: colors.primary,
    textAlign: "center",
  },
  error: { ...type.body, color: colors.danger, marginVertical: 12 },
});
