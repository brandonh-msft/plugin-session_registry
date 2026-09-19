import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseNativeSessionArchive,
  NATIVE_CLI_HARNESSES,
  NATIVE_SESSION_ARCHIVE_FORMAT,
  PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT,
  MAX_NATIVE_ARCHIVE_BYTES,
  hasNativeSessionBundle,
  nativeFileContentBytes,
  inspectNativeJsonl,
  type NativeCaptureManifest,
  type NativeHarness,
  type NativeRestoration,
  type NativeSessionArchive,
} from "@session-registry/core";
import { captureNativeSession, type NativeCaptureInput, type NativeHomes } from "./adapters.js";
import { matchesSessionEvidence, selectNativeSession, type NativeSessionSelection } from "./selection.js";
import { captureSessionSource } from "./sources.js";
import type { NativeIdeSources } from "./sourceTypes.js";
import { isMissingFile, isNativeObject, isWithin, NativeCaptureError } from "./files.js";
import { ensurePrivateCaptureDirectory, protectPrivatePath, removePrivateCapture, replacePrivateCapture, writePrivateCapture } from "./privateStorage.js";
import {
  archiveFalsePositiveSpellings,
  resolveNativeCapture,
  scanNativeCapture,
  safeReviewText,
  type CaptureFinding,
  type CaptureResolution,
  type OwnerRedaction,
  type ReviewedCapture,
} from "./review.js";

export type PrepareCaptureInput = NativeSessionSelection | (NativeCaptureInput & { readonly hostSessionId?: string });

export interface PreparedCapture {
  readonly captureId: string;
  readonly harnessSessionId: string;
  readonly harness: NativeSessionArchive["harness"];
  readonly capturedAt: string;
  readonly sourceFormat: string;
  readonly scope: "persisted-session-records";
  readonly resumable: boolean;
  readonly nativeBundle: boolean;
  readonly restoration?: NativeRestoration;
  readonly capture?: Pick<NativeCaptureManifest, "boundary" | "entrypoint" | "selection" | "layout"> & {
    readonly sourceCount: number;
    readonly historySegmentCount: number;
    readonly diagnostics: readonly { readonly code: string; readonly count: number }[];
  };
  readonly fileCount: number;
  readonly recordCount: number;
  readonly bytes: number;
  readonly findings: readonly CaptureFinding[];
  readonly reviewState: "ready" | "needs-review";
  readonly reviewPath: string;
}

export interface LoadedCapture {
  readonly archive: NativeSessionArchive;
  readonly content: string;
}

/** The owner-approved values that an approved variant is derived from. */
export interface ApprovedCaptureRequest {
  readonly resolutions: readonly CaptureResolution[];
  readonly metadata: { readonly title: string; readonly summary: string };
  readonly ownerRedactions?: readonly OwnerRedaction[];
}

export interface NativeCaptureService {
  prepare(input: PrepareCaptureInput): Promise<PreparedCapture>;
  load(captureId: string): Promise<LoadedCapture>;
  review(
    captureId: string,
    resolutions: readonly CaptureResolution[],
    metadata: { readonly title: string; readonly summary: string },
    ownerRedactions?: readonly OwnerRedaction[],
  ): Promise<ReviewedCapture>;
  /**
   * Stages the exact variant that will be uploaded for `requestKey`, writing
   * the owner's redactions into a file alongside the original capture.
   *
   * Calling this again with the same `requestKey` returns the already-staged
   * file untouched, so a retry after a failed upload re-sends those bytes
   * instead of re-capturing the session and re-applying redactions.
   */
  approveForPublish(
    captureId: string,
    requestKey: string,
    request: ApprovedCaptureRequest,
  ): Promise<ReviewedCapture>;
  /** Deletes the original capture and any staged variant. Only safe after a confirmed upload. */
  discard(captureId: string): Promise<void>;
}

export interface NativeCaptureOptions {
  readonly homes: NativeHomes;
  readonly ideSources?: NativeIdeSources;
  readonly captureDirectory: string;
  readonly maxBytes: number;
  readonly codexSqliteHome?: string;
  readonly activeCopilotSessionId?: string;
  readonly now?: () => Date;
}

