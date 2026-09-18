import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestFormParamsSchema,
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../../src/index.js";
import {
  PurgeSessionNotFoundError,
  PurgeSessionNotTombstonedError,
  type BackendPurgeSessionClient,
  type PurgeSessionResult,
} from "../../src/tools/purgeSession.js";
import {
  purgeSessions,
  type BackendListTombstonedSessionsClient,
  type TombstonedSessionPreview,
} from "../../src/tools/purgeSessions.js";
import type { BackendPublishAndShareClient } from "../../src/tools/publishAndShare.js";

interface BackendState {
  readonly tombstoned: Map<string, TombstonedSessionPreview>;
  readonly active: Map<string, TombstonedSessionPreview>;
  readonly purged: Set<string>;
  readonly purgeCalls: string[];
  customPurge?: (sessionId: string) => Promise<PurgeSessionResult>;
}

function session(
  sessionId: string,
  title = `Session ${sessionId}`,
): TombstonedSessionPreview {
  return {
    sessionId,
    harnessSessionId: `harness-${sessionId}`,
    title,
    deletedAt: "2026-09-17T12:00:00.000Z",
  };
}

function createBackend(
  initialSessions: readonly TombstonedSessionPreview[],
): BackendPublishAndShareClient &
  BackendPurgeSessionClient &
  BackendListTombstonedSessionsClient & { state: BackendState } {
  const state: BackendState = {
    tombstoned: new Map(initialSessions.map((entry) => [entry.sessionId, entry])),
    active: new Map(),
    purged: new Set(),
    purgeCalls: [],
  };
  return {
    state,
    async submitAndCreateLink() {
      throw new Error("Unexpected publish in purge_sessions test");
    },
    async listTombstonedSessions() {
      return {
        sessions: [...state.tombstoned.values()],
      };
    },
    async purgeSession(sessionId: string) {
      state.purgeCalls.push(sessionId);

      if (state.customPurge) {
        return state.customPurge(sessionId);
      }

      const deleted = state.tombstoned.get(sessionId);
      if (deleted !== undefined) {
        state.tombstoned.delete(sessionId);
        state.purged.add(sessionId);
        return {
          sessionId,
          outcome: "purged",
          blobResults: [
            {
              pointer: {
                containerName: "sessions",
                blobKey: `${sessionId}-transcript`,
              },
              outcome: "deleted",
            },
          ],
        };
      }

      if (state.active.has(sessionId)) {
        throw new PurgeSessionNotTombstonedError(
          sessionId,
          `session ${sessionId} must be tombstoned before it can be purged`,
        );
      }

      throw new PurgeSessionNotFoundError(sessionId);
    },
  };
}

async function setup(
  backend: ReturnType<typeof createBackend>,
  confirm?: (request: ElicitRequest, state: BackendState) => ElicitResult | undefined,
) {
  const server = createServer(backend);
  const client = new Client(
    { name: "purge-sessions-test-client", version: "1.0.0" },
    { capabilities: confirm === undefined ? {} : { elicitation: { form: {} } } },
  );
  const confirmations: ElicitRequest[] = [];
  if (confirm !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      confirmations.push(request);
      ElicitRequestFormParamsSchema.parse(request.params);
      return confirm(request, backend.state);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    confirmations,
    backend,
    async close() {
      await client.close();
      if (server.isConnected()) {
        await server.close();
      }
    },
  };
}

function accepted(): ElicitResult {
  return { action: "accept", content: { confirm: true } };
}

function parseResultJson(result: Awaited<ReturnType<Client["callTool"]>>) {
  const payload = result.content[1];
  if (payload?.type !== "text") {
    throw new Error("Expected JSON payload block");
  }
  return JSON.parse(payload.text);
}

