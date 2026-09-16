/**
 * Resolves the aliases/slugs an owner types when building an
 * `AudiencePolicy` into GitHub's durable entity identities (`BASE-R20`:
 * "Each selected alias or slug must be resolved to and authorized against
 * the GitHub entity's durable identity; mutable names are retained only
 * for display"). This runs once, at rule-creation/edit time — it is a
 * distinct concern from `./policyEvaluator.ts`'s live per-access
 * membership checks, which re-verify against current GitHub state on
 * every request rather than relying on anything cached here.
 *
 * The resolved durable id is carried alongside the display name so a
 * later GitHub rename of the user/org/team/repo does not silently change
 * who a rule refers to, while the UI can still show a human-readable
 * name.
 */

import type { AudienceRule } from "../models/audiencePolicy.js";

export interface ResolvedGithubUser {
  readonly githubUserId: string;
  readonly login: string;
}

export interface ResolvedGithubOrg {
  readonly githubOrgId: string;
  readonly login: string;
}

export interface ResolvedGithubTeam {
  readonly githubTeamId: string;
  readonly org: ResolvedGithubOrg;
  readonly slug: string;
}

export interface ResolvedGithubRepo {
  readonly githubRepoId: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * Live GitHub lookups this resolver depends on. A real implementation
 * calls the GitHub API; this interface plus fakes keep
 * `resolveAudienceRule` deterministically testable.
 */
export interface GithubEntityResolver {
  resolveUser(login: string): Promise<ResolvedGithubUser | null>;
  resolveOrg(login: string): Promise<ResolvedGithubOrg | null>;
  resolveTeam(githubOrg: string, teamSlug: string): Promise<ResolvedGithubTeam | null>;
  resolveRepo(repoOwner: string, repoName: string): Promise<ResolvedGithubRepo | null>;
}

export class UnresolvableAudienceEntityError extends Error {
  constructor(public readonly rule: AudienceRule, public readonly detail: string) {
    super(`could not resolve audience rule entity: ${detail}`);
    this.name = "UnresolvableAudienceEntityError";
  }
}

/**
 * A rule's resolved entities, keyed by rule type, alongside the original
 * rule. Consumers (e.g. the links route) persist both: the rule itself
 * (for `policyEvaluator`) and this resolution record (for display and for
 * detecting a stale alias/slug on a later edit).
 */
export type ResolvedAudienceRule =
  | { readonly type: "specific-users"; readonly users: readonly ResolvedGithubUser[] }
  | { readonly type: "organization"; readonly org: ResolvedGithubOrg }
  | { readonly type: "repo-collaborators"; readonly repo: ResolvedGithubRepo }
  | { readonly type: "team"; readonly team: ResolvedGithubTeam };

/**
 * Resolves every alias/slug in one rule to its durable GitHub identity.
 * Throws `UnresolvableAudienceEntityError` if any referenced entity
 * cannot currently be found — an owner should not be able to create a
 * rule that refers to nothing (`BASE-R20`).
 */
export async function resolveAudienceRule(
  rule: AudienceRule,
  resolver: GithubEntityResolver,
): Promise<ResolvedAudienceRule> {
  switch (rule.type) {
    case "specific-users": {
      const users = await Promise.all(rule.githubLogins.map((login) => resolver.resolveUser(login)));
      const unresolvedIndex = users.findIndex((user) => user === null);
      if (unresolvedIndex !== -1) {
        throw new UnresolvableAudienceEntityError(
          rule,
          `GitHub user not found: ${rule.githubLogins[unresolvedIndex]}`,
        );
      }
      return { type: "specific-users", users: users as ResolvedGithubUser[] };
    }
    case "organization": {
      const org = await resolver.resolveOrg(rule.githubOrg);
      if (org === null) {
        throw new UnresolvableAudienceEntityError(
          rule,
          `GitHub organization not found: ${rule.githubOrg}`,
        );
      }
      return { type: "organization", org };
    }
    case "team": {
      const team = await resolver.resolveTeam(rule.githubOrg, rule.teamSlug);
      if (team === null) {
        throw new UnresolvableAudienceEntityError(
          rule,
          `GitHub team not found: ${rule.githubOrg}/${rule.teamSlug}`,
        );
      }
      return { type: "team", team };
    }
    case "repo-collaborators": {
      const repo = await resolver.resolveRepo(rule.repoOwner, rule.repoName);
      if (repo === null) {
        throw new UnresolvableAudienceEntityError(
          rule,
          `GitHub repo not found: ${rule.repoOwner}/${rule.repoName}`,
        );
      }
      return { type: "repo-collaborators", repo };
    }
    default:
      // Exhaustiveness is enforced by AudienceRule's discriminant; a
      // future rule type addition will fail to compile here.
      throw new UnresolvableAudienceEntityError(
        rule,
        `unhandled rule type: ${JSON.stringify(rule)}`,
      );
  }
}

/** Resolves every rule in a list, e.g. a whole authenticated policy's rules. */
export async function resolveAudienceRules(
  rules: readonly AudienceRule[],
  resolver: GithubEntityResolver,
): Promise<readonly ResolvedAudienceRule[]> {
  return Promise.all(rules.map((rule) => resolveAudienceRule(rule, resolver)));
}
