import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectNativeJsonl, isValidHarnessSessionId, nativeFileContentBytes, scan, type NativeSessionArchive } from "@session-registry/core";
import { captureNativeSession, type NativeHomes } from "./adapters.js";
import { isMissingFile, NativeCaptureError } from "./files.js";
import { NativeRedactor } from "./redaction.js";
import type { CopilotHostCaptureSource, NativeCaptureInput } from "./sourceTypes.js";

const HOST_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const KNOWN_COPILOT_EVENT_TYPES = new Set([
  "session.start", "session.end", "session.binary_asset", "session.compaction_start",
  "session.compaction_complete", "session.info", "session.error", "user.message",
  "assistant.message", "assistant.reasoning", "tool.execution_start", "tool.execution_complete",
  "system.message", "system.notification", "user.feedback", "subagent.start",
  "subagent.complete", "checkpoint.create", "checkpoint.restore",
]);

function validateCopilotEventGraph(native: NativeSessionArchive, harnessSessionId: string): void {
  if (native.files.some((file) => file.contentEncoding === "base64")) {
    throw new NativeCaptureError("UNSCANNABLE_SOURCE", "Native binary assets or dependencies are not supported.");
  }
  const eventsFile = native.files.find((file) => file.kind === "events");
  if (eventsFile === undefined) throw new NativeCaptureError("UNSUPPORTED_FORMAT", "Missing primary events log.");
  const inspected = inspectNativeJsonl(nativeFileContentBytes(eventsFile));
  if (inspected.diagnostics.some((diagnostic) => ["invalid-json", "invalid-utf8", "duplicate-key"].includes(diagnostic.code))) {
    throw new NativeCaptureError("MALFORMED_SOURCE", `Primary events log ${eventsFile.path} is malformed.`);
  }
  if (!eventsFile.content.endsWith("\n")) {
    throw new NativeCaptureError("INCOMPLETE_SOURCE", "Primary events log has an unfinished final record.");
  }
  const seenIds = new Set<string>();
  let hasStart = false;
  for (const line of eventsFile.content.split("\n").filter((line) => line.trim() !== "")) {
    const record = JSON.parse(line) as { type?: unknown; id?: unknown; parentId?: unknown; data?: { version?: unknown; copilotVersion?: unknown; sessionId?: unknown; result?: { contents?: unknown } } };
    if (typeof record.type !== "string" || !KNOWN_COPILOT_EVENT_TYPES.has(record.type)) {
      throw new NativeCaptureError("UNSUPPORTED_EVENT", `Unknown or unsupported event type: ${String(record.type)}`);
    }
    if (record.type === "session.binary_asset") {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "Native binary assets are not supported.");
    }
    if (record.type === "session.start") {
      hasStart = true;
      if (record.data?.version !== 1 || typeof record.data.copilotVersion !== "string" || record.data.copilotVersion.trim() === "" ||
          (record.data.sessionId !== undefined && record.data.sessionId !== harnessSessionId)) {
        throw new NativeCaptureError("UNSUPPORTED_FORMAT", "The session.start event is not a supported SDK-native identity.");
      }
    }
    if (typeof record.id === "string") {
      if (seenIds.has(record.id)) throw new NativeCaptureError("INCOMPLETE_SOURCE", `Duplicate event ID: ${record.id}`);
      seenIds.add(record.id);
    }
    if (typeof record.parentId === "string" && record.parentId !== "" && !seenIds.has(record.parentId)) {
      throw new NativeCaptureError("INCOMPLETE_SOURCE", `Missing event predecessor: ${record.parentId}`);
    }
    const contents = record.data?.result?.contents;
    if (record.type === "tool.execution_complete" && Array.isArray(contents) &&
        contents.some((item) => typeof item === "object" && item !== null &&
          "outputTruncated" in item && item.outputTruncated === true &&
          (!("outputFilePath" in item) || typeof item.outputFilePath !== "string" || item.outputFilePath.trim() === ""))) {
      throw new NativeCaptureError("INCOMPLETE_SOURCE", "Truncated tool execution output is missing its persisted output file.");
    }
  }
  if (!hasStart) throw new NativeCaptureError("UNSUPPORTED_FORMAT", "Missing session.start event.");
}

function validateHostVersion(version: string | undefined, visualStudio: boolean): void {
  if (version === undefined) {
    if (visualStudio) {
      throw new NativeCaptureError(
        "SOURCE_NOT_CONFIGURED",
        "Configure SESSION_REGISTRY_VISUAL_STUDIO_VERSION for the SDK-backed Visual Studio 18.8+ experience, not legacy chat history.",
      );
    }
    return;
  }
  if (typeof version !== "string" || version.length > 128 || !HOST_VERSION.test(version)) {
    throw new NativeCaptureError(
      "UNSUPPORTED_HOST_VERSION",
      "Use a numeric major.minor[.patch[.build]] host version, optionally followed by prerelease/build metadata.",
    );
  }
  const parts = version.split(/[+-]/, 1)[0]!.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)) ||
      (visualStudio && (parts[0]! < 18 || (parts[0] === 18 && parts[1]! < 8)))) {
    throw new NativeCaptureError(
      "UNSUPPORTED_HOST_VERSION",
      "The configured version must be representable; Visual Studio requires 18.8 or later and the SDK-backed experience.",
    );
  }
}

