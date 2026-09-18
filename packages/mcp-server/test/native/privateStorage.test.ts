import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateCaptureDirectory, protectPrivatePath, writePrivateCapture } from "../../src/native/privateStorage.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "registry-private-storage-"));
  directories.push(directory);
  return directory;
}

describe("private capture storage", () => {
  it("keeps originals immutable and does not overwrite an existing capture", async () => {
    const directory = await fixture();
    await ensurePrivateCaptureDirectory(directory);
    const path = join(directory, `${"a".repeat(64)}.json`);
    await writePrivateCapture(path, "owner-only original");
    expect(await readFile(path, "utf8")).toBe("owner-only original");
    await expect(writePrivateCapture(path, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("owner-only original");
    await protectPrivatePath(path);
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o077).toBe(0);
      expect((await lstat(path)).mode & 0o077).toBe(0);
    }
  });

  it("writes captures whose absolute paths exceed the legacy Windows limit", async () => {
    const root = await fixture();
    // Enough nesting that the absolute path clears the 260-character legacy
    // limit from any temporary directory, including short POSIX ones, while
    // each component stays inside the 255-byte filesystem limit.
    const directory = join(root, "nested-directory-name".repeat(6), "nested-directory-name".repeat(6), "captures");
    await ensurePrivateCaptureDirectory(directory);
    const path = join(directory, `${"c".repeat(64)}.json`);
    expect(path.length).toBeGreaterThan(260);
    await writePrivateCapture(path, "long-path private fixture");
    expect(await readFile(path, "utf8")).toBe("long-path private fixture");
  });

  it("does not change permissions on unrelated storage or broad directories", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "unrelated.txt"), "unrelated");
    await expect(ensurePrivateCaptureDirectory(directory)).rejects.toThrow("dedicated capture directory");
    await expect(ensurePrivateCaptureDirectory(process.cwd())).rejects.toThrow("workspace root");
    expect(await readFile(join(directory, "unrelated.txt"), "utf8")).toBe("unrelated");
  });
});
