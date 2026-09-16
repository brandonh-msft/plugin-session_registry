import { randomUUID } from "node:crypto";

/**
 * Session is the immutable, owner-published snapshot of an agent coding
 * session (BASE-R1, R6, R7). Transcript/artifact/resumable-bundle content
 * never lives in this model or in Postgres — it lives only in Blob Storage,
 * referenced here by pointer (container + blob key). This is a deliberate
 * structural choice (see Key Technical Decisions in the plan), not just a
 * convention: `BlobPointer` intentionally has no field capable of holding
 * raw bytes or long text, so a session's metadata row can never balloon
 * with inlined content, and `createSession` runtime-validates pointer shape
 * as defense-in-depth against callers that bypass the type system (e.g.
 * deserializing an untyped DB row).
 */

export interface BlobPointer {
  readonly containerName: string;
  readonly blobKey: string;
}

export interface HarnessIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Present once a session already published with active links is later
 * matched by a known-bad-content list update (BASE-R30). This is a
 * terminal state: it does not reactivate, and every link on the session
 * immediately becomes indistinguishable from BASE-R44's inaccessible-link
 * response. See Unit 4/7 in the plan for the containment workflow that
 * populates this.
 */
export interface ContentBlockedState {
  readonly blockedAt: Date;
  /** known-bad-content list version whose match caused the block. */
  readonly matchedListVersion: string;
}

export interface Session {
  readonly id: string;
  readonly ownerGithubLogin: string;
  /**
   * The identifier the *harness* already uses for this session, supplied
   * by the publishing agent rather than minted here. It is what appears
   * in the public share URL, so a collaborator sees a link that matches
   * the session they were told about instead of an opaque surrogate id.
   *
   * This is deliberately not the primary key: it is only unique per owner
   * among non-superseded snapshots (see `supersededAt`), so two owners can
   * publish the same harness session id without one squatting the other,
   * and every foreign key keeps pointing at the stable `id`.
   */
  readonly harnessSessionId: string;
  readonly createdAt: Date;
  /** Owner-confirmed title, <=120 chars (SUMMARY-R48-R50). */
  readonly title: string;
  /** Owner-confirmed summary, <=500 chars (SUMMARY-R48-R50). */
  readonly summary: string;
  readonly harness: HarnessIdentity;
  readonly transcriptPointer: BlobPointer;
  readonly artifactPointers: readonly BlobPointer[];
  readonly resumableBundlePointer: BlobPointer | null;
  /**
   * known-bad-content list version this snapshot was checked against at
   * publish time (BASE-R30 containment workflow, Unit 4). Used to detect
   * which sessions still need re-evaluation after a list update.
   */
  readonly knownBadContentListVersionChecked: string;
  readonly contentBlocked: ContentBlockedState | null;
  /**
   * Set when the owner republishes the same `harnessSessionId`, making
   * this snapshot no longer the one that harness session id resolves to.
   *
   * The snapshot itself is still immutable — nothing about its content or
   * metadata is rewritten — but it is no longer *current*. Because links
   * follow the harness session id rather than a frozen snapshot id, an
   * already-shared link starts serving the newer snapshot once this is
   * set. That is a deliberate, owner-requested amendment to the original
   * "a link always serves the exact snapshot it was created for" reading
   * of `BASE-R6`/`R7`/`R41`.
   */
  readonly supersededAt: Date | null;
}

export type NewSessionInput = Omit<
  Session,
  "id" | "createdAt" | "contentBlocked" | "supersededAt"
>;

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 500;
const MAX_HARNESS_SESSION_ID_LENGTH = 128;

/**
 * Harness session ids are placed verbatim into a public URL path segment,
 * so the accepted shape is restricted to characters that survive a URL
 * unescaped and cannot be confused for path structure. Requiring an
 * alphanumeric first character additionally rules out `.`/`..` and
 * leading-dash forms.
 */
const HARNESS_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a value is usable as a harness session id: a non-empty,
 * URL-path-safe string of at most 128 characters. Exported so the API's
 * request validation and the MCP server's input schema enforce exactly
 * the same rule as `createSession`, rather than three drifting copies.
 */
