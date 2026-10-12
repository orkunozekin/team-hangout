import type {
  HierarchyKind,
  HierarchyPageInput,
  SaveHierarchyEntityInput,
} from "./contracts";

/** Callable JSON only. No browser, native or Firebase runtime dependencies. */
export type AdminSection =
  | "program"
  | "season"
  | "division"
  | "team"
  | "staff"
  | "organization";
export type AdminEntity = {
  id: string;
  name: string;
  revision: number;
  status: string;
  programId?: string;
  seasonId?: string;
  divisionId?: string;
  kind?: "municipal" | "communityCenter" | "club";
  timeZone?: string;
  sportCode?: string;
  sportLabel?: string | null;
  ageBandLabel?: string | null;
  startsOn?: string;
  endsOn?: string;
};
export type StaffAssignment = {
  id: string;
  revision: number;
  roles: ("orgAdmin" | "programStaff")[];
  programIds: string[];
  status: "active" | "revoked";
};
export type OrganizationLink = Pick<AdminEntity, "id" | "name" | "status"> & {
  roles: string[];
  programIds: string[];
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type AdminWorkspace = {
  organization: AdminEntity;
  admin: boolean;
  programIds: string[];
};
export type StaffInput = Omit<StaffAssignment, "id" | "revision"> & {
  orgId: string;
  userId: string;
  expectedRevision: number;
  requestId: string;
};
export type TeamInput = {
  orgId: string;
  teamId?: string;
  expectedRevision: number;
  requestId: string;
  fields: {
    name: string;
    programId: string;
    seasonId: string;
    divisionId: string;
    status: "active" | "archived";
  };
};
export type AdminCommands = {
  listMyOrganizations: {
    input: { cursor?: string; pageSize?: number };
    output: Page<OrganizationLink>;
  };
  getAdminWorkspace: { input: { orgId: string }; output: AdminWorkspace };
  listOrganizationHierarchy: {
    input: HierarchyPageInput;
    output: Page<AdminEntity>;
  };
  listOrganizationStaff: {
    input: { orgId: string; cursor?: string; pageSize?: number };
    output: Page<StaffAssignment>;
  };
  createOrganization: {
    input: {
      requestId: string;
      name: string;
      kind: "municipal" | "communityCenter" | "club";
      timeZone: string;
    };
    output: { organization: AdminEntity };
  };
  saveHierarchyEntity: {
    input: { [K in HierarchyKind]: SaveHierarchyEntityInput<K> }[HierarchyKind];
    output: { entity: AdminEntity };
  };
  saveTeam: { input: TeamInput; output: { team: AdminEntity } };
  setStaffAssignment: {
    input: StaffInput;
    output: { member: StaffAssignment };
  };
  archiveSeason: {
    input: {
      orgId: string;
      seasonId: string;
      status: "draft" | "active" | "archived";
      expectedRevision: number;
      requestId: string;
    };
    output: { season: AdminEntity };
  };
};
