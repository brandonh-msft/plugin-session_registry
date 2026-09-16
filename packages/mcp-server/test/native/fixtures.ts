import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NativeHarness } from "@session-registry/core";
import type { NativeCaptureOptions } from "../../src/native/captures.js";
import type { CaptureFinding, CaptureResolution } from "../../src/native/review.js";

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const TIME = "2026-09-10T20:00:00.000Z";

export function acknowledgeFixtureWarnings(findings: readonly CaptureFinding[]): CaptureResolution[] {
  return findings.filter((finding) => finding.manualReview).map(({ id }) => ({
    findingId: id, action: { kind: "acknowledge-unscanned" },
  }));
}

export function unpackNativeFixtureZip(content: Uint8Array): ReadonlyMap<string, Buffer> {
  const zip = Buffer.from(content);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    if (zip.readUInt16LE(offset + 8) !== 0) throw new Error("Expected stored native ZIP entries");
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    if (files.has(name)) throw new Error("Duplicate native ZIP fixture entry");
    files.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}

export function nativeRecords(harness: NativeHarness, id = SESSION_ID): object[] {
  if (harness === "github-copilot-cli") {
    const event = (type: string, data: object, index: number) => ({
      type, data, id: `event-${index}`, timestamp: TIME, parentId: index === 0 ? null : `event-${index - 1}`,
    });
    return [
      event("session.start", { sessionId: id, version: 1, copilotVersion: "1.0.82-1", producer: "copilot-agent", startTime: TIME }, 0),
      event("user.message", { content: "Fix the fixture exactly." }, 1),
      event("tool.execution_start", { toolCallId: "tool-1", toolName: "shell", arguments: { command: "pnpm test" } }, 2),
      event("tool.execution_complete", { toolCallId: "tool-1", success: false, result: { content: "STDERR_SENTINEL: fixture missing", exitCode: 1 } }, 3),
      event("session.compaction_complete", { summary: "A compacted context is not the source history." }, 4),
      event("assistant.message", { messageId: "message-1", content: "The corrected fixture is ready." }, 5),
      event("session.info", { infoType: "fixture", message: "PRESERVE_UNKNOWN", payload: { nested: [17, false] } }, 6),
    ];
  }
  if (harness === "claude-code") {
    const event = (type: string, message: object, index: number) => ({
      type, message, sessionId: id, version: "2.1.0", timestamp: TIME,
      uuid: `event-${index}`, parentUuid: index === 0 ? null : `event-${index - 1}`,
    });
    return [
      event("user", { role: "user", content: "Fix the fixture exactly." }, 0),
      event("assistant", { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } }] }, 1),
      event("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "STDERR_SENTINEL: fixture missing" }] }, 2),
      { type: "system", subtype: "compact_boundary", sessionId: id, timestamp: TIME, compactMetadata: { trigger: "auto" } },
      event("assistant", { role: "assistant", content: [{ type: "text", text: "The corrected fixture is ready." }] }, 4),
      { type: "progress", sessionId: id, data: { nested: ["PRESERVE_UNKNOWN", 17, false] } },
    ];
  }
  const event = (type: string, payload: object) => ({ type, payload, timestamp: TIME });
  return [
    event("session_meta", { id, cli_version: "0.114.0", originator: "codex_cli_rs", cwd: "fixture-workspace" }),
    event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the fixture exactly." }] }),
    event("response_item", { type: "function_call", call_id: "tool-1", name: "shell", arguments: '{"command":"pnpm test"}' }),
    event("response_item", { type: "function_call_output", call_id: "tool-1", output: "STDERR_SENTINEL: fixture missing" }),
    event("compacted", { message: "A compacted context is not the source history." }),
    event("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "The corrected fixture is ready." }] }),
    event("event_msg", { type: "task_complete", nested: ["PRESERVE_UNKNOWN", 17, false] }),
  ];
}

export async function writeRecords(path: string, records: readonly object[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

export async function nativeFixture(harness: NativeHarness) {
  const root = await mkdtemp(join(tmpdir(), "registry-native-test-"));
  const homes = {
    "github-copilot-cli": join(root, "copilot"),
    "claude-code": join(root, "claude"),
    "codex-cli": join(root, "codex"),
  };
  const primary = harness === "github-copilot-cli"
    ? join(homes[harness], "session-state", SESSION_ID, "events.jsonl")
    : harness === "claude-code"
      ? join(homes[harness], "projects", "fixture-project", `${SESSION_ID}.jsonl`)
      : join(homes[harness], "sessions", "2026", "09", "10", `rollout-2026-09-10T20-00-00-${SESSION_ID}.jsonl`);
  const records = nativeRecords(harness);
  await writeRecords(primary, records);
  const options: NativeCaptureOptions = {
    homes,
    captureDirectory: join(root, "captures"),
    maxBytes: 32 * 1024 * 1024,
    now: () => new Date(TIME),
  };
  return { root, homes, primary, records, options };
}
