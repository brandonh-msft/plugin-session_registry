import { describe, expect, it } from "vitest";
import {
  prPublishPreference,
  type PrPublishPreferenceDeps,
} from "../../src/tools/prPublishPreference.js";

describe("prPublishPreference (tool)", () => {
  it("delegates a check action to deps.check with the harness and reports its skipScope", async () => {
    const calls: { workspaceRoot: string; harness: "claude-code" }[] = [];
    const deps: PrPublishPreferenceDeps = {
      async check(input) {
        calls.push(input);
        return { skipScope: "user" };
      },
      async record() {
        throw new Error("record should not be called for a check action");
      },
    };

    await expect(
      prPublishPreference({ action: "check", workspaceRoot: "/repo", harness: "claude-code" }, deps),
    ).resolves.toEqual({ action: "check", skipScope: "user" });
    expect(calls).toEqual([{ workspaceRoot: "/repo", harness: "claude-code" }]);
  });

  it("delegates a record action to deps.record with the harness and chosen scope", async () => {
    const calls: { workspaceRoot: string; harness: "claude-code"; scope: "session" | "user" }[] = [];
    const deps: PrPublishPreferenceDeps = {
      async check() {
        throw new Error("check should not be called for a record action");
      },
      async record(input) {
        calls.push(input);
      },
    };

    await expect(
      prPublishPreference({ action: "record", workspaceRoot: "/repo", harness: "claude-code", scope: "session" }, deps),
    ).resolves.toEqual({ action: "record", scope: "session" });
    expect(calls).toEqual([{ workspaceRoot: "/repo", harness: "claude-code", scope: "session" }]);
  });
});
