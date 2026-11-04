import type { ImportCommands } from "./imports";
export { scheduleColumns } from "./scheduleColumns";
export type ScheduleCommands = {
  uploadScheduleImport: ImportCommands["uploadRosterImport"];
  getScheduleImport: ImportCommands["getRosterImport"];
  resolveScheduleImportRow: ImportCommands["resolveRosterImportRow"];
  commitScheduleImport: ImportCommands["commitRosterImport"];
  refreshScheduleImport: ImportCommands["refreshRosterImport"];
  prepareSchedulePublication: {
    input: { orgId: string; jobId: string; numbers: number[] };
    output: {
      binding: string;
      events: {
        number: number;
        eventId: string;
        title: string;
        startsAt: string;
        endsAt: string;
        timeZone: string;
        location: { name: string; address?: string } | null;
        revision: number;
        recipientCount: number;
      }[];
      recipientCount: number;
    };
  };
  publishScheduleImport: {
    input: {
      requestId: string;
      orgId: string;
      jobId: string;
      numbers: number[];
      binding: string;
      confirmed: true;
    };
    output: { published: number; queued: number };
  };
};
