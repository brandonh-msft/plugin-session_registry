/**
 * Read side of the orphaned-upload lifecycle: finds blobs still tagged
 * `publishStatus=pending` (see `./blobTags.ts`) so the reconciliation job can
 * decide, per candidate, whether to repair the tag (Postgres already
 * references it) or delete it (it doesn't, and it's past the grace period).
 *
 * This is deliberately a separate interface from `BlobStorageClient` rather
 * than more methods bolted onto it: `BlobStorageClient` is a per-blob pointer
 * API, whereas `findBlobsByTags` is an account-wide scan with its own
 * pagination and RBAC action (`filter/action`) — conflating the two would
 * make every `BlobStorageClient` consumer (most of the codebase) implicitly
 * depend on filter-scan semantics it doesn't use.
 */

import { BlobServiceClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";

import type { BlobPointer } from "../models/session.js";
import { PENDING_UPLOAD_TAG_FILTER } from "./blobTags.js";

export interface PendingUploadRecord {
  readonly pointer: BlobPointer;
  /** Last-modified time of the blob, used to apply the reconciliation job's grace period. */
  readonly lastModified: Date;
}

export interface PendingUploadIndex {
  findPending(): Promise<readonly PendingUploadRecord[]>;
}

/**
 * Azure Blob Storage-backed implementation. Requires the identity behind
 * `credential` to hold `filter/action` RBAC (Storage Blob Data Owner does;
 * Storage Blob Data Contributor does not — see storage.bicep) or every scan
 * fails with an authorization error.
 */
export class AzurePendingUploadIndex implements PendingUploadIndex {
  private readonly serviceClient: BlobServiceClient;

  constructor(blobEndpoint: string, credential: TokenCredential) {
    this.serviceClient = new BlobServiceClient(blobEndpoint, credential);
  }

  async findPending(): Promise<readonly PendingUploadRecord[]> {
    const records: PendingUploadRecord[] = [];
    for await (const item of this.serviceClient.findBlobsByTags(
      PENDING_UPLOAD_TAG_FILTER,
    )) {
      // `findBlobsByTags` results carry no timestamp, so a per-candidate
      // getProperties() call is unavoidable to apply the grace period.
      const properties = await this.serviceClient
        .getContainerClient(item.containerName)
        .getBlobClient(item.name)
        .getProperties();
      records.push({
        pointer: { containerName: item.containerName, blobKey: item.name },
        // No observed case leaves lastModified unset on an existing blob;
        // falling back to the epoch is a conservative "treat as very old"
        // default rather than one that could ever mask a real orphan.
        lastModified: properties.lastModified ?? new Date(0),
      });
    }
    return records;
  }
}

/** Test double: no network dependency, fully controllable via the constructor. */
export class InMemoryPendingUploadIndex implements PendingUploadIndex {
  constructor(private records: readonly PendingUploadRecord[] = []) {}

  setRecords(records: readonly PendingUploadRecord[]): void {
    this.records = records;
  }

  async findPending(): Promise<readonly PendingUploadRecord[]> {
    return this.records;
  }
}
