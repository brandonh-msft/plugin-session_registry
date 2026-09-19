import type { HarnessIdentity } from "../models/session.js";
import type { StoredZipSourceEntry } from "./nativeSessionBundle.js";

/**
 * The share-page display metadata (BASE-R6/R7's title/summary, harness
 * identity) plus the owner's GitHub login, written into every native
 * session bundle as `manifest.json`. This is a deliberately distinct file
 * from `session-registry-manifest.json` (the capture/approval-provenance
 * manifest written by `buildNativeSessionBundle`): that file describes how
 * the bytes were captured; this one describes the published session itself,
 * mirroring what a viewer already sees on the share URL page.
 *
 * `ownerGithubLogin` is intentionally the *only* place this value is ever
 * exposed to a downloader. It must not be added to `SessionViewResult` or
 * any other client-facing shape.
 */
export interface SessionManifestEntry {
  readonly sessionId: string;
  readonly harnessSessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly harness: HarnessIdentity;
  /** ISO-8601 timestamp of when the native session was captured. */
  readonly capturedAt: string;
  /** Null when the session was published without a GitHub identity. */
  readonly ownerGithubLogin: string | null;
}

export const SESSION_MANIFEST_PATH = "manifest.json";

export interface SessionManifestInput {
  readonly sessionId: string;
  readonly harnessSessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly harness: HarnessIdentity;
  /** ISO-8601 timestamp; typically the native archive's own `capturedAt`. */
  readonly capturedAt: string;
  /** Null when the session was published without a GitHub identity. */
  readonly ownerGithubLogin: string | null;
}

/** Builds the `manifest.json` byte content from confirmed session fields. */
export function buildSessionManifestBytes(input: SessionManifestInput): Buffer {
  const manifest: SessionManifestEntry = {
    sessionId: input.sessionId,
    harnessSessionId: input.harnessSessionId,
    title: input.title,
    summary: input.summary,
    harness: input.harness,
    capturedAt: input.capturedAt,
    ownerGithubLogin: input.ownerGithubLogin,
  };
  return Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Builds the `manifest.json` entry ready to append via `buildStoredZip`. */
export function buildSessionManifestZipEntry(input: SessionManifestInput): StoredZipSourceEntry {
  return { path: SESSION_MANIFEST_PATH, bytes: buildSessionManifestBytes(input) };
}
