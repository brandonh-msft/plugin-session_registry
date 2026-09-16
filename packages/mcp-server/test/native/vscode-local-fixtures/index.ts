import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isValidHarnessSessionId } from "@session-registry/core";
import type { NativeObject } from "../../../src/native/files.js";
import type { VsCodeCaptureSource } from "../../../src/native/sourceTypes.js";

export const VSCODE_LOCAL_SESSION_ID = "chat-123456789";
export const VSCODE_LOCAL_WORKSPACE_ID = "0123456789abcdef0123456789abcdef";

// Native serializers at VS Code 1.137.0, 645f29cc3176500b4b5762ba887cf2a7f0ffdf2c,
// and main cbea5b4b6a964508352be917d3ddbdc6fc6e7a75. These are not Export Chat data.
export function vscodeLocalMessage(text: string): NativeObject {
  return {
    text,
    parts: [{
      kind: "text", text, range: { start: 0, endExclusive: text.length },
      editorRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 },
    }],
  };
}

export function vscodeLocalTool(): NativeObject {
  return {
    kind: "toolInvocationSerialized",
    invocationMessage: "Run the native command",
    pastTenseMessage: "Ran the native command",
    isConfirmed: { type: 4 },
    isComplete: true,
    source: { type: "internal" },
    toolCallId: "tool-call-1",
    toolId: "run_in_terminal",
    toolSpecificData: {
      kind: "terminal", language: "shellscript",
      commandLine: { original: "printf 'native output'", forDisplay: "native command" },
      terminalCommandOutput: { text: "FULL_NATIVE_STDOUT\nFULL_NATIVE_STDERR", truncated: false },
      terminalCommandState: { exitCode: 0, timestamp: 1789153200000, duration: 20 },
    },
    resultDetails: {
      input: "native input",
      output: [{ type: "embed", isText: true, value: "COMPLETE_NATIVE_RESULT" }],
      isError: false,
    },
  };
}

export function vscodeLocalRequest(id = "request-1", text = "NATIVE_USER_MESSAGE"): NativeObject {
  return {
    requestId: id, message: vscodeLocalMessage(text), variableData: { variables: [] },
    timestamp: 1789153200000,
    responseId: `response-${id}`,
    responseTimestamp: 1789153200100,
    response: [{ value: "NATIVE_ASSISTANT_RESPONSE", supportThemeIcons: false }, vscodeLocalTool()],
    modelState: { value: 1 },
    result: { metadata: { preserved: { nested: ["FULL", "PAYLOAD"], count: 0.125 } } },
    modeInfo: { kind: "ask" },
  };
}

export function vscodeLocalSession(overrides: NativeObject = {}): NativeObject {
  return {
    version: 3, sessionId: VSCODE_LOCAL_SESSION_ID, creationDate: 1789153190000,
    responderUsername: "GitHub Copilot", customTitle: "Native title",
    initialLocation: "panel", requests: [vscodeLocalRequest()],
    inputState: {
      attachments: [], mode: { id: "ask", kind: "ask" }, inputText: "UNSENT_NATIVE_DRAFT",
      selections: [], contrib: {},
    },
    workingDirectory: "file:///historical/workspace/not-current",
    ...overrides,
  };
}

export type VsCodeLocalFixtureLayout = "workspace" | "emptyWindowChatSessions" | "transferredChatSessions";

export interface VsCodeLocalFixtureOptions {
  readonly harnessSessionId?: string;
  readonly layout?: VsCodeLocalFixtureLayout;
  readonly format?: "json" | "jsonl";
}

export interface VsCodeLocalFixture {
  readonly root: string;
  readonly source: VsCodeCaptureSource;
  readonly input: { readonly harness: "vscode-copilot-chat"; readonly harnessSessionId: string };
  readonly store: string;
  readonly primary: string;
  readonly data: NativeObject;
  readonly records: readonly NativeObject[];
}

/** Writes one synthetic native source below a caller-owned absolute test root; cleanup belongs to the caller. */
export async function createVsCodeLocalFixture(
  root: string,
  options: VsCodeLocalFixtureOptions = {},
): Promise<VsCodeLocalFixture> {
  if (!isAbsolute(root)) throw new Error("Use an absolute, caller-owned test root.");
  const harnessSessionId = options.harnessSessionId ?? VSCODE_LOCAL_SESSION_ID;
  if (!isValidHarnessSessionId(harnessSessionId) || !/^[A-Za-z0-9_-]{1,128}$/.test(harnessSessionId) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(harnessSessionId)) {
    throw new Error("Use a safe native fixture session ID.");
  }
  const layout = options.layout ?? "workspace";
  const format = options.format ?? "json";
  if (layout === "transferredChatSessions" && format !== "json") {
    throw new Error("Native transferred fixtures must use flat JSON.");
  }
  const userDataPath = join(root, "user-data");
  const store = layout === "workspace"
    ? join(userDataPath, "User", "workspaceStorage", VSCODE_LOCAL_WORKSPACE_ID, "chatSessions")
    : join(userDataPath, "User", "globalStorage", layout);
  const primary = join(store, `${harnessSessionId}.${format}`);
  const data = vscodeLocalSession({ sessionId: harnessSessionId });
  const records: NativeObject[] = format === "jsonl" ? [{ kind: 0, v: data }] : [data];
  const content = format === "jsonl"
    ? records.map((record) => JSON.stringify(record)).join("\n") + "\n"
    : JSON.stringify(data, null, 2);
  await mkdir(store, { recursive: true });
  await writeFile(primary, content, { encoding: "utf8", flag: "wx" });
  return {
    root, store, primary, data, records,
    source: { userDataPath, copilotHome: join(root, "do-not-read-copilot-home") },
    input: { harness: "vscode-copilot-chat", harnessSessionId },
  };
}
