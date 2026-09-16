import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexCapture } from "../../src/native/codex.js";
import { NativeCaptureError, NativeFiles, sourceBytes } from "../../src/native/files.js";

const ROOT = "019ff1a2-b3c4-7d5e-8f60-112233445566";
const PARENT = "019ff1a2-b3c4-7d5e-8f60-667788990011";
const CHILD = "019ff1a2-b3c4-7d5e-8f60-222222222222";
const SECOND = "019ff1a2-b3c4-7d5e-8f60-333333333333";
const OTHER = "019ff1a2-b3c4-7d5e-8f60-444444444444";
const VERSION = "019ff1a2-b3c4-7d5e-8f60-555555555555";
const MAX_BYTES = 4 * 1024 * 1024;
const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function record(type: string, payload: unknown, ordinal?: number): string {
  return `${JSON.stringify({
    timestamp: "2026-09-10T20:00:00.000Z",
    ...(ordinal === undefined ? {} : { ordinal }),
    type, payload,
  })}\n`;
}

function metadata(id: string, extra: Record<string, unknown> = {}, ordinal?: number): string {
  const mode = extra.history_mode ?? "paginated";
  const base = extra.history_base as { end_ordinal_exclusive?: number } | undefined;
  return record("session_meta", {
    session_id: id, id, cli_version: "0.154.0", originator: "codex_cli_rs",
    cwd: "fixture-workspace", timestamp: "2026-09-10T20:00:00.000Z", source: "cli",
    history_mode: mode, history_base: null, ...extra,
  }, mode === "paginated" ? ordinal ?? base?.end_ordinal_exclusive ?? 0 : undefined);
}

function message(ordinal: number | undefined, text = "retained native content"): string {
  return record("response_item", {
    type: "message", role: "user", content: [{ type: "input_text", text }],
  }, ordinal);
}

function boundary(id: string, content: string, end: number) {
  return { thread_id: id, end_byte_offset: Buffer.byteLength(content), end_ordinal_exclusive: end };
}

// Stable 0.154.0 persists ItemCompleted -> TurnItem::CollabAgentToolCall.
// https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/items.rs#L306-L350
function spawn(parent: string, child: string, ordinal: number | undefined, tool = "spawn_agent"): string {
  return record("event_msg", {
    type: "item_completed", thread_id: parent, turn_id: "fixture-turn", completed_at_ms: 1,
    item: {
      type: "CollabAgentToolCall", id: `spawn-${child}`, tool, status: "completed",
      sender_thread_id: parent, receiver_thread_ids: [child],
      receiver_agents: [{ thread_id: child, agent_nickname: "fixture" }],
      agents_states: { [child]: "running" },
    },
  }, ordinal);
}

function legacySpawn(parent: string, child: string): string {
  return record("event_msg", {
    type: "collab_agent_spawn_end", call_id: "spawn-legacy", sender_thread_id: parent, new_thread_id: child,
  });
}

