import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import {
  NATIVE_HARNESSES,
  MAX_NATIVE_ARCHIVE_FILE_BYTES,
  NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_SESSION_BUNDLE_POLICY,
  type NativeCaptureManifest,
  type NativeHarness,
  type NativeRedaction,
} from "./nativeSessionArchive.js";
import { ImportError } from "./importErrors.js";
import {
  type NativeSessionBundleEntry,
} from "./nativeSessionBundleReader.js";
import { NATIVE_SESSION_BUNDLE_MANIFEST_PATH } from "./nativeSessionBundle.js";
import { parseImportJson } from "./jsonPrecision.js";

const MANIFEST_FORMAT = "session-registry/native-bundle/1";
const HASH = /^[a-f0-9]{64}$/i;
const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const ANSI_OR_OSC = /[\u001b](?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;

export interface ImportManifestFile {
  readonly path: string;
  readonly kind: "events" | "attachment";
  readonly recordCount: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentSha256?: string;
  readonly contentEncoding?: "base64";
  readonly nativeEncoding?: "zstd";
}

export interface ImportManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly archiveFormat: typeof NATIVE_SESSION_ARCHIVE_FORMAT;
  readonly harness: { readonly name: NativeHarness; readonly version: string };
  readonly harnessSessionId: string;
  readonly capturedAt: string;
  readonly scope: "persisted-session-records";
  readonly sourceFormat: string;
  readonly capture: NativeCaptureManifest;
  readonly restoration: {
    readonly status: "not-verified" | "invalidated-by-security-edits";
    readonly reason: string;
  };
  readonly delivery: typeof NATIVE_SESSION_BUNDLE_POLICY;
  readonly securityChanges: readonly NativeRedaction[];
  readonly approvedFiles: readonly ImportManifestFile[];
  readonly notice: string;
}

export interface ValidatedImportManifest {
  readonly manifest: ImportManifest;
  readonly harness: ImportManifest["harness"];
  readonly capturedAt: string;
  readonly files: readonly ImportManifestFile[];
  readonly restoration: ImportManifest["restoration"];
  readonly securityChanges: readonly NativeRedaction[];
}

