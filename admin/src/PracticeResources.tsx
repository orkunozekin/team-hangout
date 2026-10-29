import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminEntity } from "../../shared/admin";
import {
  ageLabel,
  AVAILABILITY_LABELS,
  lines,
  ORIGIN_LABELS,
  parseAge,
  RIGHTS_ORIGINS,
  type EditorResourceRow,
  type ResourceContent,
  type ResourceDetail,
  type ResourceRights,
  type ResourceStatus,
  type RightsOrigin,
} from "../../shared/practiceResources";
import type { BrowserServices } from "./firebase";
import { message, uncertain } from "./errors";

type Form = {
  title: string; objectives: string; ageMin: string; ageMax: string; durationMinutes: string; equipment: string; instructions: string; safetyNotes: string;
  origin: RightsOrigin; owner: string; allowedUses: string; attribution: string; evidence: string; licenseUrl: string; expiresOn: string; derivativesAllowed: boolean;
};
const blank: Form = {
  title: "", objectives: "", ageMin: "", ageMax: "", durationMinutes: "", equipment: "", instructions: "", safetyNotes: "",
  origin: "original", owner: "", allowedUses: "", attribution: "", evidence: "", licenseUrl: "", expiresOn: "", derivativesAllowed: false,
};
/** Inverse of fromForm: the stored instant is the start of the day after the last permitted day. */
const localDate = (iso: string | null) => {
  if (!iso) return "";
  const at = new Date(Date.parse(iso) - 1);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
function toForm(detail: ResourceDetail | null): Form {
  const source = detail?.draft ?? detail?.published;
  if (!source) return blank;
  const { content, rights } = source;
  return {
    title: content.title, objectives: content.objectives.join("\n"), ageMin: String(content.ageMin), ageMax: String(content.ageMax),
    durationMinutes: String(content.durationMinutes), equipment: content.equipment.join("\n"), instructions: content.instructions, safetyNotes: content.safetyNotes,
    origin: rights.origin, owner: rights.owner, allowedUses: rights.allowedUses, attribution: rights.attribution ?? "", evidence: rights.evidence,
    licenseUrl: rights.licenseUrl ?? "", expiresOn: localDate(rights.expiresAt), derivativesAllowed: rights.derivativesAllowed,
  };
}
/** The permission lasts through the chosen local date. */
function fromForm(form: Form): { content: ResourceContent; rights: ResourceRights } | string {
  const ageMin = parseAge(form.ageMin);
  const ageMax = parseAge(form.ageMax);
  if (ageMin == null || ageMax == null) return "Enter ages from 4 to 19.";
  if (ageMax < ageMin) return "The oldest age must be at least the youngest age.";
  const duration = Number(form.durationMinutes);
  if (!Number.isInteger(duration) || duration < 1 || duration > 120) return "Duration must be 1 to 120 minutes.";
  if (!form.evidence.trim()) return "Record the rights evidence reference before saving.";
  const [year, month, day] = form.expiresOn.split("-").map(Number);
  return {
    content: {
      title: form.title.trim(), objectives: lines(form.objectives), ageMin, ageMax, durationMinutes: duration,
      equipment: lines(form.equipment), instructions: form.instructions.trim(), safetyNotes: form.safetyNotes.trim(),
    },
    rights: {
      origin: form.origin, owner: form.owner.trim(), allowedUses: form.allowedUses.trim(), attribution: form.attribution.trim() || null,
      evidence: form.evidence.trim(), licenseUrl: form.licenseUrl.trim() || null, derivativesAllowed: form.derivativesAllowed,
      expiresAt: form.expiresOn ? new Date(year, month - 1, day + 1).toISOString() : null,
    },
  };
}

function Editor({ detail, busy, onSave }: { detail: ResourceDetail | null; busy: boolean; onSave: (form: Form) => void }) {
  const [form, setForm] = useState<Form>(() => toForm(detail));
  useEffect(() => setForm(toForm(detail)), [detail]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const field = (key: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <label>{label}<input value={form[key] as string} onChange={(e) => set(key, e.target.value as never)} {...props} /></label>
  );
  const area = (key: keyof Form, label: string, maxLength: number) => (
    <label>{label}<textarea value={form[key] as string} maxLength={maxLength} onChange={(e) => set(key, e.target.value as never)} /></label>
  );
  return (
    <form className="practice-form" onSubmit={(e) => { e.preventDefault(); onSave(form); }}>
      <fieldset>
        <legend>Content</legend>
        {field("title", "Title", { maxLength: 80, required: true })}
        {area("objectives", "Objectives, one per line", 700)}
        <div className="toolbar">
          {field("ageMin", "Youngest age", { inputMode: "numeric", maxLength: 2 })}
          {field("ageMax", "Oldest age", { inputMode: "numeric", maxLength: 2 })}
          {field("durationMinutes", "Duration in minutes", { inputMode: "numeric", maxLength: 3 })}
        </div>
        {area("equipment", "Equipment, one per line", 700)}
        {area("instructions", "Instructions", 4000)}
        {area("safetyNotes", "Safety instructions", 1000)}
      </fieldset>
      <fieldset>
        <legend>Rights register</legend>
        <label>Origin
          <select value={form.origin} onChange={(e) => set("origin", e.target.value as RightsOrigin)}>
            {RIGHTS_ORIGINS.map((origin) => <option key={origin} value={origin}>{ORIGIN_LABELS[origin]}</option>)}
          </select>
        </label>
        {field("owner", "Rights owner", { maxLength: 120 })}
        {field("allowedUses", "Allowed uses", { maxLength: 300 })}
        {field("attribution", "Attribution shown to coaches", { maxLength: 200 })}
        {field("evidence", "Rights evidence reference", { maxLength: 500 })}
        {field("licenseUrl", "License URL", { maxLength: 300, type: "url" })}
        {field("expiresOn", "Permission ends after", { type: "date" })}
        <label className="checkbox"><input type="checkbox" checked={form.derivativesAllowed} onChange={(e) => set("derivativesAllowed", e.target.checked)} />Adaptations allowed</label>
      </fieldset>
      <div className="actions"><button className="primary" type="submit" disabled={busy}>{detail?.published && !detail.draft ? "Save as new draft version" : "Save draft"}</button></div>
    </form>
  );
}

function Review({ detail, busy, onApprove, onWithdraw }: {
  detail: ResourceDetail; busy: boolean; onApprove: (note: string) => void; onWithdraw: (reason: string) => void;
}) {
  const [rights, setRights] = useState(false);
  const [safety, setSafety] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => { setRights(false); setSafety(false); setNote(""); setReason(""); }, [detail.revision]);
  const published = detail.published;
  return (
    <>
      {published && (
        <p>
          Version {published.version} published {new Date(published.publishedAt).toLocaleDateString()}. Reviewed for rights and age and safety ({published.review.qualification}).
          {published.rights.expiresAt ? ` Permission ends ${new Date(published.rights.expiresAt).toLocaleDateString()}.` : " Permission has no end date."}
        </p>
      )}
      {detail.withdrawal && <p className="error">Withdrawn: {detail.withdrawal.reason}. Coaches can no longer add it, and existing plans show a withdrawal notice.</p>}
      {detail.draft && detail.status !== "withdrawn" && (
        detail.canReview ? (
          <form className="practice-review" onSubmit={(e) => { e.preventDefault(); onApprove(note); }}>
            <h3>Review version {detail.draft.version}</h3>
            <label className="checkbox"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />I verified the rights evidence and allowed uses</label>
            <label className="checkbox"><input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} />I reviewed sport, age band, equipment, duration and safety instructions</label>
            <label>Review note<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
            <button className="primary" type="submit" disabled={busy || !rights || !safety}>Approve and publish</button>
          </form>
        ) : <p className="notice" role="status">Version {detail.draft.version} awaits a designated reviewer who did not edit it.</p>
      )}
      {detail.status !== "withdrawn" && (
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); onWithdraw(reason); }}>
          <label>Withdrawal reason<input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="submit" disabled={busy || !reason.trim()}>Withdraw resource</button>
        </form>
      )}
    </>
  );
}

