import { lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  NativeCaptureError,
  NativeFiles,
  isMissingFile,
  isNativeObject,
  parseRecords,
  sourceBytes,
  type NativeObject,
  type NativeValue,
  type SourceFile,
} from "./files.js";
import {
  CODEX_SOURCE_PROFILE,
  codexSqliteHome,
  observeCodexState,
  type CodexStateObservation,
} from "./codexState.js";

export interface CodexCapturePlan {
  readonly primary: SourceFile;
  readonly harnessVersion: string;
  readonly sourceFormat: string;
  readonly streams: readonly SourceFile[];
  readonly selection: "native-id" | "explicit-path" | "sqlite";
  readonly history: readonly {
    readonly path: string;
    readonly sessionId: string;
    readonly rolloutId?: string;
    readonly endByteOffset?: number;
    readonly endOrdinalExclusive?: number;
  }[];
  readonly allowedDependencies: readonly string[];
  readonly assertUnchanged: () => Promise<void>;
  readonly diagnostics: readonly { readonly code: string; readonly source: string; readonly line?: number }[];
  readonly selectionEvidence: readonly {
    readonly profile: string;
    readonly sessionId: string;
    readonly path: string;
    readonly rolloutId: string;
    readonly selection: CodexCapturePlan["selection"];
    readonly databasePath?: string;
    readonly row?: CodexStateObservation["row"];
  }[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_ID = new RegExp(`^${UUID}$`, "i");
const ROLLOUT_NAME = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, "i",
);
const MAX_SOURCES = 10_000;
const MAX_DEPTH = 128;
const ROLLOUT_TYPES = new Set([
  "session_meta", "response_item", "event_msg", "compacted", "turn_context",
  "inter_agent_communication", "inter_agent_communication_metadata", "token_usage_record",
  "world_state", "security_risk_score", "retained_context", "realtime_item",
]);
// These describe ordinal evidence, not an archival admission list. Unknown
// records are retained, but Codex's decoder does not advance their ordinals.
// https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/protocol.rs#L1351-L1572
const EVENT_TYPES = new Set(`
  error warning auth_recovery_started auth_recovery_completed guardian_warning
  realtime_conversation_started realtime_conversation_realtime realtime_conversation_closed
  realtime_conversation_sdp model_reroute model_verification turn_moderation_metadata
  safety_buffering context_compacted thread_rolled_back task_started turn_started
  thread_settings_applied task_complete turn_complete token_count agent_message user_message
  agent_reasoning agent_reasoning_raw_content agent_reasoning_section_break session_configured
  environment_connected environment_disconnected thread_goal_updated thread_queue_changed
  mcp_startup_update mcp_startup_complete mcp_tool_call_begin mcp_tool_call_end web_search_begin
  web_search_end image_generation_begin image_generation_end exec_command_begin exec_command_output_delta
  terminal_interaction exec_command_end view_image_tool_call exec_approval_request request_permissions
  request_user_input dynamic_tool_call_request dynamic_tool_call_response elicitation_request
  apply_patch_approval_request guardian_assessment deprecation_notice stream_error patch_apply_begin
  patch_apply_updated patch_apply_end turn_diff realtime_conversation_list_voices_response plan_update
  turn_aborted shutdown_complete entered_review_mode exited_review_mode raw_response_item
  raw_response_completed item_started item_completed hook_started hook_completed agent_message_content_delta
  plan_delta reasoning_content_delta reasoning_raw_content_delta collab_agent_spawn_begin
  collab_agent_spawn_end collab_agent_interaction_begin collab_agent_interaction_end collab_waiting_begin
  collab_waiting_end collab_close_begin collab_close_end collab_resume_begin collab_resume_end sub_agent_activity
`.trim().split(/\s+/));
const TURN_ITEM_TYPES = new Set(`
  UserMessage FunctionCallOutput HookPrompt AgentMessage Plan Reasoning CommandExecution
  DynamicToolCall CollabAgentToolCall SubAgentActivity WebSearch ImageView Extension
  ImageGeneration EnteredReviewMode ExitedReviewMode FileChange McpToolCall ContextCompaction
`.trim().split(/\s+/));

interface RolloutName {
  readonly threadId: string;
  readonly rolloutId: string;
}

interface HistoryBase {
  readonly threadId: string;
  readonly endByteOffset: number;
  readonly endOrdinalExclusive: number;
}

interface RecordLine {
  readonly value: NativeObject;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
  readonly known: boolean;
  readonly ordinal?: number;
}

interface Rollout {
  readonly source: SourceFile;
  readonly bytes: Buffer;
  readonly metadata: NativeObject;
  readonly metadataLine: RecordLine;
  readonly id: string;
  readonly version: string;
  readonly rolloutId: string;
  readonly historyMode: "legacy" | "paginated";
  readonly base?: HistoryBase;
  readonly childStart?: number;
  readonly records: readonly RecordLine[];
  readonly diagnostics: CodexCapturePlan["diagnostics"];
}

interface Selection {
  readonly id: string;
  readonly path: string;
  readonly requestedPath?: string;
  readonly kind: CodexCapturePlan["selection"];
  readonly state?: CodexStateObservation;
}

interface ChildReference {
  readonly id: string;
  readonly strong: boolean;
}

function threadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID.test(value);
}

function ordinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function parseRolloutName(path: string): RolloutName | undefined {
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/rollout/src/rollout_file_name.rs#L10-L73
  const match = ROLLOUT_NAME.exec(basename(path));
  if (match === null) return undefined;
  const time = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  const date = new Date(`${time}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== time) return undefined;
  return { threadId: match[2]!, rolloutId: match[3] ?? match[2]! };
}

function nativePath(path: string): void {
  const name = basename(path);
  if (name.startsWith(".") || !/\.jsonl(?:\.zst)?$/.test(name)) {
    throw new NativeCaptureError("UNSUPPORTED_FORMAT",
      "Select a native Codex .jsonl or .jsonl.zst rollout, not a rendered export or a staging file.");
  }
}

async function existingRollout(reader: NativeFiles, path: string): Promise<string | undefined> {
  nativePath(path);
  const plain = path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path;
  // The same rule applies to explicitly selected and SQLite-selected paths.
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/rollout/src/compression.rs#L976-L991
  for (const candidate of [plain, `${plain}.zst`]) {
    if (await reader.exists(candidate)) {
      const absolute = await reader.resolve(candidate);
      if ((await lstat(absolute)).isFile()) return absolute;
    }
  }
  return undefined;
}

async function rolloutInventory(reader: NativeFiles): Promise<readonly string[]> {
  const paths: string[] = [];
  let entries = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 12) throw new NativeCaptureError("SOURCE_LIMIT", "Codex's rollout directory nesting exceeds the capture limit.");
    if (!(await reader.exists(directory))) return;
    for (const name of await reader.list(directory)) {
      if (++entries > MAX_SOURCES) throw new NativeCaptureError("SOURCE_LIMIT", "Codex's rollout inventory exceeds the capture limit.");
      const path = join(directory, name);
      const info = await lstat(resolve(reader.root, path));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!name.startsWith(".")) await visit(path, depth + 1);
      } else if (info.isFile() && parseRolloutName(path) !== undefined) {
        paths.push(path);
      }
    }
  }
  await visit("sessions", 0);
  await visit("archived_sessions", 0);
  const plainPaths = new Set(paths.filter((path) => path.endsWith(".jsonl")));
  return paths.filter((path) => !path.endsWith(".jsonl.zst") || !plainPaths.has(path.slice(0, -4)));
}

function oneRollout(paths: readonly string[], id: string, inherited: boolean): string {
  if (paths.length === 0) {
    throw new NativeCaptureError(inherited ? "INCOMPLETE_SOURCE" : "SESSION_NOT_FOUND",
      `${inherited ? "Required ancestor rollout" : "Codex thread"} ${id} has no native rollout in sessions or archived_sessions.`);
  }
  if (paths.length !== 1) {
    throw new NativeCaptureError(inherited ? "AMBIGUOUS_LINEAGE" : "AMBIGUOUS_SESSION",
      `${id} matches multiple concrete rollouts. Supply the producing client's selected sourcePath or SQLite home; no timestamp or newest filename was guessed.`);
  }
  return paths[0]!;
}

function historyBase(metadata: NativeObject): HistoryBase | undefined {
  const base = metadata.history_base;
  if (base === undefined || base === null) return undefined;
  if (!isNativeObject(base) || !threadId(base.thread_id) ||
      !ordinal(base.end_ordinal_exclusive) || base.end_ordinal_exclusive === 0 ||
      !ordinal(base.end_byte_offset) || base.end_byte_offset === 0) {
    throw new NativeCaptureError("UNSUPPORTED_LINEAGE",
      "Codex history_base must identify a rollout UUID and positive, exact decoded-byte and exclusive-ordinal boundaries.");
  }
  return {
    threadId: base.thread_id,
    endByteOffset: base.end_byte_offset,
    endOrdinalExclusive: base.end_ordinal_exclusive,
  };
}