/**
 * Captures an explicitly selected local SDK session and its supported dependencies,
 * not legacy IDE history, cloud sessions, or an unverified whole-application backup.
 * The harness name is operator-selected; harness.version remains the native Copilot
 * runtime version. sourceFormat labels the SDK-only boundary and configured host
 * version, which is not native attestation of the originating application/build.
 */
export async function captureCopilotHostSession(
  input: NativeCaptureInput,
  source: CopilotHostCaptureSource,
  homes: NativeHomes,
  maxBytes: number,
  now: () => Date = () => new Date(),
): Promise<NativeSessionArchive> {
  const harness = input?.harness;
  if (harness !== "visual-studio-copilot" &&
      harness !== "github-copilot-desktop" &&
      harness !== "github-copilot-desktop-chat") {
    throw new NativeCaptureError("UNSUPPORTED_HARNESS", "Use an explicit Visual Studio or Copilot Desktop SDK-native profile.");
  }
  if (input.hostSessionId !== undefined) {
    throw new NativeCaptureError("UNSUPPORTED_OPTION", "hostSessionId is not supported by these SDK-native profiles; use the native harnessSessionId.");
  }
  const harnessSessionId = input.harnessSessionId;
  if (!isValidHarnessSessionId(harnessSessionId)) {
    throw new NativeCaptureError("INVALID_SESSION_ID", "Use the exact URL-safe SDK-native session identifier, not a host ID, path, or URL.");
  }
  const copilotHome = source?.copilotHome;
  const configuredHostVersion = source?.hostVersion;
  if (typeof copilotHome !== "string" || copilotHome.trim() === "" ||
      !isAbsolute(copilotHome) || /[\u0000-\u001f\u007f]/.test(copilotHome)) {
    throw new NativeCaptureError("SOURCE_NOT_CONFIGURED", "Configure an explicit absolute local SDK-native Copilot home for this host profile.");
  }
  validateHostVersion(configuredHostVersion, harness === "visual-studio-copilot");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new NativeCaptureError("SOURCE_LIMIT", "The capture byte limit must be a positive safe integer.");
  }
  let native: NativeSessionArchive;
  try {
    const home = await lstat(copilotHome);
    if (home.isSymbolicLink()) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "The configured SDK-native home must be a real directory, not a symbolic link.");
    }
    if (!home.isDirectory()) {
      throw new NativeCaptureError("UNSUPPORTED_SOURCE", "The configured SDK-native home must be a directory, not a history export or diagnostic file.");
    }
    const primaryPath = join(copilotHome, "session-state", harnessSessionId, "events.jsonl");
    const sessionDirectory = join(copilotHome, "session-state", harnessSessionId);
    const rawEvents = await readFile(primaryPath);
    const entries = (await readdir(sessionDirectory, { recursive: true })).sort();
    if (inspectNativeJsonl(rawEvents).diagnostics.some((diagnostic) => ["invalid-json", "invalid-utf8", "duplicate-key"].includes(diagnostic.code))) {
      throw new NativeCaptureError("MALFORMED_SOURCE", `Primary events log ${primaryPath} is malformed.`);
    }
    native = await captureNativeSession(
      { harness: "github-copilot-cli", harnessSessionId },
      { ...homes, "github-copilot-cli": copilotHome },
      maxBytes,
      now,
    );
    try {
      const finalEntries = (await readdir(sessionDirectory, { recursive: true })).sort();
      if (!rawEvents.equals(await readFile(primaryPath)) ||
          entries.length !== finalEntries.length ||
          entries.some((entry, index) => entry !== finalEntries[index])) {
        throw new NativeCaptureError("SOURCE_CHANGED", "The selected SDK session changed during capture.");
      }
    } catch (error) {
      if (error instanceof NativeCaptureError) throw error;
      throw new NativeCaptureError("SOURCE_CHANGED", "Primary events log disappeared or changed during capture.");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new NativeCaptureError("SESSION_NOT_FOUND", "The configured SDK-native home or selected events.jsonl is missing; no alternate source was searched.");
  }
  validateCopilotEventGraph(native, harnessSessionId);
  if (native.harness.version.trim() === "") {
    throw new NativeCaptureError("UNSUPPORTED_FORMAT", "SDK-native session.start must record a nonempty Copilot runtime version.");
  }
  const versionScan = scan(native.harness.version);
  if (versionScan.status !== "ok" || versionScan.findings.length > 0) {
    throw new NativeCaptureError("SCAN_FAILED", "Native identity metadata contains unsanitized secrets.");
  }
  const hostVersion = configuredHostVersion === undefined
    ? "not-configured"
    : `operator-configured:${configuredHostVersion}`;
  const redactor = new NativeRedactor();
  const files = native.files.map((file) => {
    const content = file.kind === "events"
      ? file.content.split("\n").map((line) => line.trim() === "" ? line :
        JSON.stringify(redactor.value(JSON.parse(line), file.path))).join("\n")
      : redactor.text(file.content, file.path);
    return { ...file, content, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
  });
  return {
    ...native,
    harness: { name: harness, version: native.harness.version },
    sourceFormat: `${native.sourceFormat};profile=sdk-native-only;host-version=${hostVersion}`,
    files,
    redactions: [...native.redactions, ...redactor.redactions],
  };
}
