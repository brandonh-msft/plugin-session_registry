import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NativeCaptureError, NativeFiles, isMissingFile, sourceBytes } from "./files.js";

export const CODEX_SOURCE_PROFILE = "codex-0.154.0@6b9826e3aa83b1a5947db50f4332cb9c65f1b340";

export interface CodexStateRow {
  readonly id: string;
  readonly rollout_path: string;
  readonly history_mode: "legacy" | "paginated";
}

export interface CodexStateObservation {
  readonly home: string;
  readonly databasePath: string;
  readonly row: CodexStateRow | null;
}

function invalidHome(detail: string): never {
  throw new NativeCaptureError("INVALID_SQLITE_HOME",
    `${detail} Supply the producing client's absolute SQLite home through CODEX_SQLITE_HOME or SESSION_REGISTRY_CODEX_SQLITE_HOME.`);
}

// This only recognizes an unambiguous, literal sqlite_home setting. It does not
// pretend to evaluate Codex's profile/configuration-layer machinery.
function tomlStatements(text: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let quote = "";
  let triple = false;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') {
        statement += character + (text[++index] ?? "");
      } else if (character === quote && (!triple || text.slice(index, index + 3) === quote.repeat(3))) {
        statement += triple ? quote.repeat(3) : quote;
        if (triple) index += 2;
        quote = "";
        triple = false;
      } else {
        if (!triple && character === "\n") invalidHome("The native config contains an unterminated string.");
        statement += character;
      }
      continue;
    }
    if (character === "#") {
      while (index < text.length && text[index] !== "\n") index++;
      if (depth === 0 && statement.trim()) statements.push(statement.trim());
      if (depth === 0) statement = "";
      else statement += "\n";
    } else if (character === '"' || character === "'") {
      quote = character;
      triple = text.slice(index, index + 3) === quote.repeat(3);
      statement += triple ? quote.repeat(3) : quote;
      if (triple) index += 2;
    } else if (character === "\n" && depth === 0) {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
    } else {
      if (character === "[" || character === "{") depth++;
      if (character === "]" || character === "}") depth--;
      if (depth < 0) invalidHome("The native config cannot be interpreted unambiguously.");
      statement += character;
    }
  }
  if (quote || depth !== 0) invalidHome("The native config contains an incomplete value.");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function tomlString(value: string): string {
  if (/^'[^'\r\n]*'$/.test(value)) return value.slice(1, -1);
  if (!value.startsWith('"') || !value.endsWith('"') || value.startsWith('"""')) {
    return invalidHome("sqlite_home must be a simple quoted absolute path.");
  }
  let decoded = "";
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!;
    if (character === '"' || character.charCodeAt(0) < 0x20) invalidHome("sqlite_home has invalid string syntax.");
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[++index];
    const escapes: Readonly<Record<string, string>> = {
      b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\",
    };
    if (escaped !== undefined && Object.hasOwn(escapes, escaped)) {
      decoded += escapes[escaped];
    } else if (escaped === "u" || escaped === "U") {
      const length = escaped === "u" ? 4 : 8;
      const digits = value.slice(index + 1, index + 1 + length);
      if (digits.length !== length || !/^[0-9a-f]+$/i.test(digits)) invalidHome("sqlite_home has an invalid Unicode escape.");
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) invalidHome("sqlite_home has an invalid Unicode scalar.");
      decoded += String.fromCodePoint(point);
      index += length;
    } else {
      invalidHome("sqlite_home has an unsupported escape; use a TOML literal string for Windows paths.");
    }
  }
  return decoded;
}

function tomlAssignment(statement: string): { key: string[]; value: string } | undefined {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') index++;
      else if (character === quote) quote = "";
    } else if (character === "'" || character === '"') quote = character;
    else if (character === ".") {
      parts.push(statement.slice(start, index).trim());
      start = index + 1;
    } else if (character === "=") {
      parts.push(statement.slice(start, index).trim());
      return {
        key: parts.map((part) => part.startsWith('"') || part.startsWith("'") ? tomlString(part) : part),
        value: statement.slice(index + 1).trim(),
      };
    }
  }
  return undefined;
}

function configuredSqliteHome(text: string): string | undefined {
  let table = false;
  let selected: string | undefined;
  for (const statement of tomlStatements(text.replace(/^\uFEFF/, ""))) {
    if (statement.startsWith("[")) {
      table = true;
      continue;
    }
    const assignment = tomlAssignment(statement);
    if (assignment === undefined) continue;
    const { key, value } = assignment;
    if (key.at(-1) !== "sqlite_home") continue;
    if (table || key.length !== 1 || selected !== undefined) {
      invalidHome("sqlite_home appears in a profile, a dotted setting, or multiple settings.");
    }
    selected = tomlString(value);
  }
  return selected;
}

