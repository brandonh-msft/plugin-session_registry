import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_CLI_HARNESSES,
  type NativeCliHarness,
  inspectNativeJsonl,
  isValidHarnessSessionId,
  type NativeArchiveFile,
  type NativeCaptureDiagnostic,
  type NativeCaptureManifest,
  type NativeCapturedSource,
  type NativeHarness,
  type NativeSessionArchive,
} from "@session-registry/core";
import {
  NativeCaptureError,
  NativeFiles,
  isForeignAbsolute,
  isMissingFile,
  isNativeObject,
  isWithin,
  parseRecords,
  sourceBytes,
  type NativeObject,
  type NativeValue,
  type SourceFile,
} from "./files.js";
import { resolveCodexCapture } from "./codex.js";

export type NativeHomes = Readonly<Record<NativeCliHarness, string>>;

interface NativeSource {
  readonly root: string;
  readonly primary: string;
  readonly dependencyDirectories: readonly string[];
  readonly allowedDependencies: readonly string[];
  readonly selection: NativeCaptureManifest["selection"];
  readonly layout: NativeCaptureManifest["layout"];
}

export interface NativeCaptureInput {
  readonly harness: NativeHarness;
  readonly harnessSessionId: string;
  readonly sourcePath?: string;
  readonly dependencyPaths?: readonly string[];
  readonly dependencyMappings?: readonly { readonly sourcePath: string; readonly localPath: string }[];
}

interface SourceIdentity {
  readonly version: string;
  readonly format: string;
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 10_000) {
      throw new NativeCaptureError("SOURCE_LIMIT", "Too many entries in a native session store.");
    }
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(({ name }) => name).sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Native session files cannot be symbolic links.");
    }
    return info.isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function locateSource(harness: NativeHarness, home: string, id: string, sourcePath?: string): Promise<NativeSource> {
  if (harness === "github-copilot-cli") {
    const path = sourcePath === undefined ? join(home, "session-state", id, "events.jsonl") : resolve(home, sourcePath);
    if (basename(path) !== "events.jsonl") {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "Select Copilot's native events.jsonl, not its rendered /export output.");
    }
    const root = dirname(path);
    return {
      root, primary: basename(path), dependencyDirectories: ["."], allowedDependencies: [root],
      selection: sourcePath === undefined ? "native-id" : "explicit-path", layout: "session-directory",
    };
  }
  if (harness === "claude-code") {
    const projects = join(home, "projects");
    const candidates: string[] = [];
    if (sourcePath !== undefined) {
      candidates.push(resolve(home, sourcePath));
    } else {
      for (const project of await directoryEntries(projects)) {
        const path = join(projects, project, `${id}.jsonl`);
        if (await regularFileExists(path)) candidates.push(path);
      }
    }
    const path = oneSource(candidates);
    const project = dirname(path);
    const inHome = isWithin(home, path);
    const root = inHome ? home : project;
    const dependencies = [
      join(project, id),
      ...(inHome ? ["file-history", "image-cache", "uploads", "tasks", "session-env"]
        .flatMap((directory) => [join(home, directory, id), join(home, directory, `${id}.json`)]) : []),
    ];
    return {
      root, primary: relative(root, path),
      dependencyDirectories: dependencies, allowedDependencies: dependencies,
      selection: sourcePath === undefined ? "native-id" : "explicit-path",
      layout: inHome ? "harness-home" : "session-directory",
    };
  }
  throw new NativeCaptureError("UNSUPPORTED_HARNESS", "Codex requires its native rollout resolver.");
}

function oneSource(candidates: readonly string[]): string {
  if (candidates.length === 0) {
    throw new NativeCaptureError("SESSION_NOT_FOUND", "No native session matched that ID in the configured harness home.");
  }
  if (candidates.length !== 1) {
    throw new NativeCaptureError("AMBIGUOUS_SESSION", "More than one native source matched the session ID. Supply sourcePath from the producing harness; no project or version was guessed.");
  }
  return candidates[0]!;
}

