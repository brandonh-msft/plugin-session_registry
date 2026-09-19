import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestFormParamsSchema, ElicitRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { NATIVE_SESSION_ARCHIVE_FORMAT, buildNativeSessionBundle, type NativeSessionArchive } from "@session-registry/core";
import { beforeAll, describe, expect, it } from "vitest";

const PREPARE_PROMPT_NAME = "prepare_full_fidelity_publish_session";
const IMPORT_TOOL_NAME = "import_session_bundle";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MCP_DIST_DIRECTORY = resolve(
  REPOSITORY_ROOT,
  "packages/mcp-server/dist",
);
const CORE_DIST_DIRECTORY = resolve(REPOSITORY_ROOT, "packages/core/dist");
const COMPILED_ENTRYPOINT = resolve(MCP_DIST_DIRECTORY, "index.js");
const AUTHORITATIVE_VERIFICATION_COMMAND =
  "pnpm verify:full-fidelity-publication-contract";
let expectedCoreChecklist: string;

function importFixtureBundle(): Uint8Array {
  const content = '{"type":"user.message","data":{"content":"stdio imported data"}}\n';
  const sha256 = createHash("sha256").update(content).digest("hex");
  const archive: NativeSessionArchive = {
    format: NATIVE_SESSION_ARCHIVE_FORMAT,
    harness: { name: "github-copilot-cli", version: "1.0.0" },
    harnessSessionId: "stdio-import-fixture",
    capturedAt: "2026-09-17T00:00:00.000Z",
    sourceFormat: "fixture",
    scope: "persisted-session-records",
    resumable: false,
    files: [{ path: "events.jsonl", kind: "events", recordCount: 1, content, sha256 }],
    redactions: [],
    capture: {
      boundary: "observed-prefixes", entrypoint: "events.jsonl", selection: "native-id", layout: "session-directory",
      sources: [{ path: "events.jsonl", capturedBytes: Buffer.byteLength(content), observedBytes: Buffer.byteLength(content), sha256, snapshot: "file-prefix" }],
      history: [{ path: "events.jsonl", sessionId: "stdio-import-fixture" }],
      diagnostics: [],
    },
    restoration: { status: "not-verified", reason: "No admission contract." },
  };
  return buildNativeSessionBundle(archive);
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function requireBuildOutput(
  path: string,
  description: string,
): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `${description} is missing at ${path}. Run ` +
        `"${AUTHORITATIVE_VERIFICATION_COMMAND}" to create fresh compiled output.`,
    );
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMilliseconds = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }

    await delay(25);
  }

  throw new Error(`Compiled MCP child process ${pid} did not exit cleanly.`);
}

