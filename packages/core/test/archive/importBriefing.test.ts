import { describe, expect, it } from "vitest";
import { buildImportBriefing } from "../../src/archive/importBriefing.js";

const base = {
  harness: { name: "codex-cli" as const, version: "0.114.0" },
  capturedAt: "2026-09-10T20:00:00.000Z",
  files: [{ path: "events/main.jsonl", kind: "events" as const, recordCount: 3, bytes: 300 }],
  inventory: [{ category: "tool calls", count: 1 }],
  disclosures: ["owner redacted one field"],
  malformedRecords: 0,
  queryable: true,
};

describe("buildImportBriefing", () => {
  it("always renders manifest identity, imported facts, inventory, and unavailable fields", () => {
    const result = buildImportBriefing({ ...base, objective: "Fix the fixture", outcome: "passed" });
    expect(result.header).toEqual({ harness: "codex-cli", version: "0.114.0", capturedAt: base.capturedAt });
    expect(result.objective).toEqual({ status: "imported", value: "Fix the fixture" });
    expect(result.keyDecisions).toEqual({ status: "unavailable" });
    expect(result.unavailableFields).toContain("keyDecisions");
    expect(result.text).toContain("source-reported: owner redacted one field");
    expect(result.text).toContain("tool calls: 1 imported record(s)");
  });

  it("adds a mismatch notice only for a cross-harness import", () => {
    expect(buildImportBriefing({ ...base, importingHarness: "claude-code" }).reducedFidelityNotice).toContain("Reduced fidelity");
    expect(buildImportBriefing({ ...base, importingHarness: "codex-cli" }).reducedFidelityNotice).toBeUndefined();
  });

  it("returns a successful thin briefing for empty content", () => {
    const result = buildImportBriefing({ ...base, inventory: [], queryable: false });
    expect(result.thin).toBe(true);
    expect(result.queryable).toBe(false);
    expect(result.text).toContain("no readable event records");
  });
});
