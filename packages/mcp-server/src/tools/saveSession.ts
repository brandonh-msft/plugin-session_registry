import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { NATIVE_SESSION_BUNDLE_WARNING, type AudiencePolicy } from "@session-registry/core";
import { z } from "zod";
import { AUDIENCE_INPUT_GUIDANCE, audienceText, parseAudienceText } from "../audiencePolicy.js";
import type { PublishToolInput } from "../index.js";
import type { NativeCaptureService, PrepareCaptureInput } from "../native/captures.js";
import { NativeCaptureError } from "../native/files.js";
import {
  CaptureReviewRequiredError,
  knownFindingIds,
  safeReviewText,
  scanNativeCapture,
  type CaptureFinding,
  type CaptureResolution,
  type OwnerRedaction,
} from "../native/review.js";

export type SaveSessionInput = PrepareCaptureInput & {
  readonly interactionMode?: "interactive" | "noninteractive";
  readonly captureId?: string;
  readonly title: string;
  readonly summary: string;
  readonly audiencePolicy?: AudiencePolicy;
  readonly expiresAt?: string | null;
  readonly resolutions?: readonly CaptureResolution[];
  readonly ownerRedactions?: readonly OwnerRedaction[];
};

export interface SaveSessionDependencies {
  readonly captures: NativeCaptureService;
  readonly publish: (input: PublishToolInput) => Promise<CallToolResult>;
  readonly confirm: (request: ElicitRequestFormParams) => Promise<ElicitResult | undefined>;
}

/** The owner's bulk choice for every scanner-detected secret in this save. */
type SecretDecision = "redact-all" | "review-each" | "publish-unredacted";

function response(value: object, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** The registry's true, enforced title/summary limits (independent of the wider MCP schema ceiling). */
const TITLE_MAX_LENGTH = 120;
const SUMMARY_MAX_LENGTH = 500;
const TRUNCATION_MARKER = "...";

function assertNonBlankMetadata(value: { title: string; summary: string }): void {
  if (!value.title.trim() || !value.summary.trim()) {
    throw new NativeCaptureError("INVALID_METADATA", "Generate a nonblank title and summary.");
  }
}

function truncateToLimit(value: string, maxLength: number): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  const text = value.slice(0, Math.max(0, maxLength - TRUNCATION_MARKER.length)).trimEnd() + TRUNCATION_MARKER;
  return { text, truncated: true };
}

/**
 * Validates nonblank title/summary, then silently truncates an overlong
 * value to the registry's true 120/500 character limit (with a "..."
 * marker) rather than hard-rejecting the whole save. The MCP tool schema
 * accepts a wider ceiling than this so a slightly-over auto-generated draft
 * lands here to be corrected instead of bouncing the agent with a raw
 * protocol validation error before this code ever runs.
 */
export function normalizeMetadata(value: { title: string; summary: string }): { title: string; summary: string; truncated: boolean } {
  assertNonBlankMetadata(value);
  const title = truncateToLimit(value.title.trim(), TITLE_MAX_LENGTH);
  const summary = truncateToLimit(value.summary.trim(), SUMMARY_MAX_LENGTH);
  return { title: title.text, summary: summary.text, truncated: title.truncated || summary.truncated };
}

function expirationText(value: string | null | undefined): string {
  return value === undefined ? "14 days" : value === null ? "never" : value;
}

function parseExpiration(value: string): string | null | undefined {
  const text = value.trim();
  if (text === "14 days") return undefined;
  if (text.toLowerCase() === "never") return null;
  const days = /^([1-9]\d{0,4}) days?$/.exec(text);
  if (days) return new Date(Date.now() + Number(days[1]) * 86_400_000).toISOString();
  const timestamp = z.string().datetime({ offset: true }).safeParse(text);
  if (!timestamp.success || Date.parse(text) <= Date.now()) {
    throw new NativeCaptureError("INVALID_EXPIRATION", "Expiration must be a positive number of days, never, or a future ISO 8601 timestamp.");
  }
  return new Date(text).toISOString();
}