export function PracticeResources({ services, orgId, programId: initialProgram }: { services: BrowserServices; orgId: string; programId: string }) {
  const [programs, setPrograms] = useState<AdminEntity[]>([]);
  const [programId, setProgramId] = useState(initialProgram);
  const [status, setStatus] = useState<ResourceStatus | "">("");
  const [ageText, setAgeText] = useState("");
  const [rows, setRows] = useState<EditorResourceRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ status: ResourceStatus | ""; age: number | null }>({ status: "", age: null });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const pending = useRef<{ key: string; requestId: string } | null>(null);

  useEffect(() => {
    let current = true;
    (async () => {
      const items: AdminEntity[] = [];
      let next: string | undefined;
      do {
        const page = await services.call("listOrganizationHierarchy", { orgId, kind: "program", ...(next ? { cursor: next } : {}) });
        items.push(...page.items);
        next = page.nextCursor || undefined;
      } while (next);
      if (current) setPrograms(items);
    })().catch((reason) => current && setError(message(reason)));
    return () => { current = false; };
  }, [orgId, services]);

  const load = useCallback(async (more: boolean, applied = filter) => {
    if (!programId) return;
    const seq = ++listSeq.current;
    try {
      const page = await services.call("listPracticeResources", {
        orgId, programId, pageSize: 20, ...(applied.status ? { status: applied.status } : {}), ...(applied.age != null ? { age: applied.age } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      // A slower earlier response never replaces a newer filter or program.
      if (seq !== listSeq.current) return;
      setRows((current) => (more ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (reason) {
      if (seq === listSeq.current) setError(message(reason));
    }
  }, [cursor, filter, orgId, programId, services]);
  useEffect(() => { setRows([]); setCursor(null); setSelected(null); setCreating(false); void load(false); }, [programId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(async (resourceId: string) => {
    const seq = ++detailSeq.current;
    setSelected(resourceId);
    setCreating(false);
    try {
      const value = await services.call("getPracticeResource", { orgId, resourceId });
      if (seq === detailSeq.current) setDetail(value);
    } catch (reason) {
      if (seq === detailSeq.current) setError(message(reason));
    }
  }, [orgId, services]);

  const applyFilter = () => {
    const age = parseAge(ageText);
    if (age === undefined) return setError("Enter an age from 4 to 19, or leave it blank.");
    const next = { status: age != null ? ("published" as const) : status, age };
    setError("");
    setFilter(next);
    void load(false, next);
  };

  /** One request ID per intent, reused only after an uncertain failure. */
  const run = async (key: string, action: (requestId: string) => Promise<{ resourceId: string }>, done: string) => {
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action(pending.current.requestId);
      pending.current = null;
      setNotice(done);
      await Promise.all([load(false), open(result.resourceId)]);
    } catch (reason) {
      if (!uncertain(reason)) pending.current = null;
      setError(message(reason));
      // Only a stale copy is reloaded; other failures keep the editor's unsaved fields.
      const code = (reason as { details?: { domainCode?: string } })?.details?.domainCode;
      if (selected && code === "STALE_REVISION") await open(selected);
    } finally {
      setBusy(false);
    }
  };

  const save = (form: Form) => {
    const value = fromForm(form);
    if (typeof value === "string") return setError(value);
    const resourceId = creating ? null : selected;
    const expectedRevision = creating ? 0 : detail?.revision ?? 0;
    const payload = { programId, ...value };
    void run(`save:${resourceId}:${expectedRevision}:${JSON.stringify(payload)}`, (requestId) => services.call("savePracticeResource", {
      requestId, orgId, resourceId, expectedRevision, payload,
    }), `Saved draft of ${value.content.title}. It stays unavailable to coaches until a designated reviewer approves it.`);
  };
  const decide = (payload: { action: "approve"; rightsVerified: boolean; ageSafetyReviewed: boolean; reviewNote: string | null } | { action: "withdraw"; reason: string }, done: string) => {
    if (!detail) return;
    void run(`${payload.action}:${detail.resourceId}:${detail.revision}`, (requestId) => services.call("publishPracticeResource", {
      requestId, orgId, resourceId: detail.resourceId, expectedRevision: detail.revision, payload,
    }), done);
  };

  const shownDetail = !creating && detail && detail.resourceId === selected ? detail : null;
  return (
    <div className="page practice">
      <h1>Practice resources</h1>
      <p className="muted">Original or permission-cleared drills for volunteer coaches. A resource reaches coaches only after a designated reviewer, other than its last editor, verifies its rights evidence and its age and safety guidance.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <h2>Resources</h2>
        <form className="toolbar report-form" onSubmit={(e) => { e.preventDefault(); applyFilter(); }}>
          <label>Program
            <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
              <option value="">Choose a program</option>
              {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
            </select>
          </label>
          <label>Status
            <select value={status} onChange={(e) => setStatus(e.target.value as ResourceStatus | "")}>
              <option value="">All</option><option value="draft">Draft</option><option value="published">Published</option><option value="withdrawn">Withdrawn</option>
            </select>
          </label>
          <label>Player age<input value={ageText} inputMode="numeric" maxLength={2} onChange={(e) => setAgeText(e.target.value)} /></label>
          <button type="submit" disabled={!programId}>Apply filters</button>
          <button type="button" disabled={!programId} onClick={() => { setCreating(true); setSelected(null); }}>New resource</button>
        </form>
        {programId && !rows.length ? (
          <p className="muted">{filter.age != null ? `No published resources for age ${filter.age}.` : "No resources match these filters."}</p>
        ) : null}
        {rows.length ? (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Practice resources in this program</caption>
              <thead><tr><th scope="col">Resource</th><th scope="col">Ages</th><th scope="col">State</th><th scope="col">Versions</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.resourceId} aria-current={row.resourceId === selected ? "true" : undefined}>
                    <th scope="row">{row.title}</th>
                    <td>{row.ageMin != null && row.ageMax != null ? ageLabel({ ageMin: row.ageMin, ageMax: row.ageMax }) : "Not set"}</td>
                    <td>{AVAILABILITY_LABELS[row.availability]}{row.draftVersion && row.status === "published" ? ", edits awaiting review" : ""}</td>
                    <td>{row.publishedVersion ? `Published v${row.publishedVersion}` : "Not published"}{row.draftVersion ? `, draft v${row.draftVersion}` : ""}</td>
                    <td><button type="button" onClick={() => void open(row.resourceId)}>Open {row.title}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {cursor && <div className="actions"><button type="button" onClick={() => void load(true)}>Load more resources</button></div>}
      </section>
      {(creating || shownDetail) && (
        <section className="panel" aria-labelledby="practice-detail">
          <h2 id="practice-detail">{creating ? "New resource" : `${toForm(shownDetail).title}: ${AVAILABILITY_LABELS[shownDetail!.availability]}`}</h2>
          {shownDetail && <Review detail={shownDetail} busy={busy}
            onApprove={(note) => decide({ action: "approve", rightsVerified: true, ageSafetyReviewed: true, reviewNote: note.trim() || null }, "Approved and published. Coaches can now add it to practice plans.")}
            onWithdraw={(reason) => decide({ action: "withdraw", reason: reason.trim() }, "Withdrawn. Coaches can no longer add it.")} />}
          {(creating || shownDetail?.status !== "withdrawn") && <Editor detail={creating ? null : shownDetail} busy={busy} onSave={save} />}
        </section>
      )}
    </div>
  );
}
