/**
 * Preference storage for the PR-Publish Prompt (PRPP-6/PRPP-7/PRPP-8). Two
 * independent scopes exist so a developer's "stop asking" choice sticks at
 * exactly the granularity they picked, and both live inside the *harness's
 * own* config directory rather than a bespoke Session Registry folder --
 * the developer already has `.copilot`, `.claude`, or `.codex` (repo-level
 * and/or in their home directory); adding a brand-new top-level folder for
 * one small flag would just be more clutter to notice, understand, and
 * (for the repo-level copy) remember to gitignore.
 *
 * - *Session-scoped*: `<workspaceRoot>/<harnessConfigDir>/session-registry/
 *   pr-publish-prompt.json`. A "session" in this app's model is exactly one
 *   worktree, so this file's lifetime naturally matches "this session" -- a
 *   brand-new worktree never inherits it. It sits under the harness's own
 *   directory, which developers already treat as local/ignorable, rather
 *   than under a new repo-root folder.
 * - *User-scoped*: `<harnessHomeDir>/session-registry/preferences.json`,
 *   where `harnessHomeDir` is resolved with the same environment-variable
 *   overrides (`COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and their
 *   `SESSION_REGISTRY_*` overrides) already used for native session capture
 *   in `../native/captures.ts`, so a developer who relocated their harness
 *   home directory gets the same preference file relocated with it.
 *
 * Both scopes nest the flag one level deeper, in a `session-registry`
 * subdirectory, so this file never appears unexpectedly alongside the
 * harness's own files inside `.copilot`/`.claude`/`.codex` and so the same
 * subdirectory can hold future per-harness preferences without collisions.
 *
 * Both reads tolerate a missing or unparsable file by treating it as "flag
 * not set" -- never as an error -- so a corrupted preferences file can
 * never block the PR-publish prompt from working, only fail to suppress
 * it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type NativeCliHarness } from "@session-registry/core";

export type PrPublishPreferenceScope = "session" | "user";

export interface PrPublishPreferenceDeps {
  readonly homedir: () => string;
  readonly env: NodeJS.ProcessEnv;
}

export const defaultPrPublishPreferenceDeps: PrPublishPreferenceDeps = { homedir, env: process.env };

/** The harness's own config directory name, used at both the repo/worktree root and beneath the user's home directory. */
const HARNESS_CONFIG_DIR_NAMES: Record<NativeCliHarness, string> = {
  "github-copilot-cli": ".copilot",
  "claude-code": ".claude",
  "codex-cli": ".codex",
};

/** Environment variables that can relocate a harness's home directory, matching `../native/captures.ts`'s precedent. */
const HARNESS_HOME_ENV_VARS: Record<NativeCliHarness, readonly [sessionRegistryOverride: string, harnessNative: string]> = {
  "github-copilot-cli": ["SESSION_REGISTRY_COPILOT_HOME", "COPILOT_HOME"],
  "claude-code": ["SESSION_REGISTRY_CLAUDE_HOME", "CLAUDE_CONFIG_DIR"],
  "codex-cli": ["SESSION_REGISTRY_CODEX_HOME", "CODEX_HOME"],
};

const PREFERENCE_SUBDIRECTORY = "session-registry";

function harnessHomeDir(harness: NativeCliHarness, deps: PrPublishPreferenceDeps): string {
  const [sessionRegistryOverride, harnessNative] = HARNESS_HOME_ENV_VARS[harness];
  return (
    deps.env[sessionRegistryOverride] ??
    deps.env[harnessNative] ??
    join(deps.homedir(), HARNESS_CONFIG_DIR_NAMES[harness])
  );
}

export function sessionMarkerPath(workspaceRoot: string, harness: NativeCliHarness): string {
  return join(workspaceRoot, HARNESS_CONFIG_DIR_NAMES[harness], PREFERENCE_SUBDIRECTORY, "pr-publish-prompt.json");
}

export function userPreferencesPath(
  harness: NativeCliHarness,
  deps: PrPublishPreferenceDeps = defaultPrPublishPreferenceDeps,
): string {
  return join(harnessHomeDir(harness, deps), PREFERENCE_SUBDIRECTORY, "preferences.json");
}

/**
 * Reads and parses JSON from `path`, tolerating a missing file or malformed
 * content by returning `null` rather than throwing.
 */
async function readJsonTolerant(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface CheckPrPublishPreferenceInput {
  readonly workspaceRoot: string;
  readonly harness: NativeCliHarness;
}

export interface CheckPrPublishPreferenceResult {
  /** Which scope currently suppresses the prompt, or "none" if neither does. */
  readonly skipScope: PrPublishPreferenceScope | "none";
}

/** The session-scoped file is always checked before the user-scoped one, but neither is preferred over the other -- either one alone is sufficient to suppress the prompt. */
export async function checkPrPublishPreference(
  input: CheckPrPublishPreferenceInput,
  deps: PrPublishPreferenceDeps = defaultPrPublishPreferenceDeps,
): Promise<CheckPrPublishPreferenceResult> {
  const session = await readJsonTolerant(sessionMarkerPath(input.workspaceRoot, input.harness));
  if (session?.skip === true) {
    return { skipScope: "session" };
  }
  const user = await readJsonTolerant(userPreferencesPath(input.harness, deps));
  if (user?.prPublishPromptSkip === true) {
    return { skipScope: "user" };
  }
  return { skipScope: "none" };
}

export interface RecordPrPublishPreferenceInput {
  readonly workspaceRoot: string;
  readonly harness: NativeCliHarness;
  readonly scope: PrPublishPreferenceScope;
}

export async function recordPrPublishPreference(
  input: RecordPrPublishPreferenceInput,
  deps: PrPublishPreferenceDeps = defaultPrPublishPreferenceDeps,
): Promise<void> {
  if (input.scope === "session") {
    await writeJson(sessionMarkerPath(input.workspaceRoot, input.harness), { skip: true });
    return;
  }
  await writeJson(userPreferencesPath(input.harness, deps), { prPublishPromptSkip: true });
}
