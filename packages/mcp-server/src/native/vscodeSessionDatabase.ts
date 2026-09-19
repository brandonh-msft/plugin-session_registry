import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  NativeCaptureError,
  NativeFiles,
  isMissingFile,
  isNativeObject,
  parseNativeJson,
  type NativeObject,
  type NativeValue,
} from "./files.js";

export const VSCODE_AGENT_HOST_COMMIT = "cbea5b4b6a964508352be917d3ddbdc6fc6e7a75";
const MAX_ROWS = 10_000;

interface Table {
  readonly name: string;
  readonly sql: string;
  readonly columns: Readonly<Record<string, "TEXT" | "INTEGER" | "BLOB">>;
  readonly json?: readonly string[];
}

// sessionDatabase.ts at VSCODE_AGENT_HOST_COMMIT, migrations 1–12. No migrations run on sources.
const TABLES: readonly Table[] = [
  {
    name: "turns",
    sql: "CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, event_id TEXT, checkpoint_ref TEXT)",
    columns: { id: "TEXT", event_id: "TEXT", checkpoint_ref: "TEXT" },
  },
  {
    name: "file_edits",
    sql: `CREATE TABLE file_edits (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL, file_path TEXT NOT NULL,
      edit_type TEXT NOT NULL DEFAULT 'edit', original_path TEXT,
      before_content BLOB, after_content BLOB, added_lines INTEGER, removed_lines INTEGER,
      PRIMARY KEY (tool_call_id, file_path))`,
    columns: {
      turn_id: "TEXT", tool_call_id: "TEXT", file_path: "TEXT", edit_type: "TEXT", original_path: "TEXT",
      before_content: "BLOB", after_content: "BLOB", added_lines: "INTEGER", removed_lines: "INTEGER",
    },
  },
  {
    name: "session_metadata",
    sql: "CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    columns: { key: "TEXT", value: "TEXT" },
  },
  {
    name: "chat_drafts",
    sql: "CREATE TABLE chat_drafts (chat_uri TEXT PRIMARY KEY NOT NULL, draft TEXT NOT NULL)",
    columns: { chat_uri: "TEXT", draft: "TEXT" },
    json: ["draft"],
  },
  {
    name: "reviewed_files",
    sql: "CREATE TABLE reviewed_files (uri TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY (uri, nonce))",
    columns: { uri: "TEXT", nonce: "TEXT" },
  },
  {
    name: "local_turns",
    sql: `CREATE TABLE local_turns (turn_id TEXT PRIMARY KEY NOT NULL, chat_uri TEXT NOT NULL,
      anchor_turn_id TEXT, seq INTEGER NOT NULL, payload TEXT NOT NULL)`,
    columns: { turn_id: "TEXT", chat_uri: "TEXT", anchor_turn_id: "TEXT", seq: "INTEGER", payload: "TEXT" },
    json: ["payload"],
  },
  {
    name: "turn_usage",
    sql: "CREATE TABLE turn_usage (turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE, usage TEXT NOT NULL)",
    columns: { turn_id: "TEXT", usage: "TEXT" },
    json: ["usage"],
  },
  {
    name: "turn_delegation",
    sql: "CREATE TABLE turn_delegation (turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE, delegation TEXT NOT NULL)",
    columns: { turn_id: "TEXT", delegation: "TEXT" },
    json: ["delegation"],
  },
  {
    name: "turn_workspace_transition",
    sql: "CREATE TABLE turn_workspace_transition (turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE, transition TEXT NOT NULL)",
    columns: { turn_id: "TEXT", transition: "TEXT" },
    json: ["transition"],
  },
];

export interface VsCodeDatabaseRow {
  readonly table: string;
  readonly rowid: string;
  readonly columns: NativeObject;
  readonly storageTypes: NativeObject;
}

interface Guard {
  readonly path: string;
  readonly handle: FileHandle;
  readonly before: BigIntStats;
  readonly contentsMayChange: boolean;
  readonly digest: string | undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && right.nlink === 1n &&
    left.dev === right.dev && left.ino === right.ino;
}

