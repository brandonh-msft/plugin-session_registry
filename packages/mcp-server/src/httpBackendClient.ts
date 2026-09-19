/**
 * The real HTTP `BackendPublishAndShareClient`, replacing the placeholder that
 * threw "not yet implemented". Talks to the registry API's atomic
 * `POST /api/sessions:publishAndShare` endpoint.
 *
 * Two things this file has to reconcile:
 *
 * 1. **Content vs. pointers.** A `PublishSubmission` carries the redacted
 *    transcript and artifacts as *content*, but the publish API accepts blob
 *    *pointers* — large payloads are meant to go to Blob Storage directly
 *    rather than through the API. Bridging that is `ContentUploader`'s job,
 *    kept as an injected seam because how a locally-running MCP server obtains
 *    write access to storage is a genuine unresolved architectural decision
 *    (see the note on `ContentUploader`).
 *
 * 2. **Atomicity.** Publishing and link creation are one server-side call, so
 *    an interrupted publish cannot strand a session without a link. This
 *    client therefore never falls back to calling `POST /api/sessions` and
 *    `POST /api/links` separately, even though both exist.
 *
 * Uploads happen *before* the publish call, so a failed upload aborts without
 * having created anything server-side. The reverse ordering would risk a
 * published session pointing at blobs that were never written.
 */

import {
  buildNativeSessionPublication, hasNativeSessionBundle, NativeSessionArchiveError,
  parseNativeSessionArchive, parseNativeSessionArchiveView,
} from "@session-registry/core";
import type { PublishSubmission } from "./tools/publish.js";
import type {
  BackendPublishAndShareClient,
  PublishAndShareResult,
  ShareLinkRequest,
} from "./tools/publishAndShare.js";
import {
  DeleteSessionNotCurrentPublicationError,
  DeleteSessionNotFoundError,
  DeleteSessionRequestFailedError,
  DeleteSessionStateUnknownError,
  type BackendDeleteSessionClient,
  type DeleteSessionResult,
} from "./tools/deleteSession.js";
import {
  RestoreSessionNotCurrentPublicationError,
  RestoreSessionNotFoundError,
  RestoreSessionRequestFailedError,
  RestoreSessionStateUnknownError,
  type BackendRestoreSessionClient,
  type RestoreSessionResult,
} from "./tools/restoreSession.js";
import {
  PurgeSessionNotCurrentPublicationError,
  PurgeSessionNotFoundError,
  PurgeSessionNotTombstonedError,
  PurgeSessionRequestFailedError,
  PurgeSessionStateUnknownError,
  type BackendPurgeSessionClient,
  type PurgeSessionResult,
} from "./tools/purgeSession.js";
import type {
  BackendListTombstonedSessionsClient,
  ListTombstonedSessionsResult,
} from "./tools/purgeSessions.js";
import {
  GetShareCardNotFoundError,
  GetShareCardRequestFailedError,
  GetShareCardStateUnknownError,
  type BackendGetShareCardClient,
  type ShareCardResult,
} from "./tools/getShareCard.js";

export interface BlobPointer {
  readonly containerName: string;
  readonly blobKey: string;
}

/** Which content role the blob plays. The API maps this to a container. */
export type UploadKind = "transcript" | "artifact" | "resumable-bundle";

/**
 * Uploads already-redacted content and returns the pointer it was written to.
 *
 * `kind` is part of the contract because the destination container is a
 * server-side decision keyed off it — a transcript and an artifact do not live
 * together. The uploader never chooses a blob key; the backend assigns one, so
 * a compromised client cannot target another session's blob.
 *
 * The production implementation is `createSasContentUploader`, which exchanges
 * this call for a short-lived, single-blob-scoped, create-only SAS URL and
 * writes directly to Blob Storage — content never transits the API, which
 * Container Apps caps at 4 MB.
 */
export interface ContentUploader {
  upload(
    content: string | Uint8Array,
    contentType: string,
    kind: UploadKind,
  ): Promise<BlobPointer>;
}

export class PublishRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`publish request failed with status ${status}: ${detail}`);
    this.name = "PublishRequestFailedError";
  }
}

