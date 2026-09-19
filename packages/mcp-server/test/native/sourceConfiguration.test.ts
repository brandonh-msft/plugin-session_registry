import { resolve } from "node:path";
import { NATIVE_IDE_HARNESSES } from "@session-registry/core";
import { describe, expect, it } from "vitest";
import { createNativeCaptureService, nativeCaptureOptions } from "../../src/native/captures.js";
import { parseNativeJson } from "../../src/native/files.js";
import { NativeRedactor } from "../../src/native/redaction.js";
import { SESSION_ID } from "./fixtures.js";

describe("native source configuration", () => {
  it("leaves IDE sources disabled and keeps existing CLI home overrides unchanged", () => {
    const options = nativeCaptureOptions({
      SESSION_REGISTRY_COPILOT_HOME: "configured-copilot",
      SESSION_REGISTRY_CLAUDE_HOME: "configured-claude",
      SESSION_REGISTRY_CODEX_HOME: "configured-codex",
    });
    expect(options.ideSources).toBeUndefined();
    expect(options.homes).toEqual({
      "github-copilot-cli": resolve("configured-copilot"),
      "claude-code": resolve("configured-claude"),
      "codex-cli": resolve("configured-codex"),
    });
  });

  it("resolves explicit product roots and versions without treating a version as a path", () => {
    const options = nativeCaptureOptions({
      SESSION_REGISTRY_VSCODE_USER_DATA: "code-profile",
      SESSION_REGISTRY_VSCODE_COPILOT_HOME: "code-sdk",
      SESSION_REGISTRY_VISUAL_STUDIO_COPILOT_HOME: "vs-sdk",
      SESSION_REGISTRY_VISUAL_STUDIO_VERSION: "18.8.1",
      SESSION_REGISTRY_COPILOT_DESKTOP_HOME: "desktop-sdk",
      SESSION_REGISTRY_COPILOT_DESKTOP_VERSION: "1.0.84",
    });
    expect(options.ideSources).toEqual({
      vscode: { userDataPath: resolve("code-profile"), copilotHome: resolve("code-sdk") },
      visualStudio: { copilotHome: resolve("vs-sdk"), hostVersion: "18.8.1" },
      desktop: { copilotHome: resolve("desktop-sdk"), hostVersion: "1.0.84" },
    });
  });

  it("uses the configured CLI native home for VS Code only after its user-data source is selected", () => {
    const options = nativeCaptureOptions({
      SESSION_REGISTRY_COPILOT_HOME: "shared-sdk",
      SESSION_REGISTRY_VSCODE_USER_DATA: "code-profile",
    });
    expect(options.ideSources?.vscode?.copilotHome).toBe(resolve("shared-sdk"));
    expect(options.ideSources?.desktop).toBeUndefined();
    expect(options.ideSources?.visualStudio).toBeUndefined();
  });

  it.each([
    { SESSION_REGISTRY_VSCODE_USER_DATA: " " },
    { SESSION_REGISTRY_VSCODE_COPILOT_HOME: "sdk-without-host" },
    { SESSION_REGISTRY_VISUAL_STUDIO_VERSION: "18.8" },
    { SESSION_REGISTRY_COPILOT_DESKTOP_VERSION: "1.0" },
  ])("rejects incomplete or empty explicit configuration: %j", (env) => {
    expect(() => nativeCaptureOptions(env)).toThrow(/SESSION_REGISTRY_/);
  });

  it.each(NATIVE_IDE_HARNESSES)("fails an unconfigured %s source without substituting the CLI store", async (harness) => {
    const service = createNativeCaptureService(nativeCaptureOptions({}));
    await expect(service.prepare({ harness, harnessSessionId: SESSION_ID }))
      .rejects.toThrow("SOURCE_NOT_CONFIGURED");
  });

  it("rejects host-only selection on CLI captures before reading their source", async () => {
    const service = createNativeCaptureService(nativeCaptureOptions({}));
    await expect(service.prepare({
      harness: "github-copilot-cli", harnessSessionId: SESSION_ID, hostSessionId: "host-id",
    })).rejects.toThrow("UNSUPPORTED_OPTION");
  });

  it.each(["../outside", "C:\\outside", "copilot://session/id", ""])(
    "rejects unsafe host identifiers before source selection: %s",
    async (hostSessionId) => {
      const service = createNativeCaptureService(nativeCaptureOptions({}));
      await expect(service.prepare({
        harness: "vscode-copilot-agent", harnessSessionId: SESSION_ID, hostSessionId,
      })).rejects.toThrow("INVALID_SESSION_ID");
    },
  );
});

describe("strict native JSON parsing", () => {
  it("preserves structured snapshots without requiring a fabricated event type", () => {
    const value = { version: 3, sessionId: SESSION_ID, requests: [], draft: { text: "KEEP" } };
    expect(parseNativeJson({ path: "native.json", content: JSON.stringify(value) })).toEqual(value);
  });

  it.each([
    '{"sessionId":"first","sessionId":"second"}',
    '{"nested":{"key":1,"\\u006bey":2}}',
    '{"version":',
  ])("rejects malformed or duplicate-key native state: %s", (content) => {
    expect(() => parseNativeJson({ path: "native.json", content })).toThrow("MALFORMED_SOURCE");
  });

  it("keeps numeric precision checks in the shared redaction boundary", () => {
    const value = parseNativeJson({ path: "native.json", content: '{"version":3,"count":9007199254740993}' });
    expect(() => new NativeRedactor().value(value, "native.json")).toThrow("precision loss");
  });
});
