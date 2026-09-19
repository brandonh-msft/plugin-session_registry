export interface DeleteSessionInput {
  readonly sessionId: string;
}

export interface DeleteSessionResult {
  readonly sessionId: string;
  readonly outcome: "deleted" | "already_tombstoned";
}

export class DeleteSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} was not found or is not owned by the caller`);
    this.name = "DeleteSessionNotFoundError";
  }
}

export class DeleteSessionNotCurrentPublicationError extends Error {
  constructor(public readonly sessionId: string, detail: string) {
    super(detail);
    this.name = "DeleteSessionNotCurrentPublicationError";
  }
}

export class DeleteSessionRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`delete_session request failed with status ${status}: ${detail}`);
    this.name = "DeleteSessionRequestFailedError";
  }
}

export class DeleteSessionStateUnknownError extends Error {
  constructor(public readonly detail: string) {
    super(`delete_session state is unknown: ${detail}`);
    this.name = "DeleteSessionStateUnknownError";
  }
}

export interface BackendDeleteSessionClient {
  deleteSession(sessionId: string): Promise<DeleteSessionResult>;
}

export interface DeleteSessionDeps {
  readonly backendClient: BackendDeleteSessionClient;
}

export async function deleteSession(
  input: DeleteSessionInput,
  deps: DeleteSessionDeps,
): Promise<DeleteSessionResult> {
  return deps.backendClient.deleteSession(input.sessionId);
}
