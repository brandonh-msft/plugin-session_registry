import { readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isValidHarnessSessionId } from "@session-registry/core";
import type { NativeHomes } from "../../../src/native/adapters.js";
import type { NativeObject } from "../../../src/native/files.js";
import type { NativeCaptureInput, NativeIdeSources, VsCodeCaptureSource } from "../../../src/native/sourceTypes.js";

export const VSCODE_AGENT_SDK_ID = "11111111-1111-4111-8111-111111111111";
export const VSCODE_AGENT_HOST_ID = "22222222-2222-4222-8222-222222222222";
export const VSCODE_AGENT_FIXTURE_TIME = "2026-09-11T19:00:00.000Z";
export const VSCODE_AGENT_SCHEMA_V12_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema-v12.sql"), "utf8");

export interface VsCodeAgentHostFixtureOptions {
  readonly harnessSessionId?: string;
  readonly hostSessionId?: string;
}

export interface VsCodeAgentHostFixture {
  readonly root: string;
  readonly input: NativeCaptureInput & { readonly harness: "vscode-copilot-agent" };
  readonly source: VsCodeCaptureSource;
  readonly sources: NativeIdeSources;
  readonly homes: NativeHomes;
  readonly dbPath: string;
  readonly eventPath: string;
  readonly chatUri: string;
  readonly attachmentPath: string;
}

export function vscodeAgentEvents(harnessSessionId = VSCODE_AGENT_SDK_ID): NativeObject[] {
  const values: readonly (readonly [string, NativeObject])[] = [
    ["session.start", { sessionId: harnessSessionId, version: 1, copilotVersion: "1.0.84-2", producer: "copilot-agent", startTime: VSCODE_AGENT_FIXTURE_TIME }],
    ["user.message", { content: "SDK_FIRST_USER" }],
    ["tool.execution_start", { toolCallId: "edit-z", toolName: "edit", arguments: { path: "not-a-source-file.txt" } }],
    ["tool.execution_complete", { toolCallId: "edit-z", success: true, result: { content: "SDK_EDIT_RESULT" } }],
    ["assistant.message", { messageId: "reply-z", content: "SDK_FIRST_REPLY" }],
    ["user.message", { content: "SDK_SECOND_USER" }],
    ["tool.execution_start", { toolCallId: "edit-a", toolName: "create", arguments: { path: "another-nonexistent-file.txt" } }],
    ["tool.execution_complete", { toolCallId: "edit-a", success: true, result: { content: "SDK_CREATED" } }],
    ["assistant.message", { messageId: "reply-a", content: "SDK_SECOND_REPLY" }],
  ];
  return values.map(([type, data], index) => ({
    type, data, id: `event-${index}`, parentId: index === 0 ? null : `event-${index - 1}`, timestamp: VSCODE_AGENT_FIXTURE_TIME,
  }));
}

/**
 * Create synthetic SDK events and host state using the source-pinned v1-v12 migrations.
 * Supply a dedicated empty directory; the caller owns cleanup. No Vitest or test-module
 * imports, environment mutation, capture-service invocation, or real native stores.
 */
export async function createVsCodeAgentHostFixture(
  directory: string,
  options: VsCodeAgentHostFixtureOptions = {},
): Promise<VsCodeAgentHostFixture> {
  const harnessSessionId = options.harnessSessionId ?? VSCODE_AGENT_SDK_ID;
  const hostSessionId = options.hostSessionId ?? harnessSessionId;
  for (const id of [harnessSessionId, hostSessionId]) {
    if (!isValidHarnessSessionId(id) || id.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
      throw new Error("Synthetic fixture IDs must be URL-safe native session IDs.");
    }
  }
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length !== 0) {
    throw new Error("The VS Code fixture requires a dedicated empty directory; existing files were not modified.");
  }
  const userDataPath = join(root, "user-data");
  const copilotHome = join(root, "copilot");
  const dbPath = join(userDataPath, "agentSessionData", hostSessionId, "session.db");
  const eventPath = join(copilotHome, "session-state", harnessSessionId, "events.jsonl");
  await mkdir(dirname(dbPath), { recursive: true });
  await mkdir(dirname(eventPath), { recursive: true });
  await writeFile(eventPath, vscodeAgentEvents(harnessSessionId).map((record) => JSON.stringify(record)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
  const encoded = Buffer.from(`copilot:/${hostSessionId}`).toString("base64url");
  const chatUri = `ahp-chat://default/${encoded}`;
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(VSCODE_AGENT_SCHEMA_V12_SQL);
    database.prepare("INSERT INTO session_metadata (key, value) VALUES (?, ?)").run("defaultChatProviderData", JSON.stringify({ sdkSessionId: harnessSessionId }));
    database.prepare("INSERT INTO session_metadata (key, value) VALUES (?, ?)").run("peerChats", "[]");
    database.prepare("INSERT INTO session_metadata (key, value) VALUES (?, ?)").run("customTitle", "HOST_TITLE");
    database.prepare("INSERT INTO turns (id, event_id) VALUES (?, ?)").run("turn-z", "event-1");
    database.prepare("INSERT INTO turns (id, event_id) VALUES (?, ?)").run("turn-a", "event-5");
    database.prepare(`INSERT INTO file_edits
      (turn_id, tool_call_id, file_path, before_content, after_content, added_lines, removed_lines)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run("turn-z", "edit-z", "unavailable-workspace.txt", Buffer.from("HOST_BEFORE\n"), Buffer.from("HOST_AFTER\n"), 1, 1);
    database.prepare(`INSERT INTO file_edits
      (turn_id, tool_call_id, file_path, edit_type, before_content, after_content, added_lines, removed_lines)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("turn-a", "edit-a", "unavailable-created.txt", "create", null, Buffer.from("HOST_CREATED\n"), 1, 0);
    database.prepare("INSERT INTO chat_drafts (chat_uri, draft) VALUES (?, ?)").run(chatUri, JSON.stringify({
      text: "HOST_DRAFT", origin: { kind: "user" },
    }));
    database.prepare("INSERT INTO local_turns (turn_id, chat_uri, anchor_turn_id, seq, payload) VALUES (?, ?, ?, ?, ?)").run(
      "local-z", chatUri, "turn-z", 9223372036854775807n, JSON.stringify({
        id: "local-z", message: { text: "HOST_LOCAL_TURN", origin: { kind: "user" } },
        responseParts: [{ kind: "markdown", id: "local-response", content: "HOST_LOCAL_REPLY" }], state: "complete",
      }),
    );
    database.prepare("INSERT INTO turn_usage (turn_id, usage) VALUES (?, ?)").run("turn-z", JSON.stringify({ inputTokens: 12, outputTokens: 7 }));
    database.prepare("INSERT INTO reviewed_files (uri, nonce) VALUES (?, ?)").run("file:///unavailable-workspace.txt", "native-reviewed-nonce");
  } finally {
    database.close();
  }
  const source = { userDataPath, copilotHome };
  return {
    root,
    input: {
      harness: "vscode-copilot-agent", harnessSessionId,
      ...(hostSessionId === harnessSessionId ? {} : { hostSessionId }),
    },
    source,
    sources: { vscode: source },
    homes: {
      "github-copilot-cli": join(root, "unused-cli-home"),
      "claude-code": join(root, "unused-claude-home"),
      "codex-cli": join(root, "unused-codex-home"),
    },
    dbPath,
    eventPath,
    chatUri,
    attachmentPath: join(userDataPath, "agentSessionData", `default-${encoded}`, "attachments", "snapshot-id", "note.txt"),
  };
}