async function fixture() {
  const root = resolve(`.codex-resolver-${randomUUID()}`);
  directories.push(root);
  const home = join(root, "codex");
  await mkdir(home, { recursive: true });
  const reader = new NativeFiles(home, MAX_BYTES);
  async function write(
    id: string,
    content: string | Buffer = metadata(id) + message(1),
    options: { version?: string; archived?: boolean; compressed?: boolean; timestamp?: string } = {},
  ): Promise<string> {
    const ids = options.version === undefined ? id : `${id}_${options.version}`;
    const path = join(
      home, ...(options.archived ? ["archived_sessions"] : ["sessions", "2026", "09", "10"]),
      `rollout-${options.timestamp ?? "2026-09-10T20-00-00"}-${ids}.jsonl${options.compressed ? ".zst" : ""}`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, options.compressed ? zstdCompressSync(Buffer.from(content)) : content);
    return path;
  }
  async function state(sqliteHome = home, wal = false): Promise<DatabaseSync> {
    await mkdir(sqliteHome, { recursive: true });
    const database = new DatabaseSync(join(sqliteHome, "state_5.sqlite"));
    databases.push(database);
    if (wal) database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    // Selection-relevant columns from 0001_threads.sql and 0040_threads_history_mode.sql,
    // pinned at 6b9826e3. Global metadata is deliberately not an archive source.
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
      history_mode TEXT NOT NULL DEFAULT 'legacy', title TEXT, private_payload TEXT
    );`);
    return database;
  }
  function capture(input: { harnessSessionId?: string; sourcePath?: string; sqliteHome?: string } = {}, limit = MAX_BYTES) {
    return resolveCodexCapture(limit === MAX_BYTES ? reader : new NativeFiles(home, limit),
      { harnessSessionId: ROOT, ...input }, limit);
  }
  return { root, home, reader, write, state, capture };
}

function select(database: DatabaseSync, id: string, path: string, mode = "paginated"): void {
  database.prepare("INSERT INTO threads(id, rollout_path, history_mode) VALUES (?, ?, ?)").run(id, path, mode);
}

describe("Codex native rollout selection", () => {
  it("supports a normal durable paginated session with a null history base", async () => {
    const f = await fixture();
    const content = metadata(ROOT) + message(1);
    const path = await f.write(ROOT, content);
    const plan = await f.capture();
    expect(plan.selection).toBe("native-id");
    expect(plan.primary.absolutePath).toBe(path);
    expect(plan.primary.content).toBe(content);
    expect(plan.streams).toEqual([plan.primary]);
    expect(plan.history).toEqual([{ path: plan.primary.path, sessionId: ROOT, rolloutId: ROOT }]);
    await appendFile(path, message(2, "written after capture"));
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
    expect(plan.primary.content).not.toContain("written after capture");
  });

  it("keeps copied legacy forks, repeated metadata, malformed lines, and partial tails", async () => {
    const f = await fixture();
    const content = "\n{broken}\n" +
      metadata(ROOT, { history_mode: "legacy", history_base: undefined, forked_from_id: PARENT }) +
      message(undefined, "copied history") +
      metadata(PARENT, { history_mode: "legacy", history_base: undefined }) +
      message(undefined, "copied history") + '{"type":"partial"';
    await f.write(ROOT, content);
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(1);
    expect(plan.primary.content).toBe(content);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-json" }),
      expect.objectContaining({ code: "unterminated-record" }),
    ]));
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("uses the first decodable metadata rather than a malformed metadata-shaped record", async () => {
    const f = await fixture();
    const content = record("session_meta", { id: 4, cli_version: "0.154.0" }, 0) +
      metadata(ROOT, { history_mode: "legacy" }) + message(undefined);
    await f.write(ROOT, content);
    const plan = await f.capture();
    expect(plan.primary.content).toBe(content);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "codex-unknown-record", line: 1 }));
  });

  it("uses SQLite's selected immutable version, including an archived rollout and committed WAL", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + message(1, "old version"));
    const chosen = await f.write(ROOT, metadata(ROOT) + message(1, "chosen version"), { version: VERSION, archived: true });
    await f.write(ROOT, metadata(ROOT) + message(1, "lexically latest"), { version: SECOND, timestamp: "2026-09-11T23-59-59" });
    const database = await f.state(undefined, true);
    select(database, ROOT, chosen);
    database.prepare("INSERT INTO threads VALUES (?, ?, 'legacy', 'private title', 'GLOBAL-SECRET')").run(OTHER, "not-selected.jsonl");
    const before = await readFile(join(f.home, "state_5.sqlite"));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    expect(plan.selection).toBe("sqlite");
    expect(plan.primary.absolutePath).toBe(chosen);
    expect(plan.streams).toHaveLength(1);
    expect(plan.history[0]?.rolloutId).toBe(VERSION);
    expect(plan.selectionEvidence[0]).toMatchObject({
      profile: "codex-0.154.0@6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
      row: { id: ROOT, rollout_path: chosen, history_mode: "paginated" },
    });
    expect(JSON.stringify(plan)).not.toContain("GLOBAL-SECRET");
    expect(reads.mock.calls.map(([path]) => path)).toEqual([chosen]);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
    expect(await readFile(join(f.home, "state_5.sqlite"))).toEqual(before);
  });

  it("prefers a client's explicit runtime path over a stale selected SQLite version", async () => {
    const f = await fixture();
    const old = await f.write(ROOT);
    const live = await f.write(ROOT, metadata(ROOT) + message(1, "runtime writer"), { version: VERSION });
    select(await f.state(), ROOT, old);
    const plan = await f.capture({ sourcePath: live });
    expect(plan.selection).toBe("explicit-path");
    expect(plan.primary.absolutePath).toBe(live);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("allows an explicitly selected noncanonical legacy path but not a paginated rename", async () => {
    const f = await fixture();
    const path = join(f.home, "legacy-copy.jsonl");
    const content = metadata(ROOT, { history_mode: "legacy", history_base: undefined }) + message(undefined);
    await writeFile(path, content);
    expect((await f.capture({ sourcePath: path })).primary.content).toBe(content);
    await writeFile(path, metadata(ROOT) + message(1));
    await expect(resolveCodexCapture(new NativeFiles(f.home, MAX_BYTES),
      { harnessSessionId: ROOT, sourcePath: path }, MAX_BYTES)).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it("does not select a version by filename recency when SQLite is unavailable", async () => {
    const f = await fixture();
    await f.write(ROOT);
    await f.write(ROOT, undefined, { version: VERSION });
    await expect(f.capture()).rejects.toThrow("AMBIGUOUS_SESSION");
  });

  it("ignores native migration/compression staging files and invalid calendar filenames", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    for (const name of [`.${basename(path)}.paginated.tmp`, `${basename(path)}.tmp`,
      `rollout-2026-02-30T20-00-00-${ROOT}.jsonl`]) {
      await writeFile(join(dirname(path), name), "not a native candidate");
    }
    expect((await f.capture()).primary.absolutePath).toBe(path);
    await expect(f.capture({ sourcePath: `${path}.tmp` })).rejects.toThrow("UNSUPPORTED_FORMAT");
  });

  it.each(["native", "explicit", "sqlite"])("prefers a plain sibling with %s selection", async (selection) => {
    const f = await fixture();
    const plain = await f.write(ROOT, metadata(ROOT) + message(1, "plain"));
    const compressed = await f.write(ROOT, metadata(ROOT) + message(1, "older compressed"), { compressed: true });
    if (selection === "sqlite") select(await f.state(), ROOT, compressed);
    const plan = await f.capture(selection === "explicit" ? { sourcePath: compressed } : {});
    expect(plan.primary.absolutePath).toBe(plain);
    expect(plan.primary.native).toBeUndefined();
    expect(plan.streams).toHaveLength(1);
  });

  it("never falls back to an old version when the paginated SQLite-selected source is missing", async () => {
    const f = await fixture();
    const old = await f.write(ROOT);
    const missing = old.replace(ROOT, `${ROOT}_${VERSION}`);
    select(await f.state(), ROOT, missing);
    await expect(f.capture()).rejects.toMatchObject({
      code: "INCOMPLETE_SOURCE", message: expect.stringContaining(missing),
    });
  });

  it("retains the native unambiguous legacy fallback for a missing legacy SQLite path", async () => {
    const f = await fixture();
    const path = await f.write(ROOT, metadata(ROOT, { history_mode: "legacy" }) + message(undefined));
    select(await f.state(), ROOT, join(f.home, "missing-legacy.jsonl"), "legacy");
    const plan = await f.capture();
    expect(plan.selection).toBe("native-id");
    expect(plan.primary.absolutePath).toBe(path);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("requires stable metadata and filename identities even when a version suffix matches", async () => {
    const f = await fixture();
    const path = await f.write(OTHER, metadata(OTHER), { version: ROOT });
    await expect(f.capture({ sourcePath: path })).rejects.toThrow("SESSION_ID_MISMATCH");
    const mismatched = await f.write(ROOT, metadata(OTHER), { version: VERSION });
    await expect(f.capture({ sourcePath: mismatched })).rejects.toThrow("SESSION_ID_MISMATCH");
  });

  it("does not let sourcePath or selected SQLite paths escape CODEX_HOME", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.jsonl");
    await writeFile(outside, metadata(ROOT));
    await expect(f.capture({ sourcePath: outside })).rejects.toThrow("UNSAFE_SOURCE_PATH");
    select(await f.state(), ROOT, outside);
    await expect(f.capture()).rejects.toThrow("UNSAFE_SOURCE_PATH");
  });

  it("uses an explicitly relocated SQLite home without copying that global database", async () => {
    const f = await fixture();
    const old = await f.write(ROOT);
    const chosen = await f.write(ROOT, undefined, { version: VERSION });
    select(await f.state(), ROOT, old);
    const relocated = join(f.root, "relocated-state");
    select(await f.state(relocated), ROOT, chosen);
    await writeFile(join(f.home, "config.toml"), '[profiles.other]\nsqlite_home = "ambiguous"\n');
    const plan = await f.capture({ sqliteHome: relocated });
    expect(plan.primary.absolutePath).toBe(chosen);
    expect(plan.selectionEvidence[0]?.databasePath).toBe(join(relocated, "state_5.sqlite"));
    expect(plan.streams).toHaveLength(1);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("does not guess the producing client's drive for a rooted SQLite home", async () => {
    const f = await fixture();
    await f.write(ROOT);
    await expect(f.capture({ sqliteHome: f.home.slice(2) })).rejects.toThrow("INVALID_SQLITE_HOME");
  });

  it.each(["literal", "basic"])("reads a simple top-level TOML sqlite_home %s string", async (format) => {
    const f = await fixture();
    await f.write(ROOT);
    const chosen = await f.write(ROOT, undefined, { version: VERSION });
    const relocated = join(f.root, "state # selected");
    select(await f.state(relocated), ROOT, chosen);
    const value = format === "literal" ? `'${relocated}'` : JSON.stringify(relocated);
    await writeFile(join(f.home, "config.toml"),
      `# sqlite_home = "not a setting"\nmodel = "fixture"\nsqlite_home = ${value} # selected\n[features]\nfeature = true\n`);
    const plan = await f.capture();
    expect(plan.primary.absolutePath).toBe(chosen);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("does not interpret sqlite_home text inside a multiline instruction as configuration", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    await writeFile(join(f.home, "config.toml"),
      'instructions = """\nsqlite_home = "/not-authorized"\n[profiles.fake]\n"""\n[features]\nx = true\n');
    expect((await f.capture()).primary.absolutePath).toBe(path);
  });

  it("recognizes escaped TOML keys instead of silently ignoring a configured relocation", async () => {
    const f = await fixture();
    await f.write(ROOT);
    const chosen = await f.write(ROOT, undefined, { version: VERSION });
    const relocated = join(f.root, "escaped-key-state");
    select(await f.state(relocated), ROOT, chosen);
    await writeFile(join(f.home, "config.toml"), `"\\u0073qlite_home" = ${JSON.stringify(relocated)}\n`);
    expect((await f.capture({ sqliteHome: "   " })).primary.absolutePath).toBe(chosen);
  });

  it.each([
    'sqlite_home = "relative-state"\n',
    '[profiles.one]\nsqlite_home = "somewhere"\n',
    'sqlite_home = "one"\nsqlite_home = "two"\n',
    'profiles.one.sqlite_home = "elsewhere"\n',
    'profiles.one."\\u0073qlite_home" = "elsewhere"\n',
  ])("requires an explicit resolved SQLite home for ambiguous config: %s", async (config) => {
    const f = await fixture();
    await f.write(ROOT);
    await writeFile(join(f.home, "config.toml"), config);
    await expect(f.capture()).rejects.toThrow("INVALID_SQLITE_HOME");
  });

  it("rejects unknown SQLite selection schemas rather than pretending the database is absent", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    const database = new DatabaseSync(join(f.home, "state_5.sqlite"));
    databases.push(database);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);");
    await expect(f.capture()).rejects.toThrow("UNSUPPORTED_SQLITE_SCHEMA");
    expect((await f.capture({ sourcePath: path })).primary.absolutePath).toBe(path);
  });

  it("does not claim settled selection while a migration journal exists", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    await mkdir(join(f.home, "rollout-migrations"));
    await writeFile(join(f.home, "rollout-migrations", `${ROOT}.pending`), "");
    await expect(f.capture({ sourcePath: path })).rejects.toThrow("SOURCE_MIGRATION_PENDING");
  });
});

