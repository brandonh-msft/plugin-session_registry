/**
 * Shared secret/credential scanner (BASE-R8-R11, LINTER-R4). This module is
 * deliberately generic over "a string of content" so it is reusable both
 * for Unit 2's transcript/artifact scanning and Unit 3's title/summary
 * linting (the origin docs' shared-detector requirement) — it has no
 * knowledge of what kind of content it is scanning.
 *
 * This scans a UTF-8 *decodable* string. Binary/unsupported artifact
 * content should go through `scanArtifact`, which models BASE-R30's
 * "content that cannot be safely scanned" path as a distinguishable
 * `unavailable` result rather than silently treating unscannable bytes as
 * clean.
 */

export type FindingSeverity = "high" | "medium" | "low";

export interface Finding {
  readonly category: string;
  readonly severity: FindingSeverity;
  /** UTF-16 code unit offset into the scanned string where the match starts. */
  readonly offset: number;
  readonly length: number;
  readonly matchedText: string;
}

export interface ScanOk {
  readonly status: "ok";
  readonly findings: readonly Finding[];
}

export interface ScanUnavailable {
  readonly status: "unavailable";
  readonly reason: string;
}

export interface ScanError {
  readonly status: "error";
  readonly reason: string;
}

export type ScanResult = ScanOk | ScanUnavailable | ScanError;

interface Detector {
  readonly category: string;
  readonly severity: FindingSeverity;
  readonly pattern: RegExp;
}

// Deliberately conservative, high-confidence patterns for v1. The exact
// detector set is explicitly called out as an implementation-time
// refinement in the plan's Open Questions — this is a real, usable
// starting set, not a placeholder, but is expected to grow.
const DETECTORS: readonly Detector[] = [
  {
    category: "aws-access-key-id",
    severity: "high",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    category: "github-personal-access-token",
    severity: "high",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
  },
  {
    category: "github-fine-grained-token",
    severity: "high",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    category: "github-app-or-oauth-token",
    severity: "high",
    pattern: /\bgh[ousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    category: "anthropic-api-key",
    severity: "high",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    category: "openai-api-key",
    severity: "high",
    pattern: /\bsk-(?:(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48})\b/g,
  },
  {
    category: "private-key-block",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
  },
  {
    category: "slack-token",
    severity: "high",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    category: "generic-bearer-jwt",
    severity: "medium",
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

const SCAN_TIMEOUT_MESSAGE = "scanner timed out";

/**
 * Synchronous by construction — there is no real I/O here, only regex
 * matching over an in-memory string, so there is no failure mode that
 * legitimately throws in normal operation. `simulateFailure` exists only
 * so tests can exercise the `error` result path (amended BASE-R40) without
 * needing to contrive a real pathological input.
 */
export function scan(
  content: string,
  options: { simulateFailure?: boolean } = {},
): ScanResult {
  if (options.simulateFailure) {
    return { status: "error", reason: SCAN_TIMEOUT_MESSAGE };
  }

  const findings: Finding[] = [];
  for (const detector of DETECTORS) {
    // Each detector's regex carries the `g` flag and detectors are static
    // module-level constants, so `lastIndex` must be reset per scan call —
    // otherwise a detector's state would leak across unrelated scans.
    detector.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = detector.pattern.exec(content)) !== null) {
      findings.push({
        category: detector.category,
        severity: detector.severity,
        offset: match.index,
        length: match[0].length,
        matchedText: match[0],
      });
      if (match[0].length === 0) {
        // Defensive: a zero-width match would loop forever.
        detector.pattern.lastIndex += 1;
      }
    }
  }

  findings.sort((a, b) => a.offset - b.offset);
  return { status: "ok", findings };
}

const SUPPORTED_ARTIFACT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".patch",
  ".diff",
  ".ts",
  ".js",
  ".py",
  ".go",
  ".rb",
  ".java",
  ".log",
]);

export interface ArtifactInput {
  readonly filename: string;
  readonly content: string;
}

/**
 * Scans a named artifact, modeling BASE-R30's "content that cannot be
 * safely scanned" path explicitly: an unsupported artifact type never
 * silently falls through as "no findings" — it returns `unavailable` so
 * the caller (Unit 2's publish flow) can surface a local warning and
 * require explicit developer exclusion rather than including it blind.
 */
export function scanArtifact(artifact: ArtifactInput): ScanResult {
  const extension = getExtension(artifact.filename);
  if (!SUPPORTED_ARTIFACT_EXTENSIONS.has(extension)) {
    return {
      status: "unavailable",
      reason: `unsupported artifact type "${extension || "(no extension)"}" for ${artifact.filename} — cannot be safely scanned`,
    };
  }
  return scan(artifact.content);
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return "";
  }
  return filename.slice(lastDot).toLowerCase();
}
