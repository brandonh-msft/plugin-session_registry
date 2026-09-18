import { describe, expect, it } from "vitest";
import { readHarnessProjection } from "../../src/import/harnessReaders.js";
import { CAPTURED_AT, harnessFixture } from "./fixtures/harnessFixtures.js";

describe("readHarnessProjection", () => {
  it.each(["github-copilot-cli", "claude-code", "codex-cli"] as const)("projects observed %s records", (harness) => {
    const result = readHarnessProjection({
      harness: { name: harness, version: harness === "codex-cli" ? "0.114.0" : "1.0.82-1" },
      capturedAt: CAPTURED_AT,
      files: harnessFixture(harness),
    });
    expect(result.header).toMatchObject({ harness, capturedAt: CAPTURED_AT });
    expect(result.queryable).toBe(true);
    expect(result.inventory.length).toBeGreaterThan(0);
    expect(result.text).toContain("Imported session orientation");
  });

  it("isolates a malformed record and discloses the omission", () => {
    const [file] = harnessFixture("codex-cli");
    const result = readHarnessProjection({
      harness: { name: "codex-cli", version: "0.114.0" },
      capturedAt: CAPTURED_AT,
      files: [{ ...file!, content: `${file!.content}{bad json}\n`, recordCount: file!.recordCount + 1 }],
    });
    expect(result.queryable).toBe(true);
    expect(result.disclosures.join(" ")).toMatch(/malformed/i);
  });

  it("keeps tool, command-output, and error categories in the compact inventory", () => {
    const [file] = harnessFixture("github-copilot-cli");
    const result = readHarnessProjection({
      harness: { name: "github-copilot-cli", version: "1.0.82-1" },
      capturedAt: CAPTURED_AT,
      files: [{
        ...file!,
        content: `${file!.content}{"type":"session.error","data":{"message":"verification failed"}}\n`,
        recordCount: file!.recordCount + 1,
      }],
      redactions: [{ id: "r1", category: "credential", source: "events/main.jsonl:1" }],
    });
    expect(result.inventory).toEqual(expect.arrayContaining([
      { category: "tool calls", count: 1 },
      { category: "command output", count: 1 },
      { category: "errors", count: 1 },
    ]));
    expect(result.disclosures.join(" ")).toContain("redaction in an imported record");
    expect(result.disclosures.join(" ")).not.toContain("events/main.jsonl");
  });

  it("rejects precision-losing numbers through the import parser", () => {
    expect(() => readHarnessProjection({
      harness: { name: "codex-cli", version: "0.114.0" },
      capturedAt: CAPTURED_AT,
      files: [{ path: "events.jsonl", kind: "events", recordCount: 1, content: '{"type":"event","n":9007199254740993}\n' }],
    })).toThrow(/unsafe JSON number/i);
  });

  it("caps deep and oversized records without exhausting memory", () => {
    const deep = `{"type":"event","value":${"[".repeat(40)}0${"]".repeat(40)}}`;
    const oversized = JSON.stringify({ type: "event", value: "x".repeat(600_000) });
    const result = readHarnessProjection({
      harness: { name: "codex-cli", version: "0.114.0" },
      capturedAt: CAPTURED_AT,
      files: [{ path: "events.jsonl", kind: "events", recordCount: 2, content: `${deep}\n${oversized}\n` }],
    });
    expect(result.queryable).toBe(false);
    expect(result.disclosures.join(" ")).toMatch(/malformed/i);
  });

  it("returns a queryable false thin result for an empty event file", () => {
    const result = readHarnessProjection({
      harness: { name: "claude-code", version: "2.1.0" },
      capturedAt: CAPTURED_AT,
      files: [{ path: "events.jsonl", kind: "events", recordCount: 0, content: "" }],
    });
    expect(result.queryable).toBe(false);
    expect(result.thin).toBe(true);
  });
});