async function fileDigest(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(size + 1, 64 * 1024));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) {
      throw new NativeCaptureError("SOURCE_CHANGED", "A host database file became shorter during capture.");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if ((await handle.read(buffer, 0, 1, size)).bytesRead !== 0) {
    throw new NativeCaptureError("SOURCE_CHANGED", "A host database file grew during capture.");
  }
  return hash.digest("hex");
}

function normalizedSql(sql: string): string {
  return sql.replace(/\bif\s+not\s+exists\s+/gi, "")
    .replace(/'(?:''|[^'])*'|[^']+/g, (part) => part.startsWith("'") ? part : part.toLowerCase().replaceAll('"', ""))
    .replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();
}

function sqliteError(error: unknown): never {
  if (error instanceof NativeCaptureError) throw error;
  if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
    throw new NativeCaptureError("SOURCE_CHANGED", "The selected host database is busy; retry after its writes finish.");
  }
  throw new NativeCaptureError("CORRUPT_HOST_DATABASE", "The selected host database could not be read consistently.");
}

function jsonNumberToFraction(raw: string): [bigint, bigint] {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
  if (!match) throw new Error("Invalid JSON number format");
  const [, signStr, intPart, fracPart = "", expStr] = match;
  const sign = signStr === "-" ? -1n : 1n;
  const digits = intPart + fracPart;
  let exp = BigInt(expStr ?? "0") - BigInt(fracPart.length);
  let num = BigInt(digits) * sign;
  let den = 1n;
  if (exp > 0n) {
    num *= 10n ** exp;
  } else if (exp < 0n) {
    den = 10n ** (-exp);
  }
  return [num, den];
}

export function isLosslessJsonNumber(rawNumStr: string): boolean {
  const num = Number(rawNumStr);
  if (!Number.isFinite(num)) return false;
  if (Number.isInteger(num) && !Number.isSafeInteger(num)) return false;
  try {
    const [n1, d1] = jsonNumberToFraction(rawNumStr);
    const [n2, d2] = jsonNumberToFraction(JSON.stringify(num));
    return n1 * d2 === n2 * d1;
  } catch {
    return false;
  }
}

export function validateRawJsonNumbers(jsonText: string, path: string): void {
  let inString = false;
  let escape = false;
  let i = 0;
  const len = jsonText.length;

  while (i < len) {
    const char = jsonText.charAt(i);
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      i++;
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      const start = i;
      if (char === "-") i++;
      while (i < len && jsonText.charAt(i) >= "0" && jsonText.charAt(i) <= "9") i++;
      if (i < len && jsonText.charAt(i) === ".") {
        i++;
        while (i < len && jsonText.charAt(i) >= "0" && jsonText.charAt(i) <= "9") i++;
      }
      if (i < len && (jsonText.charAt(i) === "e" || jsonText.charAt(i) === "E")) {
        i++;
        const expChar = jsonText.charAt(i);
        if (i < len && (expChar === "+" || expChar === "-")) i++;
        while (i < len && jsonText.charAt(i) >= "0" && jsonText.charAt(i) <= "9") i++;
      }
      const token = jsonText.slice(start, i);
      if (!isLosslessJsonNumber(token)) {
        throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A host JSON number cannot be preserved without precision loss.");
      }
      continue;
    }

    i++;
  }
}

/** Validate nested JSON before redaction: JSON.parse alone would discard duplicate private keys. */
export function validateVsCodeJson(value: NativeValue, path: string, depth = 0): void {
  if (depth > 80) throw new NativeCaptureError("SOURCE_LIMIT", "Host JSON nesting exceeds the supported limit.");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A host JSON number cannot be preserved without precision loss.");
  }
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    validateRawJsonNumbers(value, path);
    try {
      JSON.parse(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (value.includes("\n")) {
        for (const line of value.split(/\r?\n/)) validateVsCodeJson(line, path, depth + 1);
      }
      return;
    }
    validateVsCodeJson(parseNativeJson({ path, content: value }), path, depth + 1);
  } else if (Array.isArray(value)) {
    for (const child of value) validateVsCodeJson(child, path, depth + 1);
  } else if (isNativeObject(value)) {
    for (const child of Object.values(value)) validateVsCodeJson(child, path, depth + 1);
  }
}

