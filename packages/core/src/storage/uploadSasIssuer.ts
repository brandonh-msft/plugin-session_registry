/**
 * Write-side SAS issuance: the counterpart to `BlobStorageClient`'s read-side
 * `getAnonymousSasUrl`.
 *
 * This exists because of a hard platform constraint. The MCP server runs on the
 * developer's own machine (the client-side scan-then-submit decision requires
 * it), so redacted content originates locally — but the storage account's
 * `publicNetworkAccess` is permanently `Disabled` by binding tenant policy, so
 * a direct PUT from that machine can never reach the storage data plane at
 * all. The returned URL is rehosted onto Front Door's private-link-connected
 * endpoint instead, the same way anonymous download SAS URLs already are. The API's
 * job here is only to hand out a narrowly-scoped credential; it never carries
 * the bytes itself, both because that would need to detour through it for no
 * benefit and because Azure Container Apps enforces a non-configurable 4 MB
 * ingress body limit that a transcript or resumable bundle can exceed.
 *
 * Three properties make that safe, and none of them are incidental:
 *
 * 1. **User delegation SAS, not account-key SAS.** The token is signed with a
 *    key obtained from Entra ID using the API's managed identity, so no storage
 *    account key exists to leak, and the grant inherits Entra revocation.
 * 2. **`Create` permission, not `Write`.** These differ in exactly the way that
 *    matters here: `Create` fails if the blob already exists, whereas `Write`
 *    silently overwrites. Create-only is what stops a client from retaining its
 *    SAS and swapping content *after* publish, which would break `BASE-R6`
 *    (immutable snapshots) and `BASE-R41` (the exact owner-approved variant is
 *    what is exposed). Do not "simplify" this to `write: true`.
 * 3. **Single-blob scope, short expiry, HTTPS-only.** The grant names one blob;
 *    it is not a container-wide credential.
 *
 * The caller — never the client — chooses the blob key. See
 * `uploadSlotService` for why.
 */

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

export interface UploadSlotGrantRequest {
  readonly pointer: BlobPointer;
  readonly expiresInSeconds: number;
}

export interface UploadSlotGrant {
  /** Fully-qualified blob URL with the SAS token in its query string. */
  readonly uploadUrl: string;
  readonly expiresAt: Date;
}

/**
 * The seam the API depends on, so HTTP route composition can stay decoupled
 * from Azure SDK imports and tests never need live storage.
 */
export interface UploadSasIssuer {
  issueCreateOnlyUploadUrl(request: UploadSlotGrantRequest): Promise<UploadSlotGrant>;
}

/**
 * Clock skew allowance. Without backdating the start time, a SAS minted on a
 * host whose clock runs slightly fast is rejected as "not yet valid" by the
 * storage service.
 */
const START_TIME_SKEW_SECONDS = 300;

/**
 * A user delegation key is valid for up to 7 days, so re-fetching one per
 * upload would add a pointless Entra round trip to every publish. It is cached
 * and renewed early — `RENEWAL_MARGIN_MS` before expiry — so an in-flight
 * request never signs with a key that expires mid-use.
 */
const DELEGATION_KEY_LIFETIME_MS = 60 * 60 * 1000;
const RENEWAL_MARGIN_MS = 5 * 60 * 1000;

export class AzureUploadSasIssuer implements UploadSasIssuer {
  private readonly serviceClient: BlobServiceClient;
  private readonly accountName: string;
  private cachedKey: { key: UserDelegationKey; expiresAt: number } | null = null;

  /**
   * @param blobEndpoint e.g. `https://acct.blob.core.windows.net/`
   * @param credential typically a `ManagedIdentityCredential`; needs a role
   *   granting `generateUserDelegationKey` (Storage Blob Data Contributor
   *   includes it, as does the narrower Storage Blob Delegator).
   */
  constructor(
    blobEndpoint: string,
    private readonly credential: TokenCredential,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.serviceClient = new BlobServiceClient(blobEndpoint, credential);
    this.accountName = this.serviceClient.accountName;
  }

  private async getDelegationKey(): Promise<UserDelegationKey> {
    const nowMs = this.now().getTime();
    if (this.cachedKey !== null && nowMs < this.cachedKey.expiresAt - RENEWAL_MARGIN_MS) {
      return this.cachedKey.key;
    }
    const startsOn = new Date(nowMs - START_TIME_SKEW_SECONDS * 1000);
    const expiresOn = new Date(nowMs + DELEGATION_KEY_LIFETIME_MS);
    const key = await this.serviceClient.getUserDelegationKey(startsOn, expiresOn);
    this.cachedKey = { key, expiresAt: expiresOn.getTime() };
    return key;
  }

