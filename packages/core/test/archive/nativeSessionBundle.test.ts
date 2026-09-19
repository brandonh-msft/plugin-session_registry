import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { buildNativeSessionBundle, buildNativeSessionPublication, NATIVE_SESSION_BUNDLE_MANIFEST_PATH } from "../../src/archive/nativeSessionBundle.js";
import {
  LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT, NATIVE_SESSION_BUNDLE_POLICY, NATIVE_SESSION_VIEW_FORMAT,
  hasNativeSessionBundle, inspectNativeJsonl, parseNativeSessionArchive, parseNativeSessionArchiveView, type NativeSessionArchive,
} from "../../src/archive/nativeSessionArchive.js";
import { archiveFile, nativeArchiveFixture, nativeV3ArchiveFixture } from "./nativeSessionArchive.fixture.js";

function fixture(): NativeSessionArchive {
  return {
    ...nativeArchiveFixture(),
    resumable: true,
    files: [
      archiveFile("events.jsonl", "events", '\uFEFF  {"type":"totally.unknown","n":900719925474099312345} \r\n', 1),
      archiveFile("agents\\child.jsonl", "events", '{"future":[null,"日本語"]}\r\n{}\n', 2),
      archiveFile("files/notes.txt", "attachment", "\uFEFF \r\nnotes \t\r\n", 0),
    ],
  };
}

function extracted(zipBytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(zipBytes);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    expect(zip.readUInt16LE(offset + 6)).toBe(0x800);
    expect(zip.readUInt16LE(offset + 8)).toBe(0);
    const size = zip.readUInt32LE(offset + 18);
    expect(zip.readUInt32LE(offset + 22)).toBe(size);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const bytes = zip.subarray(start, start + size);
    // Independent, bitwise checksum verification of each local entry.
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    expect(zip.readUInt32LE(offset + 14)).toBe((crc ^ 0xffffffff) >>> 0);
    files.set(name, bytes);
    offset = start + size;
  }
  const centralStart = offset;
  for (const [name, bytes] of files) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt16LE(offset + 28)).toBe(Buffer.byteLength(name));
    expect(zip.readUInt32LE(offset + 24)).toBe(bytes.length);
    expect(zip.readUInt32LE(offset + 38) >>> 16).toBe(0o100644);
    const localOffset = zip.readUInt32LE(offset + 42);
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    offset += 46 + Buffer.byteLength(name);
  }
  expect(zip.readUInt32LE(offset)).toBe(0x06054b50);
  expect(zip.readUInt16LE(offset + 10)).toBe(files.size);
  expect(zip.readUInt32LE(offset + 12)).toBe(offset - centralStart);
  expect(zip.readUInt32LE(offset + 16)).toBe(centralStart);
  expect(zip.length).toBe(offset + 22);
  return files;
}