export class PublishStateUnknownError extends Error {
  constructor(public readonly detail: string) {
    super(`publish state is unknown: ${detail}`);
    this.name = "PublishStateUnknownError";
  }
}

export interface HttpBackendClientOptions {
  /** Base URL of the hosted registry API, e.g. `https://registry.example.com`. */
  readonly baseUrl: string;
  /**
   * Supplies the publisher's registry token, or `null` when this machine has
   * not published yet.
   *
   * `null` is only meaningful on the publish endpoint, which mints a token as
   * part of a first publish. Every other endpoint operates on already-owned
   * sessions, so reaching one without a token is a caller error rather than a
   * state the server can resolve.
   */
  readonly getAccessToken: () => Promise<string | null>;
  /**
   * Called after the server mints a publisher token so the caller can persist
   * it. A first publish is the only moment this value is ever available, so a
   * failure to store it is unrecoverable and must propagate rather than be
   * swallowed.
   */
  readonly onPublisherTokenIssued?: (token: string) => Promise<void>;
  /**
   * Supplies a GitHub user token, invoked *only* when the share request
   * restricts its audience to GitHub users, teams, or organizations.
   *
   * Keeping this lazy is the point: an unrestricted publisher is never asked
   * for GitHub credentials, and no GitHub token is obtained or transmitted
   * for a publication that has no GitHub dimension at all.
   */
  readonly getGithubToken?: () => Promise<string>;
  readonly uploader: ContentUploader;
  /** Overridable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Overridable for tests. Defaults to a real `setTimeout`-based delay.
   * Used only between retries of a network-level publish failure below.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Header carrying the GitHub user token for a restricted publish.
 *
 * It is a header rather than a body field so it cannot be captured by
 * request-body logging or persisted inside an idempotency record; it is a
 * transient credential belonging to a single request.
 */
export const GITHUB_TOKEN_HEADER = "x-github-token";

/**
 * True when a share request names GitHub principals and therefore needs a
 * GitHub token to resolve them.
 */
export function requiresGithubToken(audiencePolicy: {
  readonly accessMode?: string;
}): boolean {
  return audiencePolicy.accessMode === "authenticated";
}

/**
 * The production API scales to zero when idle (Container Apps `minReplicas:
 * 0`), so a request after idling can race an in-progress cold start: the
 * connection is refused or reset before the new replica is ready, which
 * `fetch` surfaces as a thrown network error rather than an HTTP response.
 * `idempotencyKey` makes retrying this exact call safe (`PUBLISH-R54`), so
 * on that specific failure mode this client retries with backoff itself
 * rather than surfacing an immediate, likely-to-recur `PublishStateUnknownError`
 * to the caller. A non-2xx HTTP response is a real answer from a live server
 * and is never retried here.
 */
const COLD_START_RETRY_DELAYS_MS = [2000, 4000, 8000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PublishAndShareResponseBody {
  readonly sessionId?: string;
  readonly harnessSessionId?: string;
  readonly linkId?: string;
  readonly shareUrl?: string;
  readonly idempotentReplay?: boolean;
  /** Present only on a first publish, which is the only time one is minted. */
  readonly publisherToken?: string;
  readonly error?: string;
}

interface ShareCardResponseBody {
  readonly kind?: string;
  readonly markdown?: string;
  readonly error?: string;
}

interface SessionLifecycleResponseBody {
  readonly sessionId?: string;
  readonly outcome?: string;
  readonly blobResults?: readonly {
    readonly pointer?: BlobPointer;
    readonly outcome?: string;
    readonly detail?: string;
  }[];
  readonly sessions?: readonly {
    readonly sessionId?: string;
    readonly harnessSessionId?: string;
    readonly title?: string;
    readonly deletedAt?: string;
  }[];
  readonly error?: string;
}

interface JsonResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly statusText: string;
  json(): Promise<unknown>;
}

type JsonFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
) => Promise<JsonResponseLike>;

