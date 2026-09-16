import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNativeSessionArchive, type NativeSessionArchive } from "@session-registry/core";
import { captureVsCodeAgentSession } from "../../src/native/vscodeAgentHost.js";
import { VSCODE_AGENT_HOST_COMMIT, VsCodeSessionDatabase } from "../../src/native/vscodeSessionDatabase.js";
import {
  createVsCodeAgentHostFixture,
  vscodeAgentEvents as events,
  VSCODE_AGENT_SDK_ID as SDK_ID,
  VSCODE_AGENT_HOST_ID as HOST_ID,
  VSCODE_AGENT_FIXTURE_TIME as TIME,
  VSCODE_AGENT_SCHEMA_V12_SQL as schema,
} from "./vscode-agent-host-fixtures/fixture.js";

const MAX_BYTES = 32 * 1024 * 1024;
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "vscode-agent-host-fixtures");
const roots: string[] = [];
const writers: DatabaseSync[] = [];

async function writeEvents(path: string, records: readonly object[]): Promise<void> {
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

async function fixture(hostId = SDK_ID) {
  // All synthetic data stays inside the owned project fixture directory, never a system temp directory.
  const root = join(fixtures, ".runs", randomUUID().slice(0, 8));
  roots.push(root);
  const item = await createVsCodeAgentHostFixture(root, { hostSessionId: hostId });
  return {
    ...item,
    capture: (maxBytes = MAX_BYTES, now = () => new Date(TIME)) => captureVsCodeAgentSession(item.input, item.source, item.homes, maxBytes, now),
  };
}

function mutate(path: string, work: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path);
  try { work(database); } finally { database.close(); }
}

function hostRows(archive: NativeSessionArchive, key = SDK_ID) {
  const file = archive.files.find((item) => item.path === `host/${key}/session.db.jsonl`)!;
  return file.content.trimEnd().split("\n").map((line) => JSON.parse(line) as {
    type: string; table?: string; rowid?: string; columns?: Record<string, unknown>; storageTypes?: Record<string, string>;
  });
}

