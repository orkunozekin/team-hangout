import { cacheDocumentReads } from '../operations/reads';
import { requireOpenInterval } from '../facilities/closures';
import { publishedEvent } from '../scheduling/visibility';
import { getFirestore, Transaction } from "firebase-admin/firestore";
import { Data, id, keys } from "../commandSupport";
import { readAgenda } from "../calendar/agenda";
import { denied, hierarchy } from "../organizations/policy";
import { readCommand } from "../participants/policy";

export async function eventInformation(
  tx: Transaction,
  eventId: string,
  uid: string,
): Promise<Data> {
  tx = cacheDocumentReads(tx);
  const db = getFirestore(),
    event = (await tx.get(db.doc(`events/${eventId}`))).data();
  if (
    !event ||
    event.schemaVersion !== 2 ||
    event.publicationState !== "published" ||
    !(await publishedEvent(tx, event)) ||
    event.deletedAt != null ||
    event.status !== "scheduled" ||
    !Array.isArray(event.teamIds) ||
    !event.teamIds.length ||
    event.teamIds.length > 20 ||
    event.teamId !== event.teamIds[0]
  )
    denied();
  const access = await readAgenda(tx, {}, uid, { events: false });
  const visible = access.teams.filter(
    (t: Data) =>
      t.orgId === event.orgId &&
      t.seasonId === event.seasonId &&
      event.teamIds.includes(t.id),
  );
  if (!visible.length) denied();
  for (const teamId of event.teamIds) {
    const team = (
      await tx.get(db.doc(`teams/${id(teamId, "stored teamId")}`))
    ).data();
    if (
      !team ||
      team.schemaVersion !== 2 ||
      team.orgId !== event.orgId ||
      team.programId !== event.programId ||
      team.seasonId !== event.seasonId ||
      (event.divisionId != null && team.divisionId !== event.divisionId)
    )
      denied();
    await hierarchy(
      tx,
      event.orgId,
      event.programId,
      event.seasonId,
      team.divisionId,
      false,
    );
  }
  await requireOpenInterval(tx, event);
  return {
    id: eventId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: event.timeZone,
    revision: event.revision,
    location: event.location
      ? {
          name: event.location.name,
          ...(event.location.address
            ? { address: event.location.address }
            : {}),
        }
      : null,
    teams: visible.map((t: Data) => ({ id: t.id, name: t.name })),
  };
}
export const getPrivateEventInformation = readCommand(
  (data) => {
    keys(data, ["eventId"]);
    return { eventId: id(data.eventId, "eventId") };
  },
  (tx, data, uid) => eventInformation(tx, data.eventId, uid),
);