// The interactive form field is a plain multi-line text box, not JSON, so a
// human owner can simply type or paste terms to redact without learning a
// schema. One rule per line: "exact text" or "exact text -> replacement"
// (default replacement is [REDACTED]). Case-insensitive matching is assumed;
// agents calling the tool directly can still pass structured OwnerRedaction
// objects (including caseSensitive) via the ownerRedactions tool argument.
const REDACTION_LINE_ARROW = "->";

function ownerRedactionsText(value: readonly OwnerRedaction[]): string {
  return value
    .map((rule) => rule.replacementText === undefined || rule.replacementText === "[REDACTED]"
      ? rule.exactText
      : `${rule.exactText} ${REDACTION_LINE_ARROW} ${rule.replacementText}`)
    .join("\n");
}

function parseOwnerRedactions(value: string): OwnerRedaction[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length > 1_000) {
    throw new NativeCaptureError("INVALID_OWNER_REDACTION", "At most 1,000 additional redaction lines are supported.");
  }
  return lines.map((line) => {
    const separator = ` ${REDACTION_LINE_ARROW} `;
    const arrowIndex = line.indexOf(separator);
    const exactText = (arrowIndex === -1 ? line : line.slice(0, arrowIndex)).trim();
    const replacementText = arrowIndex === -1 ? undefined : line.slice(arrowIndex + separator.length).trim();
    if (!exactText) {
      throw new NativeCaptureError("INVALID_OWNER_REDACTION", `Each redaction line needs text to redact before "${REDACTION_LINE_ARROW}".`);
    }
    return replacementText ? { exactText, replacementText } : { exactText };
  });
}

/**
 * A short, safe line rendered under a finding's category/severity/location:
 * a masked partial preview of the detected value plus its character count,
 * never the value itself. Absent for manualReview findings.
 */
function findingPreviewLine(finding: CaptureFinding): string {
  return finding.maskedPreview === undefined
    ? ""
    : ` Detected value preview: ${finding.maskedPreview} (${finding.length} character${finding.length === 1 ? "" : "s"}).`;
}

/**
 * Groups findings that share the exact same detected value (case-sensitive,
 * via the opaque `valueKey` hash) so summary/recap text can report both
 * total occurrences and unique values. Preserves first-seen order both
 * within a group and across groups. Findings without a `valueKey` (should
 * not happen for non-manualReview findings, but guarded defensively) are
 * each their own singleton group keyed by finding id.
 */
function groupFindingsByValue(pending: readonly CaptureFinding[]): readonly (readonly CaptureFinding[])[] {
  const order: string[] = [];
  const groups = new Map<string, CaptureFinding[]>();
  for (const finding of pending) {
    const key = finding.valueKey ?? finding.id;
    const group = groups.get(key);
    if (group === undefined) {
      order.push(key);
      groups.set(key, [finding]);
    } else {
      group.push(finding);
    }
  }
  return order.map((key) => groups.get(key)!);
}

/** Capped so a huge finding set (e.g. dozens of secrets) still renders a short, readable list. */
const SECRET_LIST_PREVIEW_LIMIT = 10;

/**
 * Step 2 of the deterministic publish flow: a single-field choice, never a
 * multi-field settings form. It always literally reports how many likely
 * secrets the scanner found, with a capped preview list, before asking how
 * to handle them.
 */
