import { opaqueId } from "./contracts";
import type { Data, Parents } from "./contracts";

export type Phase3Capability =
  | "coaching.manage"
  | "competition.manage"
  | "playingTime.manage"
  | "practicePlans.manage"
  | "practiceResources.manage"
  | "reports.viewOrganization"
  | "reports.viewTeam"
  | "results.finalize"
  | "results.propose"
  | "rollover.manage"
  | "volunteers.manage";

export type Phase3Scope = {
  orgId: string;
  programId: string;
  seasonId: string;
  eventId: string;
  teamId: string;
};

export type Phase3ActorGrants = {
  organizationMemberships: {
    orgId: string;
    status: "active" | "revoked";
    roles: ("orgAdmin" | "programStaff")[];
    programIds: string[];
  }[];
  teamAssignments: {
    orgId: string;
    teamId: string;
    status: "active" | "revoked";
    roles: ("coach" | "captain")[];
  }[];
};

export class Phase3ContractError extends Error {
  constructor(
    public readonly code: "INVALID_CONTRACT" | "STALE_REVISION",
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "Phase3ContractError";
  }
}

function invalid(message: string): never {
  throw new Phase3ContractError("INVALID_CONTRACT", message);
}

function object(value: unknown, field: string): Data {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`Invalid ${field}`);
  }
  return value as Data;
}

function exactKeys(value: Data, fields: readonly string[], label: string): void {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((field, index) => field !== actual[index])
  ) {
    invalid(`Invalid ${label} fields`);
  }
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`Invalid ${field}`);
  return Number(value);
}

/** Pure transport contract. Callable handlers still derive actor and scope from canonical storage. */
export function decodePhase3Mutation(value: unknown) {
  const row = object(value, "mutation");
  exactKeys(
    row,
    ["requestId", "orgId", "resourceId", "expectedRevision", "payload"],
    "mutation",
  );
  return {
    requestId: opaqueId(row.requestId, "requestId"),
    orgId: opaqueId(row.orgId, "orgId"),
    resourceId: opaqueId(row.resourceId, "resourceId"),
    expectedRevision: revision(row.expectedRevision, "expectedRevision"),
    payload: object(row.payload, "payload"),
  };
}

export function assertExpectedRevision(
  currentRevision: unknown,
  expectedRevision: unknown,
): void {
  const current = revision(currentRevision, "currentRevision");
  const expected = revision(expectedRevision, "expectedRevision");
  if (current !== expected) {
    throw new Phase3ContractError(
      "STALE_REVISION",
      "This record changed. Reload before saving.",
      current,
    );
  }
  if (current === Number.MAX_SAFE_INTEGER) invalid("Revision is exhausted");
}

export function assertImmutablePhase3Scope(
  canonical: Phase3Scope,
  proposed: Phase3Scope,
): void {
  for (const field of [
    "orgId",
    "programId",
    "seasonId",
    "eventId",
    "teamId",
  ] as const) {
    if (
      opaqueId(canonical[field], field) !== opaqueId(proposed[field], field)
    ) {
      invalid(`Immutable ${field}`);
    }
  }
}

/** Participant identity is organization-local and never an authentication uid. */
export function decodeParticipantRef(value: unknown, expectedOrgId?: string) {
  const row = object(value, "participant reference");
  exactKeys(row, ["orgId", "participantId"], "participant reference");
  const ref = {
    orgId: opaqueId(row.orgId, "orgId"),
    participantId: opaqueId(row.participantId, "participantId"),
  };
  if (expectedOrgId !== undefined && ref.orgId !== opaqueId(expectedOrgId, "orgId")) {
    invalid("Participant organization mismatch");
  }
  return ref;
}

function sameCompetitionScope(event: Data, team: Parents): boolean {
  return (
    team.orgId === event.orgId &&
    team.programId === event.programId &&
    team.seasonId === event.seasonId &&
    (event.divisionId === null || team.divisionId === event.divisionId)
  );
}

/** A competition result references the two explicit sides of one canonical match event. */
export function decodeCompetitionSides(
  event: Data,
  teams: Record<string, Parents>,
) {
  if (event.type !== "match" || !Array.isArray(event.teamIds) || event.teamIds.length !== 2) {
    invalid("Competition events require exactly two teams");
  }
  const teamIds = event.teamIds.map((teamId) => opaqueId(teamId, "teamId"));
  if (new Set(teamIds).size !== 2 || event.teamId !== teamIds[0]) {
    invalid("Invalid canonical team identity");
  }
  const homeTeamId = opaqueId(event.homeTeamId, "homeTeamId");
  const awayTeamId = opaqueId(event.awayTeamId, "awayTeamId");
  if (
    homeTeamId !== teamIds[0] ||
    awayTeamId !== teamIds[1] ||
    homeTeamId === awayTeamId
  ) {
    invalid("Invalid competition sides");
  }
  for (const teamId of teamIds) {
    if (!Object.hasOwn(teams, teamId) || !sameCompetitionScope(event, teams[teamId])) {
      invalid("Competition team scope mismatch");
    }
  }
  return { home: { teamId: homeTeamId }, away: { teamId: awayTeamId } };
}

/**
 * Pure named-capability resolver. Inputs must be canonical live grants loaded by the server.
 * Platform roles, navigation projections and guardian relationships are intentionally absent.
 */
export function resolvePhase3Capabilities(
  scope: { orgId: string; programId: string; teamId?: string },
  grants: Phase3ActorGrants,
): Phase3Capability[] {
  const orgId = opaqueId(scope.orgId, "orgId");
  const programId = opaqueId(scope.programId, "programId");
  const teamId = scope.teamId === undefined ? undefined : opaqueId(scope.teamId, "teamId");
  const result = new Set<Phase3Capability>();
  for (const membership of grants.organizationMemberships) {
    if (membership.status !== "active" || membership.orgId !== orgId) continue;
    const admin = membership.roles.includes("orgAdmin");
    const programStaff =
      membership.roles.includes("programStaff") && membership.programIds.includes(programId);
    if (!admin && !programStaff) continue;
    result.add("competition.manage");
    result.add("results.finalize");
    result.add("reports.viewOrganization");
    result.add("practiceResources.manage");
    if (admin) result.add("rollover.manage");
  }
  if (teamId !== undefined) {
    for (const assignment of grants.teamAssignments) {
      if (
        assignment.status !== "active" ||
        assignment.orgId !== orgId ||
        assignment.teamId !== teamId ||
        !assignment.roles.includes("coach")
      ) {
        continue;
      }
      result.add("coaching.manage");
      result.add("playingTime.manage");
      result.add("practicePlans.manage");
      result.add("reports.viewTeam");
      result.add("results.propose");
      result.add("volunteers.manage");
    }
  }
  return [...result].sort();
}
