import { AssertionError } from "node:assert";
import { describe, expect, it } from "vitest";
import { ImportError } from "../../src/archive/importErrors.js";
import { buildNativeSessionBundle, NATIVE_SESSION_BUNDLE_MANIFEST_PATH } from "../../src/archive/nativeSessionBundle.js";
import { nativeFileBytes } from "../../src/archive/nativeSessionArchive.js";
import { readNativeSessionBundle } from "../../src/archive/nativeSessionBundleReader.js";
import { archiveFile, nativeV3ArchiveFixture } from "./nativeSessionArchive.fixture.js";
import { buildRawZip, rawEntry, validRawZip } from "./hostileBundle.fixture.js";

async function expectFailure(bytes: Uint8Array, code: string): Promise<ImportError> {
  try {
    await readNativeSessionBundle(bytes);
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new AssertionError({ message: `expected readNativeSessionBundle to fail with ${code}, but it succeeded` });
}

describe("readNativeSessionBundle", () => {
  describe("happy path", () => {
    it("reads a minimal valid single-entry archive", async () => {
      const bytes = validRawZip();
      const result = await readNativeSessionBundle(bytes);
      expect(result.size).toBe(1);
      expect(new TextDecoder().decode(result.get("a.txt")!.bytes)).toBe("hello world");
    });

    it("reads a multi-entry archive built directly through the fixture builder", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "alpha"), rawEntry("dir/b.txt", "beta")] });
      const result = await readNativeSessionBundle(bytes);
      expect(result.size).toBe(2);
      expect(new TextDecoder().decode(result.get("a.txt")!.bytes)).toBe("alpha");
      expect(new TextDecoder().decode(result.get("dir/b.txt")!.bytes)).toBe("beta");
    });

    it("returns entries as owned buffers, independent of the input bytes", async () => {
      // Node's small-Buffer pooling makes `.buffer` identity alone unreliable
      // proof of independence (two unrelated small Buffers can coincidentally
      // share one pooled ArrayBuffer at different offsets). Use content large
      // enough to bypass pooling, then mutate the *input* after reading and
      // confirm the returned entry is unaffected -- decisive proof it owns an
      // independent copy rather than aliasing the input.
      const content = "x".repeat(5000);
      const bytes = Buffer.from(buildRawZip({ entries: [rawEntry("a.txt", content)] }));
      const result = await readNativeSessionBundle(bytes);
      const entry = result.get("a.txt")!;
      expect(Buffer.from(entry.bytes).toString("utf8")).toBe(content);
      bytes.fill(0);
      expect(Buffer.from(entry.bytes).toString("utf8")).toBe(content);
    });

    it("round-trips buildNativeSessionBundle byte-identically", async () => {
      // Uses hand-picked, filesystem-safe paths: the shared fixture's default
      // files include names (backslashes, `<`/`>`) the *writer* itself rejects
      // as unsafe, independent of anything under test here.
      const fixture = nativeV3ArchiveFixture([
        archiveFile("events/main.jsonl", "events", '{"type":"user.message"}\n', 1),
        archiveFile("attachments/note.txt", "attachment", "hello attachment\n", 0),
      ]);
      const built = buildNativeSessionBundle(fixture);
      const result = await readNativeSessionBundle(built);

      expect(result.size).toBe(fixture.files.length + 1);
      const manifestEntry = result.get(NATIVE_SESSION_BUNDLE_MANIFEST_PATH);
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.bytes)) as { approvedFiles: readonly { path: string }[] };
      expect(manifest.approvedFiles.map((file) => file.path).sort()).toEqual(fixture.files.map((file) => file.path).sort());

      for (const file of fixture.files) {
        const entry = result.get(file.path);
        expect(entry).toBeDefined();
        expect(Buffer.from(entry!.bytes).equals(Buffer.from(nativeFileBytes(file)))).toBe(true);
      }
    });

    it("honors an AbortSignal that is already aborted", async () => {
      const bytes = validRawZip();
      const controller = new AbortController();
      controller.abort();
      await expect(readNativeSessionBundle(bytes, { signal: controller.signal })).rejects.toThrow(ImportError);
      try {
        await readNativeSessionBundle(bytes, { signal: controller.signal });
      } catch (error) {
        expect((error as ImportError).code).toBe("IMPORT_INPUT_FAILURE");
      }
    });
  });

  describe("structural malformation -> IMPORT_NOT_A_BUNDLE", () => {
    it("rejects an empty buffer", async () => {
      await expectFailure(Buffer.alloc(0), "IMPORT_NOT_A_BUNDLE");
    });

    it("rejects a buffer too small to contain a ZIP end-of-central-directory record", async () => {
      await expectFailure(Buffer.alloc(10), "IMPORT_NOT_A_BUNDLE");
    });

    it("rejects a buffer with no end-of-central-directory signature anywhere", async () => {
      await expectFailure(Buffer.alloc(200), "IMPORT_NOT_A_BUNDLE");
    });

    it("rejects a truncated archive (cut mid central directory)", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "hello world")] });
      await expectFailure(bytes.subarray(0, bytes.length - 10), "IMPORT_NOT_A_BUNDLE");
    });

    it("rejects a declared entry count higher than the records actually present", async () => {
      const bytes = buildRawZip({
        entries: [rawEntry("a.txt", "x"), rawEntry("b.txt", "y")],
        totalEntriesOverride: 3,
        entriesThisDiskOverride: 3,
      });
      await expectFailure(bytes, "IMPORT_NOT_A_BUNDLE");
    });

    it("trusts the declared entry count and ignores any additional central directory bytes beyond it", async () => {
      // Structural cross-validation between the declared entry count and the
      // bytes actually present is yauzl's responsibility for this narrow read
      // path; a lower declared count simply means fewer entries are surfaced.
      const bytes = buildRawZip({
        entries: [rawEntry("a.txt", "x"), rawEntry("b.txt", "y")],
        totalEntriesOverride: 1,
        entriesThisDiskOverride: 1,
      });
      const result = await readNativeSessionBundle(bytes);
      expect(result.size).toBe(1);
      expect(result.has("a.txt")).toBe(true);
    });
  });

  describe("unsupported ZIP features -> IMPORT_UNSUPPORTED_ZIP", () => {
    it("rejects a deflate-compressed entry", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { method: 8, localMethod: 8 })] });
      await expectFailure(bytes, "IMPORT_UNSUPPORTED_ZIP");
    });

    it.each([
      ["encrypted", 0x0801],
      ["strong-encryption", 0x0840],
      ["data-descriptor", 0x0808],
      ["masked-local-header", 0x2800],
    ])("rejects the %s general-purpose flag", async (_label, gpFlag) => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { gpFlag, localGpFlag: gpFlag })] });
      await expectFailure(bytes, "IMPORT_UNSUPPORTED_ZIP");
    });

    it("rejects a non-zero central directory extra field length", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { centralExtraLength: 9 })] });
      await expectFailure(bytes, "IMPORT_UNSUPPORTED_ZIP");
    });

    it("rejects a non-zero central directory entry comment length", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { centralCommentLength: 4 })] });
      await expectFailure(bytes, "IMPORT_UNSUPPORTED_ZIP");
    });

    it("rejects an entry that is not marked as a UTF-8 name", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { gpFlag: 0, localGpFlag: 0 })] });
      await expectFailure(bytes, "IMPORT_UNSUPPORTED_ZIP");
    });
  });

  describe("unsafe names and attributes -> IMPORT_UNSAFE_NAME", () => {
    it.each([
      ["path traversal", "../escape.txt"],
      ["absolute path", "/etc/passwd"],
      ["backslash", "a\\b.txt"],
      ["drive letter prefix", "C:/windows/system32"],
      ["empty path segment", "a//b.txt"],
      ["current-directory segment", "./a.txt"],
      ["reserved property name", "__proto__/a.txt"],
      ["trailing dot segment", "a./b.txt"],
      ["trailing space segment", "a /b.txt"],
      ["colon in segment", "a:b.txt"],
      ["wildcard character", "a*b.txt"],
      ["reserved device name", "con.txt"],
      ["embedded control character", "a\u0000b.txt"],
      ["bidi format character", "a\u202eb.txt"],
    ])("rejects an entry name with %s", async (_label, name) => {
      const bytes = buildRawZip({ entries: [rawEntry(name, "x")] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });

    it("rejects two entry names that collide after case-folding", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "1"), rawEntry("A.TXT", "2")] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });

    it("rejects two entry names that collide after Unicode normalization (NFC vs NFD)", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("caf\u00e9.txt", "1"), rawEntry("cafe\u0301.txt", "2")] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });

    it("rejects a directory entry", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("dir/", "", { externalAttributes: (0o040755 << 16) >>> 0 })] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });

    it("rejects a symlink entry", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { externalAttributes: (0o120644 << 16) >>> 0 })] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });

    it("rejects a regular-file entry with the setuid bit set", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("a.txt", "x", { externalAttributes: ((0o100644 | 0o4000) << 16) >>> 0 })] });
      await expectFailure(bytes, "IMPORT_UNSAFE_NAME");
    });
  });

  describe("declared-size and count limits -> IMPORT_LIMIT_EXCEEDED", () => {
    it("rejects a single entry larger than the per-entry size limit", async () => {
      const data = Buffer.alloc(129 * 1024 * 1024);
      const bytes = buildRawZip({ entries: [{ name: "big.bin", data }] });
      await expectFailure(bytes, "IMPORT_LIMIT_EXCEEDED");
    }, 30_000);

    it("rejects entries whose aggregate uncompressed size exceeds the aggregate limit", async () => {
      const chunk = Buffer.alloc(90 * 1024 * 1024);
      const bytes = buildRawZip({
        entries: [
          { name: "a.bin", data: chunk },
          { name: "b.bin", data: chunk },
          { name: "c.bin", data: chunk },
        ],
      });
      await expectFailure(bytes, "IMPORT_LIMIT_EXCEEDED");
    }, 30_000);

    it("rejects a declared entry count above the supported cap", async () => {
      const entries = Array.from({ length: 4097 }, (_, index) => rawEntry(`f${index}.txt`, ""));
      const bytes = buildRawZip({ entries });
      await expectFailure(bytes, "IMPORT_LIMIT_EXCEEDED");
    }, 30_000);

    it("rejects an entry name longer than the supported length", async () => {
      const bytes = buildRawZip({ entries: [rawEntry("x".repeat(2000), "y")] });
      await expectFailure(bytes, "IMPORT_LIMIT_EXCEEDED");
    });

    it("rejects a total-name-bytes sum above the supported limit", async () => {
      const entries = Array.from({ length: 300 }, (_, index) =>
        rawEntry(`${index.toString().padStart(4, "0")}${"z".repeat(896)}`, ""),
      );
      const bytes = buildRawZip({ entries });
      await expectFailure(bytes, "IMPORT_LIMIT_EXCEEDED");
    });
  });

  describe("hash verification -> IMPORT_HASH_MISMATCH", () => {
    it("rejects an entry whose stored bytes do not match its declared CRC-32", async () => {
      const bytes = Buffer.from(buildRawZip({ entries: [rawEntry("a.txt", "hello world")] }));
      const dataOffset = 30 + Buffer.byteLength("a.txt", "utf8");
      bytes[dataOffset] = bytes[dataOffset]! ^ 0xff;
      await expectFailure(bytes, "IMPORT_HASH_MISMATCH");
    });
  });
});