import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateCaptureDirectory, writePrivateCapture } from "../../src/native/privateStorage.js";
import {
  cleanupImportWorkspace,
  cleanupStaleImportWorkspaces,
  createImportWorkspace,
  defaultImportsRoot,
  verifySourceUnchanged,
  writeWorkspaceFile,
  type ImportWorkspace,
} from "../../src/import/workspace.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "registry-import-workspace-"));
  directories.push(directory);
  return directory;
}

async function fixtureWorkspace(root: string): Promise<ImportWorkspace> {
  return createImportWorkspace({
    handleId: "handle-1",
    bundleSha256: "a".repeat(64),
    importsRoot: root,
  });
}

describe("defaultImportsRoot", () => {
  it("resolves to a sibling of the capture directory under the user's profile", () => {
    const root = defaultImportsRoot({ homedir: () => join("C:", "Users", "example") });
    expect(root).toBe(join("C:", "Users", "example", ".session-registry", "imports"));
  });
});

describe("createImportWorkspace", () => {
  it("creates the workspace at 0o700 and persists a marker recording handle, hash, time, and pid", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    expect(workspace.path.startsWith(root)).toBe(true);

    const marker = JSON.parse(await readFile(workspace.markerPath, "utf8"));
    expect(marker).toMatchObject({ handleId: "handle-1", bundleSha256: "a".repeat(64), pid: process.pid });
    expect(typeof marker.createdAt).toBe("string");

    if (process.platform !== "win32") {
      expect((await lstat(workspace.path)).mode & 0o777).toBe(0o700);
      expect((await lstat(workspace.markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("never creates a shared or predictable workspace directory across imports", async () => {
    const root = await fixtureRoot();
    const first = await fixtureWorkspace(root);
    const second = await createImportWorkspace({ handleId: "handle-2", bundleSha256: "b".repeat(64), importsRoot: root });
    expect(first.path).not.toBe(second.path);
  });

  it("keeps existing native capture behavior unchanged after the refactor", async () => {
    const directory = await fixtureRoot();
    await ensurePrivateCaptureDirectory(directory);
    const path = join(directory, `${"a".repeat(64)}.json`);
    await writePrivateCapture(path, "owner-only original");
    expect(await readFile(path, "utf8")).toBe("owner-only original");

    const unrelated = await fixtureRoot();
    await writeFile(join(unrelated, "unrelated.txt"), "unrelated");
    await expect(ensurePrivateCaptureDirectory(unrelated)).rejects.toThrow("dedicated capture directory");
  });
});

describe("writeWorkspaceFile", () => {
  it("writes files at a fixed 0o600 regardless of any caller-supplied mode", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const destination = await writeWorkspaceFile(workspace, "events.jsonl", Buffer.from("{}"));
    expect(await readFile(destination, "utf8")).toBe("{}");
    if (process.platform !== "win32") {
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  it("creates nested directory components on demand", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const destination = await writeWorkspaceFile(workspace, join("nested", "deep", "file.txt"), Buffer.from("x"));
    expect(await readFile(destination, "utf8")).toBe("x");
  });

  it("fails a duplicate write to the same destination with EEXIST rather than overwriting", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    await writeWorkspaceFile(workspace, "events.jsonl", Buffer.from("first"));
    await expect(writeWorkspaceFile(workspace, "events.jsonl", Buffer.from("second"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(workspace.path, "events.jsonl"), "utf8")).toBe("first");
  });

  it("hard-fails on a pre-existing symlink at the destination path instead of writing through it", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const outside = await fixtureRoot();
    const outsideTarget = join(outside, "target.txt");
    await writeFile(outsideTarget, "outside content");
    const linkPath = join(workspace.path, "events.jsonl");
    await symlink(outsideTarget, linkPath, process.platform === "win32" ? "file" : undefined);

    await expect(writeWorkspaceFile(workspace, "events.jsonl", Buffer.from("payload"))).rejects.toBeTruthy();
    expect(await readFile(outsideTarget, "utf8")).toBe("outside content");
  });

  it("rejects a symlink used as an intermediate directory component", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const outsideRoot = await fixtureRoot();
    const evilDirectory = join(outsideRoot, "evil");
    await writeFile(evilDirectory, "not really used as a file, just needs to exist for symlink target purposes on some platforms").catch(() => undefined);
    const linkPath = join(workspace.path, "nested");
    await symlink(outsideRoot, linkPath, process.platform === "win32" ? "junction" : "dir");

    await expect(writeWorkspaceFile(workspace, join("nested", "file.txt"), Buffer.from("payload"))).rejects.toMatchObject({ code: "IMPORT_UNSAFE_NAME" });
  });

  it("rejects a Windows directory junction at a workspace path exactly as a symlink is rejected", async () => {
    if (process.platform !== "win32") return;
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const outsideRoot = await fixtureRoot();
    const linkPath = join(workspace.path, "nested");
    await symlink(outsideRoot, linkPath, "junction");

    await expect(writeWorkspaceFile(workspace, join("nested", "file.txt"), Buffer.from("payload"))).rejects.toMatchObject({ code: "IMPORT_UNSAFE_NAME" });
  });

  it("rejects a relative path that attempts to escape the workspace root", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    await expect(writeWorkspaceFile(workspace, join("..", "escaped.txt"), Buffer.from("payload"))).rejects.toMatchObject({ code: "IMPORT_UNSAFE_NAME" });
  });

  it("accepts a mixed-case workspace root path on Windows without a false rejection", async () => {
    if (process.platform !== "win32") return;
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const mixedCasePath = workspace.path
      .split("")
      .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()))
      .join("");
    const mixedWorkspace = { path: mixedCasePath };
    const destination = await writeWorkspaceFile(mixedWorkspace, "events.jsonl", Buffer.from("payload"));
    expect(await readFile(destination, "utf8")).toBe("payload");
  });
});

describe("verifySourceUnchanged", () => {
  it("accepts a source file whose bytes still match the recorded hash and size", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "bundle.zip");
    await writeFile(sourcePath, "bundle-bytes");
    const bytes = await readFile(sourcePath);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await expect(verifySourceUnchanged(sourcePath, { sha256, byteLength: bytes.byteLength })).resolves.toBeUndefined();
  });

  it("refuses a source file that changed size between validation and extraction", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "bundle.zip");
    await writeFile(sourcePath, "bundle-bytes");
    await expect(verifySourceUnchanged(sourcePath, { sha256: "0".repeat(64), byteLength: 999 })).rejects.toMatchObject({ code: "IMPORT_HASH_MISMATCH" });
  });

  it("refuses a source file whose bytes changed without changing size", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "bundle.zip");
    await writeFile(sourcePath, "AAAAAAAAAAAA");
    const originalBytes = await readFile(sourcePath);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(originalBytes).digest("hex");
    await writeFile(sourcePath, "BBBBBBBBBBBB");

    await expect(verifySourceUnchanged(sourcePath, { sha256, byteLength: originalBytes.byteLength })).rejects.toMatchObject({ code: "IMPORT_HASH_MISMATCH" });
  });
});

