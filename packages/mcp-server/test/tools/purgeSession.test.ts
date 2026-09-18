import { describe, expect, it } from "vitest";

import {
  purgeSession,
  PurgeSessionNotTombstonedError,
  type BackendPurgeSessionClient,
} from "../../src/tools/purgeSession.js";

describe("purgeSession", () => {
  it("passes the immutable session id to the backend and returns its outcome", async () => {
    const calls: string[] = [];
    const backendClient: BackendPurgeSessionClient = {
      async purgeSession(sessionId: string) {
        calls.push(sessionId);
        return {
          sessionId,
          outcome: "purged" as const,
          blobResults: [
            {
              pointer: { containerName: "sessions", blobKey: "blob-1" },
              outcome: "deleted" as const,
            },
          ],
        };
      },
    };

    const result = await purgeSession(
      { sessionId: "sess_123" },
      { backendClient },
    );

    expect(calls).toEqual(["sess_123"]);
    expect(result).toEqual({
      sessionId: "sess_123",
      outcome: "purged",
      blobResults: [
        {
          pointer: { containerName: "sessions", blobKey: "blob-1" },
          outcome: "deleted",
        },
      ],
    });
  });

  it("preserves partial blob-cleanup outcomes from the backend", async () => {
    const backendClient: BackendPurgeSessionClient = {
      async purgeSession(sessionId: string) {
        return {
          sessionId,
          outcome: "purged_with_blob_cleanup_failures" as const,
          blobResults: [
            {
              pointer: { containerName: "sessions", blobKey: "blob-1" },
              outcome: "delete_failed" as const,
              detail: "blob delete failed",
            },
          ],
        };
      },
    };

    await expect(
      purgeSession({ sessionId: "sess_123" }, { backendClient }),
    ).resolves.toEqual({
      sessionId: "sess_123",
      outcome: "purged_with_blob_cleanup_failures",
      blobResults: [
        {
          pointer: { containerName: "sessions", blobKey: "blob-1" },
          outcome: "delete_failed",
          detail: "blob delete failed",
        },
      ],
    });
  });

  it("propagates the non-tombstoned precondition error", async () => {
    const backendClient: BackendPurgeSessionClient = {
      async purgeSession(sessionId: string) {
        throw new PurgeSessionNotTombstonedError(
          sessionId,
          "session sess_123 must be tombstoned before it can be purged",
        );
      },
    };

    await expect(
      purgeSession({ sessionId: "sess_123" }, { backendClient }),
    ).rejects.toThrow(PurgeSessionNotTombstonedError);
  });
});
