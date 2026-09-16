import { createHash } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_HARNESSES,
  NATIVE_CLI_HARNESSES,
  NATIVE_IDE_HARNESSES,
  NATIVE_SESSION_ARCHIVE_FORMAT,
  PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
  NativeSessionArchiveError,
  hasNativeSessionBundle,
  inspectNativeJsonl,
  nativeFileBytes,
  nativeFileContentBytes,
  parseNativeSessionArchive,
} from "../../src/archive/nativeSessionArchive.js";
import { archiveFile, nativeArchiveFixture, nativeV3ArchiveFixture } from "./nativeSessionArchive.fixture.js";

describe("parseNativeSessionArchive", () => {
  it("adds explicit IDE identities without changing the existing CLI identities or archive version", () => {
    expect(NATIVE_CLI_HARNESSES).toEqual(["github-copilot-cli", "claude-code", "codex-cli"]);
    expect(NATIVE_IDE_HARNESSES).toEqual([
      "vscode-copilot-chat", "vscode-copilot-agent", "visual-studio-copilot",
      "github-copilot-desktop", "github-copilot-desktop-chat",
    ]);
    expect(new Set(NATIVE_HARNESSES).size).toBe(NATIVE_HARNESSES.length);
    expect(NATIVE_SESSION_ARCHIVE_FORMAT).toBe("session-registry/native-session/3");
  });

  it.each(NATIVE_HARNESSES)("round-trips all persisted content for %s without rewriting it", (name) => {
    const fixture = nativeArchiveFixture();
    const archive = { ...fixture, harness: { name, version: "1.0.0" } };
    const parsed = parseNativeSessionArchive(JSON.stringify(archive));
    expect(parsed).toEqual(archive);
    expect(parsed?.files[0]?.content).toContain("900719925474099312345");
    expect(parsed?.files[0]?.content).toContain('"stderr"');
    expect(parsed?.files[2]?.content.endsWith("END OF ATTACHMENT\n")).toBe(true);
    expect(parsed?.redactions).toEqual(fixture.redactions);
  });

  it.each([
    "assistant: legacy plaintext\n<script>alert(1)</script>",
    "",
    '{"message":"ordinary JSON transcript"}',
    '{"format":"another-system/v1"}',
    "Conversation about session-registry/native-session/1",
    "{ broken legacy content",
  ])("returns null for non-native legacy content: %s", (content) => {
    expect(parseNativeSessionArchive(content)).toBeNull();
  });

  it("rejects malformed and unsupported recognized native formats", () => {
    expect(() => parseNativeSessionArchive(`{"format":"${NATIVE_SESSION_ARCHIVE_FORMAT}",`))
      .toThrow(/malformed JSON/);
    expect(() => parseNativeSessionArchive(String.raw`{"\u0066ormat":"session-registry\/native-session\/1",`))
      .toThrow(/malformed JSON/);
    expect(() => parseNativeSessionArchive(JSON.stringify({ format: "session-registry/native-session/999" })))
      .toThrow(/Unsupported native session archive format/);
    expect(() => parseNativeSessionArchive(JSON.stringify({ format: NATIVE_SESSION_ARCHIVE_FORMAT })))
      .toThrow(NativeSessionArchiveError);
  });

  it.each([
    ["harness", null],
    ["harness", { name: "unsupported", version: "1" }],
    ["harness", { name: "claude-code", version: "" }],
    ["harnessSessionId", ""],
    ["capturedAt", "not-a-date"],
    ["sourceFormat", 1],
    ["scope", "complete-history"],
    ["resumable", "true"],
    ["files", null],
    ["redactions", {}],
  ])("rejects invalid %s metadata", (field, value) => {
    expect(() => parseNativeSessionArchive(JSON.stringify({ ...nativeArchiveFixture(), [field as string]: value })))
      .toThrow(NativeSessionArchiveError);
  });

  it.each([
    { kind: "unknown" },
    { content: null },
    { recordCount: -1 },
    { recordCount: 1.5 },
    { recordCount: 100 },
    { sha256: "not-a-checksum" },
    { sha256: "0".repeat(64) },
    { path: "../outside.jsonl" },
    { path: "C:\\outside.jsonl" },
    { path: "/absolute.jsonl" },
    { path: "\\\\server\\share\\events.jsonl" },
    { path: "events\\..\\outside.jsonl" },
    { path: "events\u0000.jsonl" },
  ])("rejects invalid file data: %j", (override) => {
    const archive = nativeArchiveFixture();
    expect(() => parseNativeSessionArchive(JSON.stringify({ ...archive, files: [{ ...archive.files[0], ...override }] })))
      .toThrow(NativeSessionArchiveError);
  });

  it("rejects duplicate source paths even with mixed separators", () => {
    const archive = nativeArchiveFixture();
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...archive,
      files: [archive.files[0], { ...archive.files[0], path: "events\\main.jsonl" }],
    }))).toThrow(/duplicated/);
  });

  it.each(["not JSON\n", "{}\n\n", '{"missing":\n'])("rejects invalid JSONL records: %j", (content) => {
    const archive = nativeArchiveFixture();
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...archive,
      files: [archiveFile("events.jsonl", "events", content, content.split("\n").length - 1)],
    }))).toThrow(/not valid JSON/);
  });

  it("accepts empty streams, CRLF, and JSONL without a trailing newline", () => {
    const archive = nativeArchiveFixture();
    const files = [
      archiveFile("empty.jsonl", "events", "", 0),
      archiveFile("crlf.jsonl", "events", '{"type":"future"}\r\n{}\r\n', 2),
      archiveFile("no-newline.jsonl", "events", "{}", 1),
      archiveFile("bom.jsonl", "events", '\uFEFF {"type":"unrecognized","id":900719925474099312345}\r\n', 1),
    ];
    expect(parseNativeSessionArchive(JSON.stringify({ ...archive, files }))?.files).toEqual(files);
  });

  it("preserves V1 format and false resumability without upgrading old archives", () => {
    const archive = { ...nativeArchiveFixture(), format: LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT };
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
    expect(() => parseNativeSessionArchive(JSON.stringify({ ...archive, resumable: true }))).toThrow(/legacy/);
  });

  it("keeps V2 readable and treats only its existing resumable flag as bundle availability", () => {
    const archive = nativeArchiveFixture();
    expect(archive.format).toBe(PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
    expect(hasNativeSessionBundle(archive)).toBe(false);
    expect(hasNativeSessionBundle({ ...archive, resumable: true })).toBe(true);
    expect(hasNativeSessionBundle({ ...archive, format: LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT })).toBe(false);
  });

  it("preserves V3 malformed, partial, duplicate and nonlinear raw evidence with diagnostic metadata", () => {
    const content = '\uFEFF{"type":"future","id":"repeat","parentId":"missing","n":1,"n":2}\r\n' +
      '{"type":"future","id":"repeat","parentId":"later"}\n{}\n[1,2]\nbad JSON\n{"partial":';
    const archive = nativeV3ArchiveFixture([archiveFile("events.jsonl", "events", content, 3)]);
    const parsed = parseNativeSessionArchive(JSON.stringify(archive));
    expect(parsed).toEqual(archive);
    expect(parsed!.files[0]!.content).toBe(content);
    expect(parsed!.capture!.diagnostics).toEqual([
      { source: "events.jsonl", line: 1, code: "duplicate-key" },
      { source: "events.jsonl", line: 3, code: "missing-type" },
      { source: "events.jsonl", line: 4, code: "non-object" },
      { source: "events.jsonl", line: 5, code: "invalid-json" },
      { source: "events.jsonl", line: 6, code: "invalid-json" },
      { source: "events.jsonl", line: 6, code: "partial-final-record" },
    ]);
    expect(hasNativeSessionBundle(parsed)).toBe(true);
    expect(parsed!.resumable).toBe(false);
    expect(parsed!.restoration!.status).toBe("not-verified");
    expect(() => parseNativeSessionArchive(JSON.stringify({ ...archive, resumable: true }))).toThrow(/resumability/);
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...archive, files: [{ ...archive.files[0], recordCount: 6 }],
    }))).toThrow(/decoded JSONL object records/);
  });

  it("hashes canonical V3 binary content as raw bytes, not base64 text", () => {
    const bytes = Buffer.from([0, 255, 195, 40, 10, 0, 128]);
    const file = {
      path: "state.sqlite", kind: "attachment" as const, content: bytes.toString("base64"),
      contentEncoding: "base64" as const, recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const archive = nativeV3ArchiveFixture([file]);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
    expect(nativeFileBytes(file)).toEqual(bytes);
    expect(nativeFileContentBytes(file)).toEqual(bytes);
    for (const override of [
      { content: `${file.content}\n` },
      { contentEncoding: "hex" },
      { sha256: createHash("sha256").update(file.content).digest("hex") },
    ]) {
      expect(() => parseNativeSessionArchive(JSON.stringify({
        ...archive, files: [{ ...file, ...override }],
      }))).toThrow(NativeSessionArchiveError);
    }
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...archive, format: PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
    }))).toThrow(/contentEncoding/);
  });

  it("validates multi-megabyte base64 without overflowing the regexp stack", () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    const file = {
      path: "files/large.bin", kind: "attachment" as const, contentEncoding: "base64" as const,
      content: bytes.toString("base64"), recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const parsed = parseNativeSessionArchive(JSON.stringify(nativeV3ArchiveFixture([file])))!;
    expect(parsed.files[0]!.sha256).toBe(file.sha256);
    expect(nativeFileBytes(parsed.files[0]!).equals(bytes)).toBe(true);
  });

  it("requires and validates V3 capture/restoration metadata rather than dropping it", () => {
    const archive = nativeV3ArchiveFixture();
    for (const override of [
      { capture: undefined },
      { restoration: undefined },
      { capture: { ...archive.capture, entrypoint: "../outside" } },
      { capture: { ...archive.capture, entrypoint: "absent.jsonl" } },
      { capture: { ...archive.capture, sources: [] } },
      { capture: { ...archive.capture, diagnostics: [{ source: "events.jsonl", code: "raw secret excerpt", line: 1 }] } },
      { capture: { ...archive.capture, diagnostics: [{ source: "events.jsonl", code: "missing-type", line: 0 }] } },
      { capture: { ...archive.capture, history: [{ path: "absent", sessionId: "source" }] } },
      { restoration: { status: "verified", reason: "A ZIP exists" } },
    ]) {
      expect(() => parseNativeSessionArchive(JSON.stringify({ ...archive, ...override }))).toThrow(NativeSessionArchiveError);
      expect(hasNativeSessionBundle({ ...archive, ...override } as typeof archive)).toBe(false);
    }
    const edited = {
      ...archive, restoration: { status: "invalidated-by-security-edits", reason: "Lineage offsets were not rebased." },
      capture: { ...archive.capture!, history: [{ path: archive.files[0]!.path, sessionId: "ancestor", endByteOffset: 1_000_000 }] },
    };
    expect(parseNativeSessionArchive(JSON.stringify(edited))).toEqual(edited);
  });

  it("preserves optional original paths for explicitly mapped external dependencies", () => {
    const path = `dependencies/${"a".repeat(64)}/outside.txt`;
    const archive = nativeV3ArchiveFixture([archiveFile(path, "attachment", "exact external bytes\r\n", 0)]);
    const source = archive.capture!.sources[0]!;
    const withOriginal = {
      ...archive, capture: { ...archive.capture!, sources: [{ ...source, originalPath: "D:\\owner-approved\\日本語\\outside.txt" }] },
    };
    expect(parseNativeSessionArchive(JSON.stringify(withOriginal))).toEqual(withOriginal);
    for (const originalPath of [null, "", " ", 42, "outside\0.txt", "\ud800"]) {
      expect(() => parseNativeSessionArchive(JSON.stringify({
        ...archive, capture: { ...archive.capture!, sources: [{ ...source, originalPath }] },
      }))).toThrow(/originalPath/);
    }
  });

  it("permits a SQLite backup larger than the observed main database because committed WAL pages are included", () => {
    const bytes = Buffer.alloc(8192);
    bytes.write("SQLite format 3\0");
    const file = {
      path: "state.sqlite", kind: "attachment" as const, contentEncoding: "base64" as const, content: bytes.toString("base64"),
      recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const archive = nativeV3ArchiveFixture([file]);
    const source = { ...archive.capture!.sources[0]!, capturedBytes: 8192, observedBytes: 4096, snapshot: "sqlite-backup" as const };
    const snapshot = { ...archive, capture: { ...archive.capture!, sources: [source] } };
    expect(parseNativeSessionArchive(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(nativeFileBytes(file)).toEqual(bytes);
    expect(file.sha256).not.toBe(createHash("sha256").update(file.content, "utf8").digest("hex"));
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...snapshot, capture: { ...snapshot.capture, sources: [{ ...source, snapshot: "file-prefix" }] },
    }))).toThrow(/exceeds its observed prefix/);
  });

  it("permits a decoded prefix whose recompressed representation exceeds the observed source size", () => {
    const text = '{"type":"future","content":"captured prefix"}\r\n';
    const original = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 0 } });
    const recompressed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    expect(recompressed.length).toBeGreaterThan(original.length);
    const file = {
      ...archiveFile("ancestors/prefix.jsonl.zst", "events", text, 1),
      nativeEncoding: "zstd" as const, nativeBytesBase64: recompressed.toString("base64"),
      nativeSha256: createHash("sha256").update(recompressed).digest("hex"),
    };
    const archive = nativeV3ArchiveFixture([file]);
    const capture = { ...archive.capture!, sources: [{
      ...archive.capture!.sources[0]!, snapshot: "decoded-prefix", observedBytes: original.length,
    }] };
    const parsed = parseNativeSessionArchive(JSON.stringify({ ...archive, capture }))!;
    expect(parsed.capture!.sources[0]!.capturedBytes).toBe(recompressed.length);
    expect(parsed.capture!.sources[0]!.observedBytes).toBe(original.length);
    expect(nativeFileBytes(parsed.files[0]!)).toEqual(recompressed);
  });

  it("requires attachments to have zero event records", () => {
    const archive = nativeArchiveFixture();
    expect(() => parseNativeSessionArchive(JSON.stringify({
      ...archive,
      files: [archiveFile("attachment.txt", "attachment", "full text", 1)],
    }))).toThrow(/zero for an attachment/);
  });

  describe("inspectNativeJsonl", () => {
    it("reports fixed diagnostics without snippets and keeps every object including duplicates and missing types", () => {
      const valid = '\uFEFF{"type":"event","nested":{"k":1,"\\u006b":2},"id":"same"}\r\n' +
        '{"type":"event","id":"same"}\n{"unknown":true}\nnull\n{"array":[1,2]}\n';
      const bytes = Buffer.concat([Buffer.from(valid), Buffer.from([255, 10]), Buffer.from('{"secret":"unfinished')]);
      const result = inspectNativeJsonl(bytes);
      expect(result.records).toHaveLength(4);
      expect(result.records[0]!.nested).toEqual({ k: 2 });
      expect(result.records[1]!.id).toBe("same");
      expect(result.records[2]).toEqual({ unknown: true });
      expect(result.diagnostics).toEqual([
        { line: 1, code: "duplicate-key" }, { line: 3, code: "missing-type" },
        { line: 4, code: "non-object" }, { line: 5, code: "missing-type" },
        { line: 6, code: "invalid-utf8" }, { line: 7, code: "invalid-json" },
        { line: 7, code: "partial-final-record" },
      ]);
      expect(JSON.stringify(result.diagnostics)).not.toContain("secret");
      expect(result.completeBytes).toBe(Buffer.byteLength(valid) + 2);
      expect(result.terminatedBytes).toBe(result.completeBytes);
    });

    it("counts complete final records without a newline and measures UTF-8 byte boundaries", () => {
      const prefix = '{"type":"future","text":"日本語"}\r\n';
      const final = '{"type":"later","text":"café"}';
      const result = inspectNativeJsonl(Buffer.from(prefix + final));
      expect(result.records).toHaveLength(2);
      expect(result.diagnostics).toEqual([]);
      expect(result.terminatedBytes).toBe(Buffer.byteLength(prefix));
      expect(result.completeBytes).toBe(Buffer.byteLength(prefix + final));
      expect(inspectNativeJsonl(new Uint8Array())).toEqual({ records: [], diagnostics: [], completeBytes: 0, terminatedBytes: 0 });
    });

    it("does not confuse braces or keys in strings and separate objects with duplicate keys", () => {
      const bytes = Buffer.from('{"type":"future","items":[{"k":1},{"k":2}],"text":"{\\"k\\":1,\\"k\\":2}"}\n');
      expect(inspectNativeJsonl(bytes).diagnostics).toEqual([]);
      const invalid = inspectNativeJsonl(Buffer.from([123, 34, 255]));
      expect(invalid.records).toEqual([]);
      expect(invalid.diagnostics).toEqual([{ line: 1, code: "invalid-utf8" }, { line: 1, code: "partial-final-record" }]);
      expect(invalid.completeBytes).toBe(0);
    });
  });

  it.each([null, { id: "r" }, { id: "", category: "credential", source: "file" }, { id: "r", category: 1, source: "file" }])(
    "rejects malformed redaction disclosures: %j",
    (redaction) => {
      expect(() => parseNativeSessionArchive(JSON.stringify({ ...nativeArchiveFixture(), redactions: [redaction] })))
        .toThrow(NativeSessionArchiveError);
    },
  );
});
