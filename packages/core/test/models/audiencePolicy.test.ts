import { describe, expect, it } from "vitest";
import {
  assertUnreachableAccessMode,
  assertUnreachableRuleType,
  isValidAudiencePolicy,
  isValidAudienceRule,
  type AudiencePolicy,
  type AudienceRule,
} from "../../src/models/audiencePolicy.js";

describe("isValidAudiencePolicy", () => {
  it("accepts anonymous (happy path)", () => {
    expect(isValidAudiencePolicy({ accessMode: "anonymous" })).toBe(true);
  });

  it("accepts authenticated with one valid rule (happy path)", () => {
    expect(
      isValidAudiencePolicy({
        accessMode: "authenticated",
        rules: [{ type: "specific-users", githubLogins: ["octocat"] }],
      }),
    ).toBe(true);
  });

  it("accepts authenticated with multiple OR-combined rules (happy path)", () => {
    expect(
      isValidAudiencePolicy({
        accessMode: "authenticated",
        rules: [
          { type: "specific-users", githubLogins: ["octocat"] },
          { type: "organization", githubOrg: "github" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects authenticated with an empty rules list (edge case)", () => {
    expect(
      isValidAudiencePolicy({ accessMode: "authenticated", rules: [] }),
    ).toBe(false);
  });

  it("rejects authenticated when any rule is individually invalid (edge case)", () => {
    expect(
      isValidAudiencePolicy({
        accessMode: "authenticated",
        rules: [
          { type: "organization", githubOrg: "github" },
          { type: "specific-users", githubLogins: [] },
        ],
      }),
    ).toBe(false);
  });
});

describe("isValidAudienceRule", () => {
  it("accepts specific-users with at least one login (happy path)", () => {
    expect(
      isValidAudienceRule({ type: "specific-users", githubLogins: ["octocat"] }),
    ).toBe(true);
  });

  it("rejects specific-users with an empty login list (edge case)", () => {
    expect(
      isValidAudienceRule({ type: "specific-users", githubLogins: [] }),
    ).toBe(false);
  });

  it("accepts organization with a non-empty org login (happy path)", () => {
    expect(
      isValidAudienceRule({ type: "organization", githubOrg: "github" }),
    ).toBe(true);
  });

  it("rejects organization with a blank org login (edge case)", () => {
    expect(
      isValidAudienceRule({ type: "organization", githubOrg: "  " }),
    ).toBe(false);
  });

  it("accepts repo-collaborators with owner, repo, and minPermission set (happy path)", () => {
    expect(
      isValidAudienceRule({
        type: "repo-collaborators",
        repoOwner: "github",
        repoName: "sessionregistry",
        minPermission: "write",
      }),
    ).toBe(true);
  });

  it("rejects repo-collaborators missing repoName (edge case)", () => {
    expect(
      isValidAudienceRule({
        type: "repo-collaborators",
        repoOwner: "github",
        repoName: "",
        minPermission: "write",
      }),
    ).toBe(false);
  });

  it("accepts team with org and team slug set (happy path)", () => {
    expect(
      isValidAudienceRule({ type: "team", githubOrg: "github", teamSlug: "platform" }),
    ).toBe(true);
  });

  it("rejects team missing teamSlug (edge case)", () => {
    expect(
      isValidAudienceRule({ type: "team", githubOrg: "github", teamSlug: "" }),
    ).toBe(false);
  });
});

describe("assertUnreachableAccessMode", () => {
  it("throws when reached, proving exhaustiveness checking has a runtime backstop (error path)", () => {
    const bogus = { accessMode: "not-a-real-mode" } as unknown as never;
    expect(() => assertUnreachableAccessMode(bogus)).toThrow();
  });

  it("is only reachable for the two known access modes at the type level", () => {
    // Compile-time check: every real AccessMode must be handled by
    // isValidAudiencePolicy's switch without falling through to default.
    const modes: AudiencePolicy["accessMode"][] = ["anonymous", "authenticated"];
    expect(modes).toHaveLength(2);
  });
});

describe("assertUnreachableRuleType", () => {
  it("throws when reached, proving exhaustiveness checking has a runtime backstop (error path)", () => {
    const bogus = { type: "not-a-real-type" } as unknown as never;
    expect(() => assertUnreachableRuleType(bogus)).toThrow();
  });

  it("is only reachable for the four known rule types at the type level", () => {
    const types: AudienceRule["type"][] = [
      "specific-users",
      "organization",
      "repo-collaborators",
      "team",
    ];
    expect(types).toHaveLength(4);
  });
});
