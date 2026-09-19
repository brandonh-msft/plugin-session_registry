import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidHarnessSessionId, type NativeArchiveFile, type NativeSessionArchive } from "@session-registry/core";
import { captureNativeSession, type NativeHomes } from "./adapters.js";
import {
  NativeCaptureError,
  NativeFiles,
  isMissingFile,
  isNativeObject,
  isWithin,
  parseNativeJson,
  parseRecords,
  type NativeObject,
  type NativeValue,
  type SourceFile,
} from "./files.js";
import { NativeRedactor } from "./redaction.js";
import type { NativeCaptureInput, VsCodeCaptureSource } from "./sourceTypes.js";
import { VSCODE_AGENT_HOST_COMMIT, VsCodeSessionDatabase, validateVsCodeJson } from "./vscodeSessionDatabase.js";

function safePathPart(value: string): boolean {
  return !!value && value !== "." && value !== ".." && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) &&
    !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function metadata(snapshot: VsCodeSessionDatabase): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of snapshot.rows.filter((row) => row.table === "session_metadata")) {
    if (typeof row.columns.key !== "string" || typeof row.columns.value !== "string") {
      throw new NativeCaptureError("MALFORMED_SOURCE", "Host metadata keys and values must be native text.");
    }
    result.set(row.columns.key, row.columns.value);
  }
  return result;
}

function jsonMetadata(values: ReadonlyMap<string, string>, key: string): NativeValue | undefined {
  const content = values.get(key);
  return content === undefined ? undefined : parseNativeJson({ path: `session_metadata.${key}`, content });
}

function assertDefaultChatLink(values: ReadonlyMap<string, string>, sdkId: string): void {
  // AgentService._persistDefaultChatBacking and agentPeerChats.encodeProviderData, at the pin.
  const backing = jsonMetadata(values, "defaultChatProviderData");
  if (!isNativeObject(backing) || typeof backing.sdkSessionId !== "string" ||
      Object.keys(backing).some((key) => !["sdkSessionId", "model", "agent"].includes(key)) ||
      (backing.model !== undefined && (!isNativeObject(backing.model) || typeof backing.model.id !== "string")) ||
      (backing.agent !== undefined && (!isNativeObject(backing.agent) || typeof backing.agent.uri !== "string"))) {
    throw new NativeCaptureError("UNSUPPORTED_HOST_LINKAGE", "The selected host database requires native defaultChatProviderData; a directory name is not SDK identity.");
  }
  if (backing.sdkSessionId !== sdkId) {
    throw new NativeCaptureError("HOST_SESSION_MISMATCH", "The selected host default chat belongs to a different SDK conversation.");
  }
  if (values.has("peerChatBacking")) {
    throw new NativeCaptureError("UNSUPPORTED_HOST_LINKAGE", "This database is an internal backing marker, not the owning host session; select the owning hostSessionId.");
  }
  const peers = jsonMetadata(values, "peerChats");
  const legacy = jsonMetadata(values, "copilot.chats");
  if ((peers !== undefined && !Array.isArray(peers)) || (legacy !== undefined && !isNativeObject(legacy))) {
    throw new NativeCaptureError("MALFORMED_SOURCE", "The native host chat catalog is malformed.");
  }
  if ((Array.isArray(peers) && peers.length !== 0) || (isNativeObject(legacy) && Object.keys(legacy).length !== 0)) {
    throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "Peer and side chats require their own SDK and host-state closure; no partial default-chat capture was prepared.");
  }
  const artifacts = jsonMetadata(values, "sessionArtifacts");
  if (artifacts !== undefined && (!Array.isArray(artifacts) || artifacts.length !== 0)) {
    throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "Host session artifacts require a dedicated dependency decoder.");
  }
  if (values.has("agentHost.createdBySession")) {
    throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "A host-created child session requires its parent-session dependency closure.");
  }
  if (values.get("agentHost.hasWorkspaceTransitions") === "true" ||
      values.get("agentHost.workspaceConversionQuarantined") === "true") {
    throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "Host workspace transitions require an external-workspace snapshot decoder.");
  }
}