function sanitize(value: string): string {
  return value.replace(ANSI_OR_OSC, "").replace(CONTROL_OR_FORMAT, "");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", `${label} must be a non-empty string.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", `${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!HASH.test(result)) throw new ImportError("IMPORT_MANIFEST_INVALID", `${label} must be a SHA-256 digest.`);
  return result.toLowerCase();
}

function archivePath(value: unknown, label: string): string {
  const path = string(value, label).replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", `${label} must be archive-relative.`);
  }
  return path;
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

function parseCapture(value: unknown): NativeCaptureManifest {
  const capture = object(value, "capture");
  if (capture.boundary !== "observed-prefixes" ||
      typeof capture.entrypoint !== "string" ||
      !["native-id", "explicit-path", "sqlite"].includes(String(capture.selection)) ||
      !["session-directory", "harness-home"].includes(String(capture.layout)) ||
      !Array.isArray(capture.sources) || !Array.isArray(capture.history) || !Array.isArray(capture.diagnostics)) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", "capture does not match the V3 capture schema.");
  }
  return {
    boundary: "observed-prefixes",
    entrypoint: sanitize(capture.entrypoint),
    selection: capture.selection as NativeCaptureManifest["selection"],
    layout: capture.layout as NativeCaptureManifest["layout"],
    sources: capture.sources.map((source, index) => {
      const item = object(source, `capture.sources[${index}]`);
      return {
        path: sanitize(archivePath(item.path, `capture.sources[${index}].path`)),
        ...(item.originalPath === undefined ? {} : { originalPath: sanitize(string(item.originalPath, `capture.sources[${index}].originalPath`)) }),
        capturedBytes: safeInteger(item.capturedBytes, `capture.sources[${index}].capturedBytes`),
        observedBytes: safeInteger(item.observedBytes, `capture.sources[${index}].observedBytes`),
        sha256: digest(item.sha256, `capture.sources[${index}].sha256`),
        snapshot: (() => {
          if (item.snapshot !== "file-prefix" && item.snapshot !== "sqlite-backup" && item.snapshot !== "decoded-prefix") {
            throw new ImportError("IMPORT_MANIFEST_INVALID", `capture.sources[${index}].snapshot is invalid.`);
          }
          return item.snapshot;
        })(),
      };
    }),
    history: capture.history.map((segment, index) => {
      const item = object(segment, `capture.history[${index}]`);
      return {
        path: sanitize(archivePath(item.path, `capture.history[${index}].path`)),
        sessionId: sanitize(string(item.sessionId, `capture.history[${index}].sessionId`)),
        ...(item.rolloutId === undefined ? {} : { rolloutId: sanitize(string(item.rolloutId, `capture.history[${index}].rolloutId`)) }),
        ...(item.endByteOffset === undefined ? {} : { endByteOffset: safeInteger(item.endByteOffset, `capture.history[${index}].endByteOffset`) }),
        ...(item.endOrdinalExclusive === undefined ? {} : { endOrdinalExclusive: safeInteger(item.endOrdinalExclusive, `capture.history[${index}].endOrdinalExclusive`) }),
      };
    }),
    diagnostics: capture.diagnostics.map((diagnostic, index) => {
      const item = object(diagnostic, `capture.diagnostics[${index}]`);
      return {
        code: sanitize(string(item.code, `capture.diagnostics[${index}].code`)),
        source: sanitize(string(item.source, `capture.diagnostics[${index}].source`)),
        ...(item.line === undefined ? {} : { line: safeInteger(item.line, `capture.diagnostics[${index}].line`) }),
      };
    }),
  };
}

function parseManifest(value: unknown): ImportManifest {
  const root = object(value, "manifest");
  if (root.format !== MANIFEST_FORMAT) throw new ImportError("IMPORT_MANIFEST_INVALID", "format is not V3.");
  if (root.archiveFormat !== NATIVE_SESSION_ARCHIVE_FORMAT) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", "archiveFormat is not V3.");
  }
  const harness = object(root.harness, "harness");
  const harnessName = string(harness.name, "harness.name");
  if (!(NATIVE_HARNESSES as readonly string[]).includes(harnessName)) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", "harness.name is unsupported.");
  }
  const restoration = object(root.restoration, "restoration");
  if (restoration.status !== "not-verified" && restoration.status !== "invalidated-by-security-edits") {
    throw new ImportError("IMPORT_MANIFEST_INVALID", "restoration.status is invalid.");
  }
  const delivery = object(root.delivery, "delivery");
  for (const [key, expected] of Object.entries(NATIVE_SESSION_BUNDLE_POLICY)) {
    if (delivery[key] !== expected) throw new ImportError("IMPORT_MANIFEST_INVALID", `delivery.${key} is invalid.`);
  }
  if (!Array.isArray(root.approvedFiles) || !Array.isArray(root.securityChanges)) {
    throw new ImportError("IMPORT_MANIFEST_INVALID", "approvedFiles and securityChanges must be arrays.");
  }
  const approvedFiles = root.approvedFiles.map((file, index) => {
    const item = object(file, `approvedFiles[${index}]`);
    const kind = item.kind;
    if (kind !== "events" && kind !== "attachment") {
      throw new ImportError("IMPORT_MANIFEST_INVALID", `approvedFiles[${index}].kind is invalid.`);
    }
    return {
      path: sanitize(archivePath(item.path, `approvedFiles[${index}].path`)),
      kind: kind as "events" | "attachment",
      recordCount: safeInteger(item.recordCount, `approvedFiles[${index}].recordCount`),
      bytes: safeInteger(item.bytes, `approvedFiles[${index}].bytes`),
      sha256: digest(item.sha256, `approvedFiles[${index}].sha256`),
      ...(item.contentSha256 === undefined ? {} : { contentSha256: digest(item.contentSha256, `approvedFiles[${index}].contentSha256`) }),
      ...(item.contentEncoding === undefined ? {} : item.contentEncoding === "base64"
        ? { contentEncoding: "base64" as const }
        : (() => { throw new ImportError("IMPORT_MANIFEST_INVALID", `approvedFiles[${index}].contentEncoding is invalid.`); })()),
      ...(item.nativeEncoding === undefined ? {} : item.nativeEncoding === "zstd"
        ? { nativeEncoding: "zstd" as const }
        : (() => { throw new ImportError("IMPORT_MANIFEST_INVALID", `approvedFiles[${index}].nativeEncoding is invalid.`); })()),
    };
  });
  return {
    format: MANIFEST_FORMAT,
    archiveFormat: NATIVE_SESSION_ARCHIVE_FORMAT,
    harness: { name: harnessName as NativeHarness, version: sanitize(string(harness.version, "harness.version")) },
    harnessSessionId: sanitize(string(root.harnessSessionId, "harnessSessionId")),
    capturedAt: sanitize(string(root.capturedAt, "capturedAt")),
    scope: root.scope === "persisted-session-records" ? root.scope : (() => { throw new ImportError("IMPORT_MANIFEST_INVALID", "scope is invalid."); })(),
    sourceFormat: sanitize(string(root.sourceFormat, "sourceFormat")),
    capture: parseCapture(root.capture),
    restoration: { status: restoration.status, reason: sanitize(string(restoration.reason, "restoration.reason")) },
    delivery: NATIVE_SESSION_BUNDLE_POLICY,
    securityChanges: root.securityChanges.map((change, index) => {
      const item = object(change, `securityChanges[${index}]`);
      return {
        id: sanitize(string(item.id, `securityChanges[${index}].id`)),
        category: sanitize(string(item.category, `securityChanges[${index}].category`)),
        source: sanitize(string(item.source, `securityChanges[${index}].source`)),
      };
    }),
    approvedFiles,
    notice: sanitize(string(root.notice, "notice")),
  };
}

function mismatch(detail: string): never {
  throw new ImportError("IMPORT_ENTRY_MISMATCH", detail);
}

export function validateImportManifest(
  entries: ReadonlyMap<string, NativeSessionBundleEntry>,
): ValidatedImportManifest {
  const manifestEntry = entries.get(NATIVE_SESSION_BUNDLE_MANIFEST_PATH);
  if (manifestEntry === undefined) {
    throw new ImportError("IMPORT_MANIFEST_MISSING", "this V2 bundle predates verifiable manifests; re-download or ask the owner to republish it.");
  }
  const manifest = parseManifest(parseImportJson(new TextDecoder().decode(manifestEntry.bytes)));
  const nonManifest = [...entries.values()].filter((entry) => entry.path !== NATIVE_SESSION_BUNDLE_MANIFEST_PATH);
  const byKey = new Map<string, NativeSessionBundleEntry>();
  for (const entry of nonManifest) {
    const key = pathKey(entry.path);
    if (byKey.has(key)) mismatch(`duplicate ZIP entry: ${entry.path}`);
    byKey.set(key, entry);
  }
  const approved = new Map<string, ImportManifestFile>();
  for (const file of manifest.approvedFiles) {
    const key = pathKey(file.path);
    if (approved.has(key)) mismatch(`duplicate manifest entry: ${file.path}`);
    approved.set(key, file);
  }
  for (const [key, file] of approved) if (!byKey.has(key)) mismatch(`missing ZIP entry: ${file.path}`);
  for (const [key, entry] of byKey) if (!approved.has(key)) mismatch(`unexpected ZIP entry: ${entry.path}`);
  for (const [key, file] of approved) {
    const entry = byKey.get(key)!;
    if (file.bytes !== entry.bytes.byteLength) throw new ImportError("IMPORT_HASH_MISMATCH", `${file.path}: byte length differs.`);
    const sha256 = createHash("sha256").update(entry.bytes).digest("hex");
    if (sha256 !== file.sha256.toLowerCase()) throw new ImportError("IMPORT_HASH_MISMATCH", `${file.path}: sha256 differs.`);
    if (file.contentSha256 !== undefined) {
      let contentBytes = entry.bytes;
      if (file.nativeEncoding === "zstd") {
        try {
          contentBytes = zstdDecompressSync(entry.bytes, {
            maxOutputLength: MAX_NATIVE_ARCHIVE_FILE_BYTES,
          });
        } catch {
          throw new ImportError("IMPORT_LIMIT_EXCEEDED", `${file.path}: compressed content exceeds the import limit or cannot be verified.`);
        }
      }
      const contentSha256 = createHash("sha256").update(contentBytes).digest("hex");
      if (contentSha256 !== file.contentSha256.toLowerCase()) {
        throw new ImportError("IMPORT_HASH_MISMATCH", `${file.path}: contentSha256 differs.`);
      }
    }
  }
  return {
    manifest,
    harness: manifest.harness,
    capturedAt: manifest.capturedAt,
    files: manifest.approvedFiles,
    restoration: manifest.restoration,
    securityChanges: manifest.securityChanges,
  };
}