export function nativeCaptureOptions(env: NodeJS.ProcessEnv): NativeCaptureOptions {
  const maxBytes = Number(env.SESSION_REGISTRY_MAX_CAPTURE_BYTES ?? 256 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("SESSION_REGISTRY_MAX_CAPTURE_BYTES must be a positive safe integer");
  }
  if (maxBytes > MAX_NATIVE_ARCHIVE_BYTES) {
    throw new Error(`SESSION_REGISTRY_MAX_CAPTURE_BYTES cannot exceed the supported archive limit of ${MAX_NATIVE_ARCHIVE_BYTES}`);
  }
  return {
    homes: {
      "github-copilot-cli": resolve(env.SESSION_REGISTRY_COPILOT_HOME ?? env.COPILOT_HOME ?? join(homedir(), ".copilot")),
      "claude-code": resolve(env.SESSION_REGISTRY_CLAUDE_HOME ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
      "codex-cli": resolve(env.SESSION_REGISTRY_CODEX_HOME ?? env.CODEX_HOME ?? join(homedir(), ".codex")),
    },
    ...(() => {
      const vscodePath = optionalSetting(env, "SESSION_REGISTRY_VSCODE_USER_DATA");
      const vscodeCopilotHome = optionalSetting(env, "SESSION_REGISTRY_VSCODE_COPILOT_HOME");
      const visualStudioHome = optionalSetting(env, "SESSION_REGISTRY_VISUAL_STUDIO_COPILOT_HOME");
      const visualStudioVersion = optionalSetting(env, "SESSION_REGISTRY_VISUAL_STUDIO_VERSION");
      const desktopHome = optionalSetting(env, "SESSION_REGISTRY_COPILOT_DESKTOP_HOME");
      const desktopVersion = optionalSetting(env, "SESSION_REGISTRY_COPILOT_DESKTOP_VERSION");
      if (vscodeCopilotHome !== undefined && vscodePath === undefined) {
        throw new Error("SESSION_REGISTRY_VSCODE_COPILOT_HOME also requires SESSION_REGISTRY_VSCODE_USER_DATA");
      }
      if (visualStudioVersion !== undefined && visualStudioHome === undefined) {
        throw new Error("SESSION_REGISTRY_VISUAL_STUDIO_VERSION also requires SESSION_REGISTRY_VISUAL_STUDIO_COPILOT_HOME");
      }
      if (desktopVersion !== undefined && desktopHome === undefined) {
        throw new Error("SESSION_REGISTRY_COPILOT_DESKTOP_VERSION also requires SESSION_REGISTRY_COPILOT_DESKTOP_HOME");
      }
      const ideSources: NativeIdeSources = {
        ...(vscodePath === undefined ? {} : {
          vscode: { userDataPath: resolve(vscodePath), copilotHome: resolve(vscodeCopilotHome ?? resolve(env.SESSION_REGISTRY_COPILOT_HOME ?? env.COPILOT_HOME ?? join(homedir(), ".copilot"))) },
        }),
        ...(visualStudioHome === undefined ? {} : { visualStudio: { copilotHome: resolve(visualStudioHome), ...(visualStudioVersion === undefined ? {} : { hostVersion: visualStudioVersion }) } }),
        ...(desktopHome === undefined ? {} : { desktop: { copilotHome: resolve(desktopHome), ...(desktopVersion === undefined ? {} : { hostVersion: desktopVersion }) } }),
      };
      return Object.keys(ideSources).length === 0 ? {} : { ideSources };
    })(),
    captureDirectory: resolve(env.SESSION_REGISTRY_CAPTURE_DIR ?? join(homedir(), ".session-registry", "captures")),
    maxBytes,
    ...(!env.COPILOT_AGENT_SESSION_ID?.trim() ||
      (env.SESSION_REGISTRY_COPILOT_HOME !== undefined &&
        resolve(env.SESSION_REGISTRY_COPILOT_HOME) !== resolve(env.COPILOT_HOME ?? join(homedir(), ".copilot")))
      ? {} : { activeCopilotSessionId: env.COPILOT_AGENT_SESSION_ID }),
    ...((env.SESSION_REGISTRY_CODEX_SQLITE_HOME ?? env.CODEX_SQLITE_HOME) === undefined ? {} : {
      codexSqliteHome: (env.SESSION_REGISTRY_CODEX_SQLITE_HOME ?? env.CODEX_SQLITE_HOME)!,
    }),
  };
}

function optionalSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new Error(`${name} must not be empty when configured`);
  return value.trim();
}