function knownEnvelope(value: NativeObject): boolean {
  if (typeof value.type !== "string" || !ROLLOUT_TYPES.has(value.type) || typeof value.timestamp !== "string") return false;
  if (value.ordinal !== undefined && value.ordinal !== null && !ordinal(value.ordinal)) return false;
  const payload = value.payload;
  if (!isNativeObject(payload)) return false;
  if (value.type === "session_meta") return threadId(payload.id) && typeof payload.cli_version === "string";
  if (value.type === "event_msg") {
    if (typeof payload.type !== "string" || !EVENT_TYPES.has(payload.type)) return false;
    if (payload.type === "item_started" || payload.type === "item_completed") {
      return threadId(payload.thread_id) && typeof payload.turn_id === "string" &&
        isNativeObject(payload.item) && typeof payload.item.type === "string" && TURN_ITEM_TYPES.has(payload.item.type);
    }
  }
  // ResponseItem has a native serde(other) variant, unlike EventMsg/TurnItem.
  return value.type !== "response_item" || typeof payload.type === "string";
}

function nativeOrdinalSpelling(text: string, value: NativeObject): boolean {
  if (value.ordinal === undefined || value.ordinal === null) return true;
  if (!ordinal(value.ordinal)) return false;
  // Native u64 decoding rejects 1.0/1e0, although JSON.parse turns both into 1.
  // Inspect only top-level keys, including escaped/duplicate ordinal keys.
  let depth = 0;
  let valid = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") end += 2;
        else if (text[end] === '"') break;
        else end++;
      }
      let next = end + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (depth === 1 && text[next] === ":" && JSON.parse(text.slice(index, end + 1)) === "ordinal") {
        valid = /^\s*(?:0|[1-9][0-9]*)(?=\s*[,}])/.test(text.slice(next + 1));
      }
      index = end;
    }
  }
  return valid;
}

function inspectRollout(source: SourceFile, expectedId?: string, requiredPrefix = false): Rollout {
  const bytes = sourceBytes(source);
  const records: RecordLine[] = [];
  const diagnostics: Array<CodexCapturePlan["diagnostics"][number]> = [];
  const diagnostic = (code: string, line: number) => diagnostics.push({ code, source: source.path, line });
  let start = 0;
  let line = 0;
  while (start < bytes.length) {
    line++;
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    const terminated = newline >= 0;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      diagnostic("invalid-utf8", line);
      if (!terminated) diagnostic("unterminated-record", line);
      start = end;
      continue;
    }
    if (start === 0) text = text.replace(/^\uFEFF/, "");
    if (!terminated) diagnostic("unterminated-record", line);
    if (text.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        diagnostic("invalid-json", line);
      }
      if (value !== undefined) {
        if (isNativeObject(value)) {
          const exactOrdinal = nativeOrdinalSpelling(text, value);
          const known = knownEnvelope(value) && exactOrdinal;
          if (!known) diagnostic("codex-unknown-record", line);
          records.push({
            value, line, start, end, terminated, known,
            ...(exactOrdinal && ordinal(value.ordinal) ? { ordinal: value.ordinal } : {}),
          });
        } else diagnostic("non-object-record", line);
      }
    }
    start = end;
  }
  const first = records.find(({ value, known }) => known && value.type === "session_meta" && isNativeObject(value.payload));
  if (first === undefined || !isNativeObject(first.value.payload) ||
      !threadId(first.value.payload.id) || typeof first.value.payload.cli_version !== "string" ||
      !first.value.payload.cli_version.trim()) {
    throw new NativeCaptureError(requiredPrefix ? "INCOMPLETE_SOURCE" : "UNSUPPORTED_FORMAT",
      `No decoded Codex session_meta with a thread identity and cli_version was found in ${source.path}.`);
  }
  const metadata = first.value.payload;
  const id = metadata.id as string;
  const name = parseRolloutName(source.absolutePath);
  if ((expectedId !== undefined && id !== expectedId) || (name !== undefined && name.threadId !== id)) {
    throw new NativeCaptureError("SESSION_ID_MISMATCH",
      `The first decoded session_meta or canonical filename in ${source.path} belongs to a different stable thread.`);
  }
  const mode = metadata.history_mode === undefined ? "legacy" : metadata.history_mode;
  if (mode !== "legacy" && mode !== "paginated") {
    throw new NativeCaptureError("UNSUPPORTED_FORMAT", `Unknown Codex history_mode in ${source.path}; select a supported native source profile.`);
  }
  if (mode === "paginated" && name === undefined) {
    throw new NativeCaptureError("UNSUPPORTED_FORMAT",
      `Paginated source ${source.path} needs its canonical rollout filename, including its immutable version ID.`);
  }
  const base = historyBase(metadata);
  if (base !== undefined && mode !== "paginated") {
    throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "A referenced history_base requires the paginated Codex source profile.");
  }
  const childStart = metadata.subagent_history_start_ordinal;
  if (childStart !== undefined && childStart !== null && !ordinal(childStart)) {
    throw new NativeCaptureError("UNSUPPORTED_LINEAGE", "The copied subagent history boundary is not an exact nonnegative ordinal.");
  }
  if (mode === "paginated") {
    let next = base?.endOrdinalExclusive ?? 0;
    for (const record of records) {
      if (!record.known || !record.terminated) continue;
      if (record.ordinal === undefined) diagnostic("codex-missing-ordinal", record.line);
      else if (record.ordinal < next) diagnostic("codex-duplicate-or-regressed-ordinal", record.line);
      else {
        if (record.ordinal > next) diagnostic("codex-ordinal-gap", record.line);
        next = record.ordinal + 1;
      }
    }
  }
  return {
    source, bytes, metadata, metadataLine: first, id, version: first.value.payload.cli_version,
    rolloutId: name?.rolloutId ?? id,
    historyMode: mode, base, records, diagnostics,
    ...(ordinal(childStart) ? { childStart } : {}),
  };
}

