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
      checkPrPublishPreference({ workspaceRoot }, { homedir: () => userHome }),
    ).resolves.toEqual({ skipScope: "none" });
  });

  it("Edge case: a malformed session marker file is treated as not set, never as an error", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = sessionMarkerPath(workspaceRoot);
    await mkdir(join(workspaceRoot, ".session-registry"), { recursive: true });
    await writeFile(path, "{ not valid json", "utf8");

    await expect(
      checkPrPublishPreference({ workspaceRoot }, { homedir: () => userHome }),
    ).resolves.toEqual({ skipScope: "none" });
  });

  it("Happy path: recording a session-scoped skip round-trips through check", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, scope: "session" },
      { homedir: () => userHome },
    );

    await expect(
      checkPrPublishPreference({ workspaceRoot }, { homedir: () => userHome }),
    ).resolves.toEqual({ skipScope: "session" });
  });

  it("Happy path: recording a user-scoped skip round-trips through check", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, scope: "user" },
      { homedir: () => userHome },
    );

    await expect(
      checkPrPublishPreference({ workspaceRoot }, { homedir: () => userHome }),
    ).resolves.toEqual({ skipScope: "user" });
  });

  it("Integration: the two scopes are independent -- a different workspace never inherits a session-scoped skip, but does inherit a user-scoped one", async () => {
    await recordPrPublishPreference(
      { workspaceRoot, scope: "session" },
      { homedir: () => userHome },
    );
    const otherWorkspace = await mkdtemp(join(tmpdir(), "prpp-workspace-other-"));
    try {
      await expect(
        checkPrPublishPreference({ workspaceRoot: otherWorkspace }, { homedir: () => userHome }),
      ).resolves.toEqual({ skipScope: "none" });

      await recordPrPublishPreference(
        { workspaceRoot, scope: "user" },
        { homedir: () => userHome },
      );
      await expect(
        checkPrPublishPreference({ workspaceRoot: otherWorkspace }, { homedir: () => userHome }),
      ).resolves.toEqual({ skipScope: "user" });
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("resolves the user preferences path beneath the injected home directory", () => {
    expect(userPreferencesPath({ homedir: () => userHome })).toBe(
      join(userHome, ".session-registry", "preferences.json"),
    );
  });
});
