import { FormEvent, useCallback, useEffect, useState } from "react";
import type { ConversationPage, ConversationScopeType, StaffNote } from "../../shared/conversations";
import type { BrowserServices } from "./firebase";
import { message } from "./errors";

const requestId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

export function Conversations({ services, orgId }: { services: BrowserServices; orgId: string }) {
  const [scopeType, setScopeType] = useState<ConversationScopeType>("team");
  const [scopeId, setScopeId] = useState("");
  const [channel, setChannel] = useState<ConversationPage | null>(null);
  const [notes, setNotes] = useState<StaffNote[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!scopeId.trim()) return;
    setLoading(true);
    setError("");
    try {
      const input = { orgId, scopeType, scopeId: scopeId.trim(), pageSize: 25 };
      const [page, staff] = await Promise.all([
        services.call("listConversationMessages", input),
        services.call("listStaffNotes", input),
      ]);
      setChannel(page);
      setNotes(staff.items);
    } catch (caught) {
      setChannel(null);
      setNotes([]);
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }, [orgId, scopeId, scopeType, services]);
  useEffect(() => { void load(); }, [load]);
  async function post(event: FormEvent, kind: "announcement" | "note") {
    event.preventDefault();
    setError("");
    try {
      const text = kind === "announcement" ? announcement.trim() : note.trim();
      await services.call(kind === "announcement" ? "postConversationMessage" : "postStaffNote", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), text,
      });
      if (kind === "announcement") setAnnouncement(""); else setNote("");
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  }
  const youthClosed = channel?.mode === "youth" && channel.youthPosting === "closed";
  return <section className="conversations">
    <div className="page-heading"><div><p className="eyebrow">Organization</p><h1>Conversations and staff notes</h1></div></div>
    <p>Household channels and staff notes are separate. A note is never posted into the channel.</p>
    <form className="panel" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>Scope
        <select value={scopeType} onChange={(event) => setScopeType(event.target.value as ConversationScopeType)}>
          <option value="organization">Organization announcement</option>
          <option value="division">Division announcement</option>
          <option value="team">Team channel</option>
          <option value="event">Event channel</option>
        </select>
      </label>
      <label>Scope id
        <input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder={scopeType === "organization" ? orgId : "team or event id"} />
      </label>
      <button type="submit">Open channel</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {youthClosed ? <p className="youth-closed" role="status">Youth posting is closed until an administrator approves the organization policy. Guardians can read this group channel and cannot post yet.</p> : null}
    {loading ? <p>Loading channel…</p> : null}
    <div className="conversation-columns">
      <section aria-labelledby="household-channel">
        <h2 id="household-channel">Household channel</h2>
        <ul>{channel?.items.map((item) => <li key={item.id}>{item.tombstoned ? "Message removed by a moderator" : item.body}{item.pinned ? " · Pinned" : ""}</li>)}</ul>
        {!channel?.items.length && !error ? <p>No household messages.</p> : null}
        <form onSubmit={(event) => void post(event, "announcement")}>
          <label>Announcement
            <textarea value={announcement} onChange={(event) => setAnnouncement(event.target.value)} />
          </label>
          <button type="submit">Post announcement</button>
        </form>
      </section>
      <section aria-labelledby="staff-notes">
        <h2 id="staff-notes">Staff notes</h2>
        <p>Only organization administrators and program staff can read these notes.</p>
        <ul>{notes.map((item) => <li key={item.id}>{item.body}</li>)}</ul>
        {!notes.length && !error ? <p>No staff notes.</p> : null}
        <form onSubmit={(event) => void post(event, "note")}>
          <label>Staff note
            <textarea value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button type="submit">Save staff note</button>
        </form>
      </section>
    </div>
  </section>;
}