function nextOrdinal(rollout: Rollout, endByteOffset: number, exclusive?: number): number {
  let next = rollout.base?.endOrdinalExclusive ?? 0;
  for (const record of rollout.records) {
    if (record.end > endByteOffset || !record.terminated || !record.known || record.ordinal === undefined) continue;
    if (record.ordinal < next) continue;
    if (exclusive !== undefined && record.ordinal >= exclusive) {
      throw new NativeCaptureError("INVALID_SOURCE_BOUNDARY",
        `The byte cutoff in ${rollout.source.path} includes ordinal ${record.ordinal}, outside the inherited exclusive boundary ${exclusive}.`);
    }
    next = record.ordinal + 1;
  }
  return next;
}

function validatePrefix(rollout: Rollout, boundary: HistoryBase): void {
  // Metadata itself uses base.end_ordinal_exclusive (or 0), not physical line 0.
  // A local segment starts at that ordinal + 1, even for an empty intermediate fork.
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/rollout/src/ordinal.rs#L21-L51
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/thread-store/src/local/rollout_lineage.rs#L154-L179
  const { endByteOffset, endOrdinalExclusive } = boundary;
  if (rollout.historyMode !== "paginated" || rollout.rolloutId !== boundary.threadId) {
    throw new NativeCaptureError("INVALID_LINEAGE", "An inherited prefix must belong to the referenced paginated rollout version, not merely its stable thread.");
  }
  if (endByteOffset > rollout.bytes.length) {
    throw new NativeCaptureError("INCOMPLETE_SOURCE", `Required decoded bytes are missing from ancestor ${rollout.source.path}.`);
  }
  if (rollout.bytes[endByteOffset - 1] !== 10) {
    throw new NativeCaptureError("INVALID_SOURCE_BOUNDARY", `The inherited cutoff in ${rollout.source.path} is not after a complete newline-terminated JSONL record.`);
  }
  const initial = rollout.base?.endOrdinalExclusive ?? 0;
  if (!rollout.metadataLine.terminated || rollout.metadataLine.end > endByteOffset ||
      rollout.metadataLine.ordinal !== initial || endOrdinalExclusive <= initial) {
    throw new NativeCaptureError("INCOMPLETE_SOURCE", `Ancestor ${rollout.source.path} does not contain the required metadata/ordinal prefix.`);
  }
  // Gaps, duplicates, and undecodable optional records are native projection
  // diagnostics, not reasons to count physical lines or discard source bytes.
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/thread-store/src/local/thread_history_materialization.rs#L132-L276
  if (nextOrdinal(rollout, endByteOffset, endOrdinalExclusive) !== endOrdinalExclusive) {
    throw new NativeCaptureError("INCOMPLETE_SOURCE",
      `Ancestor ${rollout.source.path} does not reach required ordinal ${endOrdinalExclusive - 1} at its declared byte cutoff.`);
  }
}

function validateCopiedPrefix(rollout: Rollout): void {
  if (rollout.historyMode === "paginated" && rollout.childStart !== undefined &&
      nextOrdinal(rollout, rollout.bytes.length) < rollout.childStart) {
    throw new NativeCaptureError("INCOMPLETE_SOURCE",
      `Copied subagent history in ${rollout.source.path} is incomplete before ordinal ${rollout.childStart}; retry after native initialization finishes.`);
  }
}

