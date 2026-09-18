import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ImportError } from "@session-registry/core";
import { protectPrivatePath, writePrivateFileExclusive } from "../native/privatePaths.js";

/**
 * Primitives for the importer-private extraction workspace (R69, R73, R75,
 * R90). This module exposes primitives only — Unit 7 owns the consent gate
 * and must call these only after an affirmative response to the trust
 * prompt. Nothing here may be invoked before consent.
 *
 * The workspace lives beside, not beneath, the native capture directory:
 * `ensurePrivateCaptureDirectory()` in `../native/privateStorage.ts` rejects
 * any entry that is not `<sha256>(.approved)?.json`, including
 * subdirectories, so placing extraction there would break capture outright.
 * `~/.session-registry/imports/` is a sibling root with its own invariant
 * that explicitly permits per-import directories and the marker file each
 * one contains.
 */

const IMPORT_ROOT_SEGMENT = "imports";
const IMPORT_WORKSPACE_PREFIX = "import-";
const IMPORT_WORKSPACE_MARKER_FILE = "workspace.json";

/** Entries directly inside the imports root: per-import directories only. */
const IMPORT_ROOT_ENTRY = /^[A-Za-z0-9._-]+$/;

export interface ImportWorkspaceDeps {
  readonly homedir: () => string;
  readonly pid: number;
  readonly now: () => string;
  /** Returns whether a process with the given pid is still running. */
  readonly isProcessAlive: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the process exists and
    // is reachable. Node implements this cross-platform, including Windows.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — still
    // alive. Any other error (notably ESRCH) means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const defaultImportWorkspaceDeps: ImportWorkspaceDeps = {
  homedir,
  pid: process.pid,
  now: () => new Date().toISOString(),
  isProcessAlive: defaultIsProcessAlive,
};

function unsafe(message: string): never {
  throw new ImportError("IMPORT_WORKSPACE_FAILURE", message);
}

function unsafeName(message: string): never {
  throw new ImportError("IMPORT_UNSAFE_NAME", message);
}

/** Default location for the imports root: `~/.session-registry/imports`. */
export function defaultImportsRoot(deps: Pick<ImportWorkspaceDeps, "homedir"> = defaultImportWorkspaceDeps): string {
  return join(deps.homedir(), ".session-registry", IMPORT_ROOT_SEGMENT);
}

/**
 * Case-sensitivity of path comparison must match the platform: Windows path
 * casing is not semantically meaningful, so a naive exact comparison there
 * produces false rejections of a legitimately contained path whose casing
 * differs only because some intermediate call normalized it.
 */
function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isContained(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + sep);
}

/**
 * Ensures the imports root exists, is not reached through a symbolic link or
 * reparse point, and holds nothing but per-import directories. Unlike the
 * capture directory's filename whitelist, this invariant is directory-shaped:
 * every entry must itself become a workspace (mkdtemp names, verified below).
 */
async function ensureImportsRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const real = await realpath(root);
  if (comparablePath(real) !== comparablePath(resolve(root))) {
    unsafe("The imports root must not resolve through a symbolic link.");
  }
  for (const name of await readdir(root)) {
    if (!IMPORT_ROOT_ENTRY.test(name)) unsafe(`Unexpected entry in the imports root: ${name}`);
  }
  await protectPrivatePath(root, true, unsafe);
  return real;
}

export interface ImportWorkspaceMarker {
  readonly handleId: string;
  readonly bundleSha256: string;
  readonly createdAt: string;
  readonly pid: number;
}

export interface ImportWorkspace {
  readonly path: string;
  readonly markerPath: string;
  readonly marker: ImportWorkspaceMarker;
}

export interface CreateImportWorkspaceOptions {
  readonly handleId: string;
  readonly bundleSha256: string;
  readonly importsRoot?: string;
  readonly deps?: Partial<ImportWorkspaceDeps>;
}

/**
 * Creates a fresh per-import workspace: `fs.mkdtemp` beneath the imports
 * root, never a shared or predictable directory — a predictable extraction
 * directory is the precondition for CVE-2026-76845. The directory is then
 * hardened to `0o700` explicitly (mode is not guaranteed by `mkdtemp` on
 * every platform) and a marker file records the handle id, bundle hash,
 * creation time, and owning process id so stale detection has something to
 * read.
 */
