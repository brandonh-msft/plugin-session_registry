/**
 * Finding-resolution logic (BASE-R9): every finding a scan produces must be
 * explicitly resolved as exactly one of accept-redaction, custom-
 * replacement, or false-positive before the owner-approved variant is
 * produced. There is no implicit "ignore" outcome — an unresolved finding
 * blocks `applyResolutions` entirely (see `UnresolvedFindingsError`), which
 * is what makes Unit 2's "fail closed, no partial submission" behavior
 * possible at this layer.
 */

import type { Finding } from "./scanner.js";

export type ResolutionAction =
  | { readonly kind: "accept-redaction" }
  | { readonly kind: "custom-replacement"; readonly replacementText: string }
  | { readonly kind: "false-positive" };

export interface FindingResolution {
  readonly findingIndex: number;
  readonly action: ResolutionAction;
}

const REDACTION_PLACEHOLDER = "[REDACTED]";

export class UnresolvedFindingsError extends Error {
  constructor(public readonly unresolvedIndexes: readonly number[]) {
    super(
      `${unresolvedIndexes.length} finding(s) have no resolution: indexes [${unresolvedIndexes.join(", ")}]`,
    );
    this.name = "UnresolvedFindingsError";
  }
}

/**
 * Applies a complete set of resolutions to the original content, producing
 * the owner-approved variant. Every finding index must have exactly one
 * resolution — this is intentionally strict (BASE-R9 requires each finding
 * to be individually resolved, not bulk-dismissed).
 *
 * false-positive resolutions leave the matched text untouched (the owner
 * has asserted it is not actually sensitive); accept-redaction replaces it
 * with a fixed placeholder; custom-replacement replaces it with owner-
 * supplied text.
 */
export function applyResolutions(
  content: string,
  findings: readonly Finding[],
  resolutions: readonly FindingResolution[],
): string {
  const resolutionByIndex = new Map<number, FindingResolution>();
  for (const resolution of resolutions) {
    resolutionByIndex.set(resolution.findingIndex, resolution);
  }

  const unresolvedIndexes = findings
    .map((_, index) => index)
    .filter((index) => !resolutionByIndex.has(index));
  if (unresolvedIndexes.length > 0) {
    throw new UnresolvedFindingsError(unresolvedIndexes);
  }

  // Apply replacements from the end of the string backward so earlier
  // offsets remain valid as later ones are rewritten.
  const findingsWithResolutions = findings
    .map((finding, index) => ({
      finding,
      resolution: resolutionByIndex.get(index)!,
    }))
    .sort((a, b) => b.finding.offset - a.finding.offset);

  let result = content;
  for (const { finding, resolution } of findingsWithResolutions) {
    const replacement = replacementFor(resolution.action, finding.matchedText);
    result =
      result.slice(0, finding.offset) +
      replacement +
      result.slice(finding.offset + finding.length);
  }
  return result;
}

function replacementFor(action: ResolutionAction, originalText: string): string {
  switch (action.kind) {
    case "accept-redaction":
      return REDACTION_PLACEHOLDER;
    case "custom-replacement":
      return action.replacementText;
    case "false-positive":
      return originalText;
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled resolution action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
