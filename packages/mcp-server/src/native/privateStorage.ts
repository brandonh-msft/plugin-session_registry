import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, relative, resolve } from "node:path";
import { NativeCaptureError } from "./errors.js";

/**
 * The capture directory holds exactly two kinds of file: the immutable
 * `<captureId>.json` original, and the `<captureId>.approved.json` redacted
 * variant that is staged there while it waits to be uploaded. Anything else
 * means the directory is shared with unrelated data and is not safe to use.
 */
const PRIVATE_CAPTURE_FILE = /^[a-f0-9]{64}(\.approved)?\.json$/;

/**
 * Captures live under the caller's own profile, which the operating system
 * already keeps private to that account. POSIX mode bits are free to set, so
 * they are applied directly; on Windows the profile's own ACLs are inherited.
 */
export async function protectPrivatePath(path: string, directory = false): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", "Private capture storage must not use symbolic links or special files.");
  }
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", "The private capture path belongs to a different owner.");
  }
  await chmod(path, directory ? 0o700 : 0o600);
}

export async function ensurePrivateCaptureDirectory(path: string): Promise<void> {
  const directory = resolve(path);
  if ([parse(directory).root, homedir(), process.cwd()].some((root) => relative(root, directory) === "")) {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", "Use a dedicated capture directory, not a filesystem, home, or workspace root.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (relative(directory, await realpath(directory)) !== "") {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", "The capture directory must not resolve through a symbolic link.");
  }
  if ((await readdir(directory)).some((name) => !PRIVATE_CAPTURE_FILE.test(name))) {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", "Use a dedicated capture directory containing only capture files and their approved variants.");
  }
  await protectPrivatePath(directory, true);
}

export async function writePrivateCapture(path: string, content: string): Promise<void> {
  // Exclusive creation refuses an existing file or a symlink at that name, so
  // captures stay immutable and the write cannot be redirected elsewhere.
  const handle = await open(path, "wx", 0o600);
  let complete = false;
  try {
    await handle.writeFile(content, "utf8");
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      try {
        await unlink(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

/**
 * Rewrites a staged approved variant. Unlike the original capture this file is
 * expected to change as the owner adds redactions, so the previous version is
 * unlinked first and the replacement still goes through the exclusive-creation
 * write above. A torn write is caught by the digest recorded inside the file,
 * and the original capture it was derived from is still on disk.
 */
export async function replacePrivateCapture(path: string, content: string): Promise<void> {
  await removePrivateCapture(path);
  await writePrivateCapture(path, content);
}

/** Removes a capture file if it is still present. */
export async function removePrivateCapture(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