  async issueCreateOnlyUploadUrl(request: UploadSlotGrantRequest): Promise<UploadSlotGrant> {
    const delegationKey = await this.getDelegationKey();
    const nowMs = this.now().getTime();
    const startsOn = new Date(nowMs - START_TIME_SKEW_SECONDS * 1000);
    const expiresOn = new Date(nowMs + request.expiresInSeconds * 1000);

    const sas = generateBlobSASQueryParameters(
      {
        containerName: request.pointer.containerName,
        blobName: request.pointer.blobKey,
        // Create, deliberately not Write — see this module's docstring.
        // `tag: true` is also granted so the uploader can mark the blob
        // `publishStatus=pending` in the same PUT, which is what makes the
        // orphaned-upload reconciliation job and the storage lifecycle policy
        // able to find abandoned uploads at all.
        // This permission is a no-op unless the identity that signed this
        // delegation key also has `tags/write` RBAC — see storage.bicep's
        // Storage Blob Data Owner assignment.
        permissions: BlobSASPermissions.from({ create: true, tag: true }),
        startsOn,
        expiresOn,
        protocol: SASProtocol.Https,
      },
      delegationKey,
      this.accountName,
    );

    const blobUrl = this.serviceClient
      .getContainerClient(request.pointer.containerName)
      .getBlockBlobClient(request.pointer.blobKey).url;

    return { uploadUrl: `${blobUrl}?${sas.toString()}`, expiresAt: expiresOn };
  }
}

/**
 * Local-emulator issuer backed by an account key. Production must use
 * `AzureUploadSasIssuer`; this class exists because Azurite cannot issue an
 * Entra user-delegation key, but local MCP publishing still needs a real URL
 * that accepts the direct blob PUT.
 */
export class SharedKeyUploadSasIssuer implements UploadSasIssuer {
  private readonly serviceClient: BlobServiceClient;
  private readonly credential: StorageSharedKeyCredential;

  constructor(
    blobEndpoint: string,
    accountName: string,
    accountKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const hostname = new URL(blobEndpoint).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error(
        "SharedKeyUploadSasIssuer is restricted to local emulator endpoints",
      );
    }
    this.credential = new StorageSharedKeyCredential(accountName, accountKey);
    this.serviceClient = new BlobServiceClient(blobEndpoint, this.credential);
  }

  async issueCreateOnlyUploadUrl(
    request: UploadSlotGrantRequest,
  ): Promise<UploadSlotGrant> {
    const container = this.serviceClient.getContainerClient(
      request.pointer.containerName,
    );
    await container.createIfNotExists();

    const nowMs = this.now().getTime();
    const startsOn = new Date(nowMs - START_TIME_SKEW_SECONDS * 1000);
    const expiresOn = new Date(
      nowMs + request.expiresInSeconds * 1000,
    );
    const sas = generateBlobSASQueryParameters(
      {
        containerName: request.pointer.containerName,
        blobName: request.pointer.blobKey,
        permissions: BlobSASPermissions.from({ create: true, tag: true }),
        startsOn,
        expiresOn,
        protocol: SASProtocol.HttpsAndHttp,
      },
      this.credential,
    );
    const blobUrl = container.getBlockBlobClient(
      request.pointer.blobKey,
    ).url;

    return { uploadUrl: `${blobUrl}?${sas.toString()}`, expiresAt: expiresOn };
  }
}

/**
 * Test double. Mirrors the real issuer's *observable contract* —
 * single-blob scope and an expiry — without minting a real token.
 */
export class FakeUploadSasIssuer implements UploadSasIssuer {
  readonly issued: UploadSlotGrantRequest[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async issueCreateOnlyUploadUrl(request: UploadSlotGrantRequest): Promise<UploadSlotGrant> {
    this.issued.push(request);
    const expiresAt = new Date(this.now().getTime() + request.expiresInSeconds * 1000);
    return {
      uploadUrl:
        `https://fake-upload.test/${request.pointer.containerName}/${request.pointer.blobKey}` +
        `?sp=c&se=${encodeURIComponent(expiresAt.toISOString())}`,
      expiresAt,
    };
  }
}
