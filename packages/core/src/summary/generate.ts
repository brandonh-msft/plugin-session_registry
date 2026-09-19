/**
 * Auto-generated title/summary generation with length validation
 * (`SUMMARY-R48`-`R60`, superseding the retired `BASE-R18` per-link
 * description).
 *
 * This module deliberately has no opinion on *how* the title/summary text
 * is produced — the actual generation is the publishing agent's own model
 * call (Key Technical Decisions), which is an integration detail owned by
 * the MCP server / harness, not this module. `generateTitleAndSummary`
 * takes that model call as an injected `TitleSummaryGenerator` and is
 * responsible only for the one thing that is this module's concern:
 * enforcing that the result is well-formed (non-empty, within the length
 * limits) before it is allowed anywhere near the scan-then-confirm flow in
 * `packages/mcp-server/src/tools/publish.ts`.
 */

export const TITLE_MAX_LENGTH = 120;
export const SUMMARY_MAX_LENGTH = 500;

export interface GeneratedSummary {
  readonly title: string;
  readonly summary: string;
}

export type TitleSummaryGenerator = () => Promise<GeneratedSummary>;

export class SummaryGenerationOutOfBoundsError extends Error {
  constructor(public readonly reason: string) {
    super(`generated title/summary is invalid: ${reason}`);
    this.name = "SummaryGenerationOutOfBoundsError";
  }
}

/**
 * Invokes the injected generator and validates its output. Throws
 * `SummaryGenerationOutOfBoundsError` (rather than silently truncating or
 * publishing empty fields) if the title or summary is empty/whitespace-only
 * or exceeds its length limit.
 */
export async function generateTitleAndSummary(
  generate: TitleSummaryGenerator,
): Promise<GeneratedSummary> {
  const result = await generate();

  if (result.title.trim().length === 0) {
    throw new SummaryGenerationOutOfBoundsError("title is empty");
  }
  if (result.title.length > TITLE_MAX_LENGTH) {
    throw new SummaryGenerationOutOfBoundsError(
      `title exceeds ${TITLE_MAX_LENGTH} characters (got ${result.title.length})`,
    );
  }
  if (result.summary.trim().length === 0) {
    throw new SummaryGenerationOutOfBoundsError("summary is empty");
  }
  if (result.summary.length > SUMMARY_MAX_LENGTH) {
    throw new SummaryGenerationOutOfBoundsError(
      `summary exceeds ${SUMMARY_MAX_LENGTH} characters (got ${result.summary.length})`,
    );
  }

  return result;
}
