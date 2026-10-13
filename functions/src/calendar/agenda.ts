import { createHash } from "node:crypto";
import {
  FieldPath,
  getFirestore,
  Timestamp,
  Transaction,
  Query,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { Data, id, invalid, keys, object } from "../commandSupport";
import { hierarchy, staffScope } from "../organizations/policy";
import { householdAccess, readCommand } from "../participants/policy";
type AgendaParticipant = {
  orgId: string;
  participantId: string;
  displayName: string;
};
type AgendaTeam = {
  id: string;
  orgId: string;
  organizationName: string;
  name: string;
  seasonId: string;
  seasonName: string;
  seasonStatus: string;
  archived: boolean;
  participants: AgendaParticipant[];
};
type AgendaEvent = Data & { id: string; startsAt: string };

const LIMIT = 100;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function exhausted(): never {
  throw new HttpsError(
    "resource-exhausted",
    "This agenda requires a narrower supported access scope. Contact your administrator.",
  );
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid("Use an ISO UTC instant.");
  return value as string;
}
function list(value: unknown, normalize: (value: unknown) => unknown): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMIT)
    invalid("Invalid agenda filters.");
  return [
    ...new Map(
      (value as unknown[]).map((v) => {
        const item = normalize(v);
        return [JSON.stringify(item), item];
      }),
    ).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function normalize(data: Data): Data {
  keys(data, [
    "from",
    "to",
    "participantRefs",
    "teamIds",
    "orgIds",
    "seasonRefs",
    "eventTypes",
    "includeArchived",
    "cursor",
    "pageSize",
  ]);
  const from = instant(data.from),
    to = instant(data.to);
  if (to <= from || Date.parse(to) - Date.parse(from) > 93 * 86400000)
    invalid("Choose a window of at most 93 days.");
  const pageSize = data.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    invalid("pageSize must be 1 through 100.");
  if (
    data.includeArchived !== undefined &&
    typeof data.includeArchived !== "boolean"
  )
    invalid("Invalid archive filter.");
  if (
    data.cursor != null &&
    (typeof data.cursor !== "string" || data.cursor.length > 2000)
  )
    invalid("Invalid cursor.");
  const refs = (field: "participantId" | "seasonId") => (value: unknown) => {
    const row = object(value);
    keys(row, ["orgId", field]);
    return { orgId: id(row.orgId, "orgId"), [field]: id(row[field], field) };
  };
  return {
    from,
    to,
    pageSize,
    includeArchived: data.includeArchived ?? false,
    cursor: data.cursor ?? null,
    participantRefs: list(data.participantRefs, refs("participantId")),
    seasonRefs: list(data.seasonRefs, refs("seasonId")),
    teamIds: list(data.teamIds, (v) => id(v, "teamId")),
    orgIds: list(data.orgIds, (v) => id(v, "orgId")),
    eventTypes: list(data.eventTypes, (v) => {
      if (!["practice", "match"].includes(v as string))
        invalid("Invalid event type.");
      return v;
    }),
  };
}
function permissionError(error: unknown) {
  return error instanceof HttpsError && error.code === "permission-denied";
}
async function bounded(tx: Transaction, query: Query, limit = LIMIT) {
  const rows = await tx.get(query.limit(limit + 1));
  if (rows.size > limit) exhausted();
  return rows.docs;
}

export async function readAgenda(
  tx: Transaction,
  payload: Data,
  uid: string,
  options: { events?: boolean } = {},
): Promise<Data> {
  const db = getFirestore();
  const candidates = new Set<string>();
  const labels = new Map<string, AgendaParticipant[]>();
  let setupRequired = false;
  // Migrated self participants predate navigation pointers. Discover personal sources canonically.
  const personal = new Map<string, { orgId: string; participantId: string }>();
  const selfRows = await bounded(
    tx,
    db.collectionGroup("participants").where("linkedUserId", "==", uid),
  );
  for (const doc of selfRows) {
    const orgId = doc.ref.parent.parent?.id;
    if (
      orgId &&
      doc.ref.path === `organizations/${orgId}/participants/${doc.id}`
    )
      personal.set(`${orgId}/${doc.id}`, { orgId, participantId: doc.id });
  }
  const guardianRows = await bounded(
    tx,
    db.collectionGroup("guardians").where("userId", "==", uid),
  );
  for (const doc of guardianRows) {
    const row = doc.data();
    if (
      typeof row.orgId === "string" &&
      typeof row.participantId === "string" &&
      doc.ref.path ===
        `organizations/${row.orgId}/participants/${row.participantId}/guardians/${uid}`
    )
      personal.set(`${row.orgId}/${row.participantId}`, {
        orgId: row.orgId,
        participantId: row.participantId,
      });
  }
  if (personal.size > LIMIT) exhausted();
  for (const row of [...personal.values()].sort((a, b) =>
    `${a.orgId}/${a.participantId}`.localeCompare(
      `${b.orgId}/${b.participantId}`,
    ),
  )) {
    try {
      const access = await householdAccess(
        tx,
        id(row.orgId, "orgId"),
        id(row.participantId, "participantId"),
        uid,
        "viewSchedule",
      );
      const rosters = await bounded(
        tx,
        db
          .collectionGroup("roster")
          .where("orgId", "==", row.orgId)
          .where("participantId", "==", row.participantId)
          .where("status", "==", "active"),
        20,
      );
      for (const roster of rosters) {
        const teamId = roster.ref.parent.parent?.id;
        if (
          !teamId ||
          roster.ref.path !== `teams/${teamId}/roster/${row.participantId}`
        )
          continue;
        candidates.add(teamId);
        const participant = {
          orgId: row.orgId,
          participantId: row.participantId,
          displayName: access.row.displayName,
        };
        const previous = labels.get(teamId) ?? [];
        if (
          !previous.some(
            (p) =>
              p.orgId === participant.orgId &&
              p.participantId === participant.participantId,
          )
        )
          previous.push(participant);
        labels.set(teamId, previous);
      }
    } catch (error) {
      if (!permissionError(error)) throw error;
    }
  }
  // Staff navigation pointers nominate organizations; canonical staffScope grants authority.
  const staffTeams = new Set<string>();
  const orgLinks = await bounded(
    tx,
    db.collection(`users/${uid}/organizationLinks`),
  );
  for (const link of orgLinks) {
    const orgId = link.data().orgId;
    if (typeof orgId !== "string") continue;
    try {
      const scope = await staffScope(tx, id(orgId, "orgId"), uid);
      if (
        scope.organization.features?.households !== true ||
        scope.organization.features?.organizationV2 !== true
      )
        continue;
      const queries = scope.admin
        ? [db.collection("teams").where("orgId", "==", orgId)]
        : scope.programIds.map((programId) =>
            db
              .collection("teams")
              .where("orgId", "==", orgId)
              .where("programId", "==", programId),
          );
      if (queries.length > LIMIT) exhausted();
      for (const query of queries)
        for (const team of await bounded(tx, query)) {
          candidates.add(team.id);
          staffTeams.add(team.id);
        }
    } catch (error) {
      if (!permissionError(error)) throw error;
    }
  }
  const memberships = await bounded(
    tx,
    db.collection("teamMembers").where("userId", "==", uid),
  );
  for (const member of memberships) {
    const row = member.data();
    if (typeof row.teamId !== "string" || member.id !== `${row.teamId}_${uid}`)
      continue;
    if (row.schemaVersion !== 2) {
      if (row.role === "coach" || row.role === "player") setupRequired = true;
      continue;
    }
    if (
      row.status === "active" &&
      row.roles?.some((role: string) => ["coach", "captain"].includes(role))
    )
      candidates.add(row.teamId);
  }
  if (candidates.size > LIMIT) exhausted();
  const teams: AgendaTeam[] = [];
  for (const teamId of [...candidates].sort()) {
    const team = (await tx.get(db.doc(`teams/${teamId}`))).data();
    if (!team || team.schemaVersion !== 2) {
      setupRequired = true;
      continue;
    }
    try {
      const parents = await hierarchy(
        tx,
        team.orgId,
        team.programId,
        team.seasonId,
        team.divisionId,
        false,
      );
      if (
        parents.org.features?.households !== true ||
        parents.org.features?.organizationV2 !== true
      )
        continue;
      const participants = (labels.get(teamId) ?? [])
        .filter((p) => p.orgId === team.orgId)
        .sort((a, b) => a.participantId.localeCompare(b.participantId));
      const member = memberships
        .find((m) => m.id === `${teamId}_${uid}`)
        ?.data();
      const coach =
        member?.orgId === team.orgId &&
        member?.status === "active" &&
        member?.roles?.some((r: string) => ["coach", "captain"].includes(r));
      if (!participants.length && !staffTeams.has(teamId) && !coach) continue;
      teams.push({
        id: teamId,
        orgId: team.orgId,
        organizationName: parents.org.name,
        name: team.name,
        seasonId: team.seasonId,
        seasonName: parents.season.name,
        seasonStatus: parents.season.status,
        archived: [
          team,
          parents.org,
          parents.program,
          parents.season,
          parents.division,
        ].some((p) => p?.status === "archived"),
        participants,
      });
    } catch (error) {
      if (!permissionError(error)) throw error;
    }
  }
  if (options.events === false) return { teams, setupRequired };
  const accessVersion = hash(teams);
  const { cursor: ignored, ...parameters } = payload;
  const fingerprint = hash({ uid, parameters, accessVersion });
  let after: { time: Timestamp; id: string } | null = null;
  if (payload.cursor) {
    let decoded: Data;
    try {
      decoded = object(
        JSON.parse(Buffer.from(payload.cursor, "base64url").toString("utf8")),
      );
      keys(decoded, ["fingerprint", "seconds", "nanoseconds", "id"]);
    } catch {
      invalid("Invalid cursor.");
    }
    if (decoded!.fingerprint !== fingerprint)
      throw new HttpsError(
        "failed-precondition",
        "Agenda access or filters changed. Reload your household.",
        { domainCode: "AGENDA_CHANGED" },
      );
    if (
      !Number.isSafeInteger(decoded!.seconds) ||
      !Number.isSafeInteger(decoded!.nanoseconds) ||
      decoded!.nanoseconds < 0 ||
      decoded!.nanoseconds >= 1e9
    )
      invalid("Invalid cursor time.");
    try {
      after = {
        time: new Timestamp(decoded!.seconds, decoded!.nanoseconds),
        id: id(decoded!.id, "cursor eventId"),
      };
    } catch {
      invalid("Invalid cursor boundary.");
    }
    if (
      after!.time.toMillis() < Date.parse(payload.from) ||
      after!.time.toMillis() >= Date.parse(payload.to)
    )
      invalid("Invalid cursor boundary.");
  }
  const selected = teams.filter(
    (team) =>
      (payload.includeArchived ||
        (!team.archived && team.seasonStatus === "active")) &&
      (!payload.teamIds.length || payload.teamIds.includes(team.id)) &&
      (!payload.orgIds.length || payload.orgIds.includes(team.orgId)) &&
      (!payload.seasonRefs.length ||
        payload.seasonRefs.some(
          (s: Data) => s.orgId === team.orgId && s.seasonId === team.seasonId,
        )) &&
      (!payload.participantRefs.length ||
        team.participants.some((p) =>
          payload.participantRefs.some(
            (r: Data) =>
              r.orgId === p.orgId && r.participantId === p.participantId,
          ),
        )),
  );
  const events = new Map<string, AgendaEvent>();
  const times = new Map<string, Timestamp>();
  let totalScanned = 0;
  // Sequential queries bound concurrency and fanout. Each stream contributes pageSize + 1 valid rows.
  for (const team of selected) {
    let query = db
      .collection("events")
      .where("orgId", "==", team.orgId)
      .where("teamIds", "array-contains", team.id)
      .where("deletedAt", "==", null)
      .where("publicationState", "==", "published")
      .where("status", "==", "scheduled")
      .where("startsAt", ">=", Timestamp.fromDate(new Date(payload.from)))
      .where("startsAt", "<", Timestamp.fromDate(new Date(payload.to)))
      .orderBy("startsAt")
      .orderBy(FieldPath.documentId());
    if (after) query = query.startAfter(after.time, after.id);
    let scanned = 0,
      valid = 0;
    while (valid <= payload.pageSize) {
      const rows = await tx.get(query.limit(payload.pageSize + 1));
      for (const doc of rows.docs) {
        if (++scanned > 500 || ++totalScanned > 5000) exhausted();
        const event = doc.data();
        if (
          event.schemaVersion !== 2 ||
          event.publicationOperationId !== null ||
          event.seasonId !== team.seasonId ||
          !Array.isArray(event.teamIds) ||
          event.teamId !== event.teamIds[0] ||
          !["practice", "match"].includes(event.type) ||
          (payload.eventTypes.length &&
            !payload.eventTypes.includes(event.type))
        )
          continue;
        if (
          !(event.startsAt instanceof Timestamp) ||
          !(event.endsAt instanceof Timestamp) ||
          event.endsAt.toMillis() <= event.startsAt.toMillis() ||
          typeof event.timeZone !== "string" ||
          !event.timeZone ||
          typeof event.title !== "string" ||
          !event.title.trim()
        ) {
          setupRequired = true;
          continue;
        }
        try {
          new Intl.DateTimeFormat("en", { timeZone: event.timeZone });
        } catch {
          setupRequired = true;
          continue;
        }
        // Validate every parent reference without returning opponents' or unrelated teams' data.
        if (
          !event.teamIds.length ||
          event.teamIds.length > 20 ||
          new Set(event.teamIds).size !== event.teamIds.length
        )
          continue;
        const parents = await tx.getAll(
          ...event.teamIds.map((value: unknown) =>
            db.doc(`teams/${id(value, "stored teamId")}`),
          ),
        );
        if (
          parents.some(
            (p) =>
              p.data()?.schemaVersion !== 2 ||
              p.data()?.orgId !== team.orgId ||
              p.data()?.programId !== event.programId ||
              p.data()?.seasonId !== event.seasonId ||
              (event.divisionId !== null &&
                p.data()?.divisionId !== event.divisionId),
          )
        )
          continue;
        const relevantTeams = selected.filter(
          (t) =>
            event.teamIds.includes(t.id) &&
            t.orgId === team.orgId &&
            t.seasonId === event.seasonId,
        );
        const participants = [
          ...new Map(
            relevantTeams
              .flatMap((t) => t.participants)
              .filter(
                (p) =>
                  !payload.participantRefs.length ||
                  payload.participantRefs.some(
                    (r: Data) =>
                      r.orgId === p.orgId &&
                      r.participantId === p.participantId,
                  ),
              )
              .map((p) => [`${p.orgId}/${p.participantId}`, p]),
          ).values(),
        ];
        times.set(doc.id, event.startsAt);
        events.set(doc.id, {
          id: doc.id,
          orgId: team.orgId,
          title: event.title,
          type: event.type,
          startsAt: event.startsAt.toDate().toISOString(),
          endsAt: event.endsAt.toDate().toISOString(),
          timeZone: event.timeZone,
          revision: event.revision ?? 0,
          updatedAt:
            event.updatedAt instanceof Timestamp
              ? event.updatedAt.toDate().toISOString()
              : event.startsAt.toDate().toISOString(),
          location: event.location
            ? {
                name: event.location.name,
                ...(event.location.address
                  ? { address: event.location.address }
                  : {}),
              }
            : null,
          teams: relevantTeams.map((t) => ({
            ...t,
            participants: t.participants.filter((p) =>
              participants.some(
                (label) =>
                  label.orgId === p.orgId &&
                  label.participantId === p.participantId,
              ),
            ),
          })),
          participants,
        });
        valid++;
      }
      if (rows.size < payload.pageSize + 1 || valid > payload.pageSize) break;
      query = query.startAfter(rows.docs[rows.docs.length - 1]);
    }
  }
  const ordered = [...events.values()].sort((a, b) => {
    const left = times.get(a.id)!,
      right = times.get(b.id)!;
    return (
      left.seconds - right.seconds ||
      left.nanoseconds - right.nanoseconds ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
  const items = ordered.slice(0, payload.pageSize);
  const last = items[items.length - 1];
  return {
    items,
    teams,
    setupRequired,
    accessVersion,
    nextCursor:
      ordered.length > payload.pageSize
        ? Buffer.from(
            JSON.stringify({
              fingerprint,
              seconds: times.get(last.id)!.seconds,
              nanoseconds: times.get(last.id)!.nanoseconds,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}

export const listHouseholdAgenda = readCommand(normalize, readAgenda);
