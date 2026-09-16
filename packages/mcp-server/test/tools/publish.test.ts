import { describe, expect, it, vi } from "vitest";
import type { Finding, FindingResolution } from "@session-registry/core";
import { SummaryGenerationOutOfBoundsError, TITLE_MAX_LENGTH } from "@session-registry/core";
import {
  publishSession,
  UnresolvedFindingsNotInteractiveError,
  UnscannableContentError,
  ScanFailedError,
  SummaryNotConfirmedError,
  type BackendPublishClient,
  type PublishSubmission,
} from "../../src/tools/publish.js";

function makeInput(overrides: Partial<Parameters<typeof publishSession>[0]> = {}) {
  return {
    ownerGithubLogin: "octocat",
    transcript: "hello world, nothing sensitive here",
    artifacts: [] as { filename: string; content: string }[],
    harness: { name: "test-harness", version: "1.0.0" },
    ...overrides,
  };
}

function makeRecordingBackendClient() {
  const submissions: PublishSubmission[] = [];
  const client: BackendPublishClient = {
    async submitToBackend(submission) {
      submissions.push(submission);
      return { sessionId: "session-123" };
    },
  };
  return { client, submissions };
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

function baseDeps(
  overrides: Partial<Parameters<typeof publishSession>[1]> &
    Pick<Parameters<typeof publishSession>[1], "backendClient" | "interactive" | "resolveInteractively">,
): Parameters<typeof publishSession>[1] {
  return { ...defaultSummaryDeps(), ...overrides };
}

describe("publishSession", () => {
  it("happy path: no findings publishes the transcript and artifacts unmodified", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();

    const result = await publishSession(
      makeInput({
        artifacts: [{ filename: "notes.md", content: "just some notes" }],
      }),
      baseDeps({ backendClient: client, interactive: true, resolveInteractively }),
    );

    expect(result).toEqual({ sessionId: "session-123" });
    expect(resolveInteractively).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      ownerGithubLogin: "octocat",
      transcript: "hello world, nothing sensitive here",
      artifacts: [{ filename: "notes.md", content: "just some notes" }],
      harness: { name: "test-harness", version: "1.0.0" },
      title: "Default generated title",
      summary: "Default generated summary",
    });
  });

  it("happy path: a finding resolved as accept-redaction publishes the redacted variant", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const transcript = "my key is AKIAABCDEFGHIJKLMNOP ok";
    const resolveInteractively = vi.fn(async (findings: readonly Finding[]) => {
      const resolutions: FindingResolution[] = findings.map((_, findingIndex) => ({
        findingIndex,
        action: { kind: "accept-redaction" },
      }));
      return resolutions;
    });

    const result = await publishSession(makeInput({ transcript }), baseDeps({
      backendClient: client,
      interactive: true,
      resolveInteractively,
    }));

    expect(result).toEqual({ sessionId: "session-123" });
    expect(resolveInteractively).toHaveBeenCalledTimes(1);
    expect(submissions[0].transcript).toBe("my key is [REDACTED] ok");
  });

  it("edge case: a finding with no safe auto-redaction can be resolved as custom-replacement", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const transcript = "token: ghp_" + "a".repeat(36);
    const resolveInteractively = vi.fn(async (findings: readonly Finding[]) => {
      return findings.map((_, findingIndex) => ({
        findingIndex,
        action: { kind: "custom-replacement", replacementText: "<my-token>" },
      })) satisfies FindingResolution[];
    });

    await publishSession(makeInput({ transcript }), baseDeps({
      backendClient: client,
      interactive: true,
      resolveInteractively,
    }));

    expect(submissions[0].transcript).toBe("token: <my-token>");
  });

  it("edge case: a finding resolved as false-positive is left in the published content untouched", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const transcript = "token: ghp_" + "b".repeat(36);
    const resolveInteractively = vi.fn(async (findings: readonly Finding[]) => {
      return findings.map((_, findingIndex) => ({
        findingIndex,
        action: { kind: "false-positive" },
      })) satisfies FindingResolution[];
    });

    await publishSession(makeInput({ transcript }), baseDeps({
      backendClient: client,
      interactive: true,
      resolveInteractively,
    }));

    expect(submissions[0].transcript).toBe(transcript);
  });

  it("edge case: an unsupported artifact type is not silently scanned as clean (BASE-R30)", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();

    await expect(
      publishSession(
        makeInput({
          artifacts: [{ filename: "session.bin", content: "\x00\x01binary" }],
        }),
        baseDeps({ backendClient: client, interactive: true, resolveInteractively }),
      ),
    ).rejects.toThrow(UnscannableContentError);

    expect(submissions).toHaveLength(0);
  });

  it("error path: a scanner error fails the publish with no partial submission (amended BASE-R40)", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();
    const failingScan = () => ({ status: "error" as const, reason: "scanner timed out" });

    await expect(
      publishSession(makeInput(), baseDeps({
        backendClient: client,
        interactive: true,
        resolveInteractively,
        scanTranscript: failingScan,
      })),
    ).rejects.toThrow(ScanFailedError);

    expect(submissions).toHaveLength(0);
    expect(resolveInteractively).not.toHaveBeenCalled();
  });

  it("error path: a non-interactive harness with unresolved findings fails with no network call", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();
    const transcript = "my key is AKIAABCDEFGHIJKLMNOP ok";

    await expect(
      publishSession(makeInput({ transcript }), baseDeps({
        backendClient: client,
        interactive: false,
        resolveInteractively,
      })),
    ).rejects.toThrow(UnresolvedFindingsNotInteractiveError);

    expect(submissions).toHaveLength(0);
    expect(resolveInteractively).not.toHaveBeenCalled();
  });

  it("error path: an interactive resolver declining to resolve (returns null) fails with no submission", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn(async () => null);
    const transcript = "my key is AKIAABCDEFGHIJKLMNOP ok";

    await expect(
      publishSession(makeInput({ transcript }), baseDeps({
        backendClient: client,
        interactive: true,
        resolveInteractively,
      })),
    ).rejects.toThrow(UnresolvedFindingsNotInteractiveError);

    expect(submissions).toHaveLength(0);
  });

  it("integration: only the exact fully-resolved variant reaches the backend, never the raw content", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const transcript = "aws=AKIAABCDEFGHIJKLMNOP and token=ghp_" + "c".repeat(36);
    const resolveInteractively = vi.fn(async (findings: readonly Finding[]) =>
      findings.map((finding, findingIndex) => ({
        findingIndex,
        action:
          finding.category === "aws-access-key-id"
            ? ({ kind: "accept-redaction" } as const)
            : ({ kind: "custom-replacement", replacementText: "<redacted-token>" } as const),
      })),
    );

    await publishSession(makeInput({ transcript }), baseDeps({
      backendClient: client,
      interactive: true,
      resolveInteractively,
    }));

    expect(submissions).toHaveLength(1);
    expect(submissions[0].transcript).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(submissions[0].transcript).not.toContain("ghp_" + "c".repeat(36));
    expect(submissions[0].transcript).toBe(
      "aws=[REDACTED] and token=<redacted-token>",
    );
  });

  /**
   * This test demonstrates a documented, accepted residual gap (see the
   * plan's Key Technical Decisions and Risks & Dependencies): an
   * authenticated caller that talks to the (future) Unit 4 publish API
   * directly, bypassing this MCP server entirely, is *not* prevented from
   * doing so by anything in this module — Unit 2's scan-then-submit flow
   * is a client-side guarantee for *this* code path, not a server-side
   * enforcement of "content must have been scanned."
   *
   * `FakeUnit4BackendClient` is a spec-faithful stand-in for the
   * not-yet-built Unit 4 endpoint: per the plan, Unit 4 trusts any
   * authenticated payload and performs no server-side scanning itself.
   */
  it("integration (Unit 4 boundary): an authenticated direct-to-backend submission bypassing the scan still succeeds", async () => {
    class FakeUnit4BackendClient implements BackendPublishClient {
      public received: PublishSubmission | undefined;
      async submitToBackend(submission: PublishSubmission) {
        // Faithful to Unit 4's documented spec: authenticated payloads are
        // trusted as-is, with no server-side re-scan.
        this.received = submission;
        return { sessionId: "session-direct" };
      }
    }

    const fakeUnit4 = new FakeUnit4BackendClient();
    const rawUnredactedTranscript = "aws=AKIAABCDEFGHIJKLMNOP unredacted";

    // Simulates an authenticated caller submitting directly to the
    // Unit 4-shaped backend client, skipping publishSession's scan step
    // entirely.
    const result = await fakeUnit4.submitToBackend({
      ownerGithubLogin: "octocat",
      transcript: rawUnredactedTranscript,
      artifacts: [],
      harness: { name: "some-other-process", version: "0.0.1" },
      title: "Untitled",
      summary: "unscanned direct submission",
    });

    expect(result).toEqual({ sessionId: "session-direct" });
    expect(fakeUnit4.received?.transcript).toBe(rawUnredactedTranscript);
  });
});

