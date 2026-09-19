import { crc32 as zlibCrc32 } from "node:zlib";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import { ImportError, type ImportErrorCode } from "./importErrors.js";
import { MAX_NATIVE_ARCHIVE_BYTES, MAX_NATIVE_ARCHIVE_FILE_BYTES } from "./nativeSessionArchive.js";

/**
 * A single extracted entry: the archive-relative path and its fully-read,
 * owned bytes. Unlike a hand-rolled reader over the same input buffer, yauzl
 * decodes each entry through its own internal stream, so there is no backing
 * buffer left to return a *view* over; every `bytes` here is a fresh
 * allocation the caller owns outright and may retain independently of the
 * original input.
 */
export interface NativeSessionBundleEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ReadNativeSessionBundleOptions {
  readonly signal?: AbortSignal;
}

const GP_FLAG_ENCRYPTED = 0x0001;
const GP_FLAG_DATA_DESCRIPTOR = 0x0008;
const GP_FLAG_STRONG_ENCRYPTION = 0x0040;
const GP_FLAG_UTF8_NAME = 0x0800;
const GP_FLAG_MASKED_LOCAL_HEADER = 0x2000;
const GP_FLAG_FORBIDDEN = GP_FLAG_ENCRYPTED | GP_FLAG_DATA_DESCRIPTOR | GP_FLAG_STRONG_ENCRYPTION | GP_FLAG_MASKED_LOCAL_HEADER;

const STORED_METHOD = 0;

const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_FILE_TYPE_REGULAR = 0x8000;
const UNIX_SPECIAL_PERMISSION_MASK = 0o7000; // setuid | setgid | sticky

// Bounds distinct from, and tighter than, the writer's own per-entry (128 MiB)
// and aggregate (256 MiB) byte budgets: a defensive cap on entry *count* and
// *name* bytes, since neither is otherwise bounded by the byte-size limits.
const MAX_BUNDLE_ENTRIES = 4096;
const MAX_ENTRY_NAME_BYTES = 1024;
const MAX_TOTAL_NAME_BYTES = 256 * 1024;

const RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const BIDI_FORMAT_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/;
const WILDCARD_CHARACTERS = /[<>"|?*]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;
const DRIVE_LETTER_PREFIX = /^[a-z]:/i;

function fail(code: ImportErrorCode, detail: string): never {
  throw new ImportError(code, detail);
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("IMPORT_INPUT_FAILURE", "the import was aborted before the bundle finished reading.");
}

function validateEntryName(name: string): void {
  if (name.includes("\\")) fail("IMPORT_UNSAFE_NAME", `entry name contains a backslash: ${name}`);
  if (name.startsWith("/")) fail("IMPORT_UNSAFE_NAME", `entry name is an absolute path: ${name}`);
  if (DRIVE_LETTER_PREFIX.test(name)) fail("IMPORT_UNSAFE_NAME", `entry name has a drive letter prefix: ${name}`);
  if (CONTROL_CHARACTERS.test(name)) fail("IMPORT_UNSAFE_NAME", `entry name contains a control character: ${name}`);
  if (BIDI_FORMAT_CHARACTERS.test(name)) fail("IMPORT_UNSAFE_NAME", `entry name contains a bidi or format codepoint: ${name}`);
  if (name.length === 0) fail("IMPORT_UNSAFE_NAME", "entry name is empty.");
  for (const segment of name.split("/")) {
    if (segment === "") fail("IMPORT_UNSAFE_NAME", `entry name has an empty path segment: ${name}`);
    if (segment === "." || segment === "..") fail("IMPORT_UNSAFE_NAME", `entry name attempts path traversal: ${name}`);
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      fail("IMPORT_UNSAFE_NAME", `entry name uses a reserved property name: ${name}`);
    }
    if (TRAILING_DOT_OR_SPACE.test(segment)) fail("IMPORT_UNSAFE_NAME", `entry name segment has a trailing dot or space: ${name}`);
    if (segment.includes(":")) fail("IMPORT_UNSAFE_NAME", `entry name segment contains a colon: ${name}`);
    if (WILDCARD_CHARACTERS.test(segment)) fail("IMPORT_UNSAFE_NAME", `entry name segment contains an unsafe character: ${name}`);
    const basename = segment.split(".")[0]!.toLowerCase();
    if (RESERVED_BASENAMES.has(basename)) fail("IMPORT_UNSAFE_NAME", `entry name segment is a reserved device name: ${name}`);
  }
}

