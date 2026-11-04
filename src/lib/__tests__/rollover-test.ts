import { notCopiedLabel, rolloverProgress } from "../../../shared/rollover";

const counts = { divisions: 2, excludedDivisions: 1, teams: 201, excludedTeams: 4 };

describe("rolloverProgress", () => {
  it("reports partial target records and the checkpoint step", () => {
    expect(rolloverProgress({ state: "running", counts, created: { divisions: 2, teams: 98 }, chunkCount: 3, completedChunks: 1 }))
      .toBe("100 of 203 records created, step 1 of 3");
  });

  it("reports a stopped job at its checkpoint", () => {
    expect(rolloverProgress({ state: "failed", counts, created: { divisions: 2, teams: 198 }, chunkCount: 3, completedChunks: 2 }))
      .toBe("200 of 203 records created, step 2 of 3");
  });

  it("reports created counts once complete", () => {
    expect(rolloverProgress({ state: "complete", counts, created: { divisions: 2, teams: 201 }, chunkCount: 3, completedChunks: 3 }))
      .toBe("201 teams and 2 divisions created");
  });
});

describe("notCopiedLabel", () => {
  it("names excluded records and falls back to the raw kind", () => {
    expect(notCopiedLabel("guardianLinks")).toBe("Guardian links");
    expect(notCopiedLabel("future")).toBe("future");
  });
});
