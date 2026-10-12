import { useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import type { Invitation, InvitationView } from "../../shared/invitations";
import { invitationMessage } from "../../shared/invitations";
import type { Participant } from "../../shared/participants";
import type { BrowserServices } from "./firebase";
import { Mutation } from "./Mutation";
import { message } from "./errors";
import { go, routeUrl } from "./route";

export function Invitations({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const [rows, setRows] = useState<Invitation[] | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [participantId, setParticipantId] = useState("");
  const [email, setEmail] = useState("");
  const [relationship, setRelationship] = useState<"guardian" | "self">(
    "guardian",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const denied = () => {
    setRows(null);
    setParticipants([]);
    setEmail("");
    setError(
      "Invitation access unavailable. Reload to recheck your permissions.",
    );
  };
  useEffect(() => {
    let alive = true;
    setRows(null);
    setParticipants([]);
    setError("");
    async function load() {
      const context = await services.call("getAdminWorkspace", { orgId });
      if (!context.admin) throw { code: "functions/permission-denied" };
      const invitations: Invitation[] = [];
      const ps: Participant[] = [];
      let cursor: string | undefined;
      do {
        const page = await services.call("listInvitations", {
          orgId,
          ...(cursor ? { cursor } : {}),
        });
        invitations.push(...page.items);
        cursor = page.nextCursor || undefined;
      } while (cursor);
      do {
        const page = await services.call("listOrganizationParticipants", {
          orgId,
          ...(cursor ? { cursor } : {}),
        });
        ps.push(...page.items);
        cursor = page.nextCursor || undefined;
      } while (cursor);
      if (alive) {
        setRows(invitations);
        setParticipants(ps.filter((p) => p.status === "active"));
      }
    }
    void load().catch((e) => {
      if (alive) setError(message(e));
    });
    return () => {
      alive = false;
    };
  }, [services, orgId, version]);
  useEffect(() => {
    let alive = true;
    const focus = () => {
      void services
        .call("getAdminWorkspace", { orgId })
        .then((c) => {
          if (alive && !c.admin) denied();
        })
        .catch((e) => {
          if (
            alive &&
            [
              "functions/permission-denied",
              "functions/unauthenticated",
            ].includes(e?.code)
          )
            denied();
        });
    };
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      window.removeEventListener("focus", focus);
    };
  }, [services, orgId]);
  const saved = () => {
    setNotice(
      "Invitation updated. Queued delivery does not mean email was sent or read.",
    );
    setVersion((v) => v + 1);
  };
  return (
    <main className="invitation-page">
      <a
        href={routeUrl(orgId, "participant")}
        onClick={(e) => {
          e.preventDefault();
          go(routeUrl(orgId, "participant"));
        }}
      >
        Back to participants
      </a>
      <p className="eyebrow">Organization / Household access</p>
      <h1>Invitations</h1>
      <p className="muted">
        Invite a guardian or confirmed adult to approve their relationship.
        Invitations expire after seven days.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button onClick={() => setVersion((v) => v + 1)}>
        Reload invitations
      </button>
      {!rows ? (
        !error && <p role="status">Loading invitations…</p>
      ) : (
        <>
          <section className="panel">
            <h2>New invitation</h2>
            <Mutation
              key={version}
              onSaved={saved}
              onDenied={denied}
              label="Queue invitation"
              action={() => {
                const payload = {
                  requestId: crypto.randomUUID(),
                  orgId,
                  participantId,
                  recipientEmail: email,
                  relationship,
                  permissions: {
                    viewSchedule: true,
                    viewProfile: true,
                    editProfile: relationship === "self",
                    respond: false,
                  },
                };
                return () => services.call("createInvitation", payload);
              }}
            >
              <label>
                Participant
                <select
                  required
                  value={participantId}
                  onChange={(e) => setParticipantId(e.target.value)}
                >
                  <option value="">Choose participant</option>
                  {participants
                    .filter(
                      (p) => relationship !== "self" || p.kind === "adult",
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Relationship
                <select
                  value={relationship}
                  onChange={(e) => {
                    setRelationship(e.target.value as "guardian" | "self");
                    setParticipantId("");
                  }}
                >
                  <option value="guardian">Guardian</option>
                  <option value="self">Adult participant (self)</option>
                </select>
              </label>
              <label>
                Recipient email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <p>
                {relationship === "self" ? "Approved access: view your profile and schedule, and edit your contact details. No response rights." : "Approved access: view household profile and schedule. No editing or response rights."}
              </p>
            </Mutation>
          </section>
          <section className="panel">
            <h2>Invitation status</h2>
            {rows.length === 0 ? (
              <p>No invitations yet.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Recipient</th>
                      <th>Relationship</th>
                      <th>Status</th>
                      <th>Delivery</th>
                      <th>Expires</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.recipientEmail}</td>
                        <td>{row.relationship}</td>
                        <td>{row.status}</td>
                        <td>{row.deliveryStatus}</td>
                        <td>{new Date(row.expiresAt).toLocaleString()}</td>
                        <td>
                          {["pending", "expired"].includes(row.status) && (
                            <>
                              <Mutation
                                label="Resend with new link"
                                onSaved={saved}
                                onDenied={denied}
                                action={() => {
                                  const p = {
                                    requestId: crypto.randomUUID(),
                                    orgId,
                                    invitationId: row.id,
                                    expectedRevision: row.revision,
                                  };
                                  return () =>
                                    services.call("resendInvitation", p);
                                }}
                              />
                              <Mutation
                                label="Revoke invitation"
                                onSaved={saved}
                                onDenied={denied}
                                action={() => {
                                  const p = {
                                    requestId: crypto.randomUUID(),
                                    orgId,
                                    invitationId: row.id,
                                    expectedRevision: row.revision,
                                  };
                                  return () =>
                                    services.call("revokeInvitation", p);
                                }}
                              />
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
export function InvitationAcceptance({
  services,
  token,
  onClose,
}: {
  services: BrowserServices;
  token: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<InvitationView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setView(null);
    setError("");
    void (
      services.auth.currentUser
        ? services.ensureProfile(services.auth.currentUser)
        : Promise.reject()
    )
      .then(() => services.auth.currentUser?.getIdToken(true))
      .then(() => services.call("inspectInvitation", { token }))
      .then((result) => {
        if (alive) setView(result);
      })
      .catch(() => {
        if (alive)
          setError(
            "Unable to check this invitation. Try again or contact your organization.",
          );
      });
    return () => {
      alive = false;
    };
  }, [services, token, version]);
  const verify = async () => {
    setBusy(true);
    try {
      if (services.auth.currentUser)
        await sendEmailVerification(services.auth.currentUser);
      setError(
        "Verification email requested. Follow the email, then check again.",
      );
    } catch {
      setError("Unable to send verification email. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-card">
      <p className="eyebrow">Household invitation</p>
      <h1>Review your invitation</h1>
      <p>Signed in as {services.auth.currentUser?.email}</p>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p role="status">Checking invitation…</p>}
      {view?.status === "pending" ? (
        <>
          <h2>{view.participantName}</h2>
          <p>
            You are accepting as {view.relationship}. Review the approved access
            before confirming.
          </p>
          <p>
            {view.permissions?.viewProfile && "View profile. "}
            {view.permissions?.viewSchedule && "View schedule. "}
            {view.permissions?.editProfile && "Edit contact details. "}
          </p>
          <Mutation
            label="Confirm and accept invitation"
            onDenied={() => {
              setView(null);
              setError("Access unavailable. Contact your organization.");
            }}
            onSaved={() => {
              setView({ status: "accepted" });
            }}
            action={() => () =>
              services
                .call("acceptInvitation", { token, confirmed: true })
                .then((result) => {
                  if (result.status !== "accepted") {
                    setView(result);
                    throw new Error(invitationMessage(result.status));
                  }
                })
            }
          />
        </>
      ) : (
        view && <p role="status">{invitationMessage(view.status)}</p>
      )}
      {view?.status === "verify-email" && (
        <button disabled={busy} onClick={() => void verify()}>
          Send verification email
        </button>
      )}
      {view?.status !== "accepted" && (
        <button disabled={busy} onClick={() => setVersion((v) => v + 1)}>
          Check invitation again
        </button>
      )}
      <button onClick={onClose}>Close invitation</button>
      <p className="small muted">
        Need help? Contact the organization that invited you and request a new
        invitation. To switch accounts, sign out and reopen the original link.
      </p>
    </main>
  );
}