export function createHttpBackendClient(
  options: HttpBackendClientOptions,
) : BackendPublishAndShareClient &
  BackendDeleteSessionClient &
  BackendRestoreSessionClient &
  BackendPurgeSessionClient &
  BackendListTombstonedSessionsClient &
  BackendGetShareCardClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const publishAndShareEndpoint = `${baseUrl}/api/sessions:publishAndShare`;

  return {
    async submitAndCreateLink(
      submission: PublishSubmission,
      share: ShareLinkRequest,
      idempotencyKey: string,
      publicationKey: string,
    ): Promise<PublishAndShareResult> {
      if (parseNativeSessionArchiveView(submission.transcript) !== null) {
        throw new NativeSessionArchiveError("A readable projection is not a native publication source. Use the complete owner-approved capture.");
      }
      const archive = parseNativeSessionArchive(submission.transcript);
      if (archive === null) {
        throw new NativeSessionArchiveError("A native session archive is required. Use the complete owner-approved capture.");
      }
      const native = hasNativeSessionBundle(archive)
        ? buildNativeSessionPublication(archive)
        : null;
      const transcriptPointer = await options.uploader.upload(
        native?.content ?? submission.transcript,
        "application/json; charset=utf-8",
        "transcript",
      );
      const artifactPointers: BlobPointer[] = [];
      for (const artifact of submission.artifacts) {
        artifactPointers.push(
          await options.uploader.upload(
            artifact.content,
            "application/octet-stream",
            "artifact",
          ),
        );
      }
      const resumableBundlePointer = native === null ? null : await options.uploader.upload(
        native.bundle, "application/zip", "resumable-bundle",
      );

      const token = await options.getAccessToken();
      // Obtained only for a restricted audience, and only once the upload has
      // succeeded, so an unrestricted publish never touches GitHub and a
      // publish that was going to fail anyway never prompts for credentials.
      const githubToken = requiresGithubToken(share.audiencePolicy)
        ? await requireGithubToken(options.getGithubToken)
        : null;
      const publishHeaders: Record<string, string> = {
        "content-type": "application/json",
        // Omitted entirely on a first publish. A blank or placeholder bearer
        // value would read as a malformed credential and be rejected, rather
        // than as the absence of one that the server is expected to mint.
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(githubToken === null ? {} : { [GITHUB_TOKEN_HEADER]: githubToken }),
      };
      let response: Response | undefined;

      for (let attempt = 0; attempt <= COLD_START_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          const delayMs = COLD_START_RETRY_DELAYS_MS[attempt - 1];
          if (delayMs !== undefined) {
            await sleep(delayMs);
          }
        }
        try {

        response = await doFetch(publishAndShareEndpoint, {
        method: "POST",
        headers: publishHeaders,
        body: JSON.stringify({
          harnessSessionId: submission.harnessSessionId,
          title: submission.title,
          summary: submission.summary,
          harness: submission.harness,
          transcriptPointer,
          artifactPointers,
          resumableBundlePointer,
          audiencePolicy: share.audiencePolicy,
          // Only sent when the caller was explicit, so the server applies its
          // own 14-day default rather than this client duplicating it.
          ...(share.expiresAt === undefined
            ? {}
            : { expiresAt: share.expiresAt === null ? null : share.expiresAt.toISOString() }),
          idempotencyKey,
          publicationKey,
        }),
        });
          break;
        } catch (error) {
          if (attempt === COLD_START_RETRY_DELAYS_MS.length) {
            throw new PublishStateUnknownError(
              error instanceof Error ? error.message : "request failed",
            );
          }
        }
      }
      if (response === undefined) {
        throw new PublishStateUnknownError("request failed");
      }

      const body = (await response.json().catch(() => ({}))) as PublishAndShareResponseBody;

      if (!response.ok) {
        throw new PublishRequestFailedError(response.status, body.error ?? response.statusText);
      }

      // Persisted before the response is validated, and before it is handed
      // back to the caller. The publication has already happened server-side
      // at this point, so a token that is not stored right now is lost
      // forever, taking with it the publisher's ability to manage everything
      // they just published. Any later rejection is preferable to that.
      if (typeof body.publisherToken === "string" && body.publisherToken.trim() !== "") {
        await options.onPublisherTokenIssued?.(body.publisherToken);
      }

      if (
        typeof body.sessionId !== "string" ||
        typeof body.linkId !== "string" ||
        typeof body.harnessSessionId !== "string" ||
        typeof body.shareUrl !== "string" ||
        typeof body.idempotentReplay !== "boolean"
      ) {
        throw new PublishStateUnknownError(
          "response did not include sessionId, harnessSessionId, linkId, shareUrl, and idempotentReplay",
        );
      }
      if (
        body.sessionId.trim().length === 0 ||
        body.linkId.trim().length === 0 ||
        body.harnessSessionId.trim().length === 0 ||
        body.shareUrl.trim().length === 0
      ) {
        throw new PublishStateUnknownError(
          "response did not include non-empty sessionId, harnessSessionId, linkId, and shareUrl values",
        );
      }
      validateShareUrl(body.shareUrl, body.harnessSessionId, body.linkId);

      // A 200 here means the server replayed a prior result for this
      // idempotency key. That is a success, not an error: it is exactly what
      // `PUBLISH-R54` requires a retry of a confirmed request to return.
      return {
        sessionId: body.sessionId,
        harnessSessionId: body.harnessSessionId,
        linkId: body.linkId,
        shareUrl: body.shareUrl,
        idempotentReplay: body.idempotentReplay,
      };
    },
    async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
      const body = await submitSessionLifecycleRequest(
        `${baseUrl}/api/sessions/delete`,
        sessionId,
        options.getAccessToken,
        doFetch,
        DeleteSessionStateUnknownError,
      );
      if (body.sessionId !== sessionId) {
        throw new DeleteSessionStateUnknownError(
          "response sessionId did not match the requested sessionId",
        );
      }
      if (body.outcome !== "deleted" && body.outcome !== "already_tombstoned") {
        throw new DeleteSessionStateUnknownError(
          "response did not include a valid delete outcome",
        );
      }
      return { sessionId: body.sessionId, outcome: body.outcome };
    },
    async restoreSession(sessionId: string): Promise<RestoreSessionResult> {
      const body = await submitSessionLifecycleRequest(
        `${baseUrl}/api/sessions/restore`,
        sessionId,
        options.getAccessToken,
        doFetch,
        RestoreSessionStateUnknownError,
      );
      if (body.sessionId !== sessionId) {
        throw new RestoreSessionStateUnknownError(
          "response sessionId did not match the requested sessionId",
        );
      }
      if (
        body.outcome !== "restored" &&
        body.outcome !== "already_active" &&
        body.outcome !== "restored_but_content_blocked"
      ) {
        throw new RestoreSessionStateUnknownError(
          "response did not include a valid restore outcome",
        );
      }
      return { sessionId: body.sessionId, outcome: body.outcome };
    },
    async purgeSession(sessionId: string): Promise<PurgeSessionResult> {
      const body = await submitSessionLifecycleRequest(
        `${baseUrl}/api/sessions/purge`,
        sessionId,
        options.getAccessToken,
        doFetch,
        PurgeSessionStateUnknownError,
      );
      if (body.sessionId !== sessionId) {
        throw new PurgeSessionStateUnknownError(
          "response sessionId did not match the requested sessionId",
        );
      }
      if (
        body.outcome !== "purged" &&
        body.outcome !== "purged_with_blob_cleanup_failures"
      ) {
        throw new PurgeSessionStateUnknownError(
          "response did not include a valid purge outcome",
        );
      }
      const blobResults = parsePurgeBlobResults(body.blobResults);
      return { sessionId: body.sessionId, outcome: body.outcome, blobResults };
    },
    async listTombstonedSessions(): Promise<ListTombstonedSessionsResult> {
      return submitListTombstonedSessionsRequest(
        `${baseUrl}/api/sessions/purge-preview`,
        options.getAccessToken,
        doFetch,
      );
    },
    async getShareCard(linkId: string): Promise<ShareCardResult> {
      let response: JsonResponseLike;
      try {
        response = await submitJsonRequest(
          `${baseUrl}/api/links/${encodeURIComponent(linkId)}/share-card`,
          "GET",
          options.getAccessToken,
          doFetch,
        );
      } catch (error) {
        throw new GetShareCardStateUnknownError(
          error instanceof Error ? error.message : "request failed",
        );
      }

      const body = (await response.json().catch(() => ({}))) as ShareCardResponseBody;
      if (response.status === 404) {
        throw new GetShareCardNotFoundError(linkId);
      }
      if (!response.ok) {
        throw new GetShareCardRequestFailedError(response.status, body.error ?? response.statusText);
      }
      if (body.kind === "unavailable") {
        return { kind: "unavailable" };
      }
      if (body.kind === "available" && typeof body.markdown === "string" && body.markdown.trim().length > 0) {
        return { kind: "available", markdown: body.markdown };
      }
      throw new GetShareCardStateUnknownError(
        "response did not include a valid kind and, when available, a non-empty markdown value",
      );
    },
  };
}

