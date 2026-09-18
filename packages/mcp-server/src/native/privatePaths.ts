import { chmod, lstat, open, unlink } from "node:fs/promises";
import { NativeCaptureError } from "./errors.js";

/**
 * Generic private-storage primitives shared by the native capture directory
 * and the import extraction workspace (`../import/workspace.ts`). Both live
 * under the caller's own profile, which the operating system already keeps
 * private to that account, so POSIX mode bits are free to set directly; on
 * Windows the profile's own ACLs are inherited and no additional per-file ACL
 * layer is added here (a prior attempt at one failed on ReFS and was removed).
 *
 * `onUnsafe` lets each caller raise its own error type — the capture path
 * keeps throwing `NativeCaptureError` unchanged, while the import workspace
 * throws `ImportError` with a stable import error code.
 */
export async function protectPrivatePath(
  path: string,
  directory = false,
  onUnsafe: (message: string) => never = (message) => {
    throw new NativeCaptureError("UNSAFE_CAPTURE_STORAGE", message);
  },
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) {
    onUnsafe("Private storage must not use symbolic links or special files.");
  }
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    onUnsafe("The private path belongs to a different owner.");
  }
  await chmod(path, directory ? 0o700 : 0o600);
}

/**
 * Writes a file with an exclusive create (`wx`), so an existing file or a
 * symlink at that name is refused rather than followed or overwritten.
 *
 * This guarantees no-follow only for the final path component — earlier
 * components in the destination path are still resolved normally by the
 * operating system. Callers that write beneath a directory tree they do not
 * fully control (the import workspace) must additionally verify every
 * intermediate component themselves; see `ensureContainedDirectory` in
 * `../import/workspace.ts`.
 */
export async function writePrivateFileExclusive(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  let complete = false;
  try {
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
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