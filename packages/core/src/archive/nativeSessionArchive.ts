import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { NATIVE_HARNESSES, type NativeHarness } from "./nativeHarness.js";

export * from "./nativeHarness.js";

export const NATIVE_SESSION_ARCHIVE_FORMAT = "session-registry/native-session/3";
export const PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT = "session-registry/native-session/2";
export const LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT = "session-registry/native-session/1";
export const NATIVE_SESSION_VIEW_FORMAT = "session-registry/native-session-view/1";
export const NATIVE_SESSION_BUNDLE_POLICY = Object.freeze({
  unscannable: true,
  delivery: "standalone-download-only",
  includedInPortableBulkArchive: false,
  requiresOwnerAcknowledgment: true,
  requiresAcknowledgmentPerDownload: true,
} as const);
export const NATIVE_SESSION_BUNDLE_WARNING =
  "This standalone native-file bundle is unscanned download-only content, not a scanned portable bulk export. " +
  "Review of inspectable text does not establish the safety of the complete native package, binary files or embedded media. " +
  "The owner must explicitly accept this warning before publication, and collaborators must separately opt in before every native-bundle download. " +
  "All approved native bytes are retained in that separate package; it must be excluded from portable bulk archives.";
export const MAX_NATIVE_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_NATIVE_ARCHIVE_BYTES = 256 * 1024 * 1024;
export interface NativeArchiveFile {
  readonly path: string;
  readonly kind: "events" | "attachment";
  readonly content: string;
  readonly recordCount: number;
  readonly sha256: string;
  readonly contentEncoding?: "base64";
  readonly nativeEncoding?: "zstd";
  readonly nativeBytesBase64?: string;
  readonly nativeSha256?: string;
}

export interface NativeRedaction {
  readonly id: string;
  readonly category: string;
  readonly source: string;
}

export interface NativeRecordDiagnostic {
  readonly line: number;
  readonly code: string;
}

export interface NativeCapturedSource {
  readonly path: string;
  /** External-source provenance, never an instruction to read or extract at this path. */
  readonly originalPath?: string;
  readonly capturedBytes: number;
  readonly observedBytes: number;
  readonly sha256: string;
  readonly snapshot: "file-prefix" | "sqlite-backup" | "decoded-prefix";
}

export interface NativeHistorySegment {
  readonly path: string;
  readonly sessionId: string;
  readonly rolloutId?: string;
  readonly endByteOffset?: number;
  readonly endOrdinalExclusive?: number;
}

export interface NativeCaptureDiagnostic {
  readonly code: string;
  readonly source: string;
  readonly line?: number;
}

export interface NativeCaptureManifest {
  readonly boundary: "observed-prefixes";
  readonly entrypoint: string;
  readonly selection: "native-id" | "explicit-path" | "sqlite";
  readonly layout: "session-directory" | "harness-home";
  readonly sources: readonly NativeCapturedSource[];
  readonly history: readonly NativeHistorySegment[];
  readonly diagnostics: readonly NativeCaptureDiagnostic[];
}

export interface NativeRestoration {
  readonly status: "not-verified" | "invalidated-by-security-edits";
  readonly reason: string;
}

export interface NativeSessionArchive {
  readonly format: typeof NATIVE_SESSION_ARCHIVE_FORMAT | typeof PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT | typeof LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT;
  readonly harness: { readonly name: NativeHarness; readonly version: string };
  readonly harnessSessionId: string;
  readonly capturedAt: string;
  readonly sourceFormat: string;
  readonly scope: "persisted-session-records";
  readonly resumable: boolean;
  readonly files: readonly NativeArchiveFile[];
  readonly redactions: readonly NativeRedaction[];
  readonly capture?: NativeCaptureManifest;
  readonly restoration?: NativeRestoration;
}

export interface NativeArchiveViewFile extends Omit<NativeArchiveFile, "content" | "contentEncoding" | "nativeBytesBase64"> {
  readonly byteLength: number;
  readonly preview: { readonly kind: "text"; readonly content: string } | { readonly kind: "download-only" };
  readonly diagnostics: readonly NativeRecordDiagnostic[];
}

