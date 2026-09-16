import { readFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NATIVE_CLI_HARNESSES, parseNativeSessionArchiveView } from "@session-registry/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { createHttpBackendClient } from "../src/httpBackendClient.js";
import { createNativeCaptureService } from "../src/native/captures.js";
import { acknowledgeFixtureWarnings, nativeFixture, nativeRecords, SESSION_ID, unpackNativeFixtureZip, writeRecords } from "./native/fixtures.js";

// Public web viewer rendering consumes the uploaded view through
// @session-registry/core fixtures, so this plugin-side test stays
// self-contained and only asserts the mcp-server publish pipeline (transcript,
// bundle, and archive-history correctness).

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("native source through publication and viewing", () => {
  const profiles = [
    ...NATIVE_CLI_HARNESSES.map((harness) => ({ harness, lifecycle: "new" })),
    { harness: "github-copilot-cli" as const, lifecycle: "resumed" },
    { harness: "claude-code" as const, lifecycle: "copied-fork" },
    { harness: "codex-cli" as const, lifecycle: "copied-fork" },
  ];
  it.each(profiles)("preserves $harness $lifecycle records through upload and the public viewer", async ({ harness, lifecycle }) => {
    const fixture = await nativeFixture(harness);
    directories.push(fixture.root);
    let records = fixture.records;
    if (lifecycle === "resumed") {
      records = [...records,
        { type: "session.resume", id: "reused", parentId: "not-retained", data: {} },
        { type: "model.future-record", id: "reused", data: { context: "RESUMED_SOURCE_NOT_A_NEW_CONVERSATION" } },
      ];
    } else if (lifecycle === "copied-fork" && harness === "claude-code") {
      records = [...nativeRecords(harness, "copied-parent"), ...records,
        { type: "system", subtype: "compact_boundary", logicalParentUuid: "not-retained" },
      ];
    } else if (lifecycle === "copied-fork" && harness === "codex-cli") {
      records = [{
        type: "session_meta", timestamp: "2026-09-10T20:00:00Z",
        payload: { id: SESSION_ID, cli_version: "0.154.0", history_mode: "legacy", forked_from_id: "22222222-2222-4222-8222-222222222222" },
      }, ...records.slice(1)];
    }
    await writeRecords(fixture.primary, records);
    let storedTranscript = "";
    let storedBundle: Uint8Array | undefined;
    const metadata: Record<string, unknown> = {};
    const pointer = { containerName: "transcripts", blobKey: "native-capture" };
    const bundlePointer = { containerName: "resumable-bundles", blobKey: "native-bundle" };
    const backend = createHttpBackendClient({
      baseUrl: "https://api.example.invalid",
      getAccessToken: async () => "fixture-owner",
      uploader: {
        async upload(content, _contentType, kind) {
          if (kind === "transcript" && typeof content === "string") {
            storedTranscript = content;
            return pointer;
          }
          if (kind === "resumable-bundle" && content instanceof Uint8Array) {
            storedBundle = content;
            return bundlePointer;
          }
          throw new Error("Unexpected native upload");
        },
      },
      fetch: async (_url, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected publish metadata");
        Object.assign(metadata, JSON.parse(init.body));
        expect(metadata.resumableBundlePointer).toEqual(bundlePointer);
        return new Response(JSON.stringify({
          sessionId: "published",
          harnessSessionId: SESSION_ID,
          linkId: "link",
          shareUrl: `https://web.example.invalid/session/${SESSION_ID}/link`,
          idempotentReplay: false,
        }), { status: 201 });
      },
    });
    const server = createServer(backend, createNativeCaptureService(fixture.options));
    const client = new Client({ name: "native-pipeline-fixture", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const prepared = await client.callTool({
        name: "prepare_session_capture", arguments: { harness, harnessSessionId: SESSION_ID },
      });
      const block = prepared.content[0];
      if (block?.type !== "text" || prepared.isError) throw new Error("Native preparation failed");
      const capture = JSON.parse(block.text);
      const result = await client.callTool({
        name: "publish_session",
        arguments: {
          captureId: capture.captureId, resolutions: acknowledgeFixtureWarnings(capture.findings), confirmed: true,
          title: "Native pipeline", summary: "The source record, not a generated excerpt.",
          audiencePolicy: { accessMode: "anonymous" },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(Array.from(storedBundle?.slice(0, 4) ?? [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(result.content[0]).toMatchObject({ text: `Published session ${SESSION_ID} and created share link link. View it at https://web.example.invalid/session/${SESSION_ID}/link` });
      const archived = parseNativeSessionArchiveView(storedTranscript);
      const preview = archived?.files[0]?.preview;
      expect(preview?.kind).toBe("text");
      if (preview?.kind !== "text") throw new Error("Expected the complete inspectable event-source preview");
      expect(preview.content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(records);
      expect(unpackNativeFixtureZip(storedBundle!).get(archived!.capture!.entrypoint)).toEqual(await readFile(fixture.primary));
      expect(archived?.resumable).toBe(false);
      expect(archived?.restoration?.status).toBe("not-verified");
      expect(archived?.capture?.history).toContainEqual(expect.objectContaining({
        path: archived?.capture?.entrypoint, sessionId: SESSION_ID,
      }));
    } finally {
      await client.close();
      if (server.isConnected()) await server.close();
    }
  });
});