describe("Codex bounded native history", () => {
  it("captures only the inherited decoded prefix and does not follow logical fork metadata", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1, "inherited λ") + message(2, "kept");
    const parent = await f.write(PARENT, prefix + message(3, "EXCLUDED-PARENT-SUFFIX"));
    await f.write(ROOT, metadata(ROOT, {
      history_base: boundary(PARENT, prefix, 3), forked_from_id: OTHER, forked_from_ordinal_exclusive: 17,
    }) + message(4, "child-local"));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    const source = plan.streams.find((file) => file.absolutePath === parent)!;
    expect(reads.mock.calls.filter(([path]) => path === parent)).toEqual([
      [parent, { endByteOffset: Buffer.byteLength(prefix) }],
    ]);
    expect(source.content).toBe(prefix);
    expect(source.observedSize).toBeGreaterThan(source.capturedSize);
    expect(plan.streams).toHaveLength(2);
    expect(plan.history).toEqual([
      { path: source.path, sessionId: PARENT, rolloutId: PARENT, endByteOffset: Buffer.byteLength(prefix), endOrdinalExclusive: 3 },
      { path: plan.primary.path, sessionId: ROOT, rolloutId: ROOT },
    ]);
    await writeFile(parent, prefix + message(3, "a rewritten and longer unrelated suffix"));
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("resolves history_base.thread_id as a rollout version, not the stable thread or its SQLite selection", async () => {
    const f = await fixture();
    await f.write(PARENT, metadata(PARENT) + message(1, "not inherited"));
    const prefix = metadata(PARENT) + message(1, "specific inherited version");
    const inherited = await f.write(PARENT, prefix + message(2, "EXCLUDED"), { version: VERSION, archived: true });
    const current = await f.write(PARENT, metadata(PARENT) + message(1, "not this selected version"), { version: OTHER });
    const primary = await f.write(ROOT, metadata(ROOT, { history_base: boundary(VERSION, prefix, 2) }) + message(3));
    const database = await f.state();
    select(database, PARENT, current);
    select(database, ROOT, primary);
    const plan = await f.capture();
    expect(plan.streams.map((source) => source.absolutePath)).toEqual([primary, inherited]);
    expect(plan.history[0]).toMatchObject({ sessionId: PARENT, rolloutId: VERSION });
    expect(plan.streams[1]?.content).toBe(prefix);
  });

  it("orders nested ancestry oldest-first, including an empty intermediate segment and compressed archived source", async () => {
    const f = await fixture();
    const oldest = metadata(PARENT) + message(1, "λ\r\npreserved unicode") + message(2) + message(3);
    const oldestPath = await f.write(PARENT, oldest + message(4, "EXCLUDED-OLDEST"), { archived: true, compressed: true });
    const middle = metadata(SECOND, { history_base: boundary(PARENT, oldest, 4) });
    const middlePath = await f.write(SECOND, middle + message(5, "EXCLUDED-MIDDLE"));
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(SECOND, middle, 5) }) + message(6));
    const plan = await f.capture();
    expect(plan.history.map((segment) => segment.sessionId)).toEqual([PARENT, SECOND, ROOT]);
    expect(plan.history.map((segment) => segment.endOrdinalExclusive)).toEqual([4, 5, undefined]);
    const compressed = plan.streams.find((source) => source.absolutePath === oldestPath)!;
    expect(compressed.content).toBe(oldest);
    expect(compressed.snapshotKind).toBe("decoded-prefix");
    expect(zstdDecompressSync(Buffer.from(compressed.native!.bytesBase64, "base64"))).toEqual(Buffer.from(oldest));
    expect(plan.streams.find((source) => source.absolutePath === middlePath)?.content).toBe(middle);
    expect(JSON.stringify(plan.streams)).not.toContain("EXCLUDED");
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("uses logical ordinals rather than physical lines and preserves tolerated projection anomalies", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + "\r\n" + message(1) + "{broken}\n" +
      record("future_native_record", { opaque: true }, 900) +
      message(1, "duplicate ordinal") + message(undefined, "missing ordinal") +
      message(3, "native forward gap");
    await f.write(PARENT, prefix + message(4, "EXCLUDED"));
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, prefix, 4) }) + message(5));
    const plan = await f.capture();
    expect(plan.streams.find((file) => file.path.includes(PARENT))?.content).toBe(prefix);
    expect(plan.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "invalid-json", "codex-unknown-record", "codex-duplicate-or-regressed-ordinal", "codex-missing-ordinal", "codex-ordinal-gap",
    ]));
  });

  it("ignores unknown native event/item ordinals, but retains native ResponseItem::Other ordinal evidence", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) +
      record("event_msg", { type: "future_native_event" }, 999) +
      record("event_msg", { type: "item_completed", thread_id: PARENT, turn_id: "fixture-turn", item: { type: "FutureTurnItem" } }, 999) +
      record("response_item", { type: "future_response_item", opaque: true }, 1);
    await f.write(PARENT, prefix + message(2, "EXCLUDED"));
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, prefix, 2) }));
    const plan = await f.capture();
    expect(plan.streams.find((source) => source.path.includes(PARENT))?.content).toBe(prefix);
    expect(plan.diagnostics.filter(({ code }) => code === "codex-unknown-record")).toHaveLength(2);
  });

  it("does not use decimal or exponent-spelled ordinals as native u64 prefix evidence", async () => {
    const f = await fixture();
    const decimal = message(900).replace('"ordinal":900', '"ordinal":900.0');
    const exponent = message(900).replace('"ordinal":900', '"ordinal":9e2');
    const valid = message(1).replace('"ordinal":1', '"ordinal":900,"\\u006frdinal":1');
    const prefix = metadata(PARENT) + decimal + exponent + valid;
    await f.write(PARENT, prefix + message(2, "EXCLUDED"));
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, prefix, 2) }));
    const plan = await f.capture();
    expect(plan.streams.find((source) => source.path.includes(PARENT))?.content).toBe(prefix);
    expect(plan.diagnostics.filter(({ code }) => code === "codex-unknown-record")).toHaveLength(2);
  });

  it("unions shared ancestor prefixes by maximum byte extent without duplicating paths or losing per-child bounds", async () => {
    const f = await fixture();
    const short = metadata(PARENT) + message(1, "short inherited range");
    const long = short + message(2) + message(3, "long inherited range");
    const ancestor = await f.write(PARENT, long + message(4, "EXCLUDED-SHARED-SUFFIX"));
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1) + spawn(ROOT, SECOND, 2));
    await f.write(CHILD, metadata(CHILD, {
      session_id: ROOT, parent_thread_id: ROOT, history_base: boundary(PARENT, short, 2),
    }) + message(3));
    await f.write(SECOND, metadata(SECOND, {
      session_id: ROOT, parent_thread_id: ROOT, history_base: boundary(PARENT, long, 4),
    }) + message(5));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(4);
    expect(new Set(plan.streams.map((source) => source.path)).size).toBe(4);
    expect(plan.streams.find((source) => source.absolutePath === ancestor)?.content).toBe(long);
    expect(reads.mock.calls.filter(([path]) => path === ancestor)).toEqual([
      [ancestor, { endByteOffset: Buffer.byteLength(short) }],
      [ancestor, { endByteOffset: Buffer.byteLength(long) }],
    ]);
    expect(plan.history.filter((segment) => segment.sessionId === PARENT).map((segment) =>
      [segment.endByteOffset, segment.endOrdinalExclusive])).toEqual([
      [Buffer.byteLength(short), 2], [Buffer.byteLength(long), 4],
    ]);
    expect(JSON.stringify(plan.streams)).not.toContain("EXCLUDED-SHARED-SUFFIX");
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("does not duplicate the selected primary when a real child's bounded history references it", async () => {
    const f = await fixture();
    const prefix = metadata(ROOT) + message(1);
    const path = await f.write(ROOT, prefix + spawn(ROOT, CHILD, 2) + message(3, "root's own later history"));
    await f.write(CHILD, metadata(CHILD, {
      session_id: ROOT, parent_thread_id: ROOT, history_base: boundary(ROOT, prefix, 2),
    }) + message(3));
    const plan = await f.capture();
    expect(plan.streams.map((source) => source.absolutePath).filter((value) => value === path)).toHaveLength(1);
    expect(plan.primary.content).toContain("root's own later history");
    expect(plan.history.filter((segment) => segment.sessionId === ROOT)).toHaveLength(2);
  });

  it("bounds plain ancestor reads even when the unrelated physical suffix exceeds the entire capture budget", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1);
    await f.write(PARENT, prefix + message(2, "X".repeat(128 * 1024)));
    const child = metadata(ROOT, { history_base: boundary(PARENT, prefix, 2) }) + message(3);
    await f.write(ROOT, child);
    const plan = await f.capture({}, Buffer.byteLength(prefix + child) + 16);
    expect(plan.streams.reduce((sum, source) => sum + sourceBytes(source).length, 0)).toBe(Buffer.byteLength(prefix + child));
  });

  it("reports a genuinely missing required ancestor instead of treating fork metadata as complete", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT, {
      history_base: { thread_id: PARENT, end_byte_offset: 100, end_ordinal_exclusive: 2 },
    }));
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it("reports an inherited cutoff that never reaches a complete metadata record as incomplete", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1);
    await f.write(PARENT, prefix);
    await f.write(ROOT, metadata(ROOT, {
      history_base: { thread_id: PARENT, end_byte_offset: 20, end_ordinal_exclusive: 1 },
    }));
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
  });

  it("detects rollout dependency cycles independently of repeated child references", async () => {
    const f = await fixture();
    const parent = metadata(PARENT, {
      history_base: { thread_id: ROOT, end_byte_offset: 100, end_ordinal_exclusive: 3 },
    }) + message(4);
    await f.write(PARENT, parent);
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, parent, 5) }));
    await expect(f.capture()).rejects.toMatchObject({ code: "INVALID_LINEAGE", message: expect.stringContaining("cycle") });
  });

  it.each(["past-end", "mid-record", "too-low-ordinal", "unreached-ordinal"])("validates inherited %s boundaries", async (kind) => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1) + message(2);
    await f.write(PARENT, prefix);
    const position = boundary(PARENT, prefix, 3);
    if (kind === "past-end") position.end_byte_offset += 1;
    if (kind === "mid-record") position.end_byte_offset -= 2;
    if (kind === "too-low-ordinal") position.end_ordinal_exclusive = 2;
    if (kind === "unreached-ordinal") position.end_ordinal_exclusive = 7;
    await f.write(ROOT, metadata(ROOT, { history_base: position }));
    await expect(f.capture()).rejects.toMatchObject({
      code: kind === "mid-record" || kind === "too-low-ordinal" ? "INVALID_SOURCE_BOUNDARY" : "INCOMPLETE_SOURCE",
    });
  });

  it("does not accept a legacy source as a referenced paginated ancestor", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT, { history_mode: "legacy" }) + message(undefined);
    await f.write(PARENT, prefix);
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, prefix, 2) }));
    await expect(f.capture()).rejects.toThrow("INVALID_LINEAGE");
  });

  it("checks migration journals against an ancestor's stable identity, not its version UUID", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1);
    await f.write(PARENT, prefix, { version: VERSION });
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(VERSION, prefix, 2) }));
    await mkdir(join(f.home, "rollout-migrations"));
    await writeFile(join(f.home, "rollout-migrations", `${PARENT}.pending`), "");
    await expect(f.capture()).rejects.toThrow("SOURCE_MIGRATION_PENDING");
  });

  it("rejects an incomplete copied subagent prefix but not a complete prefix with an optional partial tail", async () => {
    const f = await fixture();
    const partial = metadata(ROOT, { subagent_history_start_ordinal: 5 }) + message(1);
    const path = await f.write(ROOT, partial);
    await expect(f.capture()).rejects.toThrow("INCOMPLETE_SOURCE");
    const content = partial + message(2) + message(3) + message(4) + '{"type":"partial"';
    await writeFile(path, content);
    const plan = await resolveCodexCapture(new NativeFiles(f.home, MAX_BYTES), { harnessSessionId: ROOT }, MAX_BYTES);
    expect(plan.primary.content).toBe(content);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "unterminated-record" }));
  });

  it("preserves binary undecodable optional source lines without rewriting UTF-8", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([Buffer.from(metadata(ROOT) + message(1)), Buffer.from([0xff, 0xfe, 10]), Buffer.from('{"partial":')]);
    await f.write(ROOT, bytes);
    const plan = await f.capture();
    expect(sourceBytes(plan.primary)).toEqual(bytes);
    expect(plan.primary.contentEncoding).toBe("base64");
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-utf8" }));
  });
});

