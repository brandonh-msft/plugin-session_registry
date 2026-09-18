import type { BlobPointer } from "../httpBackendClient.js";

export interface PurgeSessionInput {
  readonly sessionId: string;
}

export interface PurgedBlobResult {
  readonly pointer: BlobPointer;
  readonly outcome: "deleted" | "skipped_shared" | "delete_failed";
  readonly detail?: string;
}

export interface PurgeSessionResult {
  readonly sessionId: string;
  readonly outcome: "purged" | "purged_with_blob_cleanup_failures";
  readonly blobResults: readonly PurgedBlobResult[];
}

export class PurgeSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} was not found or is not owned by the caller`);
    this.name = "PurgeSessionNotFoundError";
  }
}

export class PurgeSessionNotCurrentPublicationError extends Error {
  constructor(public readonly sessionId: string, detail: string) {
    super(detail);
    this.name = "PurgeSessionNotCurrentPublicationError";
  }
}

export class PurgeSessionNotTombstonedError extends Error {
  constructor(public readonly sessionId: string, detail: string) {
    super(detail);
    this.name = "PurgeSessionNotTombstonedError";
  }
}

export class PurgeSessionRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`purge_session request failed with status ${status}: ${detail}`);
    this.name = "PurgeSessionRequestFailedError";
  }
}

export class PurgeSessionStateUnknownError extends Error {
  constructor(public readonly detail: string) {
    super(`purge_session state is unknown: ${detail}`);
    this.name = "PurgeSessionStateUnknownError";
  }
}

export interface BackendPurgeSessionClient {
  purgeSession(sessionId: string): Promise<PurgeSessionResult>;
}

export interface PurgeSessionDeps {
  readonly backendClient: BackendPurgeSessionClient;
}

export async function purgeSession(
  input: PurgeSessionInput,
  deps: PurgeSessionDeps,
): Promise<PurgeSessionResult> {
  return deps.backendClient.purgeSession(input.sessionId);
}
