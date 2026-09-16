/**
 * Builds the manifest for a session's portable archive (`BASE-R27`,
 * `R47`). This module only decides *what* belongs in the archive and
 * *why a resumable bundle is or isn't included* — it does not touch Blob
 * Storage or issue any download credential. That keeps the archive-shape
 * decision directly unit-testable without a real storage backend.
 *
 * Content rule (`BASE-R27`, `R30`): the bulk archive contains the
 * transcript, session metadata, and every *inspectable* artifact.
 * Artifacts the owner separately warned as download-only (`BASE-R30`) are
 * named in the manifest so a collaborator knows they exist, but are never
 * bundled into the archive itself — they remain individually downloadable
 * elsewhere, with their own warning, which is a separate delivery path
 * outside this module's scope.
 */

import type { BlobPointer, HarnessIdentity } from "../models/session.js";

export interface ArchivableArtifact {
  readonly filename: string;
  readonly pointer: BlobPointer;
  /**
   * `false` marks a separately warned download-only artifact (`BASE-R30`)
   * — named in the manifest, but excluded from the bulk archive contents.
   */
  readonly inspectable: boolean;
}

/**
 * `present: false` means the publishing harness simply does not offer a
 * native resumable representation — the manifest must say so explicitly
 * rather than silently omitting the field (`BASE-R47`). `unscannable:
 * true` means a bundle exists but could not be safely scanned/redacted
 * (`BASE-R30`'s unscannable-content path): it is withheld from the bulk
 * archive exactly like a download-only artifact, even though it is
 * conceptually "resumable content" rather than a named artifact.
 */
export type ResumableBundleInput =
  | { readonly present: false }
  | { readonly present: true; readonly pointer: BlobPointer; readonly unscannable: false }
  | { readonly present: true; readonly unscannable: true };

export interface ArchiveManifestInput {
  readonly title: string;
  readonly summary: string;
  readonly harness: HarnessIdentity;
  readonly transcriptPointer: BlobPointer;
  readonly artifacts: readonly ArchivableArtifact[];
  readonly resumableBundle: ResumableBundleInput;
}

export type ResumableBundleManifestEntry =
  | { readonly included: false; readonly reason: "not-provided" }
  | { readonly included: false; readonly reason: "unscannable-download-only" }
  | { readonly included: true; readonly pointer: BlobPointer };

export interface ArchiveManifest {
  readonly metadata: { readonly title: string; readonly summary: string; readonly harness: HarnessIdentity };
  readonly transcriptPointer: BlobPointer;
  /** Inspectable artifacts bundled into the archive. */
  readonly includedArtifacts: readonly { readonly filename: string; readonly pointer: BlobPointer }[];
  /** Named but deliberately excluded from the bundle (`BASE-R30`). */
  readonly excludedDownloadOnlyArtifacts: readonly { readonly filename: string }[];
  readonly resumableBundle: ResumableBundleManifestEntry;
}

/**
 * Computes the archive manifest for one session. Pure and synchronous —
 * every input is already-resolved metadata/pointers, so there is nothing
 * here that needs to be async.
 */
export function buildArchiveManifest(input: ArchiveManifestInput): ArchiveManifest {
  const includedArtifacts = input.artifacts
    .filter((artifact) => artifact.inspectable)
    .map((artifact) => ({ filename: artifact.filename, pointer: artifact.pointer }));
  const excludedDownloadOnlyArtifacts = input.artifacts
    .filter((artifact) => !artifact.inspectable)
    .map((artifact) => ({ filename: artifact.filename }));

  return {
    metadata: { title: input.title, summary: input.summary, harness: input.harness },
    transcriptPointer: input.transcriptPointer,
    includedArtifacts,
    excludedDownloadOnlyArtifacts,
    resumableBundle: resolveResumableBundleEntry(input.resumableBundle),
  };
}

function resolveResumableBundleEntry(
  bundle: ResumableBundleInput,
): ResumableBundleManifestEntry {
  if (!bundle.present) {
    return { included: false, reason: "not-provided" };
  }
  if (bundle.unscannable) {
    return { included: false, reason: "unscannable-download-only" };
  }
  return { included: true, pointer: bundle.pointer };
}
