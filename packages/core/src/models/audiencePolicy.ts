/**
 * Audience policy for a ShareLink.
 *
 * A ShareLink's access mode is either anonymous, or authenticated with one
 * or more GitHub-based rules OR-combined together (`BASE-R17`, `R20`).
 * Anonymous and authenticated are mutually exclusive per link — switching
 * between them requires revoke-and-recreate, never an in-place edit
 * (`BASE-R32`). This is modeled as a discriminated union on `accessMode`
 * (with a second, nested discriminated union on each rule's `type`) so
 * that each shape only carries the fields it actually needs, and so that
 * exhaustiveness checking (`assertUnreachable*`) catches any code path
 * that forgets to handle a case.
 */

export type AccessMode = "anonymous" | "authenticated";

export type RuleType =
  | "specific-users"
  | "organization"
  | "repo-collaborators"
  | "team";

/**
 * The minimum qualifying effective repository permission for a
 * repo-collaborators rule (`BASE-R21`), ordered weakest to strongest.
 * Custom roles and permission inherited via a team or organization qualify
 * according to their effective repository permission, not their source.
 */
export type EffectivePermission =
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

export const EFFECTIVE_PERMISSION_RANK: readonly EffectivePermission[] = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
];

export interface SpecificUsersRule {
  readonly type: "specific-users";
  /** GitHub logins (aliases) permitted to access the link. Non-empty. */
  readonly githubLogins: readonly string[];
}

export interface OrganizationRule {
  readonly type: "organization";
  /** GitHub organization login whose members may access the link. */
  readonly githubOrg: string;
}

export interface RepoCollaboratorsRule {
  readonly type: "repo-collaborators";
  /** Owner login of the repo whose collaborators may access the link. */
  readonly repoOwner: string;
  /** Repo name (without owner prefix). */
  readonly repoName: string;
  /** Minimum effective permission a collaborator must hold to qualify. */
  readonly minPermission: EffectivePermission;
}

export interface TeamRule {
  readonly type: "team";
  /** GitHub organization login that owns the team. */
  readonly githubOrg: string;
  /** Team slug within the organization. */
  readonly teamSlug: string;
}

export type AudienceRule =
  | SpecificUsersRule
  | OrganizationRule
  | RepoCollaboratorsRule
  | TeamRule;

export interface AnonymousAudiencePolicy {
  readonly accessMode: "anonymous";
}

export interface AuthenticatedAudiencePolicy {
  readonly accessMode: "authenticated";
  /** One or more GitHub-based rules, OR-combined (`BASE-R20`). Non-empty. */
  readonly rules: readonly AudienceRule[];
}

export type AudiencePolicy =
  | AnonymousAudiencePolicy
  | AuthenticatedAudiencePolicy;

/**
 * Exhaustiveness helper: call this in the `default` branch of a switch over
 * `AudiencePolicy["accessMode"]` so that adding a third access mode in the
 * future produces a compile error at every unhandled call site instead of a
 * silent runtime fallthrough.
 */
export function assertUnreachableAccessMode(policy: never): never {
  throw new Error(
    `Unhandled audience policy access mode: ${JSON.stringify(policy)}`,
  );
}

/**
 * Exhaustiveness helper for the nested `AudienceRule["type"]` union.
 */
export function assertUnreachableRuleType(rule: never): never {
  throw new Error(`Unhandled audience rule type: ${JSON.stringify(rule)}`);
}

/**
 * Structural validation for a single AudienceRule. Intentionally does not
 * call GitHub — that live/cached membership check belongs to Unit 6, not
 * this model. This only validates that the shape is internally consistent
 * (e.g. specific-users has at least one login).
 */
export function isValidAudienceRule(rule: AudienceRule): boolean {
  switch (rule.type) {
    case "specific-users":
      return rule.githubLogins.length > 0;
    case "organization":
      return rule.githubOrg.trim().length > 0;
    case "repo-collaborators":
      return (
        rule.repoOwner.trim().length > 0 &&
        rule.repoName.trim().length > 0 &&
        EFFECTIVE_PERMISSION_RANK.includes(rule.minPermission)
      );
    case "team":
      return (
        rule.githubOrg.trim().length > 0 && rule.teamSlug.trim().length > 0
      );
    default:
      return assertUnreachableRuleType(rule);
  }
}

/**
 * Structural validation for an AudiencePolicy. Intentionally does not call
 * GitHub — that live/cached membership check belongs to Unit 6, not this
 * model. This only validates that the shape is internally consistent (e.g.
 * an authenticated policy has at least one, individually-valid rule).
 */
export function isValidAudiencePolicy(policy: AudiencePolicy): boolean {
  switch (policy.accessMode) {
    case "anonymous":
      return true;
    case "authenticated":
      return (
        policy.rules.length > 0 && policy.rules.every(isValidAudienceRule)
      );
    default:
      return assertUnreachableAccessMode(policy);
  }
}
