import { createHash } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  NATIVE_SESSION_ARCHIVE_FORMAT, PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
  buildNativeSessionBundle, buildNativeSessionPublication, hasNativeSessionBundle, inspectNativeJsonl,
  nativeFileBytes, nativeFileContentBytes, parseNativeSessionArchive,
  scan, type NativeArchiveFile, type NativeSessionArchive,
} from "@session-registry/core";
import {
  CaptureReviewRequiredError,
  maskFindingPreview,
  resolveNativeCapture as resolveCapture,
  resolveReviewedFindings,
  scanNativeCapture as scanCapture,
} from "../../src/native/review.js";

const metadata = { title: "Native session", summary: "A complete fixture session." };
const seed = "a".repeat(64);

// Source-focused cases explicitly accept the separate package warning. The
// package-level tests below exercise the unacknowledged publication boundary.
const scanNativeCapture: typeof scanCapture = (capture, captureSeed) =>
  scanCapture(capture, captureSeed).filter(({ category }) => category !== "unscannable-native-bundle");
const resolveNativeCapture: typeof resolveCapture = (capture, captureSeed, resolutions, description, ownerRedactions) =>
  resolveCapture(capture, captureSeed, [
    ...resolutions,
    ...scanCapture(capture, captureSeed).filter(({ category }) => category === "unscannable-native-bundle").map(({ id }) => ({
      findingId: id, action: { kind: "acknowledge-unscanned" as const },
    })),
  ], description, ownerRedactions);

function archive(content: string, kind: "events" | "attachment" = "events"): NativeSessionArchive {
  return withFiles({
    format: NATIVE_SESSION_ARCHIVE_FORMAT,
    harness: { name: "github-copilot-cli", version: "1.0.84-4" },
    harnessSessionId: "fixture-session", capturedAt: "2026-09-10T20:00:00.000Z",
    sourceFormat: "copilot-events-v1", scope: "persisted-session-records", resumable: false,
    files: [], redactions: [],
  }, [{
      path: kind === "events" ? "events.jsonl" : "notes.txt", kind, content,
      recordCount: kind === "events" ? inspectNativeJsonl(Buffer.from(content)).records.length : 0,
      sha256: createHash("sha256").update(content).digest("hex"),
  }]);
}

function withFiles(original: NativeSessionArchive, files: readonly NativeArchiveFile[]): NativeSessionArchive {
  return {
    ...original, files,
    capture: {
      boundary: "observed-prefixes", entrypoint: files[0]!.path, selection: "explicit-path", layout: "session-directory",
      sources: files.map((file) => ({
        path: file.path, capturedBytes: nativeFileBytes(file).length, observedBytes: nativeFileBytes(file).length,
        sha256: createHash("sha256").update(nativeFileBytes(file)).digest("hex"), snapshot: "file-prefix",
      })),
      history: files.filter((file) => file.kind === "events").map((file) => ({
        path: file.path, sessionId: original.harnessSessionId,
      })),
      diagnostics: files.filter((file) => file.kind === "events").flatMap((file) =>
        inspectNativeJsonl(nativeFileContentBytes(file)).diagnostics.map((diagnostic) => ({ ...diagnostic, source: file.path }))),
    },
    restoration: { status: "not-verified", reason: "Native activation has not been tested." },
  };
}

