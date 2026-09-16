/**
 * Blob index tag vocabulary for the upload-orphan lifecycle.
 *
 * A single tag (`publishStatus`) drives three consumers that must agree on
 * its meaning without importing each other:
 *
 * - `sasContentUploader` (packages/mcp-server) tags a blob `pending` at
 *   upload time, using the `tag` SAS permission granted alongside `create`.
 * - The publish-and-share service tags a blob `published` once the session/link
 *   referencing it is durably committed.
 * - The reconciliation job queries for blobs still tagged `pending` and either
 *   repairs (re-tags `published`, if Postgres already references it — closing a
 *   gap where the publish-time tag write failed) or deletes them (if
 *   unreferenced and past the grace period).
 *
 * A blob that is never tagged at all (pre-dating this feature, or written by
 * some other path) is invisible to all three and is left alone — the tag is
 * additive, not a completeness guarantee.
 */

export const PUBLISH_STATUS_TAG_KEY = "publishStatus";
export const PUBLISH_STATUS_PENDING = "pending";
export const PUBLISH_STATUS_PUBLISHED = "published";

export function pendingUploadTags(): Record<string, string> {
  return { [PUBLISH_STATUS_TAG_KEY]: PUBLISH_STATUS_PENDING };
}

export function publishedTags(): Record<string, string> {
  return { [PUBLISH_STATUS_TAG_KEY]: PUBLISH_STATUS_PUBLISHED };
}

/**
 * The tag filter expression `BlobServiceClient.findBlobsByTags` accepts,
 * matching the SQL-like syntax the service defines (unquoted key, quoted
 * value).
 */
export const PENDING_UPLOAD_TAG_FILTER = `${PUBLISH_STATUS_TAG_KEY}='${PUBLISH_STATUS_PENDING}'`;