function identity(harness: NativeHarness, id: string, records: readonly NativeObject[], primary: SourceFile): SourceIdentity {
  if (harness === "github-copilot-cli") {
    const first = records.find((record) => record.type === "session.start");
    if (first === undefined || !isNativeObject(first.data) ||
        first.data.sessionId !== id || first.data.version !== 1 ||
        typeof first.data.copilotVersion !== "string") {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "Expected Copilot events version 1 with session.start identity and copilotVersion.");
    }
    // A persisted journal is not necessarily a closed event graph. Keep every
    // record verbatim; absent parents, repeated IDs, and diagnostic metadata
    // do not justify rejecting, repairing, reordering, or deduplicating it.
    return { version: first.data.copilotVersion, format: "copilot-events-v1" };
  }
  if (harness === "claude-code") {
    // Claude path resume and copied/forked sessions can retain earlier IDs and
    // missing logical parents. The selected file, not every entry, has identity.
    if (basename(primary.absolutePath) !== `${id}.jsonl` && !records.some((record) => record.sessionId === id)) {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "The selected Claude source has neither the native filename nor recorded identity requested.");
    }
    if (sourceBytes(primary).length > 0 && !records.some((record) => typeof record.type === "string")) {
      throw new NativeCaptureError("UNSUPPORTED_FORMAT", "The selected Claude file contains no decodable native records; a readable export is not native session state.");
    }
    const versions = records.map((record) => record.version).filter((value): value is string => typeof value === "string");
    return { version: versions.at(-1) ?? "not-recorded", format: "claude-session-jsonl-v1" };
  }
  throw new NativeCaptureError("UNSUPPORTED_HARNESS", "Codex identity must come from its native rollout resolver.");
}

