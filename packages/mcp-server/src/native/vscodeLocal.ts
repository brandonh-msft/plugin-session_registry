import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  NATIVE_SESSION_ARCHIVE_FORMAT,
  isValidHarnessSessionId,
  type NativeArchiveFile,
  type NativeSessionArchive,
} from "@session-registry/core";
import {
  NativeCaptureError,
  NativeFiles,
  isMissingFile,
  isNativeObject,
  parseNativeJson,
  sourceBytes,
  type NativeObject,
  type NativeValue,
  type SourceFile,
} from "./files.js";
import { NativeRedactor } from "./redaction.js";
import type { NativeCaptureInput, VsCodeCaptureSource } from "./sourceTypes.js";

// VS Code 1.137.0 (645f29cc3176500b4b5762ba887cf2a7f0ffdf2c):
// chatSessionStore.ts, chatSessionOperationLog.ts, objectMutationLog.ts, and
// browser/chatEditing/{chatEditingSessionStorage,chatEditingOperations}.ts.
// Main cbea5b4b6a964508352be917d3ddbdc6fc6e7a75 adds requestSource to v3.
const MAX_RECORDS = 100_000;
const MAX_ENTRIES = 10_000;
const MAX_VALUES = 1_000_000;
const MAX_DEPTH = 100;
const WORKSPACES = join("User", "workspaceStorage");
const GLOBAL_STORAGE = join("User", "globalStorage");
const RESPONSE_KINDS = new Set([
  "markdownContent", "treeData", "toolInvocationSerialized", "progressTaskSerialized",
  "elicitationSerialized", "textEditGroup", "multiDiffData", "mcpServersStarting",
  "thinking", "planReview", "autoModeResolution", "clearToPreviousToolInvocation",
  "codeblockUri", "command", "confirmation", "extensions", "hook", "inlineReference",
  "markdownVuln", "notebookEditGroup", "progressMessage", "systemNotification",
  "pullRequest", "questionCarousel", "undoStop", "warning", "info", "workspaceEdit",
  "externalEdit", "disabledClaudeHooks",
]);
const ATTACHMENT_KINDS = new Set([
  "generic", "directory", "file", "tool", "toolset", "implicit", "string",
  "transcriptContext", "workspace", "paste", "symbol", "command", "image",
  "notebookOutput", "diagnostic", "element", "promptFile", "promptText",
  "scmHistoryItem", "scmHistoryItemChange", "scmHistoryItemChangeRange",
  "terminalCommand", "debugVariable", "agentFeedback", "debugEvents",
  "sessionReference", "browserView", "chatReference",
]);
const MESSAGE_PART_KINDS = new Set(["text", "var", "tool", "toolset", "agent", "subcommand", "slash", "prompt", "dynamic"]);
const TOOL_KINDS = new Set([
  "terminal", "input", "extensions", "pullRequest", "todoList", "subagent",
  "simpleToolInvocation", "search", "resources", "modifiedFilesConfirmation",
  "agentFeedbackReviewConfirmation", "sessionCreated", "generatedImage", "automationConfigured",
]);
const EDIT_KINDS = new Set(["textEditGroup", "notebookEditGroup", "workspaceEdit", "externalEdit", "multiDiffData"]);
const PRIVATE_REQUEST_IDENTITY = new Set([
  "requestId", "responseId", "timestamp", "responseTimestamp", "isHidden",
  "hiddenFromTranscript", "requestHiddenFromTranscript", "isSystemInitiated", "isCanceled",
]);
const PRIVATE_PROMPT_FIELDS = new Set(["message", "variableData", "confirmation", "systemInitiatedLabel", "origin"]);
const REQUEST_FIELDS = [
  "requestId", "timestamp", "confirmation", "message", "shouldBeRemovedOnSend", "agent",
  "modelId", "editedFileEvents", "variableData", "isHidden", "hiddenFromTranscript",
  "requestHiddenFromTranscript", "isCanceled", "response", "responseId", "responseTimestamp",
  "result", "responseMarkdownInfo", "followups", "modelState", "vote", "slashCommand",
  "usedContext", "contentReferences", "codeCitations", "timeSpentWaiting", "completionTokens",
  "promptTokens", "outputBuffer", "promptTokenDetails", "copilotCredits", "modelTotals",
  "sessionCopilotCredits", "elapsedMs", "modeInfo", "isSystemInitiated", "requestSource",
  "systemInitiatedLabel", "terminalExecutionId", "origin",
];

interface Shape {
  readonly fields?: Readonly<Record<string, Shape>>;
  readonly item?: Shape;
}

const VALUE: Shape = {};
function fields(names: readonly string[], overrides: Readonly<Record<string, Shape>> = {}): Shape {
  return { fields: { ...Object.fromEntries(names.map((name) => [name, VALUE])), ...overrides } };
}
const REQUEST_SHAPE = fields(REQUEST_FIELDS, {
  message: fields(["text", "parts"]),
  variableData: fields(["variables"], { variables: { item: VALUE } }),
  editedFileEvents: { item: fields(["uri", "eventKind"]) },
  response: { item: VALUE },
});
const SESSION_SHAPE = fields([
  "version", "creationDate", "customTitle", "initialLocation", "inputState",
  "responderUsername", "sessionId", "requests", "hasPendingEdits", "repoData",
  "pendingRequests", "workingDirectory",
], {
  requests: { item: REQUEST_SHAPE },
  inputState: fields(["attachments", "mode", "selectedModel", "inputText", "selections", "permissionLevel", "contrib"]),
  pendingRequests: { item: fields(["id", "request", "kind", "sendOptions"], { request: REQUEST_SHAPE }) },
});

