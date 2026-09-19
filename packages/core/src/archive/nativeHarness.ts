export const NATIVE_CLI_HARNESSES = ["github-copilot-cli", "claude-code", "codex-cli"] as const;
export type NativeCliHarness = typeof NATIVE_CLI_HARNESSES[number];

export const NATIVE_IDE_HARNESSES = [
  "vscode-copilot-chat",
  "vscode-copilot-agent",
  "visual-studio-copilot",
  "github-copilot-desktop",
  "github-copilot-desktop-chat",
] as const;

export const NATIVE_HARNESSES = [...NATIVE_CLI_HARNESSES, ...NATIVE_IDE_HARNESSES] as const;
export type NativeHarness = typeof NATIVE_HARNESSES[number];
