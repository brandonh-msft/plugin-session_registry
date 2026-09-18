import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ImportCoordinator,
  ImportError,
  createImportHandle,
  readNativeSessionBundle,
  validateImportManifest,
  type ImportHandle,
  type NativeSessionBundleEntry,
  type SliceOutcome,
} from "@session-registry/core";
import { readHarnessProjection } from "../import/harnessReaders.js";
import {
  cleanupImportWorkspace,
  createImportWorkspace,
  verifySourceUnchanged,
  writeWorkspaceFile,
  type ImportWorkspace,
} from "../import/workspace.js";
import { SliceService, type SliceFilter } from "../import/slices.js";

export type ImportSessionInput = { readonly bundlePath: string };
export type ReadImportSliceInput = { readonly importHandle: string; readonly filter: SliceFilter };
export type CloseImportInput = { readonly importHandle: string };

interface LoadedBundle {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ImportSessionDependencies {
  readonly confirm: (request: ElicitRequestFormParams) => Promise<ElicitResult | undefined>;
  readonly coordinator?: ImportCoordinator;
  readonly slices?: SliceService;
  readonly loadBundle?: (path: string) => Promise<LoadedBundle>;
  readonly readBundle?: typeof readNativeSessionBundle;
  readonly validateManifest?: typeof validateImportManifest;
  readonly createWorkspace?: (options: { readonly handleId: string; readonly bundleSha256: string }) => Promise<ImportWorkspace>;
  readonly verifyUnchanged?: typeof verifySourceUnchanged;
  readonly writeFile?: typeof writeWorkspaceFile;
  readonly cleanupWorkspace?: typeof cleanupImportWorkspace;
  readonly briefing?: typeof readHarnessProjection;
}

function result(value: object, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}

function importFailure(error: unknown): CallToolResult {
  if (error instanceof ImportError) {
    return result({ code: error.code, message: error.message, remediation: error.remediation }, true);
  }
  return result({ code: "IMPORT_INPUT_FAILURE", message: "The import could not be completed safely. No imported session is active." }, true);
}

async function defaultLoadBundle(path: string): Promise<LoadedBundle> {
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === "ENOENT"
      ? "The bundle path does not exist."
      : code === "EACCES" || code === "EPERM"
        ? "The bundle path is not readable."
        : "The bundle path could not be inspected.";
    throw new ImportError("IMPORT_INPUT_FAILURE", message);
  }
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(path);
  } catch {
    throw new ImportError("IMPORT_INPUT_FAILURE", "The bundle path could not be inspected.");
  }
  if (information.isDirectory()) throw new ImportError("IMPORT_INPUT_FAILURE", "The bundle path names a directory, not a ZIP file.");
  if (!information.isFile()) throw new ImportError("IMPORT_INPUT_FAILURE", "The bundle path is not a regular readable file.");

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ImportError("IMPORT_INPUT_FAILURE", code === "EACCES" || code === "EPERM"
      ? "The bundle path is not readable."
      : "The bundle path could not be read.");
  }
  let after: Awaited<ReturnType<typeof stat>>;
  try {
    after = await stat(path);
  } catch {
    throw new ImportError("IMPORT_INPUT_FAILURE", "The bundle changed or disappeared while it was being read.");
  }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ImportError("IMPORT_INPUT_FAILURE", "The bundle changed while it was being read; retry with a stable file.");
  }
  return { bytes, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function bounded(value: string, fallback = "unavailable"): string {
  const clean = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return clean === "" ? fallback : clean.slice(0, 120);
}

function importConfirmation(metadata: ReturnType<typeof validateImportManifest>): ElicitRequestFormParams {
  const eventFiles = metadata.files.filter((file) => file.kind === "events").length;
  const attachmentFiles = metadata.files.length - eventFiles;
  const edited = metadata.restoration.status === "invalidated-by-security-edits" || metadata.securityChanges.length > 0;
  return {
    mode: "form",
    message: [
      "Import a verified session bundle for read-only orientation.",
      `Producing harness: ${bounded(metadata.harness.name)}; version: ${bounded(metadata.harness.version)}.`,
      `Approved files: ${Math.min(metadata.files.length, 4096)} total (${eventFiles} event, ${attachmentFiles} attachment).`,
      edited
        ? "This bundle was security-edited or reports redactions; imported material may differ from its original captured state."
        : "This bundle reports no security edits or redactions.",
      "This is another person's agent state. It may contain instructions or tool-triggering content; reading it has prompt-injection risk comparable to running someone else's code.",
      "After import, you can ask questions about this session and read small parts of it.",
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        confirmImport: {
          type: "boolean",
          title: "I understand the untrusted-content risk and want to import this read-only bundle",
          default: false,
        },
      },
      required: ["confirmImport"],
    },
  };
}

function contentFor(entry: NativeSessionBundleEntry, file: ReturnType<typeof validateImportManifest>["files"][number]): string {
  let content = Buffer.from(entry.bytes);
  if (file.nativeEncoding === "zstd") content = zstdDecompressSync(content);
  return file.contentEncoding === "base64" ? content.toString("base64") : new TextDecoder("utf-8", { fatal: true }).decode(content);
}

