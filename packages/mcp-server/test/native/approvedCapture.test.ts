import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeCaptureService } from "../../src/native/captures.js";
import { acknowledgeFixtureWarnings, nativeFixture, SESSION_ID } from "./fixtures.js";

const REQUEST_KEY = "1".repeat(64);
const OTHER_REQUEST_KEY = "2".repeat(64);
const METADATA = { title: "Staged publication", summary: "The approved variant is staged before upload." };

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function stagedFixture() {
  const fixture = await nativeFixture("github-copilot-cli");
  directories.push(fixture.root);
  const service = createNativeCaptureService(fixture.options);
  const prepared = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });
  return {
    fixture,
    service,
    prepared,
    resolutions: acknowledgeFixtureWarnings(prepared.findings),
    originalPath: join(fixture.options.captureDirectory, `${prepared.captureId}.json`),
    approvedPath: join(fixture.options.captureDirectory, `${prepared.captureId}.approved.json`),
  };
}

describe("approved capture staging", () => {
  it("writes the owner's redactions into a staged file beside the unchanged original", async () => {
    const { service, prepared, resolutions, originalPath, approvedPath } = await stagedFixture();
    const original = await readFile(originalPath, "utf8");

    const approved = await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions,
      metadata: METADATA,
      ownerRedactions: [{ exactText: "STDERR_SENTINEL", replacementText: "[REMOVED]" }],
    });

    expect(approved.content).toContain("[REMOVED]");
    expect(approved.content).not.toContain("STDERR_SENTINEL");
    const staged = JSON.parse(await readFile(approvedPath, "utf8"));
    expect(staged.content).toBe(approved.content);
    expect(staged.requestKey).toBe(REQUEST_KEY);
    expect(staged.captureId).toBe(prepared.captureId);
    // The redaction is in the staged file itself, not only in the returned value.
    expect(await readFile(approvedPath, "utf8")).not.toContain("STDERR_SENTINEL");
    // The immutable original is what a differently-redacted retry rebuilds from.
    expect(await readFile(originalPath, "utf8")).toBe(original);
  });

  it("re-sends the staged file on retry instead of rebuilding it from the source", async () => {
    const { service, prepared, resolutions, originalPath, approvedPath } = await stagedFixture();
    const first = await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions, metadata: METADATA, ownerRedactions: [{ exactText: "STDERR_SENTINEL" }],
    });

    // Removing the original proves the retry cannot be re-deriving the variant:
    // there is nothing left to derive it from.
    await rm(originalPath);
    const retried = await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions, metadata: METADATA, ownerRedactions: [{ exactText: "STDERR_SENTINEL" }],
    });

    expect(retried.content).toBe(first.content);
    expect(retried.title).toBe(first.title);
    expect(retried.summary).toBe(first.summary);
    expect(retried.falsePositiveSpellings).toEqual(first.falsePositiveSpellings);
    expect(await readFile(approvedPath, "utf8")).toContain(retried.title);
  });

  it("rebuilds the staged file when the owner changes what is redacted", async () => {
    const { service, prepared, resolutions, approvedPath } = await stagedFixture();
    await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions, metadata: METADATA, ownerRedactions: [{ exactText: "STDERR_SENTINEL" }],
    });

    const amended = await service.approveForPublish(prepared.captureId, OTHER_REQUEST_KEY, {
      resolutions, metadata: METADATA,
      ownerRedactions: [{ exactText: "STDERR_SENTINEL" }, { exactText: "PRESERVE_UNKNOWN" }],
    });

    expect(amended.content).not.toContain("PRESERVE_UNKNOWN");
    const staged = JSON.parse(await readFile(approvedPath, "utf8"));
    expect(staged.requestKey).toBe(OTHER_REQUEST_KEY);
    expect(staged.content).toBe(amended.content);
  });

  it("ignores a torn staged file and rebuilds it from the original capture", async () => {
    const { service, prepared, resolutions, approvedPath } = await stagedFixture();
    const first = await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions, metadata: METADATA, ownerRedactions: [{ exactText: "STDERR_SENTINEL" }],
    });
    const complete = await readFile(approvedPath, "utf8");
    await writeFile(approvedPath, complete.slice(0, Math.floor(complete.length / 2)));

    const rebuilt = await service.approveForPublish(prepared.captureId, REQUEST_KEY, {
      resolutions, metadata: METADATA, ownerRedactions: [{ exactText: "STDERR_SENTINEL" }],
    });

    expect(rebuilt.content).toBe(first.content);
    expect(await readFile(approvedPath, "utf8")).toBe(complete);
  });

  it("removes both the staged variant and the original only when discarded", async () => {
    const { fixture, service, prepared, resolutions, originalPath, approvedPath } = await stagedFixture();
    await service.approveForPublish(prepared.captureId, REQUEST_KEY, { resolutions, metadata: METADATA });
    expect(await readdir(fixture.options.captureDirectory)).toHaveLength(2);

    await service.discard(prepared.captureId);

    expect(await readdir(fixture.options.captureDirectory)).toEqual([]);
    await expect(service.load(prepared.captureId)).rejects.toMatchObject({ code: "CAPTURE_NOT_FOUND" });
    await expect(readFile(originalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(approvedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // Discarding an already-published capture stays quiet rather than failing a retry.
    await expect(service.discard(prepared.captureId)).resolves.toBeUndefined();
  });

  it("still accepts the capture directory once a staged variant is present", async () => {
    const { service, prepared, resolutions } = await stagedFixture();
    await service.approveForPublish(prepared.captureId, REQUEST_KEY, { resolutions, metadata: METADATA });

    const next = await service.prepare({ harness: "github-copilot-cli", harnessSessionId: SESSION_ID });

    expect(next.captureId).toBe(prepared.captureId);
  });

  it("refuses to stage a variant under a key that is not a deterministic request digest", async () => {
    const { service, prepared, resolutions } = await stagedFixture();

    await expect(service.approveForPublish(prepared.captureId, "not-a-digest", { resolutions, metadata: METADATA }))
      .rejects.toMatchObject({ code: "INVALID_CAPTURE" });
  });
});
