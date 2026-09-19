import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_CLI_HARNESSES, PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT } from "@session-registry/core";
import { captureDigest, createNativeCaptureService, nativeCaptureOptions } from "../../src/native/captures.js";
import { acknowledgeFixtureWarnings, nativeFixture, nativeRecords, SESSION_ID, writeRecords } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("native session capture", () => {
  it.each(NATIVE_CLI_HARNESSES)("preserves every record and field from %s without using model-written history", async (harness) => {
    const fixture = await nativeFixture(harness);
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness, harnessSessionId: SESSION_ID });
    const captured = await service.load(prepared.captureId);

    expect(prepared.recordCount).toBe(fixture.records.length);
    expect(prepared.findings.filter((finding) => !finding.manualReview)).toEqual([]);
    expect(prepared.findings).toContainEqual(expect.objectContaining({ category: "unscannable-native-bundle", manualReview: true }));
    expect(prepared.reviewState).toBe("needs-review");
    expect(captured.archive.files[0]?.content.trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual(fixture.records);
    expect(captured.content).toContain("STDERR_SENTINEL");
    expect(captured.content).toContain("PRESERVE_UNKNOWN");
    expect(captured.archive.resumable).toBe(false);
    expect(prepared.nativeBundle).toBe(true);
    expect(captured.archive.restoration?.status).toBe("not-verified");
    expect(captured.archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
    expect(await readFile(prepared.reviewPath, "utf8")).toBe(captured.content);
  });

  it("keeps a captured boundary stable after more events are appended and across service restarts", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const before = await service.load(prepared.captureId);
    await appendFile(fixture.primary, JSON.stringify({
      type: "assistant.message", id: "new-event", timestamp: "2026-09-10T21:00:00Z", parentId: "event-6", data: { content: "LATER_EVENT" },
    }) + "\n");

    const restarted = createNativeCaptureService(fixture.options);
    expect(await restarted.load(prepared.captureId)).toEqual(before);
    const next = await restarted.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    expect(next.captureId).not.toBe(prepared.captureId);
    expect((await restarted.load(next.captureId)).content).toContain("LATER_EVENT");
  });

  it("keeps lossless V2 captures available for exact retries without adding new metadata", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const { capture: _capture, restoration: _restoration, ...source } = (await service.load(prepared.captureId)).archive;
    const previous = { ...source, format: PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT, resumable: true };
    const content = JSON.stringify(previous);
    const id = captureDigest(content);
    await writeFile(join(fixture.options.captureDirectory, `${id}.json`), content);
    expect((await service.load(id)).content).toBe(content);
    const reviewed = await service.review(id, [], { title: "Previous capture", summary: "Retry the original approved variant" });
    expect(reviewed.content).toBe(content);
    expect(reviewed.archive).not.toHaveProperty("restoration");
  });

  it.each([
    {
      name: "a diagnostic event referencing an unpersisted parent after resume",
      tail: [
        { type: "session.resume", id: "resume-1", parentId: "event-6", timestamp: "2026-09-11T01:12:50Z", data: {} },
        { type: "model.turn_started", id: "turn-1", parentId: null, timestamp: "2026-09-11T01:12:53Z", data: { turn: 1 } },
        { type: "model.model_call_started", id: "call-1", parentId: "not-in-this-journal", timestamp: "2026-09-11T01:12:53Z", data: { turn: 1 } },
        { type: "model.model_call_success", id: "success-1", parentId: "call-1", timestamp: "2026-09-11T01:12:54Z", data: { result: "complete" } },
      ],
    },
    {
      name: "repeated native event IDs without dropping either record",
      tail: [
        { type: "session.info", id: "repeated", parentId: "event-6", timestamp: "2026-09-11T01:12:53Z", data: { message: "first occurrence" } },
        { type: "session.info", id: "repeated", parentId: "repeated", timestamp: "2026-09-11T01:12:54Z", data: { message: "second occurrence" } },
      ],
    },
    {
      name: "a forward parent reference without reordering the file",
      tail: [
        { type: "model.message", id: "child", parentId: "later-parent", timestamp: "2026-09-11T01:12:54Z", data: {} },
        { type: "model.response", id: "later-parent", parentId: "event-6", timestamp: "2026-09-11T01:12:53Z", data: {} },
      ],
    },
    {
      name: "a diagnostic record with optional event metadata absent",
      tail: [{ type: "model.diagnostic", data: { message: "source record remains intact" } }],
    },
  ])("preserves $name", async ({ tail }) => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const records = [...fixture.records, ...tail];
    const bytes = records.map((record) => JSON.stringify(record)).join("\r\n") + "\r\n";
    await writeFile(fixture.primary, bytes);
    const service = createNativeCaptureService(fixture.options);
    const capture = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const approved = await service.review(capture.captureId, acknowledgeFixtureWarnings(capture.findings), { title: "Native journal", summary: "Exact persisted records." });
    expect(capture.recordCount).toBe(records.length);
    expect(capture.findings.filter((finding) => !finding.manualReview)).toEqual([]);
    expect(approved.archive.files[0]?.content).toBe(bytes);
    expect(approved.archive.files[0]?.recordCount).toBe(records.length);
    expect(approved.archive.redactions).toEqual([]);
    expect(await readFile(fixture.primary, "utf8")).toBe(bytes);
  });

  it("preserves Copilot 1.0.84 diagnostic model traces and context without imposing category exclusions", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const common = {
      model: "fixture-model", turn: 1, timestampMs: 1_788_976_800_000,
      modelInfo: { id: "fixture-model", vendor: "fixture-vendor", capabilities: { supports: { tools: true } } },
    };
    const traceData = [
      { kind: "turn_started", ...common },
      { kind: "model_call_started", ...common },
      { kind: "captured_assignment_context", assignmentContext: { content: "PRIVATE_ASSIGNMENT_CONTEXT" } },
      {
        kind: "model_call_failure", turn: 1, callId: "call-1", modelCallDurationMs: 25,
        reasoningEffort: "high", modelCall: { context: "PRIVATE_MODEL_CALL" },
        rte: { context: "PRIVATE_RUNTIME_TRACE" }, requestMessages: ["PRIVATE_REQUEST_MESSAGES"],
      },
      { kind: "turn_failed", ...common, error: "Request timed out" },
      { kind: "turn_ended", ...common },
    ];
    const records = [
      { ...fixture.records[0], data: { sessionId: SESSION_ID, version: 1, copilotVersion: "1.0.84-4" } },
      ...fixture.records.slice(1),
      ...traceData.map((data, index) => ({
        type: `model.${data.kind}`, id: `trace-${index}`,
        parentId: index === 0 ? "event-6" : `trace-${index - 1}`,
        timestamp: "2026-09-10T20:00:00Z", agentId: "fixture-agent", ephemeral: false, data,
      })),
    ];
    await writeRecords(fixture.primary, records);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const { archive, content } = await service.load(prepared.captureId);
    const captured = archive.files[0]!.content.trim().split("\n").map((line) => JSON.parse(line));
    expect(prepared.recordCount).toBe(records.length);
    expect(captured.map((record) => record.type)).toEqual(records.map((record) => "type" in record ? record.type : undefined));
    expect(archive.files[0]!.content).toBe(await readFile(fixture.primary, "utf8"));
    expect(content).toContain("PRIVATE_ASSIGNMENT_CONTEXT");
    expect(captured.find((record) => record.type === "model.turn_started").data).toEqual(traceData[0]);
    expect(captured.find((record) => record.type === "model.captured_assignment_context")).toMatchObject({
      agentId: "fixture-agent", ephemeral: false, data: traceData[2],
    });
    expect(captured.find((record) => record.type === "model.model_call_failure").data).toMatchObject({
      callId: "call-1", modelCallDurationMs: 25, reasoningEffort: "high",
      modelCall: { context: "PRIVATE_MODEL_CALL" }, rte: { context: "PRIVATE_RUNTIME_TRACE" },
      requestMessages: ["PRIVATE_REQUEST_MESSAGES"],
    });
    expect(captured.find((record) => record.type === "model.turn_failed").data.error).toBe("Request timed out");
    expect(prepared.findings.filter((finding) => !finding.manualReview)).toEqual([]);
  });

  it("captures Claude sidechain records and externalized output within the selected session directory", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const directory = join(dirname(fixture.primary), SESSION_ID);
    await writeRecords(join(directory, "subagents", "agent-worker.jsonl"), nativeRecords("claude-code"));
    await mkdir(join(directory, "tool-results"), { recursive: true });
    const output = join(directory, "tool-results", "tool-1.txt");
    await writeFile(output, "COMPLETE_EXTERNAL_OUTPUT\n");
    const records = [...fixture.records, {
      type: "user", sessionId: SESSION_ID, version: "2.1.0", timestamp: "2026-09-10T21:00:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-2", content: `Full output saved to: ${output}` }] },
      toolUseResult: { persistedOutputPath: output },
    }];
    await writeRecords(fixture.primary, records);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "claude-code", harnessSessionId: SESSION_ID });
    const { archive } = await service.load(prepared.captureId);
    expect(archive.files).toHaveLength(3);
    expect(archive.files.find((file) => file.kind === "attachment")?.content).toBe("COMPLETE_EXTERNAL_OUTPUT\n");
    expect(prepared.recordCount).toBe(records.length + fixture.records.length);
  });

  it("retains the owner-only original and changes only explicitly approved security findings", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    const token = `ghp_${"X".repeat(36)}`;
    await writeRecords(fixture.primary, [...fixture.records,
      { type: "response_item", timestamp: "2026-09-10T21:00:00Z", payload: { type: "message", role: "developer", content: "PRIVATE_INSTRUCTIONS" } },
      { type: "response_item", timestamp: "2026-09-10T21:00:00Z", payload: { type: "function_call_output", call_id: "tool-3", output: `token: ${token}` } },
      { type: "response_item", timestamp: "2026-09-10T21:00:00Z", payload: { type: "reasoning", summary: [], encrypted_content: "PRIVATE_CONTINUATION" } },
    ]);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "codex-cli", harnessSessionId: SESSION_ID });
    const content = await readFile(prepared.reviewPath, "utf8");
    expect(prepared.findings.filter((finding) => !finding.manualReview)).toHaveLength(1);
    expect(prepared.reviewState).toBe("needs-review");
    expect(content).toContain(token);
    expect(content).toContain("PRIVATE_INSTRUCTIONS");
    expect(content).toContain("PRIVATE_CONTINUATION");
    const reviewed = await service.review(prepared.captureId, prepared.findings.map(({ id, manualReview }) => ({
      findingId: id, action: { kind: manualReview ? "acknowledge-unscanned" : "accept-redaction" },
    })), { title: "Native session", summary: "Reviewed fixture" });
    expect(reviewed.content).not.toContain(token);
    expect(reviewed.content).toContain("PRIVATE_INSTRUCTIONS");
    expect(reviewed.content).toContain("PRIVATE_CONTINUATION");
    expect(await readFile(prepared.reviewPath, "utf8")).toBe(content);
    expect((await service.load(prepared.captureId)).archive.files[0]?.recordCount).toBe(fixture.records.length + 3);
  });

  it("requires a native identity without rejecting unknown records after that identity", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "github-copilot-cli" as const, harnessSessionId: SESSION_ID };
    await writeFile(fixture.primary, "{}\n");
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeFile(fixture.primary, '{"type":');
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeRecords(fixture.primary, nativeRecords("github-copilot-cli", "different-session"));
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeFile(fixture.primary, "{bad json}\n");
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "future.unclassified", id: "event-7", parentId: "event-6", timestamp: "2026-09-10T21:00:00Z",
      data: { unknownPrivateField: "UNCLASSIFIED_SENTINEL" },
    }]);
    const prepared = await service.prepare(input);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toBe(await readFile(fixture.primary, "utf8"));
  });

  it("preserves BOM, CRLF, native numeric spelling, and a complete final record without a newline", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const content = "\uFEFF" + fixture.records.map((record) => JSON.stringify(record, null, 0)).join("\r\n") +
      '\r\n{ "type":"model.any_future_event", "id":"event-7", "parentId":"event-6", "timestamp":"2026-09-10T20:00:00Z", "data": {"number": 900719925474099312345, "decimal": 1.00000} }';
    await writeFile(fixture.primary, content, "utf8");
    const service = createNativeCaptureService(fixture.options);
    const capture = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const reviewed = await service.review(capture.captureId, acknowledgeFixtureWarnings(capture.findings), { title: "Native session", summary: "Exact source" });
    expect(Buffer.from(reviewed.archive.files[0]!.content, "utf8")).toEqual(await readFile(fixture.primary));
  });

  it("accepts Claude records without an invented mandatory version field", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const records = fixture.records.map((record) => {
      const copy: Record<string, unknown> = { ...record };
      delete copy.version;
      return copy;
    });
    await writeRecords(fixture.primary, records);
    const prepared = await createNativeCaptureService(fixture.options).prepare({
      harness: "claude-code", harnessSessionId: SESSION_ID,
    });
    expect(prepared.harness.version).toBe("not-recorded");
    expect(prepared.recordCount).toBe(records.length);
  });

  it("preserves Copilot detailed output separately from the model preview and captures shell_exit dependencies", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const output = join(dirname(fixture.primary), "files", "output.txt");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "COMPLETE_SHELL_OUTPUT\n");
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "tool.execution_complete", id: "event-7", parentId: "event-6", timestamp: "2026-09-10T21:00:00Z",
      data: {
        toolCallId: "tool-7", success: true,
        result: {
          content: "MODEL_PREVIEW",
          detailedContent: "DETAILED_UI_CONTENT",
          contents: [{ type: "shell_exit", shellId: "shell-7", exitCode: 0, outputFilePath: output, outputPreview: "MODEL_PREVIEW", outputTruncated: true }],
        },
      },
    }]);
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    const captured = await service.load(prepared.captureId);
    expect(captured.content).toContain("MODEL_PREVIEW");
    expect(captured.content).toContain("DETAILED_UI_CONTENT");
    expect(captured.content).toContain("COMPLETE_SHELL_OUTPUT");
  });

  it("rejects missing Claude child transcripts instead of publishing only the child summary", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "user", sessionId: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", content: "Child summary" }] },
      toolUseResult: { agentId: "missing-child" },
    }]);
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "claude-code", harnessSessionId: SESSION_ID,
    })).rejects.toThrow("MISSING_SUBAGENT");
  });

  it("resolves Codex child rollouts from native spawn-end relationships", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    const childId = "22222222-2222-4222-8222-222222222222";
    await writeRecords(join(dirname(fixture.primary), `rollout-2026-09-10T20-00-00-${childId}.jsonl`),
      nativeRecords("codex-cli", childId));
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "event_msg", timestamp: "2026-09-10T21:00:00Z",
      payload: { type: "collab_agent_spawn_end", call_id: "spawn-1", sender_thread_id: SESSION_ID, new_thread_id: childId },
    }]);
    const service = createNativeCaptureService(fixture.options);
    const capture = await service.prepare({ harness: "codex-cli", harnessSessionId: SESSION_ID });
    const loaded = await service.load(capture.captureId);
    expect(loaded.archive.files).toHaveLength(2);
    expect(loaded.archive.files[1]?.content).toContain(childId);
  });

  it("rejects unresolved Codex inherited history even when the local suffix is valid JSONL", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    await writeRecords(fixture.primary, [{
      type: "session_meta", timestamp: "2026-09-10T20:00:00Z",
      payload: { id: SESSION_ID, cli_version: "0.114.0", history_mode: "paginated", history_base: { thread_id: "missing-prefix" } },
    }, ...fixture.records.slice(1)]);
    await expect(createNativeCaptureService(fixture.options).prepare({
      harness: "codex-cli", harnessSessionId: SESSION_ID,
    })).rejects.toThrow("UNSUPPORTED_LINEAGE");
  });

  it.skipIf(!("zstdCompressSync" in zlib))("reads a compressed Codex rollout without sending the compressed bytes through the model", async () => {
    if (!("zstdCompressSync" in zlib) || typeof zlib.zstdCompressSync !== "function") {
      throw new Error("This case requires the built-in Zstandard compressor.");
    }
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    await writeFile(`${fixture.primary}.zst`, zlib.zstdCompressSync(await readFile(fixture.primary)));
    await rm(fixture.primary);
    const service = createNativeCaptureService(fixture.options);
    const capture = await service.prepare({ harness: "codex-cli", harnessSessionId: SESSION_ID });
    const loaded = await service.load(capture.captureId);
    expect(loaded.archive.files[0]?.path).toMatch(/\.jsonl\.zst$/);
    expect(loaded.archive.files[0]?.content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(fixture.records);
  });

  it("fails for missing output dependencies and refuses references to another session", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "claude-code" as const, harnessSessionId: SESSION_ID };
    const record = { type: "user", sessionId: SESSION_ID, toolUseResult: { persistedOutputPath: join(dirname(fixture.primary), SESSION_ID, "missing.txt") } };
    await writeRecords(fixture.primary, [...fixture.records, record]);
    await expect(service.prepare(input)).rejects.toThrow("MISSING_DEPENDENCY");
    record.toolUseResult.persistedOutputPath = join(dirname(fixture.primary), "another-session.jsonl");
    await writeRecords(fixture.primary, [...fixture.records, record]);
    await expect(service.prepare(input)).rejects.toThrow("UNSUPPORTED_DEPENDENCY");
  });

  it("batches every unauthorized reference into one actionable error naming their exact paths", async () => {
    const fixture = await nativeFixture("claude-code");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "claude-code" as const, harnessSessionId: SESSION_ID };
    const firstOutside = join(dirname(fixture.primary), "another-session-a.jsonl");
    const secondOutside = join(dirname(fixture.primary), "another-session-b.jsonl");
    await writeRecords(fixture.primary, [
      ...fixture.records,
      { type: "user", sessionId: SESSION_ID, toolUseResult: { persistedOutputPath: firstOutside } },
      { type: "user", sessionId: SESSION_ID, toolUseResult: { persistedOutputPath: secondOutside } },
    ]);
    const failure = await service.prepare(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("UNSUPPORTED_DEPENDENCY");
    expect(message).toContain("2 native output reference(s)");
    expect(message).toContain(firstOutside);
    expect(message).toContain(secondOutside);
  });

  it("preserves native output truncation and reports embedded media for explicit owner review", async () => {
    const fixture = await nativeFixture("codex-cli");
    directories.push(fixture.root);
    const service = createNativeCaptureService(fixture.options);
    const input = { harness: "codex-cli" as const, harnessSessionId: SESSION_ID };
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "response_item", timestamp: "2026-09-10T21:00:00Z",
      payload: { type: "function_call_output", call_id: "tool-4", output: "Warning: truncated output", truncated: true },
    }]);
    const truncated = await service.prepare(input);
    const loaded = await service.load(truncated.captureId);
    expect(loaded.archive.capture?.diagnostics).toContainEqual(expect.objectContaining({ code: "native-output-truncated" }));
    expect(loaded.archive.files[0]?.content).toContain("Warning: truncated output");
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "response_item", timestamp: "2026-09-10T21:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,synthetic" }] },
    }]);
    const media = await service.prepare(input);
    expect(media.reviewState).toBe("needs-review");
    expect(media.findings.length).toBeGreaterThan(0);
    await expect(service.review(media.captureId, [], { title: "Native media", summary: "Owner review required" }))
      .rejects.toThrow("SECURITY_REVIEW_REQUIRED");
  });

  it("rejects capture tampering, absent captures, and path traversal", async () => {
    const valid = await nativeFixture("github-copilot-cli");
    directories.push(valid.root);
    const service = createNativeCaptureService(valid.options);
    const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
    await writeFile(prepared.reviewPath, "{}");
    await expect(service.load(prepared.captureId)).rejects.toThrow("CAPTURE_CHANGED");
    await expect(service.load("0".repeat(64))).rejects.toThrow("CAPTURE_NOT_FOUND");
    await expect(service.load("..\\events.jsonl")).rejects.toThrow("INVALID_CAPTURE");
    await expect(service.prepare({ harness: "github-copilot-cli", harnessSessionId: ".." })).rejects.toThrow("INVALID_SESSION_ID");
  });

  it("rejects symbolic-link dependencies", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "PRIVATE_OUTSIDE_SOURCE");
    await symlink(outside, join(dirname(fixture.primary), "linked"), "junction");
    const service = createNativeCaptureService(fixture.options);
    await expect(service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID }))
      .rejects.toThrow("UNSAFE_SOURCE_PATH");
  });

  it("supports captures larger than a single MCP message, or fails explicitly at the configured limit", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const output = "z".repeat(11 * 1024 * 1024);
    await writeRecords(fixture.primary, [...fixture.records, {
      type: "tool.execution_complete", id: "big-output", timestamp: "2026-09-10T21:00:00Z",
      parentId: "event-6", data: { toolCallId: "tool-5", result: { content: output }, success: true },
    }]);
    const input = { harness: "github-copilot-cli" as const, harnessSessionId: SESSION_ID };
    const service = createNativeCaptureService(fixture.options);
    const prepared = await service.prepare(input);
    expect(prepared.bytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(JSON.stringify(prepared).length).toBeLessThan(10_000);
    expect((await service.load(prepared.captureId)).archive.files[0]?.content).toContain(output);
    const limited = createNativeCaptureService({ ...fixture.options, maxBytes: 1_024 });
    await expect(limited.prepare(input)).rejects.toThrow("SOURCE_LIMIT");
  });

  it("respects explicit homes and validates the capture byte limit", () => {
    expect(() => nativeCaptureOptions({ SESSION_REGISTRY_MAX_CAPTURE_BYTES: "-1" })).toThrow("positive safe integer");
    const options = nativeCaptureOptions({ COPILOT_HOME: "isolated-profile", SESSION_REGISTRY_COPILOT_HOME: "actual-profile" });
    expect(options.homes["github-copilot-cli"]).toMatch(/actual-profile$/);
    expect(nativeCaptureOptions({ CODEX_SQLITE_HOME: "relative-native-index" }).codexSqliteHome).toBe("relative-native-index");
  });
});