function binaryFile(path: string, bytes: Buffer, kind: NativeArchiveFile["kind"] = "attachment"): NativeArchiveFile {
  return {
    path, kind, content: bytes.toString("base64"), contentEncoding: "base64",
    recordCount: kind === "events" ? inspectNativeJsonl(bytes).records.length : 0,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function previousArchive(current: NativeSessionArchive): NativeSessionArchive {
  const { capture: _capture, restoration: _restoration, ...previous } = current;
  return { ...previous, format: PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT, resumable: true };
}

describe("owner-controlled native security review", () => {
  it("requires a distinct owner warning even for a standalone native package with clean inspectable text", () => {
    const original = archive('{"type":"event","content":"inspectable fixture"}\n');
    const findings = scanCapture(original, seed);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "native-session.zip", category: "unscannable-native-bundle", manualReview: true,
    });
    expect(findings[0]!.proposedReplacement).toContain("not a scanned portable bulk export");
    expect(findings[0]!.proposedReplacement).toContain("excluded from portable bulk archives");
    expect(findings[0]!.proposedReplacement).toContain("before every native-bundle download");
    expect(() => resolveCapture(original, seed, [], metadata)).toThrow(CaptureReviewRequiredError);
    expect(() => resolveCapture(original, seed, [{
      findingId: findings[0]!.id, action: { kind: "false-positive" },
    }], metadata)).toThrow(/acknowledge-unscanned/);
    expect(resolveCapture(original, seed, [{
      findingId: findings[0]!.id, action: { kind: "acknowledge-unscanned" },
    }], metadata).content).toBe(JSON.stringify(original));
  });

  it("keeps unfamiliar events, recorded instructions, context, and exact source formatting unchanged", () => {
    const content =
      '{ "type": "model.future_event", "data": { "large":9007199254740993123, "modelCall":{"label":"retained"}, "rte":{"label":"retained"}, "requestMessages":[{"role":"system","content":"Recorded fixture instructions"}], "assignmentContext":{"label":"retained"}, "reasoningOpaque":"recorded fixture state" } }\r\n';
    const original = archive(content);
    expect(scanNativeCapture(original, seed)).toEqual([]);
    const approved = resolveNativeCapture(original, seed, [], metadata);
    expect(approved.archive.files[0]?.content).toBe(content);
    expect(approved.content).toBe(JSON.stringify(original));
    expect(approved.archive.redactions).toEqual([]);
  });

  it("reports a finding without deleting anything and blocks an unresolved publication", () => {
    const token = "ghp_" + "x".repeat(36);
    const original = archive(JSON.stringify({ type: "tool.result", output: token }) + "\n");
    const findings = scanNativeCapture(original, seed);
    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(findings[0]?.maskedPreview).toBe(`ghp_${"*".repeat(32)}xxxx`);
    expect(original.files[0]?.content).toContain(token);
    expect(() => resolveNativeCapture(original, seed, [], metadata)).toThrow(CaptureReviewRequiredError);
  });

  it("masks manualReview findings out of the public shape entirely", () => {
    const original = archive('{"type":"event","content":"inspectable fixture"}\n');
    const unscannable = scanCapture(original, seed).filter(({ category }) => category === "unscannable-native-bundle");
    expect(unscannable.length).toBeGreaterThan(0);
    for (const finding of unscannable) expect(finding.maskedPreview).toBeUndefined();
  });

  it("applies only the accepted security span and keeps the owner-only original intact", () => {
    const token = "ghp_" + "x".repeat(36);
    const content = `{ "type":"model.unfamiliar", "data":{"value":"${token}","modelCall":"keep exactly"} }\r\n`;
    const original = archive(content);
    const finding = scanNativeCapture(original, seed)[0]!;
    const approved = resolveNativeCapture(original, seed, [{
      findingId: finding.id, action: { kind: "accept-redaction" },
    }], metadata);
    expect(original.files[0]?.content).toBe(content);
    expect(approved.archive.files[0]?.content).toBe(content.replace(token, "[REDACTED]"));
    expect(approved.archive.redactions).toEqual([{ id: finding.id, source: "events.jsonl", category: finding.category }]);
    expect(approved.archive.capture!.sources).toEqual(original.capture!.sources);
    expect(approved.archive.files[0]!.sha256).not.toBe(original.files[0]!.sha256);
    expect(approved.archive.restoration!.status).toBe("invalidated-by-security-edits");
    expect(hasNativeSessionBundle(approved.archive)).toBe(true);
    expect(approved.archive.resumable).toBe(false);
  });

  it("applies case-insensitive owner-requested redactions without requiring scanner findings", () => {
    const content = '{"type":"fixture","content":"Hurlburb and hurlburb"}\n';
    const original = archive(content);
    const approved = resolveNativeCapture(original, seed, [], metadata, [{ exactText: "hurlburb" }]);
    expect(approved.archive.files[0]?.content).toBe('{"type":"fixture","content":"[REDACTED] and [REDACTED]"}\n');
    expect(approved.archive.redactions).toHaveLength(2);
    expect(approved.archive.redactions.every((redaction) => redaction.category === "owner-requested")).toBe(true);
    expect(original.files[0]?.content).toBe(content);
  });

  it("matches owner-requested redactions across NFC and NFD Unicode normalization forms", () => {
    // exactText in precomposed NFC matching decomposed NFD in source content
    const decomposedSource = '{"type":"fixture","content":"Hello Ren\u0065\u0301!"}\n';
    const originalDecomposed = archive(decomposedSource);
    const approvedNfc = resolveNativeCapture(originalDecomposed, seed, [], metadata, [{ exactText: "Ren\u00e9" }]);
    expect(approvedNfc.archive.files[0]?.content).toBe('{"type":"fixture","content":"Hello [REDACTED]!"}\n');

    // exactText in decomposed NFD matching precomposed NFC in source content
    const precomposedSource = '{"type":"fixture","content":"Hello Ren\u00e9!"}\n';
    const originalPrecomposed = archive(precomposedSource);
    const approvedNfd = resolveNativeCapture(originalPrecomposed, seed, [], metadata, [{ exactText: "Ren\u0065\u0301" }]);
    expect(approvedNfd.archive.files[0]?.content).toBe('{"type":"fixture","content":"Hello [REDACTED]!"}\n');
  });

  it("fails closed when owner-requested exact text is absent", () => {
    const original = archive('{"type":"fixture","content":"public"}\n');
    expect(() => resolveNativeCapture(original, seed, [], metadata, [{ exactText: "private" }]))
      .toThrow(/was not found/);
  });

  it("applies owner-requested redactions to publication metadata", () => {
    const original = archive('{"type":"fixture","content":"private-name"}\n');
    const approved = resolveNativeCapture(
      original,
      seed,
      [],
      { title: "Private-name report", summary: "Discussed private-name." },
      [{ exactText: "private-name" }],
    );
    expect(approved.title).toBe("[REDACTED] report");
    expect(approved.summary).toBe("Discussed [REDACTED].");
  });

  it("preserves false positives verbatim and authorizes their exact subsequent scanner matches", () => {
    const token = "ghp_" + "x".repeat(36);
    const original = archive(`{"type":"fixture","value":"${token}"}\n`);
    const finding = scanNativeCapture(original, seed)[0]!;
    const approved = resolveNativeCapture(original, seed, [{
      findingId: finding.id, action: { kind: "false-positive" },
    }], metadata);
    expect(approved.content).toBe(JSON.stringify(original));
    const scanned = scan(approved.content);
    if (scanned.status !== "ok") throw new Error("Expected scanner results");
    expect(resolveReviewedFindings(approved, scanned.findings)).toEqual([
      { findingIndex: 0, action: { kind: "false-positive" } },
    ]);
    expect(resolveReviewedFindings(approved, [{
      category: "github-personal-access-token", severity: "high",
      offset: 0, length: 40, matchedText: "ghp_" + "y".repeat(36),
    }])).toBeNull();
  });

  it("escapes custom replacements at the original JSON depth without reserializing other fields", () => {
    const content = '{ "type":"fixture", "data": { "password": "original-value", "preserve": 1.0000 } }\r\n';
    const original = archive(content);
    const finding = scanNativeCapture(original, seed)[0]!;
    const replacement = 'public "example" \\ value\nnext';
    const approved = resolveNativeCapture(original, seed, [{
      findingId: finding.id, action: { kind: "custom-replacement", replacementText: replacement },
    }], metadata);
    expect(approved.archive.files[0]?.content).toBe(content.replace("original-value", JSON.stringify(replacement).slice(1, -1)));
    expect(JSON.parse(approved.archive.files[0]!.content).data.password).toBe(replacement);
  });

  it("locates security findings through escaped, nested JSON while retaining false positives after earlier edits", () => {
    const first = "ghp_" + "x".repeat(36);
    const second = "ghp_" + "y".repeat(36);
    const nested = JSON.stringify({ output: `before ${first} between ${second} after` });
    const original = archive(JSON.stringify({ type: "fixture", copied: nested }) + "\n");
    const findings = scanNativeCapture(original, seed);
    expect(findings).toHaveLength(2);
    const approved = resolveNativeCapture(original, seed, [
      { findingId: findings[0]!.id, action: { kind: "accept-redaction" } },
      { findingId: findings[1]!.id, action: { kind: "false-positive" } },
    ], metadata);
    const result = JSON.parse(JSON.parse(approved.archive.files[0]!.content).copied);
    expect(result.output).toBe(`before [REDACTED] between ${second} after`);
    expect(approved.archive.redactions).toHaveLength(1);
  });

  it("does not silently approve a new credential introduced by a replacement", () => {
    const original = archive('{"type":"fixture","password":"original"}\n');
    const finding = scanNativeCapture(original, seed)[0]!;
    expect(() => resolveNativeCapture(original, seed, [{
      findingId: finding.id,
      action: { kind: "custom-replacement", replacementText: "ghp_" + "x".repeat(36) },
    }], metadata)).toThrow("new or changed security finding");
  });

  it("requires independent review of findings in public metadata", () => {
    const token = "ghp_" + "x".repeat(36);
    const original = archive('{"type":"fixture","content":"clean"}\n');
    let review: CaptureReviewRequiredError | undefined;
    try { resolveNativeCapture(original, seed, [], { ...metadata, title: token }); } catch (error) {
      if (!(error instanceof CaptureReviewRequiredError)) throw error;
      review = error;
    }
    expect(review?.findings).toHaveLength(1);
    expect(review?.findings[0]?.source).toBe("title");
    expect(JSON.stringify(review?.findings)).not.toContain(token);
    const approved = resolveNativeCapture(original, seed, [{
      findingId: review!.findings[0]!.id, action: { kind: "false-positive" },
    }], { ...metadata, title: token });
    expect(approved.title).toBe(token);
  });

  it("requires distinct resolutions bound to actual findings", () => {
    const original = archive('{"type":"fixture","password":"example"}\n');
    const finding = scanNativeCapture(original, seed)[0]!;
    const resolution = { findingId: finding.id, action: { kind: "false-positive" as const } };
    expect(() => resolveNativeCapture(original, seed, [resolution, resolution], metadata)).toThrow("INVALID_RESOLUTION");
    expect(() => resolveNativeCapture(original, seed, [{
      ...resolution, findingId: "b".repeat(64),
    }], metadata)).toThrow("INVALID_RESOLUTION");
  });

  it("scans malformed and partial JSONL as raw text while retaining duplicate-key structured redactions", () => {
    const token = "ghp_" + "x".repeat(36);
    const content = '\uFEFF{ "type":"future", "id":"repeat", "value":"' + token + '", "value":"' + token + '" }\r\n' +
      "not JSON " + token + "\r\n" +
      '{"partial":"' + token;
    const original = archive(content);
    const bounded = { ...original, capture: { ...original.capture!,
      history: [{ path: "events.jsonl", sessionId: "ancestor", rolloutId: "original-rollout", endByteOffset: Buffer.byteLength(content), endOrdinalExclusive: 1 }],
    } };
    const findings = scanNativeCapture(bounded, seed);
    expect(findings).toHaveLength(4);
    const approved = resolveNativeCapture(bounded, seed, findings.map(({ id }) => ({
      findingId: id, action: { kind: "accept-redaction" },
    })), metadata);
    expect(approved.archive.files[0]!.content).toBe(content.replaceAll(token, "[REDACTED]"));
    expect(approved.archive.files[0]!.recordCount).toBe(1);
    expect(approved.archive.capture!.history).toEqual(bounded.capture.history);
    expect(approved.archive.capture!.sources).toEqual(bounded.capture.sources);
    expect(approved.archive.capture!.diagnostics).toEqual(bounded.capture.diagnostics);
    expect(approved.archive.restoration!.status).toBe("invalidated-by-security-edits");
    expect(approved.archive.restoration!.reason).toContain("inherited byte offsets were not rebased");
    expect(parseNativeSessionArchive(approved.content)).toEqual(approved.archive);
  });

  it.each(["image.png", "state.sqlite"])("requires explicit manual acknowledgment of opaque %s without any byte mutation", (path) => {
    const token = "ghp_" + "x".repeat(36);
    const bytes = Buffer.concat([Buffer.from([0, 255, 137, 80, 78, 71]), Buffer.from(token)]);
    const original = withFiles(archive(""), [binaryFile(path, bytes)]);
    const findings = scanNativeCapture(original, seed);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ manualReview: true, category: "unscannable-binary", source: path });
    expect(findings[0]!.proposedReplacement).toContain("download only");
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(JSON.stringify(findings)).not.toContain(bytes.toString("base64"));
    expect(() => resolveNativeCapture(original, seed, [], metadata)).toThrow(CaptureReviewRequiredError);
    for (const kind of ["false-positive", "accept-redaction", "custom-replacement"] as const) {
      expect(() => resolveNativeCapture(original, seed, [{
        findingId: findings[0]!.id, action: kind === "custom-replacement" ? { kind, replacementText: "public" } : { kind },
      }], metadata)).toThrow(/acknowledge-unscanned/);
    }
    const approved = resolveNativeCapture(original, seed, [{
      findingId: findings[0]!.id, action: { kind: "acknowledge-unscanned" },
    }], metadata);
    expect(approved.content).toBe(JSON.stringify(original));
    expect(nativeFileBytes(approved.archive.files[0]!)).toEqual(bytes);
    expect(approved.archive.restoration!.status).toBe("not-verified");
    expect(approved.archive.redactions).toEqual([]);
    expect(buildNativeSessionBundle(approved.archive)).toBeInstanceOf(Uint8Array);
  });

  it.each([
    { type: "session.binary_asset", data: { base64: "AKIA" + "A".repeat(16) } },
    { type: "user", message: { content: [{ type: "image", source: { data: "AKIA" + "A".repeat(16), type: "base64", media_type: "image/png" } }] } },
    { type: "response_item", payload: { content: [{ type: "input_image", image_url: "data:image/png;base64," + "AKIA" + "A".repeat(16) }] } },
  ])("retains embedded native media only after acknowledgment and still scans its surrounding text", (record) => {
    const token = "ghp_" + "x".repeat(36);
    const original = archive(JSON.stringify({ ...record, note: token }) + "\r\n");
    const findings = scanNativeCapture(original, seed);
    expect(findings.some((finding) => finding.manualReview)).toBe(true);
    expect(findings.filter((finding) => !finding.manualReview)).toHaveLength(1);
    expect(() => resolveNativeCapture(original, seed, findings.filter((finding) => finding.manualReview).map(({ id }) => ({
      findingId: id, action: { kind: "acknowledge-unscanned" },
    })), metadata)).toThrow(CaptureReviewRequiredError);
    const approved = resolveNativeCapture(original, seed, findings.map((finding) => ({
      findingId: finding.id,
      action: { kind: finding.manualReview ? "acknowledge-unscanned" : "accept-redaction" },
    })), metadata);
    expect(approved.archive.files[0]!.content).toBe(original.files[0]!.content.replace(token, "[REDACTED]"));
    expect(approved.archive.files[0]!.content).toContain("AKIA" + "A".repeat(16));
    expect(approved.archive.redactions).toHaveLength(1);
    const scanned = scan(approved.content);
    if (scanned.status !== "ok") throw new Error("Expected scanner results");
    expect(resolveReviewedFindings(approved, scanned.findings)).not.toBeNull();
  });

  it("never previews, scans as plaintext, or text-edits base64 event bytes, including compressed binary sources", () => {
    const token = "ghp_" + "x".repeat(36);
    const prefix = '\uFEFF {"type":"event", "value":"' + token + '"}\r\n';
    const tail = '{"partial":"' + token;
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff, 0x80, 10]), Buffer.from(tail)]);
    const compressed = zstdCompressSync(bytes);
    const file = { ...binaryFile("events.jsonl.zst", bytes, "events"),
      nativeEncoding: "zstd" as const, nativeBytesBase64: compressed.toString("base64"),
      nativeSha256: createHash("sha256").update(compressed).digest("hex"),
    };
    const original = withFiles(archive(""), [file]);
    const findings = scanNativeCapture(original, seed);
    expect(findings.filter((finding) => finding.manualReview)).toHaveLength(1);
    expect(findings.filter((finding) => !finding.manualReview)).toHaveLength(0);
    expect(() => resolveNativeCapture(original, seed, [{
      findingId: findings[0]!.id, action: { kind: "accept-redaction" },
    }], metadata)).toThrow(/cannot be redacted as text/);
    const approved = resolveNativeCapture(original, seed, findings.map((finding) => ({
      findingId: finding.id, action: { kind: "acknowledge-unscanned" },
    })), metadata);
    expect(nativeFileContentBytes(approved.archive.files[0]!)).toEqual(bytes);
    expect(zstdDecompressSync(nativeFileBytes(approved.archive.files[0]!))).toEqual(bytes);
    expect(nativeFileBytes(approved.archive.files[0]!)).toEqual(compressed);
    expect(nativeFileBytes(original.files[0]!)).toEqual(compressed);
    expect(approved.archive.capture!.sources).toEqual(original.capture!.sources);
    expect(approved.archive.files[0]!.nativeSha256).toBe(file.nativeSha256);
    expect(approved.archive.restoration!.status).toBe("not-verified");
    expect(approved.archive.redactions).toEqual([]);
    expect(parseNativeSessionArchive(approved.content)).toEqual(approved.archive);
  });

  it("still redacts inspected UTF-8 text in Zstd sources while preserving original provenance", () => {
    const token = "ghp_" + "x".repeat(36);
    const text = '\uFEFF { "type":"future", "n":1.0000, "value":"' + token + '" }\r\n';
    const originalText = archive(text);
    const compressed = zstdCompressSync(Buffer.from(text, "utf8"));
    const original = withFiles(originalText, [{
      ...originalText.files[0]!, path: "events.jsonl.zst", nativeEncoding: "zstd",
      nativeBytesBase64: compressed.toString("base64"), nativeSha256: createHash("sha256").update(compressed).digest("hex"),
    }]);
    const finding = scanNativeCapture(original, seed)[0]!;
    const approved = resolveNativeCapture(original, seed, [{
      findingId: finding.id, action: { kind: "accept-redaction" },
    }], metadata);
    expect(approved.archive.files[0]!.content).toBe(text.replace(token, "[REDACTED]"));
    expect(zstdDecompressSync(nativeFileBytes(approved.archive.files[0]!))).toEqual(Buffer.from(text.replace(token, "[REDACTED]")));
    expect(approved.archive.capture!.sources).toEqual(original.capture!.sources);
    expect(nativeFileBytes(original.files[0]!)).toEqual(compressed);
    expect(approved.archive.files[0]!.nativeSha256).not.toBe(original.files[0]!.nativeSha256);
    expect(approved.archive.restoration!.status).toBe("invalidated-by-security-edits");
  });

  it("remaps approved source paths and native IDs throughout the manifest without keeping secret copies", () => {
    const token = "ghp_" + "x".repeat(36);
    const path = `sources/${token}/events.jsonl`;
    const base = archive('{"type":"event","value":"unchanged"}\r\n');
    const captured = withFiles({ ...base, harnessSessionId: token }, [{ ...base.files[0]!, path }]);
    const original: NativeSessionArchive = {
      ...captured, sourceFormat: `source-${token}`,
      capture: { ...captured.capture!,
        history: [{ path, sessionId: token, rolloutId: token, endByteOffset: 1000 }],
        diagnostics: [{ source: path, code: "missing-parent", line: 1 }],
      },
      redactions: [{ id: "earlier", category: "credential", source: path }],
    };
    const findings = scanNativeCapture(original, seed);
    const approved = resolveNativeCapture(original, seed, findings.map(({ id }) => ({
      findingId: id, action: { kind: "accept-redaction" },
    })), metadata);
    const approvedPath = "sources/[REDACTED]/events.jsonl";
    expect(approved.archive.files[0]!.path).toBe(approvedPath);
    expect(approved.archive.capture!.entrypoint).toBe(approvedPath);
    expect(approved.archive.capture!.sources[0]).toEqual({ ...original.capture!.sources[0], path: approvedPath });
    expect(approved.archive.capture!.history[0]).toEqual({
      path: approvedPath, sessionId: "[REDACTED]", rolloutId: "[REDACTED]", endByteOffset: 1000,
    });
    expect(approved.archive.capture!.diagnostics[0]!.source).toBe(approvedPath);
    expect(approved.archive.files[0]!.content).toBe(original.files[0]!.content);
    expect(approved.archive.restoration!.status).toBe("invalidated-by-security-edits");
    expect(approved.content).not.toContain(token);
    expect(Buffer.from(buildNativeSessionBundle(approved.archive)).toString("utf8")).not.toContain(token);
  });

  it("requires review of external originalPath metadata and retains no secret copy after approved path redactions", () => {
    const token = "ghp_" + "x".repeat(36);
    const originalPath = `D:\\owner-approved-external\\${token}.png`;
    const path = `dependencies/${createHash("sha256").update(originalPath).digest("hex")}/${token}.png`;
    const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 0]);
    const base = archive(`{ "type":"tool.result", "resultFile":${JSON.stringify(originalPath)}, "n":1.0000 }\r\n`);
    const captured = withFiles(base, [base.files[0]!, binaryFile(path, bytes)]);
    const original: NativeSessionArchive = {
      ...captured, capture: { ...captured.capture!,
        sources: captured.capture!.sources.map((source, index) => index === 1 ? { ...source, originalPath } : source),
        diagnostics: [{ source: path, code: "external-dependency" }],
      },
    };
    const findings = scanNativeCapture(original, seed);
    expect(findings.filter((finding) => !finding.manualReview)).toHaveLength(3);
    expect(findings.some(({ source }) => source === "capture.sources[1].originalPath")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(() => resolveNativeCapture(original, seed, findings
      .filter(({ source }) => source !== "capture.sources[1].originalPath")
      .map((finding) => ({
        findingId: finding.id, action: { kind: finding.manualReview ? "acknowledge-unscanned" : "accept-redaction" },
      })), metadata)).toThrow(CaptureReviewRequiredError);
    const approved = resolveNativeCapture(original, seed, findings.map((finding) => ({
      findingId: finding.id, action: { kind: finding.manualReview ? "acknowledge-unscanned" : "accept-redaction" },
    })), metadata);
    const approvedPath = path.replace(token, "[REDACTED]");
    expect(approved.archive.files[1]!.path).toBe(approvedPath);
    expect(approved.archive.capture!.sources[1]).toEqual({
      ...original.capture!.sources[1], path: approvedPath, originalPath: originalPath.replace(token, "[REDACTED]"),
    });
    expect(approved.archive.capture!.diagnostics[0]!.source).toBe(approvedPath);
    expect(approved.archive.capture!.sources[0]!.sha256).toBe(original.capture!.sources[0]!.sha256);
    expect(nativeFileBytes(approved.archive.files[1]!)).toEqual(bytes);
    expect(approved.archive.restoration!.status).toBe("invalidated-by-security-edits");
    expect(original.capture!.sources[1]!.originalPath).toBe(originalPath);
    expect(approved.content).not.toContain(token);
    const publication = buildNativeSessionPublication(approved.archive);
    expect(publication.content).not.toContain(token);
    expect(Buffer.from(publication.bundle).toString("utf8")).not.toContain(token);
  });

  it("does not accept an unscanned acknowledgment instead of resolving a text security finding", () => {
    const original = archive('{"type":"fixture","password":"example"}\n');
    expect(() => resolveNativeCapture(original, seed, [{
      findingId: scanNativeCapture(original, seed)[0]!.id, action: { kind: "acknowledge-unscanned" },
    }], metadata)).toThrow(/Text security findings/);
  });

  it.each(["", '{"type":"tool.result","output":"{\\"type\\":\\"image\\",\\"source\\":{\\"type\\":\\"base64\\",\\"data\\":\\"AAECAwQF\\"}}"}\r\n'])(
    "keeps historical V2 retries free of new package/media findings and metadata: %j", (content) => {
      const original = previousArchive(archive(content));
      const serialized = JSON.stringify(original);
      const zip = buildNativeSessionBundle(original);
      expect(scanCapture(original, seed)).toEqual([]);
      const loaded = parseNativeSessionArchive(serialized)!;
      const approved = resolveCapture(loaded, seed, [], metadata);
      expect(approved.content).toBe(serialized);
      expect(approved.archive).toEqual(original);
      expect(approved.archive).not.toHaveProperty("restoration");
      expect(approved.archive).not.toHaveProperty("capture");
      expect(buildNativeSessionBundle(approved.archive)).toEqual(zip);
    },
  );

  it("preserves prior V2 finding IDs, false-positive serialization and original Zstd ZIP bytes", () => {
    const token = "ghp_" + "x".repeat(36);
    const text = '\uFEFF { "type":"future", "n":900719925474099312345 }\r\n' +
      '{ "missingType":true, "value":"' + token + '" }\r\n';
    const current = archive(text);
    const compressed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const original = previousArchive({ ...current, files: [{
      ...current.files[0]!, path: "events.jsonl.zst", nativeEncoding: "zstd",
      nativeBytesBase64: compressed.toString("base64"), nativeSha256: createHash("sha256").update(compressed).digest("hex"),
    }] });
    const offset = text.indexOf(token);
    const legacyFindingId = createHash("sha256").update(JSON.stringify([
      seed, "file/0/content", offset, offset + token.length, "github-personal-access-token", token,
    ])).digest("hex");
    const findings = scanCapture(original, seed);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe(legacyFindingId);
    const resolutions = [{ findingId: legacyFindingId, action: { kind: "false-positive" as const } }];
    const approved = resolveCapture(parseNativeSessionArchive(JSON.stringify(original))!, seed, resolutions, metadata);
    expect(approved.content).toBe(JSON.stringify(original));
    expect(nativeFileBytes(approved.archive.files[0]!)).toEqual(compressed);
    expect(buildNativeSessionBundle(approved.archive)).toEqual(buildNativeSessionBundle(original));
    expect(approved.archive).not.toHaveProperty("restoration");
  });

  it.each(["accept-redaction", "custom-replacement"] as const)("keeps approved V2 %s output free of V3 restoration fields", (kind) => {
    const current = archive('{"type":"fixture","password":"example"}\n');
    const original = previousArchive(current);
    const finding = scanCapture(original, seed)[0]!;
    const replacement = kind === "accept-redaction" ? "[REDACTED]" : 'public "example"';
    const approved = resolveCapture(original, seed, [{
      findingId: finding.id, action: kind === "accept-redaction" ? { kind } : { kind, replacementText: replacement },
    }], metadata);
    const expectedText = original.files[0]!.content.replace("example", JSON.stringify(replacement).slice(1, -1));
    const expected: NativeSessionArchive = {
      ...original,
      files: [{ ...original.files[0]!, content: expectedText, sha256: createHash("sha256").update(expectedText).digest("hex") }],
      redactions: [{ id: finding.id, category: finding.category, source: "events.jsonl" }],
    };
    expect(approved.archive.format).toBe(PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT);
    expect(approved.content).toBe(JSON.stringify(expected));
    expect(approved.archive).not.toHaveProperty("restoration");
    expect(approved.archive).not.toHaveProperty("capture");
    expect(parseNativeSessionArchive(approved.content)).toEqual(approved.archive);
    expect(hasNativeSessionBundle(approved.archive)).toBe(true);
    expect(buildNativeSessionBundle(approved.archive)).toEqual(buildNativeSessionBundle(expected));
  });
});

