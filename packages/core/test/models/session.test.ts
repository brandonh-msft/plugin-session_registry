import { describe, expect, it } from "vitest";
import {
  applyContentBlock,
  createSession,
  InvalidSessionInputError,
  InvalidSessionLifecycleTransitionError,
  isBlobPointer,
  isValidHarnessSessionId,
  restoreSession,
  supersedeSession,
  tombstoneSession,
  type NewSessionInput,
} from "../../src/models/session.js";

function validInput(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    ownerGithubLogin: "octocat",
    harnessSessionId: "copilot-2026-09-08-auth-flake",
    title: "Fixed the flaky auth test",
    summary: "Investigated and resolved a race condition in the login flow.",
    publicationKey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    harness: { name: "copilot-cli", version: "1.0.83-5" },
    transcriptPointer: { containerName: "transcripts", blobKey: "sess-1/transcript.json" },
    artifactPointers: [
      { containerName: "artifacts", blobKey: "sess-1/diff.patch" },
    ],
    resumableBundlePointer: null,
    knownBadContentListVersionChecked: "2026-09-01",
    ...overrides,
  };
}

describe("createSession", () => {
  it("creates a session with valid metadata and round-trips its blob pointer (happy path)", () => {
    const session = createSession(validInput(), {
      now: () => new Date("2026-09-08T00:00:00Z"),
      generateId: () => "sess_fixed",
    });

    expect(session.id).toBe("sess_fixed");
    expect(session.harnessSessionId).toBe("copilot-2026-09-08-auth-flake");
    expect(session.createdAt).toEqual(new Date("2026-09-08T00:00:00Z"));
    expect(session.publicationKey).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(session.contentBlocked).toBeNull();
    expect(session.supersededAt).toBeNull();
    expect(session.deletedAt).toBeNull();
    expect(session.transcriptPointer).toEqual({
      containerName: "transcripts",
      blobKey: "sess-1/transcript.json",
    });
  });

  it("rejects a raw Buffer passed where a transcript pointer is expected (edge case: structural, not runtime-only)", () => {
    const input = validInput({
      // Simulates a caller mistakenly inlining content instead of a pointer.
      transcriptPointer: Buffer.from("raw transcript bytes") as never,
    });

    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });

  it("rejects a raw string passed where an artifact pointer is expected (edge case)", () => {
    const input = validInput({
      artifactPointers: ["not a pointer, just a string of content"] as never,
    });

    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });

  it("rejects a title longer than 120 chars (error path)", () => {
    const input = validInput({ title: "x".repeat(121) });
    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });

  it("rejects a summary longer than 500 chars (error path)", () => {
    const input = validInput({ summary: "x".repeat(501) });
    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });

  it("rejects an empty title (edge case)", () => {
    const input = validInput({ title: "" });
    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });

  it("rejects a malformed publication key (error path)", () => {
    const input = validInput({ publicationKey: "not-a-sha256" });

    expect(() => createSession(input)).toThrow(InvalidSessionInputError);
  });
});

describe("isBlobPointer", () => {
  it("accepts a well-formed pointer", () => {
    expect(isBlobPointer({ containerName: "c", blobKey: "k" })).toBe(true);
  });

  it("rejects null, arrays, Buffers, and extra-field objects", () => {
    expect(isBlobPointer(null)).toBe(false);
    expect(isBlobPointer(["c", "k"])).toBe(false);
    expect(isBlobPointer(Buffer.from("x"))).toBe(false);
    expect(
      isBlobPointer({ containerName: "c", blobKey: "k", extra: "field" }),
    ).toBe(false);
  });
});

describe("applyContentBlock", () => {
  it("transitions an unblocked session to content-blocked (happy path)", () => {
    const session = createSession(validInput());
    const blocked = applyContentBlock(session, "2026-09-10", {
      now: () => new Date("2026-09-10T00:00:00Z"),
    });

    expect(blocked.contentBlocked).toEqual({
      blockedAt: new Date("2026-09-10T00:00:00Z"),
      matchedListVersion: "2026-09-10",
    });
  });

  it("is a one-way transition — re-blocking an already-blocked session is a no-op (edge case)", () => {
    const session = createSession(validInput());
    const blockedOnce = applyContentBlock(session, "2026-09-10", {
      now: () => new Date("2026-09-10T00:00:00Z"),
    });
    const blockedTwice = applyContentBlock(blockedOnce, "2026-09-20", {
      now: () => new Date("2026-09-20T00:00:00Z"),
    });

    expect(blockedTwice.contentBlocked).toEqual(blockedOnce.contentBlocked);
  });
});