function validateSdkDependencies(records: readonly NativeObject[]): void {
  const supportedTypes = new Set([
    "session.start", "session.resume", "session.compaction_complete", "session.info",
    "session.background_tasks_changed", "session.handoff", "session.fusion_route_started",
    "user.message", "assistant.message", "assistant.reasoning", "assistant.reasoning_delta",
    "system.message", "tool.execution_start", "tool.execution_complete",
    "subagent.started", "subagent.completed", "subagent.failed",
    "agent_reasoning_raw_content", "agent_reasoning_raw_content_delta", "turn_context",
    "world_state", "retained_context", "security_risk_score", "mcp.headers_refresh_required",
    "mcp.headers_refresh_completed", "mcp.oauth_required", "mcp.oauth_completed",
    "session.binary_asset",
  ]);
  for (const record of records) {
    if (typeof record.type !== "string" || !supportedTypes.has(record.type)) {
      throw new NativeCaptureError("UNSUPPORTED_EVENT", "The selected SDK stream contains an event outside the pinned native inventory.");
    }
    if (typeof record.type === "string" && (/^(?:subagent\.(?:started|completed|failed)|factory\.)/.test(record.type) ||
        ["session.background_tasks_changed", "session.handoff", "session.fusion_route_started"].includes(record.type))) {
      throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "Delegated SDK work requires additional host/native dependency capture.");
    }
    const data = isNativeObject(record.data) ? record.data : undefined;
    if (record.type === "tool.execution_start" && typeof data?.toolName === "string" &&
        /^(?:task|runSubagent|spawn_agent|create_session|create_chat|send_session_message|send_message)$/.test(data.toolName)) {
      throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "A cross-chat tool operation requires its own native dependency decoder.");
    }
  }
}

