import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNativeSessionArchive } from "@session-registry/core";
import { NativeFiles, type NativeObject, type NativeValue } from "../../src/native/files.js";
import { captureVsCodeLocalSession } from "../../src/native/vscodeLocal.js";
import {
  createVsCodeLocalFixture,
  VSCODE_LOCAL_SESSION_ID as ID,
  VSCODE_LOCAL_WORKSPACE_ID as WORKSPACE,
  vscodeLocalMessage as message,
  vscodeLocalRequest as request,
  vscodeLocalSession as session,
  vscodeLocalTool as tool,
  type VsCodeLocalFixtureLayout as Layout,
} from "./vscode-local-fixtures/index.js";

const NOW = "2026-09-11T20:00:00.000Z";
const MAX_BYTES = 8 * 1024 * 1024;
const INPUT = { harness: "vscode-copilot-chat" as const, harnessSessionId: ID };
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJson(path: string, value: NativeValue): Promise<void> {
  await write(path, JSON.stringify(value, null, 2));
}

async function writeLog(path: string, records: NativeValue[]): Promise<void> {
  await write(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

async function fixture(layout: Layout = "workspace", log = false) {
  const root = resolve("test", "native", "vscode-local-fixtures", randomUUID());
  roots.push(root);
  const native = await createVsCodeLocalFixture(root, { layout, format: log ? "jsonl" : "json" });
  return {
    ...native,
    capture: (maxBytes = MAX_BYTES) => captureVsCodeLocalSession(native.input, native.source, maxBytes, () => new Date(NOW)),
  };
}

function records(content: string): NativeValue[] {
  return content.trimEnd().split("\n").map((line) => JSON.parse(line) as NativeValue);
}

function uri(path = "/historical/file.ts"): NativeObject {
  return { $mid: 1, scheme: "file", path };
}

function prototypeSnapshot(target: object) {
  return {
    parent: Object.getPrototypeOf(target),
    properties: new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!])),
  };
}

function expectUnchangedPrototype(target: object, before: ReturnType<typeof prototypeSnapshot>): void {
  expect(Object.getPrototypeOf(target)).toBe(before.parent);
  expect(Reflect.ownKeys(target)).toEqual([...before.properties.keys()]);
  for (const [key, previous] of before.properties) {
    const current = Object.getOwnPropertyDescriptor(target, key)!;
    expect(current.value, String(key)).toBe(previous.value);
    expect(current.get, String(key)).toBe(previous.get);
    expect(current.set, String(key)).toBe(previous.set);
    expect(current.writable, String(key)).toBe(previous.writable);
    expect(current.enumerable, String(key)).toBe(previous.enumerable);
    expect(current.configurable, String(key)).toBe(previous.configurable);
  }
}

async function editing(f: Awaited<ReturnType<typeof fixture>>, options: { workspace?: string; privateContent?: boolean } = {}) {
  const path = join(f.source.userDataPath, "User", "workspaceStorage", options.workspace ?? WORKSPACE, "chatEditingSessions", ID);
  const before = "ORIGINAL_NATIVE_FILE\n";
  const after = options.privateContent ? "const safe = true;\nAPI_KEY=PRIVATE_EDIT_SECRET\n" : "MODIFIED_NATIVE_FILE\n";
  const obsolete = "OLDER_PERSISTED_NATIVE_FILE\n";
  const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 7);
  const beforeHash = hash(before);
  const afterHash = hash(after);
  const obsoleteHash = hash(obsolete);
  const state: NativeObject = {
    version: 2,
    initialFileContents: [["file:///historical/file.ts", beforeHash]],
    recentSnapshot: {
      entries: [{
        resource: "file:///historical/file.ts", languageId: "typescript",
        originalHash: beforeHash, currentHash: afterHash, state: 0,
        snapshotUri: "chat-editing-snapshot:///historical/file.ts",
        telemetryInfo: { requestId: "request-1", agentId: "github.copilot", modeId: "agent" },
      }],
    },
    timeline: {
      checkpoints: [{ checkpointId: "checkpoint-1", requestId: "request-1", epoch: 1, label: "Native checkpoint" }],
      fileBaselines: [["file:///historical/file.ts::request-1", {
        uri: uri(), requestId: "request-1", content: before, epoch: 0,
        telemetryInfo: { requestId: "request-1" },
      }]],
      operations: [{
        type: "textEdit", uri: uri(), requestId: "request-1", epoch: 1,
        edits: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "MODIFIED" }],
      }],
      currentEpoch: 1, epochCounter: 1,
    },
  };
  await writeJson(join(path, "state.json"), state);
  await write(join(path, "contents", beforeHash), before);
  await write(join(path, "contents", afterHash), after);
  await write(join(path, "contents", obsoleteHash), obsolete);
  return { path, state, before, after, obsolete, beforeHash, afterHash, obsoleteHash };
}

