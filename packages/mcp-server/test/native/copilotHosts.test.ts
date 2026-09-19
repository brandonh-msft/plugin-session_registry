import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseNativeSessionArchive, scan, type NativeHarness } from "@session-registry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeSession, type NativeHomes } from "../../src/native/adapters.js";
import { createNativeCaptureService, type NativeCaptureOptions } from "../../src/native/captures.js";
import { captureCopilotHostSession } from "../../src/native/copilotHosts.js";
import { NativeFiles, type NativeObject } from "../../src/native/files.js";
import type { CopilotHostCaptureSource } from "../../src/native/sourceTypes.js";
import { nativeRecords, SESSION_ID, TIME, writeRecords } from "./fixtures.js";

const PROFILES = [
  { harness: "visual-studio-copilot", hostVersion: "18.8.1" },
  { harness: "github-copilot-desktop", hostVersion: "1.0.84" },
  { harness: "github-copilot-desktop-chat", hostVersion: undefined },
] as const;
const MAX_BYTES = 4 * 1024 * 1024;
const now = () => new Date(TIME);
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function event(type: string, data: NativeObject, index = 7): NativeObject {
  return { type, data, id: `event-${index}`, parentId: index === 0 ? null : `event-${index - 1}`, timestamp: TIME };
}

function jsonl(records: readonly object[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function startWith(data: NativeObject): object[] {
  const records = nativeRecords("github-copilot-cli") as NativeObject[];
  return [{ ...records[0], data: { ...records[0]!.data as NativeObject, ...data } }, ...records.slice(1)];
}

async function fixture() {
  const root = join(process.cwd(), `.copilot-host-fixture-${randomUUID()}`);
  await mkdir(root);
  directories.push(root);
  const copilotHome = join(root, "selected-sdk-home");
  const primary = join(copilotHome, "session-state", SESSION_ID, "events.jsonl");
  const records = nativeRecords("github-copilot-cli");
  await writeRecords(primary, records);
  const homes: NativeHomes = Object.freeze({
    "github-copilot-cli": join(root, "separate-cli-home"),
    "claude-code": join(root, "claude"),
    "codex-cli": join(root, "codex"),
  });
  return { root, copilotHome, primary, records, homes };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const INVALID_STREAMS = [
  { name: "mismatched native identity", content: jsonl(nativeRecords("github-copilot-cli", "another-session")), code: "UNSUPPORTED_FORMAT" },
  { name: "unsupported event schema", content: jsonl(startWith({ version: 2 })), code: "UNSUPPORTED_FORMAT" },
  { name: "string event schema", content: jsonl(startWith({ version: "1" })), code: "UNSUPPORTED_FORMAT" },
  { name: "missing runtime version", content: jsonl(startWith({ copilotVersion: null })), code: "UNSUPPORTED_FORMAT" },
  { name: "empty runtime version", content: jsonl(startWith({ copilotVersion: "" })), code: "UNSUPPORTED_FORMAT" },
  { name: "legacy history JSON", content: jsonl([{ messages: [{ role: "user", content: "Not SDK-native history" }] }]), code: "UNSUPPORTED_FORMAT" },
  { name: "diagnostic event array", content: jsonl([nativeRecords("github-copilot-cli")]), code: "UNSUPPORTED_FORMAT" },
  { name: "malformed JSON", content: "{invalid json}\n", code: "MALFORMED_SOURCE" },
  { name: "duplicate JSON keys", content: jsonl(nativeRecords("github-copilot-cli")).replace('"version":1', '"version":1,"version":1'), code: "MALFORMED_SOURCE" },
  { name: "unfinished final record", content: jsonl(nativeRecords("github-copilot-cli")).trimEnd(), code: "INCOMPLETE_SOURCE" },
  {
    name: "missing event predecessor",
    content: jsonl([...nativeRecords("github-copilot-cli"), { ...event("assistant.message", { content: "suffix" }), parentId: "missing-event" }]),
    code: "INCOMPLETE_SOURCE",
  },
  {
    name: "duplicate event identity",
    content: jsonl([...nativeRecords("github-copilot-cli"), { ...event("assistant.message", { content: "duplicate" }), id: "event-1" }]),
    code: "INCOMPLETE_SOURCE",
  },
  {
    name: "unknown native event",
    content: jsonl([...nativeRecords("github-copilot-cli"), event("future.host_event", { privateFuturePayload: "UNCLASSIFIED" })]),
    code: "UNSUPPORTED_EVENT",
  },
];

describe.each(PROFILES)("$harness SDK-native capture", (profile) => {
  const input = { harness: profile.harness, harnessSessionId: SESSION_ID };
  const source = (data: Fixture): CopilotHostCaptureSource => ({
    copilotHome: data.copilotHome,
    ...(profile.hostVersion === undefined ? {} : { hostVersion: profile.hostVersion }),
  });
  const capture = (data: Fixture, maxBytes = MAX_BYTES) =>
    captureCopilotHostSession(input, source(data), data.homes, maxBytes, now);
  const options = (data: Fixture): NativeCaptureOptions => ({
    homes: data.homes,
    ideSources: { visualStudio: source(data), desktop: source(data) },
    captureDirectory: join(data.root, "review-captures"),
    maxBytes: MAX_BYTES,
    now,
  });

  it("preserves SDK records, supported dependencies, native version, and selected profile without using the CLI default", async () => {
    const data = await fixture();
    const attachment = join("files", "input.txt");
    const output = join("files", "tool-results", "output.txt");
    const records = [
      ...data.records,
      event("user.message", { content: "Use the persisted attachment.", attachments: [{ type: "file", path: attachment }] }),
      event("tool.execution_start", { toolCallId: "tool-output", toolName: "shell", arguments: { command: "fixture-command" } }, 8),
      event("tool.execution_complete", {
        toolCallId: "tool-output", success: false,
        result: {
          content: "MODEL_PREVIEW", detailedContent: "DETAILED_NATIVE_RESULT",
          contents: [{ type: "shell_exit", shellId: "shell-output", exitCode: 1, outputTruncated: true, outputFilePath: output }],
        },
      }, 9),
    ];
    await writeRecords(data.primary, records);
    await mkdir(dirname(join(dirname(data.primary), output)), { recursive: true });
    await writeFile(join(dirname(data.primary), attachment), "PERSISTED_ATTACHMENT\n");
    await writeFile(join(dirname(data.primary), output), "COMPLETE_STDOUT\nCOMPLETE_STDERR\n");
    await writeFile(join(dirname(data.primary), "plan.md"), "# Persisted native plan\n");
    const defaultPrimary = join(data.homes["github-copilot-cli"], "session-state", SESSION_ID, "events.jsonl");
    await writeRecords(defaultPrimary, [...data.records, event("assistant.message", { content: "CLI_ONLY_SENTINEL" })]);

    const archive = await capture(data);
    const native = await captureNativeSession(
      { harness: "github-copilot-cli", harnessSessionId: SESSION_ID },
      { ...data.homes, "github-copilot-cli": data.copilotHome },
      MAX_BYTES, now,
    );
    const hostVersion = profile.hostVersion === undefined ? "not-configured" : `operator-configured:${profile.hostVersion}`;
    expect(archive).toEqual({
      ...native,
      harness: { name: profile.harness, version: "1.0.82-1" },
      sourceFormat: `copilot-events-v1;profile=sdk-native-only;host-version=${hostVersion}`,
    });
    expect(archive.files).toHaveLength(4);
    expect(archive.files[0]!.content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(records);
    expect(archive.files[0]!.recordCount).toBe(records.length);
    expect(archive.files.find((file) => file.path === "files/input.txt")?.content).toBe("PERSISTED_ATTACHMENT\n");
    expect(archive.files.find((file) => file.path === "files/tool-results/output.txt")?.content).toBe("COMPLETE_STDOUT\nCOMPLETE_STDERR\n");
    expect(archive.files.find((file) => file.path === "plan.md")?.content).toBe("# Persisted native plan\n");
    expect(archive.harnessSessionId).toBe(SESSION_ID);
    expect(archive.scope).toBe("persisted-session-records");
    expect(archive.resumable).toBe(false);
    expect(archive.redactions).toEqual([]);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
    expect(JSON.stringify(archive)).not.toContain("CLI_ONLY_SENTINEL");
    expect(JSON.stringify(archive)).not.toContain(data.copilotHome.replaceAll("\\", "\\\\"));
    expect(data.homes["github-copilot-cli"]).toBe(join(data.root, "separate-cli-home"));
    expect(await readFile(data.primary, "utf8")).toBe(jsonl(records));
  });

  it("redacts credentials and private runtime metadata without changing original native files", async () => {
    const data = await fixture();
    const token = `ghp_${"X".repeat(36)}`;
    const records = [
      ...data.records,
      event("system.message", { content: "PRIVATE_SYSTEM_SENTINEL" }),
      event("assistant.reasoning", { content: "PRIVATE_REASONING_SENTINEL" }, 8),
      event("session.info", {
        infoType: "fixture", message: token,
        payload: { nested: { authorization: "PRIVATE_AUTH_SENTINEL", environment: { VALUE: "PRIVATE_ENV_SENTINEL" }, keep: "PUBLIC_METADATA" } },
      }, 9),
    ];
    await writeRecords(data.primary, records);
    const attachment = join(dirname(data.primary), "output.txt");
    await writeFile(attachment, `PUBLIC_OUTPUT\nAPI_KEY=${token}\n`);
    const before = await readFile(data.primary);
    const modified = (await lstat(data.primary)).mtimeMs;
    const archive = await capture(data);
    const content = JSON.stringify(archive);

    for (const secret of [token, "PRIVATE_SYSTEM_SENTINEL", "PRIVATE_REASONING_SENTINEL", "PRIVATE_AUTH_SENTINEL", "PRIVATE_ENV_SENTINEL"]) {
      expect(content).not.toContain(secret);
    }
    expect(content).toContain("PUBLIC_METADATA");
    expect(content).toContain("PUBLIC_OUTPUT");
    expect(archive.redactions.length).toBeGreaterThanOrEqual(6);
    expect(archive.files[0]!.recordCount).toBe(records.length);
    expect(JSON.parse(archive.files[0]!.content.split("\n")[7]!)).toMatchObject({
      type: "system.message", id: "event-7", parentId: "event-6", redacted: "private-runtime-content",
    });
    expect(scan(content)).toMatchObject({ status: "ok", findings: [] });
    expect(parseNativeSessionArchive(content)).toEqual(archive);
    expect(await readFile(data.primary)).toEqual(before);
    expect((await lstat(data.primary)).mtimeMs).toBe(modified);
    expect(await readFile(attachment, "utf8")).toContain(token);
  });

  it("keeps prepared captures immutable across source changes and capture-service restarts", async () => {
    const data = await fixture();
    const service = createNativeCaptureService(options(data));
    const prepared = await service.prepare(input);
    const captured = await service.load(prepared.captureId);
    await appendFile(data.primary, jsonl([event("assistant.message", { content: "LATER_NATIVE_EVENT" })]));
    const restarted = createNativeCaptureService(options(data));

    expect(await restarted.load(prepared.captureId)).toEqual(captured);
    expect(await readFile(prepared.reviewPath, "utf8")).toBe(captured.content);
    expect(captured.archive.harness.name).toBe(profile.harness);
    expect(captured.content).not.toContain("LATER_NATIVE_EVENT");
    const next = await restarted.prepare(input);
    expect(next.captureId).not.toBe(prepared.captureId);
    expect((await restarted.load(next.captureId)).content).toContain("LATER_NATIVE_EVENT");
  });

  it("retains the final scan for unsanitized native identity metadata before saving a capture", async () => {
    const data = await fixture();
    await writeRecords(data.primary, startWith({ copilotVersion: `ghp_${"X".repeat(36)}` }));
    await expect(createNativeCaptureService(options(data)).prepare(input)).rejects.toMatchObject({ code: "SCAN_FAILED" });
    await expect(lstat(options(data).captureDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(INVALID_STREAMS)("rejects $name without substituting other native sources", async ({ content, code }) => {
    const data = await fixture();
    await writeFile(data.primary, content);
    await expect(capture(data)).rejects.toMatchObject({ code });
    expect(await readFile(data.primary, "utf8")).toBe(content);
  });

  it.each(["host-session", "", "../outside"])("rejects the unused hostSessionId option: %j", async (hostSessionId) => {
    const data = await fixture();
    await expect(captureCopilotHostSession({ ...input, hostSessionId }, source(data), data.homes, MAX_BYTES))
      .rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
  });

  it.each(["", "../outside", "C:\\outside", "copilot://session/id", "a/b", "a\\b", "has space"])(
    "rejects non-native session identifiers: %j", async (harnessSessionId) => {
      const data = await fixture();
      await expect(captureCopilotHostSession({ ...input, harnessSessionId }, source(data), data.homes, MAX_BYTES))
        .rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    },
  );

  it.each([undefined, null, {}, { copilotHome: "" }, { copilotHome: " " }, { copilotHome: "." }, { copilotHome: "relative\\sdk" }, { copilotHome: 42 }])(
    "rejects missing or non-explicit SDK-root configuration: %j", async (invalidSource) => {
      const data = await fixture();
      await expect(captureCopilotHostSession(input, invalidSource as CopilotHostCaptureSource, data.homes, MAX_BYTES))
        .rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });
    },
  );

  it("rejects missing native records even when another configured CLI store has a matching ID", async () => {
    const data = await fixture();
    await writeRecords(join(data.homes["github-copilot-cli"], "session-state", SESSION_ID, "events.jsonl"), data.records);
    await rm(data.primary);
    await expect(capture(data)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await rm(data.copilotHome, { recursive: true });
    await expect(capture(data)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("rejects a diagnostic/history file configured as a native home", async () => {
    const data = await fixture();
    await expect(captureCopilotHostSession(input, { ...source(data), copilotHome: data.primary }, data.homes, MAX_BYTES))
      .rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  it.each(["output", "attachment"])("requires every referenced %s dependency", async (kind) => {
    const data = await fixture();
    const record = kind === "attachment"
      ? event("user.message", { content: "Persisted input", attachments: [{ type: "file", path: "missing.txt" }] })
      : event("tool.execution_complete", {
        toolCallId: "tool-missing", success: true,
        result: { contents: [{ type: "shell_exit", outputTruncated: true, outputFilePath: "missing.txt" }] },
      });
    await writeRecords(data.primary, [...data.records, record]);
    await expect(capture(data)).rejects.toMatchObject({ code: "MISSING_DEPENDENCY" });
  });

  it.each(["relative", "absolute", "output-text"])("rejects %s references outside the selected session", async (kind) => {
    const data = await fixture();
    const outside = join(data.copilotHome, "session-state", "another-session", "output.txt");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "ANOTHER_SESSION_PRIVATE_OUTPUT");
    const reference = kind === "relative" ? join("..", "another-session", "output.txt") : outside;
    const record = kind === "output-text"
      ? event("tool.execution_complete", { toolCallId: "tool-outside", success: true, result: { content: `Full output saved to: ${reference}` } })
      : event("user.message", { content: "Reference", attachments: [{ type: "file", path: reference }] });
    await writeRecords(data.primary, [...data.records, record]);
    await expect(capture(data)).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it("rejects symbolic-link dependency directories instead of escaping the selected session", async () => {
    const data = await fixture();
    const outside = join(data.root, "outside-dependencies");
    await mkdir(outside);
    await writeFile(join(outside, "output.txt"), "OUTSIDE_OUTPUT");
    await symlink(outside, join(dirname(data.primary), "linked-files"), "junction");
    await expect(capture(data)).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
  });

  it("rejects symbolic-link configured homes", async () => {
    const data = await fixture();
    const alias = join(data.root, "linked-home");
    await symlink(data.copilotHome, alias, "junction");
    await expect(captureCopilotHostSession(input, { ...source(data), copilotHome: alias }, data.homes, MAX_BYTES))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
  });

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from("binary\0data")])("rejects unscannable native dependencies: %j", async (content) => {
    const data = await fixture();
    await writeFile(join(dirname(data.primary), "binary-asset.bin"), content);
    await expect(capture(data)).rejects.toMatchObject({ code: "UNSCANNABLE_SOURCE" });
  });

  it("rejects native binary assets and incomplete truncated tool results", async () => {
    const data = await fixture();
    await writeRecords(data.primary, [...data.records, event("session.binary_asset", { mimeType: "image/png", data: "FAKE_IMAGE" })]);
    await expect(capture(data)).rejects.toMatchObject({ code: "UNSCANNABLE_SOURCE" });
    await writeRecords(data.primary, [...data.records, event("tool.execution_complete", {
      toolCallId: "tool-truncated", success: true, result: { contents: [{ type: "shell_exit", outputTruncated: true, outputPreview: "Only a preview" }] },
    })]);
    await expect(capture(data)).rejects.toMatchObject({ code: "INCOMPLETE_SOURCE" });
  });

  it("enforces aggregate dependency and serialized capture limits without truncation", async () => {
    const data = await fixture();
    const original = await readFile(data.primary);
    await writeFile(join(dirname(data.primary), "output.txt"), "X".repeat(100));
    await expect(capture(data, original.length + 99)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
    await rm(join(dirname(data.primary), "output.txt"));
    const service = createNativeCaptureService({ ...options(data), maxBytes: original.length });
    await expect(service.prepare(input)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
    expect(await readFile(data.primary)).toEqual(original);
    await expect(lstat(options(data).captureDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid direct-call byte limits: %j", async (maxBytes) => {
      const data = await fixture();
      await expect(capture(data, maxBytes)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
    },
  );

  it.each(["events", "dependencies"])("retains the native stability check when %s change during capture", async (changed) => {
    const data = await fixture();
    const assertUnchanged = NativeFiles.prototype.assertUnchanged;
    vi.spyOn(NativeFiles.prototype, "assertUnchanged").mockImplementationOnce(async function (this: NativeFiles) {
      if (changed === "events") {
        await appendFile(data.primary, jsonl([event("assistant.message", { content: "CONCURRENT_NATIVE_WRITE" })]));
      } else {
        await writeFile(join(dirname(data.primary), "new-dependency.txt"), "CONCURRENT_NATIVE_DEPENDENCY");
      }
      await assertUnchanged.call(this);
    });
    await expect(capture(data)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});

describe("SDK host profile configuration and provenance", () => {
  it("snapshots configured provenance instead of accepting a later caller mutation as attested native state", async () => {
    const data = await fixture();
    const source = { copilotHome: data.copilotHome, hostVersion: "18.8" };
    const archive = await captureCopilotHostSession(
      { harness: "visual-studio-copilot", harnessSessionId: SESSION_ID },
      source, data.homes, MAX_BYTES,
      () => {
        source.hostVersion = "PRIVATE_MUTATED_VERSION";
        return now();
      },
    );
    expect(archive.sourceFormat).toBe("copilot-events-v1;profile=sdk-native-only;host-version=operator-configured:18.8");
    expect(JSON.stringify(archive)).not.toContain("PRIVATE_MUTATED_VERSION");
  });

  it.each(["18.8", "18.8.0", "18.8.12345.1", "18.8.0-preview.1", "18.10.2+build.3", "19.0", "20.1.0"])(
    "accepts Visual Studio %s only as configured SDK-experience provenance", async (hostVersion) => {
      const data = await fixture();
      const archive = await captureCopilotHostSession(
        { harness: "visual-studio-copilot", harnessSessionId: SESSION_ID },
        { copilotHome: data.copilotHome, hostVersion }, data.homes, MAX_BYTES, now,
      );
      expect(archive.harness).toEqual({ name: "visual-studio-copilot", version: "1.0.82-1" });
      expect(archive.sourceFormat).toBe(`copilot-events-v1;profile=sdk-native-only;host-version=operator-configured:${hostVersion}`);
      expect(archive.files[0]!.content).not.toContain(hostVersion);
    },
  );

  it("requires a Visual Studio version rather than inferring it from the native Copilot version", async () => {
    const data = await fixture();
    await expect(captureCopilotHostSession(
      { harness: "visual-studio-copilot", harnessSessionId: SESSION_ID },
      { copilotHome: data.copilotHome }, data.homes, MAX_BYTES,
    )).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });
  });

  it.each(["", " ", "17.14.9", "18.7.99", "18", "v18.8", "018.8", "18.08", "18.8oops", "18.8.0.0.0", "18.8-", "18..8", "18.8\n", "9007199254740992.0"])(
    "rejects old or malformed Visual Studio versions: %j", async (hostVersion) => {
      const data = await fixture();
      await expect(captureCopilotHostSession(
        { harness: "visual-studio-copilot", harnessSessionId: SESSION_ID },
        { copilotHome: data.copilotHome, hostVersion }, data.homes, MAX_BYTES,
      )).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_VERSION" });
    },
  );

  it.each(["github-copilot-desktop", "github-copilot-desktop-chat"] as const)(
    "does not require an invented host version or client_name for %s", async (harness) => {
      const data = await fixture();
      const archive = await captureCopilotHostSession(
        { harness, harnessSessionId: SESSION_ID }, { copilotHome: data.copilotHome }, data.homes, MAX_BYTES, now,
      );
      expect(archive.harness).toEqual({ name: harness, version: "1.0.82-1" });
      expect(archive.sourceFormat).toBe("copilot-events-v1;profile=sdk-native-only;host-version=not-configured");
      expect(archive.files[0]!.content.trim().split("\n").map((line) => JSON.parse(line))).toEqual(data.records);
      expect(archive.files[0]!.content).not.toContain("client_name");
    },
  );

  it("does not apply the Visual Studio minimum version to Desktop", async () => {
    const data = await fixture();
    const archive = await captureCopilotHostSession(
      { harness: "github-copilot-desktop", harnessSessionId: SESSION_ID },
      { copilotHome: data.copilotHome, hostVersion: "0.1.0" }, data.homes, MAX_BYTES, now,
    );
    expect(archive.sourceFormat).toContain("host-version=operator-configured:0.1.0");
  });

  it.each([" ", "not-a-version", "1.0\nSECRET", `1.0+ghp_${"X".repeat(36)}`])(
    "rejects malformed configured Desktop versions rather than copying arbitrary metadata: %j", async (hostVersion) => {
      const data = await fixture();
      await expect(captureCopilotHostSession(
        { harness: "github-copilot-desktop", harnessSessionId: SESSION_ID },
        { copilotHome: data.copilotHome, hostVersion }, data.homes, MAX_BYTES,
      )).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_VERSION" });
    },
  );

  it.each(["github-copilot-cli", "claude-code", "codex-cli", "vscode-copilot-chat", "vscode-copilot-agent", "github-copilot-desktop-cloud"])(
    "does not silently assign an SDK host profile to %s", async (harness) => {
      const data = await fixture();
      await expect(captureCopilotHostSession(
        { harness: harness as NativeHarness, harnessSessionId: SESSION_ID },
        { copilotHome: data.copilotHome, hostVersion: "18.8" }, data.homes, MAX_BYTES,
      )).rejects.toMatchObject({ code: "UNSUPPORTED_HARNESS" });
    },
  );
});