function parentId(metadata: NativeObject): string | undefined {
  const source = metadata.source;
  const subagent = isNativeObject(source) ? source.subagent : undefined;
  const spawn = isNativeObject(subagent) ? subagent.thread_spawn : undefined;
  const legacyParent = isNativeObject(spawn) ? spawn.parent_thread_id : undefined;
  const directParent = metadata.parent_thread_id;
  for (const value of [directParent, legacyParent]) {
    if (value !== undefined && value !== null && !threadId(value)) {
      throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", "A recorded Codex subagent parent is not a native thread UUID.");
    }
  }
  if (typeof directParent === "string" && typeof legacyParent === "string" && directParent !== legacyParent) {
    throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", "Codex subagent metadata records conflicting parents.");
  }
  return typeof directParent === "string" ? directParent : typeof legacyParent === "string" ? legacyParent : undefined;
}

function outputObjects(output: NativeValue | undefined): NativeObject[] {
  if (typeof output === "string") {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
    return isNativeObject(value) ? [value] : [];
  }
  if (Array.isArray(output)) {
    return output.flatMap((part) => isNativeObject(part) && part.type === "input_text" && typeof part.text === "string"
      ? outputObjects(part.text) : []);
  }
  return [];
}

function childReferences(rollout: Rollout): readonly ChildReference[] {
  const children = new Map<string, boolean>();
  const calls = new Set<string>();
  const outputs: NativeValue[] = [];
  const add = (value: unknown, strong: boolean) => {
    if (!threadId(value)) {
      throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", "A completed native spawn refers to an invalid child thread UUID.");
    }
    // A full-context child can inherit the parent's output naming this very child.
    if (!strong && value === rollout.id) return;
    children.set(value, strong || children.get(value) === true);
  };
  // Child containment follows decoded source evidence, not projected turns:
  // a complete final JSON record can establish a spawn without a final newline.
  const local = rollout.records.filter((record) => record.known &&
    (rollout.childStart === undefined || (record.ordinal !== undefined && record.ordinal >= rollout.childStart)));
  for (const { value } of local) {
    const payload = value.payload;
    if (!isNativeObject(payload)) continue;
    if (value.type === "event_msg" && payload.type === "collab_agent_spawn_end" &&
        payload.sender_thread_id === rollout.id && payload.new_thread_id !== undefined && payload.new_thread_id !== null) {
      add(payload.new_thread_id, true);
    }
    // Native TurnItem is PascalCase, its tool/status and fields are snake_case.
    // Communication, wait, resume, and root-session membership are NOT containment.
    // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/items.rs#L41-L55
    // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/items.rs#L306-L350
    if (value.type === "event_msg" && payload.type === "item_completed" &&
        payload.thread_id === rollout.id &&
        isNativeObject(payload.item) && payload.item.type === "CollabAgentToolCall" &&
        payload.item.tool === "spawn_agent" && payload.item.sender_thread_id === rollout.id) {
      const item = payload.item;
      if (Array.isArray(item.receiver_thread_ids)) for (const id of item.receiver_thread_ids) add(id, true);
      if (Array.isArray(item.receiver_agents)) {
        for (const agent of item.receiver_agents) if (isNativeObject(agent)) add(agent.thread_id, true);
      }
    }
    if (value.type === "response_item" && payload.type === "function_call" &&
        payload.name === "spawn_agent" && typeof payload.call_id === "string" &&
        typeof payload.arguments === "string") calls.add(payload.call_id);
  }
  for (const { value } of local) {
    const payload = value.payload;
    if (value.type === "response_item" && isNativeObject(payload) && payload.type === "function_call_output" &&
        typeof payload.call_id === "string" && calls.has(payload.call_id) && payload.output !== undefined) outputs.push(payload.output);
  }
  for (const output of outputs) {
    for (const value of outputObjects(output)) if (value.agent_id !== undefined) add(value.agent_id, false);
  }
  return [...children].map(([id, strong]) => ({ id, strong }));
}

function belongsToParent(child: Rollout, parent: Rollout, strong: boolean): boolean {
  const recordedParent = parentId(child.metadata);
  if (recordedParent !== undefined && recordedParent !== parent.id) {
    if (!strong) return false;
    throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP",
      `Spawned thread ${child.id} records parent ${recordedParent}, not ${parent.id}; unrelated source was not included.`);
  }
  const parentRoot = parent.metadata.session_id;
  const childRoot = child.metadata.session_id;
  if (threadId(parentRoot) && threadId(childRoot) && parentRoot !== childRoot) {
    if (!strong) return false;
    throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", `Spawned thread ${child.id} belongs to a different recorded root session.`);
  }
  return true;
}