function secretDecisionForm(
  input: { readonly captureId: string; readonly harnessSessionId: string; readonly pending: readonly CaptureFinding[] },
): ElicitRequestFormParams {
  const { pending } = input;
  const shown = pending.slice(0, SECRET_LIST_PREVIEW_LIMIT);
  const remaining = pending.length - shown.length;
  const list = shown.map((finding, index) =>
    `  ${index + 1}. [${finding.category}/${finding.severity}] ${finding.source}${findingPreviewLine(finding)}`);
  if (remaining > 0) list.push(`  ...and ${remaining} more.`);
  return {
    mode: "form",
    message: [
      `The scanner found ${pending.length} likely secret${pending.length === 1 ? "" : "s"} in session ${input.harnessSessionId} (capture ${input.captureId}).`,
      `Detected secrets:\n${list.join("\n")}`,
      "Choose how to handle every detected secret before continuing.",
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Detected secrets",
          oneOf: [
            { const: "redact-all", title: "Redact all detected secrets" },
            { const: "review-each", title: "Review and approve each detected secret individually" },
            { const: "publish-unredacted", title: "Publish unredacted" },
          ],
        },
      },
      required: ["decision"],
    },
  };
}

/** One step of the "review-each" per-finding loop, never the secret text itself. */
function perFindingForm(
  input: { readonly captureId: string; readonly harnessSessionId: string; readonly finding: CaptureFinding; readonly position: number; readonly total: number },
): ElicitRequestFormParams {
  const { finding } = input;
  return {
    mode: "form",
    message: [
      `Finding ${input.position} of ${input.total} in session ${input.harnessSessionId} (capture ${input.captureId}).`,
      `Category: ${finding.category}. Severity: ${finding.severity}. Location: ${finding.source}.${findingPreviewLine(finding)}`,
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Redact this finding",
          oneOf: [
            { const: "redact-default", title: "Yes, as [REDACTED]" },
            { const: "keep", title: "No" },
            { const: "redact-custom", title: "Yes, as something else (I'll tell you)" },
          ],
        },
      },
      required: ["decision"],
    },
  };
}

/** Follow-up step shown only when a finding's decision is "redact-custom". */
function customReplacementForm(
  input: { readonly captureId: string; readonly harnessSessionId: string; readonly finding: CaptureFinding; readonly position: number; readonly total: number },
): ElicitRequestFormParams {
  return {
    mode: "form",
    message: [
      `Custom replacement for finding ${input.position} of ${input.total} in session ${input.harnessSessionId} (capture ${input.captureId}).`,
      "Enter the exact text to use instead of this finding's value.",
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        replacementText: { type: "string", title: "Replacement text", minLength: 1 },
      },
      required: ["replacementText"],
    },
  };
}

/**
 * Step 4: the one-shot metadata form. Filled out exactly once per save -
 * there is no confirmation/warning field here and no re-scan/re-present loop
 * on edits. A separate, non-editable recap-and-confirm step follows it.
 */
function metadataForm(
  input: { captureId: string; harnessSessionId: string; title: string; summary: string;
    audiencePolicy: AudiencePolicy; expiresAt?: string | null; ownerRedactions: readonly OwnerRedaction[]; truncated?: boolean },
): ElicitRequestFormParams {
  const access = input.audiencePolicy.accessMode === "anonymous"
    ? "Anyone (anonymous)" : `Restricted: ${JSON.stringify(input.audiencePolicy.rules)}`;
  return {
    mode: "form",
    message: [
      `Publish session ${input.harnessSessionId} (capture ${input.captureId}).`,
      `Drafted title: ${input.title}`,
      `Drafted summary: ${input.summary}`,
      `Drafted access: ${access}`,
      `Drafted expiration: ${input.expiresAt === undefined ? "14 days (default)" : input.expiresAt === null ? "No expiration" : input.expiresAt}`,
      ...(input.truncated ? ["Note: the auto-generated title or summary was shortened to fit the character limit."] : []),
      "Fill in or edit every field once. A separate recap will ask you to confirm before anything is uploaded.",
    ].join("\n\n"),
    // MCP forms require primitive properties, unlike the nested tool schema.
    requestedSchema: {
      type: "object",
      properties: {
        title: { type: "string", title: "Title", default: input.title, minLength: 1, maxLength: 120 },
        summary: { type: "string", title: "Summary", default: input.summary, minLength: 1, maxLength: 500 },
        audience: { type: "string", title: "Audience", description: AUDIENCE_INPUT_GUIDANCE, default: audienceText(input.audiencePolicy), minLength: 1 },
        expiration: { type: "string", title: "Expiration", description: "Number of days (e.g. 7 days), never, or a future ISO 8601 timestamp.", default: expirationText(input.expiresAt), minLength: 1 },
        additionalRedactions: {
          type: "string",
          title: "Additional redactions (optional)",
          description: 'One item per line: text to redact, or "text -> replacement" for a custom replacement (default replacement is [REDACTED]). Applied to every scannable native source and publication metadata occurrence, matched case-insensitively.',
          default: ownerRedactionsText(input.ownerRedactions),
        },
      },
      required: ["title", "summary", "audience", "expiration"],
    },
  };
}

