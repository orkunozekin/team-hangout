import { useEffect, useRef, useState } from "react";
import type { DraftFields, ScheduleDraft } from "../../shared/scheduleDrafts";
import type { BrowserServices } from "./firebase";
import { errorCode, message, uncertain } from "./errors";
const conflictLabels: Record<string, string> = {
  RESOURCE_OVERLAP: "Field or court overlap",
  RESOURCE_AVAILABILITY: "Field or court unavailable",
  RESOURCE_CLOSURE: "Field or court closed",
  RESOURCE_COMPATIBILITY: "Unavailable or incompatible resource",
  RESOURCE_REVISION_BOUNDARY: "Setup or cleanup crosses an availability change",
  TEAM_OVERLAP: "Team plays overlapping games",
  COACH_OVERLAP: "Assigned coach has overlapping games",
  MINIMUM_REST: "Minimum team rest not met",
  TEAM_BLACKOUT: "Team blackout",
  SEASON_BOUNDS: "Outside the reviewed season range",
  DIVISION_DURATION: "Game duration differs from the constraint",
  UNKNOWN_REFERENCE: "Unknown fixture or slot",
  DUPLICATE_FIXTURE: "Fixture assigned more than once",
  EXISTING_OCCUPANCY: "Conflicts with an existing game or reservation",
};
const initial: DraftFields = {
  title: "",
  startsAt: "",
  endsAt: "",
  durationMinutes: 60,
  minimumRestMinutes: 60,
  repetitions: 1,
  seed: 206,
  slots: [],
  teamConstraints: [],
};
export function ScheduleDrafts({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const epoch = useRef(0),
    authorization = useRef(0),
    capability = useRef<string | null>(null);
  const [ready, setReady] = useState(false),
    [denied, setDenied] = useState(false),
    [busy, setBusy] = useState(false);
  const [fixturePage, setFixturePage] = useState(0);
  const [slotPage, setSlotPage] = useState(0),
    [preferencePage, setPreferencePage] = useState(0),
    [assignmentSlotPage, setAssignmentSlotPage] = useState(0);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID()),
    [loadId, setLoadId] = useState(""),
    [divisionId, setDivisionId] = useState("");
  const [fields, setFields] = useState(initial);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null),
    [assignments, setAssignments] = useState<ScheduleDraft["assignments"]>([]);
  const [unsaved, setUnsaved] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<(() => Promise<ScheduleDraft>) | null>(
    null,
  );
  function fail(e: unknown) {
    if (
      ["functions/permission-denied", "functions/unauthenticated"].includes(
        errorCode(e),
      )
    ) {
      epoch.current++;
      setDenied(true);
      setReady(false);
      setDraft(null);
      setFields(initial);
      setAssignments([]);
      setDivisionId("");
      setLoadId("");
      setDraftId("");
      setRetry(null);
      setNotice("");
      setBusy(false);
      setError("Access unavailable. Reload to recheck staff access.");
    } else setError(message(e));
  }
  useEffect(() => {
    let alive = true;
    const authorize = async (event?: Event) => {
      if (event) setDirty(true);
      const n = ++authorization.current;
      try {
        const context = await services.call("getAdminWorkspace", { orgId });
        if (!alive || n !== authorization.current) return;
        const signature = JSON.stringify([
          context.admin,
          [...context.programIds].sort(),
          context.organization.status,
        ]);
        if (capability.current !== null && signature !== capability.current) {
          fail({ code: "functions/permission-denied" });
          return;
        }
        capability.current = signature;
        // Recheck scheduler rollout, hierarchy and division authority as well as workspace access on focus.
        if (draftId && draft)
          await services.call("getScheduleDraft", { orgId, draftId });
        if (alive && n === authorization.current) setReady(true);
      } catch (e) {
        if (alive && n === authorization.current)
          fail(
            errorCode(e) === "functions/failed-precondition"
              ? { code: "functions/permission-denied" }
              : e,
          );
      }
    };
    void authorize();
    window.addEventListener("focus", authorize);
    return () => {
      alive = false;
      epoch.current++;
      window.removeEventListener("focus", authorize);
    };
  }, [services, orgId, draftId, !!draft]);
  const invalidate = () => {
    epoch.current++;
    setDirty(true);
    setUnsaved(true);
    setNotice("");
    setError("");
  };
  function patch(p: Partial<DraftFields>) {
    invalidate();
    setFields((f) => ({ ...f, ...p }));
  }
  function accept(result: ScheduleDraft, loaded = false) {
    setFixturePage(0);
    setSlotPage(0);
    setPreferencePage(0);
    setAssignmentSlotPage(0);
    setDraft(result);
    setDraftId(result.draftId);
    setDivisionId(result.divisionId);
    setFields(result.fields);
    setAssignments(result.assignments);
    setDirty(loaded);
    setUnsaved(false);
    setRetry(null);
    setNotice(
      loaded
        ? `Loaded revision ${result.revision}. Revalidate against current conditions.`
        : `Saved private draft revision ${result.revision}. No events published or resources reserved.`,
    );
  }
  async function run(kind: "generate" | "save" | "validate" | "load") {
    const n = ++epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    let action: (() => Promise<ScheduleDraft>) | undefined;
    try {
      if (retry) action = retry;
      else if (kind === "load")
        action = () =>
          services.call("getScheduleDraft", { orgId, draftId: loadId });
      else {
        const base = {
          orgId,
          draftId,
          expectedRevision: draft?.revision ?? 0,
          requestId: crypto.randomUUID(),
        };
        if (kind === "generate") {
          const payload = { ...base, divisionId, fields };
          action = () => services.call("generateScheduleDraft", payload);
        }
        if (kind === "save") {
          const payload = { ...base, fields, assignments };
          action = () => services.call("saveScheduleDraft", payload);
        }
        if (kind === "validate")
          action = () => services.call("validateScheduleDraft", base);
      }
      const result = await action!();
      if (n === epoch.current) accept(result, kind === "load");
    } catch (e) {
      if (n !== epoch.current) return;
      if (action && kind !== "load" && uncertain(e)) setRetry(() => action!);
      fail(e);
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  const validation =
    !dirty && draft?.validationRevision === draft?.revision
      ? draft?.validation
      : null;
  const slotStart =
    Math.min(slotPage, Math.max(0, Math.ceil(fields.slots.length / 10) - 1)) *
    10;
  const preferenceStart =
    Math.min(
      preferencePage,
      Math.max(0, Math.ceil(fields.slots.length / 20) - 1),
    ) * 20;
  const assignmentStart =
    Math.min(
      assignmentSlotPage,
      Math.max(0, Math.ceil(fields.slots.length / 20) - 1),
    ) * 20;
  const assignmentChoices = fields.slots.slice(
    assignmentStart,
    assignmentStart + 20,
  );
  function fixtureChoices(fixtureId: string) {
    const selected = fields.slots.find(
      (slot) =>
        slot.id === assignments.find((a) => a.fixtureId === fixtureId)?.slotId,
    );
    return selected && !assignmentChoices.includes(selected)
      ? [selected, ...assignmentChoices]
      : assignmentChoices;
  }
  const name = (id: string) =>
    draft?.teams.find((t) => t.id === id)?.name || id;
  return (
    <main id="main-content" tabIndex={-1} className="page schedule-drafts">
      <a href={`/organizations/${orgId}/program`}>← Organization workspace</a>
      <p className="eyebrow">Schedule preparation · Staff only</p>
      <h1>League schedule drafts</h1>
      <p>
        Generate a finite schedule, review conflicts and adjust assignments. All
        results stay private. Publishing is disabled.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {!ready && !denied && <p role="status">Checking staff access…</p>}
      {ready && !denied && (
        <>
          <fieldset disabled={busy || !!retry}>
            <section className="panel">
              <h2>Draft and constraints</h2>
              <div className="form-grid">
                <label>
                  Existing draft ID
                  <input
                    value={loadId}
                    onChange={(e) => setLoadId(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!loadId}
                  onClick={() => void run("load")}
                >
                  Load draft
                </button>
              </div>
              <p className="small muted">
                Draft {draftId} · Revision {draft?.revision ?? 0} · PRIVATE
              </p>
              <div className="form-grid">
                <label>
                  Division ID
                  <input
                    value={divisionId}
                    disabled={!!draft}
                    onChange={(e) => {
                      invalidate();
                      setDivisionId(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Draft title
                  <input
                    value={fields.title}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </label>
                <label>
                  Range start (UTC)
                  <input
                    placeholder="2035-01-01T00:00:00.000Z"
                    value={fields.startsAt}
                    onChange={(e) => patch({ startsAt: e.target.value })}
                  />
                </label>
                <label>
                  Range end (UTC, exclusive)
                  <input
                    placeholder="2035-02-01T00:00:00.000Z"
                    value={fields.endsAt}
                    onChange={(e) => patch({ endsAt: e.target.value })}
                  />
                </label>
                {(
                  [
                    "durationMinutes",
                    "minimumRestMinutes",
                    "repetitions",
                    "seed",
                  ] as const
                ).map((k, i) => (
                  <label key={k}>
                    {
                      [
                        "Game minutes",
                        "Minimum rest minutes",
                        "Round-robin repetitions",
                        "Deterministic seed",
                      ][i]
                    }
                    <input
                      type="number"
                      min={k === "minimumRestMinutes" || k === "seed" ? 0 : 1}
                      max={
                        k === "repetitions"
                          ? 2
                          : k === "durationMinutes"
                            ? 1440
                            : k === "minimumRestMinutes"
                              ? 10080
                              : 4294967295
                      }
                      value={fields[k]}
                      onChange={(e) => patch({ [k]: Number(e.target.value) })}
                    />
                  </label>
                ))}
              </div>
              <details>
                <summary>Candidate slots and team constraints</summary>
                <p>
                  Use explicit UTC instants to resolve repeated DST hours. The
                  timezone comes from the season or organization. Setup and
                  cleanup use current resource settings.
                </p>
                {fields.slots.length === 0 && (
                  <p>
                    No candidate slots yet. Add available field or court
                    intervals to assign games.
                  </p>
                )}
                <p>
                  Candidate slots {fields.slots.length ? slotStart + 1 : 0}{" "}
                  through {Math.min(slotStart + 10, fields.slots.length)} of{" "}
                  {fields.slots.length}
                </p>
                <button
                  type="button"
                  disabled={slotStart === 0}
                  onClick={() => setSlotPage(Math.floor(slotStart / 10) - 1)}
                >
                  Previous candidate slots
                </button>
                <button
                  type="button"
                  disabled={slotStart + 10 >= fields.slots.length}
                  onClick={() => setSlotPage(Math.floor(slotStart / 10) + 1)}
                >
                  Next candidate slots
                </button>
                <label>
                  Candidate slot page
                  <input
                    type="number"
                    min="1"
                    max={Math.max(1, Math.ceil(fields.slots.length / 10))}
                    value={slotStart / 10 + 1}
                    onChange={(e) =>
                      setSlotPage(
                        Math.max(
                          0,
                          Math.min(
                            Math.ceil(fields.slots.length / 10) - 1,
                            Number(e.target.value) - 1,
                          ),
                        ),
                      )
                    }
                  />
                </label>
                {fields.slots
                  .map((slot, i) => ({ slot, i }))
                  .slice(slotStart, slotStart + 10)
                  .map(({ slot, i }) => (
                    <fieldset className="draft-slot" key={slot.id}>
                      <legend>
                        Slot {i + 1} · {slot.id}
                      </legend>
                      <div className="form-grid">
                        {(
                          [
                            "facilityId",
                            "resourceId",
                            "startsAt",
                            "endsAt",
                          ] as const
                        ).map((k, n) => (
                          <label key={k}>
                            {
                              [
                                "Facility ID",
                                "Resource ID",
                                "UTC start",
                                "UTC end",
                              ][n]
                            }{" "}
                            for slot {i + 1}
                            <input
                              value={slot[k]}
                              onChange={(e) =>
                                patch({
                                  slots: fields.slots.map((v, j) =>
                                    j === i ? { ...v, [k]: e.target.value } : v,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                        <label>
                          Time band for slot {i + 1}
                          <select
                            value={slot.late ? "late" : "early"}
                            onChange={(e) =>
                              patch({
                                slots: fields.slots.map((v, j) =>
                                  j === i
                                    ? { ...v, late: e.target.value === "late" }
                                    : v,
                                ),
                              })
                            }
                          >
                            <option value="early">Early</option>
                            <option value="late">Late</option>
                          </select>
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAssignments((current) =>
                            current.filter((a) => a.slotId !== slot.id),
                          );
                          patch({
                            slots: fields.slots.filter((_, j) => j !== i),
                            teamConstraints: fields.teamConstraints.map(
                              (t) => ({
                                ...t,
                                preferredSlotIds: t.preferredSlotIds.filter(
                                  (id) => id !== slot.id,
                                ),
                              }),
                            ),
                          });
                        }}
                      >
                        Remove slot {i + 1}
                      </button>
                    </fieldset>
                  ))}
                <button
                  type="button"
                  disabled={fields.slots.length >= 1000}
                  onClick={() => {
                    let n = fields.slots.length + 1;
                    while (fields.slots.some((s) => s.id === `slot-${n}`)) n++;
                    setSlotPage(Math.floor(fields.slots.length / 10));
                    patch({
                      slots: [
                        ...fields.slots,
                        {
                          id: `slot-${n}`,
                          facilityId: "",
                          resourceId: "",
                          startsAt: "",
                          endsAt: "",
                          late: false,
                        },
                      ],
                    });
                  }}
                >
                  Add candidate slot
                </button>
                <h3>Team blackouts and preferences</h3>
                <p>
                  Preference choices{" "}
                  {fields.slots.length ? preferenceStart + 1 : 0} through{" "}
                  {Math.min(preferenceStart + 20, fields.slots.length)} of{" "}
                  {fields.slots.length}. Selections on other pages are retained.
                </p>
                <button
                  type="button"
                  disabled={preferenceStart === 0}
                  onClick={() =>
                    setPreferencePage(Math.floor(preferenceStart / 20) - 1)
                  }
                >
                  Previous preference slots
                </button>
                <button
                  type="button"
                  disabled={preferenceStart + 20 >= fields.slots.length}
                  onClick={() =>
                    setPreferencePage(Math.floor(preferenceStart / 20) + 1)
                  }
                >
                  Next preference slots
                </button>
                <label>
                  Preference slot page
                  <input
                    type="number"
                    min="1"
                    max={Math.max(1, Math.ceil(fields.slots.length / 20))}
                    value={preferenceStart / 20 + 1}
                    onChange={(e) =>
                      setPreferencePage(
                        Math.max(
                          0,
                          Math.min(
                            Math.ceil(fields.slots.length / 20) - 1,
                            Number(e.target.value) - 1,
                          ),
                        ),
                      )
                    }
                  />
                </label>
                {fields.teamConstraints.length === 0 && (
                  <p>No extra team blackouts or slot preferences.</p>
                )}
                {fields.teamConstraints.map((c, i) => (
                  <fieldset key={i}>
                    <legend>Team constraint {i + 1}</legend>
                    <label>
                      Team for constraint {i + 1}
                      {draft ? (
                        <select
                          aria-label={`Team for constraint ${i + 1}`}
                          value={c.teamId}
                          onChange={(e) =>
                            patch({
                              teamConstraints: fields.teamConstraints.map(
                                (t, j) =>
                                  j === i
                                    ? { ...t, teamId: e.target.value }
                                    : t,
                              ),
                            })
                          }
                        >
                          <option value="">Choose team</option>
                          {draft.teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={c.teamId}
                          placeholder="Team ID"
                          onChange={(e) =>
                            patch({
                              teamConstraints: fields.teamConstraints.map(
                                (t, j) =>
                                  j === i
                                    ? { ...t, teamId: e.target.value }
                                    : t,
                              ),
                            })
                          }
                        />
                      )}
                    </label>
                    {c.blackouts.map((b, n) => (
                      <div className="form-grid" key={n}>
                        {(["startsAt", "endsAt"] as const).map((k, z) => (
                          <label key={k}>
                            {z === 0
                              ? "Blackout UTC start"
                              : "Blackout UTC end"}{" "}
                            for constraint {i + 1} interval {n + 1}
                            <input
                              value={b[k]}
                              onChange={(e) =>
                                patch({
                                  teamConstraints: fields.teamConstraints.map(
                                    (t, j) =>
                                      j === i
                                        ? {
                                            ...t,
                                            blackouts: t.blackouts.map(
                                              (v, m) =>
                                                m === n
                                                  ? {
                                                      ...v,
                                                      [k]: e.target.value,
                                                    }
                                                  : v,
                                            ),
                                          }
                                        : t,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            patch({
                              teamConstraints: fields.teamConstraints.map(
                                (t, j) =>
                                  j === i
                                    ? {
                                        ...t,
                                        blackouts: t.blackouts.filter(
                                          (_, m) => m !== n,
                                        ),
                                      }
                                    : t,
                              ),
                            })
                          }
                        >
                          Remove blackout {n + 1} for constraint {i + 1}
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={c.blackouts.length >= 128}
                      onClick={() =>
                        patch({
                          teamConstraints: fields.teamConstraints.map((t, j) =>
                            j === i
                              ? {
                                  ...t,
                                  blackouts: [
                                    ...t.blackouts,
                                    { startsAt: "", endsAt: "" },
                                  ],
                                }
                              : t,
                          ),
                        })
                      }
                    >
                      Add blackout for constraint {i + 1}
                    </button>
                    <fieldset className="draft-preferences">
                      <legend>
                        Preferred slots for constraint {i + 1} (
                        {c.preferredSlotIds.length} selected across all pages)
                      </legend>
                      {fields.slots
                        .slice(preferenceStart, preferenceStart + 20)
                        .map((slot) => (
                          <label key={slot.id}>
                            <input
                              type="checkbox"
                              aria-label={`Prefer ${slot.id} for constraint ${i + 1}`}
                              checked={c.preferredSlotIds.includes(slot.id)}
                              onChange={(e) =>
                                patch({
                                  teamConstraints: fields.teamConstraints.map(
                                    (t, j) =>
                                      j === i
                                        ? {
                                            ...t,
                                            preferredSlotIds: e.target.checked
                                              ? [...t.preferredSlotIds, slot.id]
                                              : t.preferredSlotIds.filter(
                                                  (id) => id !== slot.id,
                                                ),
                                          }
                                        : t,
                                  ),
                                })
                              }
                            />
                            {slot.id} · {slot.startsAt || "No start set"}
                          </label>
                        ))}
                    </fieldset>
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          teamConstraints: fields.teamConstraints.filter(
                            (_, j) => j !== i,
                          ),
                        })
                      }
                    >
                      Remove team constraint {i + 1}
                    </button>
                  </fieldset>
                ))}
                <button
                  type="button"
                  disabled={fields.teamConstraints.length >= 32}
                  onClick={() =>
                    patch({
                      teamConstraints: [
                        ...fields.teamConstraints,
                        { teamId: "", blackouts: [], preferredSlotIds: [] },
                      ],
                    })
                  }
                >
                  Add team constraint
                </button>
              </details>
              <p className="small muted">
                Limits: 32 teams, 16 elapsed weeks, 1,000 slots, 32 resources.
                Search stops at 100,000 nodes or 10 seconds. A known feasible
                32-team example retains only 446 of 496 games. Completion and
                optimality are not guaranteed.
              </p>
              <button
                className="primary"
                type="button"
                onClick={() => void run("generate")}
              >
                Generate private draft
              </button>
              {draft && (
                <>
                  <button type="button" onClick={() => void run("save")}>
                    Save edits as unvalidated draft
                  </button>
                  <button
                    type="button"
                    disabled={unsaved}
                    onClick={() => void run("validate")}
                  >
                    Revalidate saved draft
                  </button>
                </>
              )}
            </section>
            {draft && (
              <section className="panel">
                <div className="page-heading">
                  <h2>Schedule review</h2>
                  <span className="badge">PRIVATE DRAFT</span>
                </div>
                <p className="small muted">
                  Season timezone: {draft.timeZone}. Slot times below are UTC.
                </p>
                {!validation ? (
                  <p role="status">
                    Validation required. Save edited assignments before
                    revalidating. Previous validation no longer applies.
                  </p>
                ) : (
                  <>
                    <h3>
                      {validation.unscheduledFixtureIds.length === 0 &&
                      validation.valid
                        ? "Complete schedule"
                        : "Partial or conflicting schedule"}
                    </h3>
                    <p>
                      {assignments.length} of {draft.fixtures.length} games
                      assigned · {validation.unscheduledFixtureIds.length}{" "}
                      unscheduled · {validation.conflictCount} hard conflicts ·
                      Validated revision {draft.validationRevision}
                    </p>
                    {draft.search && (
                      <p>
                        Generation: {draft.search.status} ·{" "}
                        {draft.search.termination}{" "}
                        {draft.search.budgetReason
                          ? `(${draft.search.budgetReason} limit)`
                          : ""}
                        .{" "}
                        {draft.search.status === "budgetExhausted"
                          ? "This is not proof of impossibility."
                          : draft.search.status === "impossible"
                            ? "No complete assignment exists for the finite slots checked."
                            : "Fairness is not guaranteed optimal."}
                      </p>
                    )}
                    {validation.disclosures.map((d) => (
                      <p className="small muted" key={d}>
                        {d}
                      </p>
                    ))}
                    <h3>Fairness diagnostics</h3>
                    <div
                      className="table-scroll"
                      tabIndex={0}
                      aria-label="Fairness diagnostics"
                    >
                      <table>
                        <thead>
                          <tr>
                            {[
                              "Team",
                              "Home / away",
                              "Round byes",
                              "Early / late",
                              "Minimum rest",
                              "Unmet preferences",
                            ].map((h) => (
                              <th key={h}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {validation.teams.map((t) => (
                            <tr key={t.teamId}>
                              <td>{name(t.teamId)}</td>
                              <td>
                                {t.home} / {t.away}
                              </td>
                              <td>{t.byes}</td>
                              <td>
                                {t.early} / {t.late}
                              </td>
                              <td>
                                {t.minimumRestMinutes === null
                                  ? "No adjacent games"
                                  : `${t.minimumRestMinutes} min`}
                              </td>
                              <td>{t.unmetPreferences}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {validation.conflictCount > 0 && (
                      <>
                        <h3>Hard conflicts</h3>
                        <ul>
                          {validation.conflicts.map((c, i) => (
                            <li key={i}>
                              {conflictLabels[c.code] || c.code}:{" "}
                              {c.fixtureIds
                                .map((id) => {
                                  const f = draft.fixtures.find(
                                    (f) => f.id === id,
                                  );
                                  return f
                                    ? `${name(f.homeTeamId)} versus ${name(f.awayTeamId)}`
                                    : id;
                                })
                                .join("; ")}
                            </li>
                          ))}
                        </ul>
                        {validation.conflictsTruncated && (
                          <p>
                            Showing the first 1,000 of{" "}
                            {validation.conflictCount} conflicts.
                          </p>
                        )}
                      </>
                    )}
                    {draft.search && (
                      <details>
                        <summary>
                          Generation diagnostics (
                          {draft.search.diagnostics.length} unscheduled at
                          generation)
                        </summary>
                        <ul>
                          {draft.search.diagnostics.map((d) => (
                            <li key={d.fixtureId}>
                              {d.fixtureId}: {d.reason};{" "}
                              {d.candidateCount ?? "unknown"} candidates;
                              rejected:{" "}
                              {Object.entries(d.rejectedCandidates)
                                .map(
                                  ([code, count]) =>
                                    `${conflictLabels[code] || code}: ${count}`,
                                )
                                .join("; ") || "none"}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
                <h3>Manual assignments</h3>
                <p>
                  Assignment slot choices{" "}
                  {fields.slots.length ? assignmentStart + 1 : 0} through{" "}
                  {Math.min(assignmentStart + 20, fields.slots.length)} of{" "}
                  {fields.slots.length}. An assigned slot remains visible when
                  it is on another page.
                </p>
                <button
                  type="button"
                  disabled={assignmentStart === 0}
                  onClick={() =>
                    setAssignmentSlotPage(Math.floor(assignmentStart / 20) - 1)
                  }
                >
                  Previous assignment slots
                </button>
                <button
                  type="button"
                  disabled={assignmentStart + 20 >= fields.slots.length}
                  onClick={() =>
                    setAssignmentSlotPage(Math.floor(assignmentStart / 20) + 1)
                  }
                >
                  Next assignment slots
                </button>
                <label>
                  Assignment slot page
                  <input
                    type="number"
                    min="1"
                    max={Math.max(1, Math.ceil(fields.slots.length / 20))}
                    value={assignmentStart / 20 + 1}
                    onChange={(e) =>
                      setAssignmentSlotPage(
                        Math.max(
                          0,
                          Math.min(
                            Math.ceil(fields.slots.length / 20) - 1,
                            Number(e.target.value) - 1,
                          ),
                        ),
                      )
                    }
                  />
                </label>
                <p>
                  Fixtures {fixturePage * 20 + 1} through{" "}
                  {Math.min((fixturePage + 1) * 20, draft.fixtures.length)} of{" "}
                  {draft.fixtures.length}
                </p>
                <button
                  type="button"
                  disabled={fixturePage === 0}
                  onClick={() => setFixturePage((p) => p - 1)}
                >
                  Previous fixtures
                </button>
                <button
                  type="button"
                  disabled={(fixturePage + 1) * 20 >= draft.fixtures.length}
                  onClick={() => setFixturePage((p) => p + 1)}
                >
                  Next fixtures
                </button>
                <p className="small muted">
                  Any edit invalidates validation immediately. Byes describe
                  pairing rounds, not calendar weeks.
                </p>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  aria-label="Fixture assignments"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Home</th>
                        <th>Away</th>
                        <th>Round</th>
                        <th>Assigned slot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.fixtures
                        .slice(fixturePage * 20, (fixturePage + 1) * 20)
                        .map((f) => (
                          <tr key={f.id}>
                            <td>{name(f.homeTeamId)}</td>
                            <td>{name(f.awayTeamId)}</td>
                            <td>
                              {f.round + 1} (cycle {f.cycle + 1})
                            </td>
                            <td>
                              <select
                                aria-label={`Slot for ${name(f.homeTeamId)} versus ${name(f.awayTeamId)} round ${f.round} cycle ${f.cycle}`}
                                value={
                                  assignments.find((a) => a.fixtureId === f.id)
                                    ?.slotId || ""
                                }
                                onChange={(e) => {
                                  invalidate();
                                  setAssignments((a) => [
                                    ...a.filter((v) => v.fixtureId !== f.id),
                                    ...(e.target.value
                                      ? [
                                          {
                                            fixtureId: f.id,
                                            slotId: e.target.value,
                                          },
                                        ]
                                      : []),
                                  ]);
                                }}
                              >
                                <option value="">Unscheduled</option>
                                {fixtureChoices(f.id).map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.id} · {s.startsAt} · {s.resourceId}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </fieldset>
          {retry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("save")}
            >
              Retry same action
            </button>
          )}
          <button type="button" disabled>
            Publish schedule (disabled)
          </button>
          {busy && <p role="status">Checking current records…</p>}
        </>
      )}
    </main>
  );
}
