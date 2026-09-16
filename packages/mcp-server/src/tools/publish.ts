/**
 * The client-side scan-then-submit publish flow (Key Technical Decisions:
 * client-side scan-then-submit; BASE-R3/R4/R8/R9/R30/R40/R41/R43/R45).
 *
 * This module is deliberately decoupled from the actual MCP stdio
 * transport/protocol wiring (see `../index.ts`) so its logic — the part
 * that matters for correctness and safety — is directly unit-testable
 * without spinning up a real MCP client/server pair.
 *
 * The published invariant this module exists to guarantee: nothing ever
 * crosses `submitToBackend` except the fully owner-approved variant, and if
 * findings cannot be resolved (interactively or otherwise), the function
 * returns/throws before `submitToBackend` is ever called — no partial or
 * unredacted submission, and no server-side state left behind on failure
 * (amended BASE-R40, BASE-R42's retirement of the durable review-pending
 * fallback).
 */

import {
  applyResolutions,
  UnresolvedFindingsError,
  type FindingResolution,
} from "@session-registry/core";
import { scan, scanArtifact, type Finding, type ArtifactInput } from "@session-registry/core";
import {
  generateTitleAndSummary,
  type GeneratedSummary,
  type TitleSummaryGenerator,
} from "@session-registry/core";

export interface HarnessIdentity {
  readonly name: string;
  readonly version: string;
}

export interface ArtifactToPublish extends ArtifactInput {}

export interface PublishSessionInput {
  readonly ownerGithubLogin: string;
  /**
   * The identifier the harness already uses for this session. It is
   * carried through the publish unchanged so the registry files the
   * snapshot under the same id the agent and owner already say out loud,
   * and so the resulting share URL contains it.
   */
  readonly harnessSessionId: string;
  readonly transcript: string;
  readonly artifacts: readonly ArtifactToPublish[];
  readonly harness: HarnessIdentity;
}

/**
 * One scannable "part" of the session content, tagged so findings can be
 * traced back to whether they came from the transcript or a specific
 * artifact, and so resolutions can be looked up unambiguously even though
 * the underlying scanner only knows about offsets within a single string.
 */
interface ScannedPart {
  readonly source:
    | { readonly kind: "transcript" }
    | { readonly kind: "artifact"; readonly filename: string }
    | { readonly kind: "title" }
    | { readonly kind: "summary" };
  readonly content: string;
  readonly findings: readonly Finding[];
}

export interface PublishSubmission {
  readonly ownerGithubLogin: string;
  readonly harnessSessionId: string;
  readonly transcript: string;
  readonly artifacts: readonly ArtifactToPublish[];
  readonly harness: HarnessIdentity;
  readonly title: string;
  readonly summary: string;
}

/**
 * Presents a scanned/resolved title+summary candidate to the owner and
 * returns their decision (`SUMMARY-R52`): return the same values back to
 * confirm as-is, return different values to request an edit (which the
 * flow re-scans before it can be confirmed, per `SUMMARY-R50`), or return
 * null to abort the publish entirely.
 */
export type SummaryConfirmer = (
  candidate: GeneratedSummary,
) => Promise<GeneratedSummary | null>;

export class SummaryNotConfirmedError extends Error {
  constructor() {
    super("owner declined to confirm the generated title/summary — publish aborted");
    this.name = "SummaryNotConfirmedError";
  }
}

export interface BackendPublishClient {
  submitToBackend(submission: PublishSubmission): Promise<{ sessionId: string }>;
}

/**
 * Supplies resolutions for a batch of findings found within one scanned
 * part. Returns null when the findings cannot be resolved in this MCP
 * session (e.g. the harness is non-interactive) — publish must fail
 * without ever calling `submitToBackend` in that case.
 */
export type InteractiveResolver = (
  findings: readonly Finding[],
) => Promise<readonly FindingResolution[] | null>;

export class UnscannableContentError extends Error {
  constructor(public readonly reason: string) {
    super(`content cannot be safely scanned: ${reason}`);
    this.name = "UnscannableContentError";
  }
}

