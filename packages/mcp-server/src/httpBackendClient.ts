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
  /** Supplies the developer's GitHub-bound bearer token for each request. */
  readonly getAccessToken: () => Promise<string>;
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
  readonly error?: string;
}

export function createHttpBackendClient(
  options: HttpBackendClientOptions,
): BackendPublishAndShareClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/sessions:publishAndShare`;

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
      const native = archive && hasNativeSessionBundle(archive)
        ? buildNativeSessionPublication(archive)
        : null;
      const transcriptPointer = await options.uploader.upload(
        native?.content ?? submission.transcript,
        archive ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
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
      let response: Response | undefined;
      for (let attempt = 0; attempt <= COLD_START_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          const delayMs = COLD_START_RETRY_DELAYS_MS[attempt - 1];
          if (delayMs !== undefined) {
            await sleep(delayMs);
          }
        }
        try {
        response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
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
  };
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