export async function codexSqliteHome(root: string, explicit: string | undefined, maxBytes: number): Promise<string> {
  let home = explicit?.trim() || undefined;
  if (home === undefined) {
    const config = new NativeFiles(root, Math.min(maxBytes, 1024 * 1024));
    if (await config.exists("config.toml")) {
      const source = await config.read("config.toml", { allowAppend: false });
      if (source.contentEncoding !== undefined) invalidHome("The native config is not UTF-8 text.");
      home = configuredSqliteHome(sourceBytes(source).toString("utf8"));
      await config.assertUnchanged();
    }
  }
  if (home === undefined) return root;
  const qualified = process.platform !== "win32" || /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(home);
  if (!home.trim() || !isAbsolute(home) || !qualified || home.includes("\0")) invalidHome("SQLite home is missing or relative to an unknown producing cwd/drive.");
  const path = resolve(home);
  try {
    if (!(await lstat(path)).isDirectory()) invalidHome("SQLite home is not a directory.");
    return await realpath(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    invalidHome("The configured SQLite home does not exist.");
  }
}

function sqliteFailure(error: unknown): never {
  if (error instanceof NativeCaptureError) throw error;
  if (error instanceof Error && "code" in error && String(error.code).includes("SQLITE")) {
    throw new NativeCaptureError("SQLITE_SOURCE_UNAVAILABLE",
      "Codex's selected-thread index could not be queried read-only. Retry after the native writer settles, or supply its exact sourcePath; no filesystem version was substituted.");
  }
  throw error;
}

export async function observeCodexState(home: string, id: string, maxBytes: number): Promise<CodexStateObservation> {
  // This pin uses state_5.sqlite, not thread_history_1.sqlite's lossy projection.
  // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/state/src/sqlite.rs#L29-L34
  const reader = new NativeFiles(home, maxBytes);
  const databasePath = join(home, "state_5.sqlite");
  if (!(await reader.exists(databasePath))) return { home, databasePath, row: null };
  await reader.resolve(databasePath);
  const before = await lstat(databasePath);
  if (!before.isFile()) {
    throw new NativeCaptureError("UNSUPPORTED_SQLITE_SCHEMA", "Codex state_5.sqlite is not a regular database file.");
  }
  let database: DatabaseSync | undefined;
  let row: CodexStateRow | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, timeout: 1_000 });
    database.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;");
    const table = database.prepare("SELECT type FROM sqlite_schema WHERE name = 'threads'").get();
    const columns = database.prepare("PRAGMA table_info('threads')").all();
    // 0001_threads.sql + 0040_threads_history_mode.sql at the same immutable pin.
    // Extra columns are normal; views, missing columns, and guessed future schemas are not.
    for (const name of ["id", "rollout_path", "history_mode"]) {
      const column = columns.find((value) => value.name === name);
      if (table?.type !== "table" || column?.type !== "TEXT" || (name === "id" && column.pk !== 1)) {
        throw new NativeCaptureError("UNSUPPORTED_SQLITE_SCHEMA",
          `Expected ${CODEX_SOURCE_PROFILE} state_5.sqlite threads(id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT). Supply the matching SQLite home or an exact native sourcePath.`);
      }
    }
    const value = database.prepare("SELECT id, rollout_path, history_mode FROM threads WHERE id = ?").get(id);
    if (value !== undefined) {
      if (value.id !== id || typeof value.rollout_path !== "string" || !value.rollout_path || value.rollout_path.length > 32_768 ||
          (value.history_mode !== "legacy" && value.history_mode !== "paginated")) {
        throw new NativeCaptureError("UNSUPPORTED_SQLITE_SCHEMA",
          "The selected Codex thread row has an invalid identity, rollout path, or history mode; no older rollout was substituted.");
      }
      row = { id, rollout_path: value.rollout_path, history_mode: value.history_mode };
    }
    database.exec("COMMIT;");
  } catch (error) {
    sqliteFailure(error);
  } finally {
    database?.close();
  }
  await reader.resolve(databasePath);
  const after = await lstat(databasePath);
  if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev) {
    throw new NativeCaptureError("SOURCE_CHANGED", "Codex's selected-thread database was replaced while it was queried; retry capture.");
  }
  return { home, databasePath, row };
}