/**
 * Repeated values still appear as separate findings during review, but the
 * recap should make that duplication explicit by stating both the raw
 * occurrence count and the unique-value count.
 */
function secretDecisionSummary(decision: SecretDecision | undefined, textFindingCount: number, uniqueFindingCount: number): string {
  if (textFindingCount === 0) return "The scanner found no likely secrets.";
  const noun = `${textFindingCount} detected secret instance${textFindingCount === 1 ? "" : "s"} (${uniqueFindingCount} unique)`;
  switch (decision) {
    case "redact-all": return `${noun} will be redacted.`;
    case "review-each": return `${noun} were reviewed individually and resolved.`;
    case "publish-unredacted": return `${noun} will be published unredacted (explicit owner override).`;
    default: return `${noun} were resolved.`;
  }
}

/**
 * Step 5: a separate, non-editable recap of every prior decision (secret
 * handling and the filled-in metadata form) with exactly one yes/no field.
 * None of the recapped values can be changed here; edit the earlier form
 * instead of resubmitting a changed answer at this step.
 */
function recapForm(
  input: {
    captureId: string; harnessSessionId: string; title: string; summary: string;
    audiencePolicy: AudiencePolicy; expiresAt?: string | null; ownerRedactions: readonly OwnerRedaction[];
    secretDecision: SecretDecision | undefined; textFindingCount: number; uniqueFindingCount: number; requiresWarning: boolean; truncated?: boolean;
  },
): ElicitRequestFormParams {
  const access = input.audiencePolicy.accessMode === "anonymous"
    ? "Anyone (anonymous)" : `Restricted: ${JSON.stringify(input.audiencePolicy.rules)}`;
  return {
    mode: "form",
    message: [
      `Final recap for session ${input.harnessSessionId} (capture ${input.captureId}). Nothing below is editable here.`,
      `Secrets: ${secretDecisionSummary(input.secretDecision, input.textFindingCount, input.uniqueFindingCount)}`,
      `Title: ${input.title}`,
      `Summary: ${input.summary}`,
      `Access: ${access}`,
      `Expiration: ${input.expiresAt === undefined ? "14 days (default)" : input.expiresAt === null ? "No expiration" : input.expiresAt}`,
      `Additional redactions: ${input.ownerRedactions.length === 0 ? "none" : ownerRedactionsText(input.ownerRedactions)}`,
      ...(input.requiresWarning ? [NATIVE_SESSION_BUNDLE_WARNING] : []),
      ...(input.truncated ? ["Note: the title or summary above was shortened to fit the character limit."] : []),
      "Automated security detection is incomplete. You remain responsible for shared content.",
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        confirmPublish: { type: "boolean", title: "Publish this session with everything shown above", default: false },
      },
      required: ["confirmPublish"],
    },
  };
}

type SecretGateOutcome =
  | { readonly kind: "unavailable" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "resolved"; readonly resolutions: readonly CaptureResolution[]; readonly decision: SecretDecision };

/**
 * Steps 1-3 of the deterministic publish flow: report how many secrets were
 * found, then require the owner to choose redact-all, review-each, or
 * publish-unredacted before anything else can happen. Returns "unavailable"
 * when the connected client cannot render forms at all; callers fall back to
 * the existing review-required/resolutions round trip in that case.
 */
