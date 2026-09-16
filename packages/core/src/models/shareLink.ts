import { randomUUID } from "node:crypto";
import {
  type AudiencePolicy,
  isValidAudiencePolicy,
} from "./audiencePolicy.js";

/**
 * A ShareLink is a revocable pointer to a Session under one AudiencePolicy
 * (BASE-R14-R26). Unlike Session, a ShareLink is mutable in specific,
 * narrow ways: it can be revoked, and its expiration can be read, but its
 * `sessionId` and `audiencePolicy` are fixed at creation. There is
 * deliberately no per-link description field here — title/summary are
 * session-scoped (SUMMARY-R53/R60, see plan's Key Technical Decisions) and
 * shared across every link on a session, so no parallel per-link
 * description exists to fall out of sync.
 */
export interface ShareLink {
  readonly id: string;
  readonly sessionId: string;
  readonly audiencePolicy: AudiencePolicy;
  readonly createdAt: Date;
  /** null means no expiration was set (BASE-R14 default handling applies upstream). */
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export type NewShareLinkInput = Omit<
  ShareLink,
  "id" | "createdAt" | "revokedAt"
>;

export class InvalidShareLinkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidShareLinkInputError";
  }
}

export function createShareLink(
  input: NewShareLinkInput,
  deps: { now?: () => Date; generateId?: () => string } = {},
): ShareLink {
  if (!isValidAudiencePolicy(input.audiencePolicy)) {
    throw new InvalidShareLinkInputError(
      `audiencePolicy is structurally invalid: ${JSON.stringify(input.audiencePolicy)}`,
    );
  }
  const now = deps.now ?? (() => new Date());
  if (input.expiresAt !== null && input.expiresAt.getTime() <= now().getTime()) {
    throw new InvalidShareLinkInputError(
      "expiresAt must be in the future when provided",
    );
  }

  const generateId = deps.generateId ?? (() => `link_${randomUUID()}`);
  return {
    ...input,
    id: generateId(),
    createdAt: now(),
    revokedAt: null,
  };
}

/** Revocation is one-way: revoking an already-revoked link is a no-op. */
export function revokeShareLink(
  link: ShareLink,
  deps: { now?: () => Date } = {},
): ShareLink {
  if (link.revokedAt !== null) {
    return link;
  }
  const now = deps.now ?? (() => new Date());
  return { ...link, revokedAt: now() };
}

/**
 * Access-status evaluation for a link *by itself* — this intentionally
 * does not evaluate audience membership (that is Unit 6's live/cached
 * GitHub authorization check) or the owning session's content-blocked
 * state (that is evaluated against the Session, not the link, since it is
 * session-scoped). This only covers the link's own revoked/expired
 * lifecycle (BASE-R44).
 */
export function isShareLinkActive(
  link: ShareLink,
  deps: { now?: () => Date } = {},
): boolean {
  const now = deps.now ?? (() => new Date());
  if (link.revokedAt !== null) {
    return false;
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now().getTime()) {
    return false;
  }
  return true;
}
