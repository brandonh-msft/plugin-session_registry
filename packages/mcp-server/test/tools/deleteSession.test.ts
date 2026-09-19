import { describe, expect, it } from "vitest";

import {
  deleteSession,
  DeleteSessionNotCurrentPublicationError,
  type BackendDeleteSessionClient,
} from "../../src/tools/deleteSession.js";

describe("deleteSession", () => {
  it("passes the immutable session id to the backend and returns its outcome", async () => {
    const calls: string[] = [];
    const backendClient: BackendDeleteSessionClient = {
      async deleteSession(sessionId: string) {
        calls.push(sessionId);
        return { sessionId, outcome: "deleted" as const };
      },
    };

    const result = await deleteSession(
      { sessionId: "sess_123" },
      { backendClient },
    );

    expect(calls).toEqual(["sess_123"]);
    expect(result).toEqual({ sessionId: "sess_123", outcome: "deleted" });
  });

  it("preserves idempotent no-op outcomes from the backend", async () => {
    const backendClient: BackendDeleteSessionClient = {
      async deleteSession(sessionId: string) {
        return { sessionId, outcome: "already_tombstoned" as const };
      },
    };

    await expect(
      deleteSession({ sessionId: "sess_123" }, { backendClient }),
    ).resolves.toEqual({
      sessionId: "sess_123",
      outcome: "already_tombstoned",
    });
  });

  it("propagates the distinct not-current-publication error", async () => {
    const backendClient: BackendDeleteSessionClient = {
      async deleteSession(sessionId: string) {
        throw new DeleteSessionNotCurrentPublicationError(
          sessionId,
          "session sess_123 is not the current publication and cannot be mutated",
        );
      },
    };

    await expect(
      deleteSession({ sessionId: "sess_123" }, { backendClient }),
    ).rejects.toThrow(DeleteSessionNotCurrentPublicationError);
  });
});
