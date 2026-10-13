import { useEffect, useState } from "react";
import type { AdminEntity, AdminWorkspace, Page } from "../../shared/admin";
import type {
  Participant,
  ParticipantProfile,
  RosterEntry,
} from "../../shared/participants";
import type { BrowserServices } from "./firebase";
import { Mutation } from "./Mutation";
import { errorCode, message } from "./errors";
import { go, routeUrl } from "./route";

async function pages<T>(fetch: (cursor?: string) => Promise<Page<T>>) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const result = await fetch(cursor);
    items.push(...result.items);
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return items;
}
export function Participants({
  services,
  orgId,
  programId,
}: {
  services: BrowserServices;
  orgId: string;
  programId: string;
}) {
  const [context, setContext] = useState<AdminWorkspace | null>(null);
  const [teams, setTeams] = useState<AdminEntity[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teamId, setTeamId] = useState("");
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [editing, setEditing] = useState<Participant | "new" | null>(null);
  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [rosterRetry, setRosterRetry] = useState(0);
  const [profileRetry, setProfileRetry] = useState(0);
  const accessDenied = (e: unknown) =>
    ["functions/permission-denied", "functions/unauthenticated"].includes(
      errorCode(e),
    );
  const reload = () => {
    setEditing(null);
    setProfile(null);
    setNotice("Changes saved.");
    setVersion((n) => n + 1);
  };
  const denied = () => {
    setContext(null);
    setRoster(null);
    setParticipants([]);
    setEditing(null);
    setProfile(null);
    setError("Permission removed or unavailable. Reload to recheck access.");
  };
  useEffect(() => {
    let active = true;
    setContext(null);
    setParticipants([]);
    setRoster(null);
    setEditing(null);
    setProfile(null);
    setError("");
    async function load() {
      const c = await services.call("getAdminWorkspace", { orgId });
      if (programId && !c.admin && !c.programIds.includes(programId))
        throw { code: "functions/permission-denied" };
      const [ts, ps] = await Promise.all([
        c.admin || programId
          ? pages((cursor) =>
              services.call("listOrganizationHierarchy", {
                orgId,
                kind: "team",
                ...(programId ? { programId } : {}),
                ...(cursor ? { cursor } : {}),
              }),
            )
          : [],
        c.admin
          ? pages((cursor) =>
              services.call("listOrganizationParticipants", {
                orgId,
                ...(cursor ? { cursor } : {}),
              }),
            )
          : [],
      ]);
      if (active) {
        setContext(c);
        setTeams(ts);
        setParticipants(ps);
        if (teamId && !ts.some((t) => t.id === teamId)) setTeamId("");
      }
    }
    void load().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
    };
  }, [services, orgId, programId, version]);
  useEffect(() => {
    let active = true;
    setRoster(null);
    setRosterError("");
    if (context && teamId)
      void pages((cursor) =>
        services.call("listRoster", {
          orgId,
          teamId,
          includeRemoved: true,
          ...(cursor ? { cursor } : {}),
        }),
      )
        .then((rows) => {
          if (active) setRoster(rows);
        })
        .catch((e) => {
          if (!active) return;
          if (accessDenied(e)) denied();
          else
            setRosterError(
              "Unable to load this roster. Your participant edits are retained. Try again.",
            );
        });
    return () => {
      active = false;
    };
  }, [services, context, teamId, orgId, rosterRetry]);
  useEffect(() => {
    let active = true;
    setProfile(null);
    setProfileError("");
    if (editing && editing !== "new")
      void services
        .call("getParticipantProfile", {
          orgId,
          participantId: editing.id,
          staffPrivate: true,
        })
        .then((p) => {
          if (active) setProfile(p);
        })
        .catch((e) => {
          if (!active) return;
          if (accessDenied(e)) denied();
          else
            setProfileError(
              "Unable to load this profile. Your participant edits are retained. Try again.",
            );
        });
    return () => {
      active = false;
    };
  }, [editing, services, orgId, profileRetry]);
  useEffect(() => {
    if (!context) return;
    let active = true;
    let checking = false;
    const scope = (c: AdminWorkspace) =>
      JSON.stringify([
        c.admin,
        [...c.programIds].sort(),
        c.organization.status,
      ]);
    async function recheck() {
      if (checking) return;
      checking = true;
      try {
        const next = await services.call("getAdminWorkspace", { orgId });
        if (active && scope(next) !== scope(context!)) {
          setContext(null);
          setEditing(null);
          setProfile(null);
          setParticipants([]);
          setRoster(null);
          setVersion((n) => n + 1);
        }
      } catch (e) {
        if (!active) return;
        if (
          [
            "functions/permission-denied",
            "functions/unauthenticated",
            "functions/failed-precondition",
          ].includes(errorCode(e))
        )
          denied();
        else
          setNotice(
            "Unable to recheck access. Your edits are retained; saving rechecks current permission.",
          );
      } finally {
        checking = false;
      }
    }
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      window.removeEventListener("focus", recheck);
    };
  }, [services, orgId, context]);
  if (error)
    return (
      <main className="page">
        <h1>Participant access unavailable</h1>
        <p role="alert" className="error">
          {error}
        </p>
        <div className="toolbar">
          <button onClick={() => setVersion((n) => n + 1)}>Reload</button>
          <a href="/">All organizations</a>
        </div>
      </main>
    );
  if (!context)
    return (
      <main className="page">
        <p role="status">Authorizing participant workspace…</p>
      </main>
    );
  const callbacks = { onSaved: reload, onDenied: denied };
  return (
    <main className="page">
      <a
        className="back-link"
        href={routeUrl(orgId, "team", programId)}
        onClick={(e) => {
          e.preventDefault();
          go(routeUrl(orgId, "team", programId));
        }}
      >
        ← Back
      </a>
      <p className="eyebrow">
        {context.organization.name} / Participants and rosters
      </p>
      <h1>Participants and rosters</h1>
      {context.admin && (
        <a
          href={routeUrl(orgId, "invitation")}
          onClick={(e) => {
            e.preventDefault();
            go(routeUrl(orgId, "invitation"));
          }}
        >
          Manage invitations
        </a>
      )}
      <p className="muted">
        Acting as {services.auth.currentUser?.email}. Participant identities
        belong to this organization.
      </p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!context.admin && !programId && (
        <p>Choose an assigned program from Teams before managing its roster.</p>
      )}
      <section className="panel">
        <h2>Team roster</h2>
        <label>
          Team
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Choose a team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.status})
              </option>
            ))}
          </select>
        </label>
        {teamId &&
          (roster ? (
            <>
              {!roster.length ? (
                <p>No enrolled participants.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Participant</th>
                        <th>Identity</th>
                        <th>Jersey</th>
                        <th>Enrollment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roster.map((row) => (
                        <tr key={row.participantId}>
                          <td>{row.displayName}</td>
                          <td>{row.participantId}</td>
                          <td>{row.jerseyNumber || "—"}</td>
                          <td>
                            <Enrollment
                              key={`${teamId}:${row.participantId}:${row.revision}`}
                              services={services}
                              orgId={orgId}
                              teamId={teamId}
                              row={row}
                              {...callbacks}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h3>Enroll an existing participant</h3>
              <Enrollment
                key={`new:${teamId}:${version}`}
                services={services}
                orgId={orgId}
                teamId={teamId}
                participants={participants.filter(
                  (p) =>
                    p.status === "active" &&
                    !roster.some((r) => r.participantId === p.id),
                )}
                {...callbacks}
              />
            </>
          ) : rosterError ? (
            <div>
              <p role="alert" className="error">
                {rosterError}
              </p>
              <button onClick={() => setRosterRetry((n) => n + 1)}>
                Retry roster read
              </button>
            </div>
          ) : (
            <p role="status">Loading roster…</p>
          ))}
      </section>
      {context.admin && (
        <section className="panel">
          <div className="page-heading">
            <h2>Organization participants</h2>
            <button onClick={() => setEditing("new")}>New participant</button>
          </div>
          {!participants.length && <p>No participants yet.</p>}
          <div className="org-grid">
            {participants.map((p) => (
              <div key={p.id} className="org-card">
                <span className="badge">{p.status}</span>
                <h3>{p.displayName}</h3>
                <p className="small">Participant {p.id}</p>
                <button onClick={() => setEditing(p)}>
                  Manage {p.displayName}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {editing && (
        <section className="panel">
          <button
            onClick={() => {
              setEditing(null);
              setProfile(null);
            }}
          >
            Close participant
          </button>
          <h2>
            {editing === "new"
              ? "New participant"
              : `Managing ${editing.displayName}`}
          </h2>
          <p>
            Acting as {services.auth.currentUser?.email} for{" "}
            {editing === "new" ? "a new participant" : editing.displayName}.
          </p>
          <IdentityEditor
            key={editing === "new" ? "new" : editing.id}
            services={services}
            orgId={orgId}
            existing={editing === "new" ? undefined : editing}
            {...callbacks}
          />
          {editing !== "new" &&
            (profile ? (
              <>
                <PrivateEditor
                  key={`${editing.id}:${profile.profile?.revision || 0}`}
                  services={services}
                  orgId={orgId}
                  data={profile}
                  {...callbacks}
                />
                <h3>Approved guardians</h3>
                {profile.guardians.length ? (
                  profile.guardians.map((g) => (
                    <div key={g.userId}>
                      <p>
                        {g.displayName} · {g.userId}
                      </p>
                      <Mutation
                        label={`Revoke ${g.displayName}`}
                        action={() => {
                          const input = {
                            orgId,
                            participantId: editing.id,
                            userId: g.userId!,
                            expectedRevision: profile.participant.revision,
                            requestId: crypto.randomUUID(),
                          };
                          return () => services.call("revokeGuardian", input);
                        }}
                        {...callbacks}
                      />
                    </div>
                  ))
                ) : (
                  <p>No approved guardians.</p>
                )}
                <GuardianEditor
                  services={services}
                  orgId={orgId}
                  data={profile}
                  {...callbacks}
                />
              </>
            ) : profileError ? (
              <div>
                <p role="alert" className="error">
                  {profileError}
                </p>
                <button onClick={() => setProfileRetry((n) => n + 1)}>
                  Retry profile read
                </button>
              </div>
            ) : (
              <p role="status">Loading private profile…</p>
            ))}
        </section>
      )}
      <button onClick={() => setVersion((n) => n + 1)}>
        Reload participants
      </button>
    </main>
  );
}
type Callbacks = { onSaved: () => void; onDenied: () => void };
function IdentityEditor({
  services,
  orgId,
  existing,
  ...callbacks
}: {
  services: BrowserServices;
  orgId: string;
  existing?: Participant;
} & Callbacks) {
  const [name, setName] = useState(existing?.displayName || "");
  const [kind, setKind] = useState<Participant["kind"]>(
    existing?.kind || "youth",
  );
  const [status, setStatus] = useState<Participant["status"]>(
    existing?.status || "active",
  );
  return (
    <Mutation
      action={() => {
        const input = {
          orgId,
          ...(existing ? { participantId: existing.id } : {}),
          expectedRevision: existing?.revision || 0,
          requestId: crypto.randomUUID(),
          fields: { displayName: name, kind, status },
        };
        return () => services.call("saveParticipant", input);
      }}
      {...callbacks}
      label="Save participant"
    >
      <label>
        Participant name
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Participant kind
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Participant["kind"])}
        >
          {["youth", "adult", "unknown"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Participant status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Participant["status"])}
        >
          <option>active</option>
          <option>archived</option>
        </select>
      </label>
    </Mutation>
  );
}
function PrivateEditor({
  services,
  orgId,
  data,
  ...callbacks
}: {
  services: BrowserServices;
  orgId: string;
  data: ParticipantProfile;
} & Callbacks) {
  const [fields, setFields] = useState({
    birthDate: data.profile?.birthDate || "",
    contactEmail: data.profile?.contactEmail || "",
    contactPhone: data.profile?.contactPhone || "",
    guardianContactDetails: data.profile?.guardianContactDetails || "",
    operationalNotes: data.profile?.operationalNotes || "",
  });
  return (
    <>
      <h3>Private administrator profile</h3>
      <Mutation
        label="Save private profile"
        action={() => {
          const input = {
            orgId,
            participantId: data.participant.id,
            expectedRevision: data.profile?.revision || 0,
            requestId: crypto.randomUUID(),
            fields: Object.fromEntries(
              Object.entries(fields).map(([k, v]) => [k, v || null]),
            ),
          };
          return () => services.call("saveParticipantPrivateProfile", input);
        }}
        {...callbacks}
      >
        {Object.entries(fields).map(([key, value]) => (
          <label key={key}>
            {
              {
                birthDate: "Birth date",
                contactEmail: "Participant email",
                contactPhone: "Participant phone",
                guardianContactDetails: "Guardian contact details",
                operationalNotes: "Staff notes",
              }[key as keyof typeof fields]
            }
            <input
              type={
                key === "birthDate"
                  ? "date"
                  : key === "contactEmail"
                    ? "email"
                    : "text"
              }
              value={value}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          </label>
        ))}
      </Mutation>
    </>
  );
}
function GuardianEditor({
  services,
  orgId,
  data,
  ...callbacks
}: {
  services: BrowserServices;
  orgId: string;
  data: ParticipantProfile;
} & Callbacks) {
  const [uid, setUid] = useState("");
  return (
    <>
      <h3>Approve an existing guardian account</h3>
      <p>
        Confirm this account’s relationship to {data.participant.displayName}{" "}
        before approval. This grants view-only access and sends no invitation.
      </p>
      <Mutation
        label="Confirm guardian approval"
        action={() => {
          const input = {
            orgId,
            participantId: data.participant.id,
            expectedRevision: data.participant.revision,
            requestId: crypto.randomUUID(),
            userId: uid.trim(),
          };
          return () => services.call("approveGuardian", input);
        }}
        {...callbacks}
      >
        <label>
          Confirmed guardian account UID
          <input
            required
            value={uid}
            onChange={(e) => setUid(e.target.value)}
          />
        </label>
      </Mutation>
    </>
  );
}
function Enrollment({
  services,
  orgId,
  teamId,
  row,
  participants = [],
  ...callbacks
}: {
  services: BrowserServices;
  orgId: string;
  teamId: string;
  row?: RosterEntry;
  participants?: Participant[];
} & Callbacks) {
  const [id, setId] = useState(row?.participantId || "");
  const [jersey, setJersey] = useState(row?.jerseyNumber || "");
  const [status, setStatus] = useState<"active" | "removed">(
    row?.status || "active",
  );
  return (
    <Mutation
      label={
        row ? `Confirm enrollment for ${row.displayName}` : "Confirm enrollment"
      }
      action={() => {
        const input = {
          orgId,
          teamId,
          participantId: id.trim(),
          jerseyNumber: jersey.trim() || null,
          status,
          expectedRevision: row?.revision || 0,
          requestId: crypto.randomUUID(),
        };
        return () => services.call("setRosterEnrollment", input);
      }}
      {...callbacks}
    >
      {!row &&
        (participants.length ? (
          <label>
            Participant
            <select required value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose participant</option>
              {participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} · {p.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Confirmed participant ID
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
        ))}
      <label>
        Jersey number
        <input value={jersey} onChange={(e) => setJersey(e.target.value)} />
      </label>
      {row && (
        <label>
          Enrollment status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "active" | "removed")}
          >
            <option value="active">active</option>
            <option value="removed">removed</option>
          </select>
        </label>
      )}
    </Mutation>
  );
}
