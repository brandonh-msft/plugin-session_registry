export interface RestoreSessionInput {
  readonly sessionId: string;
}

export interface RestoreSessionResult {
  readonly sessionId: string;
  readonly outcome:
    | "restored"
    | "already_active"
    | "restored_but_content_blocked";
}

export class RestoreSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} was not found or is not owned by the caller`);
    this.name = "RestoreSessionNotFoundError";
  }
}

export class RestoreSessionNotCurrentPublicationError extends Error {
  constructor(public readonly sessionId: string, detail: string) {
    super(detail);
    this.name = "RestoreSessionNotCurrentPublicationError";
  }
}

export class RestoreSessionRequestFailedError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`restore_session request failed with status ${status}: ${detail}`);
    this.name = "RestoreSessionRequestFailedError";
  }
}

export class RestoreSessionStateUnknownError extends Error {
  constructor(public readonly detail: string) {
    super(`restore_session state is unknown: ${detail}`);
    this.name = "RestoreSessionStateUnknownError";
  }
}

export interface BackendRestoreSessionClient {
  restoreSession(sessionId: string): Promise<RestoreSessionResult>;
}

export interface RestoreSessionDeps {
  readonly backendClient: BackendRestoreSessionClient;
}

export async function restoreSession(
  input: RestoreSessionInput,
  deps: RestoreSessionDeps,
): Promise<RestoreSessionResult> {
  return deps.backendClient.restoreSession(input.sessionId);
}
