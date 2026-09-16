/**
 * Live audience-policy evaluation (`BASE-R20`, `R22`-`R24`, `R31`). This
 * module only decides whether a single, already-identified GitHub viewer
 * satisfies a link's `AudiencePolicy` — it does not itself cache decisions
 * (Unit 6 wraps this with a TTL'd, webhook-invalidated cache) and does not
 * resolve aliases/slugs to durable entity ids (see `./githubResolver.ts`,
 * which runs once at rule-creation time). Every rule here is evaluated
 * against *current* GitHub state, matching `BASE-R23`'s "not captured when
 * the link is created" requirement.
 */

import {
  EFFECTIVE_PERMISSION_RANK,
  assertUnreachableAccessMode,
  assertUnreachableRuleType,
  type AudiencePolicy,
  type AudienceRule,
  type EffectivePermission,
} from "../models/audiencePolicy.js";

export interface ViewerIdentity {
  /** Current GitHub login. Membership checks below re-verify live, so a
   * renamed login is re-resolved by the caller before reaching here. */
  readonly githubLogin: string;
  /**
   * The viewer's GitHub OAuth access token, when the request carried one.
   *
   * Authorization is strictly OAuth-based: there is no GitHub App
   * installation token, so a live membership check can only ask GitHub about
   * *this* viewer, authenticated as them. Checks that need it report
   * `"unverifiable"` when it is absent rather than guessing.
   *
   * Never persisted: `AuthDecisionCacheStore` keys and stores decisions by
   * `githubLogin` only, so this token never reaches the cache.
   */
  readonly accessToken?: string;
}

/**
 * The tri-state result of a single live GitHub membership/permission
 * check. `"unverifiable"` models a transient GitHub-side failure — it must
 * never be treated as a match (`BASE-R24`).
 */
export type MembershipCheckResult = boolean | "unverifiable";

export type RepoPermissionCheckResult = EffectivePermission | "none" | "unverifiable";

/**
 * Live GitHub checks this evaluator depends on. A real implementation
 * calls the GitHub API (directly or via Unit 6's cache); this interface
 * plus fakes keep `evaluateAudiencePolicy` deterministically testable.
 */
export interface GithubMembershipChecks {
  isOrgMember(githubOrg: string, viewer: ViewerIdentity): Promise<MembershipCheckResult>;
  /** Must include descendant-team members, not just direct members (`BASE-R31`). */
  isTeamMember(
    githubOrg: string,
    teamSlug: string,
    viewer: ViewerIdentity,
  ): Promise<MembershipCheckResult>;
  /** Effective permission must account for permission inherited via team/org (`BASE-R21`). */
  getRepoCollaboratorPermission(
    repoOwner: string,
    repoName: string,
    viewer: ViewerIdentity,
  ): Promise<RepoPermissionCheckResult>;
}

export type AuthDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny" }
  /** No rule matched, and at least one potentially-qualifying rule could
   * not be verified — retryable, never a silent allow (`BASE-R24`). */
  | { readonly outcome: "unverifiable" };

function meetsMinPermission(
  actual: EffectivePermission,
  minPermission: EffectivePermission,
): boolean {
  return (
    EFFECTIVE_PERMISSION_RANK.indexOf(actual) >=
    EFFECTIVE_PERMISSION_RANK.indexOf(minPermission)
  );
}

/**
 * Evaluates one rule against the current viewer. Returns `"match"` if the
 * rule is positively satisfied, `"no-match"` if it is verified but not
 * satisfied, or `"unverifiable"` if the underlying GitHub check could not
 * be completed.
 */
async function evaluateRule(
  rule: AudienceRule,
  viewer: ViewerIdentity,
  checks: GithubMembershipChecks,
): Promise<"match" | "no-match" | "unverifiable"> {
  switch (rule.type) {
    case "specific-users":
      return rule.githubLogins.some(
        (login) => login.toLowerCase() === viewer.githubLogin.toLowerCase(),
      )
        ? "match"
        : "no-match";
    case "organization": {
      const result = await checks.isOrgMember(rule.githubOrg, viewer);
      if (result === "unverifiable") return "unverifiable";
      return result ? "match" : "no-match";
    }
    case "team": {
      const result = await checks.isTeamMember(rule.githubOrg, rule.teamSlug, viewer);
      if (result === "unverifiable") return "unverifiable";
      return result ? "match" : "no-match";
    }
    case "repo-collaborators": {
      const result = await checks.getRepoCollaboratorPermission(
        rule.repoOwner,
        rule.repoName,
        viewer,
      );
      if (result === "unverifiable") return "unverifiable";
      if (result === "none") return "no-match";
      return meetsMinPermission(result, rule.minPermission) ? "match" : "no-match";
    }
    default:
      return assertUnreachableRuleType(rule);
  }
}

/**
 * Evaluates a link's `AudiencePolicy` against one viewer. `viewer` must be
 * `null` for anonymous policies (no identity is needed or checked) and
 * non-null for authenticated policies — an authenticated policy evaluated
 * with a `null` viewer always denies (the caller is responsible for first
 * distinguishing a "sign-in required" state per `BASE-R33`; that UX state
 * is not this function's concern).
 *
 * Stops as soon as one rule is positively verified as a match
 * (`BASE-R24`). If no rule matches, denies as unauthorized unless one or
 * more rules were unverifiable, in which case it returns a retryable
 * `"unverifiable"` decision instead of silently allowing or denying.
 */
export async function evaluateAudiencePolicy(
  policy: AudiencePolicy,
  viewer: ViewerIdentity | null,
  checks: GithubMembershipChecks,
): Promise<AuthDecision> {
  switch (policy.accessMode) {
    case "anonymous":
      return { outcome: "allow" };
    case "authenticated": {
      if (viewer === null) {
        return { outcome: "deny" };
      }
      let anyUnverifiable = false;
      for (const rule of policy.rules) {
        const result = await evaluateRule(rule, viewer, checks);
        if (result === "match") {
          return { outcome: "allow" };
        }
        if (result === "unverifiable") {
          anyUnverifiable = true;
        }
      }
      return anyUnverifiable ? { outcome: "unverifiable" } : { outcome: "deny" };
    }
    default:
      return assertUnreachableAccessMode(policy);
  }
}