describe("Codex typed child containment", () => {
  it("captures durable native spawns once despite repeated IDs and legacy duplicate completion evidence", async () => {
    const f = await fixture();
    const root = metadata(ROOT) + spawn(ROOT, CHILD, 1) + spawn(ROOT, CHILD, 2) + legacySpawn(ROOT, CHILD);
    await f.write(ROOT, root);
    const child = await f.write(CHILD, metadata(CHILD, { session_id: ROOT, parent_thread_id: ROOT }) + message(1));
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(2);
    expect(plan.streams[1]?.absolutePath).toBe(child);
    expect(plan.primary.content).toBe(root);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("never treats communication receivers, same-root peers, or logical forks as children", async () => {
    const f = await fixture();
    let content = metadata(ROOT, { forked_from_id: PARENT });
    for (const tool of ["send_message", "send_input", "resume_agent", "wait", "close_agent", "followup_task", "interrupt_agent", "list_agents"]) {
      content += spawn(ROOT, OTHER, 1, tool);
    }
    content += record("event_msg", { type: "collab_agent_interaction_end", sender_thread_id: ROOT, receiver_thread_id: OTHER }, 2);
    content += record("inter_agent_communication", { sender_thread_id: ROOT, receiver_thread_id: OTHER }, 3);
    content += record("response_item", { type: "function_call", name: "send_message", call_id: "message", arguments: "{}" }, 4);
    content += record("response_item", { type: "function_call_output", call_id: "message", output: JSON.stringify({ agent_id: OTHER }) }, 5);
    const primary = await f.write(ROOT, content);
    await f.write(OTHER, metadata(OTHER, { session_id: ROOT }) + message(1, "UNRELATED-PRIVATE-SOURCE"));
    await f.write(PARENT, metadata(PARENT) + message(1, "UNRELATED-FORK-PARENT"));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(1);
    expect(reads.mock.calls.map(([path]) => path)).toEqual([primary]);
    expect(plan.allowedDependencies.every((path) => path.startsWith(f.home) && path.endsWith(ROOT))).toBe(true);
  });

  it("supports paired legacy spawn results and nested mixed legacy/paginated/compressed children", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1));
    await f.write(CHILD, metadata(CHILD, {
      history_mode: "legacy", session_id: ROOT,
      source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1 } } },
    }) +
      record("response_item", { type: "function_call_output", call_id: "nested", output: JSON.stringify({ agent_id: SECOND, nickname: "nested" }) }) +
      record("response_item", { type: "function_call", name: "spawn_agent", call_id: "nested", arguments: "{}" }));
    const grandchild = await f.write(SECOND, metadata(SECOND, { session_id: ROOT, parent_thread_id: CHILD }) + message(1),
      { compressed: true, archived: true });
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(3);
    expect(plan.streams.find((source) => source.absolutePath === grandchild)?.native).toBeDefined();
    expect(plan.history.map((segment) => segment.sessionId)).toEqual([ROOT, CHILD, SECOND]);
  });

  it("does not promote copied subagent context into child-local spawn authorization", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT, { subagent_history_start_ordinal: 4 }) +
      record("response_item", { type: "function_call", name: "spawn_agent", call_id: "inherited", arguments: "{}" }, 1) +
      record("response_item", { type: "function_call_output", call_id: "inherited", output: JSON.stringify({ agent_id: OTHER }) }, 2) +
      message(3) + spawn(ROOT, CHILD, 4));
    await f.write(CHILD, metadata(CHILD, { session_id: ROOT, parent_thread_id: ROOT }) + message(1));
    const unrelated = await f.write(OTHER, metadata(OTHER, { session_id: ROOT, parent_thread_id: PARENT }) + message(1, "UNRELATED"));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(2);
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(unrelated);
  });

  it("checks weak legacy spawn ownership without capturing an unrelated large source or its pending migration", async () => {
    const f = await fixture();
    const content = metadata(ROOT, { history_mode: "legacy", forked_from_id: PARENT }) +
      record("response_item", { type: "function_call", name: "spawn_agent", call_id: "copied", arguments: "{}" }) +
      record("response_item", { type: "function_call_output", call_id: "copied", output: JSON.stringify({ agent_id: OTHER }) });
    const primary = await f.write(ROOT, content);
    const unrelated = await f.write(OTHER,
      metadata(OTHER, { session_id: PARENT, parent_thread_id: PARENT }) + message(1, "X".repeat(128 * 1024)));
    await mkdir(join(f.home, "rollout-migrations"));
    await writeFile(join(f.home, "rollout-migrations", `${OTHER}.pending`), "");
    const reader = new NativeFiles(f.home, 2048);
    const reads = vi.spyOn(reader, "read");
    const plan = await resolveCodexCapture(reader, { harnessSessionId: ROOT }, 2048);
    expect(plan.streams).toHaveLength(1);
    expect(reads.mock.calls.map(([path]) => path)).toEqual([primary]);
    await writeFile(unrelated, "this unrelated thread can change after its metadata was inspected");
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("does not turn copied legacy outputs naming a captured ancestor into a containment cycle", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1));
    await f.write(CHILD, metadata(CHILD, { history_mode: "legacy", parent_thread_id: ROOT, session_id: ROOT }) +
      record("response_item", { type: "function_call", name: "spawn_agent", call_id: "copied", arguments: "{}" }) +
      record("response_item", { type: "function_call_output", call_id: "copied", output: [{ type: "input_text", text: JSON.stringify({ agent_id: ROOT }) }] }));
    expect((await f.capture()).streams).toHaveLength(2);
  });

  it("does not capture the original parent's children from a bounded physical ancestor", async () => {
    const f = await fixture();
    const inherited = metadata(PARENT) + spawn(PARENT, OTHER, 1);
    await f.write(PARENT, inherited);
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, inherited, 2) }) + message(3));
    const unrelated = await f.write(OTHER, metadata(OTHER, { session_id: PARENT, parent_thread_id: PARENT }) + message(1));
    const reads = vi.spyOn(f.reader, "read");
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(2);
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(unrelated);
  });

  it.each(["parent", "root"])("validates actual child %s metadata against the spawning thread", async (kind) => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1));
    await f.write(CHILD, metadata(CHILD, {
      parent_thread_id: kind === "parent" ? OTHER : ROOT,
      session_id: kind === "root" ? OTHER : ROOT,
    }) + message(1));
    await expect(f.capture()).rejects.toThrow("INVALID_CHILD_RELATIONSHIP");
  });

  it("reports a missing actual spawned source, but leaves incomplete spawn outputs as raw evidence", async () => {
    const f = await fixture();
    const path = await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1));
    await expect(f.capture()).rejects.toThrow("MISSING_SUBAGENT");
    const content = metadata(ROOT) +
      record("response_item", { type: "function_call", name: "spawn_agent", call_id: "unfinished", arguments: "{}" }, 1) +
      record("response_item", { type: "function_call_output", call_id: "unfinished", output: '{"agent_id":' }, 2);
    await writeFile(path, content);
    expect((await resolveCodexCapture(new NativeFiles(f.home, MAX_BYTES), { harnessSessionId: ROOT }, MAX_BYTES)).primary.content).toBe(content);
  });

  it("ignores undecodable collaboration records but includes a real child from complete unterminated JSON", async () => {
    const f = await fixture();
    const incomplete = record("event_msg", {
      type: "item_completed", item: {
        type: "CollabAgentToolCall", tool: "spawn_agent", sender_thread_id: ROOT, receiver_thread_ids: [OTHER],
      },
    }, 1);
    const content = metadata(ROOT) + incomplete + spawn(ROOT, CHILD, 2).trimEnd();
    await f.write(ROOT, content);
    const child = await f.write(CHILD, metadata(CHILD, { session_id: ROOT, parent_thread_id: ROOT }) + message(1));
    const plan = await f.capture();
    expect(plan.streams).toHaveLength(2);
    expect(plan.streams[1]?.absolutePath).toBe(child);
    expect(plan.primary.content).toBe(content);
    expect(plan.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "codex-unknown-record", "unterminated-record",
    ]));
  });

  it("detects a real containment cycle rather than confusing repeat references with cycles", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1));
    await f.write(CHILD, metadata(CHILD, { session_id: ROOT, parent_thread_id: ROOT }) + spawn(CHILD, ROOT, 1));
    await expect(f.capture()).rejects.toMatchObject({
      code: "INVALID_CHILD_RELATIONSHIP", message: expect.stringContaining("cycle"),
    });
  });

  it("rejects two typed parents assigning the same child even when old metadata omitted parent_thread_id", async () => {
    const f = await fixture();
    await f.write(ROOT, metadata(ROOT) + spawn(ROOT, CHILD, 1) + spawn(ROOT, SECOND, 2));
    await f.write(CHILD, metadata(CHILD, { session_id: ROOT }));
    await f.write(SECOND, metadata(SECOND, { session_id: ROOT, parent_thread_id: ROOT }) + spawn(SECOND, CHILD, 1));
    await expect(f.capture()).rejects.toMatchObject({
      code: "INVALID_CHILD_RELATIONSHIP", message: expect.stringContaining("conflicting parent"),
    });
  });
});

