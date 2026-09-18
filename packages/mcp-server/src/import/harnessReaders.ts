import {
  buildImportBriefing,
  parseImportJsonl,
  type ImportBriefing,
  type ImportBriefingInput,
  type ImportInventoryItem,
  type NativeArchiveFile,
  type NativeHarness,
} from "@session-registry/core";

const MAX_RECORDS = 10_000;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_VALUE_LENGTH = 4_096;
const MAX_DEPTH = 32;
const PRECISION_MESSAGE = "unsafe JSON number";

export interface HarnessReaderInput {
  readonly harness: { readonly name: NativeHarness; readonly version: string };
  readonly capturedAt: string;
  readonly files: readonly Pick<NativeArchiveFile, "path" | "kind" | "content" | "recordCount" | "contentEncoding">[];
  readonly redactions?: readonly { readonly id: string; readonly category: string; readonly source: string }[];
  readonly sourceDisclosures?: readonly string[];
  readonly importingHarness?: NativeHarness;
}

function importedReference(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const leaf = normalized.split("/").at(-1) ?? "unnamed";
  return `[imported file: ${leaf.slice(0, MAX_VALUE_LENGTH)}]`;
}

interface ParsedRecord {
  readonly value: Record<string, unknown>;
  readonly file: string;
}

interface Projection {
  readonly records: readonly ParsedRecord[];
  readonly malformed: number;
  readonly disclosures: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depth(value: unknown, current = 0): number {
  if (current > MAX_DEPTH) return current;
  if (Array.isArray(value)) return Math.max(current, ...value.map((child) => depth(child, current + 1)));
  if (isRecord(value)) return Math.max(current, ...Object.values(value).map((child) => depth(child, current + 1)));
  return current;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

function textValue(value: unknown, current = 0): string | undefined {
  if (current > MAX_DEPTH) return undefined;
  const direct = text(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item, current + 1)).filter((item): item is string => item !== undefined).join("\n") || undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["text", "content", "message", "output"]) {
    const result = textValue(value[key], current + 1);
    if (result !== undefined) return result;
  }
  return undefined;
}

function nestedText(value: unknown, keys: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return textValue(current);
}

function parseFile(file: HarnessReaderInput["files"][number]): Projection {
  if (file.kind !== "events" || file.contentEncoding === "base64") {
    return { records: [], malformed: 0, disclosures: [`${file.kind} content is not queryable text.`] };
  }
  const lines = file.content.split(/\r?\n/).filter((line) => line.trim() !== "");
  const records: ParsedRecord[] = [];
  const disclosures: string[] = [];
  let malformed = 0;
  for (const line of lines.slice(0, MAX_RECORDS)) {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      malformed++;
      continue;
    }
    try {
      const parsed = parseImportJsonl(line);
      const value = parsed[0];
      if (!isRecord(value) || depth(value) > MAX_DEPTH) {
        malformed++;
        continue;
      }
      records.push({ value, file: file.path });
    } catch (error) {
      if (error instanceof Error && error.message.includes(PRECISION_MESSAGE)) throw error;
      malformed++;
    }
  }
  if (lines.length > MAX_RECORDS) disclosures.push("record cap reached; later records were not projected.");
  return { records, malformed, disclosures };
}