describe("publishSession — title/summary generation (Unit 3)", () => {
  it("happy path: generated title/summary within limits, no findings, owner confirms as-is", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();
    const confirmSummary = vi.fn(async (candidate: { title: string; summary: string }) => candidate);

    await publishSession(
      makeInput(),
      baseDeps({
        backendClient: client,
        interactive: true,
        resolveInteractively,
        generateSummary: async () => ({
          title: "Fix flaky auth test",
          summary: "Investigated and fixed a race condition in the auth suite.",
        }),
        confirmSummary,
      }),
    );

    expect(confirmSummary).toHaveBeenCalledTimes(1);
    expect(submissions[0]).toMatchObject({
      title: "Fix flaky auth test",
      summary: "Investigated and fixed a race condition in the auth suite.",
    });
  });

  it("happy path: an owner edit before confirming is re-scanned before it can be confirmed (SUMMARY-R50)", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();
    const scanCalls: string[] = [];
    const scanSummaryText = (content: string) => {
      scanCalls.push(content);
      return { status: "ok" as const, findings: [] };
    };

    let callCount = 0;
    const confirmSummary = vi.fn(async (candidate: { title: string; summary: string }) => {
      callCount += 1;
      if (callCount === 1) {
        // Owner edits the summary on first presentation.
        return { title: candidate.title, summary: "an owner-edited summary" };
      }
      // Confirms the (re-scanned) edited value on the second presentation.
      return candidate;
    });

    await publishSession(
      makeInput(),
      baseDeps({
        backendClient: client,
        interactive: true,
        resolveInteractively,
        generateSummary: async () => ({
          title: "Generated title",
          summary: "Generated summary",
        }),
        confirmSummary,
        scanSummaryText,
      }),
    );

    expect(confirmSummary).toHaveBeenCalledTimes(2);
    // The edited summary text must have been scanned (not just the
    // originally-generated one) before the second confirmation round.
    expect(scanCalls).toContain("an owner-edited summary");
    expect(submissions[0].summary).toBe("an owner-edited summary");
  });

  it("edge case: empty generated output fails publish rather than publishing an empty field", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();

    await expect(
      publishSession(
        makeInput(),
        baseDeps({
          backendClient: client,
          interactive: true,
          resolveInteractively,
          generateSummary: async () => ({ title: "", summary: "some summary" }),
        }),
      ),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);

    expect(submissions).toHaveLength(0);
  });

  it("edge case: over-limit generated output fails publish rather than silently truncating", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();

    await expect(
      publishSession(
        makeInput(),
        baseDeps({
          backendClient: client,
          interactive: true,
          resolveInteractively,
          generateSummary: async () => ({
            title: "x".repeat(TITLE_MAX_LENGTH + 1),
            summary: "some summary",
          }),
        }),
      ),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);

    expect(submissions).toHaveLength(0);
  });

  it("edge case: a finding in generated text must be resolved via accept/replace/false-positive before confirming (SUMMARY-R49)", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn(async (findings: readonly Finding[]) =>
      findings.map((_, findingIndex) => ({
        findingIndex,
        action: { kind: "accept-redaction" as const },
      })),
    );
    const confirmSummary = vi.fn(async (candidate: { title: string; summary: string }) => candidate);

    await publishSession(
      makeInput(),
      baseDeps({
        backendClient: client,
        interactive: true,
        resolveInteractively,
        generateSummary: async () => ({
          title: "aws=AKIAABCDEFGHIJKLMNOP",
          summary: "some summary",
        }),
        confirmSummary,
      }),
    );

    expect(resolveInteractively).toHaveBeenCalledTimes(1);
    // Confirmation only ever sees the already-resolved (redacted) title —
    // there is no whole-text "approve anyway" override for this surface.
    expect(confirmSummary).toHaveBeenCalledWith({
      title: "aws=[REDACTED]",
      summary: "some summary",
    });
    expect(submissions[0].title).toBe("aws=[REDACTED]");
  });

  it("edge case: a scan failure on generated text fails closed rather than silently approving it (LINTER-R11)", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();
    const failingScan = () => ({ status: "error" as const, reason: "linter timed out" });

    await expect(
      publishSession(
        makeInput(),
        baseDeps({
          backendClient: client,
          interactive: true,
          resolveInteractively,
          scanSummaryText: failingScan,
        }),
      ),
    ).rejects.toThrow(ScanFailedError);

    expect(submissions).toHaveLength(0);
  });

  it("error path: the owner declining to confirm aborts the publish with no submission", async () => {
    const { client, submissions } = makeRecordingBackendClient();
    const resolveInteractively = vi.fn();

    await expect(
      publishSession(
        makeInput(),
        baseDeps({
          backendClient: client,
          interactive: true,
          resolveInteractively,
          confirmSummary: async () => null,
        }),
      ),
    ).rejects.toThrow(SummaryNotConfirmedError);

    expect(submissions).toHaveLength(0);
  });
});