function decodeCell(value: SQLOutputValue, table: Table, column: string, path: string): readonly [NativeValue, string] {
  if (value === null) return [null, "null"];
  if (typeof value === "bigint" && table.columns[column] === "INTEGER") return [value.toString(), "integer"];
  if (value instanceof Uint8Array && table.columns[column] === "BLOB") {
    // FileEditTracker + SessionDatabase.storeFileEdit store raw file bytes, not compressed blobs.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host edit snapshot is not raw UTF-8 text.");
    }
    if (text.includes("\0")) {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host edit snapshot contains binary data.");
    }
    validateVsCodeJson(text, path);
    return [text, "blob-utf8"];
  }
  if (typeof value !== "string" || table.columns[column] === "INTEGER") {
    throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "A host database cell has an unsupported SQLite storage type.");
  }
  if (value.includes("\0")) {
    throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host database text cell cannot be scanned.");
  }
  if (table.json?.includes(column)) {
    validateRawJsonNumbers(value, path);
    const parsed = parseNativeJson({ path, content: value });
    if (!isNativeObject(parsed)) {
      throw new NativeCaptureError("MALFORMED_SOURCE", "A host JSON column must contain its native object.");
    }
    validateVsCodeJson(parsed, path);
    return [parsed, "text-json"];
  }
  validateVsCodeJson(value, path);
  return [value, "text"];
}

/**
 * Read-only v12 logical snapshot. Rows retain SQLite rowid order and actual column names.
 * Integers/rowids use decimal strings (including 64-bit values); storageTypes distinguishes
 * null, text, parsed text-json, integer, and losslessly decoded blob-utf8. This is not a
 * SQLite restore format. The caller must redact columns and validate dependency closure.
 *
 * Source: https://github.com/microsoft/vscode/blob/cbea5b4b6a964508352be917d3ddbdc6fc6e7a75/src/vs/platform/agentHost/node/sessionDatabase.ts
 */
export class VsCodeSessionDatabase {
  readonly rows: VsCodeDatabaseRow[] = [];
  readonly schema: NativeObject[] = [];
  private active = true;

  private constructor(
    readonly key: string,
    readonly sourceBytes: number,
    private readonly reader: NativeFiles,
    private readonly guards: readonly Guard[],
    private readonly database: DatabaseSync,
    private readonly dataVersion: bigint,
  ) {}