describe("VS Code Local native capture", () => {
  it.each(["json", "jsonl"] as const)("exposes reusable %s input, source and records for integration tests", async (format) => {
    const f = await fixture();
    const native = await createVsCodeLocalFixture(f.root, { harnessSessionId: "chat-integration", format });
    const archive = await captureVsCodeLocalSession(native.input, native.source, MAX_BYTES, () => new Date(NOW));
    expect(native.input).toEqual({ harness: "vscode-copilot-chat", harnessSessionId: "chat-integration" });
    expect(native.data.sessionId).toBe(native.input.harnessSessionId);
    expect(native.primary).toBe(join(native.store, `chat-integration.${format}`));
    expect(records(archive.files[0]!.content)).toEqual(native.records);
    expect(archive.files[0]!.recordCount).toBe(native.records.length);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("keeps reusable fixture writes within a caller-owned root and does not overwrite existing sources", async () => {
    const f = await fixture();
    const before = await readFile(f.primary, "utf8");
    await expect(createVsCodeLocalFixture("relative-root")).rejects.toThrow("absolute");
    await expect(createVsCodeLocalFixture(f.root, { harnessSessionId: "../escape" })).rejects.toThrow("safe native fixture session ID");
    await expect(createVsCodeLocalFixture(f.root)).rejects.toThrow("EEXIST");
    expect(await readFile(f.primary, "utf8")).toBe(before);
  });

  it("preserves the complete flat native envelope, IDs, draft and tool payloads", async () => {
    const f = await fixture();
    const archive = await f.capture();
    expect(archive).toMatchObject({
      format: "session-registry/native-session/3",
      harness: { name: "vscode-copilot-chat", version: "not-recorded" },
      harnessSessionId: ID, capturedAt: NOW, sourceFormat: "vscode-chat-session-v3-json",
      scope: "persisted-session-records", resumable: false, redactions: [],
    });
    expect(archive.files).toHaveLength(1);
    expect(archive.files[0]).toMatchObject({
      path: `User/workspaceStorage/${WORKSPACE}/chatSessions/${ID}.json`, kind: "events", recordCount: 1,
    });
    expect(records(archive.files[0]!.content)).toEqual([session()]);
    expect(archive.files[0]!.content).not.toContain("contentForModel");
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("preserves every numeric operation and its original ordering, including replaced history", async () => {
    const f = await fixture("workspace", true);
    const initial = session({ pendingRequests: [], hasPendingEdits: false });
    const queued = request("request-queued");
    for (const key of ["response", "responseId", "responseTimestamp", "result", "modelState"]) delete queued[key];
    const operations: NativeObject[] = [
      { kind: 0, v: initial },
      { kind: 1, k: ["customTitle"], v: "CHANGED_TITLE" },
      { kind: 1, k: ["requests", 0, "message", "text"], v: "UPDATED_NATIVE_MESSAGE" },
      { kind: 1, k: ["requests", 0, "message", "parts"], v: message("UPDATED_NATIVE_MESSAGE").parts! },
      { kind: 2, k: ["requests", 0, "response"], i: 1, v: [{ value: "APPENDED_RESPONSE" }, tool()] },
      { kind: 2, k: ["requests"], v: [request("request-2", "PRESERVE_REMOVED_REQUEST")] },
      { kind: 1, k: ["requests", 0, "result"], v: { metadata: { nested: { keep: "FULL_REPLACEMENT_PAYLOAD" } } } },
      { kind: 1, k: ["customTitle"] },
      { kind: 3, k: ["inputState"] },
      { kind: 1, k: ["inputState"], v: session().inputState! },
      { kind: 2, k: ["requests"], i: 1 },
      { kind: 2, k: ["pendingRequests"], v: [{
        id: "request-queued", kind: "queued", request: queued, sendOptions: { modeInfo: { kind: "agent" } },
      }] },
    ];
    await writeLog(f.primary, operations);
    const archive = await f.capture();
    expect(archive.sourceFormat).toBe("vscode-chat-session-v3-operation-log");
    expect(archive.files).toHaveLength(1);
    expect(archive.files[0]!.recordCount).toBe(operations.length);
    expect(records(archive.files[0]!.content)).toEqual(operations);
    expect(archive.files[0]!.content).toContain("PRESERVE_REMOVED_REQUEST");
    expect(archive.redactions).toEqual([]);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("accepts a push creating an optional response array and preserves CRLF record boundaries", async () => {
    const f = await fixture("workspace", true);
    const unanswered = request();
    delete unanswered.response;
    const operations = [{ kind: 0, v: session({ requests: [unanswered] }) }, { kind: 2, k: ["requests", 0, "response"], v: [{ value: "ANSWER" }] }];
    await write(f.primary, operations.map((operation) => JSON.stringify(operation)).join("\r\n") + "\r\n");
    expect(records((await f.capture()).files[0]!.content)).toEqual(operations);
  });

  it("validates changing requests without repeatedly walking unrelated historical requests", async () => {
    const f = await fixture("workspace", true);
    const history = Array.from({ length: 100 }, (_value, index) => request(`request-${index}`));
    const operations: NativeObject[] = [{ kind: 0, v: session({ requests: history }) }];
    for (let index = 0; index < 500; index++) {
      operations.push({ kind: 2, k: ["requests", 99, "response"], i: 0, v: [{ value: `NATIVE_INCREMENT_${index}` }] });
    }
    await writeLog(f.primary, operations);
    expect(records((await f.capture()).files[0]!.content)).toEqual(operations);
  });

  it.each(["emptyWindowChatSessions", "transferredChatSessions"] as const)("finds default-profile %s without assuming a CLI source", async (layout) => {
    const f = await fixture(layout);
    expect((await f.capture()).files[0]!.path).toBe(`User/globalStorage/${layout}/${ID}.json`);
  });

  it("accepts the legacy no-workspace flat location without migrating or inventing identity", async () => {
    const f = await fixture();
    await rm(f.primary);
    await writeJson(join(f.source.userDataPath, "User", "workspaceStorage", "no-workspace", "chatSessions", `${ID}.json`), session());
    expect((await f.capture()).files[0]!.path).toContain("/no-workspace/");
  });

  it("uses an existing operation log rather than a stale flat file in the same store", async () => {
    const f = await fixture("workspace", true);
    const flat = join(f.store, `${ID}.json`);
    await writeJson(flat, session({ customTitle: "STALE_TITLE" }));
    await utimes(flat, new Date(0), new Date(0));
    expect((await f.capture()).files.map((file) => file.path)).toEqual([`User/workspaceStorage/${WORKSPACE}/chatSessions/${ID}.jsonl`]);
    expect((await f.capture()).files[0]!.content).not.toContain("STALE_TITLE");
  });

  it("never falls back to flat JSON when the preferred operation log is malformed", async () => {
    const f = await fixture("workspace", true);
    const flat = join(f.store, `${ID}.json`);
    await writeJson(flat, session());
    await utimes(flat, new Date(0), new Date(0));
    await write(f.primary, '{"kind":0,"v":\n');
    await expect(f.capture()).rejects.toThrow("MALFORMED_SOURCE");
  });

  it("rejects conflicting newer flat history and log files instead of guessing a setting", async () => {
    const f = await fixture("workspace", true);
    await utimes(f.primary, new Date(0), new Date(0));
    await writeJson(join(f.store, `${ID}.json`), session({ customTitle: "NEWER_FLAT_HISTORY" }));
    await expect(f.capture()).rejects.toThrow("AMBIGUOUS_SESSION");
  });

  it("does not read other sessions, CLI home, profile stores, or current URI-referenced files", async () => {
    const f = await fixture();
    await write(join(f.store, "other-session.jsonl"), "INVALID_OTHER_SESSION_MUST_NOT_BE_READ");
    const ignored = join(f.source.userDataPath, "User", "profiles", "other-profile", "globalStorage", "emptyWindowChatSessions", `${ID}.json`);
    await writeJson(ignored, session());
    const referenced = join(f.root, "current-private-workspace-file.txt");
    await write(referenced, "DO_NOT_READ_CURRENT_WORKSPACE");
    const data = request();
    data.variableData = { variables: [{ kind: "file", id: "context-file", name: "file.ts", value: uri(referenced) }] };
    await writeJson(f.primary, session({ requests: [data] }));
    const spy = vi.spyOn(NativeFiles.prototype, "read");
    const archive = await f.capture();
    expect(archive.files).toHaveLength(1);
    expect(archive.files[0]!.content).not.toContain("DO_NOT_READ_CURRENT_WORKSPACE");
    expect(spy.mock.calls.every(([path]) => path.endsWith(`${ID}.json`))).toBe(true);
  });

  it.each([
    ["an export without native identity", { responderUsername: "Copilot", requests: [] }],
    ["v2", session({ version: 2 })],
    ["a future version", session({ version: 4 })],
    ["a mismatching session", session({ sessionId: "chat-different" })],
    ["a missing creation date", { ...session(), creationDate: null }],
    ["an unknown top-level schema field", session({ futureNativeState: { private: "DO_NOT_UPLOAD" } })],
  ])("rejects %s", async (_name, value) => {
    const f = await fixture();
    await writeJson(f.primary, value);
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it.each(["../chat", "..", "chat/other", "chat\\other", "chat:stream", "%2e%2e", "CON", "chat.", "chat\u0000"])("rejects unsafe session ID %j", async (id) => {
    const f = await fixture();
    await expect(captureVsCodeLocalSession({ ...INPUT, harnessSessionId: id }, f.source, MAX_BYTES)).rejects.toThrow("INVALID_SESSION_ID");
  });

  it("rejects another harness or an unused hostSessionId", async () => {
    const f = await fixture();
    await expect(captureVsCodeLocalSession({ ...INPUT, harness: "github-copilot-cli" }, f.source, MAX_BYTES)).rejects.toThrow("UNSUPPORTED_HARNESS");
    await expect(captureVsCodeLocalSession({ ...INPUT, hostSessionId: "ignored-host" }, f.source, MAX_BYTES)).rejects.toThrow("INVALID_CAPTURE_INPUT");
  });

  it("rejects duplicate exact IDs in different stores without choosing by age", async () => {
    const f = await fixture();
    await writeJson(join(f.source.userDataPath, "User", "globalStorage", "emptyWindowChatSessions", `${ID}.json`), session());
    await expect(f.capture()).rejects.toThrow("AMBIGUOUS_SESSION");
  });

  it("rejects missing exact IDs and does not inspect other histories to synthesize a match", async () => {
    const f = await fixture();
    await rm(f.primary);
    await writeJson(join(f.store, "not-the-requested-id.json"), session());
    await expect(f.capture()).rejects.toThrow("SESSION_NOT_FOUND");
  });

  it("rejects a transferred operation log, which the pinned transfer reader does not use", async () => {
    const f = await fixture("transferredChatSessions");
    await writeLog(join(f.store, `${ID}.jsonl`), [{ kind: 0, v: session() }]);
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it("rejects root, workspace, and chat-store junctions, including links inside the configured root", async () => {
    const f = await fixture();
    const rootLink = join(f.root, "linked-user-data");
    await symlink(f.source.userDataPath, rootLink, "junction");
    await expect(captureVsCodeLocalSession(INPUT, { ...f.source, userDataPath: rootLink }, MAX_BYTES)).rejects.toThrow("UNSAFE_SOURCE_PATH");
    await rm(rootLink);
    const workspaceLink = join(f.source.userDataPath, "User", "workspaceStorage", "linked-workspace");
    await symlink(dirname(f.store), workspaceLink, "junction");
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
    await rm(workspaceLink);
    const otherStore = join(f.source.userDataPath, "saved-store");
    await writeJson(join(otherStore, `${ID}.json`), session());
    await rm(f.store, { recursive: true });
    await symlink(otherStore, f.store, "junction");
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
  });

  it("rejects wrong-case identifier aliases", async () => {
    const f = await fixture();
    await rm(f.primary);
    await writeJson(join(f.store, `${ID.toUpperCase()}.json`), session());
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
  });

  it.each([
    '{"version":3,',
    JSON.stringify(session()).replace('"version":3', '"version":3,"version":3'),
    JSON.stringify(session()).replace('"version":3', '"version":3,"\\u0076ersion":3'),
    JSON.stringify(session()).replace('"preserved":', '"preserved":{},"preserved":'),
  ])("rejects malformed or duplicate-key flat JSON", async (json) => {
    const f = await fixture();
    await write(f.primary, json);
    await expect(f.capture()).rejects.toThrow("MALFORMED_SOURCE");
  });

  it.each(["9007199254740993", "1e400", "0.1234567890123456789", "1e-999", "9007199254740990.5"])("rejects a numeric value that would lose precision: %s", async (number) => {
    const f = await fixture();
    await write(f.primary, JSON.stringify(session()).replace('"count":0.125', `"count":${number}`));
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_SOURCE");
  });

  it.each([
    [{ kind: 9, k: ["customTitle"], v: "FUTURE" }, "UNSUPPORTED_EVENT"],
    [{ kind: "set", k: ["customTitle"], v: "FUTURE" }, "UNSUPPORTED_EVENT"],
    [{ kind: 1, k: ["customTitle"], v: "VALID", future: "DO_NOT_UPLOAD" }, "UNSUPPORTED_FORMAT"],
    [{ kind: 0, v: session() }, "INCOMPLETE_SOURCE"],
    [{ kind: 1, k: [], v: session() }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["__proto__", "polluted"], v: true }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["constructor", "prototype", "polluted"], v: true }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["requests", "0", "message"], v: message("bad index") }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["requests", -1], v: request() }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["requests", 10], v: request() }, "INCOMPLETE_SOURCE"],
    [{ kind: 1, k: ["requests", 0, "result", "newPrivateField"], v: "FUTURE_DIFF" }, "UNSUPPORTED_FORMAT"],
    [{ kind: 2, k: ["customTitle"], v: ["bad target"] }, "UNSUPPORTED_FORMAT"],
    [{ kind: 2, k: ["requests"], i: 2, v: [] }, "INCOMPLETE_SOURCE"],
    [{ kind: 2, k: ["requests"], i: -1 }, "INCOMPLETE_SOURCE"],
    [{ kind: 2, k: ["requests"], v: {} }, "UNSUPPORTED_FORMAT"],
    [{ kind: 2, k: ["requests"] }, "UNSUPPORTED_FORMAT"],
    [{ kind: 3, k: ["customTitle"], v: "HIDDEN_PAYLOAD" }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["version"], v: 4 }, "UNSUPPORTED_FORMAT"],
    [{ kind: 1, k: ["sessionId"], v: "chat-other" }, "UNSUPPORTED_FORMAT"],
  ] as const)("rejects malformed or future operation %#", async (operation, code) => {
    const f = await fixture("workspace", true);
    await writeLog(f.primary, [{ kind: 0, v: session() }, operation as unknown as NativeValue]);
    await expect(f.capture()).rejects.toThrow(code);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it.each(["json", "jsonl"] as const)("preserves prototype-named keys as inert %s payload data", async (format) => {
    const f = await fixture("workspace", format === "jsonl");
    const beforeObject = prototypeSnapshot(Object.prototype);
    const beforeArray = prototypeSnapshot(Array.prototype);
    const payload: NativeObject = JSON.parse(
      '{"__proto__":{"nativePrototypeSentinel":"OWN_PROTO_DATA"},"constructor":{"prototype":{"nativePrototypeSentinel":"OWN_CONSTRUCTOR_DATA"}},"prototype":{"nativePrototypeSentinel":"OWN_PROTOTYPE_DATA"}}',
    );
    const initial = session({ requests: [{ ...request(), result: { metadata: payload } }] });
    const operations: NativeObject[] = [
      { kind: 0, v: initial },
      { kind: 1, k: ["inputState", "contrib"], v: payload },
      { kind: 2, k: ["requests", 0, "variableData", "variables"], v: [{
        kind: "generic", id: "inert-data", name: "metadata", value: payload,
      }] },
    ];
    if (format === "jsonl") await writeLog(f.primary, operations);
    else await writeJson(f.primary, initial);
    const archive = await f.capture();
    const exported = records(archive.files[0]!.content);
    expect(JSON.stringify(exported)).toBe(JSON.stringify(format === "jsonl" ? operations : [initial]));
    const first = exported[0] as NativeObject;
    const state = format === "jsonl" ? first.v as NativeObject : first;
    const entry = (state.requests as NativeObject[])[0]!;
    const metadata = (entry.result as NativeObject).metadata as NativeObject;
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(metadata, key)).toBe(true);
    }
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expectUnchangedPrototype(Object.prototype, beforeObject);
    expectUnchangedPrototype(Array.prototype, beforeArray);
    expect(archive.redactions).toEqual([]);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it.each([1, 2, 3])("rejects prototype traversal for mutation kind %i without changing prototypes", async (kind) => {
    const f = await fixture("workspace", true);
    const beforeObject = prototypeSnapshot(Object.prototype);
    const beforeArray = prototypeSnapshot(Array.prototype);
    const paths: (string | number)[][] = [
      ["constructor", "prototype", "nativePrototypeSentinel"],
      ["requests", "constructor", "prototype", "nativePrototypeSentinel"],
    ];
    for (const key of ["__proto__", "constructor", "prototype"]) {
      paths.push(
        [key],
        [key, "nativePrototypeSentinel"],
        ["inputState", key],
        ["inputState", key, "nativePrototypeSentinel"],
        ["requests", key],
        ["requests", key, "nativePrototypeSentinel"],
        ["requests", 0, key],
        ["requests", 0, "result", key, "nativePrototypeSentinel"],
      );
    }
    for (const path of paths) {
      const operation: NativeObject = {
        kind, k: path,
        ...(kind === 1 ? { v: { nativePrototypeSentinel: "MUST_NOT_REACH_A_PROTOTYPE" } }
          : kind === 2 ? { v: ["MUST_NOT_REACH_A_PROTOTYPE"] } : {}),
      };
      await writeLog(f.primary, [{ kind: 0, v: session() }, operation]);
      await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
      expectUnchangedPrototype(Object.prototype, beforeObject);
      expectUnchangedPrototype(Array.prototype, beforeArray);
    }
  });

  it("rejects a truncated log, blank records, duplicate operation keys, or an absent initial record", async () => {
    const f = await fixture("workspace", true);
    await write(f.primary, JSON.stringify({ kind: 0, v: session() }));
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await write(f.primary, "");
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await writeLog(f.primary, [{ kind: 1, k: ["customTitle"], v: "NO_INITIAL_STATE" }]);
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeLog(f.primary, [{ kind: 0, v: session() }]);
    await appendFile(f.primary, "\n");
    await expect(f.capture()).rejects.toThrow("MALFORMED_SOURCE");
    await write(f.primary, `{"kind":0,"v":${JSON.stringify(session())}}\n{"kind":1,"kind":3,"k":["customTitle"]}\n`);
    await expect(f.capture()).rejects.toThrow("MALFORMED_SOURCE");
  });

  it("rejects unresolved operation parents and duplicate request IDs", async () => {
    const f = await fixture("workspace", true);
    await writeLog(f.primary, [
      { kind: 0, v: session() }, { kind: 3, k: ["inputState"] },
      { kind: 1, k: ["inputState", "inputText"], v: "MISSING_PARENT" },
    ]);
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await writeLog(f.primary, [{ kind: 0, v: session() }, { kind: 2, k: ["requests"], v: [request()] }]);
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await writeLog(f.primary, [{ kind: 0, v: session({ requests: [request(), request("request-2")] }) },
      { kind: 1, k: ["requests", 1, "responseId"], v: "response-request-1" }]);
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it.each(["response", "attachment", "message", "tool"] as const)("rejects an unclassified %s payload", async (target) => {
    const f = await fixture();
    const entry = request();
    if (target === "response") entry.response = [{ kind: "futureResponse", privateData: "UNKNOWN" }];
    if (target === "attachment") entry.variableData = { variables: [{ kind: "futureAttachment", id: "unknown", name: "unknown" }] };
    if (target === "message") entry.message = { text: "text", parts: [{ kind: "futurePart", text: "text" }] };
    if (target === "tool") entry.response = [{ ...tool(), toolSpecificData: { kind: "futureTool", privateData: "UNKNOWN" } }];
    await writeJson(f.primary, session({ requests: [entry] }));
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_EVENT");
  });

  it("redacts secrets, native thinking, hidden requests and private metadata without inventing missing runtime data", async () => {
    const f = await fixture();
    const token = `ghp_${"X".repeat(36)}`;
    const entry = request();
    entry.result = { metadata: { system_prompt: "PRIVATE_SYSTEM_PROMPT", authorization: "Bearer PRIVATE_BEARER", kept: "VISIBLE_METADATA" } };
    entry.response = [{ kind: "thinking", id: "reasoning-1", value: "PRIVATE_REASONING", metadata: { signature: "PRIVATE_SIGNATURE" }, reasoningDurationMs: 123 },
      { ...tool(), resultDetails: { input: "safe input", output: token } }];
    const hidden = { ...request("request-hidden", "PRIVATE_HIDDEN_REQUEST"), hiddenFromTranscript: true };
    await writeJson(f.primary, session({ requests: [entry, hidden] }));
    const archive = await f.capture();
    const text = JSON.stringify(archive);
    for (const value of [token, "PRIVATE_REASONING", "PRIVATE_SIGNATURE", "PRIVATE_SYSTEM_PROMPT", "PRIVATE_BEARER", "PRIVATE_HIDDEN_REQUEST"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("VISIBLE_METADATA");
    expect(text).toContain("request-hidden");
    expect(archive.redactions.length).toBeGreaterThanOrEqual(6);
    expect(archive.files[0]!.recordCount).toBe(1);
    expect(parseNativeSessionArchive(text)).toEqual(archive);
  });

  it("uses semantic mutation paths and later privacy flags to protect all historical operation payloads", async () => {
    const f = await fixture("workspace", true);
    const first = request("request-1", "PRIVATE_EARLIER_MESSAGE");
    first.response = [{ value: "PRIVATE_EARLIER_RESPONSE" }];
    const operations: NativeObject[] = [
      { kind: 0, v: session({ requests: [first] }) },
      { kind: 1, k: ["requests", 0, "hiddenFromTranscript"], v: true },
      { kind: 1, k: ["requests", 0, "message", "text"], v: "PRIVATE_LATER_MESSAGE" },
      { kind: 2, k: ["requests", 0, "response"], v: [{ value: "PRIVATE_LATER_RESPONSE" }] },
      { kind: 1, k: ["inputState", "contrib"], v: { system_prompt: "PRIVATE_DRAFT_INSTRUCTIONS", nested: { password: "PRIVATE_PASSWORD" } } },
    ];
    await writeLog(f.primary, operations);
    const archive = await f.capture();
    expect(archive.files[0]!.recordCount).toBe(operations.length);
    const sanitized = archive.files[0]!.content;
    expect(sanitized).not.toMatch(/PRIVATE_(EARLIER|LATER|DRAFT|PASSWORD)/);
    expect(records(sanitized).map((record) => (record as NativeObject).kind)).toEqual([0, 1, 1, 2, 1]);
    expect(sanitized).toContain("request-1");
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("preserves complete native MCP results while redacting actual private fields and serialized thinking", async () => {
    const f = await fixture();
    const details: NativeObject = {
      input: "tool input",
      output: [
        { type: "embed", isText: true, value: "PUBLIC_TOOL_OUTPUT", mimeType: "text/plain" },
        { type: "ref", uri: uri("/never-read-current-output.txt") },
      ],
      mcpOutput: {
        content: [{ type: "text", text: "COMPLETE_MCP_ONLY_RESULT" }],
        structuredContent: {
          rows: [{ id: 17, value: "PUBLIC_STRUCTURED_RESULT" }],
          authorization: "PRIVATE_MCP_AUTH",
          system_prompt: "PRIVATE_MCP_INSTRUCTIONS",
        },
        _meta: { "ui/resourceUri": "ui://fixture/result", visibleState: "PUBLIC_UI_STATE" },
      },
    };
    const entry = request();
    entry.result = { metadata: { serialized: JSON.stringify({ kind: "thinking", value: "PRIVATE_SERIALIZED_THINKING" }) } };
    entry.response = [{ ...tool(), resultDetails: details }];
    await writeJson(f.primary, session({ requests: [entry] }));
    const archive = await f.capture();
    expect(archive.files[0]!.content).not.toContain("PRIVATE_SERIALIZED_THINKING");
    expect(archive.files[0]!.content).not.toContain("PRIVATE_MCP_AUTH");
    expect(archive.files[0]!.content).not.toContain("PRIVATE_MCP_INSTRUCTIONS");
    for (const marker of ["COMPLETE_MCP_ONLY_RESULT", "PUBLIC_STRUCTURED_RESULT", "PUBLIC_UI_STATE"]) {
      expect(archive.files[0]!.content).toContain(marker);
    }
    expect(archive.files[0]!.content).toContain("PUBLIC_TOOL_OUTPUT");
    expect(archive.files).toHaveLength(1);
  });

  it("preserves MCP payloads and recursively redacts them in operation-log updates", async () => {
    const f = await fixture("workspace", true);
    const response = {
      ...tool(),
      resultDetails: {
        input: "MCP_INPUT",
        output: [{ type: "embed", isText: true, value: "MCP_DISPLAY_OUTPUT" }],
        mcpOutput: {
          content: [{ type: "text", text: "MCP_COMPLETE_OUTPUT" }],
          structuredContent: { publicValue: "MCP_STRUCTURED_OUTPUT", password: "PRIVATE_MCP_PASSWORD" },
        },
      },
    };
    await writeLog(f.primary, [
      { kind: 0, v: session() },
      { kind: 1, k: ["requests", 0, "response"], v: [response] },
    ]);
    const archive = await f.capture();
    const content = archive.files[0]!.content;
    expect(content).toContain("MCP_COMPLETE_OUTPUT");
    expect(content).toContain("MCP_STRUCTURED_OUTPUT");
    expect(content).not.toContain("PRIVATE_MCP_PASSWORD");
    expect(archive.files[0]!.recordCount).toBe(2);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("redacts private kinds in embedded JSONL without replacing public text records", async () => {
    const f = await fixture();
    const output = '{"kind":"thinking","value":"PRIVATE_EMBEDDED_REASONING"}\n{"value":"PUBLIC_EMBEDDED_TEXT"}\n';
    await writeJson(f.primary, session({ requests: [{ ...request(), result: { metadata: { output } } }] }));
    const content = (await f.capture()).files[0]!.content;
    expect(content).not.toContain("PRIVATE_EMBEDDED_REASONING");
    expect(content).toContain("PUBLIC_EMBEDDED_TEXT");
  });

  it("rejects ambiguous or lossy embedded JSON before redaction can discard values", async () => {
    const f = await fixture();
    for (const [output, code] of [
      ['{"kind":"thinking","kind":"text","value":"PRIVATE_REASONING"}', "MALFORMED_SOURCE"],
      ['{"system_prompt":"PRIVATE","number":9007199254740990.5}', "UNSUPPORTED_SOURCE"],
    ] as const) {
      await writeJson(f.primary, session({ requests: [{ ...request(), result: { metadata: { output } } }] }));
      await expect(f.capture()).rejects.toThrow(code!);
    }
  });

  it("redacts prompt-only hidden messages but retains the visible response and request IDs", async () => {
    const f = await fixture();
    const entry: NativeObject = { ...request(), requestHiddenFromTranscript: true };
    entry.message = message("PRIVATE_PROMPT_ONLY");
    await writeJson(f.primary, session({ requests: [entry] }));
    const content = (await f.capture()).files[0]!.content;
    expect(content).not.toContain("PRIVATE_PROMPT_ONLY");
    expect(content).toContain("NATIVE_ASSISTANT_RESPONSE");
    expect(content).toContain("request-1");
  });

  it.each<NativeObject>([
    { kind: "image", id: "image-1", name: "image.png", value: { $base64: "aW1hZ2U=" } },
    { kind: "generic", id: "bytes-1", name: "bytes", value: { $base64: "cHJpdmF0ZQ==" } },
    { kind: "element", id: "element-1", name: "element", imageData: { $base64: "aW1hZ2U=" } },
  ])("rejects native encoded attachment %# rather than claiming a partial capture", async (entry) => {
    const f = await fixture();
    await writeJson(f.primary, session({ requests: [{ ...request(), variableData: { variables: [entry] } }] }));
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
  });

  it.each<NativeObject>([
    { output: { type: "data", mimeType: "text/plain", base64Data: "aGlkZGVu" } },
    { output: { type: "Buffer", data: [1, 2, 3] } },
    { output: "data:image/png;base64,aW1hZ2U=" },
    { output: "![inline image](data:image/png;base64,aW1hZ2U=)" },
    { output: { $mid: 1, scheme: "data", path: "image/png;base64,aW1hZ2U=" } },
    { output: JSON.stringify({ value: { $base64: "aW1hZ2U=" } }) },
    { output: '{"value":"plain"}\n{"value":{"$base64":"aW1hZ2U="}}\n' },
    { input: "native input", output: [{ type: "embed", value: "aGlkZGVu", mimeType: "text/plain" }] },
    { input: "native input", output: [{ type: "embed", isText: false, value: "aGlkZGVu" }] },
  ])("rejects encoded tool output %#", async (details) => {
    const f = await fixture();
    await writeJson(f.primary, session({ requests: [{ ...request(), response: [{ ...tool(), resultDetails: details }] }] }));
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
  });

  it("rejects future tool-result and embedded-output envelopes", async () => {
    const f = await fixture();
    const invalidDetails: NativeObject[] = [
      { futurePayload: "DO_NOT_UPLOAD" },
      { input: "native input", output: [{ type: "futureOutput", value: "DO_NOT_UPLOAD" }] },
    ];
    for (const details of invalidDetails) {
      await writeJson(f.primary, session({ requests: [{ ...request(), response: [{ ...tool(), resultDetails: details }] }] }));
      await expect(f.capture()).rejects.toThrow("UNSUPPORTED_EVENT");
    }
  });

  it("rejects a separately persisted subagent reference instead of publishing its display summary", async () => {
    const f = await fixture();
    await writeJson(f.primary, session({ requests: [{ ...request(), response: [{
      ...tool(), toolSpecificData: { kind: "subagent", chatResource: "agent-host-chat://parent/child", result: "DISPLAY_ONLY" },
    }] }] }));
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_LINEAGE");
  });

  it.each<NativeObject>([
    { subAgentInvocationId: "unresolved-parent-tool-call" },
    { toolSpecificData: { kind: "subagent", prompt: "CHILD_PROMPT", result: "CHILD_SUMMARY" } },
    { toolSpecificData: { kind: "subagent", isActive: true } },
  ])("rejects unresolved native subagent grouping without a chatResource: %j", async (child) => {
    const f = await fixture();
    await writeJson(f.primary, session({ requests: [{
      ...request(), response: [{ ...tool(), ...child }],
    }] }));
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_LINEAGE");
  });

  it("captures text editing state, timelines, referenced hashes and older session-scoped content", async () => {
    const f = await fixture();
    await writeJson(f.primary, session({ hasPendingEdits: true }));
    const edit = await editing(f);
    const archive = await f.capture();
    expect(archive.files).toHaveLength(5);
    const stateFile = archive.files.find((file) => file.path.endsWith("/state.json"))!;
    expect(stateFile.kind).toBe("attachment");
    expect(stateFile.recordCount).toBe(0);
    expect(JSON.parse(stateFile.content)).toEqual(edit.state);
    for (const text of [edit.before, edit.after, edit.obsolete]) {
      expect(archive.files.some((file) => file.content === text)).toBe(true);
    }
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("redacts captured edit-file contents while preserving their native hash references", async () => {
    const f = await fixture();
    const edit = await editing(f, { privateContent: true });
    const archive = await f.capture();
    const content = archive.files.find((file) => file.path.endsWith(`/contents/${edit.afterHash}`))!;
    expect(content.content).not.toContain("PRIVATE_EDIT_SECRET");
    expect(content.sha256).toBe(createHash("sha256").update(content.content).digest("hex"));
    expect(archive.redactions.length).toBeGreaterThan(0);
    expect(archive.files.find((file) => file.path.endsWith("/state.json"))!.content).toContain(edit.afterHash);
  });

  it.each<NativeObject>([
    { hasPendingEdits: true },
    { requests: [{ ...request(), editedFileEvents: [{ uri: uri(), eventKind: "accepted" }] }] },
    { requests: [{ ...request(), response: [{ kind: "textEditGroup", uri: uri(), edits: [] }] }] },
  ])("rejects unresolved editing dependencies %#", async (value) => {
    const f = await fixture();
    await writeJson(f.primary, session(value));
    await expect(f.capture()).rejects.toThrow("MISSING_DEPENDENCY");
  });

  it("requires state.json even when a partially written editing store is not marked pending", async () => {
    const f = await fixture();
    const edit = await editing(f);
    await rm(join(edit.path, "state.json"));
    await expect(f.capture()).rejects.toThrow("MISSING_DEPENDENCY");
  });

  it("rejects missing content, corrupt hashes and unknown editing files", async () => {
    const f = await fixture();
    const edit = await editing(f);
    await rm(join(edit.path, "contents", edit.afterHash));
    await expect(f.capture()).rejects.toThrow("MISSING_DEPENDENCY");
    await write(join(edit.path, "contents", edit.afterHash), "WRONG_CONTENT");
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await write(join(edit.path, "contents", edit.afterHash), edit.after);
    await write(join(edit.path, "future-state.bin"), "DO_NOT_UPLOAD");
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_DEPENDENCY");
  });

  it("rejects symlinked edit content directories instead of following them", async () => {
    const f = await fixture();
    const edit = await editing(f);
    const alternate = join(f.root, "alternate-contents");
    await mkdir(alternate);
    await rm(join(edit.path, "contents"), { recursive: true });
    await symlink(alternate, join(edit.path, "contents"), "junction");
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
  });

  it.each([1, 3])("rejects unsupported editing-state version %s", async (version) => {
    const f = await fixture();
    const edit = await editing(f);
    await writeJson(join(edit.path, "state.json"), { ...edit.state, version });
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it("rejects the pinned native notebook language marker even without a timeline", async () => {
    const f = await fixture();
    const edit = await editing(f);
    const entry = ((edit.state.recentSnapshot as NativeObject).entries as NativeObject[])[0]!;
    entry.languageId = "VSCodeChatNotebookSnapshotLanguage";
    delete edit.state.timeline;
    await writeJson(join(edit.path, "state.json"), edit.state);
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
  });

  it("rejects orphaned notebook bytes in the native double-serialized snapshot representation", async () => {
    const f = await fixture();
    const edit = await editing(f);
    const notebook = JSON.stringify([null, JSON.stringify({
      cells: [{
        source: "print('value')", language: "python", cellKind: 2,
        outputs: [{ outputId: "output-1", outputs: [{
          mime: "text/plain",
          data: { type: "ArrayBuffer-4f56482b-5a03-49ba-8356-210d3b0c1c3d", data: "UFJJVkFURV9PVVRQVVQ=" },
        }] }],
      }],
      metadata: {},
    })]);
    const hash = createHash("sha1").update(notebook).digest("hex").slice(0, 7);
    await write(join(edit.path, "contents", hash), notebook);
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
  });

  it("rejects unsafe content hashes, notebook operations, and inconsistent pending-edit state", async () => {
    const f = await fixture();
    const edit = await editing(f);
    await writeJson(join(edit.path, "state.json"), { ...edit.state, initialFileContents: [["file:///historical/file.ts", "../../private"]] });
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
    await writeJson(join(edit.path, "state.json"), { ...edit.state, timeline: { ...(edit.state.timeline as NativeObject), operations: [{ type: "notebookEdit" }] } });
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_EVENT");
    await writeJson(join(edit.path, "state.json"), { ...edit.state, timeline: { ...(edit.state.timeline as NativeObject), epochCounter: 0 } });
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_FORMAT");
    await writeJson(join(edit.path, "state.json"), { ...edit.state, recentSnapshot: { entries: [] } });
    await writeJson(f.primary, session({ hasPendingEdits: true }));
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it("associates an empty-window session with its unique workspace-scoped editing store", async () => {
    const f = await fixture("emptyWindowChatSessions");
    await editing(f);
    expect((await f.capture()).files).toHaveLength(5);
  });

  it("rejects cross-workspace or ambiguous editing state", async () => {
    const f = await fixture();
    const other = await editing(f, { workspace: "another-workspace" });
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    await editing(f);
    await expect(f.capture()).rejects.toThrow("AMBIGUOUS_SESSION");
    await rm(dirname(dirname(other.path)), { recursive: true });
    expect((await f.capture()).files).toHaveLength(5);
  });

  it("enforces the total byte budget across primary and editing dependencies", async () => {
    const f = await fixture();
    const primaryBytes = Buffer.byteLength(await readFile(f.primary, "utf8"));
    await expect(f.capture(primaryBytes - 1)).rejects.toThrow("SOURCE_LIMIT");
    expect((await f.capture(primaryBytes)).files).toHaveLength(1);
    await editing(f);
    await expect(f.capture(primaryBytes + 1)).rejects.toThrow("SOURCE_LIMIT");
  });

  it("rejects unbounded record counts, deep payloads, and producer truncation markers", async () => {
    const f = await fixture("workspace", true);
    await write(f.primary, "{}\n".repeat(100_001));
    await expect(f.capture()).rejects.toThrow("SOURCE_LIMIT");
    let deep: NativeValue = "value";
    for (let index = 0; index < 102; index++) deep = { nested: deep };
    await writeLog(f.primary, [{ kind: 0, v: session({ requests: [{ ...request(), result: { metadata: deep } }] }) }]);
    await expect(f.capture()).rejects.toThrow("SOURCE_LIMIT");
    await writeLog(f.primary, [{ kind: 0, v: session({ customTitle: "[VS Code: value truncated for persistence; original 9000000 chars]" }) }]);
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it("bounds discovery independently of the selected source's byte size", async () => {
    const f = await fixture();
    const original = NativeFiles.prototype.list;
    vi.spyOn(NativeFiles.prototype, "list").mockImplementation(async function (this: NativeFiles, path: string) {
      if (path === join("User", "workspaceStorage")) return Array.from({ length: 10_001 }, (_value, index) => `workspace-${index}`);
      return original.call(this, path);
    });
    await expect(f.capture()).rejects.toThrow("SOURCE_LIMIT");
  });

  it("rejects invalid UTF-8 and zero-containing source bytes", async () => {
    const f = await fixture();
    await writeFile(f.primary, Buffer.from([0xff, 0xfe, 0x80]));
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
    await writeFile(f.primary, Buffer.from([0]));
    await expect(f.capture()).rejects.toThrow("UNSCANNABLE_SOURCE");
  });

  it("fails when native files change before the capture boundary is verified", async () => {
    const f = await fixture();
    const original = NativeFiles.prototype.assertUnchanged;
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      await appendFile(f.primary, " ");
      await original.call(this);
    });
    await expect(f.capture()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects changed bytes even if the writer preserves file length and modification time", async () => {
    const f = await fixture();
    const original = NativeFiles.prototype.assertUnchanged;
    const read = NativeFiles.prototype.read;
    let modified = 0;
    vi.spyOn(NativeFiles.prototype, "read").mockImplementation(async function (this: NativeFiles, path: string) {
      const result = await read.call(this, path);
      if (path.endsWith(`${ID}.json`)) modified = result.modified;
      return result;
    });
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      await original.call(this);
      const content = await readFile(f.primary, "utf8");
      await writeFile(f.primary, content.replace("Native title", "Hidden title"));
      await utimes(f.primary, modified / 1000, modified / 1000);
    });
    await expect(f.capture()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("rejects editing dependency membership changes during the final verification pass", async () => {
    const f = await fixture();
    const edit = await editing(f);
    const original = NativeFiles.prototype.assertUnchanged;
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      await original.call(this);
      const content = "LATER_EDIT_SNAPSHOT";
      const hash = createHash("sha1").update(content).digest("hex").slice(0, 7);
      await write(join(edit.path, "contents", hash), content);
    });
    await expect(f.capture()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("fails when a log or another exact-ID source appears during flat capture", async () => {
    const f = await fixture();
    const original = NativeFiles.prototype.assertUnchanged;
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      await original.call(this);
      await writeLog(join(f.store, `${ID}.jsonl`), [{ kind: 0, v: session() }]);
    });
    await expect(f.capture()).rejects.toThrow("SOURCE_CHANGED");
    vi.restoreAllMocks();
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      await original.call(this);
      await writeJson(join(f.source.userDataPath, "User", "globalStorage", "emptyWindowChatSessions", `${ID}.json`), session());
    });
    await expect(f.capture()).rejects.toThrow("AMBIGUOUS_SESSION");
  });
});