function validateEntryStructure(entry: Entry): void {
  const gpFlag = entry.generalPurposeBitFlag;
  if (entry.compressionMethod !== STORED_METHOD) fail("IMPORT_UNSUPPORTED_ZIP", "only stored (uncompressed) entries are supported.");
  if (entry.compressedSize !== entry.uncompressedSize) {
    fail("IMPORT_UNSUPPORTED_ZIP", "compressed and uncompressed sizes disagree for a stored entry.");
  }
  if ((gpFlag & GP_FLAG_UTF8_NAME) === 0) fail("IMPORT_UNSUPPORTED_ZIP", "an entry is not marked as a UTF-8 name.");
  if ((gpFlag & GP_FLAG_FORBIDDEN) !== 0) fail("IMPORT_UNSUPPORTED_ZIP", "an entry uses an unsupported general-purpose flag.");
  if (entry.extraFieldLength !== 0) fail("IMPORT_UNSUPPORTED_ZIP", "extra fields are not supported.");
  if (entry.fileCommentLength !== 0) fail("IMPORT_UNSUPPORTED_ZIP", "entry comments are not supported.");

  const mode = entry.externalFileAttributes >>> 16;
  if ((mode & UNIX_FILE_TYPE_MASK) !== UNIX_FILE_TYPE_REGULAR) fail("IMPORT_UNSAFE_NAME", "an entry is not a regular file.");
  if ((mode & UNIX_SPECIAL_PERMISSION_MASK) !== 0) fail("IMPORT_UNSAFE_NAME", "an entry sets a setuid, setgid, or sticky permission bit.");
}

/**
 * Maps a raw error thrown by `yauzl` (a plain `Error` with only a message,
 * not a structured code) to the app's own `ImportError` taxonomy, by pattern
 * matching against yauzl's fixed set of error strings.
 */
function mapZipFileError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/absolute path|invalid relative path|invalid characters in fileName/.test(message)) {
    fail("IMPORT_UNSAFE_NAME", `entry name is unsafe: ${message}`);
  }
  if (/strong encryption|compressed\/uncompressed size mismatch|multi-disk|zip64|unsupported compression method/i.test(message)) {
    fail("IMPORT_UNSUPPORTED_ZIP", `unsupported ZIP feature: ${message}`);
  }
  fail("IMPORT_NOT_A_BUNDLE", `the bundle is not a well-formed ZIP archive: ${message}`);
}