export function createImportSessionHandlers(deps: ImportSessionDependencies) {
  const coordinator = deps.coordinator ?? new ImportCoordinator();
  const slices = deps.slices ?? new SliceService({ coordinator });
  const loadBundle = deps.loadBundle ?? defaultLoadBundle;
  const readBundle = deps.readBundle ?? readNativeSessionBundle;
  const validateManifest = deps.validateManifest ?? validateImportManifest;
  const createWorkspace = deps.createWorkspace ?? ((options) => createImportWorkspace(options));
  const verifyUnchanged = deps.verifyUnchanged ?? verifySourceUnchanged;
  const writeFile = deps.writeFile ?? writeWorkspaceFile;
  const cleanupWorkspace = deps.cleanupWorkspace ?? cleanupImportWorkspace;
  const briefing = deps.briefing ?? readHarnessProjection;
  const handles = new Map<string, ImportHandle>();
  let importReserved = false;

  const release = async (handle: ImportHandle): Promise<void> => {
    const cleanup = await cleanupWorkspace(handle.workspacePath);
    slices.releaseSource(handle.id);
    if (!cleanup.removed) throw new ImportError("IMPORT_WORKSPACE_FAILURE", "The imported workspace could not be removed.");
  };

  const importBundle = async (input: ImportSessionInput): Promise<CallToolResult> => {
    let workspace: ImportWorkspace | undefined;
    let handle: ImportHandle | undefined;
    try {
      const loaded = await loadBundle(input.bundlePath);
      const entries = await readBundle(loaded.bytes);
      const metadata = validateManifest(entries);
      if (importReserved) throw new ImportError("IMPORT_ALREADY_ACTIVE");
      importReserved = true;
      const confirmation = await deps.confirm(importConfirmation(metadata));
      if (confirmation?.action !== "accept" || confirmation.content?.confirmImport !== true) {
        importReserved = false;
        return result({
          code: "IMPORT_CONSENT_REQUIRED",
          message: "Import terminated without consent. No files were written; re-run in an interactive client and explicitly confirm the risk.",
        }, true);
      }

      handle = createImportHandle(randomUUID(), loaded.sha256, loaded.byteLength, "");
      workspace = await createWorkspace({ handleId: handle.id, bundleSha256: handle.bundleSha256 });
      handle = createImportHandle(handle.id, loaded.sha256, loaded.byteLength, workspace.path);
      coordinator.beginImport(handle);
      importReserved = false;
      await verifyUnchanged(input.bundlePath, { sha256: loaded.sha256, byteLength: loaded.byteLength });
      const files = metadata.files.map((file) => {
        const entry = entries.get(file.path);
        if (entry === undefined) throw new ImportError("IMPORT_ENTRY_MISMATCH", "A verified approved entry was unavailable for extraction.");
        return { file, entry, content: contentFor(entry, file) };
      });
      for (const { file, entry } of files) await writeFile(workspace, file.path, entry.bytes);
      const importBriefing = briefing({
        harness: metadata.harness,
        capturedAt: metadata.capturedAt,
        files: files.map(({ file, content }) => ({ ...file, content })),
        redactions: metadata.securityChanges,
      });
      slices.registerSource(handle, {
        files: () => files.map(({ file }) => ({ path: file.path, kind: file.kind })),
        readFile: (path) => {
          const match = files.find(({ file }) => file.path === path);
          if (match === undefined) throw new ImportError("IMPORT_HANDLE_UNKNOWN", "The requested extracted file is unavailable.");
          return match.content;
        },
      });
      coordinator.markReady(handle);
      handles.set(handle.id, handle);
      return result({
        status: "imported",
        importHandle: handle.id,
        briefing: importBriefing,
        nextSteps: [
          "Ask questions about the imported session.",
          "Read a small part of a file when you need more detail.",
        ],
      });
    } catch (error) {
      if (handle !== undefined) {
        try {
          await coordinator.closeImport(handle, release);
        } catch {
          if (workspace !== undefined) await cleanupWorkspace(workspace.path);
        }
      } else if (workspace !== undefined) {
        await cleanupWorkspace(workspace.path);
      }
      importReserved = false;
      return importFailure(error);
    }
  };

  const readSlice = async (input: ReadImportSliceInput): Promise<CallToolResult> => {
    try {
      const handle = handles.get(input.importHandle);
      if (handle === undefined) throw new ImportError("IMPORT_HANDLE_UNKNOWN");
      const outcome: SliceOutcome = await slices.readSlice(handle, input.filter);
      return result({ importHandle: handle.id, ...outcome });
    } catch (error) {
      return importFailure(error);
    }
  };

  const closeImport = async (input: CloseImportInput): Promise<CallToolResult> => {
    try {
      const handle = handles.get(input.importHandle);
      if (handle === undefined) throw new ImportError("IMPORT_HANDLE_UNKNOWN");
      await coordinator.closeImport(handle, release);
      return result({ status: "closed", importHandle: input.importHandle });
    } catch (error) {
      return importFailure(error);
    }
  };

  return { importBundle, readSlice, closeImport };
}
