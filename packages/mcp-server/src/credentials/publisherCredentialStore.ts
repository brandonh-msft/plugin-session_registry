/**
 * Persists the Session Registry publisher token issued on a first publish.
 *
 * The token *is* the publisher's identity: everything they have published is
 * reachable and manageable only through it, and it cannot be recovered from
 * the server, which stores a hash. Losing the file means losing control of
 * past publications, so it is treated as a credential rather than a
 * preference.
 *
 * Two deliberate divergences from `../preferences/prPublishPreference.ts`:
 *
 * 1. **A separate file.** `preferences.json` is written with a plain
 *    `writeFile` and read tolerantly, which is right for a boolean and wrong
 *    for a secret. Credentials go through `native/privatePaths.ts` instead,
 *    which refuses symlinks and sets restrictive modes.
 * 2. **Harness-independent.** Preferences are keyed per harness
 *    (`.copilot`/`.claude`/`.codex`), but one person on one machine should be
 *    one publisher regardless of which harness they happen to run. A
 *    per-harness credential would silently fragment their identity, giving
 *    them several unrelated publisher principals and no way to manage
 *    sessions published from a different harness.
 *
 * Tokens are additionally keyed by API origin, so a token minted against a
 * staging deployment is never sent to production (or the reverse), and so
 * pointing at a different registry does not appear to be an authentication
 * failure.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { protectPrivatePath, writePrivateFileExclusive } from "../native/privatePaths.js";

export class CredentialStorageError extends Error {
  readonly code = "UNSAFE_CREDENTIAL_STORAGE" as const;

  constructor(message: string) {
    super(message);
    this.name = "CredentialStorageError";
  }
}

interface CredentialFileShape {
  readonly version: 1;
  /** Publisher tokens keyed by the API origin that issued them. */
  readonly publisherTokens: Record<string, string>;
}

/**
 * Bucket for a token read out of the older flat `{"token": "..."}` file.
 *
 * It matches any registry, because that format carried no origin and the
 * people using it configured exactly one.
 */
const LEGACY_ANY_SCOPE = "*";

/**
 * Resolves the credential file path.
 *
 * `SESSION_REGISTRY_CREDENTIAL_FILE` takes precedence so a test, a container,
 * or a user with an unusual home directory can redirect it without patching
 * the module.
 */
export function credentialFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SESSION_REGISTRY_CREDENTIAL_FILE?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".session-registry", "credentials.json");
}

/**
 * Normalizes an API base URL to the origin that scopes a token.
 *
 * Path, query, and trailing-slash differences describe the same deployment
 * and must not split one credential into several; a differing host or scheme
 * is a genuinely different registry and must not share one.
 */
export function credentialScopeFor(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin.toLowerCase();
  } catch {
    // An unparseable value is kept verbatim rather than collapsed, so two
    // different malformed configurations cannot accidentally share a token.
    return apiBaseUrl.trim().toLowerCase();
  }
}

export async function readPublisherToken(
  apiBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const path = credentialFilePath(env);
  const file = await readCredentialFile(path);
  const token =
    file?.publisherTokens[credentialScopeFor(apiBaseUrl)] ??
    file?.publisherTokens[LEGACY_ANY_SCOPE];
  return typeof token === "string" && token.trim() !== "" ? token : null;
}

/**
 * Stores the token for one API origin, preserving tokens held for others.
 *
 * The replacement is atomic: the merged content is written to a temporary
 * file and renamed over the destination, so an interrupted write cannot
 * leave a truncated or empty credential file and strand the publisher.
 */
export async function writePublisherToken(
  apiBaseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const trimmed = token.trim();
  if (trimmed === "") {
    throw new CredentialStorageError("refusing to persist an empty publisher token");
  }

  const path = credentialFilePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await protectPrivatePathIfPresent(dirname(path), true);

  const existing = await readCredentialFile(path);
  const next: CredentialFileShape = {
    version: 1,
    publisherTokens: {
      ...(existing?.publisherTokens ?? {}),
      [credentialScopeFor(apiBaseUrl)]: trimmed,
    },
  };

  // A unique temporary name keeps the exclusive create meaningful: reusing one
  // fixed name would either collide with a concurrent write or force an
  // overwrite, which is exactly the symlink-following behaviour `wx` avoids.
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writePrivateFileExclusive(temporary, `${JSON.stringify(next, null, 2)}\n`);
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await protectPrivatePathIfPresent(path, false);
}

/**
 * Reads and validates the credential file.
 *
 * A missing file is normal — it simply means this machine has not published
 * yet. A *malformed* file is also tolerated as "no credential" rather than
 * raised, because failing here would make an unrelated stray file block
 * publishing entirely, with no obvious remedy. An unsafe file (a symlink, or
 * one owned by someone else) is the exception and does raise: silently
 * reading a credential through an attacker-controlled link is precisely what
 * must not happen.
 */
async function readCredentialFile(path: string): Promise<CredentialFileShape | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }

  await protectPrivatePath(path, false, (message) => {
    throw new CredentialStorageError(message);
  });

  try {
    const parsed = JSON.parse(raw) as Partial<CredentialFileShape> & { token?: unknown };
    const tokens = parsed.publisherTokens;
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
      // The plugin's published guidance describes a flat `{"token": "..."}`
      // file, which predates per-registry scoping. It is still honoured for
      // every registry, because someone following that guidance configured
      // exactly one registry and breaking them to tidy the shape would be a
      // gratuitous regression.
      return typeof parsed.token === "string" && parsed.token.trim() !== ""
        ? { version: 1, publisherTokens: { [LEGACY_ANY_SCOPE]: parsed.token.trim() } }
        : null;
    }
    const cleaned: Record<string, string> = {};
    for (const [scope, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token.trim() !== "") {
        cleaned[scope] = token;
      }
    }
    return { version: 1, publisherTokens: cleaned };
  } catch {
    return null;
  }
}

async function protectPrivatePathIfPresent(path: string, directory: boolean): Promise<void> {
  try {
    await protectPrivatePath(path, directory, (message) => {
      throw new CredentialStorageError(message);
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
