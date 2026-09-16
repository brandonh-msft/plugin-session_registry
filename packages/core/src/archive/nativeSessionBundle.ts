import { createHash } from "node:crypto";
import {
  MAX_NATIVE_ARCHIVE_BYTES,
  NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_SESSION_BUNDLE_POLICY,
  NATIVE_SESSION_BUNDLE_WARNING,
  NATIVE_SESSION_VIEW_FORMAT,
  NativeSessionArchiveError,
  hasNativeSessionBundle,
  nativeFileBytes,
  nativeSessionPreviewFiles,
  parseNativeSessionArchive,
  type NativeSessionArchive,
  type NativeSessionArchiveView,
} from "./nativeSessionArchive.js";

export const NATIVE_SESSION_BUNDLE_MANIFEST_PATH = "session-registry-manifest.json";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = UINT32_MAX;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ UINT32_MAX) >>> 0;
}

function reject(message: string): never {
  throw new NativeSessionArchiveError(`Cannot build native session bundle: ${message}`);
}

/**
 * A deterministic, stored ZIP of approved native bytes and a separate V3 capture
 * manifest. Creating or downloading it never activates a harness.
 */
export function buildNativeSessionBundle(archive: NativeSessionArchive): Uint8Array {
  if (archive.files.length >= UINT16_MAX) reject("too many files for a non-ZIP64 archive.");
  const validated = parseNativeSessionArchive(JSON.stringify(archive));
  if (!validated || !hasNativeSessionBundle(validated)) {
    reject("a captured V3 or resumable V2 native session archive is required.");
  }
  const sources = validated.files.map((file) => ({ path: file.path, bytes: nativeFileBytes(file) }));
  if (validated.format === NATIVE_SESSION_ARCHIVE_FORMAT) {
    sources.push({
      path: NATIVE_SESSION_BUNDLE_MANIFEST_PATH,
      bytes: Buffer.from(JSON.stringify({
        format: "session-registry/native-bundle/1",
        archiveFormat: validated.format,
        harness: validated.harness,
        harnessSessionId: validated.harnessSessionId,
        capturedAt: validated.capturedAt,
        scope: validated.scope,
        sourceFormat: validated.sourceFormat,
        capture: validated.capture,
        restoration: validated.restoration,
        delivery: NATIVE_SESSION_BUNDLE_POLICY,
        securityChanges: validated.redactions,
        approvedFiles: validated.files.map((file, index) => ({
          path: file.path, kind: file.kind, recordCount: file.recordCount, bytes: sources[index]!.bytes.length,
          sha256: file.nativeSha256 ?? file.sha256,
          contentSha256: file.sha256,
          ...(file.contentEncoding === undefined ? {} : { contentEncoding: file.contentEncoding }),
          ...(file.nativeEncoding === undefined ? {} : { nativeEncoding: file.nativeEncoding }),
        })),
        notice: NATIVE_SESSION_BUNDLE_WARNING + " Captured native files are not an official harness import format. Restoration is not verified. Download and extraction do not execute these files; activation requires a separate, explicit, compatible and isolated procedure.",
      }, null, 2) + "\n", "utf8"),
    });
  }
  const paths = new Set<string>();
  const entries = sources.map((source) => {
    const path = source.path.replaceAll("\\", "/");
    const parts = path.split("/");
    if (parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split(".")[0]!.trimEnd()))) {
      reject(`unsafe extraction filename: ${path}`);
    }
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key)) reject(`duplicate extraction filename: ${path}`);
    paths.add(key);
    const name = Buffer.from(path, "utf8");
    if (name.toString("utf8") !== path) reject("filename does not round-trip as UTF-8.");
    if (name.length > UINT16_MAX) reject("filename exceeds the ZIP size limit.");
    const bytes = source.bytes;
    return { name, bytes, crc: crc32(bytes), key };
  });
  for (const { key } of entries) {
    const parts = key.split("/");
    parts.pop();
    while (parts.length > 0) {
      if (paths.has(parts.join("/"))) reject("a filename conflicts with a source directory.");
      parts.pop();
    }
  }
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const size = localSize + centralSize + 22;
  if (size > UINT32_MAX || size > MAX_NATIVE_ARCHIVE_BYTES) reject("ZIP exceeds the bundle size limit.");
  const zip = Buffer.alloc(size);
  let offset = 0;
  let centralOffset = localSize;
  for (const entry of entries) {
    zip.writeUInt32LE(0x04034b50, offset);
    zip.writeUInt16LE(20, offset + 4);
    zip.writeUInt16LE(0x800, offset + 6);
    zip.writeUInt16LE(0x21, offset + 12); // ZIP's earliest date: 1980-01-01.
    zip.writeUInt32LE(entry.crc, offset + 14);
    zip.writeUInt32LE(entry.bytes.length, offset + 18);
    zip.writeUInt32LE(entry.bytes.length, offset + 22);
    zip.writeUInt16LE(entry.name.length, offset + 26);
    entry.name.copy(zip, offset + 30);
    entry.bytes.copy(zip, offset + 30 + entry.name.length);

    zip.writeUInt32LE(0x02014b50, centralOffset);
    zip.writeUInt16LE(0x314, centralOffset + 4);
    zip.writeUInt16LE(20, centralOffset + 6);
    zip.writeUInt16LE(0x800, centralOffset + 8);
    zip.writeUInt16LE(0x21, centralOffset + 14);
    zip.writeUInt32LE(entry.crc, centralOffset + 16);
    zip.writeUInt32LE(entry.bytes.length, centralOffset + 20);
    zip.writeUInt32LE(entry.bytes.length, centralOffset + 24);
    zip.writeUInt16LE(entry.name.length, centralOffset + 28);
    zip.writeUInt32LE(0o100644 * 0x10000, centralOffset + 38);
    zip.writeUInt32LE(offset, centralOffset + 42);
    entry.name.copy(zip, centralOffset + 46);
    offset += 30 + entry.name.length + entry.bytes.length;
    centralOffset += 46 + entry.name.length;
  }
  zip.writeUInt32LE(0x06054b50, centralOffset);
  zip.writeUInt16LE(entries.length, centralOffset + 8);
  zip.writeUInt16LE(entries.length, centralOffset + 10);
  zip.writeUInt32LE(centralSize, centralOffset + 12);
  zip.writeUInt32LE(localSize, centralOffset + 16);
  return zip;
}

/**
 * The transcript slot is a readable view, not a second ungated copy of opaque
 * native bytes. Only the separately warned package retains those bytes.
 */
export function buildNativeSessionPublication(archive: NativeSessionArchive): {
  readonly bundle: Uint8Array;
  readonly view: NativeSessionArchiveView;
  readonly content: string;
} {
  const validated = parseNativeSessionArchive(JSON.stringify(archive));
  if (validated === null || !hasNativeSessionBundle(validated)) reject("a complete native archive, not a read-view projection, is required.");
  const bundle = buildNativeSessionBundle(validated);
  const view: NativeSessionArchiveView = {
    ...validated,
    format: NATIVE_SESSION_VIEW_FORMAT,
    archiveFormat: validated.format,
    files: nativeSessionPreviewFiles(validated),
    nativeBundle: {
      ...NATIVE_SESSION_BUNDLE_POLICY,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      byteLength: bundle.byteLength,
    },
  };
  return { bundle, view, content: JSON.stringify(view) };
}