function walWriter(path: string): DatabaseSync {
  const writer = new DatabaseSync(path);
  writers.push(writer);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  writer.prepare("UPDATE session_metadata SET value = ? WHERE key = 'customTitle'").run("WAL_COMMITTED_TITLE");
  return writer;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) writer.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("VS Code SDK Agent Host native capture", () => {
  it("exposes independently configurable synthetic IDs and source configuration for integration tests", async () => {
    const root = join(fixtures, ".runs", randomUUID().slice(0, 8));
    roots.push(root);
    const item = await createVsCodeAgentHostFixture(root, { harnessSessionId: HOST_ID, hostSessionId: SDK_ID });
    expect(item.input).toEqual({ harness: "vscode-copilot-agent", harnessSessionId: HOST_ID, hostSessionId: SDK_ID });
    expect(item.sources).toEqual({ vscode: item.source });
    expect(Object.keys(item.homes)).toEqual(["github-copilot-cli", "claude-code", "codex-cli"]);
    const archive = await captureVsCodeAgentSession(item.input, item.source, item.homes, MAX_BYTES, () => new Date(TIME));
    expect(parseNativeSessionArchive(JSON.stringify(archive))?.harnessSessionId).toBe(HOST_ID);
  });

  it("does not overwrite an existing directory when constructing integration fixtures", async () => {
    const item = await fixture();
    const before = await readFile(item.dbPath);
    await expect(createVsCodeAgentHostFixture(item.root)).rejects.toThrow("dedicated empty directory");
    expect(await readFile(item.dbPath)).toEqual(before);
  });

  it("preserves SDK events plus all selected v12 host rows, text edit bytes and native row order", async () => {
    const item = await fixture();
    const before = await readFile(item.dbPath);
    const archive = await item.capture();
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
    expect(archive).toMatchObject({
      format: "session-registry/native-session/3", harness: { name: "vscode-copilot-agent" },
      harnessSessionId: SDK_ID, capturedAt: TIME, resumable: false, scope: "persisted-session-records",
      sourceFormat: "vscode-agent-host-copilot-events-v1-session-db-v12;checkpoints=references-only",
    });
    expect(archive.harness.version).toContain(VSCODE_AGENT_HOST_COMMIT);
    expect(archive.files.find((file) => file.path === "sdk/events.jsonl")?.recordCount).toBe(9);
    const rows = hostRows(archive);
    expect(rows[0]).toMatchObject({ type: "vscode.session-database.schema", userVersion: 12, sourceCommit: VSCODE_AGENT_HOST_COMMIT });
    expect(rows.filter((row) => row.table === "turns").map((row) => row.columns?.id)).toEqual(["turn-z", "turn-a"]);
    expect(rows.filter((row) => row.table === "file_edits").map((row) => row.columns?.after_content)).toEqual(["HOST_AFTER\n", "HOST_CREATED\n"]);
    expect(rows.find((row) => row.table === "file_edits")).toMatchObject({
      columns: { before_content: "HOST_BEFORE\n", added_lines: "1", removed_lines: "1" },
      storageTypes: { before_content: "blob-utf8", after_content: "blob-utf8", added_lines: "integer" },
    });
    expect(rows.find((row) => row.table === "local_turns")).toMatchObject({
      columns: { seq: "9223372036854775807", payload: { id: "local-z", message: { text: "HOST_LOCAL_TURN" } } },
      storageTypes: { seq: "integer", payload: "text-json" },
    });
    expect(rows.find((row) => row.table === "chat_drafts")?.columns?.draft).toMatchObject({ text: "HOST_DRAFT" });
    expect(rows.find((row) => row.table === "turn_usage")?.columns?.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(rows.find((row) => row.table === "reviewed_files")?.columns?.nonce).toBe("native-reviewed-nonce");
    expect(await readFile(item.dbPath)).toEqual(before);
    expect(existsSync(`${item.dbPath}-wal`)).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("uses the persisted SDK binding when the raw host and SDK IDs differ, including a native backing marker (run %i)", async () => {
    const item = await fixture(HOST_ID);
    const markerPath = join(item.source.userDataPath, "agentSessionData", SDK_ID, "session.db");
    await mkdir(dirname(markerPath), { recursive: true });
    mutate(markerPath, (database) => {
      database.exec(schema);
      database.prepare("INSERT INTO session_metadata VALUES (?, ?)").run("peerChatBacking", item.chatUri);
    });
    const archive = await item.capture();
    expect(hostRows(archive, HOST_ID).some((row) => row.columns?.key === "defaultChatProviderData")).toBe(true);
    expect(hostRows(archive, SDK_ID).find((row) => row.table === "session_metadata")?.columns?.value).toBe(item.chatUri);
    await expect(captureVsCodeAgentSession(
      { harness: "vscode-copilot-agent", harnessSessionId: SDK_ID }, item.source, item.homes, MAX_BYTES,
    )).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_LINKAGE" });
  });

  it("requires native linkage rather than inferring identity from a matching directory", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec("DELETE FROM session_metadata WHERE key = 'defaultChatProviderData'"));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_LINKAGE" });
  });

  it("rejects mismatched providerData and turn mappings", async () => {
    const item = await fixture(HOST_ID);
    mutate(item.dbPath, (database) => database.prepare("UPDATE session_metadata SET value = ? WHERE key = 'defaultChatProviderData'").run(JSON.stringify({ sdkSessionId: HOST_ID })));
    await expect(item.capture()).rejects.toMatchObject({ code: "HOST_SESSION_MISMATCH" });
    mutate(item.dbPath, (database) => {
      database.prepare("UPDATE session_metadata SET value = ? WHERE key = 'defaultChatProviderData'").run(JSON.stringify({ sdkSessionId: SDK_ID }));
      database.exec("UPDATE turns SET event_id = 'missing-user-event' WHERE id = 'turn-z'");
    });
    await expect(item.capture()).rejects.toMatchObject({ code: "HOST_SESSION_MISMATCH" });
  });

  it("rejects reversed host turn order even if all event IDs exist", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec("UPDATE turns SET event_id = CASE id WHEN 'turn-z' THEN 'event-5' ELSE 'event-1' END"));
    await expect(item.capture()).rejects.toMatchObject({ code: "HOST_SESSION_MISMATCH" });
  });

  it("requires host file edits to match the SDK tool call's own turn", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec("UPDATE file_edits SET turn_id = 'turn-z' WHERE tool_call_id = 'edit-a'"));
    await expect(item.capture()).rejects.toMatchObject({ code: "INCOMPLETE_SOURCE" });
  });

  it("does not fall back to SDK-only capture or create a missing database", async () => {
    const item = await fixture();
    await rm(item.dbPath);
    await expect(item.capture()).rejects.toMatchObject({ code: "HOST_DATABASE_NOT_FOUND" });
    expect(existsSync(item.dbPath)).toBe(false);
  });

  it("rejects corrupt databases", async () => {
    const item = await fixture();
    await writeFile(item.dbPath, "this is not SQLite");
    await expect(item.capture()).rejects.toMatchObject({ code: "CORRUPT_HOST_DATABASE" });
  });

  it.each([0, 1, 11, 13])("rejects unsupported user_version %i without migrating it", async (version) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec(`PRAGMA user_version = ${version}`));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_SCHEMA" });
    mutate(item.dbPath, (database) => expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(version));
  });

  it.each([
    "CREATE TABLE unknown_payload (value BLOB)",
    "CREATE VIEW host_projection AS SELECT * FROM turns",
    "CREATE TRIGGER host_trigger AFTER INSERT ON turns BEGIN SELECT 1; END",
    "CREATE INDEX host_index ON turns(checkpoint_ref)",
    "ALTER TABLE turns ADD COLUMN unknown_payload BLOB",
    "DROP TABLE chat_drafts",
  ])("rejects unpinned schema changes: %s", async (sql) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec(sql));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_SCHEMA" });
  });

  it.each([
    "CREATE VIEW schema_tripwire AS SELECT load_extension('unauthorized-fixture-extension') AS payload",
    "CREATE TRIGGER schema_tripwire AFTER UPDATE ON session_metadata BEGIN INSERT INTO session_metadata VALUES ('schema_executed', 'unexpected'); END",
    "DROP TABLE reviewed_files; CREATE VIEW reviewed_files AS SELECT load_extension('unauthorized-fixture-extension') AS uri, 'nonce' AS nonce",
  ])("rejects schema code without executing it, loading extensions or mutating data: %s", async (sql) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec(sql));
    const before = await readFile(item.dbPath);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const load = vi.spyOn(DatabaseSync.prototype, "loadExtension");
    const enable = vi.spyOn(DatabaseSync.prototype, "enableLoadExtension");
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_SCHEMA" });
    const statements = [...exec.mock.calls, ...prepare.mock.calls].map(([statement]) => statement).join("\n");
    expect(statements).not.toMatch(/schema_tripwire|load_extension|schema_executed|\b(?:CREATE|INSERT|UPDATE|DELETE|VACUUM|ATTACH|DETACH|REINDEX)\b/i);
    expect(load).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(await readFile(item.dbPath)).toEqual(before);
  });

  it("rejects dangling foreign keys rather than dropping dependent rows", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec("PRAGMA foreign_keys = OFF; DELETE FROM turns WHERE id = 'turn-z'"));
    await expect(item.capture()).rejects.toMatchObject({ code: "CORRUPT_HOST_DATABASE" });
  });

  it("redacts actual metadata keys, embedded JSON cells, BLOB JSON, SDK secrets and AHP reasoning", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => {
      database.prepare("INSERT INTO session_metadata VALUES (?, ?)").run("password", "low-entropy-private-value");
      database.prepare("INSERT INTO session_metadata VALUES (?, ?)").run("configValues", JSON.stringify({
        nested: { authorization: "hidden-auth-value", password: "nested-private-value" },
        encoded: JSON.stringify({ system_prompt: "hidden-system-text" }),
      }));
      database.prepare("UPDATE file_edits SET before_content = ? WHERE tool_call_id = 'edit-z'").run(Buffer.from('{"api_key":"blob-private-value","public":"BLOB_PUBLIC"}'));
      database.prepare("UPDATE local_turns SET payload = ?").run(JSON.stringify({
        id: "local-z", message: { text: "VISIBLE_LOCAL", origin: { kind: "user" } }, state: "complete",
        responseParts: [{ kind: "reasoning", id: "private-part", content: "hidden-reasoning-text" }],
      }));
    });
    const records = events();
    await writeEvents(item.eventPath, [
      ...records,
      { type: "session.info", id: "event-9", parentId: "event-8", timestamp: TIME, data: { password: "sdk-private-value" } },
    ]);
    const archive = await item.capture();
    const text = JSON.stringify(archive);
    for (const secret of ["low-entropy-private-value", "hidden-auth-value", "nested-private-value", "hidden-system-text", "blob-private-value", "hidden-reasoning-text", "sdk-private-value"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("BLOB_PUBLIC");
    expect(text).toContain("VISIBLE_LOCAL");
    expect(archive.redactions.length).toBeGreaterThanOrEqual(7);
    expect(new Set(archive.redactions.map(({ id }) => id)).size).toBe(archive.redactions.length);
    expect(archive.redactions.every(({ source }) => archive.files.some(({ path }) => path === source))).toBe(true);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it.each([
    ["systemPrompt", "private prompt without a credential-shaped prefix"],
    ["env", '{"PRIVATE_SETTING":"sql-private-environment"}'],
    ["authorization", "opaque low entropy authorization value"],
    ["role", "system"],
    ["channel", "analysis"],
  ])("preserves metadata row identity while redacting the semantic key %s", async (key, value) => {
    const item = await fixture();
    let rowid = "";
    mutate(item.dbPath, (database) => {
      database.prepare("INSERT INTO session_metadata VALUES (?, ?)").run(key, value);
      rowid = String(database.prepare("SELECT rowid FROM session_metadata WHERE key = ?").get(key)?.rowid);
    });
    const archive = await item.capture();
    const rows = hostRows(archive).filter((row) => row.table === "session_metadata" && row.columns?.key === key);
    expect(rows).toEqual([{
      type: "vscode.session-database.row", table: "session_metadata", rowid,
      columns: { key, value: "[REDACTED]" }, storageTypes: { key: "text", value: "text" },
    }]);
    expect(archive.redactions).toContainEqual({
      id: "r1", source: `host/${SDK_ID}/session.db.jsonl`,
      category: key === "role" || key === "channel" ? "hidden-content" : "private-field",
    });
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it("keeps prototype-like keys and patch-shaped host JSON inert without mutating prototypes", async () => {
    const item = await fixture();
    const marker = "vscodeFixturePrototypePoison";
    const payload = `{"__proto__":{"${marker}":"proto-data"},"constructor":{"prototype":{"${marker}":"constructor-data"}},"prototype":{"${marker}":"prototype-data"},"operations":[{"op":"replace","path":["__proto__","${marker}"],"value":true},{"op":"replace","path":["constructor","prototype","${marker}"],"value":true},{"op":"replace","path":["prototype","${marker}"],"value":true}]}`;
    const prototypes = [Object.prototype, Array.prototype, Function.prototype];
    const before = prototypes.map((prototype) => new Map(Reflect.ownKeys(prototype).map((key) =>
      [key, Object.getOwnPropertyDescriptor(prototype, key)!] as const)));
    try {
      mutate(item.dbPath, (database) => {
        const insert = database.prepare("INSERT INTO session_metadata VALUES (?, ?)");
        insert.run("configValues", payload);
        for (const key of ["__proto__", "constructor", "prototype"]) insert.run(key, `${key}-inert-value`);
      });
      const rows = hostRows(await item.capture()).filter((row) => row.table === "session_metadata");
      expect(rows.find((row) => row.columns?.key === "configValues")?.columns?.value).toBe(payload);
      for (const key of ["__proto__", "constructor", "prototype"]) {
        expect(rows.find((row) => row.columns?.key === key)?.columns?.value).toBe(`${key}-inert-value`);
      }
      for (const [index, prototype] of prototypes.entries()) {
        expect(Reflect.ownKeys(prototype)).toEqual([...before[index]!.keys()]);
        for (const [key, descriptor] of before[index]!) {
          const actual = Object.getOwnPropertyDescriptor(prototype, key);
          expect(actual, `prototype descriptor ${String(key)}`).toBeDefined();
          for (const attribute of ["value", "get", "set", "writable", "enumerable", "configurable"] as const) {
            expect(actual?.[attribute], `prototype descriptor ${String(key)}.${attribute}`).toBe(descriptor[attribute]);
          }
        }
        expect(Object.hasOwn(prototype, marker)).toBe(false);
      }
      const parsed: unknown = JSON.parse(payload);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
    } finally {
      for (const [index, prototype] of prototypes.entries()) {
        if (!before[index]!.has(marker)) Reflect.deleteProperty(prototype, marker);
      }
    }
  });

  it.each([
    '{"text":"one","text":"two","origin":{"kind":"user"}}',
    '{"text":"x","origin":{"kind":"user"},"nested":"{\\"token\\":\\"one\\",\\"token\\":\\"two\\"}"}',
    "{",
    "null",
  ])("rejects malformed or duplicate-key host JSON: %s", async (draft) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE chat_drafts SET draft = ?").run(draft));
    await expect(item.capture()).rejects.toMatchObject({ code: "MALFORMED_SOURCE" });
  });

  it("preserves raw UTF-8 BLOB encoding, including BOM, Unicode and empty content", async () => {
    const item = await fixture();
    const after = "\ufeffhéllo 🌍\r\n";
    mutate(item.dbPath, (database) => database.prepare("UPDATE file_edits SET before_content = ?, after_content = ? WHERE tool_call_id = 'edit-z'").run(Buffer.alloc(0), Buffer.from(after)));
    const row = hostRows(await item.capture()).find((entry) => entry.table === "file_edits");
    expect(row?.columns?.before_content).toBe("");
    expect(Buffer.from(row?.columns?.after_content as string)).toEqual(Buffer.from(after));
    expect(row?.storageTypes?.after_content).toBe("blob-utf8");
  });

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from("binary\0bytes"), gzipSync("compressed secret content")])("rejects binary and unclassified compressed edit blobs", async (bytes) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE file_edits SET before_content = ? WHERE tool_call_id = 'edit-z'").run(bytes));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSCANNABLE_SOURCE" });
  });

  it.each([
    ["UPDATE session_metadata SET value = x'ff' WHERE key = 'customTitle'", "UNSUPPORTED_HOST_SCHEMA"],
    ["UPDATE session_metadata SET value = CAST(x'ff' AS TEXT) WHERE key = 'customTitle'", "UNSCANNABLE_SOURCE"],
    ["UPDATE file_edits SET added_lines = 1.5", "UNSUPPORTED_HOST_SCHEMA"],
    ["UPDATE file_edits SET before_content = NULL WHERE edit_type = 'edit'", "INCOMPLETE_SOURCE"],
  ])("rejects unsupported native cell types or missing edit bytes: %s", async (sql, code) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec(sql));
    await expect(item.capture()).rejects.toMatchObject({ code });
  });

  it("preserves native checkpoint refs without reading a Git store or claiming portable restore", async () => {
    const item = await fixture();
    const checkpoint = `refs/agents/${SDK_ID}/checkpoints/turn/1`;
    mutate(item.dbPath, (database) => database.prepare("UPDATE turns SET checkpoint_ref = ? WHERE id = 'turn-z'").run(checkpoint));
    const snapshot = await VsCodeSessionDatabase.open(item.source.userDataPath, SDK_ID, MAX_BYTES);
    try {
      expect(snapshot.rows.find((row) => row.table === "turns")?.columns.checkpoint_ref).toBe(checkpoint);
      await snapshot.assertUnchanged();
    } finally {
      await snapshot.close();
    }
    const archive = await item.capture();
    expect(hostRows(archive).find((row) => row.table === "turns")?.columns?.checkpoint_ref).toBe(checkpoint);
    expect(archive.sourceFormat).toContain("checkpoints=references-only");
    expect(archive.resumable).toBe(false);
    expect(archive.files.some((file) => file.path.includes(".git"))).toBe(false);
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });

  it.each(["", "refs/agents/../other", "refs/agents/x//y", "refs/agents/x/y.lock", "C:\\source", "arbitrary-summary"])(
    "rejects an invalid native checkpoint reference: %s",
    async (checkpoint) => {
      const item = await fixture();
      mutate(item.dbPath, (database) => database.prepare("UPDATE turns SET checkpoint_ref = ? WHERE id = 'turn-z'").run(checkpoint));
      await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_SCHEMA" });
    },
  );

  it("accepts metadata-only ctime changes while retaining the same database identity and bytes", async () => {
    const item = await fixture(HOST_ID);
    const before = await readFile(item.dbPath);
    const beforeStat = statSync(item.dbPath, { bigint: true });
    const mode = statSync(item.dbPath).mode;
    try {
      const archive = await item.capture(MAX_BYTES, () => {
        chmodSync(item.dbPath, mode & ~0o222);
        const afterStat = statSync(item.dbPath, { bigint: true });
        expect(afterStat.ctimeNs).not.toBe(beforeStat.ctimeNs);
        expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
        return new Date(TIME);
      });
      expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
      expect(await readFile(item.dbPath)).toEqual(before);
    } finally {
      chmodSync(item.dbPath, mode);
    }
  });

  it("rejects same-size database byte changes even when the modification time is restored", async () => {
    const item = await fixture();
    const unchangedTime = new Date("2026-09-11T10:00:00.000Z");
    utimesSync(item.dbPath, unchangedTime, unchangedTime);
    const beforeStat = statSync(item.dbPath, { bigint: true });
    const before = await readFile(item.dbPath);
    const changed = Buffer.from(before);
    const marker = changed.indexOf(Buffer.from("HOST_AFTER\n"));
    expect(marker).toBeGreaterThanOrEqual(0);
    changed[marker] = "X".charCodeAt(0);
    await expect(item.capture(MAX_BYTES, () => {
      writeFileSync(item.dbPath, changed);
      utimesSync(item.dbPath, unchangedTime, unchangedTime);
      const afterStat = statSync(item.dbPath, { bigint: true });
      expect(afterStat.size).toBe(beforeStat.size);
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
      return new Date(TIME);
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("captures native default-chat attachment paths derived from the actual base64url chat key", async () => {
    const item = await fixture(HOST_ID);
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    await writeFile(item.attachmentPath, "HOST_ATTACHMENT_SNAPSHOT");
    mutate(item.dbPath, (database) => database.prepare("UPDATE chat_drafts SET draft = ?").run(JSON.stringify({
      text: "draft with snapshot", origin: { kind: "user" },
      attachments: [{ type: "resource", uri: pathToFileURL(item.attachmentPath).href, label: "note.txt" }],
    })));
    const archive = await item.capture();
    expect(archive.files.find((file) => file.kind === "attachment")?.content).toBe("HOST_ATTACHMENT_SNAPSHOT");
    expect(archive.files.find((file) => file.kind === "attachment")?.path).toContain("/attachments/snapshot-id/note.txt");
  });

  it("rejects missing, external and binary host attachments", async () => {
    const item = await fixture();
    const draft = (path: string) => mutate(item.dbPath, (database) => database.prepare("UPDATE chat_drafts SET draft = ?").run(JSON.stringify({
      text: "draft", origin: { kind: "user" }, attachments: [{ type: "resource", uri: pathToFileURL(path).href, label: "note.txt" }],
    })));
    draft(item.attachmentPath);
    await expect(item.capture()).rejects.toMatchObject({ code: "MISSING_DEPENDENCY" });
    const outside = join(item.root, "outside.txt");
    await writeFile(outside, "DO_NOT_READ");
    draft(outside);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
    draft(item.attachmentPath);
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    await writeFile(item.attachmentPath, Buffer.from([0xff, 0]));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSCANNABLE_SOURCE" });
  });

  it("retains existing CLI fail-closed behavior for SDK references outside its selected root", async () => {
    const item = await fixture();
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    await writeFile(item.attachmentPath, "not a CLI-root dependency");
    const records = events();
    records[1] = { ...records[1]!, data: { content: "SDK_FIRST_USER", attachments: [{ type: "file", path: item.attachmentPath }] } } as typeof records[number];
    await writeEvents(item.eventPath, records);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it.each([
    { type: "embeddedResource", contentType: "text/plain", data: Buffer.from("inline-private-text").toString("base64") },
    { type: "resource", uri: "file:///unused.svg", contentType: "image/svg+xml" },
    { type: "futureAttachment", uri: "file:///unused.txt" },
  ])("rejects embedded, declared-media and future host attachment formats", async (attachment) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE chat_drafts SET draft = ?").run(JSON.stringify({
      text: "draft", origin: { kind: "user" }, attachments: [attachment],
    })));
    await expect(item.capture()).rejects.toMatchObject({
      code: attachment.type === "resource" ? "UNSCANNABLE_SOURCE" : "UNSUPPORTED_DEPENDENCY",
    });
  });

  it("does not silently strip a BOM from a host attachment through the shared text reader", async () => {
    const item = await fixture();
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    await writeFile(item.attachmentPath, "\ufeffHOST_SNAPSHOT");
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  it("does not use the CLI rollout decompressor on native host snapshots", async () => {
    const item = await fixture();
    const compressedPath = join(dirname(item.attachmentPath), "snapshot.jsonl.zst");
    await mkdir(dirname(compressedPath), { recursive: true });
    await writeFile(compressedPath, "not an authorized compressed host format");
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_COMPRESSION" });
  });

  it("rejects duplicate keys in JSONL attachment content before embedded JSON redaction", async () => {
    const item = await fixture();
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    await writeFile(item.attachmentPath, '{"public":1}\n{"password":"one","password":"two"}\n');
    await expect(item.capture()).rejects.toMatchObject({ code: "MALFORMED_SOURCE" });
  });

  it("rejects local terminal/content references without complete native dependency capture", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE local_turns SET payload = ?").run(JSON.stringify({
      id: "local-z", message: { text: "!command", origin: { kind: "user" } }, state: "complete",
      responseParts: [{ kind: "toolCall", toolCall: { toolCallId: "local-command", result: {
        content: [{ type: "terminal", resource: "ahp-terminal:/native-terminal", title: "command", result: { exitCode: 0 } }],
      } } }],
    })));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it("rejects future native response-part formats rather than exporting unclassified payloads", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE local_turns SET payload = ?").run(JSON.stringify({
      id: "local-z", message: { text: "user turn", origin: { kind: "user" } }, state: "complete",
      responseParts: [{ kind: "futureBinary", data: "unclassified-encoding" }],
    })));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it.each([
    ["peerChats", JSON.stringify([{ uri: `ahp-chat://peer/${Buffer.from(`copilot:/${SDK_ID}`).toString("base64url")}`, providerData: JSON.stringify({ sdkSessionId: HOST_ID }) }])],
    ["copilot.chats", JSON.stringify({ peer: { sdkSessionId: HOST_ID } })],
    ["agentHost.createdBySession", JSON.stringify({ session: `copilot:/${HOST_ID}` })],
  ])("rejects peer or parent dependency metadata %s", async (key, value) => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("INSERT OR REPLACE INTO session_metadata VALUES (?, ?)").run(key, value));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_LINEAGE" });
  });

  it("rejects selected peer-key databases instead of mistaking them for SDK IDs", async () => {
    const peerKey = `peer-${Buffer.from(`copilot:/${HOST_ID}`).toString("base64url")}`;
    const item = await fixture(peerKey);
    mutate(item.dbPath, (database) => database.exec("DELETE FROM session_metadata WHERE key = 'defaultChatProviderData'"));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_LINKAGE" });
  });

  it("rejects persisted host delegation and workspace transitions", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("INSERT INTO turn_delegation VALUES (?, ?)").run("turn-z", JSON.stringify({ session: `copilot:/${HOST_ID}`, status: "completed" })));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_LINEAGE" });
    mutate(item.dbPath, (database) => {
      database.exec("DELETE FROM turn_delegation");
      database.prepare("INSERT INTO turn_workspace_transition VALUES (?, ?)").run("turn-z", JSON.stringify({ from: "file:///old-workspace", to: "file:///new-workspace" }));
    });
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it("rejects SDK subagents even if their host catalog is transient", async () => {
    const item = await fixture();
    await writeEvents(item.eventPath, [...events(), {
      type: "subagent.started", data: { toolCallId: "child-call", agentName: "child" },
      id: "event-9", parentId: "event-8", timestamp: TIME,
    }]);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_LINEAGE" });
  });

  it("preserves the shared SDK event inventory guard", async () => {
    const item = await fixture();
    await writeEvents(item.eventPath, [...events(), {
      type: "future.unknown", data: {}, id: "event-9", parentId: "event-8", timestamp: TIME,
    }]);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_EVENT" });
  });

  it("rejects an unrelated chat draft inside the selected database", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE chat_drafts SET chat_uri = ?").run(`ahp-chat://peer/${Buffer.from(`copilot:/${SDK_ID}`).toString("base64url")}`));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_LINEAGE" });
  });

  it("does not inspect or export unrelated host sessions, SDK sessions, or tool-argument paths", async () => {
    const item = await fixture();
    const unrelated = join(item.source.userDataPath, "agentSessionData", HOST_ID, "session.db");
    await mkdir(dirname(unrelated), { recursive: true });
    await writeFile(unrelated, "PRIVATE_UNRELATED_HOST_DB");
    const unrelatedSdk = join(item.source.copilotHome, "session-state", HOST_ID, "events.jsonl");
    await mkdir(dirname(unrelatedSdk), { recursive: true });
    await writeFile(unrelatedSdk, "PRIVATE_UNRELATED_SDK");
    const records = events();
    records[2] = { ...records[2]!, data: { toolCallId: "edit-z", toolName: "edit", arguments: { path: unrelated } } } as typeof records[number];
    await writeEvents(item.eventPath, records);
    const text = JSON.stringify(await item.capture());
    expect(text).not.toContain("PRIVATE_UNRELATED_HOST_DB");
    expect(text).not.toContain("PRIVATE_UNRELATED_SDK");
  });

  it("enforces combined raw source byte limits, not independent per-source limits", async () => {
    const item = await fixture();
    const records = events();
    records[1] = { ...records[1]!, data: { content: "x".repeat(60_000) } } as typeof records[number];
    await writeEvents(item.eventPath, records);
    const limit = Math.max(statSync(item.dbPath).size, statSync(item.eventPath).size) + 1;
    await expect(item.capture(limit)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
  });

  it("bounds decoded JSON nesting and rejects unsafe JSON numbers", async () => {
    const item = await fixture();
    let nested: object = {};
    for (let index = 0; index < 90; index++) nested = { child: nested };
    mutate(item.dbPath, (database) => database.prepare("UPDATE turn_usage SET usage = ?").run(JSON.stringify(nested)));
    await expect(item.capture()).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
    mutate(item.dbPath, (database) => database.prepare("UPDATE turn_usage SET usage = ?").run('{"inputTokens":9007199254740993}'));
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  it("enforces the sanitized archive byte limit after JSON escaping expansion", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.prepare("UPDATE file_edits SET after_content = ? WHERE tool_call_id = 'edit-z'").run(Buffer.from("\u0001".repeat(30_000))));
    const limit = statSync(item.dbPath).size + statSync(item.eventPath).size + 1;
    await expect(item.capture(limit)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
  });

  it("bounds row counts before extracting large tables", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => {
      const insert = database.prepare("INSERT INTO session_metadata VALUES (?, ?)");
      database.exec("BEGIN");
      for (let index = 0; index < 10_001; index++) insert.run(`fixture-${index}`, "bounded");
      database.exec("COMMIT");
    });
    await expect(item.capture()).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
  });

  it("reads committed WAL content without losing the WAL-only update", async () => {
    const item = await fixture();
    walWriter(item.dbPath);
    const mainBefore = await readFile(item.dbPath);
    const walBefore = await readFile(`${item.dbPath}-wal`);
    const archive = await item.capture();
    expect(hostRows(archive).find((row) => row.columns?.key === "customTitle")?.columns?.value).toBe("WAL_COMMITTED_TITLE");
    expect(await readFile(item.dbPath)).toEqual(mainBefore);
    expect(await readFile(`${item.dbPath}-wal`)).toEqual(walBefore);
  });

  it.each(["delete", "wal"])("keeps journal mode %s unchanged and executes only read-side connection setup", async (mode) => {
    const item = await fixture();
    if (mode === "wal") walWriter(item.dbPath);
    function journalMode(): unknown {
      const database = new DatabaseSync(item.dbPath, { readOnly: true });
      try { return database.prepare("PRAGMA journal_mode").get()?.journal_mode; } finally { database.close(); }
    }
    expect(journalMode()).toBe(mode);
    const before = await readFile(item.dbPath);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const load = vi.spyOn(DatabaseSync.prototype, "loadExtension");
    const enable = vi.spyOn(DatabaseSync.prototype, "enableLoadExtension");
    await item.capture();
    const statements = [...exec.mock.calls, ...prepare.mock.calls].map(([statement]) => statement).join("\n");
    expect(statements).toContain("PRAGMA query_only = ON");
    expect(statements).toContain("PRAGMA trusted_schema = OFF");
    expect(statements).not.toMatch(/\bjournal_mode\b|\b(?:CREATE|INSERT|UPDATE|DELETE|VACUUM|ATTACH|DETACH|REINDEX)\b/i);
    expect(load).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(journalMode()).toBe(mode);
    expect(await readFile(item.dbPath)).toEqual(before);
  });

  it("rejects a concurrent WAL commit across the SDK/host capture boundary", async () => {
    const item = await fixture();
    const writer = walWriter(item.dbPath);
    await expect(item.capture(MAX_BYTES, () => {
      writer.exec("BEGIN; UPDATE session_metadata SET value = 'CONCURRENT_TITLE' WHERE key = 'customTitle'; UPDATE file_edits SET after_content = x'7878'; COMMIT;");
      return new Date(TIME);
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("does not create missing WAL sidecars for a closed WAL database", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => database.exec("PRAGMA journal_mode = WAL"));
    expect(existsSync(`${item.dbPath}-wal`)).toBe(false);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_HOST_JOURNAL" });
    expect(existsSync(`${item.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${item.dbPath}-shm`)).toBe(false);
  });

  it("rejects a present rollback journal", async () => {
    const item = await fixture();
    await writeFile(`${item.dbPath}-journal`, "uncommitted-transaction");
    await expect(item.capture()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it.each(["../escape", "parent\\child", "parent/child", "session.", "session:stream", "CON", "LPT1.txt"])("rejects unsafe host ID %s", async (hostSessionId) => {
    const item = await fixture();
    await expect(captureVsCodeAgentSession({ ...item.input, hostSessionId }, item.source, item.homes, MAX_BYTES))
      .rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
  });

  it("rejects host session directory junctions, even when their target stays in the configured root", async () => {
    const item = await fixture();
    const original = dirname(item.dbPath);
    const renamed = `${original}-real`;
    await rename(original, renamed);
    await symlink(renamed, original, "junction");
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
  });

  it("rejects database and attachment hard links", async () => {
    const item = await fixture();
    const alias = join(item.root, "database-alias");
    await link(item.dbPath, alias);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
    await rm(alias);
    await mkdir(dirname(item.attachmentPath), { recursive: true });
    const text = join(item.root, "outside.txt");
    await writeFile(text, "OUTSIDE_LINKED_CONTENT");
    await link(text, item.attachmentPath);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
  });

  it("checks WAL and shared-memory file identity before opening SQLite", async () => {
    const item = await fixture();
    walWriter(item.dbPath);
    const walAlias = join(item.root, "wal-alias");
    await link(`${item.dbPath}-wal`, walAlias);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
    await rm(walAlias);
    const shmAlias = join(item.root, "shm-alias");
    await link(`${item.dbPath}-shm`, shmAlias);
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSAFE_SOURCE_PATH" });
    await rm(shmAlias);
  });

  it("rejects unknown files in the selected host data directory", async () => {
    const item = await fixture();
    await writeFile(join(dirname(item.dbPath), "future-native-state.bin"), "unclassified native content");
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_DEPENDENCY" });
  });

  it("requires the exact VS Code Agent Host harness", async () => {
    const item = await fixture();
    await expect(captureVsCodeAgentSession({ ...item.input, harness: "github-copilot-cli" }, item.source, item.homes, MAX_BYTES))
      .rejects.toMatchObject({ code: "UNSUPPORTED_HARNESS" });
  });

  it("rejects lossy fractional numbers in host JSON text and BLOBs before redaction", async () => {
    const item = await fixture();
    mutate(item.dbPath, (database) => {
      database.prepare("UPDATE file_edits SET before_content = ? WHERE tool_call_id = 'edit-z'")
        .run(Buffer.from('{"password":"secret","amount":9007199254740990.5}'));
    });
    await expect(item.capture()).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  });

  it("accepts valid differently-cased paths for user-data and SDK roots without treating them as symlinks", async () => {
    const item = await fixture();
    const sourceWithUpperDrive = {
      ...item.source,
      userDataPath: item.source.userDataPath.toUpperCase(),
      copilotHome: item.source.copilotHome.toUpperCase(),
    };
    const archive = await captureVsCodeAgentSession(item.input, sourceWithUpperDrive, item.homes, MAX_BYTES, () => new Date(TIME));
    expect(parseNativeSessionArchive(JSON.stringify(archive))).toEqual(archive);
  });
});
