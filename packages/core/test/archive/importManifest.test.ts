import { createHash } from "node:crypto";
import { AssertionError } from "node:assert";
import { describe, expect, it } from "vitest";
import { validateImportManifest } from "../../src/archive/importManifest.js";
import { ImportError } from "../../src/archive/importErrors.js";
import { NATIVE_SESSION_BUNDLE_MANIFEST_PATH, buildNativeSessionBundle } from "../../src/archive/nativeSessionBundle.js";
import { SESSION_MANIFEST_PATH, buildSessionManifestBytes } from "../../src/archive/sessionManifest.js";
import { readNativeSessionBundle, type NativeSessionBundleEntry } from "../../src/archive/nativeSessionBundleReader.js";
import { nativeV3ArchiveFixture } from "./nativeSessionArchive.fixture.js";

async function validEntries(): Promise<ReadonlyMap<string, NativeSessionBundleEntry>> {
  return readNativeSessionBundle(buildNativeSessionBundle(nativeV3ArchiveFixture([
    {
      path: "events/main.jsonl",
      kind: "events",
      content: '{"type":"user.message"}\n',
      recordCount: 1,
      sha256: createHash("sha256").update('{"type":"user.message"}\n').digest("hex"),
    },
  ])));
}

function withManifest(
  entries: ReadonlyMap<string, NativeSessionBundleEntry>,
  update: (manifest: Record<string, unknown>) => void,
): Map<string, NativeSessionBundleEntry> {
  const result = new Map(entries);
  const manifestEntry = result.get(NATIVE_SESSION_BUNDLE_MANIFEST_PATH)!;
  const manifest = JSON.parse(Buffer.from(manifestEntry.bytes).toString("utf8")) as Record<string, unknown>;
  update(manifest);
  result.set(NATIVE_SESSION_BUNDLE_MANIFEST_PATH, {
    path: NATIVE_SESSION_BUNDLE_MANIFEST_PATH,
    bytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
  });
  return result;
}

async function expectCode(
  entries: ReadonlyMap<string, NativeSessionBundleEntry>,
  code: string,
  text?: string,
): Promise<ImportError> {
  try {
    validateImportManifest(entries);
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    expect(error.code).toBe(code);
    if (text !== undefined) expect(error.message).toContain(text);
    return error;
  }
  throw new AssertionError({ message: `expected ${code}` });
}

describe("validateImportManifest", () => {
  it("validates a V3 bundle and reports the trust-prompt metadata", async () => {
    const result = validateImportManifest(await validEntries());
    expect(result.harness).toMatchObject({ name: "github-copilot-cli", version: "1.2.3<version>" });
    expect(result.capturedAt).toBe("2026-09-10T10:01:00.000Z");
    expect(result.files).toHaveLength(1);
    expect(result.restoration.status).toBe("not-verified");
  });

  it("refuses a bundle without a manifest as an unverifiable V2 bundle", async () => {
    const entries = new Map(await validEntries());
    entries.delete(NATIVE_SESSION_BUNDLE_MANIFEST_PATH);
    await expectCode(entries, "IMPORT_MANIFEST_MISSING", "predates verifiable manifests");
  });

  it("rejects malformed, wrong-format, missing-field, and unknown-status manifests", async () => {
    const entries = await validEntries();
    await expectCode(withManifest(entries, (manifest) => { delete manifest.notice; }), "IMPORT_MANIFEST_INVALID", "notice");
    await expectCode(withManifest(entries, (manifest) => { manifest.format = "session-registry/native-bundle/2"; }), "IMPORT_MANIFEST_INVALID", "V3");
    await expectCode(withManifest(entries, (manifest) => {
      (manifest.restoration as Record<string, unknown>).status = "unknown";
    }), "IMPORT_MANIFEST_INVALID", "restoration.status");
    const malformed = new Map(entries);
    malformed.set(NATIVE_SESSION_BUNDLE_MANIFEST_PATH, {
      path: NATIVE_SESSION_BUNDLE_MANIFEST_PATH,
      bytes: Buffer.from("{"),
    });
    await expectCode(malformed, "IMPORT_MANIFEST_INVALID", "malformed JSON");
  });

  it("rejects precision-losing manifest numbers before parsing", async () => {
    const entries = await validEntries();
    await expectCode(withManifest(entries, (manifest) => {
      (manifest.approvedFiles as Array<Record<string, unknown>>)[0]!.bytes = 9007199254740993;
    }), "IMPORT_MANIFEST_INVALID", "unsafe JSON number");
  });

  it("distinguishes missing, unexpected, and duplicate approved entries", async () => {
    const entries = await validEntries();
    const missing = new Map(entries);
    missing.delete("events/main.jsonl");
    await expectCode(missing, "IMPORT_ENTRY_MISMATCH", "missing ZIP entry");
    const extra = new Map(entries);
    extra.set("unexpected.txt", { path: "unexpected.txt", bytes: Buffer.from("x") });
    await expectCode(extra, "IMPORT_ENTRY_MISMATCH", "unexpected ZIP entry");
    await expectCode(withManifest(entries, (manifest) => {
      const files = manifest.approvedFiles as Array<Record<string, unknown>>;
      manifest.approvedFiles = [files[0], { ...files[0] }];
    }), "IMPORT_ENTRY_MISMATCH", "duplicate manifest entry");
  });

  it("accepts the share-page manifest.json entry without requiring it in approvedFiles", async () => {
    const entries = new Map(await validEntries());
    entries.set(SESSION_MANIFEST_PATH, {
      path: SESSION_MANIFEST_PATH,
      bytes: buildSessionManifestBytes({
        sessionId: "sess_123",
        harnessSessionId: "harness-abc",
        title: "Example",
        summary: "Example summary",
        harness: { name: "github-copilot-cli", version: "1.2.3" },
        capturedAt: "2026-09-10T10:01:00.000Z",
        ownerGithubLogin: "octocat",
      }),
    });
    const result = validateImportManifest(entries);
    expect(result.files).toHaveLength(1);
    expect(result.files.some((file) => file.path === SESSION_MANIFEST_PATH)).toBe(false);
  });

  it("verifies byte length, sha256, and contentSha256 independently", async () => {
    const entries = await validEntries();
    await expectCode(withManifest(entries, (manifest) => {
      (manifest.approvedFiles as Array<Record<string, unknown>>)[0]!.sha256 = "0".repeat(64);
    }), "IMPORT_HASH_MISMATCH", "sha256");
    await expectCode(withManifest(entries, (manifest) => {
      (manifest.approvedFiles as Array<Record<string, unknown>>)[0]!.contentSha256 = "0".repeat(64);
    }), "IMPORT_HASH_MISMATCH", "contentSha256");
    const altered = new Map(entries);
    const entry = altered.get("events/main.jsonl")!;
    altered.set(entry.path, { path: entry.path, bytes: Buffer.from('{"type":"altered"}\n') });
    await expectCode(altered, "IMPORT_HASH_MISMATCH", "events/main.jsonl");
  });

  it("sanitizes every displayable manifest string before returning it", async () => {
    const result = validateImportManifest(withManifest(await validEntries(), (manifest) => {
      (manifest.harness as Record<string, unknown>).version = "\u001b[2J\u001b[31munsafe\u001b[0m\u202e";
      manifest.notice = "\u001b]0;overwrite\u0007safe\u0000";
    }));
    expect(result.harness.version).toBe("unsafe");
    expect(result.manifest.notice).toBe("safe");
    expect(result.harness.version).not.toMatch(/[\u001b\u0000\u202e]/);
  });
});