function validateRows(snapshot: VsCodeSessionDatabase, records: readonly NativeObject[], chatUri: string): void {
  const eventPositions = new Map(records.map((record, index) => [record.id, { index, type: record.type }]));
  const tools = new Map(records.flatMap((record, index) =>
    record.type === "tool.execution_start" && isNativeObject(record.data) && typeof record.data.toolCallId === "string"
      ? [[record.data.toolCallId, index] as const] : []));
  const turns = new Set<string>();
  const boundaries: { id: string; start: number }[] = [];
  let previous = -1;
  for (const row of snapshot.rows.filter((row) => row.table === "turns")) {
    const { id, event_id: eventId, checkpoint_ref: checkpoint } = row.columns;
    const event = typeof eventId === "string" ? eventPositions.get(eventId) : undefined;
    if (typeof id !== "string" || !id || !event || event.type !== "user.message" || event.index <= previous) {
      throw new NativeCaptureError("HOST_SESSION_MISMATCH", "Host turn boundaries do not match the selected SDK event stream in native insertion order.");
    }
    turns.add(id);
    turns.add(eventId as string);
    boundaries.push({ id, start: event.index });
    previous = event.index;
    if (checkpoint !== null && (typeof checkpoint !== "string" ||
        !/^refs\/agents\/[A-Za-z0-9._/-]+$/.test(checkpoint) || checkpoint.includes("..") ||
        checkpoint.split("/").some((part) => part === "" || part.endsWith(".") || part.endsWith(".lock")))) {
      throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "A host checkpoint must be a native refs/agents reference.");
    }
  }
  const turnIntervals = new Map(boundaries.map((boundary, index) =>
    [boundary.id, { start: boundary.start, end: boundaries[index + 1]?.start ?? records.length }] as const));
  for (const { table, columns } of snapshot.rows) {
    if (table === "turn_delegation") {
      throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "Host turn delegation requires the delegated native session.");
    }
    if (table === "turn_workspace_transition") {
      throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "Host workspace-transition snapshots are not supported.");
    }
    if (table === "file_edits") {
      if (typeof columns.tool_call_id !== "string" || !tools.has(columns.tool_call_id) ||
          typeof columns.file_path !== "string" || !columns.file_path ||
          typeof columns.edit_type !== "string" || !["edit", "create", "delete", "rename"].includes(columns.edit_type)) {
        throw new NativeCaptureError("INCOMPLETE_SOURCE", "A host edit has no matching SDK tool call or supported edit kind.");
      }
      const turn = typeof columns.turn_id === "string" ? turnIntervals.get(columns.turn_id) : undefined;
      const position = tools.get(columns.tool_call_id)!;
      if (!turn || position < turn.start || position >= turn.end) {
        throw new NativeCaptureError("INCOMPLETE_SOURCE", "A host edit's SDK tool call belongs to a different turn boundary.");
      }
      const needsBefore = columns.edit_type !== "create";
      const needsAfter = columns.edit_type !== "delete";
      if ((needsBefore && columns.before_content === null) || (needsAfter && columns.after_content === null) ||
          (columns.edit_type === "rename" && (typeof columns.original_path !== "string" || !columns.original_path))) {
        throw new NativeCaptureError("INCOMPLETE_SOURCE", "A host edit is missing required before/after snapshot content.");
      }
    }
    if (table === "chat_drafts" || table === "local_turns") {
      if (columns.chat_uri !== chatUri) {
        throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "The selected database contains another chat's draft or local turn.");
      }
      if (table === "local_turns" && (!isNativeObject(columns.payload) ||
          columns.payload.id !== columns.turn_id ||
          (columns.anchor_turn_id !== null && (typeof columns.anchor_turn_id !== "string" || !turns.has(columns.anchor_turn_id))))) {
        throw new NativeCaptureError("INCOMPLETE_SOURCE", "A host local turn has an unresolved native ID or anchor.");
      }
      if (table === "chat_drafts") {
        validateHostMessage(columns.draft!);
      } else {
        const payload = columns.payload as NativeObject;
        validateHostMessage(payload.message!);
        if (!["complete", "cancelled", "error"].includes(String(payload.state)) || !Array.isArray(payload.responseParts)) {
          throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "A local turn does not match the pinned native protocol shape.");
        }
        for (const part of payload.responseParts) {
          if (!isNativeObject(part) ||
              !["markdown", "reasoning", "systemNotification", "inputRequest", "error", "toolCall", "contentRef"].includes(String(part.kind))) {
            throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "A local turn contains an unclassified response part.");
          }
          if (part.kind === "toolCall") {
            if (!isNativeObject(part.toolCall) || typeof part.toolCall.toolCallId !== "string") {
              throw new NativeCaptureError("MALFORMED_SOURCE", "A local tool-call response has no native tool-call ID.");
            }
            const result = part.toolCall.result;
            if (isNativeObject(result) && (!Array.isArray(result.content) || result.content.some((item) =>
              !isNativeObject(item) || !["text", "resource", "embeddedResource", "fileEdit", "terminal", "subagent"].includes(String(item.type))))) {
              throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "A local tool result contains an unclassified native content type.");
            }
          }
        }
      }
    }
  }
}

function validateHostMessage(value: NativeValue): void {
  if (!isNativeObject(value) || typeof value.text !== "string" || !isNativeObject(value.origin) ||
      !["user", "agent", "tool", "automation", "systemNotification"].includes(String(value.origin.kind)) ||
      (value.attachments !== undefined && !Array.isArray(value.attachments))) {
    throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "A host message does not match the pinned native protocol shape.");
  }
}