function readNextEntry(zipFile: ZipFile): Promise<Entry> {
  return new Promise<Entry>((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    function cleanup(): void {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("error", onError);
    }
    zipFile.once("entry", onEntry);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

async function readEntryBytes(zipFile: ZipFile, entry: Entry, signal: AbortSignal | undefined): Promise<Uint8Array> {
  checkAbort(signal);
  let stream;
  try {
    stream = await zipFile.openReadStreamPromise(entry);
  } catch {
    fail("IMPORT_NOT_A_BUNDLE", `could not open a read stream for entry: ${entry.fileName}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      checkAbort(signal);
      total += chunk.length;
      if (total > entry.uncompressedSize) {
        fail("IMPORT_NOT_A_BUNDLE", `entry produced more bytes than its declared size: ${entry.fileName}`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    fail("IMPORT_NOT_A_BUNDLE", `failed to read entry data: ${entry.fileName}`);
  }
  if ((zlibCrc32(Buffer.concat(chunks, total)) >>> 0) !== (entry.crc32 >>> 0)) {
    fail("IMPORT_HASH_MISMATCH", `entry CRC-32 verification failed: ${entry.fileName}`);
  }
  // `Buffer.concat` may return the sole chunk's own buffer unmodified when
  // there is exactly one chunk, which for entries backed by an in-memory
  // input can alias the caller's original bytes. Force a defensive, fully
  // owned copy so callers may safely retain and mutate-independently of the
  // input regardless of chunking, per this API's documented ownership contract.
  return Buffer.from(Buffer.concat(chunks, total));
}

/**
 * Reads the narrow stored, non-ZIP64 ZIP dialect emitted by
 * `buildNativeSessionBundle` from a fully untrusted in-memory buffer,
 * rejecting everything else. Structural ZIP parsing (central-directory
 * discovery, EOCD validation, ZIP64/multi-disk rejection, strict file-name
 * decoding) is delegated to `yauzl`, configured with `strictFileNames: true`
 * and `validateEntrySizes: true`; every app-owned restriction this dialect
 * additionally requires (stored-only, UTF-8 flag, forbidden general-purpose
 * flags, empty extra/comment fields, regular-file attributes, path safety,
 * case/NFC collisions, and all size/count/name-length caps) is enforced here
 * on top of yauzl's own checks, before any entry's data is read.
 *
 * Unlike a hand-rolled reader over the same input buffer, yauzl decodes each
 * entry through its own internal stream machinery rather than exposing the
 * backing buffer directly, so this function cannot return zero-copy views:
 * every returned `bytes` is a fresh, independently-owned allocation produced
 * by fully consuming and CRC-32-verifying that entry's decoded stream.
 *
 * Error code mapping (see importErrors.ts for remediation text):
 * - `IMPORT_NOT_A_BUNDLE`: the bytes are not a well-formed instance of this
 *   dialect (yauzl itself rejects it, an entry name fails yauzl's own strict
 *   validation, or an entry's read stream fails or overproduces).
 * - `IMPORT_UNSUPPORTED_ZIP`: the bytes are a well-formed ZIP using a feature
 *   this narrow dialect does not support (compression, encryption, data
 *   descriptors, extra fields, entry comments, non-UTF-8 names).
 * - `IMPORT_LIMIT_EXCEEDED`: a declared size or count exceeds a bound
 *   enforced before any entry is opened.
 * - `IMPORT_UNSAFE_NAME`: an entry name or file-type attribute could escape
 *   the extraction directory or collide with another entry.
 * - `IMPORT_HASH_MISMATCH`: an entry's stored bytes do not match its
 *   declared CRC-32.
 * - `IMPORT_INPUT_FAILURE`: the read was aborted via `AbortSignal`.
 */
export async function readNativeSessionBundle(
  bytes: Uint8Array,
  options: ReadNativeSessionBundleOptions = {},
): Promise<ReadonlyMap<string, NativeSessionBundleEntry>> {
  const { signal } = options;
  checkAbort(signal);
  const fileSize = bytes.byteLength;
  if (fileSize > MAX_NATIVE_ARCHIVE_BYTES) fail("IMPORT_LIMIT_EXCEEDED", "the bundle exceeds the maximum supported file size.");

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let zipFile: ZipFile;
  try {
    zipFile = await fromBufferPromise(buffer, {
      lazyEntries: true,
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
      decodeStrings: true,
    });
  } catch (error) {
    fail("IMPORT_NOT_A_BUNDLE", `the bundle is not a well-formed ZIP archive: ${(error as Error).message}`);
  }

  try {
    if (zipFile.entryCount > MAX_BUNDLE_ENTRIES) {
      fail("IMPORT_LIMIT_EXCEEDED", "the bundle declares more entries than are supported.");
    }

    const result = new Map<string, NativeSessionBundleEntry>();
    const keys = new Set<string>();
    let totalNameBytes = 0;
    let aggregateUncompressed = 0;

    for (let index = 0; index < zipFile.entryCount; index++) {
      checkAbort(signal);
      let entry: Entry;
      try {
        entry = await readNextEntry(zipFile);
      } catch (error) {
        mapZipFileError(error);
      }

      if (entry.fileName.includes("\\")) fail("IMPORT_UNSAFE_NAME", `entry name contains a backslash: ${entry.fileName}`);

      const nameLength = Buffer.byteLength(entry.fileName, "utf8");
      if (nameLength === 0) fail("IMPORT_NOT_A_BUNDLE", "an entry name is empty.");
      if (nameLength > MAX_ENTRY_NAME_BYTES) fail("IMPORT_LIMIT_EXCEEDED", "an entry name exceeds the supported length.");
      totalNameBytes += nameLength;
      if (totalNameBytes > MAX_TOTAL_NAME_BYTES) fail("IMPORT_LIMIT_EXCEEDED", "the total entry name bytes exceed the supported limit.");

      if (entry.uncompressedSize > MAX_NATIVE_ARCHIVE_FILE_BYTES) fail("IMPORT_LIMIT_EXCEEDED", "an entry exceeds the per-entry size limit.");
      aggregateUncompressed += entry.uncompressedSize;
      if (aggregateUncompressed > MAX_NATIVE_ARCHIVE_BYTES) fail("IMPORT_LIMIT_EXCEEDED", "entries exceed the aggregate size limit.");

      validateEntryStructure(entry);
      validateEntryName(entry.fileName);

      const key = entry.fileName.normalize("NFC").toLowerCase();
      if (keys.has(key)) fail("IMPORT_UNSAFE_NAME", `two entries normalize to the same extraction name: ${entry.fileName}`);
      keys.add(key);

      const entryBytes = await readEntryBytes(zipFile, entry, signal);
      result.set(entry.fileName, { path: entry.fileName, bytes: entryBytes });
    }

    return result;
  } finally {
    zipFile.close();
  }
}