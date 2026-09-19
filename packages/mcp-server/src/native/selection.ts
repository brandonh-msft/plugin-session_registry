import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isValidHarnessSessionId, NATIVE_CLI_HARNESSES, type NativeHarness } from "@session-registry/core";
import type { NativeCaptureInput, NativeHomes } from "./adapters.js";
import { isMissingFile, isNativeObject, NativeCaptureError, NativeFiles, parseRecords, type NativeObject } from "./files.js";

export interface NativeSessionSelection extends Omit<NativeCaptureInput, "harnessSessionId"> {
  readonly harnessSessionId?: string;
  readonly sessionDirectory?: string;
  readonly workingDirectory?: string;
  readonly recentUserMessage?: string;
}

function recordedId(harness: NativeHarness, path: string, records: readonly NativeObject[]): string | undefined {
  if (harness === "github-copilot-cli") {
    const start = records.find((record) => record.type === "session.start");
    return isNativeObject(start?.data) && typeof start.data.sessionId === "string" ? start.data.sessionId : undefined;
  }
  if (harness === "codex-cli") {
    const start = records.find((record) => record.type === "session_meta" && isNativeObject(record.payload) &&
      typeof record.payload.id === "string" && typeof record.payload.cli_version === "string");
    return isNativeObject(start?.payload) && typeof start.payload.id === "string" ? start.payload.id : undefined;
  }
  // Copied Claude forks retain old entry IDs; their canonical filename is the
  // native identity. Arbitrarily named imports must have one recorded identity.
  const name = basename(path, ".jsonl");
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name)) return name;
  const ids = new Set(records.flatMap((record) => typeof record.sessionId === "string" ? [record.sessionId] : []));
  return ids.size === 1 ? [...ids][0] : undefined;
}

export function matchesSessionEvidence(
  harness: NativeHarness, records: readonly NativeObject[], directory: string, message: string,
): boolean {
  const cwd = records.some((record) => {
    const data = harness === "github-copilot-cli" && record.type === "session.start" && isNativeObject(record.data)
      ? record.data.context : harness === "codex-cli" && record.type === "session_meta" ? record.payload : record;
    return isNativeObject(data) && typeof data.cwd === "string" && isAbsolute(data.cwd) &&
      relative(resolve(directory), resolve(data.cwd)) === "";
  });
  return cwd && records.some((record) => {
    if (harness === "github-copilot-cli") {
      return record.type === "user.message" && isNativeObject(record.data) && record.data.content === message;
    }
    const entry = harness === "claude-code" && record.type === "user" ? record.message :
      harness === "codex-cli" && record.type === "response_item" ? record.payload : undefined;
    if (!isNativeObject(entry) || entry.role !== "user") return false;
    if (typeof entry.content === "string") return entry.content === message;
    return Array.isArray(entry.content) && entry.content.some((block) =>
      isNativeObject(block) && (block.type === "text" || block.type === "input_text") && block.text === message);
  });
}