function collectHostReferences(value: NativeValue, references: Set<string>, depth = 0): void {
  if (depth > 80) throw new NativeCaptureError("SOURCE_LIMIT", "Host dependency nesting exceeds the supported limit.");
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    let parsed: NativeValue;
    try {
      parsed = parseNativeJson({ path: "host embedded JSON", content: value });
    } catch (error) {
      if (error instanceof NativeCaptureError && error.code === "MALFORMED_SOURCE" && /invalid JSON/.test(error.message)) return;
      throw error;
    }
    collectHostReferences(parsed, references, depth + 1);
  } else if (Array.isArray(value)) {
    for (const child of value) collectHostReferences(child, references, depth + 1);
  } else if (isNativeObject(value)) {
    if (value.type === "embeddedResource" || value.type === "blob" || value.kind === "embeddedResource") {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "Embedded host assets require an explicit scannable content decoder.");
    }
    if (["chat", "annotations", "subagent"].includes(String(value.type))) {
      throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "A host record references another chat or an external annotation channel.");
    }
    if (value.type === "resource") {
      if (typeof value.uri !== "string" || value.displayKind === "directory") {
        throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "Only snapshotted host text-file resources can be captured.");
      }
      if (typeof value.contentType === "string" && !/^(?:text\/|application\/(?:json|xml)(?:;|$))/i.test(value.contentType)) {
        throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host resource declares a non-text content type.");
      }
      references.add(value.uri);
    }
    if (value.kind === "resource" || value.type === "fileEdit" || value.type === "terminal" || value.kind === "contentRef" ||
        (isNativeObject(value.content) && typeof value.content.uri === "string")) {
      throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "A host content reference requires a dedicated native content decoder.");
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "attachments" && Array.isArray(child) &&
          child.some((item) => !isNativeObject(item) || !["simple", "resource"].includes(String(item.type)))) {
        throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "The host record contains an unclassified attachment format.");
      }
      // Native tool arguments are evidence, never authorization to read their referenced paths.
      if (key !== "arguments" && key !== "input") collectHostReferences(child, references, depth + 1);
    }
  }
}

function redactHostValue(value: NativeValue, redactor: NativeRedactor, path: string): NativeValue {
  function normalize(current: NativeValue, depth: number): NativeValue {
    if (depth > 80) throw new NativeCaptureError("SOURCE_LIMIT", "Host content nesting exceeds the supported limit.");
    if (Array.isArray(current)) return current.map((child) => normalize(child, depth + 1));
    if (!isNativeObject(current)) return current;
    // AHP uses kind/origin discriminants rather than the SDK's type/role discriminants.
    if (current.kind === "reasoning" || current.kind === "systemNotification" ||
        (isNativeObject(current.origin) && current.origin.kind === "systemNotification")) {
      return redactor.value({ role: "system" }, path);
    }
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, normalize(child, depth + 1)]));
  }
  return redactor.value(normalize(value, 0), path);
}

function databaseFile(snapshot: VsCodeSessionDatabase, redactor?: NativeRedactor): NativeArchiveFile {
  const path = `host/${snapshot.key}/session.db.jsonl`;
  const records: NativeValue[] = [{
    type: "vscode.session-database.schema",
    format: "vscode-agent-host-session-database/1",
    sourceCommit: VSCODE_AGENT_HOST_COMMIT,
    sourcePath: `agentSessionData/${snapshot.key}/session.db`,
    userVersion: 12,
    integerEncoding: "decimal-string",
    blobEncoding: "raw-utf8",
    jsonColumns: "parsed-native-text-json",
    schema: snapshot.schema,
  }];
  for (const row of snapshot.rows) {
    let columns = row.columns;
    if (row.table === "session_metadata" && redactor !== undefined) {
      const key = String(columns.key);
      // Metadata stores semantic field names in `key`; scan that association, not just `value`.
      const before = redactor.redactions.length;
      const named = redactor.value({ [key]: columns.value! }, path);
      if (!isNativeObject(named)) throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Invalid host metadata.");
      const hasValue = Object.hasOwn(named, key);
      if (!hasValue && redactor.redactions.length === before) {
        throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Host metadata lost its value without a recorded redaction.");
      }
      // Record-level redaction can drop role/channel; retain the SQL column and row identity.
      const value = hasValue ? named[key] : "[REDACTED]";
      if (typeof value !== "string") throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Redacted host metadata must remain a text cell.");
      columns = { ...columns, value };
    }
    records.push({
      type: "vscode.session-database.row", table: row.table, rowid: row.rowid,
      columns: redactor === undefined ? columns : redactHostValue(columns, redactor, path), storageTypes: row.storageTypes,
    });
  }
  return archiveFile(path, "events", records.map((record) => JSON.stringify(record)).join("\n") + "\n", records.length);
}

