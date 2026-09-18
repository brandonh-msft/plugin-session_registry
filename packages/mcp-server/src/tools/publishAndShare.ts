/**
 * The combined publish-and-share MCP verb (`PUBLISH-R48`-`R58`, amended
 * per the plan's Key Technical Decisions). Wraps `./publish.ts`'s
 * client-side scan-then-submit flow (Unit 2/3) and, in the same
 * server-side call, creates the session's first share link — so a
 * developer goes from a locally-scanned session to a live, correctly
 * scoped share link in one MCP call, without a separate `create_link`
 * round trip.
 *
 * The separate publish-only verb (`./publish.ts`'s `publishSession`) is
 * retained unchanged — this module composes it rather than replacing it.
 *
 * Unlike the origin requirements document's "pending link" design, there
 * is no unresolved-review-activation path here: because scanning happens
 * client-side (Unit 2/3), nothing unresolved ever reaches the server, so
 * no link is ever created in a not-yet-active state. The only remaining
 * server-side lifecycle concern is a *session* transitioning to
 * `content-blocked` sometime after publish (`packages/core/src/models/session.ts`),
 * which the registry API rejects for any
 * *new* link — irrelevant to this verb's own atomic publish+link call,
 * since that call either fully succeeds or never creates either half.
 */

import type { AudiencePolicy } from "@session-registry/core";
import { isValidAudiencePolicy } from "@session-registry/core";
import {
  publishSession,
  type PublishSessionInput,
  type PublishSessionDeps,
  type PublishSubmission,
} from "./publish.js";

/** Deliberate exception to `BASE-R14`'s 30-day default, scoped to this verb only (`PUBLISH-R50`). */
export const DEFAULT_SHARE_LINK_EXPIRATION_DAYS = 14;

export interface ShareLinkRequest {
  /**
   * Required and carries the access mode itself (`AudiencePolicy.accessMode`)
   * at this internal boundary. The MCP handler applies its Anyone default
   * before calling this function; an authenticated policy with a missing or
   * invalid audience must still fail rather than fall back to anonymous.
   */
  readonly audiencePolicy: AudiencePolicy;
  /** Omit to apply the 14-day default (`PUBLISH-R50`); pass `null` for no expiration. */
  readonly expiresAt?: Date | null;
}

export interface PublishAndShareInput extends PublishSessionInput {
  readonly publicationKey: string;
  readonly share: ShareLinkRequest;
  /**
   * Binds this call to a single confirmed request (`PUBLISH-R54`): the
   * combined confirmation the owner approves is keyed by this value, and
   * retrying with the *same* key must return the original result rather
   * than creating a duplicate session or link. The real value is the
   * harness's confirmation token; generating one is out of scope here.
   */
  readonly idempotencyKey: string;
}

export interface PublishAndShareResult {
  readonly sessionId: string;
  /** The harness-supplied identifier the session is filed under, and the first path segment of `shareUrl`. */
  readonly harnessSessionId: string;
  readonly linkId: string;
  readonly shareUrl: string;
  readonly idempotentReplay: boolean;
}

/**
 * Thrown when `share.audiencePolicy` is missing its access mode or is
 * otherwise structurally invalid (e.g. an authenticated policy with no
 * rules) — deliberately not corrected or defaulted (`PUBLISH-R49`).
 */
export class InvalidShareRequestError extends Error {
  constructor() {
    super(
      "share.audiencePolicy is missing or invalid — access mode has no default and must be explicit",
    );
    this.name = "InvalidShareRequestError";
  }
}

/**
 * The server-side counterpart this verb talks to. Publishing the
 * submission and creating its first link is modeled as a single atomic
 * operation (not two separable calls) precisely so a mid-flight failure
 * — including a malicious-content rejection (`BASE-R30`, Unit 4) — can
 * never leave an orphaned published session with no link, or a link
 * pointing at a session that was never actually published.
 * `idempotencyKey` lets a retry of the exact same confirmed request
 * return the original result instead of creating a duplicate
 * (`PUBLISH-R54`).
 */
export interface BackendPublishAndShareClient {
  submitAndCreateLink(
    submission: PublishSubmission,
    share: ShareLinkRequest,
    idempotencyKey: string,
    publicationKey: string,
  ): Promise<PublishAndShareResult>;
}

export interface PublishAndShareDeps
  extends Omit<PublishSessionDeps, "backendClient"> {
  readonly backendClient: BackendPublishAndShareClient;
  /** Defaults to `() => new Date()`. Overridable so the 14-day default is deterministic in tests. */
  readonly now?: () => Date;
}

/**
 * Runs the full scan-then-submit flow (`./publish.ts`'s `publishSession`)
 * and, in the same call, creates the session's first share link.
 * Validates `input.share.audiencePolicy` and normalizes the expiration
 * (14-day default when omitted) *before* anything is scanned or
 * submitted, so an invalid share request fails fast without ever
 * touching the scan/confirm flow.
 */
export async function publishAndShareSession(
  input: PublishAndShareInput,
  deps: PublishAndShareDeps,
): Promise<PublishAndShareResult> {
  if (!isValidAudiencePolicy(input.share.audiencePolicy)) {
    throw new InvalidShareRequestError();
  }

  const now = deps.now ?? (() => new Date());
  const expiresAt =
    input.share.expiresAt === undefined
      ? addDays(now(), DEFAULT_SHARE_LINK_EXPIRATION_DAYS)
      : input.share.expiresAt;
  const shareRequest: ShareLinkRequest = {
    audiencePolicy: input.share.audiencePolicy,
    expiresAt,
  };

  let result: PublishAndShareResult | undefined;
  const combinedBackendClient = {
    async submitToBackend(
      submission: PublishSubmission,
    ): Promise<{ sessionId: string }> {
      result = await deps.backendClient.submitAndCreateLink(
        submission,
        shareRequest,
        input.idempotencyKey,
        input.publicationKey,
      );
      return { sessionId: result.sessionId };
    },
  };

  await publishSession(input, { ...deps, backendClient: combinedBackendClient });

  // publishSession only ever returns after combinedBackendClient.submitToBackend
  // resolved successfully, so `result` is always set here.
  return result!;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
