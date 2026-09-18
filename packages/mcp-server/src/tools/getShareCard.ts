/**
 * The `get_share_card` MCP tool (PR-Publish Prompt plan, Unit 3). Retrieves
 * the copyable PR-Ready Share Card Markdown for a link the caller already
 * owns, so the PR-publish-prompt skill can embed it directly into a PR
 * body without a separate copy/paste step. This tool has no opinion on
 * *when* to call it or what to do with the result — that policy lives in
 * `plugin/skills/pr-publish-prompt/SKILL.md` (Unit 4).
 *
 * `ShareCardResult` mirrors `@session-registry/server-core`'s
 * `buildShareCard` output exactly: an `"unavailable"` result (revoked,
 * expired, or otherwise not currently resolvable) is a normal, expected
 * outcome, not an error — the caller falls back to plain PR creation
 * without a card (`PRPP-10`/`PRPP-11`).
 */

export interface GetShareCardInput {
  readonly linkId: string;
}

export type ShareCardResult =
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly markdown: string };

export class GetShareCardNotFoundError extends Error {
  constructor(public readonly linkId: string) {
    super(`share link ${linkId} was not found or is not owned by the caller`);
    this.name = "GetShareCardNotFoundError";
  }
}

export class GetShareCardRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`get_share_card request failed with status ${status}: ${detail}`);
    this.name = "GetShareCardRequestFailedError";
  }
}

export class GetShareCardStateUnknownError extends Error {
  constructor(public readonly detail: string) {
    super(`get_share_card response is unknown: ${detail}`);
    this.name = "GetShareCardStateUnknownError";
  }
}

export interface BackendGetShareCardClient {
  getShareCard(linkId: string): Promise<ShareCardResult>;
}

export interface GetShareCardDeps {
  readonly backendClient: BackendGetShareCardClient;
}

export async function getShareCard(
  input: GetShareCardInput,
  deps: GetShareCardDeps,
): Promise<ShareCardResult> {
  return deps.backendClient.getShareCard(input.linkId);
}
