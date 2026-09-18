import { describe, expect, it } from "vitest";

import {
  restoreSession,
  RestoreSessionNotCurrentPublicationError,
  type BackendRestoreSessionClient,
} from "../../src/tools/restoreSession.js";

describe("restoreSession", () => {
  it("passes the immutable session id to the backend and returns its outcome", async () => {
    const calls: string[] = [];
    const backendClient: BackendRestoreSessionClient = {
      async restoreSession(sessionId: string) {
        calls.push(sessionId);
        return { sessionId, outcome: "restored" as const };
      },
    };

    const result = await restoreSession(
      { sessionId: "sess_123" },
      { backendClient },
    );

    expect(calls).toEqual(["sess_123"]);
    expect(result).toEqual({ sessionId: "sess_123", outcome: "restored" });
  });

  it("preserves the content-blocked restore outcome", async () => {
    const backendClient: BackendRestoreSessionClient = {
      async restoreSession(sessionId: string) {
        return {
          sessionId,
          outcome: "restored_but_content_blocked" as const,
        };
      },
    };

    await expect(
      restoreSession({ sessionId: "sess_123" }, { backendClient }),
    ).resolves.toEqual({
      sessionId: "sess_123",
      outcome: "restored_but_content_blocked",
    });
  });

  it("propagates the distinct not-current-publication error", async () => {
    const backendClient: BackendRestoreSessionClient = {
      async restoreSession(sessionId: string) {
        throw new RestoreSessionNotCurrentPublicationError(
          sessionId,
          "session sess_123 is not the current publication and cannot be mutated",
        );
      },
    };

    await expect(
      restoreSession({ sessionId: "sess_123" }, { backendClient }),
    ).rejects.toThrow(RestoreSessionNotCurrentPublicationError);
  });
});
