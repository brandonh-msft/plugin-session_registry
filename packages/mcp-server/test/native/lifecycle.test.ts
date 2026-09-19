import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeCaptureService } from "../../src/native/captures.js";
import { NativeCaptureError, NativeFiles } from "../../src/native/files.js";
import { acknowledgeFixtureWarnings, nativeFixture, nativeRecords, SESSION_ID, writeRecords } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Copilot and Claude lifecycle source profiles", () => {
  it("retries invalidated source generations before exposing an immutable capture", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const original = NativeFiles.prototype.assertUnchanged;
    const check = vi.spyOn(NativeFiles.prototype, "assertUnchanged")
      .mockRejectedValueOnce(new NativeCaptureError("SOURCE_CHANGED", "Simulated rewind during observation"))
      .mockImplementation(original);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    expect(check).toHaveBeenCalledTimes(2);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
  });

  it("bounds source-change retries instead of waiting indefinitely for global idle", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const check = vi.spyOn(NativeFiles.prototype, "assertUnchanged")
      .mockRejectedValue(new NativeCaptureError("SOURCE_CHANGED", "Repeated rewrite"));
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "github-copilot-cli", harnessSessionId: SESSION_ID,
    })).rejects.toThrow("SOURCE_CHANGED");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("preserves a Claude copied fork's old IDs, repeated UUIDs and missing compaction parent", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const previousId = "22222222-2222-4222-8222-222222222222";
    const records = [
      ...nativeRecords("claude-code", previousId),
      { type: "system", subtype: "compact_boundary", logicalParentUuid: "not-retained", uuid: "event-1" },
      { type: "assistant", sessionId: SESSION_ID, uuid: "event-1", parentUuid: "not-retained", message: { content: "independent fork suffix" } },
    ];
    await writeRecords(fixture.primary, records);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "claude-code", harnessSessionId: SESSION_ID });
    const reviewed = await service.review(prepared.captureId, acknowledgeFixtureWarnings(prepared.findings), { title: "Fork", summary: "Source, not a selected-message projection" });
    expect(reviewed.archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
    expect(reviewed.archive.files[0]?.recordCount).toBe(records.length);
  });

  it("requires explicit project selection for duplicate Claude IDs and records the chosen source", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const other = join(fixture.homes["claude-code"], "projects", "other-worktree", `${SESSION_ID}.jsonl`);
    await writeRecords(other, [...fixture.records, { type: "progress", data: { text: "other branch" } }]);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "claude-code" as const, harnessSessionId: SESSION_ID };
    await expect(service.prepare(input)).rejects.toThrow("AMBIGUOUS_SESSION");
    const selected = await service.prepare({ ...input, sourcePath: fixture.primary });
    const archive = (await service.load(selected.captureId)).archive;
    expect(archive.capture?.selection).toBe("explicit-path");
    expect(archive.capture?.entrypoint).toBe(`projects/fixture-project/${SESSION_ID}.jsonl`);
    expect(archive.files.map((file) => file.content).join("")).not.toContain("other branch");
  });

  it("captures Claude native JSONL path imports without substituting rendered exports", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const imported = join(fixture.root, "imported", "session.jsonl");
    await mkdir(dirname(imported));
    await copyFile(fixture.primary, imported);
    const service = createNativeCaptureService({
      ...fixture.options,
      homes: { ...fixture.homes, "claude-code": join(fixture.root, "not-created-yet") },
    });
    const input = { harness: "claude-code" as const, harnessSessionId: SESSION_ID, sourcePath: imported };
    const prepared = await service.prepare(input);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(imported, "utf8"));
    await writeFile(imported, "# Session export\n\nHuman-readable conversation, not native state.");
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it("inventories Claude nested child sidecars, checkpoints and session-scoped assets, not global state", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const home = fixture.homes["claude-code"];
    const child = join(dirname(fixture.primary), SESSION_ID, "subagents", "nested", "agent-worker.jsonl");
    await writeRecords(child, nativeRecords("claude-code", "inherited-parent-id"));
    await writeFile(child.replace(".jsonl", ".meta.json"), '{"toolUseId":"tool-1","parentAgentId":"root"}');
    for (const directory of ["file-history", "image-cache", "uploads", "tasks", "session-env"]) {
      const selected = join(home, directory, SESSION_ID, "saved.txt");
      await mkdir(dirname(selected), { recursive: true });
      await writeFile(selected, `selected ${directory}`);
      const unrelated = join(home, directory, "another-session", "saved.txt");
      await mkdir(dirname(unrelated), { recursive: true });
      await writeFile(unrelated, "UNRELATED_SESSION");
    }
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "claude-code", harnessSessionId: SESSION_ID });
    const { archive, content } = await service.load(prepared.captureId);
    expect(archive.files).toHaveLength(8);
    expect(archive.files.find((file) => file.path.endsWith("agent-worker.jsonl"))?.recordCount).toBe(fixture.records.length);
    expect(content).toContain("agent-worker.meta.json");
    expect(content).not.toContain("UNRELATED_SESSION");
  });

  it("preserves an empty Claude native file before its first prompt without inventing messages", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    await writeFile(fixture.primary, "");
    const service = createNativeCaptureService(fixture.options);
    const capture = await service.prepare({ harness: "claude-code", harnessSessionId: SESSION_ID });
    expect(capture.recordCount).toBe(0);
    expect((await service.load(capture.captureId)).archive.files[0]?.content).toBe("");
  });

  it("carries Codex ordinal diagnostics and owned artifacts through the common capture layer", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    const records = [
      { timestamp: "2026-09-10T20:00:00Z", type: "session_meta", ordinal: 0,
        payload: { id: SESSION_ID, cli_version: "0.154.0", history_mode: "paginated" } },
      { timestamp: "2026-09-10T20:00:01Z", type: "response_item", ordinal: 2,
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Retain the source gap." }] } },
      { timestamp: "2026-09-10T20:00:02Z", type: "future-native-record", ordinal: 3,
        payload: { arbitrary: "DO_NOT_DROP_UNKNOWN_RECORDS" } },
    ];
    await writeRecords(fixture.primary, records);
    const owned = join(fixture.homes["codex-cli"], "attachments", SESSION_ID, "asset.bin");
    const unrelated = join(fixture.homes["codex-cli"], "attachments", "another-thread", "other.txt");
    await mkdir(dirname(owned), { recursive: true });
    await mkdir(dirname(unrelated), { recursive: true });
    await writeFile(owned, Buffer.from([0, 1, 0xff]));
    await writeFile(unrelated, "UNRELATED_ARTIFACT");
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "codex-cli", harnessSessionId: SESSION_ID });
    const { archive, content } = await service.load(prepared.captureId);
    expect(archive.capture?.diagnostics).toContainEqual(expect.objectContaining({ code: "codex-ordinal-gap" }));
    expect(archive.capture?.diagnostics).toContainEqual(expect.objectContaining({ code: "codex-unknown-record" }));
    expect(archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
    expect(archive.files.map((file) => file.path)).toContain(`attachments/${SESSION_ID}/asset.bin`);
    expect(content).not.toContain("UNRELATED_ARTIFACT");
  });

  it("uses the Codex resolver's first decodable metadata without a second incompatible identity heuristic", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    await writeRecords(fixture.primary, [
      { type: "session_meta", timestamp: "2026-09-10T19:00:00Z", payload: { incomplete: true } },
      ...fixture.records,
    ]);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "codex-cli", harnessSessionId: SESSION_ID });
    expect(prepared.harness.version).toBe("0.114.0");
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
  });

  it("keeps Copilot crash fragments and unfamiliar envelopes separate from decoded-record diagnostics", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const original = await readFile(fixture.primary, "utf8");
    const content = original + '\n{malformed}\n{"future":"no-type"}\n{"type":"model.pending"';
    await writeFile(fixture.primary, content);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const reviewed = await service.review(prepared.captureId, acknowledgeFixtureWarnings(prepared.findings), { title: "Interrupted", summary: "All retained native bytes" });
    expect(reviewed.archive.files[0]?.content).toBe(content);
    expect(reviewed.archive.capture?.diagnostics.length).toBeGreaterThan(0);
    expect(reviewed.archive.capture?.sources[0]?.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(reviewed.archive.files[0]?.recordCount).toBe(fixture.records.length + 1);
  });

  it("captures relocated external output only through an explicit owner-authorized mapping", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const recorded = "C:\\previous-machine\\session-output\\tool-1.txt";
    const actual = join(fixture.root, "copied-output.txt");
    await writeFile(actual, "exact historical output");
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "tool.execution_complete", data: { result: {
        contents: [{ type: "shell_exit", outputFilePath: recorded, outputTruncated: true }],
      } },
    }]);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "github-copilot-cli" as const, harnessSessionId: SESSION_ID };
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_DEPENDENCY");
    const prepared = await service.prepare({
      ...input, dependencyMappings: [{ sourcePath: recorded, localPath: actual }],
    });
    const archive = (await service.load(prepared.captureId)).archive;
    expect(archive.files.find((file) => file.kind === "attachment")?.content).toBe("exact historical output");
    expect(archive.capture?.sources.find((source) => source.originalPath === recorded)?.path).toMatch(/^dependencies\//);
    expect(archive.files[0]?.content).toContain(JSON.stringify(recorded));
  });

  it("states both the resolved path and the distinct raw reference when they differ, so a retry never has to guess", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    // A relative reference resolves to something different from its raw
    // text, and (being outside the session root) is unauthorized regardless
    // of whether a file exists there.
    const reference = "../outside-session/tool-output.txt";
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "tool.execution_complete", data: { result: { contents: [{ type: "shell_exit", outputFilePath: reference }] } },
    }]);
    const service = createNativeCaptureService(fixture.options);
    let error: unknown;
    try {
      await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NativeCaptureError);
    const message = (error as NativeCaptureError).message;
    expect(message).toContain("UNSUPPORTED_DEPENDENCY");
    // The raw recorded reference must appear quoted, verbatim, distinct from
    // the resolved absolute path - this is the exact dependencyMappings
    // sourcePath key, never the resolved path shown alongside it.
    expect(message).toContain(JSON.stringify(reference));
    expect(message).toContain("dependencyMappings sourcePath");
  });

  it("retains every relocation binding when references share an already inventoried file", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const actual = join(dirname(fixture.primary), "output.txt");
    await writeFile(actual, "one physical historical output");
    const references = ["C:\\old-profile\\tool.txt", "C:\\second-profile\\tool.txt"];
    await writeRecords(fixture.primary, [...fixture.records, ...references.map((reference) => ({
      type: "tool.execution_complete", data: { result: { contents: [{ type: "shell_exit", outputFilePath: reference }] } },
    }))]);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({
      harness: "github-copilot-cli", harnessSessionId: SESSION_ID,
      dependencyMappings: references.map((sourcePath) => ({ sourcePath, localPath: actual })),
    });
    const archive = (await service.load(prepared.captureId)).archive;
    for (const reference of references) {
      const source = archive.capture?.sources.find((source) => source.originalPath === reference);
      expect(source).toBeDefined();
      expect(archive.files.find((file) => file.path === source?.path)?.content).toBe("one physical historical output");
    }
    expect(archive.files.find((file) => file.path === "output.txt")?.content).toBe("one physical historical output");
  });

  it("captures a Copilot session SQLite snapshot and warns instead of silently omitting binary state", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const database = new DatabaseSync(join(dirname(fixture.primary), "session.db"));
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE state (value TEXT);");
      database.prepare("INSERT INTO state VALUES (?)").run("session-state-in-wal");
      const service = createNativeCaptureService(fixture.options);
      const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
      expect(prepared.reviewState).toBe("needs-review");
      const archive = (await service.load(prepared.captureId)).archive;
      expect(archive.files.map((file) => file.path)).toEqual(["events.jsonl", "session.db"]);
      expect(archive.capture?.sources.find((source) => source.path === "session.db")?.snapshot).toBe("sqlite-backup");
      expect(archive.files.find((file) => file.path === "session.db")?.contentEncoding).toBe("base64");
      await expect(service.review(prepared.captureId, [], { title: "Native database", summary: "Full native state" }))
        .rejects.toThrow("SECURITY_REVIEW_REQUIRED");
    } finally {
      database.close();
    }
  });
});
