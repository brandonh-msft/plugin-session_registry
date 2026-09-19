import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPrPublishPreference,
  recordPrPublishPreference,
  sessionMarkerPath,
  userPreferencesPath,
} from "../../src/preferences/prPublishPreference.js";

describe("prPublishPreference", () => {
  let workspaceRoot: string;
  let userHome: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "prpp-workspace-"));
    userHome = await mkdtemp(join(tmpdir(), "prpp-home-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
  });

  it("Happy path: reports \"none\" when neither preference file exists", async () => {
    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "claude-code" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "none" });
  });

  it("Edge case: a malformed session marker file is treated as not set, never as an error", async () => {
    const path = sessionMarkerPath(workspaceRoot, "claude-code");
    await mkdir(join(workspaceRoot, ".claude", "session-registry"), { recursive: true });
    await writeFile(path, "{ not valid json", "utf8");

    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "claude-code" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "none" });
  });

  it("Happy path: recording a session-scoped skip round-trips through check", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, harness: "claude-code", scope: "session" },
      { homedir: () => userHome, env: {} },
    );

    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "claude-code" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "session" });
  });

  it("Happy path: recording a user-scoped skip round-trips through check", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, harness: "claude-code", scope: "user" },
      { homedir: () => userHome, env: {} },
    );

    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "claude-code" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "user" });
  });

  it("Integration: the two scopes are independent -- a different workspace never inherits a session-scoped skip, but does inherit a user-scoped one", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, harness: "claude-code", scope: "session" },
      { homedir: () => userHome, env: {} },
    );
    const otherWorkspace = await mkdtemp(join(tmpdir(), "prpp-workspace-other-"));
    try {
      await expect(
        checkPrPublishPreference(
          { workspaceRoot: otherWorkspace, harness: "claude-code" },
          { homedir: () => userHome, env: {} },
        ),
      ).resolves.toEqual({ skipScope: "none" });

      await recordPrPublishPreference(
        { workspaceRoot, harness: "claude-code", scope: "user" },
        { homedir: () => userHome, env: {} },
      );
      await expect(
        checkPrPublishPreference(
          { workspaceRoot: otherWorkspace, harness: "claude-code" },
          { homedir: () => userHome, env: {} },
        ),
      ).resolves.toEqual({ skipScope: "user" });
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("Integration: different harnesses are independent -- a codex-cli skip never suppresses the prompt for claude-code", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, harness: "codex-cli", scope: "session" },
      { homedir: () => userHome, env: {} },
    );

    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "claude-code" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "none" });
    await expect(
      checkPrPublishPreference(
        { workspaceRoot, harness: "codex-cli" },
        { homedir: () => userHome, env: {} },
      ),
    ).resolves.toEqual({ skipScope: "session" });
  });

  it("resolves the session marker path beneath the harness's own config directory in the workspace", () => {
    expect(sessionMarkerPath(workspaceRoot, "github-copilot-cli")).toBe(
      join(workspaceRoot, ".copilot", "session-registry", "pr-publish-prompt.json"),
    );
    expect(sessionMarkerPath(workspaceRoot, "claude-code")).toBe(
      join(workspaceRoot, ".claude", "session-registry", "pr-publish-prompt.json"),
    );
    expect(sessionMarkerPath(workspaceRoot, "codex-cli")).toBe(
      join(workspaceRoot, ".codex", "session-registry", "pr-publish-prompt.json"),
    );
  });

  it("resolves the user preferences path beneath the injected home directory's harness config directory", () => {
    expect(userPreferencesPath("claude-code", { homedir: () => userHome, env: {} })).toBe(
      join(userHome, ".claude", "session-registry", "preferences.json"),
    );
  });

  it("honors the harness's native home-directory environment variable override", () => {
    const customClaudeHome = join(userHome, "custom-claude-home");
    expect(
      userPreferencesPath("claude-code", { homedir: () => userHome, env: { CLAUDE_CONFIG_DIR: customClaudeHome } }),
    ).toBe(join(customClaudeHome, "session-registry", "preferences.json"));
  });

  it("prefers the SESSION_REGISTRY_* override over the harness's own native environment variable", () => {
    const sessionRegistryHome = join(userHome, "session-registry-claude-home");
    expect(
      userPreferencesPath("claude-code", {
        homedir: () => userHome,
        env: { CLAUDE_CONFIG_DIR: join(userHome, "ignored"), SESSION_REGISTRY_CLAUDE_HOME: sessionRegistryHome },
      }),
    ).toBe(join(sessionRegistryHome, "session-registry", "preferences.json"));
  });

  it("Edge case: an environment override is honored for a user-scoped skip that round-trips through check", async () => {
    const customHome = await mkdtemp(join(tmpdir(), "prpp-custom-home-"));
    try {
      const deps = { homedir: () => userHome, env: { CLAUDE_CONFIG_DIR: customHome } };
      await recordPrPublishPreference({ workspaceRoot, harness: "claude-code", scope: "user" }, deps);

      await expect(
        readFile(join(customHome, "session-registry", "preferences.json"), "utf8"),
      ).resolves.toContain("prPublishPromptSkip");
      await expect(
        checkPrPublishPreference({ workspaceRoot, harness: "claude-code" }, deps),
      ).resolves.toEqual({ skipScope: "user" });
    } finally {
      await rm(customHome, { recursive: true, force: true });
    }
  });
});
