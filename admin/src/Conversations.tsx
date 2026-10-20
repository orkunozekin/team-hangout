import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CONVERSATION_REACTIONS, type ConversationMessage, type ConversationPage, type ConversationScopeType, type ConversationSearchPage, type StaffNote } from "../../shared/conversations";
import type { BrowserServices } from "./firebase";
import { message } from "./errors";

const requestId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

export function Conversations({ services, orgId }: { services: BrowserServices; orgId: string }) {
  const [scopeType, setScopeType] = useState<ConversationScopeType>("team");
  const [scopeId, setScopeId] = useState("");
  const [channel, setChannel] = useState<ConversationPage | null>(null);
  const [messages, setMessages] = useState<ConversationPage["items"]>([]);
  const [notes, setNotes] = useState<StaffNote[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [noteCursor, setNoteCursor] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<ConversationMessage | null>(null);
  const [replacement, setReplacement] = useState("");
  const [removal, setRemoval] = useState<{ id: string; reason: string } | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ConversationSearchPage | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<{ key: string; attachmentId?: string; detail: string; state: "scanning" | "rejected" | "ready" }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchGeneration = useRef(0);
  const clearSearch = useCallback(() => {
    searchGeneration.current += 1;
    setSearch(null);
    setSearched(false);
  }, []);
  const load = useCallback(async () => {
    clearSearch();
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
      setMessages(page.items);
      setNotes(staff.items);
      setMessageCursor(page.nextCursor);
      setNoteCursor(staff.nextCursor);
    } catch (caught) {
      setChannel(null);
      setMessages([]);
      setNotes([]);
      setMessageCursor(null);
      setNoteCursor(null);
      setSearch(null);
      setSearched(false);
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }, [clearSearch, orgId, scopeId, scopeType, services]);
  async function older(kind: "messages" | "notes") {
    const cursor = kind === "messages" ? messageCursor : noteCursor;
    if (!cursor || !scopeId.trim()) return;
    setError("");
    try {
      const input = { orgId, scopeType, scopeId: scopeId.trim(), pageSize: 25, cursor };
      if (kind === "messages") {
        const page = await services.call("listConversationMessages", input);
        setMessages((current) => [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))]);
        setMessageCursor(page.nextCursor);
        setChannel(page);
      } else {
        const staff = await services.call("listStaffNotes", input);
        setNotes((current) => [...current, ...staff.items.filter((item) => !current.some((row) => row.id === item.id))]);
        setNoteCursor(staff.nextCursor);
      }
    } catch (caught) {
      setError(message(caught));
    }
  }
  useEffect(() => { void load(); }, [load]);
  async function post(event: FormEvent, kind: "announcement" | "note") {
    event.preventDefault();
    setError("");
    try {
      const text = kind === "announcement" ? announcement.trim() : note.trim();
      const attachmentIds = kind === "announcement" ? files.filter((item) => item.state === "ready" && item.attachmentId).slice(0, 3).map((item) => item.attachmentId!) : [];
      await services.call(kind === "announcement" ? "postConversationMessage" : "postStaffNote", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), text, ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      if (kind === "announcement") {
        setAnnouncement("");
        if (attachmentIds.length) setFiles((current) => current.filter((item) => !attachmentIds.includes(item.attachmentId ?? "")));
      } else setNote("");
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !scopeId.trim()) return;
    setError("");
    try {
      await services.call("editConversationMessage", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), messageId: editing.id, text: replacement.trim(), expectedRevision: editing.revision ?? 0,
      });
      setEditing(null);
      setReplacement("");
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!removal || !scopeId.trim()) return;
    setError("");
    try {
      await services.call("moderateConversationMessage", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), messageId: removal.id, reason: removal.reason.trim(),
      });
      setRemoval(null);
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function react(item: ConversationMessage, emoji: string) {
    if (!scopeId.trim()) return;
    setError("");
    try {
      await services.call("reactToConversationMessage", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), messageId: item.id, emoji, expectedRevision: item.revision ?? 0,
      });
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  }
  async function find(event?: FormEvent, cursor?: string | null) {
    event?.preventDefault();
    if (!scopeId.trim() || !query.trim()) return;
    const generation = searchGeneration.current;
    setError("");
    try {
      const next = await services.call("searchConversationMessages", {
        orgId, scopeType, scopeId: scopeId.trim(), text: query.trim(), ...(cursor ? { cursor } : {}),
      });
      if (generation !== searchGeneration.current) return;
      setSearch(cursor && search ? { ...next, items: [...search.items, ...next.items.filter((item) => !search.items.some((row) => row.id === item.id))] } : next);
      setSearched(true);
    } catch (caught) {
      if (generation !== searchGeneration.current) return;
      setSearch(null);
      setSearched(false);
      setError(message(caught));
    }
  }
  function updateFile(key: string, patch: Partial<{ attachmentId: string; detail: string; state: "scanning" | "rejected" | "ready" }>) {
    setFiles((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }
  async function uploadFile(event: FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || !scopeId.trim()) return;
    const key = requestId();
    setError("");
    setFiles((current) => [...current, { key, detail: `Scanning · ${file.name}`, state: "scanning" }]);
    try {
      const grant = await services.call("createAttachmentUpload", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), fileName: file.name, declaredBytes: file.size,
      });
      updateFile(key, { attachmentId: grant.id });
      const put = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Attachment ${grant.token}`, "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!put.ok) {
        updateFile(key, { state: "rejected", detail: `Rejected · ${file.name}` });
        setError(put.status === 410 ? "This upload expired. Choose the file again." : put.status === 413 ? "This file does not match the reserved upload." : "This file was not uploaded.");
        return;
      }
      const done = await services.call("finalizeAttachment", {
        requestId: requestId(), orgId, scopeType, scopeId: scopeId.trim(), attachmentId: grant.id,
      });
      if (done.state !== "ready") {
        updateFile(key, { state: "rejected", detail: `Rejected · ${file.name} · ${done.rejectionCode ?? "rejected"}` });
        return;
      }
      const idToken = await services.auth.currentUser?.getIdToken();
      const downloaded = await fetch(grant.uploadUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${idToken ?? ""}`,
          "X-Org-Id": orgId,
          "X-Scope-Type": scopeType,
          "X-Scope-Id": scopeId.trim(),
          "X-Attachment-Id": grant.id,
        },
      });
      updateFile(key, {
        attachmentId: grant.id,
        state: "ready",
        detail: downloaded.ok
          ? `Ready · ${file.name} · ${done.detectedType} · ${done.byteLength} bytes`
          : `Ready · ${file.name} · download unavailable`,
      });
      if (fileInput.current) fileInput.current.value = "";
    } catch (caught) {
      updateFile(key, { state: "rejected", detail: `Rejected · ${file.name}` });
      setError(message(caught));
    }
  }
  const youthClosed = channel?.mode === "youth" && channel.youthPosting === "closed";
  const attachmentsOpen = channel?.attachments === "enabled" && channel.canPost;
  return <section className="conversations">
    <div className="page-heading"><div><p className="eyebrow">Organization</p><h1>Conversations and staff notes</h1></div></div>
    <p>Household channels and staff notes are separate. A note is never posted into the channel.</p>
    <form className="panel" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <label>Scope
        <select value={scopeType} onChange={(event) => { setScopeType(event.target.value as ConversationScopeType); clearSearch(); }}>
          <option value="organization">Organization announcement</option>
          <option value="division">Division announcement</option>
          <option value="team">Team channel</option>
          <option value="event">Event channel</option>
        </select>
      </label>
      <label>Scope id
        <input value={scopeId} onChange={(event) => { setScopeId(event.target.value); clearSearch(); }} placeholder={scopeType === "organization" ? orgId : "team or event id"} />
      </label>
      <button type="submit">Open channel</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {youthClosed ? <p className="youth-closed" role="status">Youth posting is closed until an administrator approves the organization policy. Guardians can read this group channel and cannot post yet.</p> : null}
    {loading ? <p>Loading channel…</p> : null}
    <div className="conversation-columns">
      <section aria-labelledby="household-channel">
        <h2 id="household-channel">Household channel</h2>
        <ul>{messages.map((item) => <li key={item.id}>
          <p>{item.tombstoned ? "Message removed by a moderator" : item.body}{item.pinned ? " · Pinned" : ""}{item.editedAt ? " · Edited" : ""}</p>
          {item.tombstoned ? null : item.attachments?.map((file) => <p key={file.id}>{file.fileName} · {file.detectedType} · {file.byteLength} bytes</p>)}
          {item.tombstoned ? null : <div>
            {CONVERSATION_REACTIONS.map((choice) => {
              const reaction = item.reactions?.find((row) => row.emoji === choice.emoji);
              return <button key={choice.code} type="button" aria-pressed={reaction?.mine === true} onClick={() => void react(item, choice.emoji)}>React with {choice.emoji} {reaction?.count ?? 0}</button>;
            })}
            {item.mine ? <button type="button" onClick={() => { setEditing(item); setReplacement(item.body ?? ""); }}>Edit message</button> : null}
            <button type="button" onClick={() => setRemoval({ id: item.id, reason: "" })}>Remove message</button>
          </div>}
          {editing?.id === item.id ? <form onSubmit={(event) => void saveEdit(event)}>
            <label>Replacement text
              <textarea value={replacement} onChange={(event) => setReplacement(event.target.value)} />
            </label>
            <button type="submit">Save edit</button>
          </form> : null}
          {removal?.id === item.id ? <form onSubmit={(event) => void remove(event)}>
            <label>Removal reason
              <input value={removal.reason} onChange={(event) => setRemoval({ id: item.id, reason: event.target.value })} />
            </label>
            <button type="submit">Confirm removal</button>
          </form> : null}
        </li>)}</ul>
        {!messages.length && !error ? <p>No household messages.</p> : null}
        {messageCursor ? <button type="button" onClick={() => void older("messages")}>Load older messages</button> : null}
        {attachmentsOpen ? <form onSubmit={(event) => void uploadFile(event)}>
          <h2 id="attachment-transport">Attachments</h2>
          <p>JPEG, PNG, and PDF files up to 10 MB. Metadata is removed and the file is scanned before it can be sent. A rejected file is not added to the message. Ready files are included with the next announcement, up to 3.</p>
          <label>Attachment file
            <input ref={fileInput} type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" />
          </label>
          <button type="submit">Upload attachment</button>
          <ul aria-label="Attachment status">{files.map((item) => <li key={item.key}>{item.detail}</li>)}</ul>
        </form> : null}
        <form onSubmit={(event) => void post(event, "announcement")}>
          <label>Announcement
            <textarea value={announcement} onChange={(event) => setAnnouncement(event.target.value)} />
          </label>
          <button type="submit">Post announcement</button>
        </form>
        <form onSubmit={(event) => void find(event)}>
          <h2 id="message-search">Search messages</h2>
          <p>Search covers this household channel only. Staff notes are not included.</p>
          <label>Search words
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="submit">Search messages</button>
        </form>
        <section aria-labelledby="message-search">
          {search?.partial ? <p>More matches may remain. Continue the search.</p> : null}
          <ul>{search?.items.map((item) => <li key={item.id}>{item.body}{item.editedAt ? " · Edited" : ""}</li>)}</ul>
          {searched && search && !search.items.length ? <p>No matching messages.</p> : null}
          {search?.nextCursor ? <button type="button" onClick={() => void find(undefined, search.nextCursor)}>Continue search</button> : null}
        </section>
      </section>
      <section aria-labelledby="staff-notes">
        <h2 id="staff-notes">Staff notes</h2>
        <p>Only organization administrators and program staff can read these notes.</p>
        <ul>{notes.map((item) => <li key={item.id}>{item.body}</li>)}</ul>
        {!notes.length && !error ? <p>No staff notes.</p> : null}
        {noteCursor ? <button type="button" onClick={() => void older("notes")}>Load older notes</button> : null}
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