  static async open(userDataPath: string, key: string, maxBytes: number): Promise<VsCodeSessionDatabase> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(key) || key.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key)) {
      throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "The selected host database key is not path-safe.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new NativeCaptureError("SOURCE_LIMIT", "The native source exceeds the configured capture limit.");
    }
    if (Number(process.versions.node.split(".")[0]) < 24) {
      throw new NativeCaptureError("UNSUPPORTED_RUNTIME", "VS Code Agent Host capture requires Node.js 24 or newer.");
    }
    const reader = new NativeFiles(userDataPath, maxBytes);
    const relativePath = join("agentSessionData", key, "session.db");
    const guards: Guard[] = [];
    let database: DatabaseSync | undefined;
    let sourceBytes = 0;
    async function guard(path: string, contentsMayChange = false): Promise<Guard> {
      const absolute = await reader.resolve(path);
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        const named = await lstat(absolute, { bigint: true });
        if (!sameIdentity(before, named)) {
          throw new NativeCaptureError("UNSAFE_SOURCE_PATH", "Host database files must be stable regular files, not links.");
        }
        if (before.size > BigInt(maxBytes - sourceBytes)) {
          throw new NativeCaptureError("SOURCE_LIMIT", "The host database and its WAL exceed the capture limit.");
        }
        sourceBytes += Number(before.size);
        const digest = contentsMayChange ? undefined : await fileDigest(handle, Number(before.size));
        const result = { path: absolute, handle, before, contentsMayChange, digest };
        guards.push(result);
        return result;
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    try {
      const primary = await guard(relativePath);
      const header = Buffer.alloc(100);
      const read = await primary.handle.read(header, 0, header.length, 0);
      if (read.bytesRead !== 100 || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" ||
          header.readUInt32BE(56) !== 1) {
        throw new NativeCaptureError("CORRUPT_HOST_DATABASE", "Expected a UTF-8 SQLite session database.");
      }
      if (await reader.exists(`${relativePath}-journal`)) {
        throw new NativeCaptureError("SOURCE_CHANGED", "A host rollback journal is present; retry after the transaction finishes.");
      }
      const hasWal = await reader.exists(`${relativePath}-wal`);
      const hasShm = await reader.exists(`${relativePath}-shm`);
      if (hasWal) await guard(`${relativePath}-wal`);
      if (hasShm) await guard(`${relativePath}-shm`, true);
      if (header[18] === 2 || header[19] === 2) {
        if (!hasWal || !hasShm) {
          throw new NativeCaptureError("UNSUPPORTED_HOST_JOURNAL", "WAL capture requires existing WAL and SHM files; capture never creates source sidecars.");
        }
      } else if (header[18] !== 1 || header[19] !== 1 || hasWal || hasShm) {
        throw new NativeCaptureError("UNSUPPORTED_HOST_JOURNAL", "Unsupported or inconsistent host database journal layout.");
      }
      const sqlite = await import("node:sqlite");
      database = new sqlite.DatabaseSync(primary.path, {
        readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false, timeout: 100,
      });
      database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY;");
      const versionStatement = database.prepare("PRAGMA data_version");
      versionStatement.setReadBigInts(true);
      const dataVersion = versionStatement.get()?.data_version;
      if (typeof dataVersion !== "bigint") throw new Error("Missing SQLite data version");
      database.exec("BEGIN");
      const snapshot = new VsCodeSessionDatabase(key, sourceBytes, reader, guards, database, dataVersion);
      snapshot.readRows(maxBytes);
      await snapshot.checkFiles();
      return snapshot;
    } catch (error) {
      database?.close();
      await Promise.all(guards.map(({ handle }) => handle.close()));
      if (isMissingFile(error)) {
        throw new NativeCaptureError("HOST_DATABASE_NOT_FOUND", "The exact selected host database or one of its sidecars is missing.");
      }
      sqliteError(error);
    }
  }

  private readRows(maxBytes: number): void {
    const version = this.database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 12) {
      throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "Only the pinned VS Code session database schema version 12 is supported.");
    }
    const expected = new Map<string, { type: string; table: string; sql: string | null }>();
    for (const table of TABLES) {
      expected.set(table.name, { type: "table", table: table.name, sql: table.sql });
      expected.set(`sqlite_autoindex_${table.name}_1`, { type: "index", table: table.name, sql: null });
    }
    expected.set("idx_turns_event_id", {
      type: "index", table: "turns", sql: "CREATE INDEX idx_turns_event_id ON turns(event_id)",
    });
    const schema = this.database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT 21").all();
    if (schema.length !== expected.size) {
      throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "The host database contains missing or unclassified schema objects.");
    }
    for (const entry of schema) {
      const match = typeof entry.name === "string" ? expected.get(entry.name) : undefined;
      if (!match || entry.type !== match.type || entry.tbl_name !== match.table ||
          (match.sql === null ? entry.sql !== null : typeof entry.sql !== "string" ||
            entry.sql.length > 4096 || normalizedSql(entry.sql) !== normalizedSql(match.sql))) {
        throw new NativeCaptureError("UNSUPPORTED_HOST_SCHEMA", "The host database does not match the pinned native schema.");
      }
      this.schema.push({ type: entry.type as string, name: entry.name as string, table: match.table, sql: entry.sql as string | null });
    }
    if (this.database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
        this.database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new NativeCaptureError("CORRUPT_HOST_DATABASE", "The host database failed its integrity or foreign-key check.");
    }
    let bytes = 0n;
    for (const table of TABLES) {
      const remainingRows = MAX_ROWS - this.rows.length;
      const count = this.database.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM "${table.name}" LIMIT ?)`).get(remainingRows + 1)?.n;
      if (typeof count !== "number" || count > remainingRows) {
        throw new NativeCaptureError("SOURCE_LIMIT", "The host database contains too many native rows.");
      }
      const names = Object.keys(table.columns);
      const lengthSql = names.map((name) => `COALESCE(length(CAST("${name}" AS BLOB)), 0)`).join(" + ");
      const lengthStatement = this.database.prepare(`SELECT COALESCE(SUM(${lengthSql}), 0) AS bytes FROM "${table.name}"`);
      lengthStatement.setReadBigInts(true);
      const tableBytes = lengthStatement.get()?.bytes;
      if (typeof tableBytes !== "bigint" || tableBytes < 0n || bytes + tableBytes > BigInt(maxBytes)) {
        throw new NativeCaptureError("SOURCE_LIMIT", "The decoded host database exceeds the capture limit.");
      }
      bytes += tableBytes;
      // Read TEXT as bytes as well: SQLite's JS string conversion replaces invalid UTF-8.
      const selection = names.flatMap((name) => [
        `"${name}"`, `typeof("${name}") AS "__type_${name}"`,
        `CASE WHEN typeof("${name}") = 'text' THEN CAST("${name}" AS BLOB) END AS "__text_${name}"`,
      ]).join(", ");
      const statement = this.database.prepare(`SELECT rowid AS "__rowid", ${selection} FROM "${table.name}" ORDER BY rowid LIMIT ?`);
      statement.setReadBigInts(true);
      for (const source of statement.iterate(remainingRows + 1)) {
        if (typeof source.__rowid !== "bigint") throw new Error("Missing SQLite rowid");
        const columns: NativeObject = {};
        const storageTypes: NativeObject = {};
        for (const name of names) {
          let cell = source[name]!;
          if (source[`__type_${name}`] === "text") {
            const raw = source[`__text_${name}`];
            if (!(raw instanceof Uint8Array)) throw new Error("Missing SQLite text bytes");
            try {
              cell = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
            } catch {
              throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A host database text cell is not valid UTF-8.");
            }
          }
          const [value, storageType] = decodeCell(cell, table, name, `host/${this.key}/session.db.jsonl`);
          columns[name] = value;
          storageTypes[name] = storageType;
        }
        this.rows.push({ table: table.name, rowid: source.__rowid.toString(), columns, storageTypes });
      }
    }
  }

  private async checkFiles(): Promise<void> {
    for (const { path, handle, before, contentsMayChange, digest } of this.guards) {
      await this.reader.resolve(path);
      const unchanged = (current: BigIntStats) => sameIdentity(before, current) &&
        before.size === current.size && (contentsMayChange || before.mtimeNs === current.mtimeNs);
      if (!unchanged(await lstat(path, { bigint: true })) || !unchanged(await handle.stat({ bigint: true }))) {
        throw new NativeCaptureError("SOURCE_CHANGED", "The host database or WAL changed during capture; prepare a new snapshot.");
      }
      // Windows can update ctime for metadata alone. Compare bytes instead, while
      // retaining identity, size, mtime and SQLite transaction-version checks.
      if ((!contentsMayChange && await fileDigest(handle, Number(before.size)) !== digest) ||
          !unchanged(await handle.stat({ bigint: true })) || !unchanged(await lstat(path, { bigint: true }))) {
        throw new NativeCaptureError("SOURCE_CHANGED", "The host database or WAL changed during capture; prepare a new snapshot.");
      }
    }
  }

  async assertUnchanged(): Promise<void> {
    await this.checkFiles();
    try {
      this.database.exec("ROLLBACK");
      this.active = false;
      const statement = this.database.prepare("PRAGMA data_version");
      statement.setReadBigInts(true);
      if (statement.get()?.data_version !== this.dataVersion) {
        throw new NativeCaptureError("SOURCE_CHANGED", "A host transaction committed during capture; prepare a new snapshot.");
      }
    } catch (error) {
      sqliteError(error);
    }
    await this.checkFiles();
  }

  async close(): Promise<void> {
    try {
      if (this.active) this.database.exec("ROLLBACK");
    } finally {
      this.active = false;
      this.database.close();
      await Promise.all(this.guards.map(({ handle }) => handle.close()));
    }
  }
}