async function launchWithoutRequiredEnvironment(): Promise<ProcessResult> {
  const env = { ...process.env };
  delete env.SESSION_REGISTRY_API_URL;
  delete env.SESSION_REGISTRY_TOKEN;

  const child = spawn(process.execPath, [COMPILED_ENTRYPOINT], {
    cwd: REPOSITORY_ROOT,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

  return new Promise<ProcessResult>((resolvePromise, reject) => {
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const cleanupTimers = (): void => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 1_000);
      }
    }, 5_000);

    child.once("error", (error) => {
      cleanupTimers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanupTimers();
      const stderr = stderrChunks.join("");
      const stdout = stdoutChunks.join("");

      if (timedOut) {
        reject(
          new Error(
            `Compiled MCP server did not fail for missing configuration within the timeout. ` +
              `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
          ),
        );
        return;
      }

      resolvePromise({ code, signal, stderr, stdout });
    });
  });
}

beforeAll(async () => {
  await requireBuildOutput(
    COMPILED_ENTRYPOINT,
    "Compiled MCP stdio entrypoint",
  );
  await requireBuildOutput(
    resolve(MCP_DIST_DIRECTORY, "index.d.ts"),
    "Compiled MCP declaration entrypoint",
  );
  await requireBuildOutput(
    resolve(CORE_DIST_DIRECTORY, "index.d.ts"),
    "Compiled core declaration entrypoint",
  );
  const coreEntrypoint = resolve(CORE_DIST_DIRECTORY, "index.js");
  await requireBuildOutput(coreEntrypoint, "Compiled core entrypoint");
  const coreModule = (await import(
    /* @vite-ignore */ pathToFileURL(coreEntrypoint).href
  )) as {
    readonly FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST: string;
  };
  expectedCoreChecklist =
    coreModule.FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST;
});

describe("compiled MCP stdio protocol", () => {
  it("captures and confirms a current session across real stdio without requesting a native UUID", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-save-stdio-"));
    const id = "77777777-7777-4777-8777-777777777777";
    const home = join(root, "native-home");
    const session = join(home, "session-state", id);
    await mkdir(session, { recursive: true });
    const native = [
      { type: "session.start", data: { sessionId: id, version: 1, copilotVersion: "1.0.84-4", context: { cwd: root } } },
      { type: "user.message", data: { content: "tell me about black holes" } },
      { type: "assistant.message", data: { content: "Event horizons and accretion disks." } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(join(session, "events.jsonl"), native);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [COMPILED_ENTRYPOINT], cwd: REPOSITORY_ROOT,
      env: {
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        SESSION_REGISTRY_API_URL: "http://127.0.0.1:1",
        SESSION_REGISTRY_TOKEN: "non-secret-fixture-owner",
        SESSION_REGISTRY_COPILOT_HOME: home,
        SESSION_REGISTRY_CAPTURE_DIR: join(root, "captures"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "save-stdio-regression", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    let confirmations = 0;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      confirmations++;
      expect(params.message).toContain(id);
      expect(params.message).toContain("Anyone (anonymous)");
      expect(params.requestedSchema.properties.title).toMatchObject({ default: "Black holes explained" });
      expect(params.requestedSchema.properties.audience).toMatchObject({ type: "string", default: "anyone" });
      expect(params.requestedSchema.properties).not.toHaveProperty("harnessSessionId");
      // Real stdio exercises source reads and host confirmation, not a real upload.
      return { action: "decline" };
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "save_session", arguments: {
        harness: "github-copilot-cli", interactionMode: "interactive", workingDirectory: root, recentUserMessage: "tell me about black holes",
        title: "Black holes explained", summary: "Discussed event horizons and accretion disks.",
      } });
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected save outcome");
      const outcome = JSON.parse(block.text);
      expect(outcome.status).toBe("cancelled");
      expect(confirmations).toBe(1);
      const captured = JSON.parse(await readFile(join(root, "captures", `${outcome.captureId}.json`), "utf8"));
      expect(captured.files[0].content).toBe(native);
    } finally {
      await client.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes through an absolute entrypoint and serves static capabilities", async () => {
    expect(
      isAbsolute(COMPILED_ENTRYPOINT),
      "the Windows startup regression requires an absolute filesystem path",
    ).toBe(true);

    const importRoot = await mkdtemp(join(tmpdir(), "registry-import-stdio-"));
    const importPath = join(importRoot, "fixture.zip");
    await writeFile(importPath, importFixtureBundle());
    let importPrompts = 0;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [COMPILED_ENTRYPOINT],
      cwd: REPOSITORY_ROOT,
      env: {
        SESSION_REGISTRY_API_URL: "http://127.0.0.1:1",
        SESSION_REGISTRY_TOKEN: "non-secret-stdio-smoke-token",
      },
      stderr: "pipe",
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

    const client = new Client({
      name: "session-registry-compiled-stdio-smoke",
      version: "1.0.0",
    }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      importPrompts++;
      expect(params.message).not.toContain(importPath);
      expect(params.message).not.toContain("stdio imported data");
      return { action: "decline" };
    });
    let connected = false;

    try {
      await client.connect(transport);
      connected = true;

      const childPid = transport.pid;
      expect(
        childPid,
        "the absolute-path child must remain alive through initialization",
      ).toBeTypeOf("number");
      expect(client.getServerCapabilities()).toMatchObject({
        prompts: {},
        tools: {},
      });

      const { prompts } = await client.listPrompts();
      expect(prompts.some(({ name }) => name === PREPARE_PROMPT_NAME)).toBe(
        true,
      );

      const prompt = await client.getPrompt({ name: PREPARE_PROMPT_NAME });
      const promptMessage = prompt.messages[0];
      expect(promptMessage).toMatchObject({
        role: "user",
        content: {
          type: "text",
        },
      });
      if (promptMessage?.content.type !== "text") {
        throw new Error("Preparation prompt did not return text content.");
      }

      const checklist = promptMessage.content.text;
      expect(checklist).toBe(expectedCoreChecklist);
      expect(checklist).toContain(
        "# Prepare a full-fidelity publish_session request",
      );
      expect(checklist).toContain(
        "full-fidelity-publication-contract/4.4.1",
      );
      expect(checklist).toContain(
        "Call prepare_session_capture",
      );
      expect(checklist).toContain(
        "Do not send transcript, artifacts, or harness metadata",
      );

      const { tools } = await client.listTools();
      const save = tools.find(({ name }) => name === "save_session");
      expect(save?.inputSchema.required).toEqual(["harness", "interactionMode", "title", "summary"]);
      expect(save?.description).toContain("BEFORE asking the user");
      expect(save?.inputSchema.properties).toHaveProperty("sessionDirectory");
      expect(save?.inputSchema.properties).toHaveProperty("recentUserMessage");
      expect(tools.some(({ name }) => name === "publish_session")).toBe(true);
      expect(tools.find(({ name }) => name === "prepare_session_capture")?.description)
        .toContain("Do not ask the owner to write these fields or present a blank metadata form.");
      expect(checklist).toContain("one concise publish proposal");
      for (const name of [IMPORT_TOOL_NAME, "read_import_slice", "close_import"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.inputSchema.additionalProperties).toBe(false);
        expect(tool?.description).toBeTruthy();
      }

      const malformedImport = await client.callTool({
        name: IMPORT_TOOL_NAME,
        arguments: { bundlePath: "" },
      });
      expect(malformedImport.isError).toBe(true);
      const declinedImport = await client.callTool({
        name: IMPORT_TOOL_NAME,
        arguments: { bundlePath: importPath },
      });
      const importBlock = declinedImport.content[0];
      if (importBlock?.type !== "text") throw new Error("Expected import response");
      expect(JSON.parse(importBlock.text)).toMatchObject({ code: "IMPORT_CONSENT_REQUIRED" });
      expect(importPrompts).toBe(1);

      await expect(
        client.getPrompt({ name: "unknown-compiled-stdio-prompt" }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof McpError && error.code === ErrorCode.InvalidParams,
      );

      const recoveredPrompt = await client.getPrompt({
        name: PREPARE_PROMPT_NAME,
      });
      expect(recoveredPrompt).toEqual(prompt);

      await client.close();
      connected = false;
      expect(transport.pid).toBeNull();
      if (childPid !== null) {
        await waitForProcessExit(childPid);
      }
      expect(
        stderrChunks.join(""),
        "successful stdio startup must not emit diagnostics",
      ).toBe("");
    } finally {
      if (connected) {
        await client.close();
      } else {
        await transport.close();
      }
      await rm(importRoot, { recursive: true, force: true });
    }
  });

  it("fails explicitly on stderr with a nonzero code when configuration is missing", async () => {
    const result = await launchWithoutRequiredEnvironment();

    expect(result.signal).toBeNull();
    expect(result.code).toBeTypeOf("number");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "SESSION_REGISTRY_API_URL must be configured for the MCP server",
    );
    expect(
      result.stdout,
      "startup diagnostics must not corrupt the MCP stdout protocol",
    ).toBe("");
  });
});
