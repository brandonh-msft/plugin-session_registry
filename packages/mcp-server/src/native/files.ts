import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";
import { inspectNativeJsonl, MAX_NATIVE_ARCHIVE_FILE_BYTES } from "@session-registry/core";
import { NativeCaptureError } from "./errors.js";
import { protectPrivatePath } from "./privateStorage.js";

export { NativeCaptureError } from "./errors.js";

export interface SourceFile {
  readonly absolutePath: string;
  readonly path: string;
  readonly content: string;
  readonly contentEncoding?: "base64";
  readonly size: number;
  readonly modified: number;
  readonly capturedSize: number;
  readonly observedSize: number;
  readonly snapshotKind: "file-prefix" | "sqlite-backup" | "decoded-prefix";
  readonly native?: { readonly bytesBase64: string; readonly sha256: string };
}

export interface SourceReadOptions {
  readonly endByteOffset?: number;
  readonly allowAppend?: boolean;
}

interface CapturedFile {
  readonly source: SourceFile;
  readonly verificationBytes: Buffer;
  readonly ino: number;
  readonly dev: number;
  readonly allowAppend: boolean;
}

export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** All reads are bounded by a selected native-session source, never by transcript instructions. */
export class NativeFiles {
  private readonly captured = new Map<string, CapturedFile>();
  private readonly directories = new Map<string, readonly string[]>();
  private readonly chargedBytes = new Map<string, number>();
  private totalBytes = 0;

  constructor(
    readonly root: string,
    private readonly maxBytes: number,
  ) {}

