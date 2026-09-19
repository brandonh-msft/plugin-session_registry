import type { NativeHarness } from "@session-registry/core";

export const CAPTURED_AT = "2026-09-10T20:00:00.000Z";

export function harnessFixture(harness: NativeHarness): readonly { readonly path: string; readonly kind: "events"; readonly content: string; readonly recordCount: number }[] {
  if (harness === "github-copilot-cli") {
    const records = [
      { type: "session.start", data: { copilotVersion: "1.0.82-1" } },
      { type: "user.message", data: { content: "Fix the fixture exactly." } },
      { type: "tool.execution_start", data: { toolName: "shell" } },
      { type: "tool.execution_complete", data: { result: { content: "pnpm test", exitCode: 0 } } },
      { type: "assistant.message", data: { content: "The corrected fixture is ready." } },
    ];
    return [{ path: "events/main.jsonl", kind: "events", content: records.map(JSON.stringify).join("\n") + "\n", recordCount: records.length }];
  }
  if (harness === "claude-code") {
    const records = [
      { type: "user", message: { role: "user", content: "Fix the fixture exactly." } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Running verification." }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "pnpm test passed" }] } },
    ];
    return [{ path: "projects/fixture/111.jsonl", kind: "events", content: records.map(JSON.stringify).join("\n") + "\n", recordCount: records.length }];
  }
  const records = [
    { type: "session_meta", payload: { cli_version: "0.114.0" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the fixture exactly." }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell" } },
    { type: "response_item", payload: { type: "function_call_output", output: "pnpm test passed" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The corrected fixture is ready." }] } },
  ];
  return [{ path: "sessions/2026/09/10/rollout.jsonl", kind: "events", content: records.map(JSON.stringify).join("\n") + "\n", recordCount: records.length }];
}
