import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NATIVE_SESSION_ARCHIVE_FORMAT, type NativeSessionArchive } from "@session-registry/core";
import { createDefaultBackendClient, createPublishHandler, type PublishToolInput } from "../src/index.js";
import type { BackendPublishAndShareClient } from "../src/tools/publishAndShare.js";
import { PublishStateUnknownError } from "../src/httpBackendClient.js";
import type { NativeCaptureService } from "../src/native/captures.js";
import { NativeCaptureError } from "../src/native/files.js";
import { resolveNativeCapture, scanNativeCapture, type ReviewedCapture } from "../src/native/review.js";
import { acknowledgeFixtureWarnings } from "./native/fixtures.js";

const eventContent = '{"type":"tool.result","id":"tool-1","stdout":"all preserved","stderr":"failure before retry"}\n';
const archive: NativeSessionArchive = {
  format: NATIVE_SESSION_ARCHIVE_FORMAT,
  harness: { name: "github-copilot-cli", version: "0.0.420" },
  harnessSessionId: "copilot-2026-09-08-mcp-publish",
  capturedAt: "2026-09-10T20:00:00.000Z",
  sourceFormat: "copilot-events-v1",
  scope: "persisted-session-records",
  resumable: false,
  files: [{
    path: "events.jsonl", kind: "events", recordCount: 1, content: eventContent,
    sha256: createHash("sha256").update(eventContent).digest("hex"),
  }],
  redactions: [],
  capture: {
    boundary: "observed-prefixes", entrypoint: "events.jsonl", selection: "native-id", layout: "session-directory",
    sources: [{
      path: "events.jsonl", capturedBytes: Buffer.byteLength(eventContent), observedBytes: Buffer.byteLength(eventContent),
      sha256: createHash("sha256").update(eventContent).digest("hex"), snapshot: "file-prefix",
    }],
    history: [{ path: "events.jsonl", sessionId: "copilot-2026-09-08-mcp-publish" }],
    diagnostics: [],
  },
  restoration: { status: "not-verified", reason: "Fixture captures source, not native activation." },
};

type StubCaptureService = NativeCaptureService & {
  readonly staged: Map<string, ReviewedCapture>;
  readonly discarded: string[];
};

function captures(value = archive): StubCaptureService {
  const staged = new Map<string, ReviewedCapture>();
  const discarded: string[] = [];
  const service: StubCaptureService = {
    staged,
    discarded,
    async prepare() { throw new Error("This handler only publishes previously prepared captures."); },
    async load() { return { archive: value, content: JSON.stringify(value) }; },
    async review(captureId, resolutions, metadata, ownerRedactions) {
      return resolveNativeCapture(value, captureId, resolutions, metadata, ownerRedactions);
    },
    async approveForPublish(captureId, requestKey, request) {
      const existing = staged.get(`${captureId}:${requestKey}`);
      if (existing !== undefined) return existing;
      const reviewed = await service.review(captureId, request.resolutions, request.metadata, request.ownerRedactions);
      staged.set(`${captureId}:${requestKey}`, reviewed);
      return reviewed;
    },
    async discard(captureId) {
      discarded.push(captureId);
      for (const key of [...staged.keys()]) {
        if (key.startsWith(`${captureId}:`)) staged.delete(key);
      }
    },
  };
  return service;
}

function input(overrides: Partial<PublishToolInput> = {}): PublishToolInput {
  const captureId = overrides.captureId ?? "a".repeat(64);
  return {
    captureId,
    resolutions: acknowledgeFixtureWarnings(scanNativeCapture(archive, captureId)),
    title: "Fix MCP publishing",
    summary: "Published the native session rather than a conversation excerpt.",
    confirmed: true,
    audiencePolicy: { accessMode: "anonymous" },
    ...overrides,
  };
}

function published(idempotentReplay = false) {
  return {
    sessionId: "session-1",
    harnessSessionId: archive.harnessSessionId,
    linkId: "link-1",
    shareUrl: `https://sessions.example.com/session/${archive.harnessSessionId}/link-1`,
    idempotentReplay,
  };
}

