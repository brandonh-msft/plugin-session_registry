import { describe, expect, it } from "vitest";
import {
  prPublishPreference,
  type PrPublishPreferenceDeps,
} from "../../src/tools/prPublishPreference.js";

describe("prPublishPreference (tool)", () => {
  it("delegates a check action to deps.check and reports its skipScope", async () => {
    const calls: { workspaceRoot: string }[] = [];
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
      prPublishPreference({ action: "check", workspaceRoot: "/repo" }, deps),
    ).resolves.toEqual({ action: "check", skipScope: "user" });
    expect(calls).toEqual([{ workspaceRoot: "/repo" }]);
  });

  it("delegates a record action to deps.record with the chosen scope", async () => {
    const calls: { workspaceRoot: string; scope: "session" | "user" }[] = [];
    const deps: PrPublishPreferenceDeps = {
      async check() {
        throw new Error("check should not be called for a record action");
      },
      async record(input) {
        calls.push(input);
      },
    };

    await expect(
      prPublishPreference({ action: "record", workspaceRoot: "/repo", scope: "session" }, deps),
    ).resolves.toEqual({ action: "record", scope: "session" });
    expect(calls).toEqual([{ workspaceRoot: "/repo", scope: "session" }]);
  });
});