export async function createImportWorkspace(options: CreateImportWorkspaceOptions): Promise<ImportWorkspace> {
  const deps: ImportWorkspaceDeps = { ...defaultImportWorkspaceDeps, ...options.deps };
  const root = options.importsRoot ?? defaultImportsRoot(deps);
  await ensureImportsRoot(root);

  let workspacePath: string;
  try {
    workspacePath = await mkdtemp(join(root, IMPORT_WORKSPACE_PREFIX));
  } catch (error) {
    unsafe(`Could not create the import workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
  await protectPrivatePath(workspacePath, true, unsafe);

  const marker: ImportWorkspaceMarker = {
    handleId: options.handleId,
    bundleSha256: options.bundleSha256,
    createdAt: deps.now(),
    pid: deps.pid,
  };
  const markerPath = join(workspacePath, IMPORT_WORKSPACE_MARKER_FILE);
  await writePrivateFileExclusive(markerPath, JSON.stringify(marker), 0o600);
  return { path: workspacePath, markerPath, marker };
}

/**
 * Resolves `relativePath` against the workspace root and confirms containment
 * against the root's `realpath`, not the caller-supplied string — resolving
 * against an unresolved root would let a symlinked ancestor smuggle a path
 * back out.
 */
async function resolveContainedPath(workspaceRoot: string, relativePath: string): Promise<string> {
  const realRoot = await realpath(workspaceRoot);
  const candidate = resolve(realRoot, relativePath);
  if (!isContained(realRoot, candidate)) {
    unsafeName(`Path escapes the import workspace: ${relativePath}`);
  }
  return candidate;
}

/**
 * Creates every directory component from the workspace root down to
 * `targetDir`, one at a time, tolerating `EEXIST` only when a following
 * `lstat` confirms the component is a real directory rather than a link.
 *
 * On Windows this checks `isSymbolicLink()` from `lstat`, which — on the
 * Node versions this package targets — reports directory junctions, mount
 * points, and other reparse points as symbolic links; Node exposes no public
 * API for the raw `FILE_ATTRIBUTE_REPARSE_POINT` bit, and Windows has no
 * `O_NOFOLLOW` equivalent to fall back on, so this is the strongest check
 * available through Node's fs API.
 */
async function ensureContainedDirectory(targetDir: string, realRoot: string): Promise<void> {
  const rel = relative(realRoot, targetDir);
  if (rel === "") return;
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
        unsafe(`Could not create workspace directory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      unsafeName(`Refusing to write through a link at ${current}.`);
    }
  }
}

/**
 * Writes `data` to `relativePath` beneath `workspace`. Every directory
 * component is created and verified in order (see `ensureContainedDirectory`)
 * and the file itself is written with an exclusive create (`wx`) at a fixed
 * `0o600` — archive-supplied permission bits are never applied; there is no
 * parameter through which they could be.
 */
export async function writeWorkspaceFile(
  workspace: Pick<ImportWorkspace, "path">,
  relativePath: string,
  data: Uint8Array,
): Promise<string> {
  const realRoot = await realpath(workspace.path);
  const destination = await resolveContainedPath(workspace.path, relativePath);
  await ensureContainedDirectory(dirname(destination), realRoot);
  await writePrivateFileExclusive(destination, data, 0o600);
  return destination;
}

export interface SourceBinding {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Re-checks the outer bundle immediately before extraction and refuses if it
 * changed since validation — binding the workspace to the exact bytes that
 * were hashed and manifest-checked, not merely to the path.
 */
export async function verifySourceUnchanged(sourcePath: string, expected: SourceBinding): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    throw new ImportError("IMPORT_INPUT_FAILURE", `Could not re-read the source bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength !== expected.byteLength) {
    throw new ImportError("IMPORT_HASH_MISMATCH", "The source bundle changed size between validation and extraction.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256.toLowerCase()) {
    throw new ImportError("IMPORT_HASH_MISMATCH", "The source bundle changed between validation and extraction.");
  }
}

export interface WorkspaceCleanupResult {
  readonly path: string;
  readonly removed: boolean;
  readonly error?: string;
}

/**
 * Removes a workspace for every exit path: decline, hard failure, explicit
 * `close_import`, process exit, and startup stale recovery. Failure is
 * reported, never swallowed — a failed delete must not be mistaken for a
 * successful one, and a caller must never report content as removed when it
 * was not.
 */
export async function cleanupImportWorkspace(
  workspacePath: string,
  deps: { readonly rm: typeof rm } = { rm },
): Promise<WorkspaceCleanupResult> {
  try {
    // `force: true` only suppresses ENOENT (already gone, so cleanup is
    // idempotent); any other failure — e.g. a file still open, or a
    // permission error — still throws and is reported below.
    await deps.rm(workspacePath, { recursive: true, force: true });
    return { path: workspacePath, removed: true };
  } catch (error) {
    return { path: workspacePath, removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CleanupStaleResult {
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly failures: readonly WorkspaceCleanupResult[];
}

/**
 * Startup stale recovery: imports are process-scoped by default (see the
 * module doc comment above), so a workspace whose marker names a process
 * that is no longer running is abandoned and safe to remove. A workspace
 * whose marker names a live process is retained untouched, since that
 * process may still be reading from it. A workspace with a missing or
 * unreadable marker is treated as stale — no live import can vouch for it and
 * a durable resume policy is not implemented (a durable resume would also
 * need to re-verify the bundle hash and re-run trust confirmation, since
 * reusing an extraction across a restart without re-consent would bypass the
 * gate R70 exists to provide).
 */
export async function cleanupStaleImportWorkspaces(
  importsRoot: string = defaultImportsRoot(),
  deps: Pick<ImportWorkspaceDeps, "isProcessAlive"> = defaultImportWorkspaceDeps,
): Promise<CleanupStaleResult> {
  let entries: string[];
  try {
    entries = await readdir(importsRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed: [], retained: [], failures: [] };
    }
    unsafe(`Could not scan the imports root: ${error instanceof Error ? error.message : String(error)}`);
  }

  const removed: string[] = [];
  const retained: string[] = [];
  const failures: WorkspaceCleanupResult[] = [];
  for (const name of entries) {
    const workspacePath = join(importsRoot, name);
    let alive = false;
    try {
      const marker = JSON.parse(await readFile(join(workspacePath, IMPORT_WORKSPACE_MARKER_FILE), "utf8")) as ImportWorkspaceMarker;
      alive = deps.isProcessAlive(marker.pid);
    } catch {
      alive = false;
    }
    if (alive) {
      retained.push(workspacePath);
      continue;
    }
    const result = await cleanupImportWorkspace(workspacePath);
    if (result.removed) removed.push(workspacePath);
    else failures.push(result);
  }
  return { removed, retained, failures };
}