function dependencyReferences(value: NativeValue, references: Set<string>, allowText: boolean, harness: NativeHarness, depth = 0): void {
  if (depth > 100) throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Native dependency nesting is too deep.");
  if (Array.isArray(value)) {
    for (const child of value) dependencyReferences(child, references, allowText, harness, depth + 1);
  } else if (isNativeObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (((harness === "github-copilot-cli" && value.type === "shell_exit" && key === "outputFilePath") ||
           (harness === "claude-code" && key === "persistedOutputPath")) && typeof child === "string") {
        references.add(child);
      } else if (key === "attachments" && Array.isArray(child)) {
        for (const attachment of child) {
          if (isNativeObject(attachment)) {
            // Frozen tagged-files entries are native references, not copies of current workspace files.
            if (attachment.type === "directory" || typeof attachment.taggedFilesEntry === "string") continue;
            const path = attachment.path ?? attachment.filePath;
            if (typeof path === "string") references.add(path);
          }
        }
      }
      // Tool arguments describe actions, not permission to read arbitrary historical paths.
      if (key !== "arguments" && key !== "input") dependencyReferences(child, references, allowText, harness, depth + 1);
    }
  } else if (allowText && harness !== "codex-cli" && typeof value === "string") {
    for (const match of value.matchAll(/^(?:Full output saved to:|Output saved to:|Saved to:)[ \t]*([^\r\n]+)/gm)) {
      const path = match[1]?.trim().replace(/^["']|["']$/g, "");
      if (path) references.add(path);
    }
  }
}

function isOutputRecord(record: NativeObject): boolean {
  return record.type === "tool.execution_complete" ||
    (record.type === "response_item" && isNativeObject(record.payload) &&
      (record.payload.type === "function_call_output" || record.payload.type === "custom_tool_call_output")) ||
    (record.type === "user" && isNativeObject(record.message) && Array.isArray(record.message.content) &&
      record.message.content.some((block) => isNativeObject(block) && block.type === "tool_result"));
}

function hasPersistedOutputGap(record: NativeObject, hasReferences: boolean, completeCodexOutputs: ReadonlySet<string>): boolean {
  if (!isOutputRecord(record)) return false;
  const result = isNativeObject(record.data) && isNativeObject(record.data.result) ? record.data.result : null;
  if (result !== null && Array.isArray(result.contents) && result.contents.some((block) =>
    isNativeObject(block) && block.type === "shell_exit" && block.outputTruncated === true &&
    typeof block.outputFilePath !== "string")) {
    return true;
  }
  if (hasReferences) return false;
  const truncatedPrefix = /^\s*(?:Warning: truncated output|\.\.\.\s*\d+\s+(?:characters|tokens) truncated)/i;
  const fullCopilotResult = result !== null && typeof result.detailedContent === "string" &&
    !truncatedPrefix.test(result.detailedContent);
  const fullCodexResult = record.type === "response_item" && isNativeObject(record.payload) &&
    typeof record.payload.call_id === "string" && completeCodexOutputs.has(record.payload.call_id);
  const output = result?.content ?? (isNativeObject(record.payload) ? record.payload.output : undefined);
  const claudeOutputs = isNativeObject(record.message) && Array.isArray(record.message.content)
    ? record.message.content.filter((block) => isNativeObject(block) && block.type === "tool_result")
      .map((block) => isNativeObject(block) ? block.content : undefined) : [];
  return !fullCopilotResult && !fullCodexResult && [output, ...claudeOutputs].some((text) =>
    typeof text === "string" && truncatedPrefix.test(text));
}

export async function captureNativeSession(
  input: NativeCaptureInput,
  homes: NativeHomes,
  maxBytes: number,
  now: () => Date = () => new Date(),
  sqliteHome?: string,
): Promise<NativeSessionArchive> {
  if (!isValidHarnessSessionId(input.harnessSessionId)) {
    throw new NativeCaptureError("INVALID_SESSION_ID", "Use the exact URL-safe native session identifier.");
  }
  if (!NATIVE_CLI_HARNESSES.includes(input.harness as NativeCliHarness)) {
    throw new NativeCaptureError("UNSUPPORTED_HARNESS", "This harness requires its dedicated native source adapter.");
  }
  const configuredHome = homes[input.harness as NativeCliHarness];
  if (configuredHome === undefined) throw new NativeCaptureError("UNSUPPORTED_HARNESS", "This harness does not have a native adapter.");
  let selected: NativeSource;
  let home: string;
  try {
    home = resolve(configuredHome);
    try {
      home = await realpath(home);
    } catch (error) {
      if (!isMissingFile(error) || input.harness === "codex-cli" ||
          input.sourcePath === undefined || !isAbsolute(input.sourcePath)) throw error;
    }
    selected = input.harness === "codex-cli"
      ? { root: home, primary: "", dependencyDirectories: [], allowedDependencies: [], selection: "native-id", layout: "harness-home" }
      : await locateSource(input.harness, home, input.harnessSessionId, input.sourcePath);
    if (relative(selected.root, await realpath(selected.root)) !== "") {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "The selected session directory is a symbolic link.");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new NativeCaptureError("SESSION_NOT_FOUND", "The configured harness home or selected native session is missing.");
  }
  const reader = new NativeFiles(selected.root, maxBytes);
  const codex = input.harness === "codex-cli"
    ? await resolveCodexCapture(reader, { harnessSessionId: input.harnessSessionId, sourcePath: input.sourcePath, sqliteHome }, maxBytes)
    : undefined;
  if (codex !== undefined) {
    const ownedThreads = new Set(codex.selectionEvidence.map((source) => source.sessionId));
    selected = {
      ...selected, primary: codex.primary.path, selection: codex.selection,
      allowedDependencies: codex.allowedDependencies,
      // Ancestors contribute only their bounded history and explicitly
      // referenced assets, never their unrelated post-fork artifact directories.
      dependencyDirectories: codex.allowedDependencies.filter((path) => ownedThreads.has(basename(path))),
    };
  }
  const primary = codex?.primary ?? await reader.read(selected.primary);
  const primaryRecords = parseRecords(primary);
  const sourceIdentity = codex === undefined
    ? identity(input.harness, input.harnessSessionId, primaryRecords, primary)
    : { version: codex.harnessVersion, format: codex.sourceFormat };
  const files: NativeArchiveFile[] = [];
  const sources: NativeCapturedSource[] = [];
  const diagnostics: NativeCaptureDiagnostic[] = [];
  const visited = new Set<string>();
  const pendingReferences = new Set<string>();
  const claudeChildren = new Set<string>();
  const externalReaders: NativeFiles[] = [];
  const explicitDependencies = new Set((input.dependencyPaths ?? []).map((path) => {
    if (!isAbsolute(path)) {
      throw new NativeCaptureError("INVALID_DEPENDENCY_PATH", "dependencyPaths must name exact absolute files authorized by the owner.");
    }
    return resolve(path);
  }));
  const dependencyMappings = new Map<string, string>();
  for (const { sourcePath, localPath } of input.dependencyMappings ?? []) {
    if (!sourcePath || !isAbsolute(localPath) || dependencyMappings.has(sourcePath)) {
      throw new NativeCaptureError("INVALID_DEPENDENCY_PATH", "Each dependency mapping must bind one recorded reference to a distinct, owner-authorized absolute local file.");
    }
    dependencyMappings.set(sourcePath, resolve(localPath));
  }

  function inspectRecord(record: NativeObject): void {
    if (input.harness === "claude-code" && isNativeObject(record.toolUseResult) &&
        typeof record.toolUseResult.agentId === "string") {
      claudeChildren.add(record.toolUseResult.agentId);
    }
  }

  function includeFile(source: SourceFile, events: boolean, originalPath?: string): void {
    if (visited.has(source.path)) return;
    visited.add(source.path);
    if (visited.size > 10_000) throw new NativeCaptureError("SOURCE_LIMIT", "Too many native session files.");
    let recordCount = 0;
    if (events) {
      const inspected = inspectNativeJsonl(sourceBytes(source));
      diagnostics.push(...inspected.diagnostics.map((diagnostic) => ({ ...diagnostic, source: source.path })));
      const records = inspected.records.filter(isNativeObject);
      const completeCodexOutputs = new Set(records.flatMap((record) =>
        record.type === "event_msg" && isNativeObject(record.payload) &&
        record.payload.type === "exec_command_end" && typeof record.payload.call_id === "string" &&
        typeof record.payload.stdout === "string" && typeof record.payload.stderr === "string"
          ? [record.payload.call_id] : []));
      recordCount = records.length;
      for (const record of records) {
        inspectRecord(record);
        const references = new Set<string>();
        dependencyReferences(record, references, isOutputRecord(record), input.harness);
        if (hasPersistedOutputGap(record, references.size > 0, completeCodexOutputs)) {
          diagnostics.push({ code: "native-output-truncated", source: source.path });
        }
        for (const reference of references) pendingReferences.add(reference);
      }
    }
    files.push({
      path: source.path,
      kind: events ? "events" : "attachment",
      content: source.content,
      ...(source.contentEncoding === undefined ? {} : { contentEncoding: source.contentEncoding }),
      recordCount,
      sha256: createHash("sha256").update(sourceBytes(source)).digest("hex"),
      ...(source.native === undefined ? {} : {
        nativeEncoding: "zstd" as const,
        nativeBytesBase64: source.native.bytesBase64,
        nativeSha256: source.native.sha256,
      }),
    });
    sources.push({
      path: source.path, capturedBytes: source.capturedSize, observedBytes: source.observedSize,
      sha256: source.native?.sha256 ?? createHash("sha256").update(sourceBytes(source)).digest("hex"),
      snapshot: source.snapshotKind,
      ...(originalPath === undefined ? {} : { originalPath }),
    });
    const size = files.reduce((sum, file) => sum + Buffer.byteLength(file.content) +
      (file.nativeBytesBase64?.length ?? 0), 0);
    if (size > maxBytes) {
      throw new NativeCaptureError("SOURCE_LIMIT", "Native files and dependencies exceed the capture limit; nothing was truncated.");
    }
  }

  async function captureFile(path: string, events = false): Promise<void> {
    includeFile(await reader.read(path), events);
  }

  async function captureDirectory(path: string, depth = 0): Promise<void> {
    if (depth > 20) throw new NativeCaptureError("SOURCE_LIMIT", "Native dependency nesting exceeds the supported limit.");
    if (!(await reader.exists(path))) return;
    if ((await lstat(await reader.resolve(path))).isFile()) {
      await captureFile(path);
      return;
    }
    for (const name of await reader.list(path)) {
      const child = join(path, name);
      try {
        // Online backup replaces the database plus its transactional sidecars;
        // don't require a volatile sidecar to remain after the backup completes.
        if (/(?:-wal|-shm|-journal)$/.test(name)) {
          const database = child.replace(/(?:-wal|-shm|-journal)$/, "");
          if (await reader.exists(database)) {
            const snapshot = await reader.read(database);
            if (snapshot.snapshotKind === "sqlite-backup") {
              includeFile(snapshot, false);
              continue;
            }
          }
        }
        const absolute = await reader.resolve(child);
        const info = await lstat(absolute);
        if (info.isDirectory()) await captureDirectory(child, depth + 1);
        else await captureFile(child, input.harness === "claude-code" &&
          /(?:^|[\\/])subagents[\\/].*agent-[^\\/]+\.jsonl$/.test(child));
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        throw new NativeCaptureError("SOURCE_CHANGED", "An inventoried native dependency disappeared during capture; retry preparation.");
      }
    }
  }

  if (codex === undefined) includeFile(primary, true);
  else {
    includeFile(primary, true);
    for (const stream of codex.streams) includeFile(stream, true);
  }
  for (const directory of selected.dependencyDirectories) await captureDirectory(directory);
  for (const child of claudeChildren) {
    if (!/^[A-Za-z0-9_-]+$/.test(child) || !files.some((file) => file.path.endsWith(`/agent-${child}.jsonl`))) {
      throw new NativeCaptureError("MISSING_SUBAGENT", "A Claude child transcript referenced by toolUseResult.agentId is missing.");
    }
  }
  for (const reference of pendingReferences) {
    try {
      const parts = reference.replaceAll("\\", "/").split("/");
      const referenceRoot = input.harness === "claude-code" && parts[0] === input.harnessSessionId
        ? dirname(primary.absolutePath)
        : input.harness === "claude-code" && parts[0] === "tool-results"
          ? join(dirname(primary.absolutePath), input.harnessSessionId)
          : selected.root;
      const absolute = dependencyMappings.get(reference) ??
        (isAbsolute(reference)
          ? resolve(reference)
          : isForeignAbsolute(reference) ? reference : resolve(referenceRoot, reference));
      if (dependencyMappings.has(reference) || explicitDependencies.has(absolute)) {
        const root = dirname(absolute);
        if (relative(root, await realpath(root)) !== "") {
          throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "An explicitly selected dependency directory is a symbolic link.");
        }
        const external = new NativeFiles(root, maxBytes);
        const source = await external.read(basename(absolute));
        externalReaders.push(external);
        includeFile({
          ...source,
          path: `dependencies/${createHash("sha256").update(reference).digest("hex")}/${basename(absolute)}`,
        }, false, reference);
      } else {
        if (!selected.allowedDependencies.some((directory) => isWithin(directory, absolute))) {
          throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY",
            "A native output reference is outside the selected session. Authorize its exact file in dependencyPaths, or map a relocated reference with dependencyMappings; no external file was read.");
        }
        await captureFile(absolute);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw new NativeCaptureError("MISSING_DEPENDENCY", "A referenced native output or attachment is missing; no partial archive was prepared.");
    }
  }
  await reader.assertUnchanged();
  for (const external of externalReaders) await external.assertUnchanged();
  if (codex === undefined) {
    const currentSource = await locateSource(input.harness, home, input.harnessSessionId, input.sourcePath);
    if (resolve(currentSource.root, currentSource.primary) !== primary.absolutePath) {
      throw new NativeCaptureError("SOURCE_CHANGED", "The selected native source changed during capture.");
    }
  } else await codex.assertUnchanged();
  return {
    format: NATIVE_SESSION_ARCHIVE_FORMAT,
    harness: { name: input.harness, version: sourceIdentity.version },
    harnessSessionId: input.harnessSessionId,
    capturedAt: now().toISOString(),
    sourceFormat: sourceIdentity.format,
    scope: "persisted-session-records",
    resumable: false,
    files,
    redactions: [],
    capture: {
      boundary: "observed-prefixes", entrypoint: primary.path, selection: selected.selection,
      layout: selected.layout, sources,
      diagnostics: [...new Map([...diagnostics, ...(codex?.diagnostics ?? [])].map((diagnostic) =>
        [JSON.stringify([diagnostic.source, diagnostic.line, diagnostic.code]), diagnostic])).values()],
      history: codex?.history ?? [{ path: primary.path, sessionId: input.harnessSessionId }],
    },
    restoration: {
      status: "not-verified",
      reason: "Native source files are preserved; activation requires a compatible harness, source registration, workspace and recipient configuration. The registry never resumes the producer to capture it.",
    },
  };
}
