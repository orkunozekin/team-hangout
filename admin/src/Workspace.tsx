import { useEffect, useState } from "react";
import type {
  AdminEntity,
  AdminSection,
  AdminWorkspace,
  OrganizationLink,
  Page,
  StaffAssignment,
} from "../../shared/admin";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";
import { go, labels, routeUrl, sections } from "./route";
import { EntityEditor, OrganizationCreator, StaffEditor } from "./editors";

type Route = { orgId: string; section: AdminSection; programId: string };
async function allPages<T>(fetch: (cursor?: string) => Promise<Page<T>>) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const result = await fetch(cursor);
    items.push(...result.items);
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return items;
}
export function OrganizationPicker({
  services,
}: {
  services: BrowserServices;
}) {
  const [items, setItems] = useState<OrganizationLink[] | null>(null);
  const [error, setError] = useState("");
  const [create, setCreate] = useState(false);
  useEffect(() => {
    let active = true;
    allPages((cursor) =>
      services.call("listMyOrganizations", { ...(cursor ? { cursor } : {}) }),
    )
      .then((rows) => {
        if (active)
          setItems(
            rows.filter((row) =>
              row.roles.some((role) =>
                ["orgAdmin", "programStaff"].includes(role),
              ),
            ),
          );
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [services]);
  return (
    <main className="page">
      <p className="eyebrow">Your workspace</p>
      <div className="page-heading">
        <div>
          <h1>Organizations</h1>
          <p className="muted">Choose where you’d like to work today.</p>
        </div>
        <button onClick={() => setCreate(!create)}>Create organization</button>
      </div>
      {error ? (
        <ErrorState text={error} />
      ) : !items ? (
        <p role="status">Loading organizations…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <h2>No staff access yet</h2>
          <p>
            Ask an organization administrator to assign your account. Household
            access does not grant workspace permissions.
          </p>
        </div>
      ) : (
        <div className="org-grid">
          {items.map((org) => (
            <a
              className="org-card"
              key={org.id}
              href={routeUrl(org.id, "program")}
              onClick={(e) => {
                e.preventDefault();
                go(routeUrl(org.id, "program"));
              }}
            >
              <span className="badge">{org.status}</span>
              <h2>{org.name}</h2>
              <p>
                {org.roles.includes("orgAdmin")
                  ? "Organization administrator"
                  : "Program staff"}
              </p>
              <span>Open workspace →</span>
            </a>
          ))}
        </div>
      )}
      {create && (
        <section className="panel">
          <h2>Create an organization</h2>
          <p className="muted">
            Requires a server-provisioned owner grant. Creating an organization
            assigns you as its first administrator; it does not enable workspace
            rollout.
          </p>
          <OrganizationCreator services={services} onSaved={() => go("/")} />
        </section>
      )}
    </main>
  );
}
export function ErrorState({ text }: { text: string }) {
  return (
    <section className="empty">
      <h2>Workspace unavailable</h2>
      <p className="error" role="alert">
        {text}
      </p>
      <button onClick={() => location.reload()}>Reload workspace</button>
      <a href="/">Choose another organization</a>
    </section>
  );
}
export function Workspace({
  services,
  route,
}: {
  services: BrowserServices;
  route: Route;
}) {
  const [data, setData] = useState<{
    context: AdminWorkspace;
    programs: AdminEntity[];
    seasons: AdminEntity[];
    divisions: AdminEntity[];
    items: (AdminEntity | StaffAssignment)[];
  } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<
    AdminEntity | StaffAssignment | "new" | null
  >(null);
  const [archived, setArchived] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { orgId, section, programId } = route;
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setEditing(null);
    async function load() {
      const context = await services.call("getAdminWorkspace", { orgId });
      if ((section === "staff" || section === "organization") && !context.admin)
        throw { code: "functions/permission-denied" };
      const needsPrograms = section !== "organization";
      const programs = needsPrograms
        ? await allPages((cursor) =>
            services.call("listOrganizationHierarchy", {
              orgId,
              kind: "program",
              ...(cursor ? { cursor } : {}),
            }),
          )
        : [];
      const selected = programId
        ? programs.find((program) => program.id === programId)
        : undefined;
      if (programId && needsPrograms && !selected)
        throw { code: "functions/permission-denied" };
      const scoped = context.admin || selected;
      const list = (kind: "season" | "division" | "team") =>
        scoped
          ? allPages((cursor) =>
              services.call("listOrganizationHierarchy", {
                orgId,
                kind,
                ...(programId ? { programId } : {}),
                ...(cursor ? { cursor } : {}),
              }),
            )
          : Promise.resolve([]);
      const [seasons, divisions, teams, staff] = await Promise.all([
        ["season", "division", "team"].includes(section) ? list("season") : [],
        ["division", "team"].includes(section) ? list("division") : [],
        section === "team" ? list("team") : [],
        section === "staff"
          ? allPages((cursor) =>
              services.call("listOrganizationStaff", {
                orgId,
                ...(cursor ? { cursor } : {}),
              }),
            )
          : [],
      ]);
      const items =
        section === "program"
          ? programs
          : section === "season"
            ? seasons
            : section === "division"
              ? divisions
              : section === "team"
                ? teams
                : section === "staff"
                  ? staff
                  : [context.organization];
      if (active) setData({ context, programs, seasons, divisions, items });
    }
    void load().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
    };
  }, [services, orgId, section, programId, generation]);
  const currentContext = data?.context;
  useEffect(() => {
    if (!currentContext) return;
    let active = true;
    let checking = false;
    const scope = (context: AdminWorkspace) =>
      JSON.stringify([
        context.admin,
        [...context.programIds].sort(),
        context.organization.status,
      ]);
    async function reauthorize() {
      if (checking) return;
      checking = true;
      try {
        const next = await services.call("getAdminWorkspace", { orgId });
        if (active && scope(next) !== scope(currentContext!)) {
          setData(null);
          setEditing(null);
          setGeneration((n) => n + 1);
        }
      } catch (e) {
        if (!active) return;
        if (
          [
            "functions/permission-denied",
            "functions/unauthenticated",
            "functions/failed-precondition",
          ].includes(errorCode(e))
        ) {
          setData(null);
          setEditing(null);
          setError(message(e));
        } else
          setNotice(
            "Unable to recheck access. Your edits are retained; the server will check access when you save.",
          );
      } finally {
        checking = false;
      }
    }
    window.addEventListener("focus", reauthorize);
    return () => {
      active = false;
      window.removeEventListener("focus", reauthorize);
    };
  }, [services, orgId, currentContext]);
  const reload = () => {
    setData(null);
    setEditing(null);
    setNotice("Changes saved.");
    setGeneration((n) => n + 1);
  };
  const denied = () => {
    setData(null);
    setEditing(null);
    setError(message({ code: "functions/permission-denied" }));
  };
  if (error)
    return (
      <main className="page">
        <ErrorState text={error} />
      </main>
    );
  if (!data)
    return (
      <main className="page">
        <p role="status">Authorizing workspace and loading current records…</p>
      </main>
    );
  const { context, programs, seasons, divisions } = data;
  const needsProgram =
    !context.admin &&
    !programId &&
    ["season", "division", "team"].includes(section);
  const canCreate =
    context.organization.status === "active" &&
    !needsProgram &&
    !["organization"].includes(section) &&
    (context.admin || !["program", "staff"].includes(section));
  const visible = data.items.filter(
    (item) => archived || !["archived", "revoked"].includes(item.status),
  );
  const name = (id?: string) =>
    [...programs, ...seasons, ...divisions].find((item) => item.id === id)
      ?.name || id;
  return (
    <div className="workspace">
      <aside>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("/");
          }}
        >
          ← All organizations
        </a>
        <div className="navigation-heading">
          <h2>{context.organization.name}</h2>
          <button
            className="navigation-toggle"
            aria-label={navigationOpen ? "Close menu" : "Open menu"}
            aria-expanded={navigationOpen}
            aria-controls="organization-navigation"
            onClick={() => setNavigationOpen((open) => !open)}
          >
            <span className="menu-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
        <p className="small muted">
          {context.admin ? "Organization administrator" : "Program staff"}
        </p>
        <nav
          id="organization-navigation"
          aria-label="Organization"
          className={navigationOpen ? "navigation-open" : ""}
        >
          {sections
            .filter(
              (item) =>
                context.admin || !["staff", "organization"].includes(item),
            )
            .map((item) => (
              <a
                key={item}
                aria-current={section === item ? "page" : undefined}
                href={routeUrl(orgId, item, programId)}
                onClick={(e) => {
                  e.preventDefault();
                  setNavigationOpen(false);
                  go(routeUrl(orgId, item, programId));
                }}
              >
                {labels[item]}
              </a>
            ))}
        </nav>
        <div className="sidebar-note">
          Build the foundation.
          <br />
          Make room for every team.
        </div>
      </aside>
      <main className="workspace-main">
        <p className="eyebrow">Organization / {labels[section]}</p>
        <div className="page-heading">
          <div>
            <h1>{labels[section]}</h1>
            <p className="muted">
              {section === "staff"
                ? "Assign access to existing accounts, scoped to the work they do."
                : "Organize your teams with a clear home for every season."}
            </p>
          </div>
          {canCreate && (
            <button className="primary" onClick={() => setEditing("new")}>
              {section === "staff" ? "Assign staff" : `New ${section}`}
            </button>
          )}
        </div>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {context.organization.status === "archived" && (
          <p className="notice">
            This organization is archived. Restore it in Organization settings
            before editing its hierarchy.
          </p>
        )}
        <div className="toolbar">
          {!["organization", "staff"].includes(section) && (
            <label>
              Program
              <select
                value={programId}
                onChange={(e) => go(routeUrl(orgId, section, e.target.value))}
              >
                <option value="">
                  {context.admin
                    ? "All programs"
                    : "Choose an assigned program"}
                </option>
                {programs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.status === "archived" ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Include archived / revoked
          </label>
          <button
            onClick={() => {
              setNotice("");
              setGeneration((n) => n + 1);
            }}
          >
            Reload
          </button>
        </div>
        {needsProgram ? (
          <div className="empty">
            <h2>Choose a program</h2>
            <p>
              Select an assigned program to see its{" "}
              {labels[section].toLowerCase()}.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">＋</span>
            <h2>No {labels[section].toLowerCase()} to show</h2>
            <p>
              {canCreate
                ? "Create the first record to get started, or include archived records."
                : "There are no records in this scope. Try including archived records."}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{section === "staff" ? "Account UID" : "Name"}</th>
                  <th>Scope / details</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{"name" in item ? item.name : item.id}</strong>
                      {"roles" in item && (
                        <div className="small muted">
                          {item.roles.join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="muted">
                      {"roles" in item ? (
                        item.programIds.map(name).join(", ") || "All programs"
                      ) : item.startsOn ? (
                        <span className="date-range">
                          <time dateTime={item.startsOn}>{item.startsOn}</time>
                          <span>
                            to <time dateTime={item.endsOn}>{item.endsOn}</time>
                          </span>
                        </span>
                      ) : item.programId ? (
                        [
                          name(item.programId),
                          name(item.seasonId),
                          name(item.divisionId),
                        ]
                          .filter(Boolean)
                          .join(" / ")
                      ) : (
                        item.timeZone || item.sportCode || "Organization-wide"
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${item.status === "archived" || item.status === "revoked" ? "quiet" : ""}`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td>
                      {(context.admin || section !== "program") && (
                        <button
                          aria-label={`Edit ${"name" in item ? item.name : item.id}`}
                          onClick={() => setEditing(item)}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing && (
          <section className="panel" aria-label="Record editor">
            <div className="page-heading">
              <h2>
                {editing === "new" ? "Create" : "Edit"}{" "}
                {section === "staff" ? "staff assignment" : section}
              </h2>
              <button onClick={() => setEditing(null)}>Close editor</button>
            </div>
            {section === "staff" ? (
              <StaffEditor
                key={editing === "new" ? "new" : editing.id}
                services={services}
                orgId={orgId}
                existing={
                  editing === "new" ? undefined : (editing as StaffAssignment)
                }
                programs={programs}
                onSaved={reload}
                onDenied={denied}
              />
            ) : (
              <EntityEditor
                key={editing === "new" ? "new" : editing.id}
                services={services}
                orgId={orgId}
                kind={section}
                existing={
                  editing === "new" ? undefined : (editing as AdminEntity)
                }
                programs={programs}
                seasons={seasons}
                divisions={divisions}
                programId={programId}
                onSaved={reload}
                onDenied={denied}
              />
            )}
          </section>
        )}
        <p className="small muted footnote">
          Archiving preserves history. Parent references are fixed after
          creation. Your server permissions are checked on every read and save.
        </p>
      </main>
    </div>
  );
}
