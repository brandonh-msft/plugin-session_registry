/**
 * Preference storage for the PR-Publish Prompt (PRPP-7/PRPP-8). Two
 * independent scopes exist so a developer's "stop asking" choice sticks at
 * exactly the granularity they picked:
 *
 * - *Session-scoped*: a git-ignored marker file at the workspace/worktree
 *   root, `.session-registry/pr-publish-prompt.json`. A "session" in this
 *   app's model is exactly one worktree, so this file's lifetime naturally
 *   matches "this session" -- a brand-new worktree never inherits it.
 * - *User-scoped*: `~/.session-registry/preferences.json`, outside any
 *   repo, so it follows the developer across every workspace. Namespaced
 *   within a JSON object (not a bare marker file) because this directory
 *   may hold other future per-user preferences.
 *
 * Both reads tolerate a missing or unparsable file by treating it as "flag
 * not set" -- never as an error -- so a corrupted preferences file can
 * never block the PR-publish prompt from working, only fail to suppress
 * it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PrPublishPreferenceScope = "session" | "user";

export interface PrPublishPreferenceDeps {
  readonly homedir: () => string;
}

export const defaultPrPublishPreferenceDeps: PrPublishPreferenceDeps = { homedir };

const SESSION_MARKER_RELATIVE_SEGMENTS = [".session-registry", "pr-publish-prompt.json"];
const USER_PREFERENCES_RELATIVE_SEGMENTS = [".session-registry", "preferences.json"];

export function sessionMarkerPath(workspaceRoot: string): string {
  return join(workspaceRoot, ...SESSION_MARKER_RELATIVE_SEGMENTS);
}

export function userPreferencesPath(
  deps: PrPublishPreferenceDeps = defaultPrPublishPreferenceDeps,
): string {
  return join(deps.homedir(), ...USER_PREFERENCES_RELATIVE_SEGMENTS);
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
  const session = await readJsonTolerant(sessionMarkerPath(input.workspaceRoot));
  if (session?.skip === true) {
    return { skipScope: "session" };
  }
  const user = await readJsonTolerant(userPreferencesPath(deps));
  if (user?.prPublishPromptSkip === true) {
    return { skipScope: "user" };
  }
  return { skipScope: "none" };
}

export interface RecordPrPublishPreferenceInput {
  readonly workspaceRoot: string;
  readonly scope: PrPublishPreferenceScope;
}

export async function recordPrPublishPreference(
  input: RecordPrPublishPreferenceInput,
  deps: PrPublishPreferenceDeps = defaultPrPublishPreferenceDeps,
): Promise<void> {
  if (input.scope === "session") {
    await writeJson(sessionMarkerPath(input.workspaceRoot), { skip: true });
    return;
  }
  await writeJson(userPreferencesPath(deps), { prPublishPromptSkip: true });
}
