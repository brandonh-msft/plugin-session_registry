import { describe, expect, it } from "vitest";
import { buildArchiveManifest, type ArchiveManifestInput } from "../../src/archive/archiveBuilder.js";

function baseInput(overrides: Partial<ArchiveManifestInput> = {}): ArchiveManifestInput {
  return {
    title: "A session",
    summary: "A summary.",
    harness: { name: "test-harness", version: "1.0.0" },
    transcriptPointer: { containerName: "sessions", blobKey: "transcript" },
    artifacts: [],
    resumableBundle: { present: false },
    ...overrides,
  };
}

describe("buildArchiveManifest", () => {
  it("happy path: includes the transcript, metadata, and every inspectable artifact", () => {
    const manifest = buildArchiveManifest(
      baseInput({
        artifacts: [
          { filename: "notes.md", pointer: { containerName: "artifacts", blobKey: "a1" }, inspectable: true },
          { filename: "diagram.png", pointer: { containerName: "artifacts", blobKey: "a2" }, inspectable: true },
        ],
      }),
    );

    expect(manifest.transcriptPointer).toEqual({ containerName: "sessions", blobKey: "transcript" });
    expect(manifest.metadata).toEqual({
      title: "A session",
      summary: "A summary.",
      harness: { name: "test-harness", version: "1.0.0" },
    });
    expect(manifest.includedArtifacts).toEqual([
      { filename: "notes.md", pointer: { containerName: "artifacts", blobKey: "a1" } },
      { filename: "diagram.png", pointer: { containerName: "artifacts", blobKey: "a2" } },
    ]);
    expect(manifest.excludedDownloadOnlyArtifacts).toEqual([]);
  });

  it("happy path: includes the resumable bundle as an opaque pointer when present and scannable", () => {
    const manifest = buildArchiveManifest(
      baseInput({
        resumableBundle: {
          present: true,
          unscannable: false,
          pointer: { containerName: "bundles", blobKey: "b1" },
        },
      }),
    );

    expect(manifest.resumableBundle).toEqual({
      included: true,
      pointer: { containerName: "bundles", blobKey: "b1" },
    });
  });

  it("edge case: states explicitly that no resumable bundle was provided, rather than implying resumability", () => {
    const manifest = buildArchiveManifest(baseInput({ resumableBundle: { present: false } }));

    expect(manifest.resumableBundle).toEqual({ included: false, reason: "not-provided" });
  });

  it("edge case: an unscannable resumable bundle is withheld from the archive like a download-only artifact", () => {
    const manifest = buildArchiveManifest(
      baseInput({ resumableBundle: { present: true, unscannable: true } }),
    );

    expect(manifest.resumableBundle).toEqual({
      included: false,
      reason: "unscannable-download-only",
    });
  });

  it("edge case: separately warned download-only artifacts are named but excluded from the bulk archive", () => {
    const manifest = buildArchiveManifest(
      baseInput({
        artifacts: [
          { filename: "notes.md", pointer: { containerName: "artifacts", blobKey: "a1" }, inspectable: true },
          {
            filename: "raw-dump.bin",
            pointer: { containerName: "artifacts", blobKey: "a2" },
            inspectable: false,
          },
        ],
      }),
    );

    expect(manifest.includedArtifacts).toEqual([
      { filename: "notes.md", pointer: { containerName: "artifacts", blobKey: "a1" } },
    ]);
    expect(manifest.excludedDownloadOnlyArtifacts).toEqual([{ filename: "raw-dump.bin" }]);
  });
});
