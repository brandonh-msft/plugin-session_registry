/**
 * The `pr_publish_preference` MCP tool (PR-Publish Prompt plan, Unit 2).
 * `check` is called before ever showing the 4-choice prompt (PRPP-4/5/9);
 * `record` persists a "stop asking" choice at whichever scope the developer
 * picked (PRPP-7/8). Both actions delegate to
 * `../preferences/prPublishPreference.ts` for the actual read/write logic;
 * this module is only the MCP-shaped request/response wrapper around it.
 *
 * `harness` selects which harness's own config directory (`.copilot`,
 * `.claude`, `.codex`) backs the flag, so each harness's opt-out is
 * independent and never spills a bespoke Session Registry folder into the
 * developer's repo or home directory.
 */

import { type NativeCliHarness } from "@session-registry/core";

export type PrPublishPreferenceInput =
  | { readonly action: "check"; readonly workspaceRoot: string; readonly harness: NativeCliHarness }
  | { readonly action: "record"; readonly workspaceRoot: string; readonly harness: NativeCliHarness; readonly scope: "session" | "user" };

export type PrPublishPreferenceResult =
  | { readonly action: "check"; readonly skipScope: "session" | "user" | "none" }
  | { readonly action: "record"; readonly scope: "session" | "user" };

export interface PrPublishPreferenceDeps {
  readonly check: (input: {
    readonly workspaceRoot: string;
    readonly harness: NativeCliHarness;
  }) => Promise<{ readonly skipScope: "session" | "user" | "none" }>;
  readonly record: (input: {
    readonly workspaceRoot: string;
    readonly harness: NativeCliHarness;
    readonly scope: "session" | "user";
  }) => Promise<void>;
}

export async function prPublishPreference(
  input: PrPublishPreferenceInput,
  deps: PrPublishPreferenceDeps,
): Promise<PrPublishPreferenceResult> {
  if (input.action === "check") {
    const result = await deps.check({ workspaceRoot: input.workspaceRoot, harness: input.harness });
    return { action: "check", skipScope: result.skipScope };
  }
  await deps.record({ workspaceRoot: input.workspaceRoot, harness: input.harness, scope: input.scope });
  return { action: "record", scope: input.scope };
}