async function runSecretDecisionGate(
  deps: SaveSessionDependencies,
  ctx: { readonly captureId: string; readonly harnessSessionId: string },
  pending: readonly CaptureFinding[],
): Promise<SecretGateOutcome> {
  const decisionAnswer = await deps.confirm(secretDecisionForm({ ...ctx, pending }));
  if (decisionAnswer === undefined) return { kind: "unavailable" };
  if (decisionAnswer.action !== "accept") return { kind: "cancelled" };
  const decision = decisionAnswer.content?.decision;
  if (decision !== "redact-all" && decision !== "review-each" && decision !== "publish-unredacted") {
    throw new NativeCaptureError("INVALID_CONFIRMATION", "Choose redact-all, review-each, or publish-unredacted for the detected secrets.");
  }
  if (decision === "redact-all") {
    return { kind: "resolved", decision, resolutions: pending.map((finding) => ({ findingId: finding.id, action: { kind: "accept-redaction" } })) };
  }
  if (decision === "publish-unredacted") {
    return { kind: "resolved", decision, resolutions: pending.map((finding) => ({ findingId: finding.id, action: { kind: "owner-override-unredacted" } })) };
  }
  const resolutions: CaptureResolution[] = [];
  for (const finding of pending) {
    const position = resolutions.length + 1;
    const answer = await deps.confirm(perFindingForm({ ...ctx, finding, position, total: pending.length }));
    if (answer === undefined) return { kind: "unavailable" };
    if (answer.action !== "accept") return { kind: "cancelled" };
    const findingDecision = answer.content?.decision;
    if (findingDecision === "redact-default") {
      resolutions.push({ findingId: finding.id, action: { kind: "accept-redaction" } });
    } else if (findingDecision === "keep") {
      resolutions.push({ findingId: finding.id, action: { kind: "owner-override-unredacted" } });
    } else if (findingDecision === "redact-custom") {
      const customAnswer = await deps.confirm(customReplacementForm({ ...ctx, finding, position, total: pending.length }));
      if (customAnswer === undefined) return { kind: "unavailable" };
      if (customAnswer.action !== "accept") return { kind: "cancelled" };
      const replacementText = typeof customAnswer.content?.replacementText === "string"
        ? customAnswer.content.replacementText.trim() : "";
      if (!replacementText) {
        throw new NativeCaptureError(
          "INVALID_CONFIRMATION",
          'Enter replacement text for this finding, or go back and choose "Yes, as [REDACTED]" or "No" instead.',
        );
      }
      resolutions.push({ findingId: finding.id, action: { kind: "custom-replacement", replacementText } });
    } else {
      throw new NativeCaptureError("INVALID_CONFIRMATION", "Choose one of the three options for this finding.");
    }
  }
  return { kind: "resolved", decision, resolutions };
}

