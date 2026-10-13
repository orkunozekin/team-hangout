import { useEffect, useRef, useState } from "react";
import type { AdminEntity, AdminWorkspace } from "../../shared/admin";
import type { ImportJob, ImportRow } from "../../shared/imports";
import { columns, parseCsv, safeCsv, MAX_BYTES } from "../../shared/csv";
import type { BrowserServices } from "./firebase";
import { message, uncertain } from "./errors";
import { routeUrl } from "./route";

function download(name: string, contents: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export function RosterImports({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const [workspace, setWorkspace] = useState<AdminWorkspace | null>(null),
    [programs, setPrograms] = useState<AdminEntity[]>([]),
    [seasons, setSeasons] = useState<AdminEntity[]>([]);
  const [programId, setProgram] = useState(""),
    [seasonId, setSeason] = useState("");
  const [headers, setHeaders] = useState<string[]>([]),
    [mapping, setMapping] = useState<Record<string, string | null>>({}),
    [bytes, setBytes] = useState<Uint8Array | null>(null),
    [localCount, setLocalCount] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null),
    [rows, setRows] = useState<ImportRow[]>([]),
    [offset, setOffset] = useState(0),
    [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  const [resumeId, setResumeId] = useState("");
  const [invitation, setInvitation] = useState<{
      row: ImportRow;
      email: string;
      slot: number;
    } | null>(null),
    [inviteConfirmed, setInviteConfirmed] = useState(false);
  const loadedPreview = useRef("");
  const revoked = useRef(false);
  const generation = useRef(0),
    mounted = useRef(true),
    pending = useRef<{ label: string; run: () => Promise<unknown> } | null>(
      null,
    );
  const [retry, setRetry] = useState("");
  const jobId = job?.id;
  function failure(e: unknown) {
    const code = (e as { code?: string }).code;
    if (
      code === "functions/permission-denied" ||
      code === "functions/unauthenticated"
    ) {
      generation.current++;
      revoked.current = true;
      setWorkspace(null);
      setJob(null);
      setRows([]);
      setBytes(null);
      setInvitation(null);
      pending.current = null;
      setRetry("");
    }
    setError(
      e instanceof Error && !(e as { code?: string }).code
        ? e.message
        : message(e),
    );
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    async function load() {
      try {
        const w = await services.call("getAdminWorkspace", { orgId });
        const all = async (
          kind: "program" | "season",
          scopedProgram?: string,
        ) => {
          const items: AdminEntity[] = [];
          let cursor: string | undefined;
          do {
            const page = await services.call("listOrganizationHierarchy", {
              orgId,
              kind,
              ...(scopedProgram ? { programId: scopedProgram } : {}),
              ...(cursor ? { cursor } : {}),
            });
            items.push(...page.items);
            cursor = page.nextCursor || undefined;
          } while (cursor);
          return items.filter((i) => i.status !== "archived");
        };
        const [p, s] = await Promise.all([
          all("program"),
          w.admin
            ? all("season")
            : Promise.all(w.programIds.map((id) => all("season", id))).then(
                (pages) => pages.flat(),
              ),
        ]);
        if (active) {
          setWorkspace(w);
          setPrograms(p);
          setSeasons(s);
        }
      } catch (e) {
        if (active) failure(e);
      }
    }
    void load();
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [orgId, services]);
  async function read(id = jobId, page = offset) {
    if (!id) return;
    const current = ++generation.current;
    try {
      const result = await services.call("getRosterImport", {
        orgId,
        jobId: id,
        offset: page,
      });
      if (!mounted.current || current !== generation.current) return;
      if (revoked.current) return;
      const binding = `${result.job.id}:${result.job.previewRevision}:${result.job.planRevision}`;
      if (loadedPreview.current !== binding) {
        setConfirmed(false);
        setInvitation(null);
        loadedPreview.current = binding;
      }
      setJob(result.job);
      setRows(result.rows);
      setNextOffset(result.nextOffset);
      setResumeId(id);
    } catch (e) {
      if (mounted.current && current === generation.current) failure(e);
    }
  }
  useEffect(() => {
    if (!jobId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void read(jobId, offset);
    };
    const interval = setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    void read(jobId, offset);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      generation.current++;
    };
  }, [jobId, offset, services, orgId]);
  async function action(label: string, run: () => Promise<unknown>) {
    if (busy) return;
    pending.current = { label, run };
    setBusy(true);
    setRetry("");
    setError("");
    try {
      const result = await run();
      if (mounted.current && !revoked.current) {
        pending.current = null;
        setNotice(`${label} accepted.`);
        const uploaded = result as { job?: ImportJob } | undefined;
        await read(uploaded?.job?.id ?? jobId, uploaded?.job ? 0 : offset);
      }
    } catch (e) {
      if (mounted.current) {
        failure(e);
        if (pending.current && uncertain(e)) setRetry(label);
        else pending.current = null;
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function chooseFile(file?: File) {
    if (!file) return;
    setError("");
    setBytes(null);
    setHeaders([]);
    try {
      if (file.size > MAX_BYTES)
        throw new Error("CSV exceeds 5 MB. Split it into smaller files.");
      const data = new Uint8Array(await file.arrayBuffer()),
        parsed = parseCsv(data);
      setBytes(data);
      setHeaders(parsed[0]);
      setLocalCount(parsed.length - 1);
      setMapping(
        Object.fromEntries(
          columns.map((c) => [c, parsed[0].includes(c) ? c : null]),
        ),
      );
    } catch (e) {
      failure(e);
    }
  }
  function upload() {
    if (!bytes) return;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const payload = {
      requestId: crypto.randomUUID(),
      orgId,
      programId,
      seasonId,
      csvBase64: btoa(binary),
      mapping,
      templateVersion: 1 as const,
    };
    void action("Upload", async () => {
      const result = await services.call("uploadRosterImport", payload);
      if (mounted.current && !revoked.current) {
        setOffset(0);
        setJob(result.job);
        setConfirmed(false);
      }
      return result;
    });
  }
  function resolve(
    row: ImportRow,
    resolution: "create" | "update" | "skip",
    participantId?: string,
  ) {
    if (!job) return;
    const payload = {
      requestId: crypto.randomUUID(),
      orgId,
      jobId: job.id,
      number: row.number,
      previewRevision: job.previewRevision,
      planRevision: job.planRevision,
      resolution,
      ...(participantId ? { participantId } : {}),
    };
    setConfirmed(false);
    void action("Row resolution", () =>
      services.call("resolveRosterImportRow", payload),
    );
  }
  async function outcome() {
    if (!job) return;
    const collected: ImportRow[] = [];
    let page = 0;
    do {
      const result = await services.call("getRosterImport", {
        orgId,
        jobId: job.id,
        offset: page,
      });
      collected.push(...result.rows);
      if (result.nextOffset == null) break;
      page = result.nextOffset;
    } while (page < 5000);
    download(
      "roster-import-outcome-v1.csv",
      safeCsv([
        ["row", "participantName", "externalId", "result", "errors"],
        ...collected.map((r) => [
          r.number,
          r.fields.participantName,
          r.fields.externalId,
          r.outcome || r.resolution || "needs-review",
          r.errors.join("; "),
        ]),
      ]),
    );
  }
  return (
    <main className="page roster-imports">
      <a href={routeUrl(orgId, "program")}>← Organization workspace</a>
      <p className="eyebrow">Reviewed imports · Template v1</p>
      <h1>Roster CSV imports</h1>
      <p className="muted">
        Preview participant identities and team enrollments before committing.
        Guardian emails never activate access. Imports send no mail.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {retry && (
        <button
          disabled={busy}
          onClick={() => {
            const p = pending.current;
            if (p) void action(p.label, p.run);
          }}
        >
          Retry {retry.toLowerCase()} with the same request
        </button>
      )}
      {!workspace ? (
        <p role="status">
          {error
            ? "Workspace unavailable. Reload after access is restored."
            : "Loading import workspace…"}
        </p>
      ) : (
        <>
          {!workspace.admin && (
            <p>
              Program staff can enroll existing trusted identities on the
              selected roster. Ask an administrator to create or resolve
              identities.
            </p>
          )}
          <section className="panel">
            <h2>Upload and map a CSV</h2>
            <p>
              UTF-8 CSV only, up to 5 MB and 5,000 rows. Team external IDs must
              already be configured for the selected season. Birth dates and
              private profile fields are not imported.
            </p>
            <button
              onClick={() =>
                download(
                  "roster-template-v1.csv",
                  safeCsv([
                    columns,
                    [
                      "child-001",
                      "Jamie Example",
                      "youth",
                      "team-external-id",
                      "",
                      "",
                    ],
                  ]),
                )
              }
            >
              Download roster template v1
            </button>
            <fieldset disabled={busy || !!retry}>
              <label>
                Program
                <select
                  value={programId}
                  onChange={(e) => {
                    setProgram(e.target.value);
                    setSeason("");
                  }}
                >
                  <option value="">Choose program</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target season
                <select
                  value={seasonId}
                  onChange={(e) => setSeason(e.target.value)}
                >
                  <option value="">Choose season</option>
                  {seasons
                    .filter((s) => s.programId === programId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                CSV file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => void chooseFile(e.target.files?.[0])}
                />
              </label>
              {headers.length > 0 && (
                <>
                  <p role="status">
                    Local parse: {localCount} rows. The server will
                    independently validate the uploaded bytes.
                  </p>
                  <div className="import-mapping">
                    {columns.map((c) => (
                      <label key={c}>
                        {c}
                        <select
                          value={mapping[c] || ""}
                          onChange={(e) =>
                            setMapping({
                              ...mapping,
                              [c]: e.target.value || null,
                            })
                          }
                        >
                          <option value="">Not imported</option>
                          {headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </>
              )}
              <button
                className="primary"
                disabled={!bytes || !programId || !seasonId}
                onClick={upload}
              >
                Upload for server preview
              </button>
            </fieldset>
          </section>
          <section className="panel">
            <h2>Resume a saved job</h2>
            <label>
              Import job ID
              <input
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !resumeId || !!retry}
              onClick={() => {
                setOffset(0);
                void read(resumeId, 0);
              }}
            >
              Open saved import
            </button>
          </section>
          {job && (
            <section className="panel">
              <h2>Server preview and progress</h2>
              <p>
                Target:{" "}
                {programs.find((p) => p.id === job.programId)?.name ||
                  job.programId}{" "}
                ·{" "}
                {seasons.find((s) => s.id === job.seasonId)?.name ||
                  job.seasonId}
                . Acting account: {services.auth.currentUser?.email}.
              </p>
              <p className="small import-job-id">Job ID: {job.id}</p>
              <p role="status">
                {job.status} · Previewed {job.previewCheckpoint}/{job.count} ·
                Committed {job.checkpoint}/{job.count} · Created {job.created} ·
                Updated {job.updated} · Skipped {job.skipped} · Needs resolution{" "}
                {job.unresolved}
              </p>
              {job.error && (
                <p className="error" role="alert">
                  {job.error}
                </p>
              )}
              <p>
                Source and preview expire{" "}
                {new Date(job.expiresAt).toLocaleString()}. Completed rows
                remain committed when a later row fails. Refreshing a preview
                preserves those rows and reviews only pending rows.
              </p>
              {["preview", "needs-review", "paused"].includes(job.status) && (
                <button
                  disabled={busy || !!retry}
                  onClick={() => {
                    const payload = {
                      requestId: crypto.randomUUID(),
                      orgId,
                      jobId: job.id,
                    };
                    setConfirmed(false);
                    void action("Preview refresh", () =>
                      services.call("refreshRosterImport", payload),
                    );
                  }}
                >
                  Refresh pending preview
                </button>
              )}
              <button
                disabled={busy || !!retry}
                onClick={() => void action("Outcome download", outcome)}
              >
                Download outcome CSV
              </button>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Participant</th>
                      <th>Team external ID</th>
                      <th>Review</th>
                      <th>Resolution / outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.number}>
                        <td>{row.number}</td>
                        <td>
                          <strong>{row.fields.participantName}</strong>
                          <div>
                            {row.fields.externalId || "No trusted external ID"}{" "}
                            · {row.fields.kind}
                          </div>
                        </td>
                        <td>{row.fields.teamExternalId}</td>
                        <td>
                          {row.errors.map((e) => (
                            <p className="error" key={e}>
                              {e}
                            </p>
                          ))}
                          {row.warnings.map((w) => (
                            <p key={w}>{w}</p>
                          ))}
                          {!row.errors.length &&
                            !row.warnings.length &&
                            "Validated"}
                        </td>
                        <td>
                          {row.outcome ||
                            row.resolution ||
                            "Choose a resolution"}
                          {job.status === "preview" && !row.outcome && (
                            <div>
                              <button
                                disabled={busy || !!retry}
                                onClick={() => resolve(row, "skip")}
                              >
                                Skip row {row.number}
                              </button>
                              {!row.errors.length &&
                                workspace.admin &&
                                (!row.fields.externalId ||
                                  !row.candidates.length) && (
                                  <button
                                    disabled={busy || !!retry}
                                    onClick={() => resolve(row, "create")}
                                  >
                                    Create separate participant for row{" "}
                                    {row.number}
                                  </button>
                                )}
                              {!row.errors.length &&
                                row.candidates
                                  .filter((c) => c.status === "active")
                                  .map((c) => (
                                    <button
                                      disabled={busy || !!retry}
                                      key={c.id}
                                      onClick={() =>
                                        resolve(row, "update", c.id)
                                      }
                                    >
                                      Match row {row.number} to {c.displayName}{" "}
                                      ({c.id.slice(0, 8)})
                                    </button>
                                  ))}
                            </div>
                          )}
                          {job.status === "complete" &&
                            workspace.admin &&
                            ["created", "updated"].includes(
                              row.outcome || "",
                            ) &&
                            ["guardianEmail1", "guardianEmail2"].map(
                              (key, slot) =>
                                row.fields[key] && (
                                  <button
                                    disabled={busy || !!retry}
                                    key={key}
                                    onClick={() => {
                                      setInvitation({
                                        row,
                                        email: row.fields[key],
                                        slot,
                                      });
                                      setInviteConfirmed(false);
                                    }}
                                  >
                                    Review guardian invitation for row{" "}
                                    {row.number} to {row.fields[key]}
                                  </button>
                                ),
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="actions">
                <button
                  disabled={offset === 0 || busy}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous rows
                </button>
                <button
                  disabled={nextOffset == null || busy}
                  onClick={() => setOffset(nextOffset!)}
                >
                  Next rows
                </button>
              </div>
              {job.status === "preview" && (
                <>
                  <p>
                    Pending plan: create {job.previewCreates}, update{" "}
                    {job.previewUpdates}, skip {job.previewSkips}. Confirm all{" "}
                    {job.count - job.checkpoint} pending rows using their
                    current resolutions. Unresolved rows block commit.
                    Invitations: none.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      disabled={busy || !!retry}
                    />
                    I reviewed the current preview and confirm participant and
                    roster changes without sending invitations.
                  </label>
                  <button
                    className="primary"
                    disabled={
                      !confirmed || job.unresolved > 0 || busy || !!retry
                    }
                    onClick={() => {
                      const payload = {
                        requestId: crypto.randomUUID(),
                        orgId,
                        jobId: job.id,
                        previewRevision: job.previewRevision,
                        planRevision: job.planRevision,
                        confirmed: true as const,
                      };
                      void action("Import commit", () =>
                        services.call("commitRosterImport", payload),
                      );
                    }}
                  >
                    Confirm and commit roster
                  </button>
                </>
              )}
              {invitation && job.status === "complete" && workspace.admin && (
                <section className="panel">
                  <h3>Confirm guardian invitation</h3>
                  <p>
                    Acting account: {services.auth.currentUser?.email}.
                    Participant: {invitation.row.fields.participantName}.
                    Recipient: {invitation.email}. Rights: view profile and
                    schedule only. This queues an invitation; it does not
                    activate guardian access or deliver live mail.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={inviteConfirmed}
                      disabled={busy || !!retry}
                      onChange={(e) => setInviteConfirmed(e.target.checked)}
                    />
                    I confirm this recipient and participant relationship.
                  </label>
                  <button
                    disabled={!inviteConfirmed || busy || !!retry}
                    onClick={() => {
                      const selected = invitation;
                      const payload = {
                        requestId: `import-${job.id}-${selected.row.number}-${selected.slot}`,
                        orgId,
                        participantId: selected.row.participantId,
                        ...(selected.row.teamId
                          ? { teamId: selected.row.teamId }
                          : {}),
                        recipientEmail: selected.email,
                        relationship: "guardian" as const,
                        permissions: {
                          viewSchedule: true,
                          viewProfile: true,
                          editProfile: false,
                          respond: false,
                        },
                      };
                      void action("Guardian invitation queue", async () => {
                        await services.call("createInvitation", payload);
                        if (mounted.current) setInvitation(null);
                      });
                    }}
                  >
                    Queue confirmed guardian invitation
                  </button>
                  <button
                    disabled={busy || !!retry}
                    onClick={() => setInvitation(null)}
                  >
                    Cancel invitation
                  </button>
                </section>
              )}
              {job.status === "complete" && workspace.admin && (
                <p>
                  To invite guardians, open{" "}
                  <a href={routeUrl(orgId, "invitation")}>Invitations</a> and
                  explicitly confirm each intended participant, email and
                  rights. No invitations were queued by this import.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