describe("createPublishHandler", () => {
  it("publishes the exact immutable native archive and returns the complete public URL", async () => {
    const received: string[] = [];
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink(submission) {
        received.push(submission.transcript);
        expect(submission.harness).toEqual(archive.harness);
        expect(submission.harnessSessionId).toBe(archive.harnessSessionId);
        return published();
      },
    };
    const result = await createPublishHandler(backendClient, captures())(input());
    expect(received).toEqual([JSON.stringify(archive)]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `Published session ${archive.harnessSessionId} and created share link link-1. View it at ${published().shareUrl}`,
        },
        {
          type: "text",
          text: JSON.stringify({
            status: "published",
            title: "Fix MCP publishing",
            summary: "Published the native session rather than a conversation excerpt.",
            harnessSessionId: archive.harnessSessionId,
            shareUrl: published().shareUrl,
            localCapturesRemoved: true,
            publicationSettings: {
              audience: "anyone",
              audiencePolicy: { accessMode: "anonymous" },
              expiration: "14 days (default)",
              ownerRequestedRedactionCount: 0,
              appliedRedactionCount: 0,
            },
          }),
        },
      ],
    });
  });

  it("returns the enforced restricted audience and safe redaction counts in the publication receipt", async () => {
    const restricted = {
      accessMode: "authenticated" as const,
      rules: [{ type: "specific-users" as const, githubLogins: ["fixture-reviewer"] }],
    };
    const result = await createPublishHandler({
      async submitAndCreateLink(_submission, share) {
        expect(share.audiencePolicy).toEqual(restricted);
        return published();
      },
    }, captures())(input({
      audiencePolicy: restricted,
      ownerRedactions: [{ exactText: "all preserved" }],
    }));

    expect(result.isError).not.toBe(true);
    const receipt = result.content[1];
    if (receipt?.type !== "text") throw new Error("Expected publication receipt");
    expect(JSON.parse(receipt.text)).toMatchObject({
      publicationSettings: {
        audience: "users:fixture-reviewer",
        audiencePolicy: restricted,
        expiration: "14 days (default)",
        ownerRequestedRedactionCount: 1,
        appliedRedactionCount: 1,
      },
    });
    expect(receipt.text).not.toContain("all preserved");
  });

  it("returns an unambiguous MCP error when publishing fails", async () => {
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink() { throw new Error("backend unavailable"); },
    };
    const result = await createPublishHandler(backendClient, captures())(input());
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "PUBLISH FAILED: Nothing was published. backend unavailable" }],
    });
  });

  it("reports unknown state with a stable key and reuses the capture instead of preparing again", async () => {
    const keys: string[] = [];
    const payloads: string[] = [];
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink(submission, _share, key) {
        keys.push(key);
        payloads.push(submission.transcript);
        if (keys.length === 1) throw new PublishStateUnknownError("connection reset");
        return published(true);
      },
    };
    const handler = createPublishHandler(backendClient, captures());
    const request = input();
    const uncertain = await handler(request);
    const replay = await handler(request);
    expect(uncertain.isError).toBe(true);
    expect(uncertain.content[0]?.text).toContain("PUBLISH STATE UNKNOWN");
    expect(keys[0]).toBe(keys[1]);
    expect(payloads[0]).toBe(payloads[1]);
    expect(replay.content[0]?.text).toBe(
      `Replayed confirmed publish ${archive.harnessSessionId} and returned share link link-1. View it at ${published().shareUrl}`,
    );
  });

  it("binds idempotency to both the snapshot and the confirmed publication settings", async () => {
    const keys: string[] = [];
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink(submission, share, key) {
        expect(submission.title).toContain("title");
        expect(share.audiencePolicy).toEqual({ accessMode: "anonymous" });
        keys.push(key);
        return published();
      },
    };
    const handler = createPublishHandler(backendClient, captures());
    await handler(input({ title: "First title" }));
    await handler(input({ title: "First title", captureId: "b".repeat(64) }));
    await handler(input({ title: "Different title" }));
    expect(new Set(keys).size).toBe(3);
  });

  it("defaults missing access to anonymous and gives explicit/default access identical retry keys", async () => {
    const keys: string[] = [];
    const audiences: unknown[] = [];
    const backend: BackendPublishAndShareClient = {
      async submitAndCreateLink(_submission, share, key) {
        keys.push(key);
        audiences.push(share.audiencePolicy);
        expect(share.expiresAt).toBeInstanceOf(Date);
        expect(Math.abs(share.expiresAt!.getTime() - Date.now() - 14 * 24 * 60 * 60 * 1_000)).toBeLessThan(5_000);
        return published();
      },
    };
    const handler = createPublishHandler(backend, captures());
    expect((await handler(input({ audiencePolicy: undefined }))).isError).not.toBe(true);
    expect((await handler(input({ audiencePolicy: { accessMode: "anonymous" } }))).isError).not.toBe(true);
    const restricted = {
      accessMode: "authenticated" as const,
      rules: [{ type: "specific-users" as const, githubLogins: ["fixture-reviewer"] }],
    };
    expect((await handler(input({ audiencePolicy: restricted }))).isError).not.toBe(true);
    expect(audiences).toEqual([{ accessMode: "anonymous" }, { accessMode: "anonymous" }, restricted]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("does not conflate default expiration with explicit no-expiration in retry keys", async () => {
    const keys: string[] = [];
    const expirations: (Date | null | undefined)[] = [];
    const handler = createPublishHandler({
      async submitAndCreateLink(_submission, share, key) {
        keys.push(key);
        expirations.push(share.expiresAt);
        return published();
      },
    }, captures());
    await handler(input());
    await handler(input({ expiresAt: null }));
    expect(keys[0]).not.toBe(keys[1]);
    expect(expirations[0]).toBeInstanceOf(Date);
    expect(expirations[1]).toBeNull();
  });

  it("blocks unresolved findings and retains explicitly approved false positives through publication", async () => {
    let uploads = 0;
    const token = "ghp_" + "x".repeat(36);
    const content = `{"type":"tool.result","output":"${token}"}\n`;
    const candidate: NativeSessionArchive = {
      ...archive,
      files: [{ ...archive.files[0]!, content, sha256: createHash("sha256").update(content).digest("hex") }],
      capture: {
        ...archive.capture!,
        sources: [{
          ...archive.capture!.sources[0]!, capturedBytes: Buffer.byteLength(content), observedBytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        }],
      },
    };
    const findings = scanNativeCapture(candidate, input().captureId);
    const finding = findings.find((item) => !item.manualReview)!;
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink(submission) {
        expect(submission.transcript).toBe(JSON.stringify(candidate));
        uploads++;
        return published();
      },
    };
    const handler = createPublishHandler(backendClient, captures(candidate));
    const resolution = { findingId: finding.id, action: { kind: "false-positive" as const } };
    expect((await handler(input())).isError).toBe(true);
    expect((await handler(input({ resolutions: [resolution, resolution] }))).isError).toBe(true);
    expect((await handler(input({ resolutions: [{ ...resolution, findingId: "b".repeat(64) }] }))).isError).toBe(true);
    expect(uploads).toBe(0);
    expect((await handler(input({ resolutions: [...acknowledgeFixtureWarnings(findings), resolution] }))).isError).not.toBe(true);
    expect(uploads).toBe(1);
  });

  it("deletes the local capture only after the upload succeeds, and keeps it for retry when it fails", async () => {
    const service = captures();
    const failing = createPublishHandler({
      async submitAndCreateLink() { throw new Error("upload rejected"); },
    }, service);
    expect((await failing(input())).isError).toBe(true);
    // The staged variant survives a failed upload so the retry re-sends those
    // exact bytes rather than recapturing and re-redacting the session.
    expect(service.discarded).toEqual([]);
    expect(service.staged.size).toBe(1);

    let uploaded = 0;
    const succeeding = createPublishHandler({
      async submitAndCreateLink() { uploaded++; return published(); },
    }, service);
    const result = await succeeding(input());

    expect(uploaded).toBe(1);
    expect(result.isError).not.toBe(true);
    expect(service.discarded).toEqual(["a".repeat(64)]);
    expect(service.staged.size).toBe(0);
  });

  it("reports a published session whose local capture files could not be deleted", async () => {
    const service = captures();
    service.discard = async () => { throw new Error("capture directory is read-only"); };
    const result = await createPublishHandler({
      async submitAndCreateLink() { return published(); },
    }, service)(input());

    expect(result.isError).not.toBe(true);
    const receipt = JSON.parse(result.content[1]!.text as string);
    expect(receipt.status).toBe("published");
    expect(receipt.localCapturesRemoved).toBe(false);
    expect(receipt.localCaptureRemovalError).toContain("read-only");
    expect(receipt.localCaptureRemovalGuidance).toContain("remove them manually");
  });

  it("does not upload or reconstruct content when a prepared snapshot is unavailable", async () => {
    const backendClient: BackendPublishAndShareClient = {
      async submitAndCreateLink() { throw new Error("must not reach the backend"); },
    };
    const service: NativeCaptureService = {
      async prepare() { throw new Error("must not reprepare"); },
      async load() { throw new NativeCaptureError("CAPTURE_NOT_FOUND", "Capture unavailable"); },
      async review() { throw new NativeCaptureError("CAPTURE_NOT_FOUND", "Capture unavailable"); },
      async approveForPublish() { throw new NativeCaptureError("CAPTURE_NOT_FOUND", "Capture unavailable"); },
      async discard() { throw new Error("must not discard a capture that was never published"); },
    };
    const result = await createPublishHandler(backendClient, service)(input());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("CAPTURE_NOT_FOUND");
    expect(result.content[0]?.text).toContain("may already be published");
    expect(result.content[0]?.text).toContain("Do not capture the session again");
    expect(result.content[0]?.text).not.toContain("Nothing was published");
  });

  it("requires only the API URL and publishing token at startup", () => {
    expect(() => createDefaultBackendClient({
      SESSION_REGISTRY_API_URL: "https://api.example.com",
      SESSION_REGISTRY_TOKEN: "fixture-owner",
    })).not.toThrow();
  });
});
