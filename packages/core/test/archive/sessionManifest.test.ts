import { describe, expect, it } from "vitest";
import { buildStoredZip } from "../../src/archive/nativeSessionBundle.js";
import { readNativeSessionBundle } from "../../src/archive/nativeSessionBundleReader.js";
import {
  buildSessionManifestBytes, buildSessionManifestZipEntry, SESSION_MANIFEST_PATH, type SessionManifestInput,
} from "../../src/archive/sessionManifest.js";

function fixtureInput(): SessionManifestInput {
  return {
    sessionId: "sess_abc123",
    harnessSessionId: "harness-session-42",
    title: "Fixing the login bug",
    summary: "Traced and fixed a race condition in the session refresh flow.",
    harness: { name: "github-copilot-cli", version: "1.0.84-5" },
    capturedAt: "2026-09-18T12:34:56.789Z",
    ownerGithubLogin: "octocat",
  };
}

describe("session manifest entry", () => {
  it("serializes every confirmed field, including ownerGithubLogin", () => {
    const bytes = buildSessionManifestBytes(fixtureInput());
    const parsed = JSON.parse(bytes.toString("utf8"));
    expect(parsed).toEqual({
      sessionId: "sess_abc123",
      harnessSessionId: "harness-session-42",
      title: "Fixing the login bug",
      summary: "Traced and fixed a race condition in the session refresh flow.",
      harness: { name: "github-copilot-cli", version: "1.0.84-5" },
      capturedAt: "2026-09-18T12:34:56.789Z",
      ownerGithubLogin: "octocat",
    });
  });

  it("builds a zip entry at the manifest.json root path", () => {
    const entry = buildSessionManifestZipEntry(fixtureInput());
    expect(entry.path).toBe(SESSION_MANIFEST_PATH);
    expect(entry.path).toBe("manifest.json");
    expect(JSON.parse(entry.bytes.toString("utf8")).ownerGithubLogin).toBe("octocat");
  });

  it("round-trips through buildStoredZip and readNativeSessionBundle alongside other entries", async () => {
    const manifestEntry = buildSessionManifestZipEntry(fixtureInput());
    const zip = buildStoredZip([
      { path: "session-registry-manifest.json", bytes: Buffer.from("{}", "utf8") },
      manifestEntry,
    ]);
    const entries = await readNativeSessionBundle(zip);
    expect(entries.size).toBe(2);
    const readBack = entries.get(SESSION_MANIFEST_PATH);
    expect(readBack).toBeDefined();
    const parsed = JSON.parse(Buffer.from(readBack!.bytes).toString("utf8"));
    expect(parsed.ownerGithubLogin).toBe("octocat");
    expect(parsed.sessionId).toBe("sess_abc123");
  });
});
