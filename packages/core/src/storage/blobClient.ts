import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import type { BlobPointer } from "../models/session.js";

/**
 * Storage abstraction the rest of the codebase depends on, so units never
 * import `@azure/storage-blob` directly. This keeps the Azure-specific SDK
 * confined to `AzureBlobStorageClient` and makes `InMemoryBlobStorageClient`
 * a drop-in test double with no network dependency.
 */
export interface BlobStorageClient {
  putObject(pointer: BlobPointer, data: Buffer): Promise<void>;
  getObject(pointer: BlobPointer): Promise<Buffer>;
  deleteObject(pointer: BlobPointer): Promise<void>;
  /**
   * Issues a short-lived, single-blob-scoped SAS URL for anonymous-link
   * delivery (see plan's SAS-vs-proxy delivery split, Unit 8). Authenticated
   * links must never call this — they go through an application-level
   * authorization proxy instead, which streams via getObject.
   */
  getAnonymousSasUrl(
    pointer: BlobPointer,
    options: { expiresInSeconds: number },
  ): Promise<string>;
  /**
   * Replaces a blob's index tags wholesale (Azure's `setTags` is not a merge).
   * Backs the `publishStatus` tag lifecycle in `./blobTags.ts` — do not use
   * this for arbitrary tagging without checking that lifecycle first, since a
   * careless overwrite here is exactly what would defeat the reconciliation
   * job's and the storage lifecycle policy's ability to tell published
   * content from an abandoned upload.
   */
  setTags(pointer: BlobPointer, tags: Record<string, string>): Promise<void>;
}

const DELEGATION_KEY_LIFETIME_MS = 60 * 60 * 1000;
const DELEGATION_RENEWAL_MARGIN_MS = 5 * 60 * 1000;
const DELEGATION_START_SKEW_MS = 5 * 60 * 1000;

/** Managed-identity construction inputs for `AzureBlobStorageClient`. */export interface AzureBlobStorageTokenOptions {
  /** e.g. `https://acct.blob.core.windows.net/` */
  readonly blobEndpoint: string;
  readonly credential: TokenCredential;
}

export class BlobNotFoundError extends Error {  constructor(pointer: BlobPointer) {
    super(
      `Blob not found: container=${pointer.containerName} key=${pointer.blobKey}`,
    );
    this.name = "BlobNotFoundError";
  }
}

/**
 * Azure Blob Storage-backed implementation (Key Technical Decisions: Azure
 * mapping). Requires a real connection string/credential at construction
 * time — this class is intentionally never exercised in this unit's tests,
 * which use InMemoryBlobStorageClient instead; live Azure connectivity is
 * an operational/integration concern outside a unit test's scope.
 */
export class AzureBlobStorageClient implements BlobStorageClient {
  private readonly serviceClient: BlobServiceClient;
  private readonly sharedKeyCredential?: StorageSharedKeyCredential;
  /**
   * Set only on the managed-identity path. Anonymous-link SAS is then signed
   * with a user delegation key instead of an account key, which is what lets
   * production run without any storage account key at all (see
   * `AzureUploadSasIssuer`, which signs upload URLs the same way).
   */
  private readonly delegationCredential?: TokenCredential;
  private cachedDelegationKey: { key: UserDelegationKey; expiresAt: number } | null = null;

  constructor(
    connectionStringOrOptions: string | AzureBlobStorageTokenOptions,
    sharedKey?: { readonly accountName: string; readonly accountKey: string },
  ) {
    if (typeof connectionStringOrOptions === "string") {
      this.serviceClient = BlobServiceClient.fromConnectionString(
        connectionStringOrOptions,
      );
      this.sharedKeyCredential =
        sharedKey === undefined
          ? undefined
          : new StorageSharedKeyCredential(
              sharedKey.accountName,
              sharedKey.accountKey,
            );
      return;
    }
    this.serviceClient = new BlobServiceClient(
      connectionStringOrOptions.blobEndpoint,
      connectionStringOrOptions.credential,
    );
    this.delegationCredential = connectionStringOrOptions.credential;
  }

  /**
   * Managed-identity construction for production, where no account key or
   * connection string exists. `credential` needs a role granting
   * `generateUserDelegationKey` (Storage Blob Data Contributor includes it).
   */
  static fromTokenCredential(
    blobEndpoint: string,
    credential: TokenCredential,
  ): AzureBlobStorageClient {
    return new AzureBlobStorageClient({ blobEndpoint, credential });
  }

  async putObject(pointer: BlobPointer, data: Buffer): Promise<void> {
    const containerClient = this.serviceClient.getContainerClient(
      pointer.containerName,
    );
    const blockBlobClient = containerClient.getBlockBlobClient(
      pointer.blobKey,
    );
    await blockBlobClient.upload(data, data.length);
  }