  async resolve(path: string): Promise<string> {
    const target = resolve(this.root, path);
    if (!isWithin(this.root, target)) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "A source reference is outside the selected session.");
    }
    const parts = relative(this.root, target).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) {
        throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Session sources cannot contain symbolic links.");
      }
    }
    if (!isWithin(this.root, await realpath(target))) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "A source resolves outside the selected session.");
    }
    return target;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolve(path);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async list(path: string): Promise<readonly string[]> {
    const directory = await this.resolve(path);
    const previous = this.directories.get(directory);
    if (previous !== undefined) return previous;
    const entries = (await readdir(directory)).sort();
    if (entries.length > 10_000 || this.directories.size > 10_000) {
      throw new NativeCaptureError("SOURCE_LIMIT", "The native source has too many directory entries.");
    }
    this.directories.set(directory, entries);
    return entries;
  }

  async read(path: string, options: SourceReadOptions = {}): Promise<SourceFile> {
    if (options.endByteOffset !== undefined &&
        (!Number.isSafeInteger(options.endByteOffset) || options.endByteOffset < 0)) {
      throw new NativeCaptureError("INVALID_SOURCE_BOUNDARY", "A native source byte boundary must be a nonnegative safe integer.");
    }
    const absolutePath = await this.resolve(path);
    const key = JSON.stringify([absolutePath, options.endByteOffset ?? null]);
    const existing = this.captured.get(key);
    if (existing !== undefined) return existing.source;
    if (!(await lstat(absolutePath)).isFile()) {
      throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Only regular native session files can be captured.");
    }
    const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    let size: number;
    let modified: number;
    let ino: number;
    let dev: number;
    let sqlite = false;
    const compressed = absolutePath.endsWith(".jsonl.zst");
    const allowAppend = options.allowAppend ?? !compressed;
    try {
      const before = await handle.stat();
      const named = await lstat(absolutePath);
      if (!before.isFile() || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) {
        throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Expected a stable regular native session file.");
      }
      const length = compressed ? before.size : Math.min(options.endByteOffset ?? before.size, before.size);
      if (!compressed && options.endByteOffset !== undefined && options.endByteOffset > before.size) {
        throw new NativeCaptureError("INCOMPLETE_SOURCE", "An inherited byte boundary extends beyond its native source.");
      }
      this.checkSize(length);
      bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) {
          throw new NativeCaptureError("SOURCE_CHANGED", "The source became shorter while it was being captured.");
        }
        offset += read.bytesRead;
      }
      sqlite = options.endByteOffset === undefined && bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"));
      const after = await handle.stat();
      const current = await lstat(absolutePath);
      if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev ||
          (!sqlite && (after.size < length || current.size < length ||
            (!allowAppend && (before.size !== after.size || before.mtimeMs !== after.mtimeMs))))) {
        throw new NativeCaptureError("SOURCE_CHANGED", "The session changed during capture; prepare a new snapshot.");
      }
      size = before.size;
      modified = before.mtimeMs;
      ino = before.ino;
      dev = before.dev;
    } finally {
      await handle.close();
    }

    const verificationBytes = bytes;
    let snapshotKind: SourceFile["snapshotKind"] = "file-prefix";
    if (sqlite) {
      bytes = await this.sqliteSnapshot(absolutePath);
      snapshotKind = "sqlite-backup";
    }
    let originalBytes = compressed ? bytes : undefined;
    if (compressed) {
      if (typeof zlib.zstdDecompressSync !== "function") {
        throw new NativeCaptureError("UNSUPPORTED_COMPRESSION", "Compressed Codex rollouts require a Node.js runtime with built-in Zstandard support.");
      }
      try {
        bytes = zlib.zstdDecompressSync(bytes, { maxOutputLength: Math.min(this.maxBytes, MAX_NATIVE_ARCHIVE_FILE_BYTES) });
      } catch (error) {
        if (!(error instanceof Error && "code" in error)) throw error;
        throw new NativeCaptureError("INVALID_COMPRESSED_SOURCE", "A compressed rollout is invalid or exceeds the configured capture limit.");
      }
      if (options.endByteOffset !== undefined) {
        if (options.endByteOffset > bytes.length) {
          throw new NativeCaptureError("INCOMPLETE_SOURCE", "An inherited byte boundary extends beyond its decoded native source.");
        }
        if (options.endByteOffset < bytes.length) {
          bytes = bytes.subarray(0, options.endByteOffset);
          originalBytes = zlib.zstdCompressSync(bytes);
          snapshotKind = "decoded-prefix";
        }
      }
    }
    this.checkSize(bytes.length);
    let content: string;
    let contentEncoding: "base64" | undefined;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes("\0")) {
        content = bytes.toString("base64");
        contentEncoding = "base64";
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      content = bytes.toString("base64");
      contentEncoding = "base64";
    }
    const charge = bytes.length + (originalBytes?.length ?? 0);
    const previousCharge = this.chargedBytes.get(absolutePath) ?? 0;
    if (this.totalBytes + Math.max(0, charge - previousCharge) > this.maxBytes) {
      throw new NativeCaptureError("SOURCE_LIMIT", "Native source exceeds SESSION_REGISTRY_MAX_CAPTURE_BYTES; nothing was truncated.");
    }
    this.totalBytes += Math.max(0, charge - previousCharge);
    this.chargedBytes.set(absolutePath, Math.max(charge, previousCharge));
    const source: SourceFile = {
      absolutePath,
      path: relative(this.root, absolutePath).split(sep).join("/"),
      content,
      ...(contentEncoding === undefined ? {} : { contentEncoding }),
      size,
      modified,
      capturedSize: originalBytes?.length ?? bytes.length,
      observedSize: size,
      snapshotKind,
      ...(originalBytes === undefined ? {} : {
        native: {
          bytesBase64: originalBytes.toString("base64"),
          sha256: createHash("sha256").update(originalBytes).digest("hex"),
        },
      }),
    };
    this.captured.set(key, { source, verificationBytes, ino, dev, allowAppend });
    return source;
  }

  private checkSize(bytes: number): void {
    if (bytes > Math.min(this.maxBytes, MAX_NATIVE_ARCHIVE_FILE_BYTES)) {
      throw new NativeCaptureError("SOURCE_LIMIT", "A native file exceeds the configured capture limit; nothing was truncated.");
    }
  }

  private async sqliteSnapshot(path: string): Promise<Buffer> {
    const directory = await mkdtemp(join(tmpdir(), "registry-sqlite-snapshot-"));
    const target = join(directory, "snapshot.sqlite");
    let database: DatabaseSync | undefined;
    try {
      await writeFile(target, "", { flag: "wx", mode: 0o600 });
      await protectPrivatePath(directory, true);
      await protectPrivatePath(target);
      database = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1_000 });
      database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
      const pageSize = database.prepare("PRAGMA page_size").get()?.page_size;
      if (typeof pageSize !== "number") {
        throw new NativeCaptureError("SQLITE_SNAPSHOT_FAILED", "The selected database did not report its page size.");
      }
      const started = Date.now();
      await backup(database, target, {
        rate: 256,
        progress: ({ totalPages }) => {
          this.checkSize(totalPages * pageSize);
          if (Date.now() - started > 10_000) {
            throw new NativeCaptureError("SOURCE_CHANGED", "SQLite snapshot could not settle within the capture window; retry preparation.");
          }
        },
      });
      this.checkSize((await lstat(target)).size);
      return await readFile(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).includes("SQLITE")) {
        throw new NativeCaptureError("SQLITE_SNAPSHOT_FAILED", "The selected session database could not be snapshotted read-only, including its committed WAL state.");
      }
      throw error;
    } finally {
      database?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  async assertUnchanged(): Promise<void> {
    for (const { source, verificationBytes, ino, dev, allowAppend } of this.captured.values()) {
      try {
        await this.resolve(source.absolutePath);
        const handle = await open(source.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const current = await handle.stat();
          const named = await lstat(source.absolutePath);
          if (!current.isFile() || named.isSymbolicLink() || current.ino !== ino || current.dev !== dev ||
              named.ino !== ino || named.dev !== dev) {
            throw new NativeCaptureError("SOURCE_CHANGED", "A native source was replaced during capture; prepare a new snapshot.");
          }
          // SQLite backup is its own transactional observation boundary, including
          // committed WAL pages; a subsequent commit need not invalidate it.
          if (source.snapshotKind === "sqlite-backup") continue;
          if (current.size < verificationBytes.length ||
              (!allowAppend && (current.size !== source.size || current.mtimeMs !== source.modified))) {
            throw new NativeCaptureError("SOURCE_CHANGED", "A captured source was truncated or rewritten; prepare a new snapshot.");
          }
          const buffer = Buffer.alloc(Math.min(64 * 1024, verificationBytes.length));
          let offset = 0;
          while (offset < verificationBytes.length) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, verificationBytes.length - offset), offset);
            if (bytesRead === 0 || !buffer.subarray(0, bytesRead).equals(verificationBytes.subarray(offset, offset + bytesRead))) {
              throw new NativeCaptureError("SOURCE_CHANGED", "A captured prefix was rewritten; later appends are allowed, earlier changes are not.");
            }
            offset += bytesRead;
          }
          await this.resolve(source.absolutePath);
          const after = await lstat(source.absolutePath);
          if (!after.isFile() || after.isSymbolicLink() || after.ino !== ino || after.dev !== dev ||
              after.size < verificationBytes.length) {
            throw new NativeCaptureError("SOURCE_CHANGED", "A native source was replaced or truncated during prefix verification.");
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        throw new NativeCaptureError("SOURCE_CHANGED", "A selected source disappeared before capture completed.");
      }
    }
  }
}

