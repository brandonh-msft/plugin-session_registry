import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, relative, resolve } from "node:path";
import { NativeCaptureError } from "./errors.js";
import { protectPrivatePath, writePrivateFileExclusive } from "./privatePaths.js";

export { protectPrivatePath } from "./privatePaths.js";

/**
 * The capture directory holds exactly two kinds of file: the immutable
 * `<captureId>.json` original, and the `<captureId>.approved.json` redacted
 * variant that is staged there while it waits to be uploaded. Anything else
 * means the directory is shared with unrelated data and is not safe to use.
 */
const PRIVATE_CAPTURE_FILE = /^[a-f0-9]{64}(\.approved)?\.json$/;

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
  await writePrivateFileExclusive(path, content, 0o600);
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