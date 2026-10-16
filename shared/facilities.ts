import type { Page } from "./admin";
export type FacilityFields = {
  name: string;
  address: string;
  timeZone: string;
  latitude: number | null;
  longitude: number | null;
  parking: string | null;
  accessibility: string | null;
  status: "active" | "inactive";
};
export type Facility = FacilityFields & { id: string; revision: number };
export type ResourceFields = {
  label: string;
  sports: string[];
  setupMinutes: number;
  cleanupMinutes: number;
  status: "active" | "inactive";
};
export type Resource = ResourceFields & { id: string; revision: number };
export type Availability = {
  id: string;
  revision: number;
  effectiveFrom: string;
  windows: { startsAt: string; endsAt: string }[];
};
type Scope = { orgId: string; facilityId: string; resourceId: string };
type Paging = { cursor?: string; pageSize?: number };
type Mutation = { requestId: string; expectedRevision: number };
export type FacilityCommands = {
  listFacilities: {
    input: { orgId: string } & Paging;
    output: Page<Facility> & { canManage: boolean };
  };
  listFacilityResources: {
    input: Omit<Scope, "resourceId"> & Paging;
    output: Page<Resource>;
  };
  saveFacility: {
    input: {
      orgId: string;
      facilityId?: string;
      fields: FacilityFields;
    } & Mutation;
    output: { facility: Facility };
  };
  saveFacilityResource: {
    input: Omit<Scope, "resourceId"> & {
      resourceId?: string;
      fields: ResourceFields;
    } & Mutation;
    output: { resource: Resource };
  };
  listResourceAvailability: {
    input: Scope & Paging;
    output: Page<Availability>;
  };
  appendResourceAvailability: {
    input: Scope &
      Mutation & { effectiveFrom: string; windows: Availability["windows"] };
    output: { revision: number };
  };
  getCanonicalEvent: {
    input: { eventId: string };
    output: {
      id: string;
      orgId: string;
      revision: number;
      title: string;
      canManage: boolean;
      facilityId?: string | null;
      resourceId?: string | null;
      location: { name: string; address?: string } | null;
    };
  };
  mutateEventSchedule: {
    input: {
      eventId: string;
      expectedRevision: number;
      requestId: string;
      action: "edit";
      patch: { facilityId: string | null; resourceId: string | null };
      reason: string;
    };
    output: { id: string; revision: number };
  };
};
