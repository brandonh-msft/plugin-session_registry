import {
  PurgeSessionNotCurrentPublicationError,
  PurgeSessionNotFoundError,
  PurgeSessionNotTombstonedError,
  type BackendPurgeSessionClient,
  type PurgedBlobResult,
} from "./purgeSession.js";

export interface TombstonedSessionPreview {
  readonly sessionId: string;
  readonly harnessSessionId: string;
  readonly title: string;
  readonly deletedAt: string;
}

export interface ListTombstonedSessionsResult {
  readonly sessions: readonly TombstonedSessionPreview[];
}

export interface BackendListTombstonedSessionsClient {
  listTombstonedSessions(): Promise<ListTombstonedSessionsResult>;
}

export interface PurgeSessionsInput {}

export interface PurgeSessionsConfirmationRequest {
  readonly message: string;
  readonly requestedSchema: {
    readonly type: "object";
    readonly properties: {
      readonly confirm: {
        readonly type: "boolean";
        readonly default: false;
        readonly description: string;
      };
    };
    readonly required: string[];
    readonly additionalProperties: false;
  };
}

export interface PurgeSessionsConfirmationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: {
    readonly confirm?: boolean;
  };
}

export interface PurgeSessionsOutcome {
  readonly sessionId: string;
  readonly outcome:
    | "purged"
    | "purged_with_blob_cleanup_failures"
    | "skipped"
    | "failed";
  readonly reason?: string;
  readonly blobResults?: readonly PurgedBlobResult[];
}

export interface PurgeSessionsResult {
  readonly previewCount: number;
  readonly previewedSessionIds: readonly string[];
  readonly confirmation:
    | "accepted"
    | "declined"
    | "cancelled"
    | "unanswered"
    | "unavailable"
    | "not_needed";
  readonly outcomes: readonly PurgeSessionsOutcome[];
}

export interface PurgeSessionsDeps {
  readonly backendClient: BackendListTombstonedSessionsClient & BackendPurgeSessionClient;
  readonly confirm?: (
    request: PurgeSessionsConfirmationRequest,
  ) => Promise<PurgeSessionsConfirmationResponse | undefined>;
}

export async function purgeSessions(
  _input: PurgeSessionsInput,
  deps: PurgeSessionsDeps,
): Promise<PurgeSessionsResult> {
  const preview = await deps.backendClient.listTombstonedSessions();
  const previewedSessionIds = preview.sessions.map((session) => session.sessionId);

  if (preview.sessions.length === 0) {
    return {
      previewCount: 0,
      previewedSessionIds,
      confirmation: "not_needed",
      outcomes: [],
    };
  }

  if (deps.confirm === undefined) {
    return {
      previewCount: preview.sessions.length,
      previewedSessionIds,
      confirmation: "unavailable",
      outcomes: [],
    };
  }

  const confirmation = await deps.confirm(buildConfirmationRequest(preview.sessions));
  const confirmationStatus = toConfirmationStatus(confirmation);
  if (confirmationStatus !== "accepted") {
    return {
      previewCount: preview.sessions.length,
      previewedSessionIds,
      confirmation: confirmationStatus,
      outcomes: [],
    };
  }

  const outcomes: PurgeSessionsOutcome[] = [];
  for (const session of preview.sessions) {
    try {
      const result = await deps.backendClient.purgeSession(session.sessionId);
      outcomes.push({
        sessionId: session.sessionId,
        outcome: result.outcome,
        blobResults: result.blobResults,
      });
    } catch (error) {
      outcomes.push(classifyPurgeFailure(session.sessionId, error));
    }
  }

  return {
    previewCount: preview.sessions.length,
    previewedSessionIds,
    confirmation: "accepted",
    outcomes,
  };
}

function buildConfirmationRequest(
  sessions: readonly TombstonedSessionPreview[],
): PurgeSessionsConfirmationRequest {
  const lines = sessions.map(
    (session) =>
      `- ${session.title} (${session.sessionId}) tombstoned ${session.deletedAt}`,
  );
  return {
    message:
      `Permanently purge ${sessions.length} tombstoned session${sessions.length === 1 ? "" : "s"}? ` +
      "This cannot be undone.\n" +
      lines.join("\n"),
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          default: false,
          description: "Set to true to permanently purge exactly this previewed set.",
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
  };
}

function toConfirmationStatus(
  confirmation: PurgeSessionsConfirmationResponse | undefined,
): PurgeSessionsResult["confirmation"] {
  if (confirmation === undefined) {
    return "unanswered";
  }
  if (confirmation.action === "cancel") {
    return "cancelled";
  }
  if (confirmation.action !== "accept") {
    return "declined";
  }
  if (confirmation.content?.confirm !== true) {
    return "declined";
  }
  return "accepted";
}

function classifyPurgeFailure(
  sessionId: string,
  error: unknown,
): PurgeSessionsOutcome {
  if (error instanceof PurgeSessionNotFoundError) {
    return {
      sessionId,
      outcome: "skipped",
      reason: "session was already purged before execution",
    };
  }
  if (error instanceof PurgeSessionNotTombstonedError) {
    return {
      sessionId,
      outcome: "skipped",
      reason: "session was restored or otherwise no longer tombstoned",
    };
  }
  if (error instanceof PurgeSessionNotCurrentPublicationError) {
    return {
      sessionId,
      outcome: "skipped",
      reason: error.message,
    };
  }
  return {
    sessionId,
    outcome: "failed",
    reason: error instanceof Error ? error.message : "purge failed",
  };
}