/** An explicitly partial view, never a substitute for the complete approved native package. */
export interface NativeSessionArchiveView extends Omit<NativeSessionArchive, "format" | "files"> {
  readonly format: typeof NATIVE_SESSION_VIEW_FORMAT;
  readonly archiveFormat: NativeSessionArchive["format"];
  readonly files: readonly NativeArchiveViewFile[];
  readonly nativeBundle: typeof NATIVE_SESSION_BUNDLE_POLICY & { readonly sha256: string; readonly byteLength: number };
}

export class NativeSessionArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeSessionArchiveError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new NativeSessionArchiveError(`Invalid native session archive: ${message}`);
  }
}

function relativePath(value: unknown, label: string): string {
  requireValid(nonemptyString(value), `${label} is required.`);
  const normalized = value.replaceAll("\\", "/");
  requireValid(
    !/^[a-z]:/i.test(normalized) && !/[\u0000-\u001f\u007f]/.test(normalized) &&
    normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    Buffer.from(value, "utf8").toString("utf8") === value,
    `${label} must be archive-relative UTF-8.`,
  );
  return normalized;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function base64Bytes(value: unknown, label: string): Buffer {
  requireValid(
    typeof value === "string" && value.length <= Math.ceil(MAX_NATIVE_ARCHIVE_FILE_BYTES / 3) * 4 &&
    value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value),
    `${label} must contain bounded base64 bytes.`,
  );
  const bytes = Buffer.from(value, "base64");
  requireValid(bytes.length <= MAX_NATIVE_ARCHIVE_FILE_BYTES && bytes.toString("base64") === value,
    `${label} is not canonical bounded base64.`);
  return bytes;
}

/** Decoded source bytes, before any optional native compression. */
export function nativeFileContentBytes(file: NativeArchiveFile): Buffer {
  return file.contentEncoding === "base64"
    ? base64Bytes(file.content, "file.content")
    : Buffer.from(file.content, "utf8");
}

/** Exact approved bytes for the native file, including its original compression. */
export function nativeFileBytes(file: NativeArchiveFile): Buffer {
  return file.nativeEncoding === "zstd"
    ? base64Bytes(file.nativeBytesBase64, "file.nativeBytesBase64")
    : nativeFileContentBytes(file);
}

function hasDuplicateJsonKeys(text: string): boolean {
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") objects.push(new Set());
    else if (char === "[") objects.push(null);
    else if (char === "}" || char === "]") objects.pop();
    else if (char === '"') {
      const start = index++;
      while (text[index] !== '"') {
        if (text[index] === "\\") index++;
        index++;
      }
      let after = index + 1;
      while (/\s/.test(text[after] ?? "") && after < text.length) after++;
      if (text[after] === ":") {
        const key: string = JSON.parse(text.slice(start, index + 1));
        const keys = objects.at(-1);
        if (keys?.has(key)) return true;
        keys?.add(key);
      }
    }
  }
  return false;
}

/**
 * A diagnostic projection, never an archival rewrite. Invalid lines and partial
 * tails remain in the caller's source bytes; parsed objects are not deduplicated.
 */
export function inspectNativeJsonl(bytes: Uint8Array): {
  readonly records: readonly Record<string, unknown>[];
  readonly diagnostics: readonly NativeRecordDiagnostic[];
  readonly completeBytes: number;
  readonly terminatedBytes: number;
} {
  const records: Record<string, unknown>[] = [];
  const diagnostics: NativeRecordDiagnostic[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let terminatedBytes = 0;
  let completeBytes = 0;
  let line = 0;
  let start = 0;
  for (let end = 0; end <= bytes.length; end++) {
    const terminated = end < bytes.length && bytes[end] === 10;
    if (!terminated && end !== bytes.length) continue;
    if (start === bytes.length) break;
    line++;
    if (terminated) completeBytes = terminatedBytes = end + 1;
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(start, end));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      diagnostics.push({ line, code: "invalid-utf8" });
      if (!terminated) diagnostics.push({ line, code: "partial-final-record" });
      start = end + 1;
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      diagnostics.push({ line, code: "invalid-json" });
      if (!terminated) diagnostics.push({ line, code: "partial-final-record" });
      start = end + 1;
      continue;
    }
    if (!terminated) completeBytes = end;
    if (hasDuplicateJsonKeys(text)) diagnostics.push({ line, code: "duplicate-key" });
    if (!isObject(record)) diagnostics.push({ line, code: "non-object" });
    else {
      records.push(record);
      if (!nonemptyString(record.type)) diagnostics.push({ line, code: "missing-type" });
    }
    start = end + 1;
  }
  return { records, diagnostics, completeBytes, terminatedBytes };
}

