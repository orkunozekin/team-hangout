import { useEffect, useRef, useState } from "react";
import type { AgendaTeam, ParticipantRef } from "../../shared/agenda";
import {
  calendarCoverage,
  calendarInstructions,
  calendarPrivacy,
  calendarRemoval,
  type CalendarIssue,
  type CalendarSubscription,
} from "../../shared/calendarSubscriptions";
import type { BrowserServices } from "./firebase";
import { go } from "./route";

export function CalendarSubscriptions({
  services,
}: {
  services: BrowserServices;
}) {
  const [teams, setTeams] = useState<AgendaTeam[] | null>(null);
  const [items, setItems] = useState<CalendarSubscription[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [participants, setParticipants] = useState<ParticipantRef[]>([]);
  const [types, setTypes] = useState<("practice" | "match")[]>([
    "practice",
    "match",
  ]);
  const [names, setNames] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const alive = useRef(false);
  const pending = useRef<{
    name:
      | "createCalendarSubscription"
      | "rotateCalendarSubscription"
      | "revokeCalendarSubscription";
    data: any;
  } | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const visibility = () => {
      generation.current++;
      setBusy(false);
      setUrl(null);
      setItems(null);
      setTeams(null);
      pending.current = null;
      setSelected([]);
      setParticipants([]);
      setNames(false);
      setVisible(document.visibilityState !== "hidden");
      setReload((n) => n + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      generation.current++;
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setItems(null);
    setTeams(null);
    setError("");
    // Owner removal must stay available even when schedule discovery is slow or fails.
    services
      .call("listCalendarSubscriptions", {})
      .then((list) => {
        if (active) setItems(list.items);
      })
      .catch(() => {
        if (active)
          setError((previous) =>
            [
              previous,
              "Unable to load saved subscriptions. Reload to try again.",
            ]
              .filter(Boolean)
              .join(" "),
          );
      });
    services
      .call("calendarSubscriptionOptions", {})
      .then((options) => {
        if (!active) return;
        setTeams(options.teams);
        setSelected([]);
        setParticipants([]);
        setNames(false);
      })
      .catch(() => {
        if (!active) return;
        setTeams([]);
        setError((previous) =>
          [
            previous,
            "Unable to load team choices. Saved subscriptions can still be removed.",
          ]
            .filter(Boolean)
            .join(" "),
        );
      });
    return () => {
      active = false;
    };
  }, [services, reload, visible]);
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
        data: row
          ? {
              subscriptionId: row.id,
              expectedRevision: row.revision,
              requestId: crypto.randomUUID(),
            }
          : {
              teamIds: selected,
              participantRefs: participants,
              eventTypes: types,
              includeParticipantNames: names,
              requestId: crypto.randomUUID(),
            },
      };
    const current = pending.current,
      stamp = generation.current;
    setBusy(true);
    setError("");
    setUrl(null);
    setNotice("");
    try {
      const result = await services.call(current.name, current.data);
      if (
        !alive.current ||
        stamp !== generation.current ||
        document.visibilityState === "hidden"
      )
        return;
      pending.current = null;
      if ("url" in result) {
        setUrl((result as CalendarIssue).url);
        setNotice(
          result.url
            ? "Private URL created. Save it now; it is shown only once."
            : "This action already completed. Rotate the subscription to obtain a new URL.",
        );
      } else
        setNotice(
          "URL revoked. Remove the subscribed calendar from your calendar app too.",
        );
      setReload((n) => n + 1);
    } catch (e) {
      if (
        !alive.current ||
        stamp !== generation.current ||
        document.visibilityState === "hidden"
      )
        return;
      const code = (e as { code?: string }).code;
      if (
        ![
          "functions/unavailable",
          "functions/deadline-exceeded",
          "functions/internal",
        ].includes(code || "")
      )
        pending.current = null;
      setError(
        pending.current
          ? "The result is uncertain. Retry the same action before making another change."
          : "Action unavailable or access changed. Reload and review your current selection.",
      );
    } finally {
      if (alive.current && stamp === generation.current) setBusy(false);
    }
  }
  const labels = [
    ...new Map(
      (teams ?? [])
        .filter((t) => selected.includes(t.id))
        .flatMap((t) => t.participants)
        .map((p) => [`${p.orgId}/${p.participantId}`, p]),
    ).values(),
  ];
  return (
    <main className="page calendar-subscriptions">
      <a
        href="/"
        onClick={(e) => {
          e.preventDefault();
          go("/");
        }}
      >
        ← Organizations
      </a>
      <p className="eyebrow">Your private schedule</p>
      <h1>Calendar subscriptions</h1>
      <p className="muted">{calendarPrivacy}</p>
      <p>{calendarCoverage}</p>
      <section className="panel">
        <h2>Create a subscription</h2>
        {!teams && !error && <p role="status">Loading calendar access…</p>}
        {teams?.length === 0 && (
          <p>
            No eligible teams. Ask your administrator about calendar setup or
            approved schedule access.
          </p>
        )}
        <fieldset disabled={busy || !!pending.current}>
          <legend>Select only the teams you want to share</legend>
          {teams?.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={(e) => {
                  setSelected(
                    e.target.checked
                      ? [...selected, t.id]
                      : selected.filter((id) => id !== t.id),
                  );
                  setParticipants([]);
                  setNames(false);
                }}
              />
              {t.name} · {t.organizationName}
            </label>
          ))}
          {labels.length > 0 && (
            <>
              <p>Optional: narrow to specific participants</p>
              {labels.map((p) => (
                <label key={`${p.orgId}/${p.participantId}`}>
                  <input
                    type="checkbox"
                    checked={participants.some(
                      (r) =>
                        r.orgId === p.orgId &&
                        r.participantId === p.participantId,
                    )}
                    onChange={(e) => {
                      setParticipants(
                        e.target.checked
                          ? [
                              ...participants,
                              {
                                orgId: p.orgId,
                                participantId: p.participantId,
                              },
                            ]
                          : participants.filter(
                              (r) =>
                                !(
                                  r.orgId === p.orgId &&
                                  r.participantId === p.participantId
                                ),
                            ),
                      );
                      setNames(false);
                    }}
                  />
                  {p.displayName}
                </label>
              ))}
            </>
          )}
          <p>Event types</p>
          {(["practice", "match"] as const).map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={types.includes(type)}
                onChange={(e) =>
                  setTypes(
                    e.target.checked
                      ? [...types, type]
                      : types.filter((v) => v !== type),
                  )
                }
              />
              {type === "practice" ? "Practices" : "Matches"}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={names}
              disabled={!participants.length}
              onChange={(e) => setNames(e.target.checked)}
            />
            Include selected participant names in the feed
          </label>
          <p className="small muted">
            Including names shares them with anyone who has the URL and with
            your calendar provider.
          </p>
          <button
            className="primary"
            disabled={!selected.length || !types.length || selected.length > 20}
            onClick={() => {
              if (
                window.confirm(
                  "Create a private URL for exactly this selection? Anyone with the URL can read it.",
                )
              )
                void action("createCalendarSubscription");
            }}
          >
            Create private URL
          </button>
        </fieldset>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending.current && (
        <button
          disabled={busy}
          onClick={() => void action(pending.current!.name)}
        >
          Retry same action
        </button>
      )}
      {url && (
        <section className="panel">
          <h2>Your private URL</h2>
          <label>
            Subscription URL
            <input readOnly value={url} autoComplete="off" spellCheck={false} />
          </label>
          <p>{calendarInstructions}</p>
        </section>
      )}
      <h2>Active subscriptions</h2>
      {items?.length === 0 && <p>No active subscriptions.</p>}
      {items?.map((row, i) => (
        <section className="panel" key={row.id}>
          <h3>Subscription {i + 1}</h3>
          <p>
            {row.scope.teamIds.length}{" "}
            {row.scope.teamIds.length === 1 ? "team" : "teams"} ·{" "}
            {row.scope.eventTypes.join(", ")} · Names{" "}
            {row.scope.includeParticipantNames ? "included" : "excluded"}
          </p>
          <p>
            {row.scope.teamIds
              .map(
                (id) =>
                  teams?.find((t) => t.id === id)?.name || "Unavailable team",
              )
              .join(", ")}
          </p>
          {row.scope.participantRefs.length ? (
            <p>
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
            </p>
          ) : null}
          <button
            disabled={busy || !!pending.current}
            onClick={() => {
              if (
                window.confirm(
                  "Revoke the old URL and replace it for the same selection? Update your calendar subscription with the new URL.",
                )
              )
                void action("rotateCalendarSubscription", row);
            }}
          >
            Rotate URL
          </button>{" "}
          <button
            disabled={busy || !!pending.current}
            onClick={() => {
              if (
                window.confirm(
                  "Revoke this URL? Also remove the calendar in your calendar app.",
                )
              )
                void action("revokeCalendarSubscription", row);
            }}
          >
            Remove subscription
          </button>
        </section>
      ))}
      <p>{calendarRemoval}</p>
      <p>{calendarInstructions}</p>
      <button
        disabled={busy || !!pending.current}
        onClick={() => {
          setUrl(null);
          setReload((n) => n + 1);
        }}
      >
        Reload subscriptions
      </button>
    </main>
  );
}
