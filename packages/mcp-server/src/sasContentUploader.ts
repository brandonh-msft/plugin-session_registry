/**
 * The real `ContentUploader`: obtains a create-only upload slot from the
 * registry API, then PUTs the redacted bytes straight to Blob Storage.
 *
 * Content deliberately does not travel through the API. Azure Container Apps
 * enforces a non-configurable 4 MB ingress body limit, which a transcript or
 * resumable bundle can exceed; more importantly, streaming large uploads
 * through the API would pin a replica per publish for no benefit, since the
 * API has nothing to do with the bytes. The API's role is to mint a narrowly
 * scoped credential and to record pointers.
 *
 * Two consequences of the credential's shape are load-bearing here:
 *
 * 1. **The server chooses the blob key**, so this client cannot target a blob
 *    of its own choosing. It sends only a *kind* and reads back the pointer.
 * 2. **The SAS carries `Create`, not `Write`** permission, so a PUT to a key
 *    that already holds content fails rather than overwriting it. A retry
 *    therefore needs a *fresh* slot — reusing a spent one is not merely
 *    wasteful, it will fail. `upload()` requests one slot per call for exactly
 *    this reason.
 */

import type { BlobPointer, ContentUploader, UploadKind } from "./httpBackendClient.js";
import {
  PUBLISH_STATUS_TAG_KEY,
  PUBLISH_STATUS_PENDING,
} from "@session-registry/core";

export class UploadFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`upload failed with status ${status}: ${detail}`);
    this.name = "UploadFailedError";
  }
}

export interface SasContentUploaderOptions {
  readonly baseUrl: string;
  /**
   * Supplies the publisher's registry token, or `null` when this machine has
   * not published yet. A first publish has to upload its content before the
   * call that mints its token, so the slot endpoint accepts an anonymous
   * caller under a separate abuse budget.
   */
  readonly getAccessToken: () => Promise<string | null>;
  /** Overridable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

interface UploadSlotResponse {
  readonly slots?: readonly {
    readonly pointer?: BlobPointer;
    readonly uploadUrl?: string;
  }[];
  readonly error?: string;
}

/**
 * One slot is requested per `upload()` call. That is deliberate rather than
 * wasteful: because slots are create-only, a spent slot cannot be reused, so
 * batching slot requests ahead of time would strand credentials whenever an
 * upload failed partway through.
 */
export function createSasContentUploader(
  options: SasContentUploaderOptions,
): ContentUploader {
  const doFetch = options.fetch ?? globalThis.fetch;
  const slotEndpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/uploads`;

  return {
    async upload(
      content: string | Uint8Array,
      contentType: string,
      kind: UploadKind,
    ): Promise<BlobPointer> {
      const token = await options.getAccessToken();

      const slotResponse = await doFetch(slotEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Omitted rather than blank when absent: a malformed credential is
          // refused, while an absent one is what marks a first publish.
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ uploads: [{ kind, contentType }] }),
      });

      const slotBody = (await slotResponse.json().catch(() => ({}))) as UploadSlotResponse;
      if (!slotResponse.ok) {
        throw new UploadFailedError(
          slotResponse.status,
          slotBody.error ?? slotResponse.statusText,
        );
      }

      const slot = slotBody.slots?.[0];
      if (
        slot === undefined ||
        typeof slot.uploadUrl !== "string" ||
        typeof slot.pointer?.containerName !== "string" ||
        typeof slot.pointer?.blobKey !== "string"
      ) {
        throw new UploadFailedError(slotResponse.status, "response did not include a usable slot");
      }

      const putResponse = await doFetch(slot.uploadUrl, {
        method: "PUT",
        headers: {
          // Required by the Blob REST API for a block blob PUT; without it the
          // service rejects the request rather than inferring a type.
          "x-ms-blob-type": "BlockBlob",
          "content-type": contentType,
          // Marks the blob `publishStatus=pending` at write time, so the
          // orphaned-upload reconciliation job can find it if `publishAndShare`
          // is never called for it. The SAS's `tag` permission (see
          // uploadSasIssuer.ts) is what makes this header effective at all.
          // Format is Azure's tag-header convention: URL-encoded key=value
          // pairs joined by `&` (only one pair needed here).
          "x-ms-tags": `${encodeURIComponent(PUBLISH_STATUS_TAG_KEY)}=${encodeURIComponent(PUBLISH_STATUS_PENDING)}`,
        },
        body: content,
      });

      if (!putResponse.ok) {
        // 409 here specifically means the blob already exists — the create-only
        // permission working as intended. Surfaced rather than retried, because
        // silently retrying would mean re-requesting a slot in a loop.
        throw new UploadFailedError(
          putResponse.status,
          putResponse.status === 409
            ? "blob already exists; create-only upload slots cannot overwrite"
            : putResponse.statusText,
        );
      }

      return { containerName: slot.pointer.containerName, blobKey: slot.pointer.blobKey };
    },
  };
}
