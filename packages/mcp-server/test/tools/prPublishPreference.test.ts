import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/index.js";
import {
  prPublishPreference,
  type PrPublishPreferenceDeps,
} from "../../src/tools/prPublishPreference.js";
import type { BackendPublishAndShareClient } from "../../src/tools/publishAndShare.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function connectClient() {
  const backend: BackendPublishAndShareClient = {
    async submitAndCreateLink() {
      throw new Error("Unexpected publish in pr_publish_preference test");
    },
  };
  const server = createServer(backend);
  const client = new Client({ name: "pr-publish-preference-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      if (server.isConnected()) {
        await server.close();
      }
    },
  };
}

describe("prPublishPreference (tool)", () => {
  it("delegates a check action to deps.check with the harness and reports its skipScope", async () => {
    const calls: { workspaceRoot: string; harness: "claude-code" }[] = [];
    const deps: PrPublishPreferenceDeps = {
      async check(input) {
        calls.push(input);
        return { skipScope: "user" };
      },
      async record() {
        throw new Error("record should not be called for a check action");
      },
    };

    await expect(
      prPublishPreference({ action: "check", workspaceRoot: "/repo", harness: "claude-code" }, deps),
    ).resolves.toEqual({ action: "check", skipScope: "user" });
    expect(calls).toEqual([{ workspaceRoot: "/repo", harness: "claude-code" }]);
  });

  it("delegates a record action to deps.record with the harness and chosen scope", async () => {
    const calls: { workspaceRoot: string; harness: "claude-code"; scope: "session" | "user" }[] = [];
    const deps: PrPublishPreferenceDeps = {
      async check() {
        throw new Error("check should not be called for a record action");
      },
      async record(input) {
        calls.push(input);
      },
    };

    await expect(
      prPublishPreference({ action: "record", workspaceRoot: "/repo", harness: "claude-code", scope: "session" }, deps),
    ).resolves.toEqual({ action: "record", scope: "session" });
    expect(calls).toEqual([{ workspaceRoot: "/repo", harness: "claude-code", scope: "session" }]);
  });

  it("advertises exact strict request shapes and harness literals", async () => {
    const connection = await connectClient();
    try {
      const { tools } = await connection.client.listTools();
      const tool = tools.find(({ name }) => name === "pr_publish_preference");

      expect(tool?.description).toContain(
        "{\"action\":\"check\",\"workspaceRoot\":\"<absolute-path>\",\"harness\":\"github-copilot-cli\"}",
      );
      expect(tool?.description).toContain("Do not send skipScope -- it is response-only.");
      expect(tool?.description).toContain(
        "{\"action\":\"record\",\"workspaceRoot\":\"<absolute-path>\",\"harness\":\"github-copilot-cli\",\"scope\":\"session\"}",
      );
      expect(tool?.description).toContain(
        "\"github-copilot-cli\", \"claude-code\", or \"codex-cli\"",
      );
    } finally {
      await connection.close();
    }
  });

  it("accepts the documented exact check and record request shapes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "prpp-tool-"));
    temporaryDirectories.push(workspaceRoot);
    const connection = await connectClient();
    try {
      const initial = await connection.client.callTool({
        name: "pr_publish_preference",
        arguments: { action: "check", workspaceRoot, harness: "github-copilot-cli" },
      });
      expect(initial.content).toEqual([{
        type: "text",
        text: JSON.stringify({ action: "check", skipScope: "none" }),
      }]);

      const recorded = await connection.client.callTool({
        name: "pr_publish_preference",
        arguments: {
          action: "record",
          workspaceRoot,
          harness: "github-copilot-cli",
          scope: "session",
        },
      });
      expect(recorded.content).toEqual([{
        type: "text",
        text: JSON.stringify({ action: "record", scope: "session" }),
      }]);

      const checked = await connection.client.callTool({
        name: "pr_publish_preference",
        arguments: { action: "check", workspaceRoot, harness: "github-copilot-cli" },
      });
      expect(checked.content).toEqual([{
        type: "text",
        text: JSON.stringify({ action: "check", skipScope: "session" }),
      }]);
    } finally {
      await connection.close();
    }
  });

  it("rejects response-only skipScope in a check request with an actionable error", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "prpp-tool-"));
    temporaryDirectories.push(workspaceRoot);
    const connection = await connectClient();
    try {
      const result = await connection.client.callTool({
        name: "pr_publish_preference",
        arguments: {
          action: "check",
          workspaceRoot,
          harness: "github-copilot-cli",
          skipScope: "none",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{
        type: "text",
        text: expect.stringContaining('Unrecognized key: "skipScope"'),
      }]);
    } finally {
      await connection.close();
    }
  });
});
