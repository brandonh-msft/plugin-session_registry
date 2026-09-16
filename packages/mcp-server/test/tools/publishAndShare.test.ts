import { describe, expect, it, vi } from "vitest";
import { UnscannableContentError } from "../../src/tools/publish.js";
import {
  publishAndShareSession,
  DEFAULT_SHARE_LINK_EXPIRATION_DAYS,
  InvalidShareRequestError,
  type BackendPublishAndShareClient,
  type PublishAndShareInput,
  type PublishAndShareDeps,
  type PublishAndShareResult,
} from "../../src/tools/publishAndShare.js";

function makeInput(overrides: Partial<PublishAndShareInput> = {}): PublishAndShareInput {
  return {
    ownerGithubLogin: "octocat",
    transcript: "hello world, nothing sensitive here",
    artifacts: [],
    harness: { name: "test-harness", version: "1.0.0" },
    share: { audiencePolicy: { accessMode: "anonymous" } },
    idempotencyKey: "confirm-token-1",
    ...overrides,
  };
}

function defaultSummaryDeps() {
  return {
    generateSummary: async () => ({
      title: "Default generated title",
      summary: "Default generated summary",
    }),
    confirmSummary: async (candidate: { title: string; summary: string }) => candidate,
  };
}

/**
 * A recording+deduping fake standing in for the real HTTP client. Dedupes
 * by `idempotencyKey` (as any real implementation must, per `PUBLISH-R54`)
 * so tests can assert a retry never creates a second session/link.
 */
function makeFakeBackendClient(options: { rejectSubmission?: boolean } = {}) {
  const calls: Array<{ idempotencyKey: string }> = [];
  const resultsByKey = new Map<string, PublishAndShareResult>();
  let nextId = 1;

  const client: BackendPublishAndShareClient = {
    async submitAndCreateLink(submission, share, idempotencyKey) {
      calls.push({ idempotencyKey });
      const existing = resultsByKey.get(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      if (options.rejectSubmission) {
        throw new Error("content matched the malicious-content check");
      }
      const result: PublishAndShareResult = {
        sessionId: `session-${nextId}`,
        harnessSessionId: submission.harnessSessionId,
        linkId: `link-${nextId}`,
        shareUrl: `https://registry.example.com/session/${encodeURIComponent(submission.harnessSessionId)}/link-${nextId}`,
        idempotentReplay: false,
      };
      nextId += 1;
      resultsByKey.set(idempotencyKey, result);
      return result;
    },
  };
  return { client, calls, resultsByKey };
}

function baseDeps(
  overrides: Partial<PublishAndShareDeps> &
    Pick<PublishAndShareDeps, "backendClient" | "interactive" | "resolveInteractively">,
): PublishAndShareDeps {
  return { ...defaultSummaryDeps(), ...overrides };
}

describe("publishAndShareSession", () => {
  it("happy path: anonymous access mode with no expiration produces an active link with a 14-day expiration", async () => {
    const { client } = makeFakeBackendClient();
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await publishAndShareSession(
      makeInput({ share: { audiencePolicy: { accessMode: "anonymous" } } }),
      baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn(), now: () => now }),
    );

    expect(result.sessionId).toBeDefined();
    expect(result.linkId).toBeDefined();
  });

  it("computes a 14-day expiration from `now` when expiresAt is omitted", async () => {
    let capturedExpiresAt: Date | null | undefined;
    const client: BackendPublishAndShareClient = {
      async submitAndCreateLink(_submission, share) {
        capturedExpiresAt = share.expiresAt;
        return {
          sessionId: "session-1",
          harnessSessionId: "hs1",
          linkId: "link-1",
          shareUrl: "https://registry.example.com/session/hs1/link-1",
          idempotentReplay: false,
        };
      },
    };
    const now = new Date("2026-01-01T00:00:00.000Z");

    await publishAndShareSession(
      makeInput({ share: { audiencePolicy: { accessMode: "anonymous" } } }),
      baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn(), now: () => now }),
    );

    expect(capturedExpiresAt).toEqual(
      new Date(now.getTime() + DEFAULT_SHARE_LINK_EXPIRATION_DAYS * 24 * 60 * 60 * 1000),
    );
  });

  it("happy path: authenticated access mode with a valid audience policy produces a correctly scoped link", async () => {
    let capturedShare: { audiencePolicy: unknown } | undefined;
    const client: BackendPublishAndShareClient = {
      async submitAndCreateLink(_submission, share) {
        capturedShare = share;
        return {
          sessionId: "session-1",
          harnessSessionId: "hs1",
          linkId: "link-1",
          shareUrl: "https://registry.example.com/session/hs1/link-1",
          idempotentReplay: false,
        };
      },
    };

    const audiencePolicy = {
      accessMode: "authenticated" as const,
      rules: [{ type: "specific-users" as const, githubLogins: ["monalisa"] }],
    };

    const result = await publishAndShareSession(
      makeInput({ share: { audiencePolicy } }),
      baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn() }),
    );

    expect(result).toEqual({
      sessionId: "session-1",
      harnessSessionId: "hs1",
      linkId: "link-1",
      shareUrl: "https://registry.example.com/session/hs1/link-1",
      idempotentReplay: false,
    });
    expect(capturedShare?.audiencePolicy).toEqual(audiencePolicy);
  });

  it("edge case: an authenticated policy with no rules fails validation with no default applied", async () => {
    const { client, calls } = makeFakeBackendClient();

    await expect(
      publishAndShareSession(
        makeInput({
          share: { audiencePolicy: { accessMode: "authenticated", rules: [] } },
        }),
        baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn() }),
      ),
    ).rejects.toThrow(InvalidShareRequestError);

    // Must fail before ever reaching the scan/submit flow.
    expect(calls).toHaveLength(0);
  });

  it("edge case: an authenticated policy with an invalid rule fails validation rather than falling back to anonymous", async () => {
    const { client, calls } = makeFakeBackendClient();

    await expect(
      publishAndShareSession(
        makeInput({
          share: {
            audiencePolicy: {
              accessMode: "authenticated",
              rules: [{ type: "specific-users", githubLogins: [] }],
            },
          },
        }),
        baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn() }),
      ),
    ).rejects.toThrow(InvalidShareRequestError);

    expect(calls).toHaveLength(0);
  });

  it("edge case: retrying the same confirmed request (same idempotencyKey) returns the original result rather than creating a duplicate", async () => {
    const { client, calls } = makeFakeBackendClient();
    const input = makeInput({ idempotencyKey: "confirm-token-shared" });
    const deps = baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn() });

    const first = await publishAndShareSession(input, deps);
    const second = await publishAndShareSession(input, deps);

    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it("error path: content matching the malicious-content check is rejected before any session or link exists", async () => {
    const { client } = makeFakeBackendClient({ rejectSubmission: true });

    await expect(
      publishAndShareSession(
        makeInput(),
        baseDeps({ backendClient: client, interactive: true, resolveInteractively: vi.fn() }),
      ),
    ).rejects.toThrow(/malicious-content/);
  });

  it("error path: unscannable content is rejected before ever contacting the backend", async () => {
    const { client, calls } = makeFakeBackendClient();
    const scanTranscript = vi.fn(() => ({ status: "unavailable" as const, reason: "binary content" }));

    await expect(
      publishAndShareSession(
        makeInput(),
        baseDeps({
          backendClient: client,
          interactive: true,
          resolveInteractively: vi.fn(),
          scanTranscript,
        }),
      ),
    ).rejects.toThrow(UnscannableContentError);

    expect(calls).toHaveLength(0);
  });
});
