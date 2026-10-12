import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import type { BrowserServices } from "./firebase";
import { message } from "./errors";
import { go, readRoute } from "./route";
import { Participants } from "./Participants";
import { Workspace, OrganizationPicker } from "./Workspace";

export function App({ services }: { services: BrowserServices }) {
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
      setPath(location.pathname + location.search);
      setRefresh((n) => n + 1);
    };
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("popstate", navigate);
    };
  }, []);
  async function logout() {
    try {
      await signOut(services.auth);
      go("/");
    } catch (e) {
      setError(message(e));
    }
  }
  const route = readRoute();
  return (
    <>
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
          <span className="workspace-label">Admin workspace</span>
        </a>
        {session.user && (
          <div className="account">
            <span>{session.user.email}</span>
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
      {!session.ready ? (
        <main>
          <p role="status">Restoring your session…</p>
        </main>
      ) : !session.user ? (
        <SignIn services={services} />
      ) : (
        <div
          key={`${session.user.uid}:${session.generation}:${path}:${refresh}`}
        >
          {route ? (
            route.section === "participant" ? <Participants services={services} orgId={route.orgId} programId={route.programId} /> : <Workspace services={services} route={route} />
          ) : location.pathname === "/" ? (
            <OrganizationPicker services={services} />
          ) : (
            <main>
              <h1>Page not found</h1>
              <a href="/">Choose an organization</a>
            </main>
          )}
        </div>
      )}
    </>
  );
}
function SignIn({ services }: { services: BrowserServices }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function login(reset = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (reset) {
        await sendPasswordResetEmail(services.auth, email);
        setNotice(
          "If this email has an account, a password reset link has been requested.",
        );
      } else await signInWithEmailAndPassword(services.auth, email, password);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-card">
      <p className="eyebrow">A place for every team</p>
      <h1>Welcome back.</h1>
      <p className="muted">
        Manage your organization, seasons and staff in one place.
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