function parseCapture(value: unknown, files: readonly Pick<NativeArchiveFile, "path">[]): NativeCaptureManifest {
  requireValid(isObject(value), "capture must be an object for a V3 archive.");
  requireValid(value.boundary === "observed-prefixes", "capture.boundary must be observed-prefixes.");
  const paths = new Set(files.map((file) => relativePath(file.path, "file.path")));
  requireValid(paths.has(relativePath(value.entrypoint, "capture.entrypoint")), "capture.entrypoint must identify a captured file.");
  requireValid(value.selection === "native-id" || value.selection === "explicit-path" || value.selection === "sqlite",
    "capture.selection is invalid.");
  requireValid(value.layout === "session-directory" || value.layout === "harness-home", "capture.layout is invalid.");
  requireValid(Array.isArray(value.sources), "capture.sources must be an array.");
  requireValid(Array.isArray(value.history), "capture.history must be an array.");
  requireValid(Array.isArray(value.diagnostics), "capture.diagnostics must be an array.");
  const capturedPaths = new Set<string>();
  const sources: NativeCapturedSource[] = value.sources.map((source: unknown, index: number) => {
    const label = `capture.sources[${index}]`;
    requireValid(isObject(source), `${label} must be an object.`);
    const path = relativePath(source.path, `${label}.path`);
    requireValid(paths.has(path), `${label}.path must identify a captured file.`);
    requireValid(!capturedPaths.has(path), `${label}.path is duplicated.`);
    capturedPaths.add(path);
    requireValid(nonnegativeInteger(source.capturedBytes), `${label}.capturedBytes must be a nonnegative safe integer.`);
    requireValid(nonnegativeInteger(source.observedBytes), `${label}.observedBytes must be a nonnegative safe integer.`);
    requireValid(sha256(source.sha256), `${label}.sha256 must be a SHA-256 hex digest.`);
    requireValid(source.originalPath === undefined || (nonemptyString(source.originalPath) &&
      !source.originalPath.includes("\0") && Buffer.from(source.originalPath, "utf8").toString("utf8") === source.originalPath),
    `${label}.originalPath must be nonempty UTF-8 path metadata.`);
    requireValid(source.snapshot === "file-prefix" || source.snapshot === "sqlite-backup" || source.snapshot === "decoded-prefix",
      `${label}.snapshot is invalid.`);
    // Backups and decoded/recompressed prefixes are different representations
    // from the observed physical file; their byte lengths are not ordered.
    requireValid(source.snapshot !== "file-prefix" || source.capturedBytes <= source.observedBytes,
      `${label}.capturedBytes exceeds its observed prefix.`);
    return {
      path: source.path as string, capturedBytes: source.capturedBytes, observedBytes: source.observedBytes,
      sha256: source.sha256, snapshot: source.snapshot,
      ...(source.originalPath === undefined ? {} : { originalPath: source.originalPath as string }),
    };
  });
  requireValid(capturedPaths.size === paths.size, "capture.sources must describe every captured file.");
  const history: NativeHistorySegment[] = value.history.map((segment: unknown, index: number) => {
    const label = `capture.history[${index}]`;
    requireValid(isObject(segment), `${label} must be an object.`);
    requireValid(paths.has(relativePath(segment.path, `${label}.path`)), `${label}.path must identify a captured file.`);
    requireValid(nonemptyString(segment.sessionId), `${label}.sessionId is required.`);
    requireValid(segment.rolloutId === undefined || nonemptyString(segment.rolloutId), `${label}.rolloutId must be nonempty.`);
    requireValid(segment.endByteOffset === undefined || nonnegativeInteger(segment.endByteOffset), `${label}.endByteOffset is invalid.`);
    requireValid(segment.endOrdinalExclusive === undefined || nonnegativeInteger(segment.endOrdinalExclusive), `${label}.endOrdinalExclusive is invalid.`);
    return {
      path: segment.path as string, sessionId: segment.sessionId,
      ...(segment.rolloutId === undefined ? {} : { rolloutId: segment.rolloutId as string }),
      ...(segment.endByteOffset === undefined ? {} : { endByteOffset: segment.endByteOffset as number }),
      ...(segment.endOrdinalExclusive === undefined ? {} : { endOrdinalExclusive: segment.endOrdinalExclusive as number }),
    };
  });
  const diagnostics: NativeCaptureDiagnostic[] = value.diagnostics.map((diagnostic: unknown, index: number) => {
    const label = `capture.diagnostics[${index}]`;
    requireValid(isObject(diagnostic), `${label} must be an object.`);
    requireValid(typeof diagnostic.code === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(diagnostic.code), `${label}.code must be a diagnostic identifier.`);
    requireValid(nonemptyString(diagnostic.source), `${label}.source is required.`);
    requireValid(diagnostic.line === undefined || (nonnegativeInteger(diagnostic.line) && diagnostic.line > 0), `${label}.line is invalid.`);
    return {
      code: diagnostic.code, source: diagnostic.source,
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line as number }),
    };
  });
  return {
    boundary: value.boundary, entrypoint: value.entrypoint as string, selection: value.selection,
    layout: value.layout, sources, history, diagnostics,
  };
}

