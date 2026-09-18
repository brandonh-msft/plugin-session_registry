import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { NATIVE_SESSION_BUNDLE_WARNING, type AudiencePolicy } from "@session-registry/core";
import { z } from "zod";
import { AUDIENCE_INPUT_GUIDANCE, audienceText, parseAudienceText } from "../audiencePolicy.js";
import type { PublishToolInput } from "../index.js";
import type { NativeCaptureService, PrepareCaptureInput } from "../native/captures.js";
import { NativeCaptureError } from "../native/files.js";
import {
  CaptureReviewRequiredError,
  safeReviewText,
  scanNativeCapture,
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

function response(value: object, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}

function metadata(value: { title: string; summary: string }): void {
  if (!value.title.trim() || value.title.length > 120 || !value.summary.trim() || value.summary.length > 500) {
    throw new NativeCaptureError("INVALID_METADATA", "Generate a nonblank title of at most 120 characters and summary of at most 500 characters.");
  }
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

export function saveConfirmation(
  input: { captureId: string; harnessSessionId: string; title: string; summary: string;
    audiencePolicy: AudiencePolicy; expiresAt?: string | null; requiresWarning: boolean },
): ElicitRequestFormParams {
  const access = input.audiencePolicy.accessMode === "anonymous"
    ? "Anyone (anonymous)" : `Restricted: ${JSON.stringify(input.audiencePolicy.rules)}`;
  return {
    mode: "form",
    message: [
      `Publish session ${input.harnessSessionId} (capture ${input.captureId}).`,
      `Title: ${input.title}`,
      `Summary: ${input.summary}`,
      `Access: ${access}`,
      `Expiration: ${input.expiresAt === undefined ? "14 days (default)" : input.expiresAt === null ? "No expiration" : input.expiresAt}`,
      "Confirm these drafted values or edit them. Editing causes a re-scan and a fresh confirmation.",
      ...(input.requiresWarning ? [NATIVE_SESSION_BUNDLE_WARNING] : []),
      "Automated security detection is incomplete. You remain responsible for shared content.",
    ].join("\n\n"),
    // MCP forms require primitive properties, unlike the nested tool schema.
    requestedSchema: {
      type: "object",
      properties: {
        title: { type: "string", title: "Title", default: input.title, minLength: 1, maxLength: 120 },
        summary: { type: "string", title: "Summary", default: input.summary, minLength: 1, maxLength: 500 },
        audience: { type: "string", title: "Audience", description: AUDIENCE_INPUT_GUIDANCE, default: audienceText(input.audiencePolicy), minLength: 1 },
        expiration: { type: "string", title: "Expiration", description: "Number of days (e.g. 7 days), never, or a future ISO 8601 timestamp.", default: expirationText(input.expiresAt), minLength: 1 },
        confirmPublish: { type: "boolean", title: "Publish this session with the settings shown", default: false },
        ...(input.requiresWarning ? {
          acknowledgeWarning: { type: "boolean" as const, title: "I accept the native-package warning above", default: false },
        } : {}),
      },
      required: ["title", "summary", "audience", "expiration", "confirmPublish", ...(input.requiresWarning ? ["acknowledgeWarning"] : [])],
    },
  };
}

function additionalRedactionConfirmation(
  input: { captureId: string; harnessSessionId: string; ownerRedactions: readonly OwnerRedaction[] },
): ElicitRequestFormParams {
  return {
    mode: "form",
    message: [
      `The scanner findings and publication settings for session ${input.harnessSessionId} are approved.`,
      "Anything else you'd like redacted that the scanner didn't flag?",
      "Add internal project names, personal names, hostnames, URLs, or other sensitive text. Leave the field blank and confirm to proceed without additional redactions.",
    ].join("\n\n"),
    requestedSchema: {
      type: "object",
      properties: {
        additionalRedactions: {
          type: "string",
          title: "Additional redactions (optional)",
          description: 'One item per line: text to redact, or "text -> replacement" for a custom replacement (default replacement is [REDACTED]). Applied to every scannable native source and publication metadata occurrence, matched case-insensitively.',
          default: ownerRedactionsText(input.ownerRedactions),
        },
        confirmAdditionalRedactions: {
          type: "boolean",
          title: "I reviewed additional redactions and want to continue",
          default: false,
        },
      },
      required: ["additionalRedactions", "confirmAdditionalRedactions"],
    },
  };
}

export function createSaveHandler(deps: SaveSessionDependencies) {
  return async (input: SaveSessionInput): Promise<CallToolResult> => {
    let captureId = input.captureId;
    let reviewPath: string | undefined;
    try {
      metadata(input);
      if (captureId === undefined) {
        const prepared = await deps.captures.prepare(input);
        captureId = prepared.captureId;
        reviewPath = prepared.reviewPath;
      }
      const { archive } = await deps.captures.load(captureId);
      if (archive.harness.name !== input.harness ||
          (input.harnessSessionId !== undefined && archive.harnessSessionId !== input.harnessSessionId)) {
        throw new NativeCaptureError("SESSION_ID_MISMATCH", "The prepared capture belongs to a different requested session.");
      }
      let ownerRedactions = [...(input.ownerRedactions ?? [])];
      let sourceFindings = scanNativeCapture(archive, captureId, ownerRedactions);
      const requiresAdditionalRedactionReview = sourceFindings.some((finding) => !finding.manualReview);
      const sourceFindingIds = new Set(sourceFindings.map((finding) => finding.id));
      const pendingWarnings = sourceFindings.filter((finding) => finding.manualReview &&
        !(input.resolutions ?? []).some((resolution) => resolution.findingId === finding.id));
      let resolutions: CaptureResolution[] = [
        ...(input.resolutions ?? []),
        ...pendingWarnings.map(({ id }): CaptureResolution => ({ findingId: id, action: { kind: "acknowledge-unscanned" } })),
      ];
      // These provisional warning decisions are used only for local validation.
      // They reach publication only after form acceptance or explicit headless
      // publication authorization. Actual secret decisions are never inferred.
      let candidate = { title: input.title, summary: input.summary };
      let audiencePolicy = input.audiencePolicy ?? { accessMode: "anonymous" as const };
      let expiresAt = input.expiresAt;
      for (let attempt = 0; attempt < 5; attempt++) {
        const reviewed = await deps.captures.review(captureId, resolutions, candidate, ownerRedactions);
        if (reviewed.title !== candidate.title || reviewed.summary !== candidate.summary) {
          // Metadata is a separate draft revision. Its old offsets/IDs must not
          // be replayed against already-redacted text in publish_session.
          resolutions = [
            ...resolutions.filter((resolution) => sourceFindingIds.has(resolution.findingId)),
            ...reviewed.metadataResolutions,
          ];
          candidate = { title: reviewed.title, summary: reviewed.summary };
          continue;
        }
        candidate = { title: reviewed.title, summary: reviewed.summary };
        metadata(candidate);
        let proposal = {
          captureId, ...candidate, audiencePolicy,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(ownerRedactions.length === 0 ? {} : { ownerRedactions }),
        };
        const request = saveConfirmation({
          ...proposal, harnessSessionId: archive.harnessSessionId, requiresWarning: pendingWarnings.length > 0,
        });
        const confirmation = input.interactionMode === "noninteractive"
          ? { action: "accept" as const, content: { ...candidate, audience: audienceText(audiencePolicy),
            expiration: expirationText(expiresAt), confirmPublish: true, acknowledgeWarning: true } }
          : await deps.confirm(request);
        if (confirmation === undefined) {
          return response({
            status: "confirmation-required", captureId, reviewPath, proposal, confirmation: request,
            findings: pendingWarnings,
            instructions: "No upload occurred. Show this filled-in proposal and collect explicit confirmation and warning acknowledgment in plain text or the supplied primitive form. Then separately ask whether anything else should be redacted that the scanner did not flag, collect exact-text rules or an explicit no-more-redactions decision, and call publish_session with this captureId, the approved values, explicit finding resolutions, and additionalRedactionsConfirmed:true. Do not ask for the native ID, create a blank metadata form, or prepare another capture.",
          });
        }
        if (confirmation.action !== "accept") return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
        const content = confirmation.content;
        if (typeof content?.title !== "string" || typeof content.summary !== "string" ||
            typeof content.audience !== "string" || typeof content.expiration !== "string") {
          throw new NativeCaptureError("INVALID_CONFIRMATION", "Confirmation must contain the proposed or edited title, summary, audience, and expiration.");
        }
        const edited = { title: content.title, summary: content.summary };
        const editedAudience = content.audience === audienceText(audiencePolicy) ? audiencePolicy : parseAudienceText(content.audience);
        const editedExpiration = content.expiration === expirationText(expiresAt) ? expiresAt : parseExpiration(content.expiration);
        metadata(edited);
        const metadataChanged = edited.title !== candidate.title || edited.summary !== candidate.summary;
        const settingsChanged = metadataChanged ||
          audienceText(editedAudience) !== audienceText(audiencePolicy) || editedExpiration !== expiresAt;
        if (settingsChanged) {
          if (metadataChanged) {
            resolutions = resolutions.filter((resolution) => sourceFindingIds.has(resolution.findingId));
          }
          candidate = edited;
          audiencePolicy = editedAudience;
          expiresAt = editedExpiration;
          sourceFindings = scanNativeCapture(archive, captureId, ownerRedactions);
          resolutions = resolutions.filter((resolution) =>
            sourceFindings.some((finding) => finding.id === resolution.findingId));
          const rereviewed = await deps.captures.review(captureId, resolutions, candidate, ownerRedactions);
          if (rereviewed.title !== candidate.title || rereviewed.summary !== candidate.summary) {
            resolutions = [
              ...resolutions.filter((resolution) =>
                sourceFindings.some((finding) => finding.id === resolution.findingId)),
              ...rereviewed.metadataResolutions,
            ];
            candidate = { title: rereviewed.title, summary: rereviewed.summary };
          }
          metadata(candidate);
          proposal = {
            captureId, ...candidate, audiencePolicy,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(ownerRedactions.length === 0 ? {} : { ownerRedactions }),
          };
        }
        if (content.confirmPublish !== true || (pendingWarnings.length > 0 && content.acknowledgeWarning !== true)) {
          return response({
            status: "confirmation-required", captureId, proposal, confirmation: request, findings: pendingWarnings,
            message: "Nothing was uploaded. Explicit publication confirmation and the displayed warning acknowledgment are required.",
            instructions: "Keep this exact reviewed proposal, including edited access/expiry. Do not revert to the initial draft or switch to noninteractive. Continue confirmation with the same captureId.",
          });
        }
        let additionalRedactionsConfirmed: true | undefined;
        if (input.interactionMode === "interactive" && requiresAdditionalRedactionReview) {
          const additionalRedactionRequest = additionalRedactionConfirmation({
            captureId,
            harnessSessionId: archive.harnessSessionId,
            ownerRedactions,
          });
          const additionalRedactionConfirmationResult = await deps.confirm(additionalRedactionRequest);
          if (additionalRedactionConfirmationResult === undefined) {
            return response({
              status: "confirmation-required",
              stage: "additional-redactions",
              captureId,
              proposal,
              confirmation: additionalRedactionRequest,
              instructions: "No upload occurred. Present this distinct additional-redaction prompt after the scanner finding decision, then call publish_session with the same captureId and additionalRedactionsConfirmed:true.",
            });
          }
          if (additionalRedactionConfirmationResult.action !== "accept") {
            return response({ status: "cancelled", captureId, message: "Nothing was uploaded; the local capture remains available." });
          }
          const additionalRedactionContent = additionalRedactionConfirmationResult.content;
          if (typeof additionalRedactionContent?.additionalRedactions !== "string" ||
              additionalRedactionContent.confirmAdditionalRedactions !== true) {
            return response({
              status: "confirmation-required",
              stage: "additional-redactions",
              captureId,
              proposal,
              confirmation: additionalRedactionRequest,
              message: "Nothing was uploaded. Confirm the distinct additional-redaction review to continue.",
            });
          }
          ownerRedactions = parseOwnerRedactions(additionalRedactionContent.additionalRedactions);
          sourceFindings = scanNativeCapture(archive, captureId, ownerRedactions);
          resolutions = resolutions.filter((resolution) =>
            sourceFindings.some((finding) => finding.id === resolution.findingId));
          const additionalRedactionReview = await deps.captures.review(
            captureId,
            resolutions,
            candidate,
            ownerRedactions,
          );
          candidate = {
            title: additionalRedactionReview.title,
            summary: additionalRedactionReview.summary,
          };
          metadata(candidate);
          proposal = {
            captureId,
            ...candidate,
            audiencePolicy,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(ownerRedactions.length === 0 ? {} : { ownerRedactions }),
          };
          additionalRedactionsConfirmed = true;
        }
        const confirmedRequest: PublishToolInput = {
          ...proposal,
          resolutions,
          confirmed: true,
          ...(additionalRedactionsConfirmed === undefined ? {} : { additionalRedactionsConfirmed }),
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
        if (input.interactionMode === "noninteractive" && !result.isError) {
          return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({
            interactionMode: "noninteractive",
            warning: NATIVE_SESSION_BUNDLE_WARNING,
            disclaimer: "Automated security detection is incomplete. The owner remains responsible for shared content.",
          }) }] };
        }
        return result;
      }
      return response({ status: "confirmation-required", captureId, message: "Too many consecutive edits. Nothing was uploaded; continue with this capture after reviewing the final metadata." });
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