function categoryFor(harness: NativeHarness, record: Record<string, unknown>): string {
  const type = typeof record.type === "string" ? record.type : "";
  if (harness === "github-copilot-cli") {
    if (type === "user.message") return "user messages";
    if (type === "assistant.message" || type === "assistant.reasoning") return "assistant messages";
    if (type.startsWith("tool.execution")) return type === "tool.execution_start" ? "tool calls" : "command output";
    if (type === "session.error") return "errors";
    if (type.startsWith("system.")) return "system";
  } else if (harness === "claude-code") {
    if (type === "user") {
      const content = record.message;
      if (JSON.stringify(content).includes("tool_result")) return "command output";
      return "user messages";
    }
    if (type === "assistant") return "assistant messages";
    if (type === "progress") return "system";
    if (type === "system") return "system";
  } else {
    if (type === "response_item") {
      const payload = record.payload;
      if (isRecord(payload) && payload.type === "function_call") return "tool calls";
      if (isRecord(payload) && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) return "command output";
      if (isRecord(payload) && payload.type === "message") {
        const role = isRecord(payload) && typeof payload.role === "string" ? payload.role : "";
        return role === "user" ? "user messages" : "assistant messages";
      }
    }
    if (type === "event_msg" && isRecord(record.payload) && record.payload.type === "error") return "errors";
    if (type === "error" || type === "warning") return "errors";
  }
  return type === "" ? "unknown records" : "other records";
}

function contentFor(harness: NativeHarness, record: Record<string, unknown>): string | undefined {
  if (harness === "github-copilot-cli") {
    return nestedText(record, ["data", "content"]) ?? nestedText(record, ["data", "message"]) ??
      nestedText(record, ["data", "result", "content"]);
  }
  if (harness === "claude-code") {
    return nestedText(record, ["message", "content"]) ?? nestedText(record, ["data", "content"]);
  }
  return nestedText(record, ["payload", "content"]) ?? nestedText(record, ["payload", "output"]) ??
    nestedText(record, ["payload", "message"]);
}

function project(input: HarnessReaderInput): ImportBriefingInput {
  const projections = input.files.map(parseFile);
  const records = projections.flatMap((projection, index) =>
    projection.records.map((record) => ({ ...record, file: input.files[index]!.path })),
  );
  const counts = new Map<string, number>();
  for (const { value } of records) {
    const category = categoryFor(input.harness.name, value);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const inventory: ImportInventoryItem[] = [...counts.entries()].map(([category, count]) => ({ category, count }));
  const user = records.find(({ value }) => categoryFor(input.harness.name, value) === "user messages");
  const assistant = [...records].reverse().find(({ value }) => categoryFor(input.harness.name, value) === "assistant messages");
  const outputs = [...records].filter(({ value }) => categoryFor(input.harness.name, value) === "command output");
  const objective = user === undefined ? undefined : contentFor(input.harness.name, user.value);
  const outcome = assistant === undefined ? undefined : contentFor(input.harness.name, assistant.value);
  const verificationStatus = outputs.length === 0 ? undefined : outputs.some(({ value }) => JSON.stringify(value).match(/error|fail/i))
    ? "verification outcome imported as failed or incomplete"
    : "verification output imported";
  const filesTouched = records.flatMap(({ value }) => {
    const candidates = [value.filePath, value.path, nestedText(value, ["data", "filePath"])];
    return candidates
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length <= MAX_VALUE_LENGTH)
      .map(importedReference);
  });
  const disclosures = [
    ...(input.sourceDisclosures ?? []),
    ...(input.redactions ?? []).map((redaction) => `${redaction.category} redaction in an imported record`),
    ...projections.flatMap((projection) => projection.disclosures),
  ];
  return {
    harness: input.harness,
    capturedAt: input.capturedAt,
    files: input.files.map(({ path, kind, recordCount, content }) => ({
      path,
      kind,
      recordCount,
      bytes: Buffer.byteLength(content, "utf8"),
    })),
    inventory,
    ...(objective === undefined ? {} : { objective }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(filesTouched.length === 0 ? {} : { filesTouched: [...new Set(filesTouched)] }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
    disclosures,
    malformedRecords: projections.reduce((sum, projection) => sum + projection.malformed, 0),
    queryable: records.length > 0,
    ...(input.importingHarness === undefined ? {} : { importingHarness: input.importingHarness }),
  };
}

export function readHarnessProjection(input: HarnessReaderInput): ImportBriefing {
  return buildImportBriefing(project(input));
}

export const buildHarnessBriefing = readHarnessProjection;
