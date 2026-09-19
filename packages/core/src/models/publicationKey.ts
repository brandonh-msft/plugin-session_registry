import { createHash } from "node:crypto";
import {
  assertUnreachableAccessMode,
  assertUnreachableRuleType,
  type AudiencePolicy,
  type AudienceRule,
} from "./audiencePolicy.js";
import type { ResolutionAction } from "../scanning/resolution.js";
import type { Finding } from "../scanning/scanner.js";

export const PUBLICATION_KEY_VERSION = "v1";
export const PUBLICATION_KEY_PLACEHOLDER_REPLACEMENT = "[REDACTED]";
export const PUBLICATION_KEY_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface OwnerRedaction {
  readonly exactText: string;
  readonly replacementText?: string;
  readonly caseSensitive?: boolean;
}

export type PublicationExpirationChoice = "default" | "never" | Date;

export interface PublicationContentDecision {
  readonly findingId?: string;
  readonly finding: Pick<Finding, "category" | "matchedText">;
  readonly action: ResolutionAction;
}

export interface ComputePublicationKeyInput {
  readonly title: string;
  readonly summary: string;
  readonly audiencePolicy: AudiencePolicy;
  readonly expiresAtChoice: PublicationExpirationChoice;
  readonly ownerRedactions: readonly OwnerRedaction[];
  readonly contentDecisions: readonly PublicationContentDecision[];
}

export function computePublicationKey(input: ComputePublicationKeyInput): string {
  const hash = createHash("sha256");
  const parts = [
    PUBLICATION_KEY_VERSION,
    input.title,
    input.summary,
    canonicalAudiencePolicy(input.audiencePolicy),
    canonicalExpiration(input.expiresAtChoice),
    canonicalRedactions(input.ownerRedactions),
    canonicalContentDecisions(input.contentDecisions),
  ];

  for (const part of parts) {
    hash.update(lengthPrefixed(part), "utf8");
  }
  return hash.digest("hex");
}

export function canonicalAudiencePolicy(policy: AudiencePolicy): string {
  switch (policy.accessMode) {
    case "anonymous":
      return JSON.stringify(["anonymous"]);
    case "authenticated":
      return JSON.stringify([
        "authenticated",
        [...policy.rules].map(canonicalAudienceRule).sort(),
      ]);
    default:
      return assertUnreachableAccessMode(policy);
  }
}

export function canonicalExpiration(
  choice: PublicationExpirationChoice,
): string {
  if (choice === "default" || choice === "never") {
    return choice;
  }
  return choice.toISOString();
}

export function canonicalRedactions(
  redactions: readonly OwnerRedaction[],
): string {
  return JSON.stringify(
    [...redactions]
      .map((redaction) => [
        redaction.exactText,
        redaction.replacementText ?? PUBLICATION_KEY_PLACEHOLDER_REPLACEMENT,
        redaction.caseSensitive ?? false,
      ])
      .sort(compareCanonicalEntries),
  );
}

export function canonicalContentDecisions(
  decisions: readonly PublicationContentDecision[],
): string {
  return JSON.stringify(
    [...decisions]
      .map((decision) => [
        decision.finding.category,
        decision.finding.matchedText,
        decision.action.kind,
        decision.action.kind === "custom-replacement"
          ? decision.action.replacementText
          : null,
      ])
      .sort(compareCanonicalEntries),
  );
}

export function isValidPublicationKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PUBLICATION_KEY_HEX_PATTERN.test(value)
  );
}

function canonicalAudienceRule(rule: AudienceRule): string {
  switch (rule.type) {
    case "specific-users":
      return JSON.stringify([
        "specific-users",
        [...rule.githubLogins].map(normalizeGitHubIdentifier).sort(),
      ]);
    case "organization":
      return JSON.stringify([
        "organization",
        normalizeGitHubIdentifier(rule.githubOrg),
      ]);
    case "repo-collaborators":
      return JSON.stringify([
        "repo-collaborators",
        normalizeGitHubIdentifier(rule.repoOwner),
        normalizeGitHubIdentifier(rule.repoName),
        rule.minPermission,
      ]);
    case "team":
      return JSON.stringify([
        "team",
        normalizeGitHubIdentifier(rule.githubOrg),
        normalizeGitHubIdentifier(rule.teamSlug),
      ]);
    default:
      return assertUnreachableRuleType(rule);
  }
}

function normalizeGitHubIdentifier(value: string): string {
  return value.toLowerCase();
}

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}\u0000`;
}

function compareCanonicalEntries(left: readonly unknown[], right: readonly unknown[]): number {
  const leftKey = JSON.stringify(left);
  const rightKey = JSON.stringify(right);
  return leftKey.localeCompare(rightKey);
}
