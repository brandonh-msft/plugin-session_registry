/**
 * Post-publish title/summary edit path (`SUMMARY-R55`/`R56`). This is the
 * *trusted, unscanned* path by deliberate design: unlike the publish-time
 * generation flow in `./publish.ts`, an owner-typed edit here never goes
 * through the scanner. It is gated only by a single-use confirmation token
 * (the `BASE-R16` pattern), which proves the caller is the session owner
 * acting deliberately — not a substitute for content safety scanning, and
 * not meant to be one.
 *
 * This applies uniformly whether the edit is triggered via a later MCP
 * call (this module) or the web app (Unit 8) — both paths funnel through
 * the same trusted, unscanned semantics.
 */

export interface EditSessionSummaryInput {
  readonly sessionId: string;
  readonly confirmationToken: string;
  readonly title: string;
  readonly summary: string;
}

/**
 * Persists a session's title/summary. Deliberately does not scan `title`
 * or `summary` — see the module doc comment for why that is correct here.
 */
export interface SummaryStore {
  setSummary(
    sessionId: string,
    summary: { title: string; summary: string },
  ): Promise<void>;
}

/**
 * Validates and consumes a single-use confirmation token for a post-publish
 * summary edit (the `BASE-R16` pattern). Returns false for a missing,
 * already-consumed, or otherwise invalid token — the caller must reject the
 * edit in that case rather than proceeding.
 */
export type ConfirmationTokenConsumer = (
  sessionId: string,
  token: string,
) => Promise<boolean>;

export class InvalidConfirmationTokenError extends Error {
  constructor() {
    super("confirmation token is missing, invalid, or already used");
    this.name = "InvalidConfirmationTokenError";
  }
}

export interface EditSessionSummaryDeps {
  readonly store: SummaryStore;
  readonly consumeConfirmationToken: ConfirmationTokenConsumer;
}

/**
 * Executes the post-publish title/summary edit. Throws
 * `InvalidConfirmationTokenError` without persisting anything if the token
 * cannot be validated/consumed. On success, persists the new title/summary
 * verbatim — no scanning is performed on this path (`SUMMARY-R56`).
 */
export async function editSessionSummary(
  input: EditSessionSummaryInput,
  deps: EditSessionSummaryDeps,
): Promise<void> {
  const tokenIsValid = await deps.consumeConfirmationToken(
    input.sessionId,
    input.confirmationToken,
  );
  if (!tokenIsValid) {
    throw new InvalidConfirmationTokenError();
  }

  await deps.store.setSummary(input.sessionId, {
    title: input.title,
    summary: input.summary,
  });
}