async function submitSessionLifecycleRequest(
  endpoint: string,
  sessionId: string,
  getAccessToken: HttpBackendClientOptions["getAccessToken"],
  doFetch: JsonFetch,
  UnknownError: new (detail: string) => Error,
): Promise<SessionLifecycleResponseBody> {
  let response: JsonResponseLike;
  try {
    response = await submitJsonRequest(
      endpoint,
      "POST",
      getAccessToken,
      doFetch,
      { sessionId },
    );
  } catch (error) {
    throw new UnknownError(error instanceof Error ? error.message : "request failed");
  }

  const body = (await response.json().catch(() => ({}))) as SessionLifecycleResponseBody;
  if (response.status === 404) {
    if (endpoint.endsWith("/delete")) {
      throw new DeleteSessionNotFoundError(sessionId);
    }
    if (endpoint.endsWith("/purge")) {
      throw new PurgeSessionNotFoundError(sessionId);
    }
    throw new RestoreSessionNotFoundError(sessionId);
  }
  if (response.status === 409) {
    const detail = body.error ?? response.statusText;
    if (endpoint.endsWith("/delete")) {
      throw new DeleteSessionNotCurrentPublicationError(sessionId, detail);
    }
    if (endpoint.endsWith("/purge")) {
      if (detail.includes("must be tombstoned before it can be purged")) {
        throw new PurgeSessionNotTombstonedError(sessionId, detail);
      }
      throw new PurgeSessionNotCurrentPublicationError(sessionId, detail);
    }
    throw new RestoreSessionNotCurrentPublicationError(sessionId, detail);
  }
  if (!response.ok) {
    const detail = body.error ?? response.statusText;
    if (endpoint.endsWith("/delete")) {
      throw new DeleteSessionRequestFailedError(response.status, detail);
    }
    if (endpoint.endsWith("/purge")) {
      throw new PurgeSessionRequestFailedError(response.status, detail);
    }
    throw new RestoreSessionRequestFailedError(response.status, detail);
  }
  if (typeof body.sessionId !== "string" || typeof body.outcome !== "string") {
    throw new UnknownError("response did not include sessionId and outcome");
  }
  if (body.sessionId.trim().length === 0 || body.outcome.trim().length === 0) {
    throw new UnknownError("response did not include non-empty sessionId and outcome values");
  }
  return body;
}

