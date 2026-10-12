import { useState } from "react";
import type {
  AdminEntity,
  AdminSection,
  StaffAssignment,
} from "../../shared/admin";
import type {
  HierarchyFields,
  OrganizationKind,
  SportCode,
} from "../../shared/contracts";
import type { BrowserServices } from "./firebase";
import { Mutation } from "./Mutation";

type Callbacks = { onSaved: () => void; onDenied: () => void };
type Choice = { id: string; name: string };
function Select({
  label,
  value,
  options,
  change,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Choice[];
  change: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <select
        required
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Choose {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
const statuses = ["active", "archived"].map((id) => ({ id, name: id }));
const orgKinds = ["municipal", "communityCenter", "club"].map((id) => ({
  id,
  name:
    id === "communityCenter"
      ? "Community center"
      : id === "municipal"
        ? "Municipal"
        : "Club",
}));
export function EntityEditor({
  services,
  orgId,
  kind,
  existing,
  programs,
  seasons,
  divisions,
  programId: selectedProgram,
  onSaved,
  onDenied,
}: {
  services: BrowserServices;
  orgId: string;
  kind: Exclude<AdminSection, "staff" | "participant" | "invitation">;
  existing?: AdminEntity;
  programs: AdminEntity[];
  seasons: AdminEntity[];
  divisions: AdminEntity[];
  programId: string;
} & Callbacks) {
  const [name, setName] = useState(existing?.name || "");
  const [status, setStatus] = useState(
    existing?.status === "archived" && kind === "season"
      ? "active"
      : existing?.status || "active",
  );
  const [programId, setProgram] = useState(
    existing?.programId || selectedProgram,
  );
  const [seasonId, setSeason] = useState(existing?.seasonId || "");
  const [divisionId, setDivision] = useState(existing?.divisionId || "");
  const [startsOn, setStarts] = useState(existing?.startsOn || "");
  const [endsOn, setEnds] = useState(existing?.endsOn || "");
  const [sport, setSport] = useState<SportCode>(
    (existing?.sportCode as SportCode) || "soccer",
  );
  const [sportLabel, setSportLabel] = useState(existing?.sportLabel || "");
  const [age, setAge] = useState(existing?.ageBandLabel || "");
  const [orgKind, setOrgKind] = useState<OrganizationKind>(
    existing?.kind || "club",
  );
  const [timeZone, setTimeZone] = useState(
    existing?.timeZone || "America/Chicago",
  );
  function action() {
    const base = {
      orgId,
      expectedRevision: existing?.revision || 0,
      requestId: crypto.randomUUID(),
    };
    const entityId = existing ? { entityId: existing.id } : {};
    const activeStatus = status as "active" | "archived";
    if (kind === "team") {
      const input = {
        ...base,
        ...(existing ? { teamId: existing.id } : {}),
        fields: { name, status: activeStatus, programId, seasonId, divisionId },
      };
      return () => services.call("saveTeam", input);
    }
    if (kind === "organization") {
      const input = {
        ...base,
        ...entityId,
        kind: "organization" as const,
        fields: { name, status: activeStatus, kind: orgKind, timeZone },
      };
      return () => services.call("saveHierarchyEntity", input);
    }
    if (kind === "program") {
      const input = {
        ...base,
        ...entityId,
        kind: "program" as const,
        fields: { name, status: activeStatus, sportCode: sport, sportLabel },
      };
      return () => services.call("saveHierarchyEntity", input);
    }
    if (kind === "season") {
      const fields: HierarchyFields["season"] = {
        name,
        status: status as "draft" | "active",
        programId,
        startsOn,
        endsOn,
      };
      return () =>
        services.call("saveHierarchyEntity", {
          ...base,
          ...entityId,
          kind: "season",
          fields,
        });
    }
    const input = {
      ...base,
      ...entityId,
      kind: "division" as const,
      fields: {
        name,
        status: activeStatus,
        programId,
        seasonId,
        ageBandLabel: age,
      },
    };
    return () => services.call("saveHierarchyEntity", input);
  }
  const archivedSeason = kind === "season" && existing?.status === "archived";
  return (
    <>
      {archivedSeason ? (
        <p>
          This season is archived. Restore it before changing its details.
          Historical divisions and teams remain available.
        </p>
      ) : (
        <Mutation action={action} onSaved={onSaved} onDenied={onDenied}>
          <div className="form-grid">
            <label>
              Name
              <input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Select
              label="Status"
              value={status}
              options={
                kind === "season"
                  ? ["draft", "active"].map((id) => ({ id, name: id }))
                  : statuses
              }
              change={setStatus}
            />
            {["season", "division", "team"].includes(kind) && (
              <Select
                label="Program"
                value={programId}
                options={programs}
                disabled={!!existing}
                change={(value) => {
                  setProgram(value);
                  setSeason("");
                  setDivision("");
                }}
              />
            )}
            {["division", "team"].includes(kind) && (
              <Select
                label="Season"
                value={seasonId}
                options={seasons.filter((item) => item.programId === programId)}
                disabled={!!existing}
                change={(value) => {
                  setSeason(value);
                  setDivision("");
                }}
              />
            )}
            {kind === "team" && (
              <Select
                label="Division"
                value={divisionId}
                options={divisions.filter(
                  (item) =>
                    item.programId === programId && item.seasonId === seasonId,
                )}
                disabled={!!existing}
                change={setDivision}
              />
            )}
            {kind === "season" && (
              <>
                <label>
                  Starts on
                  <input
                    type="date"
                    required
                    value={startsOn}
                    onChange={(e) => setStarts(e.target.value)}
                  />
                </label>
                <label>
                  Ends on
                  <input
                    type="date"
                    required
                    min={startsOn}
                    value={endsOn}
                    onChange={(e) => setEnds(e.target.value)}
                  />
                </label>
              </>
            )}
            {kind === "program" && (
              <>
                <Select
                  label="Sport"
                  value={sport}
                  options={["soccer", "basketball", "football", "other"].map(
                    (id) => ({ id, name: id }),
                  )}
                  change={(value) => setSport(value as SportCode)}
                />
                <label>
                  Sport label (optional)
                  <input
                    maxLength={100}
                    value={sportLabel}
                    onChange={(e) => setSportLabel(e.target.value)}
                  />
                </label>
              </>
            )}
            {kind === "division" && (
              <label>
                Age band (optional)
                <input
                  maxLength={100}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                />
              </label>
            )}
            {kind === "organization" && (
              <>
                <Select
                  label="Organization type"
                  value={orgKind}
                  options={orgKinds}
                  change={(value) => setOrgKind(value as OrganizationKind)}
                />
                <label>
                  IANA time zone
                  <input
                    required
                    maxLength={100}
                    value={timeZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          {existing && (
            <p className="small muted">
              Editing revision {existing.revision}. Archive preserves records
              and history.
            </p>
          )}
        </Mutation>
      )}
      {kind === "season" && existing && (
        <div className="archive-action">
          <Mutation
            label={
              archivedSeason ? "Restore season to active" : "Archive season"
            }
            onSaved={onSaved}
            onDenied={onDenied}
            action={() => {
              const input = {
                orgId,
                seasonId: existing.id,
                expectedRevision: existing.revision,
                status: archivedSeason
                  ? ("active" as const)
                  : ("archived" as const),
                requestId: crypto.randomUUID(),
              };
              return () => services.call("archiveSeason", input);
            }}
          >
            <p className="small muted">
              {archivedSeason
                ? "Restoring allows normal edits again."
                : "Archiving stops normal edits to this season and its teams. It preserves history."}
            </p>
          </Mutation>
        </div>
      )}
    </>
  );
}
export function StaffEditor({
  services,
  orgId,
  existing,
  programs,
  onSaved,
  onDenied,
}: {
  services: BrowserServices;
  orgId: string;
  existing?: StaffAssignment;
  programs: AdminEntity[];
} & Callbacks) {
  const [userId, setUserId] = useState(existing?.id || "");
  const [role, setRole] = useState<"orgAdmin" | "programStaff">(
    existing?.roles.includes("orgAdmin") ? "orgAdmin" : "programStaff",
  );
  const [programIds, setPrograms] = useState<string[]>(
    existing?.programIds || [],
  );
  const [status, setStatus] = useState<"active" | "revoked">(
    existing?.status || "active",
  );
  return (
    <Mutation
      onSaved={onSaved}
      onDenied={onDenied}
      action={() => {
        const input = {
          orgId,
          userId,
          roles: [role],
          programIds: role === "orgAdmin" ? [] : programIds,
          status,
          expectedRevision: existing?.revision || 0,
          requestId: crypto.randomUUID(),
        };
        return () => services.call("setStaffAssignment", input);
      }}
    >
      <p className="muted">
        Use the existing account’s UID, obtained through your authorized account
        setup process. Names or matching emails do not establish identity.
      </p>
      <div className="form-grid">
        <label>
          Account UID
          <input
            required
            maxLength={128}
            pattern="[A-Za-z0-9_-]+"
            disabled={!!existing}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        </label>
        <Select
          label="Role"
          value={role}
          options={[
            { id: "programStaff", name: "Program staff" },
            { id: "orgAdmin", name: "Organization administrator" },
          ]}
          change={(value) => setRole(value as typeof role)}
        />
        <Select
          label="Access status"
          value={status}
          options={["active", "revoked"].map((id) => ({ id, name: id }))}
          change={(value) => setStatus(value as typeof status)}
        />
      </div>
      {role === "programStaff" && (
        <label>
          Assigned programs (select one or more)
          <select
            multiple
            required
            value={programIds}
            onChange={(e) =>
              setPrograms(
                Array.from(e.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {programs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="small muted">
        {existing
          ? `Editing revision ${existing.revision}.`
          : "New assignment."}{" "}
        Revoking access takes effect on canonical server reads. Another
        administrator must change your own admin role.
      </p>
    </Mutation>
  );
}
export function OrganizationCreator({
  services,
  onSaved,
}: {
  services: BrowserServices;
  onSaved: () => void;
}) {
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OrganizationKind>("club");
  const [timeZone, setTimeZone] = useState("America/Chicago");
  if (denied)
    return (
      <p className="error" role="alert">
        Creating an organization requires a server-provisioned owner grant.
        Contact the application owner.
      </p>
    );
  return (
    <Mutation
      label="Create organization"
      onSaved={onSaved}
      onDenied={() => setDenied(true)}
      action={() => {
        const input = { requestId: crypto.randomUUID(), name, kind, timeZone };
        return () => services.call("createOrganization", input);
      }}
    >
      <div className="form-grid">
        <label>
          Name
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Select
          label="Organization type"
          value={kind}
          options={orgKinds}
          change={(value) => setKind(value as OrganizationKind)}
        />
        <label>
          IANA time zone
          <input
            required
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
          />
        </label>
      </div>
    </Mutation>
  );
}