export function captureDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const APPROVED_CAPTURE_FORMAT = "session-registry.approved-capture.v1";

/**
 * Headroom the staged variant is allowed to occupy beyond the capture byte
 * limit. The variant stores the approved archive plus the residual
 * false-positive spellings that justify it; anything larger is treated as
 * unusable and rebuilt from the original capture rather than read into memory.
 */
const APPROVED_CAPTURE_OVERHEAD_BYTES = 8 * 1024 * 1024;

interface ApprovedCaptureRecord {
  readonly format: string;
  readonly captureId: string;
  readonly requestKey: string;
  readonly approvedAt: string;
  readonly title: string;
  readonly summary: string;
  readonly falsePositiveSpellings: readonly string[];
  readonly metadataResolutions: readonly CaptureResolution[];
  readonly contentDigest: string;
  readonly content: string;
}

function isApprovedCaptureRecord(value: unknown): value is ApprovedCaptureRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.format === APPROVED_CAPTURE_FORMAT &&
    typeof record.captureId === "string" &&
    typeof record.requestKey === "string" &&
    typeof record.approvedAt === "string" &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.contentDigest === "string" &&
    typeof record.content === "string" &&
    Array.isArray(record.falsePositiveSpellings) &&
    record.falsePositiveSpellings.every((entry) => typeof entry === "string") &&
    Array.isArray(record.metadataResolutions);
}