export async function selectNativeSession(
  input: NativeSessionSelection, homes: NativeHomes, maxBytes: number,
): Promise<NativeCaptureInput> {
  if (!NATIVE_CLI_HARNESSES.includes(input.harness as typeof NATIVE_CLI_HARNESSES[number])) {
    throw new NativeCaptureError("UNSUPPORTED_HARNESS", "This harness requires its dedicated native source adapter.");
  }
  const home = homes[input.harness as typeof NATIVE_CLI_HARNESSES[number]];
  let sourcePath = input.sourcePath;
  if (input.sessionDirectory !== undefined) {
    if (sourcePath !== undefined) throw new NativeCaptureError("INVALID_SOURCE_SELECTION", "Supply sourcePath or sessionDirectory, not both.");
    if (input.harness === "codex-cli") throw new NativeCaptureError("SOURCE_SELECTION_REQUIRED", "Codex requires its rollout file, or workingDirectory plus an exact recentUserMessage.");
    const directory = resolve(home, input.sessionDirectory);
    sourcePath = input.harness === "github-copilot-cli" ? join(directory, "events.jsonl") :
      join(dirname(directory), `${basename(directory)}.jsonl`);
  }
  if (input.harnessSessionId !== undefined && sourcePath === undefined) {
    return { ...input, harnessSessionId: input.harnessSessionId };
  }
  if (sourcePath !== undefined) {
    const path = resolve(home, sourcePath);
    if (input.harness === "github-copilot-cli" ? basename(path) !== "events.jsonl" : !/\.jsonl(?:\.zst)?$/.test(path)) {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "Select the native journal/JSONL, not readable Markdown or HTML.");
    }
    const root = dirname(path);
    if (relative(root, await realpath(root)) !== "") throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Native source directories cannot be symbolic links.");
    const reader = new NativeFiles(root, maxBytes);
    const source = await reader.read(path);
    const records = parseRecords(source);
    await reader.assertUnchanged();
    if (source.content.length > 0 && !records.some((record) => typeof record.type === "string")) {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "The selected source has no decodable native records; a readable export is not native state.");
    }
    const id = input.harness === "claude-code" && input.harnessSessionId !== undefined &&
      records.some((record) => record.sessionId === input.harnessSessionId)
      ? input.harnessSessionId : recordedId(input.harness, path, records);
    if (id === undefined || !isValidHarnessSessionId(id) ||
        (input.harnessSessionId !== undefined && input.harnessSessionId !== id)) {
      throw new NativeCaptureError("SESSION_ID_MISMATCH", "The native source does not establish the requested session identity.");
    }
    return { ...input, sourcePath: path, harnessSessionId: id };
  }
  if (!input.workingDirectory || !isAbsolute(input.workingDirectory) || !input.recentUserMessage?.trim()) {
    throw new NativeCaptureError("SOURCE_SELECTION_REQUIRED",
      "Use the native sessionDirectory/sourcePath already present in your harness context, or pass workingDirectory and an exact distinctive recentUserMessage. The server verifies native identity; do not ask the owner to transcribe a UUID or guess the newest session.");
  }
  const root = await realpath(home);
  const inventory = new NativeFiles(root, maxBytes);
  const candidates: string[] = [];
  let visited = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (!await inventory.exists(path)) return;
    for (const name of await inventory.list(path)) {
      if (++visited > 10_000) throw new NativeCaptureError("SOURCE_LIMIT", "Native identity lookup exceeds its bounded inventory; supply the native sourcePath.");
      const child = join(path, name);
      const info = await lstat(resolve(root, child));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory() && depth > 0) await walk(child, depth - 1);
      else if (info.isFile() && (input.harness === "github-copilot-cli" ? name === "events.jsonl" :
        input.harness === "claude-code" ? name.endsWith(".jsonl") : /^rollout-.*\.jsonl(?:\.zst)?$/.test(name))) {
        candidates.push(child);
      }
    }
  }
  try {
    if (input.harness === "github-copilot-cli") await walk("session-state", 1);
    else if (input.harness === "claude-code") await walk("projects", 1);
    else { await walk("sessions", 3); await walk("archived_sessions", 3); }
    const matches = new Map<string, { id: string; path: string }>();
    let bytes = 0;
    for (const path of candidates) {
      if (path.endsWith(".zst") && candidates.includes(path.slice(0, -4))) continue;
      const reader = new NativeFiles(root, maxBytes);
      const file = await reader.read(path);
      bytes += Buffer.byteLength(file.content);
      if (bytes > maxBytes) throw new NativeCaptureError("SOURCE_LIMIT", "Native identity lookup exceeds its byte budget; supply the native sourcePath.");
      const records = parseRecords(file);
      if (!matchesSessionEvidence(input.harness, records, input.workingDirectory, input.recentUserMessage)) continue;
      const id = recordedId(input.harness, path, records);
      if (id === undefined || !isValidHarnessSessionId(id)) continue;
      await reader.assertUnchanged();
      matches.set(input.harness === "codex-cli" ? id : path, { id, path: resolve(root, path) });
    }
    if (matches.size === 0) throw new NativeCaptureError("SESSION_NOT_FOUND", "No native session matches that exact user message and working directory. Check the producing profile or supply its native sourcePath.");
    if (matches.size !== 1) throw new NativeCaptureError("AMBIGUOUS_SESSION",
      `The message occurs in ${matches.size} native sources (for example after a fork). Supply the current native sourcePath or a more distinctive message; no newest-file guess was made.`);
    const match = [...matches.values()][0]!;
    // Codex's real resolver must still select the authoritative rollout version.
    return { ...input, harnessSessionId: match.id, ...(input.harness === "codex-cli" ? {} : { sourcePath: match.path }) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new NativeCaptureError("SOURCE_CHANGED", "A native source moved during identity lookup; retry with its current sourcePath.");
  }
}
