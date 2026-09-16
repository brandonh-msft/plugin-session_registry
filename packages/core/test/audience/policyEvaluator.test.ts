import { describe, expect, it } from "vitest";
import {
  evaluateAudiencePolicy,
  type GithubMembershipChecks,
  type ViewerIdentity,
} from "../../src/audience/policyEvaluator.js";
import type { AudiencePolicy } from "../../src/models/audiencePolicy.js";

function checksStub(overrides: Partial<GithubMembershipChecks> = {}): GithubMembershipChecks {
  return {
    isOrgMember: async () => false,
    isTeamMember: async () => false,
    getRepoCollaboratorPermission: async () => "none",
    ...overrides,
  };
}

const octocat: ViewerIdentity = { githubLogin: "octocat" };

describe("evaluateAudiencePolicy", () => {
  it("allows any viewer (including none) for an anonymous policy (happy path)", async () => {
    const policy: AudiencePolicy = { accessMode: "anonymous" };
    await expect(evaluateAudiencePolicy(policy, null, checksStub())).resolves.toEqual({
      outcome: "allow",
    });
    await expect(evaluateAudiencePolicy(policy, octocat, checksStub())).resolves.toEqual({
      outcome: "allow",
    });
  });

  it("grants access to a listed GitHub user and denies an unlisted one (happy path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [{ type: "specific-users", githubLogins: ["octocat"] }],
    };
    await expect(evaluateAudiencePolicy(policy, octocat, checksStub())).resolves.toEqual({
      outcome: "allow",
    });
    await expect(
      evaluateAudiencePolicy(policy, { githubLogin: "monalisa" }, checksStub()),
    ).resolves.toEqual({ outcome: "deny" });
  });

  it("grants access to a current org member (happy path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [{ type: "organization", githubOrg: "github" }],
    };
    const checks = checksStub({ isOrgMember: async () => true });
    await expect(evaluateAudiencePolicy(policy, octocat, checks)).resolves.toEqual({
      outcome: "allow",
    });
  });

  it("respects the configured minimum effective repo permission, including inherited permission (happy path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [
        {
          type: "repo-collaborators",
          repoOwner: "github",
          repoName: "sessionregistry",
          minPermission: "write",
        },
      ],
    };
    const inheritedWrite = checksStub({
      getRepoCollaboratorPermission: async () => "write",
    });
    await expect(evaluateAudiencePolicy(policy, octocat, inheritedWrite)).resolves.toEqual({
      outcome: "allow",
    });

    const readOnly = checksStub({ getRepoCollaboratorPermission: async () => "read" });
    await expect(evaluateAudiencePolicy(policy, octocat, readOnly)).resolves.toEqual({
      outcome: "deny",
    });
  });

  it("includes descendant-team members, not just direct members (happy path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [{ type: "team", githubOrg: "github", teamSlug: "platform" }],
    };
    const checks = checksStub({ isTeamMember: async () => true });
    await expect(evaluateAudiencePolicy(policy, octocat, checks)).resolves.toEqual({
      outcome: "allow",
    });
  });

  it("grants access if either of two OR-combined rules matches (edge case)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [
        { type: "specific-users", githubLogins: ["someone-else"] },
        { type: "organization", githubOrg: "github" },
      ],
    };
    const checks = checksStub({ isOrgMember: async () => true });
    await expect(evaluateAudiencePolicy(policy, octocat, checks)).resolves.toEqual({
      outcome: "allow",
    });
  });

  it("denies with a retryable unverifiable state when no rule matches and one cannot be verified (error path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [{ type: "organization", githubOrg: "github" }],
    };
    const checks = checksStub({ isOrgMember: async () => "unverifiable" });
    await expect(evaluateAudiencePolicy(policy, octocat, checks)).resolves.toEqual({
      outcome: "unverifiable",
    });
  });

  it("denies as unauthorized when every rule is verified and none matches, never falling back to anonymous (error path)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [
        { type: "specific-users", githubLogins: ["someone-else"] },
        { type: "organization", githubOrg: "github" },
      ],
    };
    const checks = checksStub({ isOrgMember: async () => false });
    await expect(evaluateAudiencePolicy(policy, octocat, checks)).resolves.toEqual({
      outcome: "deny",
    });
  });

  it("stops as soon as one rule is positively verified, without evaluating later rules (edge case)", async () => {
    let laterRuleEvaluated = false;
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [
        { type: "specific-users", githubLogins: ["octocat"] },
        { type: "organization", githubOrg: "github" },
      ],
    };
    const checks = checksStub({
      isOrgMember: async () => {
        laterRuleEvaluated = true;
        return true;
      },
    });
    await evaluateAudiencePolicy(policy, octocat, checks);
    expect(laterRuleEvaluated).toBe(false);
  });

  it("denies an authenticated policy when no viewer identity is present (edge case)", async () => {
    const policy: AudiencePolicy = {
      accessMode: "authenticated",
      rules: [{ type: "specific-users", githubLogins: ["octocat"] }],
    };
    await expect(evaluateAudiencePolicy(policy, null, checksStub())).resolves.toEqual({
      outcome: "deny",
    });
  });
});