describe("purge_sessions", () => {
  it("happy path: previews and purges exactly the confirmed tombstoned set in one tool call", async () => {
    const backend = createBackend([session("sess_1"), session("sess_2")]);
    const run = await setup(backend, () => accepted());

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(1);
      const confirmation = ElicitRequestFormParamsSchema.parse(
        run.confirmations[0]!.params,
      );
      expect(confirmation.message).toContain("Permanently purge 2 tombstoned sessions?");
      expect(confirmation.message).toContain("sess_1");
      expect(confirmation.message).toContain("sess_2");
      expect(run.backend.state.purgeCalls).toEqual(["sess_1", "sess_2"]);
      expect(parseResultJson(result)).toEqual({
        previewCount: 2,
        previewedSessionIds: ["sess_1", "sess_2"],
        confirmation: "accepted",
        outcomes: [
          {
            sessionId: "sess_1",
            outcome: "purged",
            blobResults: [
              {
                pointer: {
                  containerName: "sessions",
                  blobKey: "sess_1-transcript",
                },
                outcome: "deleted",
              },
            ],
          },
          {
            sessionId: "sess_2",
            outcome: "purged",
            blobResults: [
              {
                pointer: {
                  containerName: "sessions",
                  blobKey: "sess_2-transcript",
                },
                outcome: "deleted",
              },
            ],
          },
        ],
      });
    } finally {
      await run.close();
    }
  });

  it("edge case: a session tombstoned after preview computation is excluded from that batch", async () => {
    const backend = createBackend([session("sess_1")]);
    const run = await setup(backend, (_request, state) => {
      state.tombstoned.set("sess_2", session("sess_2"));
      return accepted();
    });

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(run.backend.state.purgeCalls).toEqual(["sess_1"]);
      expect(parseResultJson(result)).toMatchObject({
        previewCount: 1,
        previewedSessionIds: ["sess_1"],
      });
      expect(run.backend.state.tombstoned.has("sess_2")).toBe(true);
    } finally {
      await run.close();
    }
  });

  it("edge case: previewed sessions restored or already purged before confirmation are skipped at execution time", async () => {
    const backend = createBackend([session("sess_1"), session("sess_2")]);
    const run = await setup(backend, (_request, state) => {
      const restored = state.tombstoned.get("sess_1");
      if (restored !== undefined) {
        state.tombstoned.delete("sess_1");
        state.active.set("sess_1", restored);
      }
      state.tombstoned.delete("sess_2");
      state.purged.add("sess_2");
      return accepted();
    });

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(run.backend.state.purgeCalls).toEqual(["sess_1", "sess_2"]);
      expect(parseResultJson(result)).toEqual({
        previewCount: 2,
        previewedSessionIds: ["sess_1", "sess_2"],
        confirmation: "accepted",
        outcomes: [
          {
            sessionId: "sess_1",
            outcome: "skipped",
            reason: "session was restored or otherwise no longer tombstoned",
          },
          {
            sessionId: "sess_2",
            outcome: "skipped",
            reason: "session was already purged before execution",
          },
        ],
      });
    } finally {
      await run.close();
    }
  });

  it("edge case: a declined confirmation leaves everything untouched", async () => {
    const backend = createBackend([session("sess_1")]);
    const run = await setup(backend, () => ({ action: "decline" } satisfies ElicitResult));

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(run.backend.state.purgeCalls).toEqual([]);
      expect(parseResultJson(result)).toMatchObject({
        previewCount: 1,
        confirmation: "declined",
        outcomes: [],
      });
    } finally {
      await run.close();
    }
  });

  it("edge case: an unanswered confirmation leaves everything untouched", async () => {
    const backend = createBackend([session("sess_1")]);

    await expect(
      purgeSessions(
        {},
        {
          backendClient: backend,
          confirm: async () => undefined,
        },
      ),
    ).resolves.toEqual({
      previewCount: 1,
      previewedSessionIds: ["sess_1"],
      confirmation: "unanswered",
      outcomes: [],
    });
    expect(backend.state.purgeCalls).toEqual([]);
  });

  it("edge case: bulk results preserve per-session partial failures after the row is purged", async () => {
    const backend = createBackend([session("sess_1"), session("sess_2")]);
    backend.state.customPurge = async (sessionId) => {
      backend.state.tombstoned.delete(sessionId);
      backend.state.purged.add(sessionId);
      return sessionId === "sess_1"
        ? {
            sessionId,
            outcome: "purged_with_blob_cleanup_failures",
            blobResults: [
              {
                pointer: { containerName: "sessions", blobKey: `${sessionId}-transcript` },
                outcome: "delete_failed",
                detail: "blob delete failed",
              },
            ],
          }
        : {
            sessionId,
            outcome: "purged",
            blobResults: [
              {
                pointer: { containerName: "sessions", blobKey: `${sessionId}-transcript` },
                outcome: "deleted",
              },
            ],
          };
    };
    const run = await setup(backend, () => accepted());

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(parseResultJson(result)).toMatchObject({
        confirmation: "accepted",
        outcomes: [
          {
            sessionId: "sess_1",
            outcome: "purged_with_blob_cleanup_failures",
            blobResults: [
              {
                pointer: { containerName: "sessions", blobKey: "sess_1-transcript" },
                outcome: "delete_failed",
                detail: "blob delete failed",
              },
            ],
          },
          {
            sessionId: "sess_2",
            outcome: "purged",
          },
        ],
      });
    } finally {
      await run.close();
    }
  });

  it("error path: never accepts an explicit id list argument", async () => {
    const backend = createBackend([session("sess_1")]);
    const run = await setup(backend, () => accepted());

    try {
      const result = await run.client.callTool({
        name: "purge_sessions",
        arguments: { sessionIds: ["sess_1"] },
      });

      expect(result.isError).toBe(true);
      expect(run.backend.state.purgeCalls).toEqual([]);
    } finally {
      await run.close();
    }
  });
});
