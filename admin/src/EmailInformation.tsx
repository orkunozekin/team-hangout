import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivateEvent, EmailDelivery } from "../../shared/email";
import type { BrowserServices } from "./firebase";
import { Mutation } from "./Mutation";
import { errorCode } from "./errors";
class ReportLimitError extends Error {}
function privateReadError(error: unknown) {
  if (error instanceof ReportLimitError)
    return "The delivery report exceeds 1,000 messages. Ask support for a narrower delivery report.";
  if (
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      errorCode(error),
    )
  )
    return "Access unavailable. Sign in with the invited account or contact your organization.";
  if (errorCode(error) === "functions/resource-exhausted")
    return "This information exceeds the supported scope. Ask your organization for a narrower report.";
  return "Unable to load current information. Check your connection and try again.";
}

function usePrivateRead<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      const request = ++generation.current;
      setValue(null);
      setError("");
      if (document.visibilityState === "hidden") return;
      void load()
        .then((v) => {
          if (alive && request === generation.current) setValue(v);
        })
        .catch((error) => {
          if (alive && request === generation.current)
            setError(privateReadError(error));
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      generation.current++;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return {
    value,
    error,
    clear: () => {
      generation.current++;
      setValue(null);
    },
  };
}
export function PrivateEventInformation({
  services,
  eventId,
}: {
  services: BrowserServices;
  eventId: string;
}) {
  const load = useCallback(
    () => services.call("getPrivateEventInformation", { eventId }),
    [services, eventId],
  );
  const { value: event, error } = usePrivateRead<PrivateEvent>(load);
  return (
    <main id="main-content" tabIndex={-1} className="auth-card">
      <p className="eyebrow">Private schedule information</p>
      <h1>Event information</h1>
      <p>
        No app installation needed. Your current access is checked on every
        refresh.
      </p>
      {error && <p role="alert">{error}</p>}
      {!event && !error && <p role="status">Loading current event…</p>}
      {event && (
        <>
          <h2>{event.title}</h2>
          <p>Team: {event.teams.map((t) => t.name).join(", ")}</p>
          <p>
            {new Intl.DateTimeFormat("en-US", {
              timeZone: event.timeZone,
              dateStyle: "full",
              timeStyle: "short",
            }).format(new Date(event.startsAt))}{" "}
            to{" "}
            {new Intl.DateTimeFormat("en-US", {
              timeZone: event.timeZone,
              timeStyle: "short",
            }).format(new Date(event.endsAt))}{" "}
            ({event.timeZone})
          </p>
          <p>
            Place: {event.location?.name || "Location to be confirmed"}
            {event.location?.address && `, ${event.location.address}`}
          </p>
          <p className="small muted">
            Published revision {event.revision}. Contact your organization if
            details need clarification.
          </p>
        </>
      )}
      <a href="/help">Get help</a>
    </main>
  );
}
export function EmailPreferences({ services }: { services: BrowserServices }) {
  const [version, setVersion] = useState(0),
    [mutationEpoch, setMutationEpoch] = useState(0);
  const load = useCallback(
    () => services.call("getEssentialEmailPreference", {}),
    [services, version],
  );
  const { value, error, clear } = usePrivateRead(load);
  const settled = () => {
    clear();
    setMutationEpoch((n) => n + 1);
    setVersion((n) => n + 1);
  };
  return (
    <main id="main-content" tabIndex={-1} className="auth-card">
      <h1>Essential email preferences</h1>
      <p>
        These messages cover invitations and published schedule information.
        Promotional consent is separate; no promotional mail is offered.
      </p>
      <p>
        Suppressing email may mean missing updates. You can still use your
        private browser event links and calendar subscriptions. Ask your
        organization for help.
      </p>
      {error && <p role="alert">{error}</p>}
      {!value && !error && <p role="status">Loading preference…</p>}
      {value && (
        <p role="status">
          Essential email is {value.suppressed ? "suppressed" : "allowed"}.
        </p>
      )}
      {/* Keep the original request and retry mounted while private reads clear on focus or visibility changes. */}
      <fieldset disabled={!value}>
        <Mutation
          key={mutationEpoch}
          label={
            value
              ? value.suppressed
                ? "Allow essential email"
                : "Suppress essential email"
              : "Change essential email preference"
          }
          onSaved={settled}
          onDenied={settled}
          action={() => {
            const payload = {
              requestId: crypto.randomUUID(),
              suppressed: !value!.suppressed,
              expectedRevision: value!.revision,
            };
            return () => services.call("setEssentialEmailPreference", payload);
          }}
        />
      </fieldset>
      <a href="/help">Get help</a>
    </main>
  );
}
export function EmailDeliveryStatus({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const [version, setVersion] = useState(0);
  const load = useCallback(async () => {
    const items: EmailDelivery[] = [];
    let cursor: string | undefined;
    do {
      const page = await services.call("listEssentialEmail", {
        orgId,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor || undefined;
      if (items.length >= 1000 && cursor) throw new ReportLimitError();
    } while (cursor);
    return items;
  }, [services, orgId, version]);
  const { value: items, error } = usePrivateRead(load);
  const failures = items?.filter((i) => i.status === "failed").length ?? 0;
  return (
    <section className="panel">
      <h2>Essential email delivery</h2>
      <p>
        Transport accepted does not mean read or delivered to an inbox. Live
        delivery stays disabled until sender and privacy approval.
      </p>
      <button onClick={() => setVersion((v) => v + 1)}>
        Reload email delivery
      </button>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p role="status">Loading delivery status…</p>}
      {items && (
        <>
          <p role="status">
            {failures} failed ·{" "}
            {
              items.filter(
                (i) => i.status === "pending" || i.status === "queued",
              ).length
            }{" "}
            pending
          </p>
          {!items.length ? (
            <p>No essential mail queued.</p>
          ) : (
            <div className="table-scroll" role="region" aria-label="Records table" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Purpose</th>
                    <th scope="col">Delivery status</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.kind === "invitation"
                          ? "Invitation"
                          : "Schedule update"}
                      </td>
                      <td>
                        {i.status === "sent" ? "Transport accepted" : i.status}
                      </td>
                      <td>{i.attemptCount}</td>
                      <td>
                        {i.failureCode === "AMBIGUOUS"
                          ? "Ask support to reconcile provider acceptance before any resend."
                          : i.failureCode === "BOUNCE"
                            ? "Contact suppressed. Ask support to verify the address."
                            : i.status === "failed"
                              ? "Ask support to review sender configuration and contact."
                              : i.status === "cancelled"
                                ? "Suppressed or access changed; review current grants."
                                : i.status === "pending"
                                  ? "Automatic bounded retry scheduled."
                                  : "No action needed."}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
export function EmailHelp() {
  return (
    <main id="main-content" tabIndex={-1} className="auth-card">
      <h1>Help with team information</h1>
      <p>
        Use the email address your organization invited. Existing native
        accounts can request a password reset here to access the same account in
        the browser.
      </p>
      <p>
        For a replaced, expired or revoked invitation, contact the organization
        that invited you and request a reviewed new link. For a schedule or
        access question, contact your team administrator. A link never grants
        access by itself.
      </p>
      <p>
        Already copied email and calendar entries cannot be recalled. Email
        transport acceptance does not confirm that someone read the message.
      </p>
      <a href="/">Sign in or reset your password</a>
    </main>
  );
}