export class ScanFailedError extends Error {
  constructor(public readonly reason: string) {
    super(`scan failed: ${reason}`);
    this.name = "ScanFailedError";
  }
}

export class UnresolvedFindingsNotInteractiveError extends Error {
  constructor() {
    super(
      "unresolved findings and no interactive resolution available — resolve locally and retry",
    );
    this.name = "UnresolvedFindingsNotInteractiveError";
  }
}

export interface PublishSessionDeps {
  readonly backendClient: BackendPublishClient;
  readonly resolveInteractively: InteractiveResolver;
  /**
   * Whether interactive resolution is even possible in the current MCP
   * session. When false, `resolveInteractively` is never called — the
   * publish call fails immediately once any findings exist, matching the
   * "non-interactive harness with unresolved findings" test scenario.
   */
  readonly interactive: boolean;
  /**
   * Overrides for the transcript/artifact scan functions. Defaults to the
   * real `scan`/`scanArtifact` from `@session-registry/core`. Exists so
   * tests can deterministically exercise the scanner-error path (amended
   * BASE-R40) without needing a real pathological input — production
   * callers should never need to set these.
   */
  readonly scanTranscript?: typeof scan;
  readonly scanArtifactContent?: typeof scanArtifact;
  /** Override for scanning the generated title/summary text. Defaults to `scan`. */
  readonly scanSummaryText?: typeof scan;
  /**
   * Produces the title/summary candidate (Key Technical Decisions: the
   * publishing agent's own model, invoked as part of this MCP call).
   */
  readonly generateSummary: TitleSummaryGenerator;
  /** Presents the scanned/resolved candidate to the owner for confirmation or edit. */
  readonly confirmSummary: SummaryConfirmer;
}

/**
 * Executes the full client-side scan-then-submit flow for one publish
 * call. Throws (without calling `submitToBackend`) if:
 * - any part of the content cannot be safely scanned (`UnscannableContentError`,
 *   BASE-R30's local-warning path — the developer must exclude it locally
 *   and retry, this function does not silently include unscannable content)
 * - the scanner itself errors (`ScanFailedError`, amended BASE-R40)
 * - there are unresolved findings and interactive resolution is not
 *   available (`UnresolvedFindingsNotInteractiveError`)
 * - the interactive resolver itself declines to resolve (returns null)
 */
export async function publishSession(
  input: PublishSessionInput,
  deps: PublishSessionDeps,
): Promise<{ sessionId: string }> {
  const parts = scanAllParts(input, deps.scanTranscript ?? scan, deps.scanArtifactContent ?? scanArtifact);

  const findingsToResolutions = new Map<ScannedPart, FindingResolution[]>();
  for (const part of parts) {
    if (part.findings.length === 0) {
      continue;
    }
    if (!deps.interactive) {
      throw new UnresolvedFindingsNotInteractiveError();
    }
    const resolutions = await deps.resolveInteractively(part.findings);
    if (resolutions === null) {
      throw new UnresolvedFindingsNotInteractiveError();
    }
    findingsToResolutions.set(part, [...resolutions]);
  }

  const redactedTranscript = applyPartResolutions(
    parts.find((p) => p.source.kind === "transcript")!,
    findingsToResolutions,
  );

  const redactedArtifacts: ArtifactToPublish[] = input.artifacts.map((artifact) => {
    const part = parts.find(
      (p) => p.source.kind === "artifact" && p.source.filename === artifact.filename,
    )!;
    return {
      filename: artifact.filename,
      content: applyPartResolutions(part, findingsToResolutions),
    };
  });

  const submission: PublishSubmission = {
    ownerGithubLogin: input.ownerGithubLogin,
    harnessSessionId: input.harnessSessionId,
    transcript: redactedTranscript,
    artifacts: redactedArtifacts,
    harness: input.harness,
    ...(await generateAndConfirmSummary(deps)),
  };

  // This is the only line in the entire client-side flow that ever crosses
  // the trust boundary into the hosted backend (see Key Technical
  // Decisions' explicit trust-boundary statement).
  return deps.backendClient.submitToBackend(submission);
}

