import { describe, expect, it } from "vitest";
import {
  canonicalContentDecisions,
  computePublicationKey,
  type ComputePublicationKeyInput,
  type PublicationContentDecision,
} from "../../src/models/publicationKey.js";

function validInput(
  overrides: Partial<ComputePublicationKeyInput> = {},
): ComputePublicationKeyInput {
  return {
    title: "Investigated flaky auth redirect",
    summary: "Captured the failing run and redacted the leaked token.",
    audiencePolicy: {
      accessMode: "authenticated",
      rules: [
        { type: "specific-users", githubLogins: ["OctoCat", "hubot"] },
        { type: "organization", githubOrg: "GitHub" },
      ],
    },
    expiresAtChoice: "default",
    ownerRedactions: [
      {
        exactText: "ghp_secret",
        replacementText: "[TOKEN]",
        caseSensitive: false,
      },
    ],
    contentDecisions: [
      {
        findingId: "finding-1",
        finding: {
          category: "github-personal-access-token",
          matchedText: "ghp_secret",
        },
        action: { kind: "accept-redaction" },
      },
    ],
    ...overrides,
  };
}

describe("computePublicationKey", () => {
  it("returns the same key for identical semantic publication settings (happy path)", () => {
    const input = validInput();

    expect(computePublicationKey(input)).toBe(computePublicationKey(input));
  });

  it("changes when one hashed field changes (happy path)", () => {
    const left = validInput();
    const right = validInput({
      audiencePolicy: {
        accessMode: "authenticated",
        rules: [{ type: "specific-users", githubLogins: ["octocat"] }],
      },
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("ignores findingId churn when category, matched text, and resolution stay the same (edge case)", () => {
    const leftDecision: PublicationContentDecision = {
      findingId: "capture-a-finding-1",
      finding: {
        category: "github-personal-access-token",
        matchedText: "ghp_secret",
      },
      action: { kind: "custom-replacement", replacementText: "[TOKEN]" },
    };
    const rightDecision: PublicationContentDecision = {
      findingId: "capture-b-finding-99",
      finding: {
        category: "github-personal-access-token",
        matchedText: "ghp_secret",
      },
      action: { kind: "custom-replacement", replacementText: "[TOKEN]" },
    };

    expect(canonicalContentDecisions([leftDecision])).toBe(
      canonicalContentDecisions([rightDecision]),
    );
    expect(
      computePublicationKey(validInput({ contentDecisions: [leftDecision] })),
    ).toBe(
      computePublicationKey(validInput({ contentDecisions: [rightDecision] })),
    );
  });

  it("does not collide when field boundaries shift across embedded delimiters (error path)", () => {
    const left = validInput({
      title: "alpha:\u0000beta",
      summary: "gamma",
    });
    const right = validInput({
      title: "alpha",
      summary: "\u0000beta:gamma",
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("treats audience rule reordering and GitHub login casing as non-semantic (edge case)", () => {
    const left = validInput({
      audiencePolicy: {
        accessMode: "authenticated",
        rules: [
          { type: "organization", githubOrg: "GitHub" },
          { type: "specific-users", githubLogins: ["OctoCat", "hubot"] },
        ],
      },
    });
    const right = validInput({
      audiencePolicy: {
        accessMode: "authenticated",
        rules: [
          { type: "specific-users", githubLogins: ["HUBOT", "octocat"] },
          { type: "organization", githubOrg: "github" },
        ],
      },
    });

    expect(computePublicationKey(left)).toBe(computePublicationKey(right));
  });

  it("changes when redaction text casing changes (edge case)", () => {
    const left = validInput({
      ownerRedactions: [{ exactText: "ghp_secret" }],
    });
    const right = validInput({
      ownerRedactions: [{ exactText: "GHP_SECRET" }],
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("changes when caseSensitive changes (edge case)", () => {
    const left = validInput({
      ownerRedactions: [{ exactText: "ghp_secret", caseSensitive: false }],
    });
    const right = validInput({
      ownerRedactions: [{ exactText: "ghp_secret", caseSensitive: true }],
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("changes when custom replacement text changes (edge case)", () => {
    const left = validInput({
      contentDecisions: [
        {
          finding: {
            category: "github-personal-access-token",
            matchedText: "ghp_secret",
          },
          action: { kind: "custom-replacement", replacementText: "[TOKEN]" },
        },
      ],
    });
    const right = validInput({
      contentDecisions: [
        {
          finding: {
            category: "github-personal-access-token",
            matchedText: "ghp_secret",
          },
          action: { kind: "custom-replacement", replacementText: "[MASKED]" },
        },
      ],
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("changes when absolute expiration instants differ (edge case)", () => {
    const left = validInput({
      expiresAtChoice: new Date("2026-09-30T00:00:00Z"),
    });
    const right = validInput({
      expiresAtChoice: new Date("2026-10-01T00:00:00Z"),
    });

    expect(computePublicationKey(left)).not.toBe(computePublicationKey(right));
  });

  it("distinguishes default, never, and absolute expiration choices (edge case)", () => {
    const defaultKey = computePublicationKey(
      validInput({ expiresAtChoice: "default" }),
    );
    const neverKey = computePublicationKey(
      validInput({ expiresAtChoice: "never" }),
    );
    const absoluteKey = computePublicationKey(
      validInput({ expiresAtChoice: new Date("2026-09-30T00:00:00Z") }),
    );

    expect(defaultKey).not.toBe(neverKey);
    expect(defaultKey).not.toBe(absoluteKey);
    expect(neverKey).not.toBe(absoluteKey);
  });
});
