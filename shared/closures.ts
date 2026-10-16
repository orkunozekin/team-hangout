export type ClosureImpact = {
  eventId: string;
  revision: number;
  title: string;
  startsAt: string;
  endsAt: string;
  resourceId: string;
  teamIds: string[];
  teamNames: string[];
  timeZone: string;
};
export type ClosurePreview = {
  previewId: string;
  previewHash: string;
  facilityId: string;
  resourceIds: string[];
  startsAt: string;
  endsAt: string;
  reason: string;
  impacted: ClosureImpact[];
};
export type ClosureOperation = {
  operationId: string;
  closureId: string;
  revision: number;
  fencingToken: number;
  state: string;
  cursor: number;
  total: number;
  postponed: number;
  mismatches: string[];
  expiresAt: string;
  impacted: ClosureImpact[];
};
export type MakeupPatch = {
  startsAt: string;
  endsAt: string;
  timeZone: string;
  facilityId: string;
  resourceId: string;
};
export type MakeupPreview = MakeupPatch & {
  previewId: string;
  previewHash: string;
  eventId: string;
  title: string;
  teamIds: string[];
  previousStartsAt: string;
  crossOrganizationBusy: string;
};
type Confirm = {
  requestId: string;
  orgId: string;
  previewId: string;
  previewHash: string;
  confirmed: boolean;
};
export type ClosureCommands = {
  previewFacilityClosure: {
    input: {
      requestId: string;
      orgId: string;
      facilityId: string;
      resourceIds: string[] | null;
      startsAt: string;
      endsAt: string;
      reason: string;
    };
    output: ClosurePreview;
  };
  applyFacilityClosure: { input: Confirm; output: ClosureOperation };
  getFacilityClosureOperation: {
    input: { orgId: string; operationId: string };
    output: ClosureOperation;
  };
  advanceFacilityClosure: {
    input: {
      requestId: string;
      orgId: string;
      operationId: string;
      expectedRevision: number;
      fencingToken: number;
      action: "advance" | "resume";
    };
    output: ClosureOperation;
  };
  previewEventMakeup: {
    input: {
      requestId: string;
      orgId: string;
      eventId: string;
      expectedRevision: number;
      patch: MakeupPatch;
      reason: string;
    };
    output: MakeupPreview;
  };
  confirmEventMakeup: {
    input: Confirm;
    output: { id: string; revision: number };
  };
};