describe("Codex source-selection observation boundaries", () => {
  it("detects a SQLite selector switch while the original captured source stays unchanged", async () => {
    const f = await fixture();
    const original = await f.write(ROOT);
    const replacement = await f.write(ROOT, undefined, { version: VERSION });
    const database = await f.state();
    select(database, ROOT, original);
    const plan = await f.capture();
    database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(replacement, ROOT);
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("allows source appends and unrelated SQLite metadata updates", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    const database = await f.state(undefined, true);
    select(database, ROOT, path);
    const plan = await f.capture();
    await appendFile(path, message(2));
    database.prepare("UPDATE threads SET title = 'new title' WHERE id = ?").run(ROOT);
    await expect(plan.assertUnchanged()).resolves.toBeUndefined();
  });

  it("detects a newly ambiguous filesystem version even with a cached NativeFiles inventory", async () => {
    const f = await fixture();
    await f.write(ROOT);
    const plan = await f.capture();
    await f.write(ROOT, undefined, { version: VERSION });
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects a new authoritative SQLite row instead of silently finishing an old native-id selection", async () => {
    const f = await fixture();
    await f.write(ROOT);
    const plan = await f.capture();
    const replacement = await f.write(ROOT, undefined, { version: VERSION });
    select(await f.state(), ROOT, replacement);
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects a new plain representation before accepting a compressed observation", async () => {
    const f = await fixture();
    await f.write(ROOT, undefined, { compressed: true });
    const plan = await f.capture();
    await f.write(ROOT);
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("detects newly pending migration state, even with an explicit source path", async () => {
    const f = await fixture();
    const path = await f.write(ROOT);
    const plan = await f.capture({ sourcePath: path });
    await mkdir(join(f.home, "rollout-migrations"));
    await writeFile(join(f.home, "rollout-migrations", `${ROOT}.pending`), "");
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_MIGRATION_PENDING");
  });

  it("rejects captured ancestor prefix rewrites while allowing untouched suffixes to change", async () => {
    const f = await fixture();
    const prefix = metadata(PARENT) + message(1, "captured");
    const path = await f.write(PARENT, prefix + message(2, "uncaptured"));
    await f.write(ROOT, metadata(ROOT, { history_base: boundary(PARENT, prefix, 2) }) + message(3));
    const plan = await f.capture();
    await writeFile(path, prefix.replace("captured", "rewritten") + message(2, "uncaptured"));
    await expect(plan.assertUnchanged()).rejects.toThrow("SOURCE_CHANGED");
  });

  it("returns stable actionable capture errors for native identity and resource failures", async () => {
    const f = await fixture();
    await expect(f.capture({ harnessSessionId: `${ROOT}_${VERSION}` })).rejects.toBeInstanceOf(NativeCaptureError);
    await f.write(ROOT);
    await expect(f.capture({}, 1)).rejects.toMatchObject({ code: "SOURCE_LIMIT" });
  });

  it("keeps assertion-time filesystem failures actionable rather than leaking raw I/O errors", async () => {
    const f = await fixture();
    await f.write(ROOT);
    const plan = await f.capture();
    vi.spyOn(f.reader, "assertUnchanged").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(plan.assertUnchanged()).rejects.toMatchObject({ code: "SOURCE_READ_FAILED" });
  });
});