export function createSaveHandler(deps: SaveSessionDependencies) {
  return async (input: SaveSessionInput): Promise<CallToolResult> => {
    let captureId: string | undefined;
    let reviewPath: string | undefined;
    let metadataTruncated = false;
    try {
      assertNonBlankMetadata(input);
      // Step 0: gathering session artifacts is never conditional on a
      // caller-supplied captureId. A fresh save always re-gathers; a
      // caller-supplied captureId is only accepted as a resume hint when it
      // matches what was just freshly gathered from the exact same source.
      const prepared = await deps.captures.prepare(input);
      captureId = prepared.captureId;
      reviewPath = prepared.reviewPath;
      if (input.captureId !== undefined && input.captureId !== captureId) {
        throw new NativeCaptureError("CAPTURE_CHANGED", "The session changed since an earlier response. Resolve findings, edits, and confirmation again using this freshly gathered captureId.");
      }
      const { archive } = await deps.captures.load(captureId);
      if (archive.harness.name !== input.harness ||
          (input.harnessSessionId !== undefined && archive.harnessSessionId !== input.harnessSessionId)) {
        throw new NativeCaptureError("SESSION_ID_MISMATCH", "The prepared capture belongs to a different requested session.");
      }
      const interactive = input.interactionMode !== "noninteractive";
      const ctx = { captureId, harnessSessionId: archive.harnessSessionId };

      let ownerRedactions = [...(input.ownerRedactions ?? [])];
      let candidate = { title: input.title, summary: input.summary };
      let audiencePolicy = input.audiencePolicy ?? { accessMode: "anonymous" as const };
      let expiresAt = input.expiresAt;
      let secretDecision: SecretDecision | undefined;

      // Step 1: scan.
      const findings = scanNativeCapture(archive, captureId, ownerRedactions);
      const textFindings = findings.filter((finding) => !finding.manualReview);
      const manualFindings = findings.filter((finding) => finding.manualReview);

      let resolutions: CaptureResolution[] = [...(input.resolutions ?? [])];
      const resolvedIds = () => new Set(resolutions.map((resolution) => resolution.findingId));

      // Step 2-3: report the finding count and require an explicit bulk (or
      // per-finding) decision before anything else can proceed.
      const unresolvedText = textFindings.filter((finding) => !resolvedIds().has(finding.id));
      if (interactive && unresolvedText.length > 0) {
        const gate = await runSecretDecisionGate(deps, ctx, unresolvedText);
        if (gate.kind === "cancelled") {
          return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
        }
        if (gate.kind === "resolved") {
          resolutions = [...resolutions, ...gate.resolutions];
          secretDecision = gate.decision;
        }
        // "unavailable" falls through to the existing review-required path below.
      }
      resolutions = [
        ...resolutions,
        ...manualFindings
          .filter((finding) => !resolvedIds().has(finding.id))
          .map((finding): CaptureResolution => ({ findingId: finding.id, action: { kind: "acknowledge-unscanned" } })),
      ];

      resolutions = resolutions.filter((resolution) => knownFindingIds(archive, ctx.captureId, candidate, ownerRedactions).has(resolution.findingId));
      let reviewed = await deps.captures.review(captureId, resolutions, candidate, ownerRedactions);
      if (reviewed.title !== candidate.title || reviewed.summary !== candidate.summary) {
        // Metadata is a separate draft revision. Its old offsets/IDs must not
        // be replayed against already-redacted text in publish_session.
        const rebasedIds = knownFindingIds(archive, captureId, { title: reviewed.title, summary: reviewed.summary }, ownerRedactions);
        resolutions = [...resolutions.filter((resolution) => rebasedIds.has(resolution.findingId)), ...reviewed.metadataResolutions];
      }
      candidate = { title: reviewed.title, summary: reviewed.summary };
      {
        const normalized = normalizeMetadata(candidate);
        candidate = { title: normalized.title, summary: normalized.summary };
        metadataTruncated = metadataTruncated || normalized.truncated;
      }

      let requiresWarning = manualFindings.length > 0;

      // Step 4: the one-shot metadata form, filled out exactly once.
      if (interactive) {
        const formRequest = metadataForm({ captureId, harnessSessionId: archive.harnessSessionId, ...candidate, audiencePolicy, expiresAt, ownerRedactions, truncated: metadataTruncated });
        const answer = await deps.confirm(formRequest);
        if (answer === undefined) {
          return response({
            status: "confirmation-required", stage: "metadata", captureId, reviewPath, metadataTruncated,
            proposal: { captureId, ...candidate, audiencePolicy, ...(expiresAt === undefined ? {} : { expiresAt }) },
            confirmation: formRequest, findings: manualFindings, secretDecision,
            instructions: "No upload occurred. Show this filled-in proposal and collect the title, summary, audience, expiration, and additional redactions in plain text or the supplied primitive form, then call save_session again with this exact captureId and the same resolutions. Do not ask for the native ID, create a blank metadata form, or prepare another capture.",
          });
        }
        if (answer.action !== "accept") return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
        const content = answer.content;
        if (typeof content?.title !== "string" || typeof content.summary !== "string" ||
            typeof content.audience !== "string" || typeof content.expiration !== "string" ||
            (content.additionalRedactions !== undefined && typeof content.additionalRedactions !== "string")) {
          throw new NativeCaptureError("INVALID_CONFIRMATION", "Confirmation must contain title, summary, audience, and expiration; additional redactions is optional but must be text if provided.");
        }
        const edited = { title: content.title, summary: content.summary };
        const editedAudience = content.audience === audienceText(audiencePolicy) ? audiencePolicy : parseAudienceText(content.audience);
        const editedExpiration = content.expiration === expirationText(expiresAt) ? expiresAt : parseExpiration(content.expiration);
        const additionalRedactionsAnswer = content.additionalRedactions ?? "";
        const editedOwnerRedactions = additionalRedactionsAnswer === ownerRedactionsText(ownerRedactions)
          ? ownerRedactions : parseOwnerRedactions(additionalRedactionsAnswer);
        const normalizedEdited = normalizeMetadata(edited);
        candidate = { title: normalizedEdited.title, summary: normalizedEdited.summary };
        metadataTruncated = metadataTruncated || normalizedEdited.truncated;
        audiencePolicy = editedAudience;
        expiresAt = editedExpiration;
        ownerRedactions = editedOwnerRedactions;

        // Re-scan exactly once for findings the edit itself introduced (e.g.
        // removed additional redactions exposing a previously-covered
        // secret). This never re-presents the metadata form; new findings
        // are auto-resolved using the previously-chosen bulk decision, a
        // per-finding loop when "review-each" was chosen, or a fresh gate
        // when no decision existed because the original scan found nothing.
        // Resolutions that no longer correspond to any current source or
        // metadata finding (e.g. an edit that removed the secret entirely)
        // are dropped rather than replayed, since resolveNativeCapture
        // rejects any resolution referencing an unrecognized finding ID.
        const rescanned = scanNativeCapture(archive, captureId, ownerRedactions);
        const currentKnownIds = knownFindingIds(archive, captureId, candidate, ownerRedactions);
        resolutions = resolutions.filter((resolution) => currentKnownIds.has(resolution.findingId));
        const rescannedText = rescanned.filter((finding) => !finding.manualReview);
        const rescannedManual = rescanned.filter((finding) => finding.manualReview);
        requiresWarning = rescannedManual.length > 0;
        const newText = rescannedText.filter((finding) => !resolvedIds().has(finding.id));
        if (newText.length > 0) {
          if (secretDecision === "redact-all") {
            resolutions = [...resolutions, ...newText.map((finding): CaptureResolution => ({ findingId: finding.id, action: { kind: "accept-redaction" } }))];
          } else if (secretDecision === "publish-unredacted") {
            resolutions = [...resolutions, ...newText.map((finding): CaptureResolution => ({ findingId: finding.id, action: { kind: "owner-override-unredacted" } }))];
          } else if (secretDecision === "review-each") {
            const gate = await runSecretDecisionGate(deps, ctx, newText);
            // "review-each" was already the owner's standing choice, so only
            // per-finding answers are meaningful here; still honor a cancel.
            if (gate.kind === "cancelled") return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
            if (gate.kind === "resolved") resolutions = [...resolutions, ...gate.resolutions];
          } else {
            const gate = await runSecretDecisionGate(deps, ctx, newText);
            if (gate.kind === "cancelled") return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
            if (gate.kind === "resolved") {
              resolutions = [...resolutions, ...gate.resolutions];
              secretDecision = gate.decision;
            }
            // "unavailable" falls through to the review-required path below.
          }
        }
        resolutions = [
          ...resolutions,
          ...rescannedManual
            .filter((finding) => !resolvedIds().has(finding.id))
            .map((finding): CaptureResolution => ({ findingId: finding.id, action: { kind: "acknowledge-unscanned" } })),
        ];
        reviewed = await deps.captures.review(captureId, resolutions, candidate, ownerRedactions);
        if (reviewed.title !== candidate.title || reviewed.summary !== candidate.summary) {
          const rebasedIds = knownFindingIds(archive, captureId, { title: reviewed.title, summary: reviewed.summary }, ownerRedactions);
          resolutions = [...resolutions.filter((resolution) => rebasedIds.has(resolution.findingId)), ...reviewed.metadataResolutions];
        }
        candidate = { title: reviewed.title, summary: reviewed.summary };
        {
          const normalized = normalizeMetadata(candidate);
          candidate = { title: normalized.title, summary: normalized.summary };
          metadataTruncated = metadataTruncated || normalized.truncated;
        }
      }

      const proposal = {
        captureId, ...candidate, audiencePolicy,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(ownerRedactions.length === 0 ? {} : { ownerRedactions }),
      };

      // Step 5: a separate, non-editable recap with exactly one yes/no field.
      if (interactive) {
        const recapRequest = recapForm({
          captureId, harnessSessionId: archive.harnessSessionId, ...candidate, audiencePolicy, expiresAt, ownerRedactions,
          secretDecision, textFindingCount: textFindings.length, uniqueFindingCount: groupFindingsByValue(textFindings).length,
          requiresWarning, truncated: metadataTruncated,
        });
        const recapAnswer = await deps.confirm(recapRequest);
        if (recapAnswer === undefined) {
          return response({
            status: "confirmation-required", stage: "recap", captureId, proposal, confirmation: recapRequest, metadataTruncated,
            findings: manualFindings, secretDecision,
            instructions: "No upload occurred. Present this exact non-editable recap after the metadata form and collect a single yes/no confirmation, then call save_session again with this exact captureId and the same resolutions.",
          });
        }
        if (recapAnswer.action !== "accept" || recapAnswer.content?.confirmPublish !== true) {
          return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
        }
      }

      const confirmedRequest: PublishToolInput = {
        ...proposal, resolutions, confirmed: true, additionalRedactionsConfirmed: true,
      };
      const result = await deps.publish(confirmedRequest);
      if (result.isError) {
        return { ...result, content: [...result.content, {
          type: "text",
          text: JSON.stringify({
            instructions: "Retry publish_session with this exact confirmed request; do not repeat source preparation or start a new save.",
            retryRequest: confirmedRequest,
          }),
        }] };
      }
      if (!interactive) {
        return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({
          interactionMode: "noninteractive",
          warning: NATIVE_SESSION_BUNDLE_WARNING,
          disclaimer: "Automated security detection is incomplete. The owner remains responsible for shared content.",
          ...(metadataTruncated ? { metadataTruncated: true, metadataNote: "The auto-generated title or summary was shortened to fit the character limit." } : {}),
        }) }] };
      }
      if (metadataTruncated) {
        return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({
          metadataTruncated: true, metadataNote: "The auto-generated title or summary was shortened to fit the character limit.",
        }) }] };
      }
      return result;
    } catch (error) {
      if (error instanceof CaptureReviewRequiredError) {
        return response({
          status: "review-required", captureId, reviewPath, findings: error.findings,
          message: "Nothing was uploaded. Resolve the actual security findings with the owner, regenerate metadata from the approved content, and continue using this captureId. Native warnings alone do not require a separate preliminary form.",
        });
      }
      return response({
        status: "save-failed", captureId,
        message: error instanceof Error ? safeReviewText(error.message) : "Unknown save error.",
        instructions: captureId === undefined
          ? "Retry with sessionDirectory from your harness's Session folder context or its native sourcePath. Do not ask the owner for a UUID, path or message already in your conversation; do not guess the newest source. Copilot normally supplies COPILOT_AGENT_SESSION_ID automatically."
          : "Nothing new was uploaded by preparation/confirmation. Keep this captureId; do not silently replace an earlier unknown publication outcome.",
      }, true);
    }
  };
}