function archiveFile(path: string, kind: NativeArchiveFile["kind"], content: string, recordCount = 0): NativeArchiveFile {
  return { path, kind, content, recordCount, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

/**
 * Capture a pinned-schema, SDK-backed default chat, never Local chat exports or a UI projection.
 * hostSessionId is the exact raw owning Copilot host ID (defaults to the requested SDK ID only
 * as a path selector); defaultChatProviderData and native turn boundaries prove its SDK linkage.
 * Checkpoint refs remain frozen references, not collected Git objects or a resume bundle.
 * Peer/delegation, workspace transitions and unknown required dependencies fail.
 */
export async function captureVsCodeAgentSession(
  input: NativeCaptureInput,
  source: VsCodeCaptureSource,
  homes: NativeHomes,
  maxBytes: number,
  now: () => Date = () => new Date(),
): Promise<NativeSessionArchive> {
  if (input.harness !== "vscode-copilot-agent") {
    throw new NativeCaptureError("UNSUPPORTED_HARNESS", "This adapter only captures vscode-copilot-agent sessions.");
  }
  const hostId = input.hostSessionId ?? input.harnessSessionId;
  if (!isValidHarnessSessionId(input.harnessSessionId) || !isValidHarnessSessionId(hostId) ||
      !safePathPart(hostId) || !safePathPart(input.harnessSessionId)) {
    throw new NativeCaptureError("INVALID_SESSION_ID", "Use exact URL-safe SDK and host session identifiers.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new NativeCaptureError("SOURCE_LIMIT", "A positive safe capture byte limit is required.");
  }
  let userDataPath: string;
  let sdkRoot: string;
  try {
    userDataPath = await realpath(source.userDataPath);
    sdkRoot = await realpath(join(source.copilotHome, "session-state", input.harnessSessionId));
    const expectedUserData = resolve(source.userDataPath);
    const expectedSdkRoot = resolve(source.copilotHome, "session-state", input.harnessSessionId);
    const sameUserData = process.platform === "win32"
      ? userDataPath.toLowerCase() === expectedUserData.toLowerCase()
      : userDataPath === expectedUserData;
    const sameSdkRoot = process.platform === "win32"
      ? sdkRoot.toLowerCase() === expectedSdkRoot.toLowerCase()
      : sdkRoot === expectedSdkRoot;
    if (!sameUserData || !sameSdkRoot) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "VS Code capture roots and session directories cannot be symbolic links.");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new NativeCaptureError("SESSION_NOT_FOUND", "The configured VS Code or selected SDK source is missing.");
  }
  const snapshots: VsCodeSessionDatabase[] = [];
  const hostReader = new NativeFiles(userDataPath, maxBytes);
  const sdkReader = new NativeFiles(sdkRoot, maxBytes);
  const hostSessionUri = `copilot:/${hostId}`;
  const encodedHost = Buffer.from(hostSessionUri, "utf8").toString("base64url");
  const defaultChatUri = `ahp-chat://default/${encodedHost}`;
  const attachmentKeys = [hostId, `default-${encodedHost}`];
  const attachmentRoots = attachmentKeys.map((key) => join(userDataPath, "agentSessionData", key, "attachments"));
  const redactor = new NativeRedactor();
  const hostFiles: NativeArchiveFile[] = [];
  const hostSources = new Map<string, SourceFile>();
  let sourceBytes = 0;
  function addSourceBytes(bytes: number): void {
    sourceBytes += bytes;
    if (sourceBytes > maxBytes) throw new NativeCaptureError("SOURCE_LIMIT", "Combined SDK and host sources exceed the capture byte limit.");
  }
  async function captureAttachments(path: string, depth = 0): Promise<void> {
    if (depth > 20 || hostFiles.length >= 10_000) {
      throw new NativeCaptureError("SOURCE_LIMIT", "The host attachment tree exceeds its depth or file limit.");
    }
    if (!(await hostReader.exists(path))) return;
    for (const name of await hostReader.list(path)) {
      if (!safePathPart(name)) throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "A host attachment filename is not path-safe.");
      const child = join(path, name);
      const absolute = await hostReader.resolve(child);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        await captureAttachments(child, depth + 1);
      } else {
        if (info.nlink !== 1) throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Host attachment hard links are not supported.");
        if (/\.jsonl\.zst$/i.test(name)) {
          throw new NativeCaptureError("UNSUPPORTED_COMPRESSION", "VS Code host attachments are raw snapshots, not compressed rollout streams.");
        }
        const file = await hostReader.read(child);
        if (file.contentEncoding !== undefined) {
          throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host attachment contains opaque bytes that cannot be preserved as text.");
        }
        if (file.content.charCodeAt(0) === 0xfeff) {
          throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A host attachment contains opaque or BOM-prefixed bytes that cannot be preserved as text.");
        }
        if (Buffer.byteLength(file.content, "utf8") !== file.size) {
          throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A host attachment uses a text encoding marker that the shared reader cannot preserve.");
        }
        addSourceBytes(file.size);
        const archivePath = `host/${file.path.slice("agentSessionData/".length)}`;
        validateVsCodeJson(file.content, archivePath);
        hostFiles.push(archiveFile(archivePath, "attachment", redactor.text(file.content, archivePath)));
        hostSources.set(archivePath, file);
      }
    }
  }
  async function checkDirectory(key: string, databaseExpected: boolean, attachmentsAllowed = true): Promise<void> {
    const directory = join("agentSessionData", key);
    if (!(await hostReader.exists(directory))) {
      if (databaseExpected) throw new NativeCaptureError("HOST_DATABASE_NOT_FOUND", "The selected host database directory is missing.");
      return;
    }
    const allowed = [...(databaseExpected ? ["session.db", "session.db-wal", "session.db-shm"] : []), ...(attachmentsAllowed ? ["attachments"] : [])];
    if ((await hostReader.list(directory)).some((name) => !allowed.includes(name))) {
      throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "The selected host data directory contains an unclassified native dependency.");
    }
  }
  try {
    const primary = await VsCodeSessionDatabase.open(userDataPath, hostId, maxBytes);
    snapshots.push(primary);
    addSourceBytes(primary.sourceBytes);
    assertDefaultChatLink(metadata(primary), input.harnessSessionId);
    await checkDirectory(hostId, true);
    const events = await sdkReader.read("events.jsonl");
    const records = parseRecords(events);
    validateSdkDependencies(records);
    validateRows(primary, records, defaultChatUri);
    // AgentService._markChatBacking may create a separate, metadata-only SDK-ID database.
    if (hostId !== input.harnessSessionId && await hostReader.exists(join("agentSessionData", input.harnessSessionId))) {
      const marker = await VsCodeSessionDatabase.open(userDataPath, input.harnessSessionId, maxBytes - sourceBytes);
      snapshots.push(marker);
      addSourceBytes(marker.sourceBytes);
      if (marker.rows.length !== 1 || metadata(marker).get("peerChatBacking") !== defaultChatUri) {
        throw new NativeCaptureError("UNSUPPORTED_HOST_LINKAGE", "The SDK-ID host database is not the selected default chat's isolated backing marker.");
      }
      await checkDirectory(input.harnessSessionId, true, false);
    }
    const references = new Set<string>();
    for (const row of primary.rows) {
      // before/after edit bytes are native content, not permission to crawl paths in source code.
      if (row.table !== "file_edits") collectHostReferences(row.columns, references);
    }
    for (const reference of references) {
      let path: string;
      try {
        const uri = new URL(reference);
        if (uri.protocol !== "file:" || uri.host || uri.search || uri.hash) throw new Error("Not a local file URI");
        path = fileURLToPath(uri);
      } catch {
        throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "A host resource is not a local snapshotted attachment.");
      }
      if (!isAbsolute(path) || !attachmentRoots.some((root) => isWithin(root, path) && root !== path) ||
          !relative(userDataPath, path).split(sep).every(safePathPart)) {
        throw new NativeCaptureError("UNSUPPORTED_DEPENDENCY", "A host attachment references content outside the selected snapshot directories.");
      }
      if (!(await hostReader.exists(path))) {
        throw new NativeCaptureError("MISSING_DEPENDENCY", "A referenced host attachment snapshot is missing.");
      }
    }
    for (const key of attachmentKeys) {
      if (key !== hostId) await checkDirectory(key, false);
      await captureAttachments(join("agentSessionData", key, "attachments"));
    }
    const sdk = await captureNativeSession(
      { harness: "github-copilot-cli", harnessSessionId: input.harnessSessionId },
      { ...homes, "github-copilot-cli": source.copilotHome }, maxBytes, now,
    );
    for (const file of sdk.files) addSourceBytes((await sdkReader.read(file.path.split("/").join(sep))).size);
    const sdkFiles = sdk.files.map((file) => {
      if (file.kind !== "events") return file;
      const content = records
        .map((record) => JSON.stringify(redactor.value(record, `sdk/${file.path}`)))
        .join("\n") + "\n";
      return { ...file, content, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
    });
    const databaseFiles = snapshots.map((snapshot) => databaseFile(snapshot, redactor));
    const rawDatabaseFiles = snapshots.map((snapshot) => databaseFile(snapshot));
    const files = [
      ...sdkFiles.map((file) => ({ ...file, path: `sdk/${file.path}` })),
      ...databaseFiles,
      ...hostFiles,
    ];
    if (files.length > 10_000 || snapshots.reduce((total, snapshot) => total + snapshot.rows.length, 0) > 10_000 ||
        new Set(files.map((file) => file.path)).size !== files.length ||
        files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) > maxBytes) {
      throw new NativeCaptureError("SOURCE_LIMIT", "Combined native archive files exceed the capture limit or contain duplicate paths.");
    }
    const redactions = [
      ...sdk.redactions.map((item) => ({ ...item, source: `sdk/${item.source}` })),
      ...redactor.redactions,
    ].map((item, index) => ({ ...item, id: `r${index + 1}` }));
    if (redactions.length > 10_000) {
      throw new NativeCaptureError("REDACTION_LIMIT", "The combined native redaction ledger exceeds the review limit.");
    }
    await sdkReader.assertUnchanged();
    await hostReader.assertUnchanged();
    for (const snapshot of snapshots) await snapshot.assertUnchanged();
    return {
      ...sdk,
      harness: { name: "vscode-copilot-agent", version: `source-${VSCODE_AGENT_HOST_COMMIT}; copilot-${sdk.harness.version}` },
      sourceFormat: "vscode-agent-host-copilot-events-v1-session-db-v12;checkpoints=references-only",
      files,
      redactions,
      capture: {
        ...sdk.capture!,
        entrypoint: `sdk/${sdk.capture!.entrypoint}`,
        sources: [
          ...sdk.capture!.sources.map((source) => ({ ...source, path: `sdk/${source.path}` })),
          ...rawDatabaseFiles.map((file) => ({
            path: file.path,
            capturedBytes: Buffer.byteLength(file.content, "utf8"),
            observedBytes: Buffer.byteLength(file.content, "utf8"),
            sha256: file.sha256,
            snapshot: "sqlite-backup" as const,
          }),
          ...hostFiles.map((file) => {
            const source = hostSources.get(file.path)!;
            return {
              path: file.path,
              capturedBytes: source.capturedSize,
              observedBytes: source.observedSize,
              sha256: createHash("sha256").update(source.content, "utf8").digest("hex"),
              snapshot: source.snapshotKind,
            };
          })),
        ],
        history: sdk.capture!.history.map((segment) => ({ ...segment, path: `sdk/${segment.path}` })),
        diagnostics: sdk.capture!.diagnostics.map((diagnostic) => ({ ...diagnostic, source: `sdk/${diagnostic.source}` })),
      },
    };
  } finally {
    await Promise.all(snapshots.map((snapshot) => snapshot.close()));
  }
}
