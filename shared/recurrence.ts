export type SeriesFields = {
  title: string;
  startsOn: string;
  endsOn: string;
  weekdays: number[];
  localTime: string;
  timeZone: string;
  durationMinutes: number;
  exclusions: string[];
  offsets: Record<string, number>;
  facilityId: string | null;
  resourceId: string | null;
};
export type Occurrence = {
  id: string;
  localDate: string;
  localTime: string;
  startsAt: string | null;
  endsAt: string | null;
  offsetMinutes: number | null;
  choices: { startsAt: string; offsetMinutes: number }[];
  issue: string | null;
};
export type RecurrenceInput = {
  orgId: string;
  teamId: string;
  seriesId: string;
  expectedRevision: number;
  fields: SeriesFields;
};
export type RecurrencePreview = {
  occurrences: Occurrence[];
  diagnostics: { occurrenceId: string; message: string }[];
  previewHash: string;
};
export type RecurrenceDraft = Omit<
  RecurrenceInput,
  "orgId" | "expectedRevision"
> &
  Omit<RecurrencePreview, "previewHash"> & {
    revision: number;
    state: "reviewedDraft";
  };
export type RecurrenceCommands = {
  previewRecurrenceDraft: { input: RecurrenceInput; output: RecurrencePreview };
  saveRecurrenceDraft: {
    input: RecurrenceInput & {
      requestId: string;
      previewHash: string;
      reviewed: true;
    };
    output: Pick<
      RecurrenceDraft,
      "seriesId" | "revision" | "occurrences" | "diagnostics"
    >;
  };
  getRecurrenceDraft: {
    input: { orgId: string; seriesId: string };
    output: RecurrenceDraft;
  };
};
