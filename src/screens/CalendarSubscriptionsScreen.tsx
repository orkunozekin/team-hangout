import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "../firebase/config";
import type { AgendaTeam, ParticipantRef } from "../../shared/agenda";
import {
  calendarCoverage,
  calendarInstructions,
  calendarPrivacy,
  calendarRemoval,
  type CalendarCommands,
  type CalendarSubscription,
  type CalendarIssue,
} from "../../shared/calendarSubscriptions";
import { colors, type } from "../theme/theme";
async function call<K extends keyof CalendarCommands>(
  name: K,
  payload: CalendarCommands[K]["input"],
): Promise<CalendarCommands[K]["output"]> {
  return (
    await httpsCallable<
      CalendarCommands[K]["input"],
      CalendarCommands[K]["output"]
    >(
      functions,
      name,
    )(payload)
  ).data;
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
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
function Check({
  label,
  checked,
  onPress,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.check}
    >
      <View
        style={[
          styles.checkbox,
          checked && { backgroundColor: colors.primary },
        ]}
      >
        <Text style={{ color: "white", fontSize: 16 }}>
          {checked ? "✓" : ""}
        </Text>
      </View>
      <Text style={[styles.copy, { flex: 1, marginBottom: 0 }]}>{label}</Text>
    </Pressable>
  );
}
export default function CalendarSubscriptionsScreen({
  onBack,
}: {
  onBack: () => void;
}) {
  const [teams, setTeams] = useState<AgendaTeam[] | null>(null),
    [items, setItems] = useState<CalendarSubscription[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [participants, setParticipants] = useState<ParticipantRef[]>([]);
  const [types, setTypes] = useState<("practice" | "match")[]>([
    "practice",
    "match",
  ]);
  const [names, setNames] = useState(false),
    [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const alive = useRef(false);
  const pending = useRef<{
    name:
      | "createCalendarSubscription"
      | "rotateCalendarSubscription"
      | "revokeCalendarSubscription";
    data: any;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setTeams(null);
    setItems(null);
    setError("");
    Promise.all([
      call("calendarSubscriptionOptions", {}),
      call("listCalendarSubscriptions", {}),
    ])
      .then(([options, list]) => {
        if (!active) return;
        setTeams(options.teams);
        setItems(list.items);
        setSelected([]);
        setParticipants([]);
        setNames(false);
      })
      .catch(() => {
        if (active)
          setError(
            "Unable to load subscriptions. Reload to check current access.",
          );
      });
    return () => {
      active = false;
    };
  }, [reload]);
  async function action(
    name:
      | "createCalendarSubscription"
      | "rotateCalendarSubscription"
      | "revokeCalendarSubscription",
    row?: CalendarSubscription,
  ) {
    if (busy) return;
    if (!pending.current)
      pending.current = {
        name,
        data: {
          requestId: doc(collection(db, "commandRequests")).id,
          ...(row
            ? { subscriptionId: row.id, expectedRevision: row.revision }
            : {
                teamIds: selected,
                participantRefs: participants,
                eventTypes: types,
                includeParticipantNames: names,
              }),
        },
      };
    const current = pending.current;
    setBusy(true);
    setError("");
    setNotice("");
    setUrl(null);
    try {
      const result = await call(current.name, current.data);
      if (!alive.current) return;
      pending.current = null;
      if ("url" in result) {
        setUrl((result as CalendarIssue).url);
        setNotice(
          result.url
            ? "Private URL created. Save it now; it is shown only once."
            : "This action already completed. Rotate to obtain a new URL.",
        );
      } else
        setNotice(
          "URL revoked. Remove the subscribed calendar from your calendar app too.",
        );
      setReload((n) => n + 1);
    } catch (e) {
      if (!alive.current) return;
      if (
        ![
          "functions/unavailable",
          "functions/deadline-exceeded",
          "functions/internal",
        ].includes((e as { code?: string }).code || "")
      )
        pending.current = null;
      setError(
        pending.current
          ? "The result is uncertain. Retry the same action before making another change."
          : "Action unavailable or access changed. Reload and review your selection.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || !!pending.current;
  const labels = [
    ...new Map(
      (teams ?? [])
        .filter((t) => selected.includes(t.id))
        .flatMap((t) => t.participants)
        .map((p) => [`${p.orgId}/${p.participantId}`, p]),
    ).values(),
  ];
  return (
    <View>
      <Button label="Back to household" onPress={onBack} />
      <Text style={styles.heading}>Calendar subscriptions</Text>
      <Text style={styles.copy}>{calendarPrivacy}</Text>
      <Text style={styles.copy}>{calendarCoverage}</Text>
      {!teams && !error ? (
        <ActivityIndicator accessibilityLabel="Loading calendar access" />
      ) : null}
      {teams?.length === 0 ? (
        <Text style={styles.copy}>
          No eligible teams. Ask your administrator about calendar setup or
          approved schedule access.
        </Text>
      ) : null}
      <Text style={styles.heading}>Create a subscription</Text>
      {teams?.map((t) => (
        <Check
          key={t.id}
          label={`${t.name} · ${t.organizationName}`}
          checked={selected.includes(t.id)}
          disabled={disabled}
          onPress={() => {
            setSelected(
              selected.includes(t.id)
                ? selected.filter((id) => id !== t.id)
                : [...selected, t.id],
            );
            setParticipants([]);
            setNames(false);
          }}
        />
      ))}
      {labels.length > 0 ? (
        <Text style={styles.copy}>
          Optional: narrow to specific participants
        </Text>
      ) : null}
      {labels.map((p) => (
        <Check
          key={`${p.orgId}/${p.participantId}`}
          label={p.displayName}
          checked={participants.some(
            (r) => r.orgId === p.orgId && r.participantId === p.participantId,
          )}
          disabled={disabled}
          onPress={() => {
            setParticipants(
              participants.some(
                (r) =>
                  r.orgId === p.orgId && r.participantId === p.participantId,
              )
                ? participants.filter(
                    (r) =>
                      !(
                        r.orgId === p.orgId &&
                        r.participantId === p.participantId
                      ),
                  )
                : [
                    ...participants,
                    { orgId: p.orgId, participantId: p.participantId },
                  ],
            );
            setNames(false);
          }}
        />
      ))}
      <Text style={styles.heading}>Event types</Text>
      {(["practice", "match"] as const).map((t) => (
        <Check
          key={t}
          label={t === "practice" ? "Practices" : "Matches"}
          checked={types.includes(t)}
          disabled={disabled}
          onPress={() =>
            setTypes(
              types.includes(t) ? types.filter((v) => v !== t) : [...types, t],
            )
          }
        />
      ))}
      <Check
        label="Include selected participant names"
        checked={names}
        disabled={disabled || !participants.length}
        onPress={() => setNames(!names)}
      />
      <Text style={styles.copy}>
        Including names shares them with anyone who has the URL and with your
        calendar provider.
      </Text>
      <Button
        label="Create private URL"
        disabled={
          disabled || !selected.length || !types.length || selected.length > 20
        }
        onPress={() =>
          Alert.alert(
            "Create private subscription?",
            "Anyone with the URL can read exactly this selected schedule.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Create",
                onPress: () => void action("createCalendarSubscription"),
              },
            ],
          )
        }
      />
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
      {pending.current ? (
        <Button
          label="Retry same action"
          disabled={busy}
          onPress={() => void action(pending.current!.name)}
        />
      ) : null}
      {url ? (
        <View style={styles.card}>
          <Text style={styles.heading}>Your private URL</Text>
          <Text selectable style={styles.url}>
            {url}
          </Text>
          <Button
            label="Share private subscription URL"
            onPress={() => {
              void Share.share({ message: url }).catch(() => {
                if (alive.current)
                  setError("Unable to share. Select and copy the URL instead.");
              });
            }}
          />
          <Text style={styles.copy}>{calendarInstructions}</Text>
        </View>
      ) : null}
      <Text style={styles.heading}>Active subscriptions</Text>
      {items?.length === 0 ? (
        <Text style={styles.copy}>No active subscriptions.</Text>
      ) : null}
      {items?.map((row, i) => (
        <View key={row.id} style={styles.card}>
          <Text style={styles.heading}>Subscription {i + 1}</Text>
          <Text style={styles.copy}>
            {row.scope.teamIds.length}{" "}
            {row.scope.teamIds.length === 1 ? "team" : "teams"} ·{" "}
            {row.scope.eventTypes.join(", ")} · Names{" "}
            {row.scope.includeParticipantNames ? "included" : "excluded"}
          </Text>
          <Text style={styles.copy}>
            {row.scope.teamIds
              .map(
                (id) =>
                  teams?.find((t) => t.id === id)?.name || "Unavailable team",
              )
              .join(", ")}
          </Text>
          {row.scope.participantRefs.length ? (
            <Text style={styles.copy}>
              Selected participants:{" "}
              {row.scope.participantRefs
                .map(
                  (p) =>
                    teams
                      ?.flatMap((t) => t.participants)
                      .find(
                        (label) =>
                          label.orgId === p.orgId &&
                          label.participantId === p.participantId,
                      )?.displayName || "Unavailable participant",
                )
                .join(", ")}
            </Text>
          ) : null}
          <Button
            label="Rotate URL"
            disabled={disabled}
            onPress={() =>
              Alert.alert(
                "Replace private URL?",
                "The old URL stops working. Update your calendar app with the replacement URL for the same scope.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Rotate",
                    onPress: () =>
                      void action("rotateCalendarSubscription", row),
                  },
                ],
              )
            }
          />
          <Button
            label="Remove subscription"
            disabled={disabled}
            onPress={() =>
              Alert.alert(
                "Revoke this URL?",
                "Also remove the subscribed calendar from your calendar app.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () =>
                      void action("revokeCalendarSubscription", row),
                  },
                ],
              )
            }
          />
        </View>
      ))}
      <Text style={styles.copy}>{calendarRemoval}</Text>
      <Text style={styles.copy}>{calendarInstructions}</Text>
      <Button
        label="Reload subscriptions"
        disabled={disabled}
        onPress={() => {
          setUrl(null);
          setReload((n) => n + 1);
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  heading: { ...type.h2, color: colors.text, marginVertical: 16 },
  copy: { ...type.body, color: colors.textMuted, marginBottom: 12 },
  error: { ...type.body, color: colors.danger, marginVertical: 12 },
  button: {
    backgroundColor: colors.primarySoft,
    padding: 16,
    minHeight: 48,
    borderRadius: 12,
    marginVertical: 8,
  },
  buttonText: {
    ...type.bodyMedium,
    color: colors.primary,
    textAlign: "center",
  },
  check: {
    paddingVertical: 12,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    marginVertical: 12,
  },
  url: { ...type.caption, color: colors.text, marginBottom: 12 },
});