interface Selection {
  readonly primary: string;
  readonly log: boolean;
  readonly workspace?: string;
}

interface Discovery {
  readonly selected: Selection;
  readonly editing: readonly { readonly path: string; readonly workspace: string }[];
  readonly fingerprint: string;
}

interface Inspection {
  values: number;
  requiresEdits: boolean;
  readonly privateRequests: Set<string>;
  readonly privatePrompts: Set<string>;
}

type ObjectPath = (string | number)[];

function requireSource(condition: unknown, message: string, code = "UNSUPPORTED_FORMAT"): asserts condition {
  if (!condition) throw new NativeCaptureError(code, message);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}

async function configuredRoot(path: string): Promise<string> {
  requireSource(isAbsolute(path) && !path.includes("\0"), "Configure an absolute VS Code user-data directory.", "UNSAFE_SOURCE_PATH");
  const absolute = resolve(path);
  const info = await lstat(absolute);
  requireSource(!info.isSymbolicLink() && info.isDirectory(), "The VS Code user-data root must be a regular directory.", "UNSAFE_SOURCE_PATH");
  const canonical = await realpath(absolute);
  const same = process.platform === "win32"
    ? canonical.toLowerCase() === absolute.toLowerCase()
    : canonical === absolute;
  requireSource(same, "The configured VS Code user-data path cannot contain symbolic links.", "UNSAFE_SOURCE_PATH");
  return canonical;
}

async function directory(reader: NativeFiles, path: string): Promise<boolean> {
  if (!(await reader.exists(path))) return false;
  requireSource((await lstat(await reader.resolve(path))).isDirectory(), "A native store path is not a directory.", "UNSAFE_SOURCE_PATH");
  return true;
}

async function discover(reader: NativeFiles, id: string): Promise<Discovery> {
  const candidates: Selection[] = [];
  const stamps: NativeValue[] = [];
  const editing: { path: string; workspace: string }[] = [];
  let entriesVisited = 0;

  async function list(path: string): Promise<readonly string[]> {
    const names = await reader.list(path);
    entriesVisited += names.length;
    requireSource(entriesVisited <= MAX_ENTRIES, "VS Code discovery exceeds the directory-entry limit.", "SOURCE_LIMIT");
    return names;
  }

  async function store(path: string, workspace?: string, transferred = false): Promise<void> {
    if (!(await directory(reader, path))) return;
    const names = await list(path);
    const expected = [`${id}.json`, `${id}.jsonl`];
    requireSource(!names.some((name) => expected.some((target) =>
      name.toLowerCase() === target.toLowerCase() && name !== target)),
    "A session filename has a different exact identifier.", "UNSAFE_SOURCE_PATH");
    const found = new Map<string, { size: number; modified: number }>();
    for (const name of expected) {
      if (!names.includes(name)) continue;
      const info = await lstat(await reader.resolve(join(path, name)));
      requireSource(info.isFile(), "Native chat histories must be regular files.", "UNSAFE_SOURCE_PATH");
      found.set(name, { size: info.size, modified: info.mtimeMs });
      stamps.push({ path: join(path, name), size: info.size, modified: info.mtimeMs });
    }
    if (found.size === 0) return;
    const flat = found.get(expected[0]!);
    const log = found.get(expected[1]!);
    requireSource(!transferred || log === undefined, "Transferred sessions use flat JSON, not an operation log.");
    // The supported default is chat.useLogSessionStorage !== false. Do not
    // silently select an old log after a writer has switched back to flat JSON.
    requireSource(flat === undefined || log === undefined || flat.modified <= log.modified,
      "A newer flat snapshot conflicts with the operation log; provide a quiescent, unambiguous native store.", "AMBIGUOUS_SESSION");
    candidates.push({
      primary: join(path, log === undefined ? expected[0]! : expected[1]!),
      log: log !== undefined,
      ...(workspace === undefined ? {} : { workspace }),
    });
  }

  if (await directory(reader, WORKSPACES)) {
    const workspaces = await list(WORKSPACES);
    for (const workspace of workspaces) {
      const workspacePath = join(WORKSPACES, workspace);
      const info = await lstat(await reader.resolve(workspacePath));
      if (!info.isDirectory()) continue;
      requireSource(safeSegment(workspace), "An unsafe workspace-storage identifier was found.", "UNSAFE_SOURCE_PATH");
      await store(join(workspacePath, "chatSessions"), workspace);
      const editPath = join(workspacePath, "chatEditingSessions", id);
      if (await directory(reader, editPath)) editing.push({ path: editPath, workspace });
    }
  }
  await store(join(GLOBAL_STORAGE, "emptyWindowChatSessions"));
  await store(join(GLOBAL_STORAGE, "transferredChatSessions"), undefined, true);
  requireSource(candidates.length !== 0, "No native VS Code Local session matched the exact ID.", "SESSION_NOT_FOUND");
  requireSource(candidates.length === 1, "The session ID exists in more than one VS Code store.", "AMBIGUOUS_SESSION");
  requireSource(editing.length <= 1, "The session ID has more than one native editing store.", "AMBIGUOUS_SESSION");
  const selected = candidates[0]!;
  requireSource(selected.workspace === undefined || editing.length === 0 || editing[0]!.workspace === selected.workspace,
    "The chat history and editing state belong to different workspaces.", "INCOMPLETE_SOURCE");
  return { selected, editing, fingerprint: JSON.stringify({ candidates, stamps, editing }) };
}

