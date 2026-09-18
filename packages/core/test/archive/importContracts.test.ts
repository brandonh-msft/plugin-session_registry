import { describe, expect, it } from "vitest";
import {
  ImportCoordinator,
  createImportHandle,
  type SliceOutcome,
} from "../../src/archive/importContracts.js";
import {
  IMPORT_ERROR_CODES,
  ImportError,
  importErrorDefinition,
} from "../../src/archive/importErrors.js";

const handle = createImportHandle("opaque-1", "a".repeat(64), 123, "/private/import-1");

describe("import contracts", () => {
  it("defines distinct actionable errors for every taxonomy class", () => {
    const definitions = IMPORT_ERROR_CODES.map(importErrorDefinition);
    expect(new Set(definitions.map(({ code }) => code)).size).toBe(definitions.length);
    expect(definitions.every(({ remediation }) => remediation.trim().length > 0)).toBe(true);
    const error = new ImportError("IMPORT_HASH_MISMATCH", "content differs");
    expect(error.name).toBe("ImportError");
    expect(error.code).toBe("IMPORT_HASH_MISMATCH");
    expect(error.remediation).toContain("Re-download");
    expect(error.message).toContain("IMPORT_HASH_MISMATCH");
  });

  it("rejects a second import while the first is pending or ready", () => {
    const coordinator = new ImportCoordinator();
    coordinator.beginImport(handle);
    expect(() => coordinator.beginImport(createImportHandle("opaque-2", "b".repeat(64), 1, "/private/import-2")))
      .toThrowError(expect.objectContaining({ code: "IMPORT_ALREADY_ACTIVE" }));
    coordinator.markReady(handle);
    expect(() => coordinator.beginImport(createImportHandle("opaque-2", "b".repeat(64), 1, "/private/import-2")))
      .toThrowError(expect.objectContaining({ code: "IMPORT_ALREADY_ACTIVE" }));
  });

  it("distinguishes unknown, stale, and closed handles", async () => {
    const coordinator = new ImportCoordinator();
    const unknown = createImportHandle("unknown", "c".repeat(64), 1, "/private/unknown");
    expect(() => coordinator.session(unknown)).toThrowError(expect.objectContaining({ code: "IMPORT_HANDLE_UNKNOWN" }));

    coordinator.beginImport(handle);
    const stale = createImportHandle(handle.id, "b".repeat(64), handle.byteLength, handle.workspacePath);
    expect(() => coordinator.markReady(stale)).toThrowError(expect.objectContaining({ code: "IMPORT_HANDLE_STALE" }));
    coordinator.markReady(handle);
    await coordinator.closeImport(handle);
    await expect(coordinator.read(handle, () => "unreachable"))
      .rejects.toThrowError(expect.objectContaining({ code: "IMPORT_CLOSED" }));
    await expect(coordinator.read(createImportHandle("old", "a".repeat(64), 123, "/private/import-1"), () => "unreachable"))
      .rejects.toThrowError(expect.objectContaining({ code: "IMPORT_HANDLE_UNKNOWN" }));
  });

  it("waits for an in-flight read before releasing the workspace", async () => {
    const coordinator = new ImportCoordinator();
    coordinator.beginImport(handle);
    coordinator.markReady(handle);
    let finishRead!: () => void;
    const readFinished = new Promise<void>((resolve) => { finishRead = resolve; });
    let released = false;
    const read = coordinator.read(handle, async () => {
      await readFinished;
      return "read";
    });
    const close = coordinator.closeImport(handle, () => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    finishRead();
    await expect(read).resolves.toBe("read");
    await expect(close).resolves.toMatchObject({ lifecycle: "closed" });
    expect(released).toBe(true);
  });

  it("retries workspace release after a failed close instead of wedging future imports", async () => {
    const coordinator = new ImportCoordinator();
    coordinator.beginImport(handle);
    coordinator.markReady(handle);
    let attempts = 0;
    const release = () => {
      attempts++;
      if (attempts === 1) throw new Error("cleanup failed");
    };

    await expect(coordinator.closeImport(handle, release)).rejects.toThrow("cleanup failed");
    expect(() => coordinator.beginImport(createImportHandle("opaque-2", "b".repeat(64), 1, "/private/import-2")))
      .toThrowError(expect.objectContaining({ code: "IMPORT_ALREADY_ACTIVE" }));

    await expect(coordinator.closeImport(handle, release)).resolves.toMatchObject({ lifecycle: "closed" });
    expect(() => coordinator.beginImport(createImportHandle("opaque-2", "b".repeat(64), 1, "/private/import-2")))
      .not.toThrow();
  });

  it("keeps slice outcomes discriminated and excludes semantic judgments", () => {
    const outcomes: SliceOutcome[] = [
      {
        outcome: "found",
        content: "record",
        inspection: { selection: { path: "events.jsonl", start: 0, end: 1 }, bytesInspected: 6, recordsInspected: 1, complete: true },
      },
      {
        outcome: "not-found",
        reason: "No matching record",
        inspection: { selection: { path: "events.jsonl" }, bytesInspected: 0, recordsInspected: 0, complete: true },
      },
      {
        outcome: "partial-with-boundary",
        content: "prefix",
        boundary: { stoppingPoint: "record 10", reason: "per-read output cap" },
        inspection: { selection: { path: "events.jsonl" }, bytesInspected: 100, recordsInspected: 10, complete: false },
      },
      {
        outcome: "read-failure",
        error: { code: "IMPORT_INPUT_FAILURE", message: "read failed" },
      },
    ];
    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "found", "not-found", "partial-with-boundary", "read-failure",
    ]);
    expect("not-answerable-from-bundle" in outcomes[0]!).toBe(false);
  });

  it("uses a Map for bundle-derived entry names", () => {
    const entries = new Map<string, string>([["__proto__", "safe"]]);
    expect(entries.get("__proto__")).toBe("safe");
    expect(Object.getPrototypeOf(entries)).toBe(Map.prototype);
  });
});
