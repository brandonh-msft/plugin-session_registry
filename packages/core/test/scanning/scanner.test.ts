import { describe, expect, it } from "vitest";
import { scan, scanArtifact } from "../../src/scanning/scanner.js";

describe("scan", () => {
  it("returns no findings for clean content (happy path)", () => {
    const result = scan("just some ordinary text with no secrets in it");
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  it("detects an AWS access key id (happy path)", () => {
    const content = "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP";
    const result = scan(content);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        category: "aws-access-key-id",
        severity: "high",
        matchedText: "AKIAABCDEFGHIJKLMNOP",
      });
    }
  });

  it("detects a GitHub personal access token (happy path)", () => {
    const token = "ghp_" + "a".repeat(36);
    const result = scan(`token: ${token}`);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.findings.map((f) => f.category)).toEqual([
        "github-personal-access-token",
      ]);
      expect(result.findings[0]!.matchedText).toBe(token);
    }
  });

  it("detects a private key block (happy path)", () => {
    const result = scan("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.findings.map((f) => f.category)).toContain("private-key-block");
    }
  });

  it.each([
    ["github-app-or-oauth-token", "gho_" + "x".repeat(36)],
    ["github-app-or-oauth-token", "ghs_" + "x".repeat(36)],
    ["anthropic-api-key", "sk-ant-api03-" + "x".repeat(40)],
    ["openai-api-key", "sk-proj-" + "x".repeat(40)],
    ["openai-api-key", "sk-svcacct-" + "x".repeat(40)],
    ["openai-api-key", "sk-" + "x".repeat(48)],
  ])("detects %s credentials in native CLI output", (category, token) => {
    const result = scan(`captured output: ${token}`);
    expect(result).toEqual({
      status: "ok",
      findings: [expect.objectContaining({ category, matchedText: token })],
    });
  });

  it("detects multiple distinct findings and returns them ordered by offset (edge case)", () => {
    const token = "ghp_" + "b".repeat(36);
    const content = `first ${token} then AKIAABCDEFGHIJKLMNOP end`;
    const result = scan(content);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0]!.category).toBe("github-personal-access-token");
      expect(result.findings[1]!.category).toBe("aws-access-key-id");
      expect(result.findings[0]!.offset).toBeLessThan(result.findings[1]!.offset);
    }
  });

  it("does not leak detector regex state across repeated scans (edge case)", () => {
    const content = "AKIAABCDEFGHIJKLMNOP";
    const first = scan(content);
    const second = scan(content);
    expect(first).toEqual(second);
  });

  it("returns an error result rather than throwing when the scan is simulated to fail (error path, amended BASE-R40)", () => {
    const result = scan("irrelevant content", { simulateFailure: true });
    expect(result).toEqual({ status: "error", reason: "scanner timed out" });
  });
});

describe("scanArtifact", () => {
  it("scans a supported artifact type normally (happy path)", () => {
    const result = scanArtifact({
      filename: "notes.md",
      content: "no secrets here",
    });
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  it("returns unavailable for an unsupported artifact type rather than silently treating it as clean (BASE-R30 edge case)", () => {
    const result = scanArtifact({
      filename: "screenshot.png",
      content: "binary-ish content standing in for real bytes",
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain(".png");
    }
  });

  it("returns unavailable for a filename with no extension (edge case)", () => {
    const result = scanArtifact({ filename: "Dockerfile", content: "FROM node" });
    expect(result.status).toBe("unavailable");
  });
});
