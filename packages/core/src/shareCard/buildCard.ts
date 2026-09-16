/**
 * Builds the copyable Markdown "PR-Ready Share Card" (`PRSC-1`-`R12`) an
 * owner pastes into a pull request description. This module has no
 * opinion on *how* a link's current availability or resumable-bundle
 * presence is determined — those are resolved upstream by the API's
 * `isLinkResolvable`/session checks. `buildShareCard` only turns an
 * already-resolved snapshot into Markdown text, the same
 * way `../summary/generate.ts` only validates already-generated text
 * rather than generating it itself.
 *
 * Deliberately stateless and side-effect-free: called fresh on every
 * retrieval from current link/session state, never cached (`PRSC-7`).
 * Regenerating the card on a later retrieval (e.g. after the owner edits
 * the title/summary) has no effect on Markdown a viewer already copied
 * and pasted elsewhere — that pasted text is now just static content in
 * whatever external system it landed in, entirely outside this module's
 * (or this registry's) control.
 */

export interface ShareCardHarness {
  readonly name: string;
}

export interface ShareCardInput {
  /**
   * Whether the underlying link currently resolves (active, not expired,
   * not revoked, and the session is not content-blocked) — the exact
   * condition `isLinkResolvable` already checks. This module does not
   * re-derive that decision; it only renders based on it
   * (`PRSC-8`).
   */
  readonly linkAvailable: boolean;
  /** The share link's own destination URL — never a protected archive
   * URL, bearer credential, or audience-policy detail (`PRSC-10`-`R11`). */
  readonly linkUrl: string;
  /** Owner-confirmed session title (`SUMMARY-R48`-`R50`), not regenerated
   * here. */
  readonly title: string;
  /** Owner-confirmed session summary, not regenerated here. */
  readonly summary: string;
  readonly harness: ShareCardHarness;
  /** Whether a native resumable bundle is currently attached to the
   * session — drives the conditional "Download & resume" CTA
   * (`PRSC-4`-`R5`). */
  readonly resumableBundleAvailable: boolean;
}

export type ShareCardResult =
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly markdown: string };

/**
 * Renders the card's Markdown for an available link, or signals
 * unavailability for a revoked/expired/deleted-session/inactive one
 * without producing any Markdown to copy (`PRSC-8`).
 */
export function buildShareCard(input: ShareCardInput): ShareCardResult {
  if (!input.linkAvailable) {
    return { kind: "unavailable" };
  }

  const lines: string[] = [
    `### ${input.title}`,
    "",
    input.summary,
    "",
    `[View this session](${input.linkUrl})`,
  ];

  if (input.resumableBundleAvailable) {
    lines.push("", `[Download & resume in ${input.harness.name}](${input.linkUrl})`);
  }

  return { kind: "available", markdown: lines.join("\n") };
}