async function submitListTombstonedSessionsRequest(
  endpoint: string,
  getAccessToken: HttpBackendClientOptions["getAccessToken"],
  doFetch: JsonFetch,
): Promise<ListTombstonedSessionsResult> {
  let response: JsonResponseLike;
  try {
    response = await submitJsonRequest(endpoint, "GET", getAccessToken, doFetch);
  } catch (error) {
    throw new PurgeSessionStateUnknownError(
      error instanceof Error ? error.message : "request failed",
    );
  }

  const body = (await response.json().catch(() => ({}))) as SessionLifecycleResponseBody;
  if (!response.ok) {
    throw new PurgeSessionRequestFailedError(
      response.status,
      body.error ?? response.statusText,
    );
  }
  return {
    sessions: parseTombstonedSessions(body.sessions),
  };
}

/**
 * Raised when a restricted audience was requested but no GitHub token could
 * be obtained. This is a caller-correctable configuration problem, not a
 * server failure, so it is deliberately distinct from
 * `PublishRequestFailedError`.
 */
export class GithubTokenRequiredError extends Error {
  readonly code = "GITHUB_TOKEN_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "GithubTokenRequiredError";
  }
}

async function requireGithubToken(
  getGithubToken: HttpBackendClientOptions["getGithubToken"],
): Promise<string> {
  if (getGithubToken === undefined) {
    throw new GithubTokenRequiredError(
      "Restricting an audience to GitHub users, teams, or organizations requires a GitHub token, " +
        "but this client was not configured to obtain one.",
    );
  }
  const token = (await getGithubToken()).trim();
  if (token === "") {
    throw new GithubTokenRequiredError("No GitHub token was available for a restricted audience.");
  }
  return token;
}