  async getObject(pointer: BlobPointer): Promise<Buffer> {
    const containerClient = this.serviceClient.getContainerClient(
      pointer.containerName,
    );
    const blobClient = containerClient.getBlobClient(pointer.blobKey);
    const exists = await blobClient.exists();
    if (!exists) {
      throw new BlobNotFoundError(pointer);
    }
    const download = await blobClient.download();
    const chunks: Buffer[] = [];
    if (download.readableStreamBody) {
      for await (const chunk of download.readableStreamBody) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks);
  }

  async deleteObject(pointer: BlobPointer): Promise<void> {
    const containerClient = this.serviceClient.getContainerClient(
      pointer.containerName,
    );
    await containerClient.getBlobClient(pointer.blobKey).deleteIfExists();
  }

  async getAnonymousSasUrl(
    pointer: BlobPointer,
    options: { expiresInSeconds: number },
  ): Promise<string> {
    const expiresOn = new Date(Date.now() + options.expiresInSeconds * 1000);
    const url = this.serviceClient
      .getContainerClient(pointer.containerName)
      .getBlobClient(pointer.blobKey).url;
    const permissions = BlobSASPermissions.parse("r");

    if (this.delegationCredential !== undefined) {
      const delegationKey = await this.getDelegationKey();
      const sas = generateBlobSASQueryParameters(
        {
          containerName: pointer.containerName,
          blobName: pointer.blobKey,
          permissions,
          expiresOn,
          protocol: SASProtocol.Https,
        },
        delegationKey,
        this.serviceClient.accountName,
      );
      return `${url}?${sas.toString()}`;
    }

    if (this.sharedKeyCredential === undefined) {
      throw new Error(
        `getAnonymousSasUrl requires a configured SAS credential for ${pointer.containerName}/${pointer.blobKey}`,
      );
    }
    const sas = generateBlobSASQueryParameters(
      {
        containerName: pointer.containerName,
        blobName: pointer.blobKey,
        permissions,
        expiresOn,
        protocol: SASProtocol.HttpsAndHttp,
      },
      this.sharedKeyCredential,
    );
    return `${url}?${sas.toString()}`;
  }

  /**
   * A user delegation key is valid for days, so it is cached and renewed
   * early rather than re-fetched per download link.
   */
  private async getDelegationKey(): Promise<UserDelegationKey> {
    const nowMs = Date.now();
    if (this.cachedDelegationKey !== null && nowMs < this.cachedDelegationKey.expiresAt - DELEGATION_RENEWAL_MARGIN_MS) {
      return this.cachedDelegationKey.key;
    }
    const expiresOn = new Date(nowMs + DELEGATION_KEY_LIFETIME_MS);
    const key = await this.serviceClient.getUserDelegationKey(
      new Date(nowMs - DELEGATION_START_SKEW_MS),
      expiresOn,
    );
    this.cachedDelegationKey = { key, expiresAt: expiresOn.getTime() };
    return key;
  }

  async setTags(
    pointer: BlobPointer,
    tags: Record<string, string>,
  ): Promise<void> {
    const containerClient = this.serviceClient.getContainerClient(
      pointer.containerName,
    );
    await containerClient.getBlobClient(pointer.blobKey).setTags(tags);
  }
}

/**
 * In-memory fake for tests. Never used in production — production code
 * should depend on the BlobStorageClient interface, not this class.
 */
export class InMemoryBlobStorageClient implements BlobStorageClient {
  private readonly store = new Map<string, Buffer>();
  private readonly tagsByKey = new Map<string, Record<string, string>>();

  private key(pointer: BlobPointer): string {
    return `${pointer.containerName}/${pointer.blobKey}`;
  }

  /** Test-only inspection helper; not part of the BlobStorageClient interface. */
  getTags(pointer: BlobPointer): Record<string, string> | undefined {
    return this.tagsByKey.get(this.key(pointer));
  }

  async putObject(pointer: BlobPointer, data: Buffer): Promise<void> {
    this.store.set(this.key(pointer), Buffer.from(data));
  }

  async getObject(pointer: BlobPointer): Promise<Buffer> {
    const data = this.store.get(this.key(pointer));
    if (!data) {
      throw new BlobNotFoundError(pointer);
    }
    return data;
  }

  async deleteObject(pointer: BlobPointer): Promise<void> {
    this.store.delete(this.key(pointer));
    this.tagsByKey.delete(this.key(pointer));
  }

  async setTags(
    pointer: BlobPointer,
    tags: Record<string, string>,
  ): Promise<void> {
    if (!this.store.has(this.key(pointer))) {
      throw new BlobNotFoundError(pointer);
    }
    this.tagsByKey.set(this.key(pointer), { ...tags });
  }

  async getAnonymousSasUrl(
    pointer: BlobPointer,
    options: { expiresInSeconds: number },
  ): Promise<string> {
    if (!this.store.has(this.key(pointer))) {
      throw new BlobNotFoundError(pointer);
    }
    return `https://fake-sas.test/${pointer.containerName}/${pointer.blobKey}?expiresIn=${options.expiresInSeconds}`;
  }
}