async function resolveCapture(
  reader: NativeFiles,
  input: { harnessSessionId: string; sourcePath?: string; sqliteHome?: string },
  maxBytes: number,
): Promise<CodexCapturePlan> {
  if (!threadId(input.harnessSessionId)) {
    throw new NativeCaptureError("INVALID_SESSION_ID", "Codex capture requires the exact stable native thread UUID, not a name or rollout-version suffix.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new NativeCaptureError("SOURCE_LIMIT", "The native capture byte limit must be positive.");
  let inventory: readonly string[] | undefined;
  let sqliteHome: string | undefined;
  const retained = new Map<string, Rollout>();
  const selected = new Map<string, {
    readonly selection: Selection;
    readonly rollout: Rollout;
    readonly parentId?: string;
  }>();
  const ancestors = new Map<string, string>();
  const checkedThreads = new Set<string>();
  const history: Array<CodexCapturePlan["history"][number]> = [];
  const active = new Set<string>();

  async function noMigration(id: string, files = reader): Promise<void> {
    // This journal covers publication before SQLite's mode/path update finishes.
    // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/thread-store/src/local/rollout_migration/publish.rs#L1-L43
    if (await files.exists(join("rollout-migrations", `${id}.pending`))) {
      throw new NativeCaptureError("SOURCE_MIGRATION_PENDING",
        `Codex thread ${id} has an unsettled rollout-migrations journal. Let the producing client finish recovery and retry; capture will not migrate it.`);
    }
    checkedThreads.add(id);
  }

  async function candidates(id: string, inherited: boolean): Promise<string> {
    inventory ??= await rolloutInventory(reader);
    const matches = inventory.filter((path) => {
      const name = parseRolloutName(path)!;
      return (inherited ? name.rolloutId : name.threadId) === id;
    });
    return await reader.resolve(oneRollout(matches, id, inherited));
  }

  async function select(id: string, explicit?: string, checkMigration = true): Promise<Selection> {
    if (checkMigration) await noMigration(id);
    if (explicit !== undefined) {
      const path = await existingRollout(reader, explicit);
      if (path === undefined) throw new NativeCaptureError("SESSION_NOT_FOUND", "The explicitly selected Codex rollout is missing; no other source was substituted.");
      return { id, path, requestedPath: explicit, kind: "explicit-path" };
    }
    sqliteHome ??= await codexSqliteHome(reader.root, input.sqliteHome, maxBytes);
    const state = await observeCodexState(sqliteHome, id, maxBytes);
    if (state.row !== null) {
      const path = await existingRollout(reader, state.row.rollout_path);
      if (path !== undefined) {
        const name = parseRolloutName(path);
        if (name === undefined || name.threadId === id) return { id, path, kind: "sqlite", state };
        if (state.row.history_mode === "paginated") {
          throw new NativeCaptureError("SESSION_ID_MISMATCH", "Codex's authoritative paginated rollout path identifies a different stable thread.");
        }
      }
      if (state.row.history_mode === "paginated") {
        throw new NativeCaptureError("INCOMPLETE_SOURCE",
          `SQLite selects missing paginated rollout ${state.row.rollout_path} for ${id}. Restore that selected source or provide the producing client's current sourcePath; older versions were not substituted.`);
      }
    }
    return { id, path: await candidates(id, false), kind: "native-id", state };
  }

  async function probeMetadata(selection: Selection): Promise<Rollout> {
    // Copied legacy tool outputs have no sender field. Inspect their candidate's
    // metadata before charging/capturing a potentially unrelated, very large thread.
    const probe = new NativeFiles(reader.root, maxBytes);
    const path = await probe.resolve(selection.path);
    const size = (await lstat(path)).size;
    const compressed = path.endsWith(".jsonl.zst");
    let amount = Math.min(size, 4096, maxBytes);
    for (;;) {
      let source: SourceFile;
      let complete = !compressed && amount === size;
      try {
        source = await probe.read(path, { endByteOffset: amount });
      } catch (error) {
        if (!(error instanceof NativeCaptureError) || error.code !== "INCOMPLETE_SOURCE" || !compressed) throw error;
        // A small compressed file can decode to fewer bytes than the probe size.
        source = await probe.read(path);
        complete = true;
      }
      if (parseRecords(source).some((value) => value.type === "session_meta" && knownEnvelope(value)) || complete) {
        await probe.assertUnchanged();
        return inspectRollout(source, selection.id);
      }
      if (amount >= maxBytes || amount === 0) {
        throw new NativeCaptureError("SOURCE_LIMIT", "A legacy spawn candidate's metadata exceeds the bounded inspection limit.");
      }
      amount = Math.min(amount * 2, maxBytes, compressed ? Number.MAX_SAFE_INTEGER : size);
    }
  }

  async function readRollout(path: string, expectedId?: string, boundary?: HistoryBase): Promise<Rollout> {
    const prior = retained.get(path);
    const rollout = prior !== undefined && boundary !== undefined && prior.bytes.length >= boundary.endByteOffset
      ? prior
      : inspectRollout(await reader.read(path, boundary === undefined ? {} : { endByteOffset: boundary.endByteOffset }), expectedId, boundary !== undefined);
    if (expectedId !== undefined && rollout.id !== expectedId) {
      throw new NativeCaptureError("SESSION_ID_MISMATCH", "A selected Codex rollout belongs to another stable thread.");
    }
    await noMigration(rollout.id);
    if (boundary !== undefined) validatePrefix(rollout, boundary);
    return rollout;
  }

  function retain(rollout: Rollout): void {
    const previous = retained.get(rollout.source.absolutePath);
    if (previous === undefined || previous.bytes.length < rollout.bytes.length) retained.set(rollout.source.absolutePath, rollout);
    if (retained.size > MAX_SOURCES) throw new NativeCaptureError("SOURCE_LIMIT", "The Codex dependency closure has too many sources.");
  }

  async function lineage(rollout: Rollout): Promise<void> {
    const segments: Array<CodexCapturePlan["history"][number]> = [];
    const seen = new Set<string>();
    let current = rollout;
    let end: HistoryBase | undefined;
    for (;;) {
      if (seen.size >= MAX_DEPTH) throw new NativeCaptureError("SOURCE_LIMIT", "Codex history ancestry exceeds the capture limit.");
      if (seen.has(current.rolloutId)) throw new NativeCaptureError("INVALID_LINEAGE", "Codex history_base contains a rollout dependency cycle.");
      seen.add(current.rolloutId);
      retain(current);
      segments.push({
        path: current.source.path, sessionId: current.id, rolloutId: current.rolloutId,
        ...(end === undefined ? {} : { endByteOffset: end.endByteOffset, endOrdinalExclusive: end.endOrdinalExclusive }),
      });
      if (current.base === undefined) break;
      end = current.base;
      if (seen.has(end.threadId)) throw new NativeCaptureError("INVALID_LINEAGE", "Codex history_base contains a rollout dependency cycle.");
      const path = await candidates(end.threadId, true);
      ancestors.set(end.threadId, path);
      current = await readRollout(path, undefined, end);
    }
    history.push(...segments.reverse());
  }

  async function visit(id: string, parent?: Rollout, reference?: ChildReference): Promise<void> {
    if (active.has(id)) {
      if (reference?.strong === false) return;
      throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", "Codex's typed child references contain a containment cycle.");
    }
    const previous = selected.get(id);
    if (previous !== undefined) {
      if (parent !== undefined && previous.parentId !== parent.id) {
        if (reference?.strong === false) return;
        throw new NativeCaptureError("INVALID_CHILD_RELATIONSHIP", `Native spawns assign child ${id} to conflicting parent threads.`);
      }
      if (parent !== undefined) belongsToParent(previous.rollout, parent, reference?.strong ?? true);
      return;
    }
    if (active.size >= MAX_DEPTH) throw new NativeCaptureError("SOURCE_LIMIT", "Codex child nesting exceeds the capture limit.");
    let selection: Selection;
    try {
      selection = await select(id, parent === undefined ? input.sourcePath : undefined, reference?.strong !== false);
    } catch (error) {
      if (!(error instanceof NativeCaptureError) || error.code !== "SESSION_NOT_FOUND" || parent === undefined) throw error;
      throw new NativeCaptureError("MISSING_SUBAGENT", `Codex spawn in ${parent.source.path} requires child thread ${id}, whose native source is missing.`);
    }
    if (parent !== undefined && reference?.strong === false &&
        !belongsToParent(await probeMetadata(selection), parent, false)) return;
    const rollout = await readRollout(selection.path, id);
    if (parent !== undefined && !belongsToParent(rollout, parent, reference?.strong ?? true)) return;
    if (selection.kind === "sqlite" && selection.state?.row?.history_mode !== rollout.historyMode) {
      throw new NativeCaptureError("SOURCE_CHANGED", "Codex's selected SQLite history mode and rollout metadata disagree; retry after native migration/recovery settles.");
    }
    validateCopiedPrefix(rollout);
    selected.set(id, { selection, rollout, ...(parent === undefined ? {} : { parentId: parent.id }) });
    active.add(id);
    try {
      await lineage(rollout);
      for (const child of childReferences(rollout)) await visit(child.id, rollout, child);
    } finally {
      active.delete(id);
    }
  }

  await visit(input.harnessSessionId);
  const root = selected.get(input.harnessSessionId)!;

  async function assertUnchanged(): Promise<void> {
    await reader.assertUnchanged();
    const fresh = new NativeFiles(reader.root, maxBytes);
    for (const id of checkedThreads) await noMigration(id, fresh);
    if (sqliteHome !== undefined && await codexSqliteHome(reader.root, input.sqliteHome, maxBytes) !== sqliteHome) {
      throw new NativeCaptureError("SOURCE_CHANGED", "Codex's effective SQLite home changed during capture; retry with the producing client's current profile.");
    }
    let currentInventory: readonly string[] | undefined;
    async function currentCandidate(id: string, inherited: boolean): Promise<string> {
      currentInventory ??= await rolloutInventory(fresh);
      const matches = currentInventory.filter((path) => {
        const name = parseRolloutName(path)!;
        return (inherited ? name.rolloutId : name.threadId) === id;
      });
      if (matches.length !== 1) throw new NativeCaptureError("SOURCE_CHANGED", "Codex's selected rollout inventory changed during capture; retry without guessing a version.");
      return await fresh.resolve(matches[0]!);
    }
    for (const { selection } of selected.values()) {
      if (selection.state !== undefined) {
        const current = await observeCodexState(selection.state.home, selection.id, maxBytes);
        if (JSON.stringify(current.row) !== JSON.stringify(selection.state.row)) {
          throw new NativeCaptureError("SOURCE_CHANGED", `SQLite switched Codex thread ${selection.id}'s selected path or history mode during capture.`);
        }
      }
      const path = selection.kind === "native-id"
        ? await currentCandidate(selection.id, false)
        : await existingRollout(fresh, selection.requestedPath ?? selection.state!.row!.rollout_path);
      if (path !== selection.path) throw new NativeCaptureError("SOURCE_CHANGED", "The selected Codex rollout representation changed during capture; retry.");
    }
    for (const [id, path] of ancestors) {
      if (await currentCandidate(id, true) !== path) throw new NativeCaptureError("SOURCE_CHANGED", "A required Codex ancestor changed representation or location during capture.");
    }
    await reader.assertUnchanged();
  }

  const primary = retained.get(root.selection.path)!.source;
  const streams = [primary, ...[...retained.values()].map(({ source }) => source).filter((source) => source.absolutePath !== primary.absolutePath)];
  const allowedDependencies = [...new Set([...retained.values()].flatMap(({ id }) =>
    ["attachments", "artifacts", "generated_images", "tool-output", "tool-results"].map((directory) => join(reader.root, directory, id))))];
  return {
    primary, streams, selection: root.selection.kind, history, allowedDependencies,
    harnessVersion: root.rollout.version,
    sourceFormat: root.rollout.historyMode === "paginated" ? "codex-paginated-rollout-v1" : "codex-rollout-jsonl-v1",
    assertUnchanged: () => withSourceErrors(assertUnchanged),
    diagnostics: [...retained.values()].flatMap(({ diagnostics }) => diagnostics),
    selectionEvidence: [...selected.values()].map(({ selection, rollout }) => ({
      profile: CODEX_SOURCE_PROFILE, sessionId: rollout.id, path: rollout.source.path, rolloutId: rollout.rolloutId,
      selection: selection.kind,
      ...(selection.state === undefined ? {} : { databasePath: selection.state.databasePath, row: selection.state.row }),
    })),
  };
}

export async function resolveCodexCapture(
  reader: NativeFiles,
  input: { harnessSessionId: string; sourcePath?: string; sqliteHome?: string },
  maxBytes: number,
): Promise<CodexCapturePlan> {
  return withSourceErrors(() => resolveCapture(reader, input, maxBytes));
}

async function withSourceErrors<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string" &&
        ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "EBUSY", "ELOOP", "ENAMETOOLONG"].includes(error.code)) {
      throw new NativeCaptureError(isMissingFile(error) ? "SOURCE_CHANGED" : "SOURCE_READ_FAILED",
        "A selected Codex source disappeared or could not be read safely. Check the configured native/SQLite homes and retry; no partial capture was returned.");
    }
    throw error;
  }
}