function parseRestoration(value: unknown): NativeRestoration {
  requireValid(isObject(value), "restoration must be an object for a V3 archive.");
  requireValid(value.status === "not-verified" || value.status === "invalidated-by-security-edits", "restoration.status is invalid.");
  requireValid(nonemptyString(value.reason), "restoration.reason is required.");
  return { status: value.status, reason: value.reason };
}

/** Native files being available says nothing about a tested activation procedure. */
export function hasNativeSessionBundle(archive: NativeSessionArchive | null | undefined): boolean {
  if (archive?.format === PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT) return archive.resumable;
  if (archive?.format !== NATIVE_SESSION_ARCHIVE_FORMAT || archive.resumable) return false;
  try {
    parseCapture(archive.capture, archive.files);
    parseRestoration(archive.restoration);
    return true;
  } catch (error) {
    if (!(error instanceof NativeSessionArchiveError)) throw error;
    return false;
  }
}

function hasNativeFormatMarker(content: string, prefix = "session-registry/native-session"): boolean {
  if (!/^\s*\{/.test(content)) return false;
  if (new RegExp(`"format"\\s*:\\s*"${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(content)) return true;
  // Decode complete string tokens so escaped keys/slashes also identify a damaged archive.
  for (const match of content.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      const marker: unknown = JSON.parse(match[2]!);
      if (JSON.parse(match[1]!) === "format" &&
          typeof marker === "string" && marker.startsWith(prefix)) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A malformed token cannot identify a format; inspect the remaining tokens.
    }
  }
  return false;
}

function parseMetadata(value: Record<string, unknown>, format: NativeSessionArchive["format"]) {
  requireValid(isObject(value.harness), "harness must be an object.");
  const harness = value.harness;
  const harnessName = NATIVE_HARNESSES.find((name) => name === harness.name);
  requireValid(harnessName !== undefined, "harness name is unsupported.");
  requireValid(nonemptyString(harness.version), "harness version is required.");
  requireValid(nonemptyString(value.harnessSessionId), "harnessSessionId is required.");
  requireValid(nonemptyString(value.capturedAt) && !Number.isNaN(Date.parse(value.capturedAt)), "capturedAt must be a timestamp.");
  requireValid(nonemptyString(value.sourceFormat), "sourceFormat is required.");
  requireValid(value.scope === "persisted-session-records", "scope must be persisted-session-records.");
  requireValid(typeof value.resumable === "boolean", "resumable must be a boolean.");
  requireValid(format !== LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT || !value.resumable, "legacy archives cannot be resumable.");
  requireValid(format !== NATIVE_SESSION_ARCHIVE_FORMAT || !value.resumable, "V3 archives cannot claim resumability from captured files.");
  return {
    harness: { name: harnessName, version: harness.version }, harnessSessionId: value.harnessSessionId,
    capturedAt: value.capturedAt, sourceFormat: value.sourceFormat, scope: value.scope, resumable: value.resumable,
  } as const;
}

function parseRedactions(value: unknown): NativeRedaction[] {
  requireValid(Array.isArray(value), "redactions must be an array.");
  const ids = new Set<string>();
  return value.map((redaction: unknown, index: number) => {
    requireValid(isObject(redaction), `redactions[${index}] must be an object.`);
    requireValid(nonemptyString(redaction.id), `redactions[${index}].id is required.`);
    requireValid(nonemptyString(redaction.category), `redactions[${index}].category is required.`);
    requireValid(nonemptyString(redaction.source), `redactions[${index}].source is required.`);
    requireValid(!ids.has(redaction.id), `redactions[${index}].id is duplicated.`);
    ids.add(redaction.id);
    return { id: redaction.id, category: redaction.category, source: redaction.source };
  });
}

/**
 * Returns null for non-archive content, including separate readable views. Native archive errors must not be
 * presented as a validated native capture. Checksums describe the approved
 * files, not the completeness or authenticity of the original source session.
 */
export function parseNativeSessionArchive(content: string): NativeSessionArchive | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (hasNativeFormatMarker(content)) {
      throw new NativeSessionArchiveError("Invalid native session archive: malformed JSON.");
    }
    return null;
  }

  if (!isObject(value) || typeof value.format !== "string" ||
      !value.format.startsWith("session-registry/native-session") || value.format.startsWith("session-registry/native-session-view/")) {
    return null;
  }
  if (value.format !== NATIVE_SESSION_ARCHIVE_FORMAT && value.format !== PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT &&
      value.format !== LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT) {
    throw new NativeSessionArchiveError(`Unsupported native session archive format: ${value.format}`);
  }

  const metadata = parseMetadata(value, value.format);
  requireValid(Array.isArray(value.files), "files must be an array.");
  requireValid(Array.isArray(value.redactions), "redactions must be an array.");

  const paths = new Set<string>();
  const files: NativeArchiveFile[] = [];
  let totalBytes = 0;
  for (const [index, file] of value.files.entries()) {
    const label = `files[${index}]`;
    requireValid(isObject(file), `${label} must be an object.`);
    const normalizedPath = relativePath(file.path, `${label}.path`);
    requireValid(!paths.has(normalizedPath), `${label}.path is duplicated.`);
    paths.add(normalizedPath);
    requireValid(file.kind === "events" || file.kind === "attachment", `${label}.kind is invalid.`);
    requireValid(typeof file.content === "string", `${label}.content must be a string.`);
    requireValid(file.contentEncoding === undefined || (value.format === NATIVE_SESSION_ARCHIVE_FORMAT && file.contentEncoding === "base64"),
      `${label}.contentEncoding must be base64 in a V3 archive.`);
    const contentBytes = file.contentEncoding === "base64"
      ? base64Bytes(file.content, `${label}.content`)
      : Buffer.from(file.content, "utf8");
    requireValid(contentBytes.length <= MAX_NATIVE_ARCHIVE_FILE_BYTES, `${label}.content exceeds the file size limit.`);
    totalBytes += contentBytes.length;
    requireValid(totalBytes <= MAX_NATIVE_ARCHIVE_BYTES, "files exceed the total archive size limit.");
    requireValid(file.contentEncoding === "base64" || contentBytes.toString("utf8") === file.content,
      `${label}.content must round-trip as UTF-8.`);
    requireValid(nonnegativeInteger(file.recordCount), `${label}.recordCount must be a nonnegative safe integer.`);
    requireValid(sha256(file.sha256), `${label}.sha256 must be a SHA-256 hex digest.`);
    requireValid(
      createHash("sha256").update(contentBytes).digest("hex") === file.sha256.toLowerCase(),
      `${label}.sha256 does not match its approved content.`,
    );
    const compressed = file.nativeEncoding !== undefined || file.nativeBytesBase64 !== undefined || file.nativeSha256 !== undefined;
    if (compressed) {
      requireValid(value.format !== LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT, `${label}.nativeEncoding requires a V2 or V3 archive.`);
      requireValid(file.nativeEncoding === "zstd" && (value.format === NATIVE_SESSION_ARCHIVE_FORMAT || file.kind === "events"),
        `${label}.nativeEncoding must be zstd (V2 requires an event source).`);
      requireValid(sha256(file.nativeSha256), `${label}.nativeSha256 must be a SHA-256 hex digest.`);
      const nativeBytes = base64Bytes(file.nativeBytesBase64, `${label}.nativeBytesBase64`);
      requireValid(nativeBytes.length > 0, `${label}.nativeBytesBase64 cannot be empty.`);
      totalBytes += nativeBytes.length;
      requireValid(totalBytes <= MAX_NATIVE_ARCHIVE_BYTES, "files exceed the total archive size limit.");
      requireValid(createHash("sha256").update(nativeBytes).digest("hex") === file.nativeSha256.toLowerCase(),
        `${label}.nativeSha256 does not match its native bytes.`);
      if (typeof zlib.zstdDecompressSync !== "function") {
        throw new NativeSessionArchiveError("Unsupported runtime: native Zstd archives require Node.js with Zstd decompression support.");
      }
      let decoded: Buffer;
      try {
        decoded = zlib.zstdDecompressSync(nativeBytes, { maxOutputLength: Math.max(1, contentBytes.length) });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new NativeSessionArchiveError(`Invalid native session archive: ${label} cannot be decompressed within its declared content size.`);
      }
      requireValid(decoded.equals(contentBytes), `${label}.nativeBytesBase64 does not decode to its approved content.`);
    }
    if (file.kind === "attachment") {
      requireValid(file.recordCount === 0, `${label}.recordCount must be zero for an attachment.`);
    } else if (value.format === NATIVE_SESSION_ARCHIVE_FORMAT) {
      requireValid(inspectNativeJsonl(contentBytes).records.length === file.recordCount,
        `${label}.recordCount does not match its decoded JSONL object records.`);
    } else {
      const validationContent = file.content.replace(/^\uFEFF/, "");
      const records = validationContent === "" ? [] : validationContent.split("\n");
      if (records.at(-1) === "") records.pop();
      requireValid(records.length === file.recordCount, `${label}.recordCount does not match its JSONL records.`);
      for (const [recordIndex, record] of records.entries()) {
        try {
          JSON.parse(record);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new NativeSessionArchiveError(
            `Invalid native session archive: ${label} record ${recordIndex + 1} is not valid JSON.`,
          );
        }
      }
    }
    files.push({
      path: file.path as string, kind: file.kind, content: file.content,
      recordCount: file.recordCount, sha256: file.sha256,
      ...(file.contentEncoding === "base64" ? { contentEncoding: "base64" as const } : {}),
      ...(compressed ? {
        nativeEncoding: "zstd" as const,
        nativeBytesBase64: file.nativeBytesBase64 as string,
        nativeSha256: file.nativeSha256 as string,
      } : {}),
    });
  }

  return {
    format: value.format,
    ...metadata,
    files,
    redactions: parseRedactions(value.redactions),
    ...(value.format === NATIVE_SESSION_ARCHIVE_FORMAT || value.capture !== undefined ? {
      capture: parseCapture(value.capture, files),
    } : {}),
    ...(value.format === NATIVE_SESSION_ARCHIVE_FORMAT || value.restoration !== undefined ? {
      restoration: parseRestoration(value.restoration),
    } : {}),
  };
}

const NATIVE_MEDIA_TYPES = new Set(["image", "input_image", "output_image", "image_url", "audio", "input_audio",
  "output_audio", "document", "video", "input_video", "session.binary_asset", "base64"]);

function containsOpaqueMedia(text: string, depth = 0): boolean {
  if (depth > 32 || /\bdata:[^\s,"']*;base64,/i.test(text)) return true;
  let previousEnd = -1;
  let previousKey = "";
  // Complete string tokens also expose media markers in duplicated or partial
  // JSON records without treating JSON.parse's last-key-wins result as evidence.
  for (const match of text.matchAll(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g)) {
    const decoded: string = JSON.parse(match[0]);
    const end = match.index + match[0].length;
    const isKey = /^\s*:/.test(text.slice(end));
    const field = !isKey && previousEnd >= 0 && /^\s*:\s*$/.test(text.slice(previousEnd, match.index)) ? previousKey : "";
    if ((isKey && /^(?:image_url|base64|bytes[_-]?base64|data[_-]?base64|[a-z_]*b64)$/i.test(decoded)) ||
        ((field === "type" || field === "encoding") && NATIVE_MEDIA_TYPES.has(decoded))) return true;
    if ((decoded.includes('"') || decoded.includes("data:")) && containsOpaqueMedia(decoded, depth + 1)) return true;
    previousEnd = end;
    previousKey = isKey ? decoded : "";
  }
  return false;
}

export function nativeFileNeedsUnscannedReview(file: NativeArchiveFile): boolean {
  return file.contentEncoding === "base64" || containsOpaqueMedia(file.content);
}

/** Readable projections never carry binary encodings, even when a file is an event stream. */
export function nativeSessionPreviewFiles(archive: NativeSessionArchive): readonly NativeArchiveViewFile[] {
  return archive.files.map((file) => ({
    path: file.path, kind: file.kind, recordCount: file.recordCount, sha256: file.sha256,
    byteLength: nativeFileBytes(file).length,
    ...(file.nativeEncoding === undefined ? {} : { nativeEncoding: file.nativeEncoding, nativeSha256: file.nativeSha256! }),
    preview: nativeFileNeedsUnscannedReview(file)
      ? { kind: "download-only" as const }
      : { kind: "text" as const, content: file.content },
    diagnostics: file.kind !== "events" ? [] : file.contentEncoding !== "base64"
      ? inspectNativeJsonl(Buffer.from(file.content, "utf8")).diagnostics
      : (archive.capture?.diagnostics ?? []).flatMap((diagnostic) =>
        diagnostic.source.replaceAll("\\", "/") === file.path.replaceAll("\\", "/") && diagnostic.line !== undefined
          ? [{ code: diagnostic.code, line: diagnostic.line }] : []),
  }));
}

export function parseNativeSessionArchiveView(content: string): NativeSessionArchiveView | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (hasNativeFormatMarker(content, "session-registry/native-session-view")) {
      throw new NativeSessionArchiveError("Invalid native session view: malformed JSON.");
    }
    return null;
  }
  if (!isObject(value) || typeof value.format !== "string" || !value.format.startsWith("session-registry/native-session-view")) return null;
  requireValid(value.format === NATIVE_SESSION_VIEW_FORMAT, "unsupported native session view format.");
  requireValid(value.archiveFormat === NATIVE_SESSION_ARCHIVE_FORMAT || value.archiveFormat === PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
    "native view archiveFormat must identify a V2 or V3 native package.");
  const metadata = parseMetadata(value, value.archiveFormat);
  requireValid(value.archiveFormat !== PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT || metadata.resumable, "a V2 view requires its legacy bundle flag.");
  requireValid(isObject(value.nativeBundle), "native view bundle metadata is required.");
  for (const [key, expected] of Object.entries(NATIVE_SESSION_BUNDLE_POLICY)) {
    requireValid(value.nativeBundle[key] === expected, `native view nativeBundle.${key} has an unsafe delivery classification.`);
  }
  requireValid(sha256(value.nativeBundle.sha256), "native view bundle SHA-256 is invalid.");
  requireValid(nonnegativeInteger(value.nativeBundle.byteLength) && value.nativeBundle.byteLength >= 22 &&
    value.nativeBundle.byteLength <= MAX_NATIVE_ARCHIVE_BYTES, "native view bundle byteLength is invalid.");
  requireValid(Array.isArray(value.files), "native view files must be an array.");
  const paths = new Set<string>();
  let totalBytes = 0;
  const files: NativeArchiveViewFile[] = value.files.map((file: unknown, index: number) => {
    const label = `native view files[${index}]`;
    requireValid(isObject(file), `${label} must be an object.`);
    const path = relativePath(file.path, `${label}.path`);
    requireValid(!paths.has(path), `${label}.path is duplicated.`);
    paths.add(path);
    requireValid(file.kind === "events" || file.kind === "attachment", `${label}.kind is invalid.`);
    requireValid(nonnegativeInteger(file.recordCount) && (file.kind === "events" || file.recordCount === 0), `${label}.recordCount is invalid.`);
    requireValid(sha256(file.sha256), `${label}.sha256 is invalid.`);
    requireValid(nonnegativeInteger(file.byteLength) && file.byteLength <= MAX_NATIVE_ARCHIVE_FILE_BYTES, `${label}.byteLength is invalid.`);
    requireValid(file.content === undefined && file.contentEncoding === undefined && file.nativeBytesBase64 === undefined,
      `${label} must not expose archival byte fields.`);
    requireValid(file.nativeEncoding === undefined || file.nativeEncoding === "zstd", `${label}.nativeEncoding is invalid.`);
    requireValid(file.nativeEncoding === "zstd" ? sha256(file.nativeSha256) : file.nativeSha256 === undefined,
      `${label}.nativeSha256 is invalid.`);
    requireValid(isObject(file.preview), `${label}.preview is required.`);
    let preview: NativeArchiveViewFile["preview"];
    let previewBytes = 0;
    if (file.preview.kind === "text") {
      requireValid(typeof file.preview.content === "string", `${label}.preview.content must be text.`);
      const bytes = Buffer.from(file.preview.content, "utf8");
      previewBytes = bytes.length;
      requireValid(bytes.toString("utf8") === file.preview.content && bytes.length <= MAX_NATIVE_ARCHIVE_FILE_BYTES,
        `${label}.preview must contain bounded UTF-8 text.`);
      requireValid(createHash("sha256").update(bytes).digest("hex") === file.sha256.toLowerCase(), `${label}.preview checksum does not match.`);
      requireValid(file.nativeEncoding === "zstd" || file.byteLength === bytes.length, `${label}.byteLength does not match its text.`);
      requireValid(!nativeFileNeedsUnscannedReview({
        path: file.path as string, kind: file.kind, content: file.preview.content, recordCount: file.recordCount, sha256: file.sha256,
      }), `${label} contains download-only media and must not be previewed.`);
      if (file.kind === "events" && value.archiveFormat === NATIVE_SESSION_ARCHIVE_FORMAT) {
        requireValid(inspectNativeJsonl(bytes).records.length === file.recordCount, `${label}.recordCount does not match its decoded records.`);
      }
      preview = { kind: "text", content: file.preview.content };
    } else {
      requireValid(file.preview.kind === "download-only" && file.preview.content === undefined,
        `${label}.preview must withhold unscanned bytes.`);
      preview = { kind: "download-only" };
    }
    totalBytes += Math.max(file.byteLength, previewBytes);
    requireValid(totalBytes <= MAX_NATIVE_ARCHIVE_BYTES, "native view exceeds the archive size limit.");
    requireValid(Array.isArray(file.diagnostics), `${label}.diagnostics must be an array.`);
    const diagnostics = file.diagnostics.map((diagnostic: unknown): NativeRecordDiagnostic => {
      requireValid(isObject(diagnostic) && nonnegativeInteger(diagnostic.line) && diagnostic.line > 0 &&
        typeof diagnostic.code === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(diagnostic.code), `${label}.diagnostic is invalid.`);
      return { line: diagnostic.line, code: diagnostic.code };
    });
    return {
      path: file.path as string, kind: file.kind, recordCount: file.recordCount, sha256: file.sha256,
      byteLength: file.byteLength, preview, diagnostics,
      ...(file.nativeEncoding === "zstd" ? { nativeEncoding: "zstd", nativeSha256: file.nativeSha256 as string } : {}),
    };
  });
  return {
    format: NATIVE_SESSION_VIEW_FORMAT, archiveFormat: value.archiveFormat, ...metadata, files,
    redactions: parseRedactions(value.redactions),
    ...(value.archiveFormat === NATIVE_SESSION_ARCHIVE_FORMAT || value.capture !== undefined ? { capture: parseCapture(value.capture, files) } : {}),
    ...(value.archiveFormat === NATIVE_SESSION_ARCHIVE_FORMAT || value.restoration !== undefined ? { restoration: parseRestoration(value.restoration) } : {}),
    nativeBundle: {
      ...NATIVE_SESSION_BUNDLE_POLICY, sha256: value.nativeBundle.sha256, byteLength: value.nativeBundle.byteLength,
    },
  };
}
