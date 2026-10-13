export type ImportJob = {
  id: string;
  orgId: string;
  programId: string;
  seasonId: string;
  status: string;
  previewRevision: number;
  count: number;
  previewCheckpoint: number;
  checkpoint: number;
  unresolved: number;
  previewCreates: number;
  previewUpdates: number;
  previewSkips: number;
  created: number;
  updated: number;
  skipped: number;
  error: string | null;
  expiresAt: string;
  templateVersion: 1;
};
export type ImportRow = {
  number: number;
  fields: Record<string, string>;
  errors: string[];
  warnings: string[];
  candidates: {
    id: string;
    displayName: string;
    revision: number;
    status: string;
    kind: string;
  }[];
  resolution: "create" | "update" | "skip" | null;
  outcome: string | null;
  participantId: string;
  teamId: string | null;
};
export type ImportCommands = {
  uploadRosterImport: {
    input: {
      requestId: string;
      orgId: string;
      programId: string;
      seasonId: string;
      csvBase64: string;
      mapping: Record<string, string | null>;
      templateVersion: 1;
    };
    output: { job: ImportJob };
  };
  getRosterImport: {
    input: { orgId: string; jobId: string; offset?: number };
    output: { job: ImportJob; rows: ImportRow[]; nextOffset: number | null };
  };
  resolveRosterImportRow: {
    input: {
      requestId: string;
      orgId: string;
      jobId: string;
      number: number;
      previewRevision: number;
      resolution: "create" | "update" | "skip";
      participantId?: string;
    };
    output: { ok: boolean };
  };
  commitRosterImport: {
    input: {
      requestId: string;
      orgId: string;
      jobId: string;
      previewRevision: number;
      confirmed: true;
    };
    output: { ok: boolean };
  };
  refreshRosterImport: {
    input: { requestId: string; orgId: string; jobId: string };
    output: { ok: boolean };
  };
};
