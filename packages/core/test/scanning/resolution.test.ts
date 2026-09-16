import { describe, expect, it } from "vitest";
import {
  applyResolutions,
  UnresolvedFindingsError,
  type FindingResolution,
} from "../../src/scanning/resolution.js";
import { scan, type Finding } from "../../src/scanning/scanner.js";

function findingsFor(content: string): readonly Finding[] {
  const result = scan(content);
  if (result.status !== "ok") {
    throw new Error("expected scan to succeed in test setup");
  }
  return result.findings;
}

describe("applyResolutions", () => {
  it("applies an accepted redaction, replacing the match with a placeholder (happy path)", () => {
    const token = "ghp_" + "a".repeat(36);
    const content = `token=${token}`;
    const findings = findingsFor(content);

    const resolutions: FindingResolution[] = [
      { findingIndex: 0, action: { kind: "accept-redaction" } },
    ];
    const result = applyResolutions(content, findings, resolutions);

    expect(result).toBe("token=[REDACTED]");
  });

  it("applies a custom replacement supplied by the owner (happy path)", () => {
    const content = "key=AKIAABCDEFGHIJKLMNOP";
    const findings = findingsFor(content);

    const resolutions: FindingResolution[] = [
      {
        findingIndex: 0,
        action: { kind: "custom-replacement", replacementText: "<env-var-ref>" },
      },
    ];
    const result = applyResolutions(content, findings, resolutions);

    expect(result).toBe("key=<env-var-ref>");
  });

  it("leaves a false-positive-resolved match untouched (happy path)", () => {
    const content = "key=AKIAABCDEFGHIJKLMNOP";
    const findings = findingsFor(content);

    const resolutions: FindingResolution[] = [
      { findingIndex: 0, action: { kind: "false-positive" } },
    ];
    const result = applyResolutions(content, findings, resolutions);

    expect(result).toBe(content);
  });

  it("resolves multiple findings independently, applying different actions to each (integration)", () => {
    const secret1 = "ghp_" + "a".repeat(36);
    const secret2 = "AKIAABCDEFGHIJKLMNOP";
    const content = `first ${secret1} second ${secret2} end`;
    const findings = findingsFor(content);
    expect(findings).toHaveLength(2);

    const resolutions: FindingResolution[] = [
      { findingIndex: 0, action: { kind: "accept-redaction" } },
      { findingIndex: 1, action: { kind: "false-positive" } },
    ];
    const result = applyResolutions(content, findings, resolutions);

    expect(result).toBe(`first [REDACTED] second ${secret2} end`);
  });

  it("throws UnresolvedFindingsError when a finding has no resolution (error path, BASE-R9)", () => {
    const content = "key=AKIAABCDEFGHIJKLMNOP";
    const findings = findingsFor(content);

    expect(() => applyResolutions(content, findings, [])).toThrow(
      UnresolvedFindingsError,
    );
  });

  it("throws when only some of multiple findings are resolved (edge case)", () => {
    const secret1 = "ghp_" + "a".repeat(36);
    const secret2 = "AKIAABCDEFGHIJKLMNOP";
    const content = `${secret1} ${secret2}`;
    const findings = findingsFor(content);

    const resolutions: FindingResolution[] = [
      { findingIndex: 0, action: { kind: "accept-redaction" } },
    ];
    expect(() => applyResolutions(content, findings, resolutions)).toThrow(
      UnresolvedFindingsError,
    );
  });

  it("is a no-op that returns the original content when there are no findings (edge case)", () => {
    const content = "nothing sensitive here";
    const findings = findingsFor(content);
    expect(applyResolutions(content, findings, [])).toBe(content);
  });
});