export function createNativeCaptureService(
  options = nativeCaptureOptions(process.env),
): NativeCaptureService {
  const directory = resolve(options.captureDirectory);
  async function snapshot(input: PrepareCaptureInput): Promise<NativeSessionArchive> {
    const selection = input as NativeSessionSelection;
    if (NATIVE_CLI_HARNESSES.includes(input.harness as typeof NATIVE_CLI_HARNESSES[number]) &&
        (input as { readonly hostSessionId?: string }).hostSessionId !== undefined) {
      throw new NativeCaptureError("UNSUPPORTED_OPTION", "hostSessionId applies only to VS Code Agent Host capture.");
    }
    if (!NATIVE_CLI_HARNESSES.includes(input.harness as typeof NATIVE_CLI_HARNESSES[number])) {
      return captureSessionSource(
        input as NativeCaptureInput & { readonly hostSessionId?: string },
        options.homes,
        options.ideSources,
        options.maxBytes,
        options.now,
      );
    }
    if (input.harness === "github-copilot-cli" && options.activeCopilotSessionId !== undefined &&
        selection.harnessSessionId === undefined && selection.sourcePath === undefined && selection.sessionDirectory === undefined) {
      input = { ...input, harnessSessionId: options.activeCopilotSessionId };
    }
    const selectedInput = input as NativeSessionSelection;
    for (let attempt = 0; ; attempt++) {
      try {
        const selected: NativeCaptureInput = await selectNativeSession(selectedInput, options.homes, options.maxBytes);
        const archive = await captureNativeSession(selected, options.homes, options.maxBytes, options.now, options.codexSqliteHome);
        if (selectedInput.harnessSessionId === undefined && selectedInput.sourcePath === undefined && selectedInput.sessionDirectory === undefined &&
            selectedInput.workingDirectory && selectedInput.recentUserMessage) {
          const records = archive.files.filter((file) => file.kind === "events")
            .flatMap((file) => inspectNativeJsonl(nativeFileContentBytes(file)).records);
          if (!matchesSessionEvidence(selectedInput.harness, records.filter(isNativeObject), selectedInput.workingDirectory, selectedInput.recentUserMessage)) {
            throw new NativeCaptureError("SOURCE_CHANGED", "The selected native snapshot no longer contains the identity evidence; no other session was substituted.");
          }
        }
        return archive;
      } catch (error) {
        if (error instanceof NativeCaptureError && error.code === "SOURCE_CHANGED" && attempt < 2) continue;
        throw error;
      }
    }
  }
  function approvedPath(captureId: string): string {
    return join(directory, `${captureId}.approved.json`);
  }

  /**
   * Returns the variant already staged for `requestKey`, or undefined when
   * there is none that can be trusted. Anything unreadable, torn, or staged for
   * a different request is ignored rather than repaired: the original capture
   * is still on disk, so the caller simply rebuilds the variant from it.
   */
  async function readApproved(captureId: string, requestKey: string): Promise<ReviewedCapture | undefined> {
    const path = approvedPath(captureId);
    let raw: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() ||
          info.size > options.maxBytes + APPROVED_CAPTURE_OVERHEAD_BYTES) return undefined;
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isApprovedCaptureRecord(parsed) || parsed.captureId !== captureId ||
        parsed.requestKey !== requestKey || captureDigest(parsed.content) !== parsed.contentDigest) {
      return undefined;
    }
    const archive = parseNativeSessionArchive(parsed.content);
    if (archive === null) return undefined;
    return {
      archive,
      content: parsed.content,
      title: parsed.title,
      summary: parsed.summary,
      falsePositiveSpellings: [...parsed.falsePositiveSpellings, ...archiveFalsePositiveSpellings(archive)],
      metadataResolutions: parsed.metadataResolutions,
    };
  }

  const service: NativeCaptureService = {
    async prepare(input) {
      const archive = await snapshot(input);
      const content = JSON.stringify(archive);
      const bytes = Buffer.byteLength(content);
      if (bytes > options.maxBytes) {
        throw new NativeCaptureError("SOURCE_LIMIT", "The serialized capture exceeds SESSION_REGISTRY_MAX_CAPTURE_BYTES; nothing was truncated.");
      }
      if (parseNativeSessionArchive(content) === null) {
        throw new NativeCaptureError("INVALID_CAPTURE", "The captured source did not produce a supported native archive.");
      }
      const captureId = captureDigest(content);
      const findings = scanNativeCapture(archive, captureId);
      const diagnosticCounts = new Map<string, number>();
      for (const diagnostic of archive.capture?.diagnostics ?? []) {
        diagnosticCounts.set(diagnostic.code, (diagnosticCounts.get(diagnostic.code) ?? 0) + 1);
      }
      await ensurePrivateCaptureDirectory(directory);
      const reviewPath = join(directory, `${captureId}.json`);
      try {
        await writePrivateCapture(reviewPath, content);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        await protectPrivatePath(reviewPath);
        if (await readFile(reviewPath, "utf8") !== content) {
          throw new NativeCaptureError("CAPTURE_CHANGED", "An existing capture does not match its content identifier.");
        }
      }
      return {
        captureId,
        harnessSessionId: safeReviewText(archive.harnessSessionId),
        harness: { name: archive.harness.name, version: safeReviewText(archive.harness.version) },
        capturedAt: archive.capturedAt,
        sourceFormat: archive.sourceFormat,
        scope: archive.scope,
        resumable: archive.resumable,
        nativeBundle: hasNativeSessionBundle(archive),
        restoration: archive.restoration,
        // Full source maps and diagnostics live in the owner-only archive,
        // keeping the control-plane response bounded even for large sessions.
        capture: archive.capture === undefined ? undefined : {
          boundary: archive.capture.boundary,
          entrypoint: safeReviewText(archive.capture.entrypoint),
          selection: archive.capture.selection,
          layout: archive.capture.layout,
          sourceCount: archive.capture.sources.length,
          historySegmentCount: archive.capture.history.length,
          diagnostics: [...diagnosticCounts].map(([code, count]) => ({ code, count })),
        },
        fileCount: archive.files.length,
        recordCount: archive.files.reduce((count, file) => count + file.recordCount, 0),
        bytes,
        findings,
        reviewState: findings.length === 0 ? "ready" : "needs-review",
        reviewPath,
      };
    },
    async load(captureId) {
      if (!/^[a-f0-9]{64}$/.test(captureId)) {
        throw new NativeCaptureError("INVALID_CAPTURE", "Use the captureId returned by prepare_session_capture.");
      }
      const path = join(directory, `${captureId}.json`);
      let content: string;
      try {
        const info = await lstat(path);
        const root = await realpath(directory);
        if (!info.isFile() || info.isSymbolicLink() || !isWithin(root, await realpath(path))) {
          throw new NativeCaptureError("INVALID_CAPTURE", "The prepared capture is not a regular local capture file.");
        }
        if (info.size > options.maxBytes) {
          throw new NativeCaptureError("SOURCE_LIMIT", "The prepared capture exceeds the configured byte limit.");
        }
        await protectPrivatePath(path);
        content = await readFile(path, "utf8");
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        throw new NativeCaptureError("CAPTURE_NOT_FOUND", "The prepared capture is unavailable. Do not reconstruct it or silently capture a newer session.");
      }
      if (captureDigest(content) !== captureId) {
        throw new NativeCaptureError("CAPTURE_CHANGED", "The prepared capture changed after preparation; it cannot be published.");
      }
      const archive = parseNativeSessionArchive(content);
      if (archive === null) {
        throw new NativeCaptureError("INVALID_CAPTURE", "The prepared file is not a supported native session archive.");
      }
      if (archive.format !== NATIVE_SESSION_ARCHIVE_FORMAT && archive.format !== PREVIOUS_NATIVE_SESSION_ARCHIVE_FORMAT) {
        throw new NativeCaptureError("CAPTURE_UPGRADE_REQUIRED",
          "This capture predates lossless owner-controlled review. It cannot recover removed source data. A previous unknown publication outcome must be resolved separately.");
      }
      return { archive, content };
    },
    async review(captureId, resolutions, metadata, ownerRedactions = []) {
      const capture = await service.load(captureId);
      const reviewed = resolveNativeCapture(capture.archive, captureId, resolutions, metadata, ownerRedactions);
      if (Buffer.byteLength(reviewed.content) > options.maxBytes) {
        throw new NativeCaptureError("SOURCE_LIMIT", "The approved variant exceeds the configured capture limit; nothing was truncated.");
      }
      return reviewed;
    },
    async approveForPublish(captureId, requestKey, request) {
      if (!/^[a-f0-9]{64}$/.test(requestKey)) {
        throw new NativeCaptureError("INVALID_CAPTURE", "An approved variant must be staged under a deterministic request key.");
      }
      const staged = await readApproved(captureId, requestKey);
      if (staged !== undefined) return staged;
      const reviewed = await service.review(captureId, request.resolutions, request.metadata, request.ownerRedactions);
      const derived = new Set(archiveFalsePositiveSpellings(reviewed.archive));
      const record: ApprovedCaptureRecord = {
        format: APPROVED_CAPTURE_FORMAT,
        captureId,
        requestKey,
        approvedAt: (options.now?.() ?? new Date()).toISOString(),
        title: reviewed.title,
        summary: reviewed.summary,
        // Spellings restating the archive's own encoded bytes are recomputed on
        // read, so the staged file stays close to the size of the variant itself.
        falsePositiveSpellings: reviewed.falsePositiveSpellings.filter((text) => !derived.has(text)),
        metadataResolutions: reviewed.metadataResolutions,
        contentDigest: captureDigest(reviewed.content),
        content: reviewed.content,
      };
      await ensurePrivateCaptureDirectory(directory);
      await replacePrivateCapture(approvedPath(captureId), JSON.stringify(record));
      return reviewed;
    },
    async discard(captureId) {
      if (!/^[a-f0-9]{64}$/.test(captureId)) {
        throw new NativeCaptureError("INVALID_CAPTURE", "Use the captureId returned by prepare_session_capture.");
      }
      await removePrivateCapture(approvedPath(captureId));
      await removePrivateCapture(join(directory, `${captureId}.json`));
    },
  };
  return service;
}