describe("isValidHarnessSessionId", () => {
  it("accepts the identifier shapes harnesses actually emit (happy path)", () => {
    for (const candidate of [
      "copilot-2026-09-08-auth-flake",
      "01JB8Z2M9K7QW4",
      "run.42_final",
      "a",
      "a".repeat(128),
    ]) {
      expect(isValidHarnessSessionId(candidate)).toBe(true);
    }
  });

  it("rejects values that would break out of a URL path segment or exceed the length cap (edge case)", () => {
    for (const candidate of [
      "",
      ".",
      "..",
      "-leading-dash",
      "has space",
      "has/slash",
      "has?query",
      "has#fragment",
      "has%2Fescape",
      "a".repeat(129),
      42,
      null,
      undefined,
    ]) {
      expect(isValidHarnessSessionId(candidate)).toBe(false);
    }
  });
});

describe("createSession harness session id validation", () => {
  it("rejects a harness session id that is not URL-path-safe (edge case)", () => {
    expect(() =>
      createSession(validInput({ harnessSessionId: "../../etc/passwd" })),
    ).toThrow(InvalidSessionInputError);
  });

  it("rejects an empty harness session id (edge case)", () => {
    expect(() => createSession(validInput({ harnessSessionId: "" }))).toThrow(
      InvalidSessionInputError,
    );
  });
});

describe("supersedeSession", () => {
  it("marks a snapshot as no longer current without altering its content (happy path)", () => {
    const session = createSession(validInput());
    const superseded = supersedeSession(session, {
      now: () => new Date("2026-09-11T00:00:00Z"),
    });

    expect(superseded.supersededAt).toEqual(new Date("2026-09-11T00:00:00Z"));
    expect(superseded.title).toBe(session.title);
    expect(superseded.summary).toBe(session.summary);
    expect(superseded.transcriptPointer).toEqual(session.transcriptPointer);
    expect(superseded.harnessSessionId).toBe(session.harnessSessionId);
    // The original value is untouched — superseding returns a new object.
    expect(session.supersededAt).toBeNull();
  });

  it("is a one-way transition — superseding twice keeps the first timestamp (edge case)", () => {
    const session = createSession(validInput());
    const once = supersedeSession(session, {
      now: () => new Date("2026-09-11T00:00:00Z"),
    });
    const twice = supersedeSession(once, {
      now: () => new Date("2026-09-12T00:00:00Z"),
    });

    expect(twice.supersededAt).toEqual(new Date("2026-09-11T00:00:00Z"));
  });
});

describe("tombstoneSession", () => {
  it("marks the current snapshot deleted without changing its publication identity (happy path)", () => {
    const session = createSession(validInput());
    const tombstoned = tombstoneSession(session, {
      now: () => new Date("2026-09-12T00:00:00Z"),
    });

    expect(tombstoned.deletedAt).toEqual(new Date("2026-09-12T00:00:00Z"));
    expect(tombstoned.publicationKey).toBe(session.publicationKey);
    expect(session.deletedAt).toBeNull();
  });

  it("throws when asked to tombstone a superseded snapshot (edge case)", () => {
    const session = supersedeSession(createSession(validInput()), {
      now: () => new Date("2026-09-12T00:00:00Z"),
    });

    expect(() => tombstoneSession(session)).toThrow(
      InvalidSessionLifecycleTransitionError,
    );
  });
});

describe("restoreSession", () => {
  it("restores a tombstoned current snapshot (happy path)", () => {
    const session = tombstoneSession(createSession(validInput()), {
      now: () => new Date("2026-09-12T00:00:00Z"),
    });

    const restored = restoreSession(session);

    expect(restored.deletedAt).toBeNull();
  });

  it("returns the original object unchanged when the session is not tombstoned (edge case)", () => {
    const session = createSession(validInput());

    expect(restoreSession(session)).toBe(session);
  });

  it("returns a non-tombstoned superseded session unchanged before enforcing current-row checks (edge case)", () => {
    const session = supersedeSession(createSession(validInput()), {
      now: () => new Date("2026-09-12T00:00:00Z"),
    });

    expect(restoreSession(session)).toBe(session);
  });

  it("throws when asked to restore a tombstoned superseded snapshot (edge case)", () => {
    const session = supersedeSession(
      tombstoneSession(createSession(validInput()), {
        now: () => new Date("2026-09-12T00:00:00Z"),
      }),
      { now: () => new Date("2026-09-13T00:00:00Z") },
    );

    expect(() => restoreSession(session)).toThrow(
      InvalidSessionLifecycleTransitionError,
    );
  });
});