export function isValidHarnessSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HARNESS_SESSION_ID_LENGTH &&
    HARNESS_SESSION_ID_PATTERN.test(value)
  );
}

/**
 * Runtime structural guard for BlobPointer. Rejects anything that isn't a
 * plain object with the two expected string fields — in particular,
 * rejects Buffers, typed arrays, and long raw strings that a careless
 * caller might pass in place of a real pointer.
 */
export function isBlobPointer(value: unknown): value is BlobPointer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.containerName === "string" &&
    candidate.containerName.length > 0 &&
    typeof candidate.blobKey === "string" &&
    candidate.blobKey.length > 0 &&
    Object.keys(candidate).length === 2
  );
}

export class InvalidSessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionInputError";
  }
}

/**
 * Constructs a new Session, generating its id/createdAt and validating that
 * every blob-content field is a genuine pointer rather than inlined
 * content. This is the only supported construction path — callers should
 * not build a Session object literal directly, so this validation cannot
 * be bypassed.
 */
export function createSession(
  input: NewSessionInput,
  deps: { now?: () => Date; generateId?: () => string } = {},
): Session {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? defaultGenerateId;

  if (!isValidHarnessSessionId(input.harnessSessionId)) {
    throw new InvalidSessionInputError(
      `harnessSessionId must be 1-${MAX_HARNESS_SESSION_ID_LENGTH} URL-safe chars matching ${HARNESS_SESSION_ID_PATTERN.source}`,
    );
  }
  if (input.title.length === 0 || input.title.length > MAX_TITLE_LENGTH) {
    throw new InvalidSessionInputError(
      `title must be 1-${MAX_TITLE_LENGTH} chars, got ${input.title.length}`,
    );
  }
  if (input.summary.length === 0 || input.summary.length > MAX_SUMMARY_LENGTH) {
    throw new InvalidSessionInputError(
      `summary must be 1-${MAX_SUMMARY_LENGTH} chars, got ${input.summary.length}`,
    );
  }
  if (!isBlobPointer(input.transcriptPointer)) {
    throw new InvalidSessionInputError(
      "transcriptPointer must be a {containerName, blobKey} pointer, not inlined content",
    );
  }
  for (const [index, pointer] of input.artifactPointers.entries()) {
    if (!isBlobPointer(pointer)) {
      throw new InvalidSessionInputError(
        `artifactPointers[${index}] must be a {containerName, blobKey} pointer, not inlined content`,
      );
    }
  }
  if (
    input.resumableBundlePointer !== null &&
    !isBlobPointer(input.resumableBundlePointer)
  ) {
    throw new InvalidSessionInputError(
      "resumableBundlePointer must be a {containerName, blobKey} pointer or null, not inlined content",
    );
  }

  return {
    ...input,
    id: generateId(),
    createdAt: now(),
    contentBlocked: null,
    supersededAt: null,
  };
}

/**
 * Marks a snapshot as no longer the current one for its harness session
 * id, because the owner republished that same harness session id. Like
 * `applyContentBlock` this is a one-way transition: the first supersede
 * timestamp wins, so replaying a republish cannot rewrite history.
 *
 * This never mutates the snapshot's content or metadata — superseding
 * changes only which snapshot a harness session id resolves to.
 */
export function supersedeSession(
  session: Session,
  deps: { now?: () => Date } = {},
): Session {
  if (session.supersededAt !== null) {
    return session;
  }
  const now = deps.now ?? (() => new Date());
  return { ...session, supersededAt: now() };
}

/**
 * Applies the containment transition described in the plan's Unit 4/7:
 * a session already published is later matched by a known-bad-content
 * list update. This is a one-way transition — a session already
 * content-blocked cannot be un-blocked by calling this again.
 */
export function applyContentBlock(
  session: Session,
  matchedListVersion: string,
  deps: { now?: () => Date } = {},
): Session {
  if (session.contentBlocked !== null) {
    return session;
  }
  const now = deps.now ?? (() => new Date());
  return {
    ...session,
    contentBlocked: {
      blockedAt: now(),
      matchedListVersion,
    },
  };
}

function defaultGenerateId(): string {
  return `sess_${randomUUID()}`;
}
