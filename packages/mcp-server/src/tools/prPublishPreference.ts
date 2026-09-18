/**
 * The `pr_publish_preference` MCP tool (PR-Publish Prompt plan, Unit 2).
 * `check` is called before ever showing the 4-choice prompt (PRPP-4/5/9);
 * `record` persists a "stop asking" choice at whichever scope the developer
 * picked (PRPP-7/8). Both actions delegate to
 * `../preferences/prPublishPreference.ts` for the actual read/write logic;
 * this module is only the MCP-shaped request/response wrapper around it.
 */

export type PrPublishPreferenceInput =
  | { readonly action: "check"; readonly workspaceRoot: string }
  | { readonly action: "record"; readonly workspaceRoot: string; readonly scope: "session" | "user" };

export type PrPublishPreferenceResult =
  | { readonly action: "check"; readonly skipScope: "session" | "user" | "none" }
  | { readonly action: "record"; readonly scope: "session" | "user" };

export interface PrPublishPreferenceDeps {
  readonly check: (input: {
    readonly workspaceRoot: string;
  }) => Promise<{ readonly skipScope: "session" | "user" | "none" }>;
  readonly record: (input: {
    readonly workspaceRoot: string;
    readonly scope: "session" | "user";
  }) => Promise<void>;
}

export async function prPublishPreference(
  input: PrPublishPreferenceInput,
  deps: PrPublishPreferenceDeps,
): Promise<PrPublishPreferenceResult> {
  if (input.action === "check") {
    const result = await deps.check({ workspaceRoot: input.workspaceRoot });
    return { action: "check", skipScope: result.skipScope };
  }
  await deps.record({ workspaceRoot: input.workspaceRoot, scope: input.scope });
  return { action: "record", scope: input.scope };
}
