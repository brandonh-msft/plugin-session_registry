import { describe, expect, it } from "vitest";
import {
  resolveAudienceRule,
  resolveAudienceRules,
  UnresolvableAudienceEntityError,
  type GithubEntityResolver,
} from "../../src/audience/githubResolver.js";
import type { AudienceRule } from "../../src/models/audiencePolicy.js";

function resolverStub(overrides: Partial<GithubEntityResolver> = {}): GithubEntityResolver {
  return {
    resolveUser: async (login) => ({ githubUserId: `user_${login}`, login }),
    resolveOrg: async (login) => ({ githubOrgId: `org_${login}`, login }),
    resolveTeam: async (githubOrg, slug) => ({
      githubTeamId: `team_${githubOrg}_${slug}`,
      org: { githubOrgId: `org_${githubOrg}`, login: githubOrg },
      slug,
    }),
    resolveRepo: async (owner, name) => ({
      githubRepoId: `repo_${owner}_${name}`,
      owner,
      name,
    }),
    ...overrides,
  };
}

describe("resolveAudienceRule", () => {
  it("resolves every login in a specific-users rule to a durable user id (happy path)", async () => {
    const rule: AudienceRule = { type: "specific-users", githubLogins: ["octocat", "monalisa"] };
    const resolved = await resolveAudienceRule(rule, resolverStub());
    expect(resolved).toEqual({
      type: "specific-users",
      users: [
        { githubUserId: "user_octocat", login: "octocat" },
        { githubUserId: "user_monalisa", login: "monalisa" },
      ],
    });
  });

  it("resolves an organization rule to a durable org id (happy path)", async () => {
    const rule: AudienceRule = { type: "organization", githubOrg: "github" };
    const resolved = await resolveAudienceRule(rule, resolverStub());
    expect(resolved).toEqual({ type: "organization", org: { githubOrgId: "org_github", login: "github" } });
  });

  it("resolves a team rule including its owning org (happy path)", async () => {
    const rule: AudienceRule = { type: "team", githubOrg: "github", teamSlug: "platform" };
    const resolved = await resolveAudienceRule(rule, resolverStub());
    expect(resolved).toEqual({
      type: "team",
      team: {
        githubTeamId: "team_github_platform",
        org: { githubOrgId: "org_github", login: "github" },
        slug: "platform",
      },
    });
  });

  it("resolves a repo-collaborators rule to a durable repo id (happy path)", async () => {
    const rule: AudienceRule = {
      type: "repo-collaborators",
      repoOwner: "github",
      repoName: "sessionregistry",
      minPermission: "write",
    };
    const resolved = await resolveAudienceRule(rule, resolverStub());
    expect(resolved).toEqual({
      type: "repo-collaborators",
      repo: { githubRepoId: "repo_github_sessionregistry", owner: "github", name: "sessionregistry" },
    });
  });

  it("throws when a specific-users login cannot be found (error path)", async () => {
    const rule: AudienceRule = { type: "specific-users", githubLogins: ["ghost"] };
    const resolver = resolverStub({ resolveUser: async () => null });
    await expect(resolveAudienceRule(rule, resolver)).rejects.toThrow(
      UnresolvableAudienceEntityError,
    );
  });

  it("throws when an organization cannot be found (error path)", async () => {
    const rule: AudienceRule = { type: "organization", githubOrg: "ghost-org" };
    const resolver = resolverStub({ resolveOrg: async () => null });
    await expect(resolveAudienceRule(rule, resolver)).rejects.toThrow(
      UnresolvableAudienceEntityError,
    );
  });

  it("throws when a team cannot be found (error path)", async () => {
    const rule: AudienceRule = { type: "team", githubOrg: "github", teamSlug: "ghost-team" };
    const resolver = resolverStub({ resolveTeam: async () => null });
    await expect(resolveAudienceRule(rule, resolver)).rejects.toThrow(
      UnresolvableAudienceEntityError,
    );
  });

  it("throws when a repo cannot be found (error path)", async () => {
    const rule: AudienceRule = {
      type: "repo-collaborators",
      repoOwner: "github",
      repoName: "ghost-repo",
      minPermission: "read",
    };
    const resolver = resolverStub({ resolveRepo: async () => null });
    await expect(resolveAudienceRule(rule, resolver)).rejects.toThrow(
      UnresolvableAudienceEntityError,
    );
  });
});

describe("resolveAudienceRules", () => {
  it("resolves a list of mixed rule types in order (integration)", async () => {
    const rules: AudienceRule[] = [
      { type: "specific-users", githubLogins: ["octocat"] },
      { type: "organization", githubOrg: "github" },
    ];
    const resolved = await resolveAudienceRules(rules, resolverStub());
    expect(resolved.map((r) => r.type)).toEqual(["specific-users", "organization"]);
  });
});