describe("native source bundle", () => {
  it("includes the separate V3 capture manifest without claiming restoration or changing native bytes", () => {
    const archive = nativeV3ArchiveFixture(fixture().files);
    const bundle = buildNativeSessionBundle(archive);
    const files = extracted(bundle);
    expect(files.size).toBe(archive.files.length + 1);
    for (const file of archive.files) expect(files.get(file.path.replaceAll("\\", "/"))).toEqual(Buffer.from(file.content));
    const manifest = JSON.parse(files.get(NATIVE_SESSION_BUNDLE_MANIFEST_PATH)!.toString("utf8"));
    expect(manifest.capture).toEqual(archive.capture);
    expect(manifest.restoration).toEqual(archive.restoration);
    expect(manifest.securityChanges).toEqual(archive.redactions);
    expect(manifest.delivery).toEqual(NATIVE_SESSION_BUNDLE_POLICY);
    expect(manifest.delivery.unscannable).toBe(true);
    expect(manifest.delivery.includedInPortableBulkArchive).toBe(false);
    expect(manifest.notice).toContain("not a scanned portable bulk export");
    expect(manifest.notice).toContain("not an official harness import format");
    expect(manifest.notice).toContain("Restoration is not verified");
    expect(hasNativeSessionBundle(archive)).toBe(true);
    expect(archive.resumable).toBe(false);
    expect(buildNativeSessionBundle(archive)).toEqual(bundle);
  });

  it("separates a readable view from opaque native bytes without dropping anything from the warned package", () => {
    const bytes = Buffer.concat([Buffer.from([0, 255, 137, 80, 78, 71]), Buffer.from("binary-private-sentinel")]);
    const content = '{"type":"future","n":900719925474099312345,"k":1,"k":2}\r\nbad JSON\n{"partial":';
    const decoded = Buffer.from('\uFEFF{"type":"compressed"}\r\n');
    const compressed = zstdCompressSync(decoded);
    const media = '{"type":"image","type":"future","source":{"type":"base64","data":"AKIAAAAAAAAAAAAAAAAA"}}\n';
    const archive = nativeV3ArchiveFixture([
      archiveFile("events.jsonl", "events", content, 1),
      { path: "files/image.png", kind: "attachment", contentEncoding: "base64", content: bytes.toString("base64"),
        recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex") },
      { ...archiveFile("child.jsonl.zst", "events", decoded.toString("utf8"), 1), nativeEncoding: "zstd",
        nativeBytesBase64: compressed.toString("base64"), nativeSha256: createHash("sha256").update(compressed).digest("hex") },
      archiveFile("media.jsonl", "events", media, 1),
    ]);
    const publication = buildNativeSessionPublication(archive);
    const view = parseNativeSessionArchiveView(publication.content)!;
    expect(view).toEqual(publication.view);
    expect(view.format).toBe(NATIVE_SESSION_VIEW_FORMAT);
    expect(parseNativeSessionArchive(publication.content)).toBeNull();
    expect(view.nativeBundle).toEqual({
      ...NATIVE_SESSION_BUNDLE_POLICY, byteLength: publication.bundle.byteLength,
      sha256: createHash("sha256").update(publication.bundle).digest("hex"),
    });
    expect(view.files.map(({ path, preview }) => [path, preview.kind])).toEqual([
      ["events.jsonl", "text"], ["files/image.png", "download-only"], ["child.jsonl.zst", "text"], ["media.jsonl", "download-only"],
    ]);
    expect(view.files[0]!.preview).toEqual({ kind: "text", content });
    expect(view.capture!.sources).toEqual(archive.capture!.sources);
    expect(publication.content).not.toContain(bytes.toString("base64"));
    expect(publication.content).not.toContain("binary-private-sentinel");
    expect(publication.content).not.toContain(compressed.toString("base64"));
    expect(publication.content).not.toContain("AKIAAAAAAAAAAAAAAAAA");
    expect(publication.content).not.toContain("nativeBytesBase64");
    const files = extracted(publication.bundle);
    expect(files.get("events.jsonl")).toEqual(Buffer.from(content));
    expect(files.get("files/image.png")).toEqual(bytes);
    expect(files.get("child.jsonl.zst")).toEqual(compressed);
    expect(files.get("media.jsonl")).toEqual(Buffer.from(media));
  });

  it("refuses unsafe view classifications and attempts to inline opaque byte fields", () => {
    const publication = buildNativeSessionPublication(nativeV3ArchiveFixture(fixture().files));
    const view = publication.view;
    for (const nativeBundle of [
      { ...view.nativeBundle, unscannable: false },
      { ...view.nativeBundle, includedInPortableBulkArchive: true },
      { ...view.nativeBundle, requiresOwnerAcknowledgment: false },
      { ...view.nativeBundle, requiresAcknowledgmentPerDownload: false },
      { ...view.nativeBundle, delivery: "portable-bulk" },
      { ...view.nativeBundle, sha256: "not-a-hash" },
      { ...view.nativeBundle, byteLength: 0 },
    ]) {
      expect(() => parseNativeSessionArchiveView(JSON.stringify({ ...view, nativeBundle }))).toThrow();
    }
    for (const override of [
      { nativeBytesBase64: "AA==" },
      { contentEncoding: "base64", content: "AA==" },
      { preview: { kind: "download-only", content: "AA==" } },
      { preview: { kind: "text", content: "wrong text" } },
    ]) {
      expect(() => parseNativeSessionArchiveView(JSON.stringify({
        ...view, files: [{ ...view.files[0], ...override }, ...view.files.slice(1)],
      }))).toThrow();
    }
    const media = '{"type":"image","data":"data:;base64,AA=="}\n';
    expect(() => parseNativeSessionArchiveView(JSON.stringify({
      ...view, files: [{ ...view.files[0], byteLength: Buffer.byteLength(media),
        sha256: createHash("sha256").update(media).digest("hex"), preview: { kind: "text", content: media } }, ...view.files.slice(1)],
    }))).toThrow(/must not be previewed/);
    expect(() => parseNativeSessionArchiveView(`{"format":"${NATIVE_SESSION_VIEW_FORMAT}",`)).toThrow(/malformed JSON/);
    expect(() => parseNativeSessionArchiveView(JSON.stringify({ ...view, format: "session-registry/native-session-view/999" }))).toThrow(/unsupported/);
  });

  it("keeps mapped-dependency originalPath provenance in the view and native manifest, not the extraction filename", () => {
    const path = `dependencies/${"a".repeat(64)}/output.txt`;
    const originalPath = "D:\\owner-approved-external\\output.txt";
    const archive = nativeV3ArchiveFixture([archiveFile(path, "attachment", "external source bytes\r\n", 0)]);
    const source = { ...archive.capture!.sources[0]!, originalPath };
    const publication = buildNativeSessionPublication({ ...archive, capture: { ...archive.capture!, sources: [source] } });
    expect(parseNativeSessionArchiveView(publication.content)!.capture!.sources[0]).toEqual(source);
    const files = extracted(publication.bundle);
    expect(files.get(path)).toEqual(Buffer.from("external source bytes\r\n"));
    expect(files.has(originalPath)).toBe(false);
    const manifest = JSON.parse(files.get(NATIVE_SESSION_BUNDLE_MANIFEST_PATH)!.toString("utf8"));
    expect(manifest.capture.sources[0]).toEqual(source);
  });

  it("round-trips native binary attachments and compressed partially undecodable JSONL bytes", () => {
    const bytes = Buffer.from([0, 255, 1, 137, 80, 78, 71]);
    const decoded = Buffer.concat([Buffer.from('{"type":"future"}\r\n'), Buffer.from([255, 10]), Buffer.from('{"partial":')]);
    const compressed = zstdCompressSync(decoded);
    const archive = nativeV3ArchiveFixture([
      { path: "events.jsonl.zst", kind: "events", content: decoded.toString("base64"),
        contentEncoding: "base64", sha256: createHash("sha256").update(decoded).digest("hex"),
        recordCount: inspectNativeJsonl(decoded).records.length,
        nativeEncoding: "zstd", nativeBytesBase64: compressed.toString("base64"),
        nativeSha256: createHash("sha256").update(compressed).digest("hex") },
      { path: "files/image.png", kind: "attachment", content: bytes.toString("base64"),
        contentEncoding: "base64", recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex") },
    ]);
    const parsed = parseNativeSessionArchive(JSON.stringify(archive))!;
    const files = extracted(buildNativeSessionBundle(parsed));
    expect(files.get("events.jsonl.zst")).toEqual(compressed);
    expect(files.get("files/image.png")).toEqual(bytes);
    expect(parsed.capture!.diagnostics.some(({ code }) => code === "invalid-utf8")).toBe(true);
  });

  it.each([NATIVE_SESSION_BUNDLE_MANIFEST_PATH, NATIVE_SESSION_BUNDLE_MANIFEST_PATH.toUpperCase(), `${NATIVE_SESSION_BUNDLE_MANIFEST_PATH}/child`])(
    "rejects collisions with V3 registry metadata: %s", (path) => {
      const archive = nativeV3ArchiveFixture([archiveFile(path, "attachment", "original source", 0)]);
      expect(() => buildNativeSessionBundle(archive)).toThrow(/duplicate|conflict/);
    },
  );

  it("extracts exact approved UTF-8 bytes, BOM, CRLF, whitespace, large numbers and unknown events", () => {
    const archive = fixture();
    const zip = buildNativeSessionBundle(archive);
    const files = extracted(zip);
    expect(files.size).toBe(archive.files.length);
    for (const file of archive.files) {
      expect(files.get(file.path.replaceAll("\\", "/"))).toEqual(Buffer.from(file.content));
    }
    expect(buildNativeSessionBundle(archive)).toEqual(zip);
  });

  it("preserves original compressed bytes and validates their decoded content without recompressing", () => {
    const archive = fixture();
    const source = archive.files[0]!;
    const bytes = zstdCompressSync(Buffer.from(source.content));
    const file = { ...source, path: "events.jsonl.zst", nativeEncoding: "zstd" as const,
      nativeBytesBase64: bytes.toString("base64"), nativeSha256: createHash("sha256").update(bytes).digest("hex") };
    const compressed = { ...archive, files: [file] };
    expect(parseNativeSessionArchive(JSON.stringify(compressed))).toEqual(compressed);
    expect(extracted(buildNativeSessionBundle(compressed)).get(file.path)).toEqual(bytes);
    for (const override of [
      { nativeSha256: "0".repeat(64) },
      { nativeBytesBase64: "bad base64!" },
      { nativeEncoding: undefined },
      { nativeBytesBase64: undefined },
      { nativeSha256: undefined },
      { nativeEncoding: "gzip" },
      { content: "{}", sha256: createHash("sha256").update("{}").digest("hex") },
    ]) {
      expect(() => buildNativeSessionBundle({ ...compressed, files: [{ ...file, ...override } as typeof file] })).toThrow();
    }
  });

  it("rejects invalid compression even when its native digest is correct", () => {
    const source = fixture().files[0]!;
    const bytes = Buffer.from("not zstd");
    expect(() => buildNativeSessionBundle({ ...fixture(), files: [{ ...source,
      nativeEncoding: "zstd", nativeBytesBase64: bytes.toString("base64"),
      nativeSha256: createHash("sha256").update(bytes).digest("hex"),
    }] })).toThrow(/decompressed/);
  });

  it("reports an unsupported Zstd runtime explicitly", async () => {
    vi.doMock("node:zlib", () => ({ zstdDecompressSync: undefined }));
    vi.resetModules();
    try {
      const { parseNativeSessionArchive: parse } = await import("../../src/archive/nativeSessionArchive.js");
      const source = fixture().files[0]!;
      const bytes = zstdCompressSync(Buffer.from(source.content));
      expect(() => parse(JSON.stringify({ ...fixture(), files: [{ ...source, nativeEncoding: "zstd",
        nativeBytesBase64: bytes.toString("base64"), nativeSha256: createHash("sha256").update(bytes).digest("hex"),
      }] }))).toThrow(/Unsupported runtime.*Zstd/);
    } finally {
      vi.doUnmock("node:zlib");
      vi.resetModules();
    }
  });

  it.each(["../escape", "/absolute", "C:\\absolute", "\\\\server\\share", "a/../b", "a//b",
    "a/./b", "file:stream", "NUL", "aux.txt", "COM1", "LPT9.log", "CON .txt", "CONIN$", "file.", "file ", "a\u0000b", "a\nb", "a?b", "\ud800"])(
    "rejects unsafe extraction names: %j", (path) => {
      expect(() => buildNativeSessionBundle({ ...fixture(), files: [archiveFile(path, "attachment", "bytes", 0)] })).toThrow();
    },
  );

  it.each([["a/b", "a\\b"], ["A.txt", "a.txt"], ["café", "cafe\u0301"], ["folder", "folder/file"]])(
    "rejects colliding extraction names %j and %j", (first, second) => {
      expect(() => buildNativeSessionBundle({ ...fixture(), files: [first, second].map((path) =>
        archiveFile(path, "attachment", "bytes", 0)) })).toThrow(/duplicat|conflict/);
    },
  );

  it("enforces ZIP filename/count limits and does not produce bundles from legacy captures", () => {
    expect(() => buildNativeSessionBundle({ ...fixture(), files: [
      archiveFile("x".repeat(65536), "attachment", "", 0),
    ] })).toThrow(/filename.*limit/);
    expect(() => buildNativeSessionBundle({ ...fixture(), files: Array(65535).fill(fixture().files[0]) })).toThrow(/too many files/);
    expect(() => buildNativeSessionBundle({ ...fixture(), resumable: false })).toThrow(/resumable V2/);
    expect(() => buildNativeSessionBundle({ ...fixture(), format: LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT, resumable: false }))
      .toThrow(/resumable V2/);
  });
});
