import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  FULL_FIDELITY_PUBLICATION_CONTRACT_ID,
  FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
  FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST,
  FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION,
  NATIVE_CLI_HARNESSES,
  parseNativeSessionArchive,
  type AudiencePolicy,
} from "@session-registry/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { createNativeCaptureService, type NativeCaptureService } from "../src/native/captures.js";
import type { BackendPublishAndShareClient } from "../src/tools/publishAndShare.js";
import type { PublishSubmission } from "../src/tools/publish.js";
import { acknowledgeFixtureWarnings, nativeFixture, SESSION_ID } from "./native/fixtures.js";

const PREPARE_PROMPT_NAME = "prepare_full_fidelity_publish_session";
const unusedCaptureService: NativeCaptureService = {
  async prepare() { throw new Error("Unexpected source access while discovering capabilities"); },
  async load() { throw new Error("Unexpected capture access while discovering capabilities"); },
  async review() { throw new Error("Unexpected capture review while discovering capabilities"); },
  async approveForPublish() { throw new Error("Unexpected capture approval while discovering capabilities"); },
  async discard() { throw new Error("Unexpected capture deletion while discovering capabilities"); },
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function recordingBackend() {
  const submissions: PublishSubmission[] = [];
  const audiences: AudiencePolicy[] = [];
  const backend: BackendPublishAndShareClient = {
    async submitAndCreateLink(submission, share) {
      submissions.push(submission);
      audiences.push(share.audiencePolicy);
      return {
        sessionId: "session-capability-test",
        harnessSessionId: submission.harnessSessionId,
        linkId: "link-capability-test",
        shareUrl: `https://sessions.example.com/session/${submission.harnessSessionId}/link-capability-test`,
        idempotentReplay: false,
      };
    },
  };
  return { submissions, audiences, backend };
}

async function connectClient(backend: BackendPublishAndShareClient, captures = unusedCaptureService) {
  const server = createServer(backend, captures);
  const client = new Client({ name: "server-capabilities-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  };
}

describe("MCP native capture capabilities", () => {
  it("advertises a deterministic optional prompt without reading sources or uploading", async () => {
    const backend = recordingBackend();
    const connection = await connectClient(backend.backend);
    try {
      expect(connection.client.getServerCapabilities()).toMatchObject({ prompts: {}, tools: {} });
      const { prompts } = await connection.client.listPrompts();
      expect(prompts.find(({ name }) => name === PREPARE_PROMPT_NAME)).toMatchObject({
        name: PREPARE_PROMPT_NAME,
        description: expect.stringContaining(FULL_FIDELITY_PUBLICATION_CONTRACT_ID),
      });
      const first = await connection.client.getPrompt({ name: PREPARE_PROMPT_NAME });
      expect(first.messages).toEqual([{
        role: "user", content: { type: "text", text: FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST },
      }]);
      expect(await connection.client.getPrompt({ name: PREPARE_PROMPT_NAME })).toEqual(first);
      expect(backend.submissions).toEqual([]);
      const { tools } = await connection.client.listTools();
      for (const importName of ["import_session_bundle", "read_import_slice", "close_import"]) {
        const imported = tools.find(({ name }) => name === importName);
        expect(imported?.inputSchema.additionalProperties).toBe(false);
        expect(imported?.description.length).toBeGreaterThan(100);
      }
      expect(tools.find(({ name }) => name === "import_session_bundle")?.inputSchema.required).toEqual(["bundlePath"]);
      expect(tools.find(({ name }) => name === "read_import_slice")?.inputSchema.required).toEqual(["importHandle", "filter"]);
      expect(tools.find(({ name }) => name === "close_import")?.inputSchema.required).toEqual(["importHandle"]);
      const publish = tools.find(({ name }) => name === "publish_session");
      expect(publish?.description).toContain(FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION);
      expect(publish?.inputSchema.properties).not.toHaveProperty("transcript");
      expect(publish?.inputSchema.properties).not.toHaveProperty("artifacts");
      expect(publish?.inputSchema.properties).toHaveProperty("captureId");
      expect(publish?.inputSchema.additionalProperties).toBe(false);
      const prepare = tools.find(({ name }) => name === "prepare_session_capture");
      for (const property of ["harness", "harnessSessionId", "sourcePath", "dependencyPaths", "dependencyMappings"]) {
        expect(prepare?.inputSchema.properties).toHaveProperty(property);
      }
      expect(prepare?.inputSchema.additionalProperties).toBe(false);
      expect(prepare?.description).toContain(FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE);
      expect(JSON.stringify(publish?.inputSchema.properties?.title)).toContain("Auto-generate");
      expect(JSON.stringify(publish?.inputSchema.properties?.summary)).toContain("Auto-generate");
      expect(JSON.stringify(publish?.inputSchema.properties?.expiresAt)).toContain("14-day default");
      expect(publish?.inputSchema.required).not.toContain("audiencePolicy");
      expect(JSON.stringify(publish?.inputSchema.properties?.audiencePolicy)).toContain("Anyone (anonymous)");
    } finally {
      await connection.close();
    }
  });

  it("recovers after an unknown prompt without weakening preparation", async () => {
    const connection = await connectClient(recordingBackend().backend);
    try {
      await expect(connection.client.getPrompt({ name: "unknown-prompt" })).rejects.toSatisfy(
        (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams,
      );
      expect((await connection.client.getPrompt({ name: PREPARE_PROMPT_NAME })).messages[0]).toMatchObject({
        content: { text: FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST },
      });
    } finally {
      await connection.close();
    }
  });

  it.each(NATIVE_CLI_HARNESSES)("publishes %s source records even when the client never retrieves prompts", async (harness) => {
    const fixture = await nativeFixture(harness);
    directories.push(fixture.root);
    const backend = recordingBackend();
    const connection = await connectClient(backend.backend, createNativeCaptureService(fixture.options));
    try {
      const result = await connection.client.callTool({
        name: "prepare_session_capture",
        arguments: { harness, harnessSessionId: SESSION_ID },
      });
      expect(result.isError).not.toBe(true);
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected capture metadata");
      const prepared = JSON.parse(block.text);
      expect(prepared.captureId).toMatch(/^[a-f0-9]{64}$/);
      expect(prepared.recordCount).toBe(fixture.records.length);
      expect(prepared.nativeBundle).toBe(true);
      expect(prepared.resumable).toBe(false);
      expect(prepared.restoration.status).toBe("not-verified");
      expect(prepared).not.toHaveProperty("transcript");
      expect(prepared.nextStep).toEqual({
        tool: "save_session",
        instructions: FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
      });
      expect(backend.submissions).toHaveLength(0);

      const proposal = {
        captureId: prepared.captureId, resolutions: acknowledgeFixtureWarnings(prepared.findings),
        title: "Repair missing test fixture",
        summary: "Investigated the missing fixture, retained the failed test output, and prepared the corrected fixture.",
      };
      const unconfirmed = await connection.client.callTool({
        name: "publish_session", arguments: { ...proposal, confirmed: false },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(backend.submissions).toHaveLength(0);
      const published = await connection.client.callTool({
        name: "publish_session",
        arguments: { ...proposal, confirmed: true },
      });
      expect(published.isError).not.toBe(true);
      expect(published.content[0]).toMatchObject({
        type: "text", text: expect.stringContaining(`https://sessions.example.com/session/${SESSION_ID}/`),
      });
      expect(backend.submissions).toHaveLength(1);
      expect(backend.submissions[0]).toMatchObject({ title: proposal.title, summary: proposal.summary });
      expect(backend.audiences).toEqual([{ accessMode: "anonymous" }]);
      const captured = parseNativeSessionArchive(backend.submissions[0]!.transcript);
      expect(captured?.files[0]?.content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(fixture.records);
    } finally {
      await connection.close();
    }
  });

  it("requires separate owner acknowledgment for retained unscannable native content", async () => {
    const fixture = await nativeFixture("github-copilot-cli");
    directories.push(fixture.root);
    const bytes = Buffer.from([0xff, 0, 0xc3, 0x28]);
    await writeFile(join(dirname(fixture.primary), "native-asset.bin"), bytes);
    const backend = recordingBackend();
    const connection = await connectClient(backend.backend, createNativeCaptureService(fixture.options));
    try {
      const result = await connection.client.callTool({
        name: "prepare_session_capture",
        arguments: { harness: "github-copilot-cli", harnessSessionId: SESSION_ID, sourcePath: fixture.primary },
      });
      expect(result.isError).not.toBe(true);
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected capture metadata");
      const prepared: { captureId: string; reviewState: string; findings: { id: string }[] } = JSON.parse(block.text);
      expect(prepared.reviewState).toBe("needs-review");
      expect(prepared.findings.length).toBeGreaterThan(0);
      const request = {
        captureId: prepared.captureId, confirmed: true,
        title: "Native asset", summary: "The owner reviews unscannable state separately.",
        audiencePolicy: { accessMode: "anonymous" },
      };
      const unreviewed = await connection.client.callTool({
        name: "publish_session", arguments: { ...request, resolutions: [] },
      });
      expect(unreviewed.isError).toBe(true);
      expect(backend.submissions).toHaveLength(0);
      const notAcknowledged = await connection.client.callTool({
        name: "publish_session", arguments: {
          ...request, resolutions: prepared.findings.map(({ id }) => ({ findingId: id, action: { kind: "false-positive" } })),
        },
      });
      expect(notAcknowledged.isError).toBe(true);
      expect(backend.submissions).toHaveLength(0);
      const approved = await connection.client.callTool({
        name: "publish_session", arguments: {
          ...request, resolutions: prepared.findings.map(({ id }) => ({ findingId: id, action: { kind: "acknowledge-unscanned" } })),
        },
      });
      expect(approved.isError).not.toBe(true);
      const archive = parseNativeSessionArchive(backend.submissions[0]!.transcript);
      const asset = archive?.files.find((file) => file.path === "native-asset.bin");
      expect(asset?.contentEncoding).toBe("base64");
      expect(Buffer.from(asset!.content, "base64")).toEqual(bytes);
    } finally {
      await connection.close();
    }
  });

  it("rejects inline transcript substitution and unsupported harnesses without source or backend access", async () => {
    const backend = recordingBackend();
    const connection = await connectClient(backend.backend);
    try {
      const legacy = await connection.client.callTool({
        name: "publish_session",
        arguments: {
          captureId: "a".repeat(64), resolutions: [], confirmed: true,
          title: "Legacy excerpt", summary: "Must not publish.",
          audiencePolicy: { accessMode: "anonymous" },
          transcript: "user: hello\nassistant: done",
        },
      });
      expect(legacy.isError).toBe(true);
      const unsupported = await connection.client.callTool({
        name: "prepare_session_capture",
        arguments: { harness: "arbitrary-harness", harnessSessionId: SESSION_ID },
      });
      expect(unsupported.isError).toBe(true);
      expect(backend.submissions).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it("does not turn incomplete restricted access or invalid policies into anonymous access", async () => {
    const backend = recordingBackend();
    const connection = await connectClient(backend.backend);
    try {
      for (const audiencePolicy of [null, {}, { accessMode: "authenticated" }, { accessMode: "authenticated", rules: [] }]) {
        const result = await connection.client.callTool({
          name: "publish_session",
          arguments: {
            captureId: "a".repeat(64), resolutions: [], confirmed: true,
            title: "Agent-generated title", summary: "Agent-generated summary.",
            audiencePolicy,
          },
        });
        expect(result.isError).toBe(true);
      }
      expect(backend.submissions).toEqual([]);
    } finally {
      await connection.close();
    }
  });
});
