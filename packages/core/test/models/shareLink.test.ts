import { describe, expect, it } from "vitest";
import {
  createShareLink,
  InvalidShareLinkInputError,
  isShareLinkActive,
  revokeShareLink,
  type NewShareLinkInput,
} from "../../src/models/shareLink.js";

function validInput(overrides: Partial<NewShareLinkInput> = {}): NewShareLinkInput {
  return {
    sessionId: "sess_1",
    audiencePolicy: { accessMode: "anonymous" },
    expiresAt: null,
    ...overrides,
  };
}

describe("createShareLink", () => {
  it("creates an active link with no expiration by default (happy path)", () => {
    const link = createShareLink(validInput(), {
      now: () => new Date("2026-09-08T00:00:00Z"),
      generateId: () => "link_fixed",
    });

    expect(link.id).toBe("link_fixed");
    expect(link.revokedAt).toBeNull();
    expect(isShareLinkActive(link, { now: () => new Date("2026-09-09T00:00:00Z") })).toBe(true);
  });

  it("creates a link scoped to specific GitHub users", () => {
    const link = createShareLink(
      validInput({
        audiencePolicy: {
          accessMode: "authenticated",
          rules: [{ type: "specific-users", githubLogins: ["octocat", "monalisa"] }],
        },
      }),
    );
    expect(link.audiencePolicy).toEqual({
      accessMode: "authenticated",
      rules: [{ type: "specific-users", githubLogins: ["octocat", "monalisa"] }],
    });
  });

  it("rejects an authenticated policy with an empty rules list (error path)", () => {
    const input = validInput({
      audiencePolicy: { accessMode: "authenticated", rules: [] },
    });
    expect(() => createShareLink(input)).toThrow(InvalidShareLinkInputError);
  });

  it("rejects an expiresAt that is already in the past (error path)", () => {
    const input = validInput({ expiresAt: new Date("2020-01-01T00:00:00Z") });
    expect(() =>
      createShareLink(input, { now: () => new Date("2026-09-08T00:00:00Z") }),
    ).toThrow(InvalidShareLinkInputError);
  });
});

describe("revokeShareLink", () => {
  it("revokes an active link (happy path)", () => {
    const link = createShareLink(validInput());
    const revoked = revokeShareLink(link, { now: () => new Date("2026-09-09T00:00:00Z") });
    expect(revoked.revokedAt).toEqual(new Date("2026-09-09T00:00:00Z"));
    expect(isShareLinkActive(revoked)).toBe(false);
  });

  it("is a one-way transition — revoking an already-revoked link is a no-op (edge case)", () => {
    const link = createShareLink(validInput());
    const revokedOnce = revokeShareLink(link, { now: () => new Date("2026-09-09T00:00:00Z") });
    const revokedTwice = revokeShareLink(revokedOnce, { now: () => new Date("2026-09-20T00:00:00Z") });
    expect(revokedTwice.revokedAt).toEqual(revokedOnce.revokedAt);
  });
});

describe("isShareLinkActive", () => {
  it("treats an expired link as inactive even if never revoked (edge case)", () => {
    const link = createShareLink(
      validInput({ expiresAt: new Date("2026-09-10T00:00:00Z") }),
      { now: () => new Date("2026-09-08T00:00:00Z") },
    );
    expect(isShareLinkActive(link, { now: () => new Date("2026-09-11T00:00:00Z") })).toBe(false);
  });
});
