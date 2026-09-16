import { createHash } from "node:crypto";
import {
  NATIVE_SESSION_ARCHIVE_FORMAT,
  PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
  inspectNativeJsonl,
  nativeFileBytes,
  nativeFileContentBytes,
  type NativeArchiveFile,
  type NativeSessionArchive,
} from "../../src/archive/nativeSessionArchive.js";

export function archiveFile(
  path: string,
  kind: NativeArchiveFile["kind"],
  content: string,
  recordCount: number,
): NativeArchiveFile {
  return { path, kind, content, recordCount, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

export function nativeArchiveFixture(): NativeSessionArchive {
  const records = [
    JSON.stringify({ type: "user.message", id: "user-1", data: { text: "Investigate failures — 日本語" }, timestamp: "2026-09-10T10:00:01Z" }),
    '{"type":"future.unknown","largeInteger":900719925474099312345,"payload":{"nested":[null,true,{"unrecognized":"<script>alert(1)</script>"}]},"vendorExtension":{"preserve":"everything"}}',
    JSON.stringify({
      type: "tool.execution_complete",
      data: {
        command: "example-tool --check",
        stdout: "partial output\nsecond line",
        stderr: "failure details\n</pre><script>alert('stderr')</script>",
        exitCode: 23,
        success: false,
        error: { code: "E_CHECK", details: ["first failure", "last failure"] },
      },
    }),
    JSON.stringify({ type: "assistant.message", data: { content: "[REDACTED:fixture-1]", reasoning: "retained persisted field" } }),
  ];
  const childRecord = JSON.stringify({
    type: "subagent.future",
    timestamp: "2026-09-10T09:59:00Z",
    payload: { childField: "separate stream", parentId: "user-1" },
  });
  return {
    format: PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
    harness: { name: "github-copilot-cli", version: "1.2.3<version>" },
    harnessSessionId: "session-<id>",
    capturedAt: "2026-09-10T10:01:00.000Z",
    sourceFormat: 'events.jsonl <format> "quoted"',
    scope: "persisted-session-records",
    resumable: false,
    files: [
      archiveFile("events/main.jsonl", "events", `${records.join("\n")}\n`, records.length),
      archiveFile("agents\\child.jsonl", "events", `${childRecord}\r\n`, 1),
      archiveFile(
        "attachments/<img onerror=alert(1)>.txt",
        "attachment",
        `\n# Literal attachment, not rendered Markdown\n<img src=x onerror=alert(1)>\n${"Full attachment text — café.\n".repeat(1000)}END OF ATTACHMENT\n`,
        0,
      ),
    ],
    redactions: [
      { id: "fixture-1", category: "credential", source: "events/main.jsonl:4" },
      { id: "fixture-2<id>", category: "<script>category</script>", source: 'attachments/<source>"' },
    ],
  };
}

export function nativeV3ArchiveFixture(files = nativeArchiveFixture().files): NativeSessionArchive {
  const previous = nativeArchiveFixture();
  return {
    ...previous,
    format: NATIVE_SESSION_ARCHIVE_FORMAT,
    files,
    capture: {
      boundary: "observed-prefixes", entrypoint: files[0]!.path,
      selection: "explicit-path", layout: "session-directory",
      sources: files.map((file) => {
        const bytes = nativeFileBytes(file);
        return {
          path: file.path, capturedBytes: bytes.length, observedBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"), snapshot: "file-prefix",
        };
      }),
      history: files.filter((file) => file.kind === "events").map((file) => ({
        path: file.path, sessionId: previous.harnessSessionId,
      })),
      diagnostics: files.filter((file) => file.kind === "events").flatMap((file) =>
        inspectNativeJsonl(nativeFileContentBytes(file)).diagnostics.map((diagnostic) => ({
          ...diagnostic, source: file.path,
        }))),
    },
    restoration: { status: "not-verified", reason: "No native activation procedure was tested." },
  };
}