describe("cleanupImportWorkspace", () => {
  it("removes the workspace so decline and hard failure both leave nothing behind", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    await writeWorkspaceFile(workspace, "events.jsonl", Buffer.from("{}"));

    const result = await cleanupImportWorkspace(workspace.path);
    expect(result).toEqual({ path: workspace.path, removed: true });
    await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent when the workspace is already gone", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    await cleanupImportWorkspace(workspace.path);
    const result = await cleanupImportWorkspace(workspace.path);
    expect(result).toEqual({ path: workspace.path, removed: true });
  });

  it("reports a cleanup failure explicitly and never claims removal that did not happen", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    const failingRm = async () => {
      throw Object.assign(new Error("simulated failure"), { code: "EBUSY" });
    };

    const result = await cleanupImportWorkspace(workspace.path, { rm: failingRm as unknown as typeof rm });
    expect(result.removed).toBe(false);
    expect(result.error).toContain("simulated failure");
    await expect(stat(workspace.path)).resolves.toBeTruthy();
  });
});

describe("cleanupStaleImportWorkspaces", () => {
  it("removes a workspace whose owning process is gone and retains one whose process is alive", async () => {
    const root = await fixtureRoot();
    const alive = await createImportWorkspace({
      handleId: "alive",
      bundleSha256: "a".repeat(64),
      importsRoot: root,
      deps: { pid: 4242 },
    });
    const dead = await createImportWorkspace({
      handleId: "dead",
      bundleSha256: "b".repeat(64),
      importsRoot: root,
      deps: { pid: 4343 },
    });

    const result = await cleanupStaleImportWorkspaces(root, {
      isProcessAlive: (pid) => pid === 4242,
    });

    expect(result.retained).toEqual([alive.path]);
    expect(result.removed).toEqual([dead.path]);
    expect(result.failures).toEqual([]);
    await expect(stat(alive.path)).resolves.toBeTruthy();
    await expect(stat(dead.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a workspace with a missing or unreadable marker as stale", async () => {
    const root = await fixtureRoot();
    const workspace = await fixtureWorkspace(root);
    await rm(workspace.markerPath, { force: true });

    const result = await cleanupStaleImportWorkspaces(root, { isProcessAlive: () => true });

    expect(result.removed).toEqual([workspace.path]);
    expect(result.retained).toEqual([]);
  });

  it("returns an empty result when the imports root does not exist yet", async () => {
    const root = join(await fixtureRoot(), "does-not-exist");
    const result = await cleanupStaleImportWorkspaces(root);
    expect(result).toEqual({ removed: [], retained: [], failures: [] });
  });
});