describe("maskFindingPreview", () => {
  it("fully masks values of 4 characters or fewer with no reveal", () => {
    expect(maskFindingPreview("")).toBe("");
    expect(maskFindingPreview("a")).toBe("*");
    expect(maskFindingPreview("ab12")).toBe("****");
  });

  it("reveals 1 character at each end for short (5-11 char) values", () => {
    expect(maskFindingPreview("secret")).toBe(`s${"*".repeat(4)}t`);
  });

  it("reveals 2 characters at each end for medium (12-23 char) values", () => {
    const value = "a".repeat(12);
    expect(maskFindingPreview(value)).toBe(`aa${"*".repeat(8)}aa`);
  });

  it("reveals 4 characters at each end for long (24+ char) values", () => {
    const token = `ghp_${"x".repeat(36)}`;
    expect(maskFindingPreview(token)).toBe(`ghp_${"*".repeat(32)}xxxx`);
  });

  it("collapses whitespace/control characters so multi-line structure never leaks", () => {
    const pem = "-----BEGIN KEY-----\nMIIBaAAA\nBBBB\n-----END KEY-----";
    const preview = maskFindingPreview(pem);
    expect(preview).not.toContain("\n");
    expect(preview.length).toBe(pem.replace(/\s+/g, " ").length);
  });
});