function decimalIdentity(token: string): string {
  const [mantissa, rawExponent = "0"] = token.toLowerCase().split("e");
  const sign = mantissa!.startsWith("-") ? "-" : "";
  const unsigned = mantissa!.replace(/^-/, "");
  const point = unsigned.indexOf(".");
  let digits = unsigned.replace(".", "").replace(/^0+/, "");
  if (digits === "") return "0";
  let exponent = Number(rawExponent) - (point === -1 ? 0 : unsigned.length - point - 1);
  requireSource(Number.isSafeInteger(exponent), "A native number cannot be represented safely.", "UNSUPPORTED_SOURCE");
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return `${sign}${digits}e${exponent}`;
}

function nativeJson(source: Pick<SourceFile, "path" | "content">): NativeValue {
  const value = parseNativeJson(source);
  for (const token of source.content.matchAll(/"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (token[1] === undefined) continue;
    const number = Number(token[1]);
    requireSource(Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)) &&
      decimalIdentity(token[1]) === decimalIdentity(JSON.stringify(number)),
    "A native number cannot be preserved without precision loss.", "UNSUPPORTED_SOURCE");
  }
  return value;
}

function embeddedJson(text: string): NativeValue | undefined {
  if (!/^\s*[\[{]/.test(text)) return undefined;
  try {
    JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  return nativeJson({ path: "Embedded native content", content: text });
}

function inspect(value: NativeValue, budget: Inspection, depth = 0): void {
  requireSource(depth <= MAX_DEPTH && ++budget.values <= MAX_VALUES,
    "The native snapshot exceeds the supported nesting or validation-work limit.", "SOURCE_LIMIT");
  if (typeof value === "string") {
    requireSource(!value.includes("[VS Code: value truncated for persistence"),
      "VS Code persisted a truncation marker, not the complete native value.", "INCOMPLETE_SOURCE");
    requireSource(!/data:[^,\r\n]*;base64,/i.test(value), "Encoded native media cannot be scanned.", "UNSCANNABLE_SOURCE");
    const embedded = embeddedJson(value);
    if (embedded !== undefined) inspect(embedded, budget, depth + 1);
    else if (/^\s*[\[{]/.test(value) && value.includes("\n")) {
      for (const line of value.split(/\r?\n/)) inspect(line, budget, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    requireSource(value.length <= MAX_RECORDS, "A native array exceeds the record limit.", "SOURCE_LIMIT");
    for (const item of value) inspect(item, budget, depth + 1);
  } else if (isNativeObject(value)) {
    requireSource(!Object.hasOwn(value, "$base64") && !Object.hasOwn(value, "base64Data") &&
      value.type !== "Buffer" && !(typeof value.type === "string" && value.type.startsWith("ArrayBuffer-")) &&
      !(typeof value.scheme === "string" && value.scheme.toLowerCase() === "data") &&
      value.kind !== "image" && value.kind !== "generatedImage" &&
      !(value.type === "embed" && value.isText !== true) &&
      ![value.mimeType, value.mime].some((mime) => typeof mime === "string" && !/^(?:text\/|application\/(?:json|xml)$)/i.test(mime)),
    "A native media or encoded-byte payload cannot be safely scanned.", "UNSCANNABLE_SOURCE");
    if (value.kind === "subagent" && value.chatResource !== undefined) {
      throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "A separately persisted subagent chat requires a linked-source adapter.");
    }
    for (const item of Object.values(value)) inspect(item, budget, depth + 1);
  }
}

function knownFields(value: NativeObject, shape: Shape): void {
  requireSource(shape.fields !== undefined && Object.keys(value).every((key) => Object.hasOwn(shape.fields!, key)),
    "The native object contains fields outside the pinned storage schema.");
}

function array(value: NativeValue | undefined, label: string): NativeValue[] {
  requireSource(Array.isArray(value), `${label} must be an array.`);
  requireSource(value.length <= MAX_RECORDS, `${label} exceeds the record limit.`, "SOURCE_LIMIT");
  return value;
}

function attachments(value: NativeValue | undefined): void {
  for (const entry of array(value, "Native attachments")) {
    requireSource(isNativeObject(entry) && typeof entry.kind === "string" && ATTACHMENT_KINDS.has(entry.kind),
      "The source contains an unclassified attachment kind.", "UNSUPPORTED_EVENT");
    requireSource(typeof entry.id === "string" && typeof entry.name === "string", "A native attachment is missing its identity.");
  }
}

function nativeUri(value: NativeValue | undefined): boolean {
  return isNativeObject(value) && typeof value.scheme === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.$mid === undefined || value.$mid === 1);
}

function toolResult(value: NativeValue): void {
  if (Array.isArray(value)) {
    requireSource(value.every((item) => nativeUri(item) || (isNativeObject(item) && nativeUri(item.uri) && isNativeObject(item.range))),
      "A native tool-result reference is malformed.");
    return;
  }
  requireSource(isNativeObject(value) && typeof value.input === "string",
    "The source contains an unclassified tool-result envelope.", "UNSUPPORTED_EVENT");
  knownFields(value, fields(["input", "inputLanguage", "output", "isError", "mcpOutput"]));
  // Older persisted input/output details used a plain output string.
  if (typeof value.output === "string") return;
  for (const item of array(value.output, "Native tool output")) {
    requireSource(isNativeObject(item) && (item.type === "embed" || item.type === "ref"),
      "The source contains an unclassified tool-output kind.", "UNSUPPORTED_EVENT");
    requireSource(item.type === "ref" ? nativeUri(item.uri) : item.isText === true && typeof item.value === "string",
      "A native tool output has unavailable or unscannable content.", "UNSCANNABLE_SOURCE");
  }
}

function responsePart(value: NativeValue, inspection: Inspection): void {
  if (typeof value === "string") return;
  requireSource(isNativeObject(value), "A response part has an unsupported envelope.");
  if (value.kind === undefined) {
    requireSource(value.type === undefined && (typeof value.value === "string" || nativeUri(value.uri)),
      "An untagged response part is neither persisted Markdown nor file-tree data.", "UNSUPPORTED_EVENT");
    return;
  }
  requireSource(typeof value.kind === "string" && RESPONSE_KINDS.has(value.kind),
    "The source contains an unclassified response kind.", "UNSUPPORTED_EVENT");
  requireSource(value.subAgentInvocationId === undefined,
    "A subagent-correlated response requires its complete native lineage; a display record alone is insufficient.", "UNSUPPORTED_LINEAGE");
  if (EDIT_KINDS.has(value.kind)) inspection.requiresEdits = true;
  if (value.kind === "toolInvocationSerialized") {
    requireSource(typeof value.toolCallId === "string" && typeof value.toolId === "string" && value.isComplete === true,
      "A serialized tool invocation has an invalid identity or completion marker.");
    if (value.toolSpecificData !== undefined) {
      requireSource(isNativeObject(value.toolSpecificData) && typeof value.toolSpecificData.kind === "string" &&
        TOOL_KINDS.has(value.toolSpecificData.kind), "The source contains an unclassified tool payload.", "UNSUPPORTED_EVENT");
      requireSource(value.toolSpecificData.kind !== "subagent",
        "Subagent tool summaries require a native lineage decoder, including those without a chatResource.", "UNSUPPORTED_LINEAGE");
    }
    if (value.resultDetails !== undefined) toolResult(value.resultDetails);
  }
}

function request(value: NativeValue, inspection: Inspection): string {
  requireSource(isNativeObject(value), "A native request is not an object.");
  knownFields(value, REQUEST_SHAPE);
  requireSource(typeof value.requestId === "string" && value.requestId.length > 0, "A native request has no persisted requestId.");
  requireSource(value.responseId === undefined || typeof value.responseId === "string" && value.responseId.length > 0,
    "A native response has an invalid persisted responseId.");
  for (const key of ["isHidden", "hiddenFromTranscript", "requestHiddenFromTranscript", "isSystemInitiated", "isCanceled"]) {
    requireSource(value[key] === undefined || typeof value[key] === "boolean", "A native request has an invalid visibility or state flag.");
  }
  if (typeof value.message !== "string") {
    requireSource(isNativeObject(value.message) && typeof value.message.text === "string", "A native request has no message.");
    knownFields(value.message, REQUEST_SHAPE.fields!.message!);
    for (const part of array(value.message.parts, "Parsed message parts")) {
      requireSource(isNativeObject(part) && typeof part.kind === "string" && MESSAGE_PART_KINDS.has(part.kind),
        "The source contains an unclassified message-part kind.", "UNSUPPORTED_EVENT");
    }
  }
  requireSource(isNativeObject(value.variableData), "A native request has no variableData.");
  knownFields(value.variableData, REQUEST_SHAPE.fields!.variableData!);
  attachments(value.variableData.variables);
  if (value.response !== undefined) {
    for (const part of array(value.response, "Native response")) responsePart(part, inspection);
  }
  if (value.editedFileEvents !== undefined && array(value.editedFileEvents, "Edited-file events").length > 0) {
    inspection.requiresEdits = true;
  }
  if (value.hiddenFromTranscript === true || value.isHidden === true) inspection.privateRequests.add(value.requestId);
  if (value.requestHiddenFromTranscript === true || value.isSystemInitiated === true) inspection.privatePrompts.add(value.requestId);
  return value.requestId;
}

function validateSession(value: NativeValue, id: string, inspection: Inspection): asserts value is NativeObject {
  requireSource(isNativeObject(value) && value.version === 3 && value.sessionId === id,
    "Expected a native VS Code v3 snapshot with the exact persisted sessionId; Export Chat JSON is not native state.");
  knownFields(value, SESSION_SHAPE);
  requireSource(typeof value.creationDate === "number" && Number.isSafeInteger(value.creationDate) && value.creationDate >= 0 &&
    typeof value.responderUsername === "string", "The native session envelope is incomplete.");
  inspect(value, inspection);
  const ids = new Set<string>();
  const responseIds = new Set<string>();
  for (const entry of array(value.requests, "Native requests")) {
    const requestId = request(entry, inspection);
    requireSource(!ids.has(requestId), "The native session contains duplicate request IDs.", "INCOMPLETE_SOURCE");
    ids.add(requestId);
    if (isNativeObject(entry) && typeof entry.responseId === "string") {
      requireSource(!responseIds.has(entry.responseId), "The native session contains duplicate response IDs.", "INCOMPLETE_SOURCE");
      responseIds.add(entry.responseId);
    }
  }
  if (value.pendingRequests !== undefined) {
    for (const entry of array(value.pendingRequests, "Pending requests")) {
      requireSource(isNativeObject(entry), "A pending request has an invalid envelope.");
      knownFields(entry, SESSION_SHAPE.fields!.pendingRequests!.item!);
      requireSource(typeof entry.id === "string" && (entry.kind === "queued" || entry.kind === "steering"),
        "A pending request has an unsupported identity or queue kind.");
      const requestId = request(entry.request!, inspection);
      requireSource(entry.id === requestId && !ids.has(requestId), "A pending request has a duplicate or inconsistent ID.", "INCOMPLETE_SOURCE");
      ids.add(requestId);
    }
  }
  if (value.inputState !== undefined) {
    requireSource(isNativeObject(value.inputState), "Native inputState must be an object.");
    knownFields(value.inputState, SESSION_SHAPE.fields!.inputState!);
    attachments(value.inputState.attachments);
    requireSource(typeof value.inputState.inputText === "string", "The native draft input is incomplete.");
  }
  if (value.hasPendingEdits !== undefined) {
    requireSource(typeof value.hasPendingEdits === "boolean", "hasPendingEdits must be a boolean.");
    if (value.hasPendingEdits) inspection.requiresEdits = true;
  }
}

function validateMutation(state: NativeObject, path: ObjectPath, id: string, inspection: Inspection): void {
  if (path[0] === "requests" && typeof path[1] === "number" && path.length > 2 &&
    path[2] !== "requestId" && path[2] !== "responseId") {
    const entry = (state.requests as NativeValue[])[path[1]]!;
    inspect(entry, inspection);
    request(entry, inspection);
  } else {
    validateSession(state, id, inspection);
  }
}

function operationPath(entry: NativeObject): { path: ObjectPath; shape: Shape } {
  const parts = array(entry.k, "Operation path");
  requireSource(parts.length > 0 && parts.length <= MAX_DEPTH, "An operation cannot replace the root or use an unbounded path.");
  let shape = SESSION_SHAPE;
  const path: ObjectPath = [];
  for (const part of parts) {
    if (shape.item !== undefined) {
      requireSource(typeof part === "number" && Number.isSafeInteger(part) && part >= 0 && part < MAX_RECORDS,
        "An operation array index is invalid.");
      shape = shape.item;
    } else {
      requireSource(typeof part === "string" && shape.fields !== undefined && Object.hasOwn(shape.fields, part),
        "An operation targets a path outside the pinned native schema.");
      shape = shape.fields[part]!;
    }
    path.push(part);
  }
  return { path, shape };
}

function child(value: NativeValue, key: string | number): NativeValue | undefined {
  if (Array.isArray(value)) {
    requireSource(typeof key === "number" && key < value.length, "An operation would create a sparse native array.", "INCOMPLETE_SOURCE");
    return value[key];
  }
  requireSource(isNativeObject(value) && typeof key === "string", "An operation traverses a missing or non-object parent.", "INCOMPLETE_SOURCE");
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function applyOperation(state: NativeObject, entry: NativeObject): ObjectPath {
  requireSource(entry.kind === 1 || entry.kind === 2 || entry.kind === 3, "The source contains an unknown mutation kind.", "UNSUPPORTED_EVENT");
  const allowed = entry.kind === 2 ? ["kind", "k", "v", "i"] : entry.kind === 1 ? ["kind", "k", "v"] : ["kind", "k"];
  requireSource(Object.keys(entry).every((key) => allowed.includes(key)), "An operation contains unsupported schema fields.");
  const { path, shape } = operationPath(entry);
  let parent: NativeValue = state;
  for (const part of path.slice(0, -1)) {
    const next = child(parent, part);
    requireSource(next !== undefined, "An operation has an unresolved parent.", "INCOMPLETE_SOURCE");
    parent = next;
  }
  const key = path.at(-1)!;
  const previous = child(parent, key);
  let next: NativeValue | undefined;
  if (entry.kind === 2) {
    requireSource(shape.item !== undefined && (previous === undefined || Array.isArray(previous)), "A push targets a non-array.");
    const current = previous === undefined ? [] : previous as NativeValue[];
    const index = entry.i === undefined ? current.length : entry.i;
    requireSource(typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index <= current.length,
      "A push has an invalid splice boundary.", "INCOMPLETE_SOURCE");
    const values = entry.v === undefined ? [] : array(entry.v, "Pushed values");
    requireSource(entry.i !== undefined || values.length > 0, "A push has neither values nor a splice boundary.");
    requireSource(index + values.length <= MAX_RECORDS, "A native array exceeds the record limit.", "SOURCE_LIMIT");
    current.length = index;
    for (const value of values) current.push(structuredClone(value));
    next = current;
  } else {
    // A Set without v is emitted for a primitive changed to undefined.
    next = entry.kind === 3 || entry.v === undefined ? undefined : structuredClone(entry.v);
  }
  if (Array.isArray(parent)) {
    requireSource(typeof key === "number" && next !== undefined, "An operation would leave a hole in a native array.", "INCOMPLETE_SOURCE");
    parent[key] = next;
  } else {
    requireSource(isNativeObject(parent) && typeof key === "string", "An operation targets a non-object.", "INCOMPLETE_SOURCE");
    if (next === undefined) delete parent[key];
    else parent[key] = next;
  }
  return path;
}

function privateValue(value: NativeValue, redactor: NativeRedactor, source: string): NativeValue {
  const sanitized = redactor.value({ system_prompt: value }, source);
  requireSource(isNativeObject(sanitized), "The native redactor returned an invalid object.");
  return sanitized.system_prompt!;
}

function privateRequestField(id: NativeValue | undefined, key: string, inspection: Inspection): boolean {
  return typeof id === "string" && (
    inspection.privateRequests.has(id) && !PRIVATE_REQUEST_IDENTITY.has(key) ||
    inspection.privatePrompts.has(id) && PRIVATE_PROMPT_FIELDS.has(key)
  );
}

function requestIdentity(value: NativeObject): NativeValue | undefined {
  return Object.hasOwn(value, "message") && Object.hasOwn(value, "variableData") ? value.requestId : undefined;
}

function preparePrivate(value: NativeValue, inspection: Inspection, redactor: NativeRedactor, source: string): NativeValue {
  if (typeof value === "string") {
    const embedded = embeddedJson(value);
    if (embedded === undefined) {
      return /^\s*[\[{]/.test(value) && value.includes("\n")
        ? value.split(/(\r?\n)/).map((line, index) => index % 2 === 0
          ? preparePrivate(line, inspection, redactor, source) : line).join("")
        : value;
    }
    const before = redactor.redactions.length;
    const prepared = preparePrivate(embedded, inspection, redactor, source);
    return before === redactor.redactions.length ? value : JSON.stringify(prepared);
  }
  if (Array.isArray(value)) return value.map((item) => preparePrivate(item, inspection, redactor, source));
  if (!isNativeObject(value)) return value;
  const requestId = requestIdentity(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const privatePart = (value.kind === "thinking" && !["kind", "id", "reasoningDurationMs"].includes(key)) ||
      (value.kind === "promptText" && key === "value") ||
      privateRequestField(requestId, key, inspection);
    return [key, privatePart ? privateValue(item, redactor, source) : preparePrivate(item, inspection, redactor, source)];
  }));
}

function redactAtPath(value: NativeValue, path: ObjectPath, state: NativeObject, inspection: Inspection, redactor: NativeRedactor, source: string): NativeValue {
  let current: NativeValue | undefined = state;
  for (const key of path) {
    if (isNativeObject(current) && privateRequestField(requestIdentity(current), String(key), inspection)) {
      return privateValue(value, redactor, source);
    }
    current = current === undefined ? undefined : child(current, key);
  }
  const prepared = preparePrivate(value, inspection, redactor, source);
  // Preserve semantic property names for structured redaction of a Set's v.
  let wrapped = prepared;
  for (const key of [...path].reverse()) wrapped = { [key]: wrapped };
  let sanitized = redactor.value(wrapped, source);
  for (const key of path) {
    if (!isNativeObject(sanitized)) return sanitized;
    sanitized = sanitized[String(key)]!;
  }
  return sanitized;
}

function decode(source: SourceFile, log: boolean, id: string, redactor: NativeRedactor): { records: NativeValue[]; inspection: Inspection; pendingEdits: boolean } {
  const inspection: Inspection = { values: 0, requiresEdits: false, privateRequests: new Set(), privatePrompts: new Set() };
  if (!log) {
    const value = nativeJson(source);
    validateSession(value, id, inspection);
    return {
      records: [redactor.value(preparePrivate(value, inspection, redactor, source.path), source.path)],
      inspection,
      pendingEdits: value.hasPendingEdits === true,
    };
  }
  requireSource(source.content.endsWith("\n"), "The operation log has an incomplete final record.", "INCOMPLETE_SOURCE");
  const lines = source.content.split("\n");
  lines.pop();
  requireSource(lines.length > 0, "The native operation log is empty.", "EMPTY_SOURCE");
  requireSource(lines.length <= MAX_RECORDS, "The native operation log exceeds the record limit.", "SOURCE_LIMIT");
  const entries = lines.map((content, index) => {
    const entry = nativeJson({ path: `${source.path} record ${index + 1}`, content });
    requireSource(isNativeObject(entry), "A native operation must be an object.");
    return entry;
  });
  const initial = entries[0]!;
  requireSource(initial.kind === 0 && Object.keys(initial).every((key) => key === "kind" || key === "v") &&
    Object.hasOwn(initial, "v"), "Expected one initial kind-0 state as the first operation.");
  let state = structuredClone(initial.v!);
  validateSession(state, id, inspection);
  for (const entry of entries.slice(1)) {
    requireSource(entry.kind !== 0, "An initial operation may only appear once, at the start of the log.", "INCOMPLETE_SOURCE");
    const path = applyOperation(state, entry);
    validateMutation(state, path, id, inspection);
  }
  const pendingEdits = state.hasPendingEdits === true;
  // Replay for context, but archive every original operation, not the replayed
  // display state. Privacy flags discovered later also protect earlier payloads.
  state = structuredClone(initial.v!);
  requireSource(isNativeObject(state), "The initial state is not an object.");
  const records: NativeValue[] = [{
    kind: 0,
    v: redactor.value(preparePrivate(initial.v!, inspection, redactor, source.path), source.path),
  }];
  for (const entry of entries.slice(1)) {
    const path = applyOperation(state, entry);
    records.push(entry.v === undefined ? redactor.value(entry, source.path) : {
      ...redactor.value({ ...entry, v: null }, source.path) as NativeObject,
      v: redactAtPath(entry.v, path, state, inspection, redactor, source.path),
    });
  }
  return { records, inspection, pendingEdits };
}

function archiveFile(path: string, kind: NativeArchiveFile["kind"], content: string, recordCount = 0): NativeArchiveFile {
  return { path, kind, content, recordCount, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
}

function editState(value: NativeValue, inspection: Inspection): { hashes: Set<string>; modified: boolean } {
  requireSource(isNativeObject(value) && value.version === 2, "Only native text-editing state version 2 is supported.");
  knownFields(value, fields(["version", "initialFileContents", "recentSnapshot", "timeline"]));
  inspect(value, inspection);
  const hashes = new Set<string>();
  function hash(value: NativeValue | undefined): void {
    requireSource(typeof value === "string" && /^[a-f0-9]{7}$/.test(value), "A native edit-content hash is unsafe or unsupported.", "UNSAFE_SOURCE_PATH");
    hashes.add(value);
  }
  const resources = new Set<string>();
  for (const entry of array(value.initialFileContents, "Initial edit contents")) {
    requireSource(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && !resources.has(entry[0]),
      "An initial edit-content reference is malformed or duplicated.", "INCOMPLETE_SOURCE");
    resources.add(entry[0]);
    hash(entry[1]);
  }
  requireSource(isNativeObject(value.recentSnapshot), "The editing state has no recent snapshot.");
  knownFields(value.recentSnapshot, fields(["stopId", "entries"]));
  resources.clear();
  let modified = false;
  for (const entry of array(value.recentSnapshot.entries, "Recent edit entries")) {
    requireSource(isNativeObject(entry) && typeof entry.resource === "string" && typeof entry.languageId === "string" &&
      typeof entry.snapshotUri === "string" && isNativeObject(entry.telemetryInfo) &&
      (entry.state === 0 || entry.state === 1 || entry.state === 2) && !resources.has(entry.resource),
    "A native edit snapshot entry is malformed or duplicated.", "INCOMPLETE_SOURCE");
    knownFields(entry, fields(["resource", "languageId", "originalHash", "currentHash", "state", "snapshotUri", "telemetryInfo", "isDeleted"]));
    requireSource(entry.languageId !== "VSCodeChatNotebookSnapshotLanguage",
      "Native notebook snapshot dependencies are not supported.", "UNSCANNABLE_SOURCE");
    resources.add(entry.resource);
    hash(entry.originalHash);
    hash(entry.currentHash);
    modified ||= entry.state === 0;
  }
  if (value.timeline !== undefined) {
    requireSource(isNativeObject(value.timeline), "The editing timeline must be an object.");
    knownFields(value.timeline, fields(["checkpoints", "fileBaselines", "operations", "currentEpoch", "epochCounter"]));
    requireSource(Number.isSafeInteger(value.timeline.currentEpoch) && Number.isSafeInteger(value.timeline.epochCounter) &&
      Number(value.timeline.currentEpoch) >= 0 && Number(value.timeline.currentEpoch) <= Number(value.timeline.epochCounter),
    "The editing timeline has an invalid epoch boundary.");
    const epochCounter = Number(value.timeline.epochCounter);
    const validEpoch = (epoch: NativeValue | undefined) =>
      typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= epochCounter;
    const checkpoints = new Set<string>();
    for (const checkpoint of array(value.timeline.checkpoints, "Edit checkpoints")) {
      requireSource(isNativeObject(checkpoint) && typeof checkpoint.checkpointId === "string" &&
        typeof checkpoint.label === "string" && validEpoch(checkpoint.epoch) && !checkpoints.has(checkpoint.checkpointId),
      "An edit checkpoint is malformed or duplicated.");
      checkpoints.add(checkpoint.checkpointId);
    }
    const baselines = new Set<string>();
    for (const baseline of array(value.timeline.fileBaselines, "Edit baselines")) {
      requireSource(Array.isArray(baseline) && baseline.length === 2 && typeof baseline[0] === "string" &&
        !baselines.has(baseline[0]) && isNativeObject(baseline[1]) && typeof baseline[1].content === "string" &&
        nativeUri(baseline[1].uri) && typeof baseline[1].requestId === "string" && validEpoch(baseline[1].epoch),
      "A native edit baseline is malformed or duplicated.");
      requireSource(baseline[1].notebookViewType === undefined, "Notebook editing dependencies are not supported.", "UNSCANNABLE_SOURCE");
      baselines.add(baseline[0]);
    }
    for (const operation of array(value.timeline.operations, "Edit operations")) {
      requireSource(isNativeObject(operation) && typeof operation.type === "string" &&
        ["create", "delete", "rename", "textEdit"].includes(operation.type),
      "The source contains an unsupported editing operation.", "UNSUPPORTED_EVENT");
      requireSource(nativeUri(operation.uri) && typeof operation.requestId === "string" && validEpoch(operation.epoch),
        "An editing operation is incomplete.");
      requireSource(operation.notebookViewType === undefined && operation.cellIndex === undefined,
        "Notebook editing dependencies are not supported.", "UNSCANNABLE_SOURCE");
      requireSource(operation.type !== "create" || typeof operation.initialContent === "string", "A file creation has no native content.");
      requireSource(operation.type !== "delete" || typeof operation.finalContent === "string", "A file deletion has no native content.");
      requireSource(operation.type !== "rename" || (isNativeObject(operation.oldUri) && isNativeObject(operation.newUri)), "A rename is incomplete.");
      if (operation.type === "textEdit") array(operation.edits, "Native text edits");
    }
  }
  return { hashes, modified };
}

async function captureEdits(
  reader: NativeFiles,
  path: string,
  inspection: Inspection,
  pendingEdits: boolean,
  redactor: NativeRedactor,
  captured: SourceFile[],
): Promise<NativeArchiveFile[]> {
  const names = await reader.list(path);
  requireSource(names.includes("state.json"), "The native editing state file is missing.", "MISSING_DEPENDENCY");
  requireSource(names.every((name) => name === "state.json" || name === "contents"), "The editing store contains unclassified dependencies.", "UNSUPPORTED_DEPENDENCY");
  const source = await reader.read(join(path, "state.json"));
  captured.push(source);
  const value = nativeJson(source);
  const { hashes, modified } = editState(value, inspection);
  requireSource(!pendingEdits || modified, "Chat pending edits disagree with the persisted editing snapshot.", "INCOMPLETE_SOURCE");
  const files = [archiveFile(source.path, "attachment", JSON.stringify(redactor.value(preparePrivate(value, inspection, redactor, source.path), source.path)) + "\n")];
  const contentsPath = join(path, "contents");
  const contents = await directory(reader, contentsPath) ? await reader.list(contentsPath) : [];
  requireSource(contents.length <= MAX_ENTRIES && [...hashes].every((hash) => contents.includes(hash)),
    "A required native edit-content file is missing.", "MISSING_DEPENDENCY");
  for (const name of contents) {
    requireSource(/^[a-f0-9]{7}$/.test(name), "The editing store contains an unclassified content path.", "UNSUPPORTED_DEPENDENCY");
    const content = await reader.read(join(contentsPath, name));
    captured.push(content);
    // Upstream uses the first seven hex characters of SHA-1, not SHA-256.
    requireSource(createHash("sha1").update(content.content, "utf8").digest("hex").startsWith(name),
      "A native edit-content file does not match its persisted hash.", "INCOMPLETE_SOURCE");
    let text = content.content;
    const embedded = embeddedJson(text);
    if (embedded !== undefined) {
      inspect(embedded, inspection);
      const before = redactor.redactions.length;
      const sanitized = redactor.value(preparePrivate(embedded, inspection, redactor, content.path), content.path);
      if (before !== redactor.redactions.length) text = JSON.stringify(sanitized);
    }
    files.push(archiveFile(content.path, "attachment", redactor.text(text, content.path)));
  }
  return files;
}

export async function captureVsCodeLocalSession(
  input: NativeCaptureInput,
  source: VsCodeCaptureSource,
  maxBytes: number,
  now: () => Date = () => new Date(),
): Promise<NativeSessionArchive> {
  requireSource(input.harness === "vscode-copilot-chat", "This adapter only captures VS Code Local chat.", "UNSUPPORTED_HARNESS");
  requireSource(input.hostSessionId === undefined, "VS Code Local capture does not use a hostSessionId.", "INVALID_CAPTURE_INPUT");
  requireSource(isValidHarnessSessionId(input.harnessSessionId) && safeSegment(input.harnessSessionId),
    "Use the exact safe native VS Code session identifier.", "INVALID_SESSION_ID");
  requireSource(Number.isSafeInteger(maxBytes) && maxBytes > 0, "The native capture byte limit must be a positive safe integer.", "SOURCE_LIMIT");
  try {
    const root = await configuredRoot(source.userDataPath);
    const reader = new NativeFiles(root, maxBytes);
    const discovery = await discover(reader, input.harnessSessionId);
    const primary = await reader.read(discovery.selected.primary);
    requireSource(primary.contentEncoding === undefined, "Native chat histories must be valid UTF-8 text, not opaque bytes.", "UNSCANNABLE_SOURCE");
    const captured = [primary];
    const redactor = new NativeRedactor();
    const decoded = decode(primary, discovery.selected.log, input.harnessSessionId, redactor);
    const files = [archiveFile(primary.path, "events", decoded.records.map((record) => JSON.stringify(record)).join("\n") + "\n", decoded.records.length)];
    requireSource(!decoded.inspection.requiresEdits || discovery.editing.length > 0,
      "The session references native edits but its editing state is missing.", "MISSING_DEPENDENCY");
    if (discovery.editing[0] !== undefined) {
      files.push(...await captureEdits(reader, discovery.editing[0].path, decoded.inspection, decoded.pendingEdits, redactor, captured));
    }
    await reader.assertUnchanged();
    requireSource(await configuredRoot(source.userDataPath) === root, "The configured source root changed during capture.", "SOURCE_CHANGED");
    const verifier = new NativeFiles(root, maxBytes);
    const current = await discover(verifier, input.harnessSessionId);
    requireSource(current.fingerprint === discovery.fingerprint, "The native source selection changed during capture.", "SOURCE_CHANGED");
    for (const editing of discovery.editing) {
      const contentsPath = `${editing.path.replaceAll("\\", "/")}/contents/`;
      const expected = captured
        .filter((source) => source.path.startsWith(contentsPath))
        .map((source) => source.path.slice(contentsPath.length))
        .sort();
      const actual = await verifier.list(join(editing.path, "contents"));
      requireSource(actual.length === expected.length && actual.every((name, index) => name === expected[index]),
        "The native editing dependency set changed during capture.", "SOURCE_CHANGED");
    }
    for (const previous of captured) {
      const checked = await verifier.read(previous.path);
      requireSource(checked.content === previous.content && checked.size === previous.size && checked.modified === previous.modified,
        "Native content changed during snapshot verification.", "SOURCE_CHANGED");
    }
    await verifier.assertUnchanged();
    await reader.assertUnchanged();
    return {
      format: NATIVE_SESSION_ARCHIVE_FORMAT,
      harness: { name: input.harness, version: "not-recorded" },
      harnessSessionId: input.harnessSessionId,
      capturedAt: now().toISOString(),
      sourceFormat: discovery.selected.log ? "vscode-chat-session-v3-operation-log" : "vscode-chat-session-v3-json",
      scope: "persisted-session-records",
      resumable: false,
      files,
      redactions: redactor.redactions,
      capture: {
        boundary: "observed-prefixes",
        entrypoint: primary.path,
        selection: "native-id",
        layout: "harness-home",
        sources: captured.map((source) => ({
          path: source.path,
          capturedBytes: source.capturedSize,
          observedBytes: source.observedSize,
          sha256: createHash("sha256").update(sourceBytes(source)).digest("hex"),
          snapshot: source.snapshotKind,
        })),
        history: [{ path: primary.path, sessionId: input.harnessSessionId }],
        diagnostics: [],
      },
      restoration: {
        status: "not-verified",
        reason: "Native source files are preserved; activation requires a compatible harness, source registration, workspace and recipient configuration. The registry never resumes the producer to capture it.",
      },
    };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new NativeCaptureError("SESSION_NOT_FOUND", "The configured VS Code source or a required native session file is missing.");
  }
}