/**
 * Resolves the registry token for an endpoint that cannot mint one.
 *
 * Only the publish endpoint issues credentials. Session lifecycle and share
 * card endpoints act on sessions the caller already owns, so arriving here
 * without a token means nothing has ever been published from this machine —
 * a local state problem, reported as such rather than as a server 401.
 */
async function requireAccessToken(
  getAccessToken: HttpBackendClientOptions["getAccessToken"],
): Promise<string> {
  const token = await getAccessToken();
  if (token === null || token.trim() === "") {
    throw new PublisherTokenMissingError();
  }
  return token;
}

export class PublisherTokenMissingError extends Error {
  readonly code = "PUBLISHER_TOKEN_MISSING" as const;

  constructor() {
    super(
      "No Session Registry publisher token is stored for this API. Publish a session first — " +
        "the registry issues a token as part of your first publication.",
    );
    this.name = "PublisherTokenMissingError";
  }
}

async function submitJsonRequest(
  endpoint: string,
  method: "GET" | "POST",
  getAccessToken: HttpBackendClientOptions["getAccessToken"],
  doFetch: JsonFetch,
  body?: unknown,
): Promise<JsonResponseLike> {
  const token = await requireAccessToken(getAccessToken);
  return doFetch(endpoint, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function parsePurgeBlobResults(
  value: SessionLifecycleResponseBody["blobResults"],
): PurgeSessionResult["blobResults"] {
  if (value === undefined) {
    return [];
  }
  return value.map((entry, index) => {
    const pointer = entry.pointer;
    if (
      pointer === undefined ||
      typeof pointer.containerName !== "string" ||
      typeof pointer.blobKey !== "string"
    ) {
      throw new PurgeSessionStateUnknownError(
        `response blobResults[${index}] did not include a valid pointer`,
      );
    }
    if (
      entry.outcome !== "deleted" &&
      entry.outcome !== "skipped_shared" &&
      entry.outcome !== "delete_failed"
    ) {
      throw new PurgeSessionStateUnknownError(
        `response blobResults[${index}] did not include a valid outcome`,
      );
    }
    if (entry.detail !== undefined && typeof entry.detail !== "string") {
      throw new PurgeSessionStateUnknownError(
        `response blobResults[${index}] did not include a valid detail`,
      );
    }
    return {
      pointer,
      outcome: entry.outcome,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    };
  });
}

function parseTombstonedSessions(
  value: SessionLifecycleResponseBody["sessions"],
): ListTombstonedSessionsResult["sessions"] {
  if (value === undefined) {
    throw new PurgeSessionStateUnknownError(
      "response did not include tombstoned sessions",
    );
  }
  return value.map((session, index) => {
    if (
      typeof session.sessionId !== "string" ||
      typeof session.harnessSessionId !== "string" ||
      typeof session.title !== "string" ||
      typeof session.deletedAt !== "string"
    ) {
      throw new PurgeSessionStateUnknownError(
        `response sessions[${index}] was malformed`,
      );
    }
    if (
      session.sessionId.trim().length === 0 ||
      session.harnessSessionId.trim().length === 0 ||
      session.title.trim().length === 0 ||
      session.deletedAt.trim().length === 0
    ) {
      throw new PurgeSessionStateUnknownError(
        `response sessions[${index}] contained empty fields`,
      );
    }
    return session as ListTombstonedSessionsResult["sessions"][number];
  });
}

function validateShareUrl(value: string, harnessSessionId: string, linkId: string): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PublishStateUnknownError("response shareUrl is not a valid absolute HTTP(S) URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== `/session/${encodeURIComponent(harnessSessionId)}/${encodeURIComponent(linkId)}`
  ) {
    throw new PublishStateUnknownError(
      "response shareUrl must be an HTTP(S) canonical session URL without credentials, query, or fragment",
    );
  }
}