/**
 * Runs `SUMMARY-R52`'s sequence for the title/summary that follows the
 * transcript/artifact resolution above: generate → scan → resolve any
 * findings → present to the owner for confirm-or-edit → if edited, loop
 * back through scan/resolve before the edited text can be confirmed
 * (`SUMMARY-R50`). Title/summary findings use the same strict `BASE-R9`
 * per-finding resolution as the transcript/artifacts — there is no softer
 * whole-text override for this surface, a deliberate tightening given
 * title/summary's immediate anonymous-preview exposure.
 */
async function generateAndConfirmSummary(
  deps: PublishSessionDeps,
): Promise<{ title: string; summary: string }> {
  const generated = await generateTitleAndSummary(deps.generateSummary);

  let candidate = generated;
  while (true) {
    const resolved = await scanAndResolveSummary(candidate, deps);
    const confirmation = await deps.confirmSummary(resolved);
    if (confirmation === null) {
      throw new SummaryNotConfirmedError();
    }
    if (confirmation.title === resolved.title && confirmation.summary === resolved.summary) {
      return resolved;
    }
    // Edited: loop back so the edited text is re-scanned before it can be
    // confirmed (SUMMARY-R50) rather than trusting the edit outright.
    candidate = confirmation;
  }
}

async function scanAndResolveSummary(
  candidate: GeneratedSummary,
  deps: PublishSessionDeps,
): Promise<GeneratedSummary> {
  const scanFn = deps.scanSummaryText ?? scan;
  const titlePart = toScannedPart({ kind: "title" }, candidate.title, scanFn(candidate.title));
  const summaryPart = toScannedPart(
    { kind: "summary" },
    candidate.summary,
    scanFn(candidate.summary),
  );

  const findingsToResolutions = new Map<ScannedPart, FindingResolution[]>();
  for (const part of [titlePart, summaryPart]) {
    if (part.findings.length === 0) {
      continue;
    }
    if (!deps.interactive) {
      throw new UnresolvedFindingsNotInteractiveError();
    }
    const resolutions = await deps.resolveInteractively(part.findings);
    if (resolutions === null) {
      throw new UnresolvedFindingsNotInteractiveError();
    }
    findingsToResolutions.set(part, [...resolutions]);
  }

  return {
    title: applyPartResolutions(titlePart, findingsToResolutions),
    summary: applyPartResolutions(summaryPart, findingsToResolutions),
  };
}

function scanAllParts(
  input: PublishSessionInput,
  scanFn: typeof scan,
  scanArtifactFn: typeof scanArtifact,
): ScannedPart[] {
  const parts: ScannedPart[] = [];

  const transcriptResult = scanFn(input.transcript);
  parts.push(toScannedPart({ kind: "transcript" }, input.transcript, transcriptResult));

  for (const artifact of input.artifacts) {
    const artifactResult = scanArtifactFn(artifact);
    parts.push(
      toScannedPart(
        { kind: "artifact", filename: artifact.filename },
        artifact.content,
        artifactResult,
      ),
    );
  }

  return parts;
}

function toScannedPart(
  source: ScannedPart["source"],
  content: string,
  result: ReturnType<typeof scan>,
): ScannedPart {
  if (result.status === "unavailable") {
    throw new UnscannableContentError(result.reason);
  }
  if (result.status === "error") {
    throw new ScanFailedError(result.reason);
  }
  return { source, content, findings: result.findings };
}

function applyPartResolutions(
  part: ScannedPart,
  findingsToResolutions: ReadonlyMap<ScannedPart, FindingResolution[]>,
): string {
  const resolutions = findingsToResolutions.get(part);
  if (part.findings.length === 0) {
    return part.content;
  }
  try {
    return applyResolutions(part.content, part.findings, resolutions ?? []);
  } catch (error) {
    if (error instanceof UnresolvedFindingsError) {
      throw new UnresolvedFindingsNotInteractiveError();
    }
    throw error;
  }
}
