import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeFiles, parseRecords, sourceBytes } from "../../src/native/files.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-file-test-"));
  directories.push(root);
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"type":"fixture"}\n');
  return { root, path, files: new NativeFiles(root, 2 * 1024 * 1024) };
}

describe("bounded native file reads", () => {
  it("freezes a journal prefix while the publishing turn appends more events", async () => {
    const { path, files } = await fixture();
    const source = await files.read(path);
    await appendFile(path, '{"type":"later"}\n');
    await expect(files.assertUnchanged()).resolves.toBeUndefined();
    expect(source.content).toBe('{"type":"fixture"}\n');
    expect(source.capturedSize).toBe(Buffer.byteLength(source.content));
    expect(await files.read(path)).toBe(source);
  });

  it("uses the same observed-prefix contract for growing tool-output attachments", async () => {
    const { root, files } = await fixture();
    const output = join(root, "tool-output.txt");
    await writeFile(output, "output at cutoff\n");
    const source = await files.read(output);
    await appendFile(output, "output written after cutoff\n");
    await expect(files.assertUnchanged()).resolves.toBeUndefined();
    expect(source.content).toBe("output at cutoff\n");
  });

  it("freezes directory inventory rather than requiring an active session to stop writing", async () => {
    const { root, files } = await fixture();
    const names = await files.list(".");
    await writeFile(join(root, "late-dependency.txt"), "later");
    expect(await files.list(".")).toEqual(names);
    await expect(files.assertUnchanged()).resolves.toBeUndefined();
  });

  it("enforces the selected root while preserving undecodable binary sources", async () => {
    const { path, files } = await fixture();
    await expect(files.read(join("..", "outside.txt"))).rejects.toThrow("UNSAFE_SOURCE_PATH");
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    await writeFile(path, bytes);
    const source = await files.read(path);
    expect(source.contentEncoding).toBe("base64");
    expect(sourceBytes(source)).toEqual(bytes);
  });

  it("preserves duplicate keys instead of reserializing away an earlier native field", async () => {
    const { path, files } = await fixture();
    const content = '{"type":"fixture","data":{"value":"earlier","\\u0076alue":"later"}}\n';
    await writeFile(path, content);
    const source = await files.read(path);
    expect(source.content).toBe(content);
    expect(parseRecords(source)).toHaveLength(1);
  });

  it("rejects a rewrite of captured bytes even when the writer also appends", async () => {
    const { path, files } = await fixture();
    await files.read(path);
    const writer = await open(path, "r+");
    try {
      await writer.write(Buffer.from('{"type":"changed"}\n'), 0, 19, 0);
    } finally {
      await writer.close();
    }
    await appendFile(path, '{"type":"after"}\n');
    await expect(files.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects source replacement and truncation instead of accepting a new generation", async () => {
    const { root, path, files } = await fixture();
    await files.read(path);
    await rename(path, join(root, "old.jsonl"));
    await writeFile(path, '{"type":"fixture"}\n');
    await expect(files.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
    const second = new NativeFiles(root, 1_024);
    await second.read(path);
    await writeFile(path, "");
    await expect(second.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects pathname replacement at the end of prefix verification", async () => {
    const { root, path, files } = await fixture();
    await files.read(path);
    const originalResolve = files.resolve.bind(files);
    let observations = 0;
    vi.spyOn(files, "resolve").mockImplementation(async (source) => {
      const selected = await originalResolve(source);
      if (++observations === 2) {
        await rename(path, join(root, "replaced.jsonl"));
        await writeFile(path, '{"type":"replacement"}\n');
      }
      return selected;
    });
    await expect(files.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("captures only a bounded inherited prefix and permits changes after that boundary", async () => {
    const { root, path, files } = await fixture();
    const prefix = '{"type":"inherited","content":"unicode \\u03bb"}\r\n';
    await writeFile(path, prefix + '{"type":"unrelated-parent-suffix"}\n');
    const source = await files.read(path, { endByteOffset: Buffer.byteLength(prefix) });
    await writeFile(path, prefix + '{"type":"rewritten-and-longer-parent-suffix"}\n');
    await expect(files.assertUnchanged()).resolves.toBeUndefined();
    expect(sourceBytes(source)).toEqual(Buffer.from(prefix));
    expect(source.capturedSize).toBeLessThan(source.observedSize);
    await expect(new NativeFiles(root, 2 * 1024 * 1024).read(path, { endByteOffset: 1_000_000 }))
      .rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it("regenerates only a compressed inherited prefix without including the excluded suffix", async () => {
    const { root, files } = await fixture();
    const prefix = '{"type":"inherited"}\n';
    const path = join(root, "ancestor.jsonl.zst");
    await writeFile(path, zstdCompressSync(Buffer.from(prefix + '{"type":"not-in-this-session"}\n')));
    const source = await files.read(path, { endByteOffset: Buffer.byteLength(prefix) });
    expect(source.snapshotKind).toBe("decoded-prefix");
    expect(source.content).toBe(prefix);
    const native = Buffer.from(source.native!.bytesBase64, "base64");
    expect(zstdDecompressSync(native).toString("utf8")).toBe(prefix);
    expect(source.native!.sha256).toBe(createHash("sha256").update(native).digest("hex"));
    await expect(files.assertUnchanged()).resolves.toBeUndefined();
  });

  it("keeps malformed lines and a partial tail as source evidence", async () => {
    const { path, files } = await fixture();
    const content = '\uFEFF{"type":"first","number":1.0000}\r\n\n{broken}\n{"type":"partial"';
    await writeFile(path, content);
    const source = await files.read(path);
    expect(source.content).toBe(content);
    expect(parseRecords(source).map((record) => record.type)).toEqual(["first"]);
  });

  it("creates a consistent SQLite backup including committed WAL content", async () => {
    const { root, files } = await fixture();
    const path = join(root, "session.db");
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (content TEXT);");
      database.prepare("INSERT INTO events VALUES (?)").run("committed in WAL");
      const original = await readFile(path);
      const source = await files.read(path);
      expect(source.snapshotKind).toBe("sqlite-backup");
      expect(source.contentEncoding).toBe("base64");
      database.prepare("INSERT INTO events VALUES (?)").run("after snapshot");
      await expect(files.assertUnchanged()).resolves.toBeUndefined();
      expect(await readFile(path)).toEqual(original);
      const copyPath = join(root, "captured.sqlite");
      await writeFile(copyPath, sourceBytes(source));
      const copy = new DatabaseSync(copyPath, { readOnly: true });
      try {
        expect(copy.prepare("SELECT content FROM events").all()).toEqual([{ content: "committed in WAL" }]);
      } finally {
        copy.close();
      }
    } finally {
      database.close();
    }
  });
});