export type NativeValue = null | boolean | number | string | NativeValue[] | NativeObject;
export interface NativeObject { [key: string]: NativeValue }

export function isNativeObject(value: unknown): value is NativeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectDuplicateKeys(json: string, location: string): void {
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < json.length; index++) {
    const character = json[index];
    if (character === "{") objects.push(new Set());
    else if (character === "[") objects.push(null);
    else if (character === "}" || character === "]") objects.pop();
    else if (character === '"') {
      const start = index++;
      while (index < json.length && json[index] !== '"') {
        if (json[index] === "\\") index++;
        index++;
      }
      let next = index + 1;
      while (next < json.length && /\s/.test(json[next]!)) next++;
      if (json[next] === ":") {
        const key = JSON.parse(json.slice(start, index + 1)) as string;
        const keys = objects.at(-1);
        if (keys?.has(key)) {
          throw new NativeCaptureError("MALFORMED_SOURCE", `${location} contains duplicate JSON keys.`);
        }
        keys?.add(key);
      }
    }
  }
}

export function sourceBytes(source: SourceFile): Buffer {
  return Buffer.from(source.content, source.contentEncoding === "base64" ? "base64" : "utf8");
}

export function parseNativeJson(source: Pick<SourceFile, "path" | "content">): NativeValue {
  let value: unknown;
  try {
    value = JSON.parse(source.content);
    rejectDuplicateKeys(source.content, source.path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new NativeCaptureError("MALFORMED_SOURCE", `${source.path} contains invalid JSON.`);
  }
  if (value === null || typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean" || Array.isArray(value) || isNativeObject(value)) {
    return value;
  }
  throw new NativeCaptureError("MALFORMED_SOURCE", `${source.path} is not a native JSON value.`);
}

export function parseRecords(source: SourceFile): NativeObject[] {
  return inspectNativeJsonl(sourceBytes(source)).records.filter(isNativeObject);
}
