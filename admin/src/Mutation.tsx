import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorCode, message, uncertain } from "./errors";

/** Retain an uncertain action's closure/request ID; retry never becomes a second creation. */
export function Mutation({
  children,
  action,
  onSaved,
  onDenied,
  label = "Save changes",
}: {
  children?: ReactNode;
  action: () => () => Promise<unknown>;
  onSaved: () => void;
  onDenied: () => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  async function submit() {
    const operation = retry || action();
    setBusy(true);
    setError("");
    try {
      await operation();
      if (alive.current) onSaved();
    } catch (e) {
      if (!alive.current) return;
      if (
        errorCode(e) === "functions/permission-denied" ||
        errorCode(e) === "functions/unauthenticated"
      ) {
        onDenied();
        return;
      }
      setRetry(uncertain(e) ? () => operation : null);
      setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy || !!retry}>{children}</fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy} type="submit">
        {busy ? "Saving…" : retry ? "Retry same action" : label}
      </button>
    </form>
  );
}
