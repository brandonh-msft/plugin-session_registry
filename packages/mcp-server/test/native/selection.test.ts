import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_CLI_HARNESSES, type NativeHarness } from "@session-registry/core";
import { createNativeCaptureService, nativeCaptureOptions } from "../../src/native/captures.js";
import { nativeFixture, nativeRecords, SESSION_ID, writeRecords } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

function withEvidence(harness: NativeHarness, cwd: string, id = SESSION_ID) {
  const records = nativeRecords(harness, id);
  if (harness === "github-copilot-cli") return [
    { type: "session.start", data: { sessionId: id, version: 1, copilotVersion: "1.0.84-4", context: { cwd } } },
    ...records.slice(1),
  ];
  if (harness === "claude-code") return records.map((record) => ({ ...record, cwd }));
  return [
    { type: "session_meta", timestamp: "2026-09-11T17:00:00Z", payload: { id, cli_version: "0.154.0", cwd } },
    ...records.slice(1),
  ];
}

describe("verified current-session selection", () => {
  it("uses Copilot's runtime-bound ID even when repeated publish prompts are ambiguous", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const otherId = "22222222-2222-4222-8222-222222222222";
    await writeRecords(fixture.primary, withEvidence("github-copilot-cli", fixture.root));
    await writeRecords(join(fixture.homes["github-copilot-cli"], "session-state", otherId, "events.jsonl"),
      withEvidence("github-copilot-cli", fixture.root, otherId));
    const service = createNativeCaptureService({ ...fixture.options, activeCopilotSessionId: SESSION_ID });
    const bound = await service.prepare({ harness: "github-copilot-cli" });
    expect(bound.harnessSessionId).toBe(SESSION_ID);
    const lookup = await service.prepare({ harness: "github-copilot-cli", workingDirectory: fixture.root, recentUserMessage: "Fix the fixture exactly." });
    expect(lookup.harnessSessionId).toBe(SESSION_ID);
    const explicit = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: otherId });
    expect(explicit.harnessSessionId).toBe(otherId);
    const missing = createNativeCaptureService({ ...fixture.options, activeCopilotSessionId: "missing-runtime-id" });
    await expect(missing.prepare({ harness: "github-copilot-cli", workingDirectory: fixture.root, recentUserMessage: "Fix the fixture exactly." })).rejects.toThrow();
  });

  it("binds the actual Copilot environment only within its producing profile", () => {
    const env = { COPILOT_HOME: "producing-profile", COPILOT_AGENT_SESSION_ID: SESSION_ID };
    expect(nativeCaptureOptions(env).activeCopilotSessionId).toBe(SESSION_ID);
    expect(nativeCaptureOptions({ ...env, SESSION_REGISTRY_COPILOT_HOME: "producing-profile" }).activeCopilotSessionId).toBe(SESSION_ID);
    expect(nativeCaptureOptions({ ...env, SESSION_REGISTRY_COPILOT_HOME: "other-profile" }).activeCopilotSessionId).toBeUndefined();
  });

  it.each(NATIVE_CLI_HARNESSES)("derives %s native identity from its actual source file", async (harness) => {
    const fixture = await nativeFixture(harness);
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness, sourcePath: fixture.primary });
    expect(prepared.harnessSessionId).toBe(SESSION_ID);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
  });

  it("validates Copilot's context session folder instead of forbidding its UUID", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const capture = await createNativeCaptureService(fixture.options).prepare({
      harness: "github-copilot-cli", sessionDirectory: dirname(fixture.primary),
    });
    expect(capture.harnessSessionId).toBe(SESSION_ID);
  });

  it.each(NATIVE_CLI_HARNESSES)("finds %s by exact native user text plus cwd, not a fabricated transcript or newest file", async (harness) => {
    const fixture = await nativeFixture(harness);
    directories.push(fixture.root);
    const cwd = join(fixture.root, "workspace");
    await writeRecords(fixture.primary, withEvidence(harness, cwd));
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness, workingDirectory: cwd, recentUserMessage: "Fix the fixture exactly." });
    expect(prepared.harnessSessionId).toBe(SESSION_ID);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
    await expect(service.prepare({ harness, workingDirectory: cwd, recentUserMessage: "fixture" })).rejects.toThrow("SESSION_NOT_FOUND");
    await expect(service.prepare({ harness, workingDirectory: join(cwd, "different"), recentUserMessage: "Fix the fixture exactly." })).rejects.toThrow("SESSION_NOT_FOUND");
  });

  it("refuses to guess between forks with the same user text and working directory", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const cwd = join(fixture.root, "workspace");
    const otherId = "22222222-2222-4222-8222-222222222222";
    await writeRecords(fixture.primary, withEvidence("github-copilot-cli", cwd));
    await writeRecords(join(fixture.homes["github-copilot-cli"], "session-state", otherId, "events.jsonl"),
      withEvidence("github-copilot-cli", cwd, otherId));
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "github-copilot-cli", workingDirectory: cwd, recentUserMessage: "Fix the fixture exactly.",
    })).rejects.toThrow("AMBIGUOUS_SESSION");
  });

  it("does not match tool arguments, assistant text or nested request context as user identity", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const cwd = join(fixture.root, "workspace");
    await writeRecords(fixture.primary, [
      ...withEvidence("github-copilot-cli", cwd).filter((record) => !("type" in record) || record.type !== "user.message"),
      { type: "assistant.message", data: { content: "Fix the fixture exactly." } },
      { type: "tool.execution_start", data: { arguments: { type: "user.message", data: { content: "Fix the fixture exactly." } } } },
    ]);
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "github-copilot-cli", workingDirectory: cwd, recentUserMessage: "Fix the fixture exactly.",
    })).rejects.toThrow("SESSION_NOT_FOUND");
  });

  it("reports actionable source context instead of requesting an owner-entered UUID", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    await expect(createNativeCaptureService(fixture.options).prepare({ harness: "github-copilot-cli" }))
      .rejects.toThrow("SOURCE_SELECTION_REQUIRED");
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "github-copilot-cli", sourcePath: fixture.primary, harnessSessionId: "different-native-id",
    })).rejects.toThrow("SESSION_ID_MISMATCH");
  });

  it("keeps a copied Claude fork filename's identity even with earlier parent IDs", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    await writeRecords(fixture.primary, nativeRecords("claude-code", "copied-parent"));
    await mkdir(join(dirname(fixture.primary), SESSION_ID), { recursive: true });
    const capture = await createNativeCaptureService(fixture.options).prepare({
      harness: "claude-code", sessionDirectory: join(dirname(fixture.primary), SESSION_ID),
    });
    expect(capture.harnessSessionId).toBe(SESSION_ID);
  });
});
