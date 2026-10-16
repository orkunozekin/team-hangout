import { Closures } from "./Closures";
import { ScheduleDrafts } from "./ScheduleDrafts";
import { Recurrence } from "./Recurrence";
import { Facilities } from "./Facilities";
import { useEffect, useRef, useState } from "react";
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import type { BrowserServices } from "./firebase";
import { message } from "./errors";
import { go, readRoute } from "./route";
import { InvitationAcceptance, Invitations } from "./Invitations";
import { invitationTokenFromUrl } from "../../shared/invitations";
import { CalendarSubscriptions } from "./CalendarSubscriptions";
import {
  PrivateEventInformation,
  EmailPreferences,
  EmailHelp,
} from "./EmailInformation";
import { RosterImports } from "./RosterImports";
import { Participants } from "./Participants";
import { Workspace, OrganizationPicker } from "./Workspace";

export function App({ services }: { services: BrowserServices }) {
  const [pendingToken, setPendingToken] = useState(() => {
    const token = invitationTokenFromUrl(location.href);
    if (token) history.replaceState(null, "", "/invitation");
    return token;
  });
  const previousUid = useRef<string | null>(null);
  const [session, setSession] = useState<{
    user: User | null;
    ready: boolean;
    generation: number;
  }>({ user: null, ready: false, generation: 0 });
  const [path, setPath] = useState(location.pathname + location.search);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(
    () =>
      onAuthStateChanged(services.auth, (user) => {
        if (previousUid.current && previousUid.current !== user?.uid)
          setPendingToken(null);
        previousUid.current = user?.uid ?? null;
        setSession((previous) => ({
          user,
          ready: true,
          generation: previous.generation + 1,
        }));
        setError("");
      }),
    [services],
  );
  useEffect(() => {
    const navigate = () => {
      const token = invitationTokenFromUrl(location.href);
      if (token) {
        setPendingToken(token);
        history.replaceState(null, "", "/invitation");
      }
      setPath(location.pathname + location.search);
      setRefresh((n) => n + 1);
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, []);
  async function logout() {
    try {
      setPendingToken(null);
      await signOut(services.auth);
      go("/");
    } catch (e) {
      setError(message(e));
    }
  }
  const route = readRoute();
  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("/");
          }}
        >
          <span className="brand-mark">th</span>Team Hangout{" "}
          <span className="workspace-label">
            {pendingToken
              ? "Household invitation"
              : /^\/events\//.test(location.pathname)
                ? "Team information"
                : "Admin workspace"}
          </span>
        </a>
        {session.user && (
          <div className="account">
            <span>{session.user.email}</span>
            <a
              href="/calendar-subscriptions"
              onClick={(e) => {
                e.preventDefault();
                go("/calendar-subscriptions");
              }}
            >
              Calendar subscriptions
            </a>
            <a
              href="/email-preferences"
              onClick={(e) => {
                e.preventDefault();
                go("/email-preferences");
              }}
            >
              Email preferences
            </a>
            <button onClick={() => void logout()}>Sign out</button>
          </div>
        )}
      </header>
      {services.emulator && (
        <div className="environment">
          LOCAL DEMO · Synthetic development data
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {location.pathname === "/help" ? (
        <EmailHelp />
      ) : !session.ready ? (
        <main id="main-content" tabIndex={-1}>
          <p role="status">Restoring your session…</p>
        </main>
      ) : !session.user ? (
        <>
          {pendingToken && (
            <p className="environment">
              Sign in to review your invitation. Acceptance requires your
              confirmation.
            </p>
          )}
          <SignIn
            services={services}
            invitation={!!pendingToken}
            information={/^\/events\//.test(location.pathname)}
          />
        </>
      ) : (
        <div
          key={`${session.user.uid}:${session.generation}:${path}:${refresh}`}
        >
          {!pendingToken &&
          /^\/events\/[A-Za-z0-9_-]+$/.test(location.pathname) ? (
            <PrivateEventInformation
              services={services}
              eventId={location.pathname.split("/")[2]}
            />
          ) : !pendingToken && location.pathname === "/email-preferences" ? (
            <EmailPreferences services={services} />
          ) : location.pathname === "/calendar-subscriptions" &&
            !pendingToken ? (
            <CalendarSubscriptions services={services} />
          ) : pendingToken ? (
            <InvitationAcceptance
              services={services}
              token={pendingToken}
              onClose={() => {
                setPendingToken(null);
                go("/");
              }}
            />
          ) : route ? (
            ["import", "schedule"].includes(route.section) ? (
              <RosterImports
                key={route.section}
                services={services}
                orgId={route.orgId}
                kind={route.section === "schedule" ? "schedule" : "roster"}
              />
            ) : route.section === "invitation" ? (
              <Invitations services={services} orgId={route.orgId} />
            ) : route.section === "closures" ? (
              <Closures key={route.orgId} services={services} orgId={route.orgId} />
            ) : route.section === "drafts" ? (
              <ScheduleDrafts services={services} orgId={route.orgId} />
            ) : route.section === "recurrence" ? (
              <Recurrence services={services} orgId={route.orgId} />
            ) : route.section === "facility" ? (
              <Facilities services={services} orgId={route.orgId} />
            ) : route.section === "participant" ? (
              <Participants
                services={services}
                orgId={route.orgId}
                programId={route.programId}
              />
            ) : (
              <Workspace services={services} route={route} />
            )
          ) : location.pathname === "/" ? (
            <OrganizationPicker services={services} />
          ) : (
            <main id="main-content" tabIndex={-1}>
              <h1>Page not found</h1>
              <a href="/">Choose an organization</a>
            </main>
          )}
        </div>
      )}
    </>
  );
}
function SignIn({
  services,
  invitation = false,
  information = false,
}: {
  services: BrowserServices;
  invitation?: boolean;
  information?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function login(reset = false, register = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (reset) {
        await sendPasswordResetEmail(services.auth, email);
        setNotice(
          "If this email has an account, a password reset link has been requested.",
        );
      } else {
        register
          ? await createUserWithEmailAndPassword(services.auth, email, password)
          : await signInWithEmailAndPassword(services.auth, email, password);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main-content" tabIndex={-1} className="auth-card">
      <p className="eyebrow">A place for every team</p>
      <h1>Welcome back.</h1>
      <p className="muted">
        {invitation
          ? "Use the email address that received the invitation."
          : information
            ? "Sign in to read your private team schedule. No app installation needed."
            : "Manage your organization, seasons and staff in one place."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void login();
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Email address
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {invitation && (
            <button
              type="button"
              disabled={!email || password.length < 6}
              onClick={() => void login(false, true)}
            >
              Create household account
            </button>
          )}
          <button className="primary" type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={() => void login(true)}
            disabled={!email}
          >
            Reset password
          </button>
        </fieldset>
      </form>
      <p className="small muted">
        Use your existing Team Hangout account. Access is assigned by your
        organization administrator.
      </p>
    </main>
  );
}
