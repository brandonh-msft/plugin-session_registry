#!/usr/bin/env node
/**
 * Local (stdio-transport) MCP server entrypoint. Harnesses launch this
 * process directly — it runs in the developer's own environment so the
 * client-side scan-then-submit flow (`./tools/publish.ts`) can execute
 * before anything is transmitted to the hosted registry backend (Key
 * Technical Decisions: client-side scan-then-submit).
 *
 * This file is intentionally thin: it wires the MCP protocol/transport to
 * `publishSession`, but contains none of the scan/resolve/submit logic
 * itself, so that logic remains directly unit-testable without a live MCP
 * client. See `packages/mcp-server/test/tools/publish.test.ts`.
 *
 * The publishing agent supplies the title/summary it generated and confirms
 * the complete request in the tool arguments. The server then performs the
 * deterministic local scan and atomic upload/publish/share flow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  FULL_FIDELITY_PUBLICATION_CONTRACT_ID,
  FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
  FULL_FIDELITY_SAVE_WORKFLOW,
  FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST,
  FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION,
  NATIVE_HARNESSES,
  computePublicationKey,
  type AudiencePolicy,
  type PublicationExpirationChoice,
} from "@session-registry/core";
import {
  publishAndShareSession,
  type BackendPublishAndShareClient,
} from "./tools/publishAndShare.js";
import {
  deleteSession,
  type BackendDeleteSessionClient,
} from "./tools/deleteSession.js";
import {
  restoreSession,
  type BackendRestoreSessionClient,
} from "./tools/restoreSession.js";
import {
  purgeSession,
  type BackendPurgeSessionClient,
} from "./tools/purgeSession.js";
import {
  purgeSessions,
  type BackendListTombstonedSessionsClient,
} from "./tools/purgeSessions.js";
import {
  createHttpBackendClient,
  PublishStateUnknownError,
} from "./httpBackendClient.js";
import { createSasContentUploader } from "./sasContentUploader.js";
import { createNativeCaptureService, type NativeCaptureService } from "./native/captures.js";
import { NativeCaptureError } from "./native/files.js";
import { createSaveHandler } from "./tools/saveSession.js";
import type { OwnerRedaction } from "./native/review.js";
import { audiencePolicySchema, audienceText } from "./audiencePolicy.js";
import {
  CaptureReviewRequiredError,
  derivePublicationContentDecisions,
  resolveReviewedFindings,
  safeReviewText,
  type CaptureResolution,
} from "./native/review.js";

const sourceSelectionShape = {
  harness: z.enum(NATIVE_HARNESSES),
  harnessSessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe(
    "Optional known native ID. Do not ask the owner to transcribe it: use sourcePath/sessionDirectory from your context or workingDirectory plus recentUserMessage for verified native lookup.",
  ),
  sourcePath: z.string().min(1).max(32_768).optional().describe(
    "Native journal/JSONL/rollout path from the producing harness context, not rendered /export output. The server reads and verifies its native ID.",
  ),
  sessionDirectory: z.string().min(1).max(32_768).optional().describe(
    "Copilot native session folder shown in your system context, or Claude's session-specific directory. Do not reject a folder UUID without checking its native journal; the server verifies identity.",
  ),
  workingDirectory: z.string().min(1).max(32_768).optional().describe(
    "Your current absolute working directory. Pair with recentUserMessage when the native source path/ID is unavailable.",
  ),
  recentUserMessage: z.string().min(1).max(32_768).optional().describe(
    "Exact distinctive user text already visible in this conversation, e.g. the task before 'save this session'. Used only for unique native-source lookup, never as a transcript substitute. Do not ask the user to retype it.",
  ),
  hostSessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe(
    "VS Code Agent Host only: exact host session identifier when it differs from the backing SDK session ID. Not a path or URL.",
  ),
  dependencyPaths: z.array(z.string().min(1).max(32_768)).max(1_000).optional().describe(
    "Exact external historical files authorized by the owner; only references present in the selected native source are read.",
  ),
  dependencyMappings: z.array(z.object({
    sourcePath: z.string().min(1).max(32_768),
    localPath: z.string().min(1).max(32_768),
  }).strict()).max(1_000).optional().describe("Explicit mappings from recorded external references to owner-authorized historical copies."),
};

const resolutionsSchema = z.array(z.object({
  findingId: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accept-redaction") }).strict(),
    z.object({ kind: z.literal("custom-replacement"), replacementText: z.string().max(1_000_000) }).strict(),
    z.object({ kind: z.literal("false-positive") }).strict(),
    z.object({ kind: z.literal("acknowledge-unscanned") }).strict(),
  ]),
}).strict()).max(10_000);

const ownerRedactionsSchema = z.array(z.object({
  exactText: z.string().min(1).max(10_000).describe("Exact owner-selected text to replace everywhere it occurs in scannable native source content and publication metadata."),
  replacementText: z.string().max(1_000_000).optional().describe("Replacement text; defaults to [REDACTED]."),
  caseSensitive: z.boolean().optional().describe("Defaults to false so capitalization variants are also replaced."),
}).strict()).max(1_000);

export interface PublishToolInput {
  readonly captureId: string;
  readonly resolutions: readonly CaptureResolution[];
  readonly ownerRedactions?: readonly OwnerRedaction[];
  readonly title: string;
  readonly summary: string;
  readonly confirmed: true;
  readonly audiencePolicy?: AudiencePolicy;
  readonly expiresAt?: string | null;
}

type SessionRegistryBackendClient = BackendPublishAndShareClient &
  BackendDeleteSessionClient &
  BackendRestoreSessionClient &
  BackendPurgeSessionClient &
  BackendListTombstonedSessionsClient;
type ServerBackendClient = BackendPublishAndShareClient &
  Partial<BackendDeleteSessionClient> &
  Partial<BackendRestoreSessionClient> &
  Partial<BackendPurgeSessionClient> &
  Partial<BackendListTombstonedSessionsClient>;

export function createDefaultBackendClient(
  env: NodeJS.ProcessEnv,
): SessionRegistryBackendClient {
  const baseUrl = requiredEnvironmentValue(env, "SESSION_REGISTRY_API_URL");
  const token = requiredEnvironmentValue(env, "SESSION_REGISTRY_TOKEN");
  const getAccessToken = async () => token;
  const uploader = createSasContentUploader({ baseUrl, getAccessToken });
  return createHttpBackendClient({
    baseUrl,
    getAccessToken,
    uploader,
  });
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name:
    | "SESSION_REGISTRY_API_URL"
    | "SESSION_REGISTRY_TOKEN",
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured for the MCP server`);
  }
  return value;
}

export function createPublishHandler(
  backendClient: BackendPublishAndShareClient,
  captures: NativeCaptureService = createNativeCaptureService(),
) {
  return async (input: PublishToolInput) => {
    const idempotencyKey = confirmedRequestKey(input);
    try {
      if (!input.confirmed) throw new Error("Owner confirmation is required before publication.");
      const audiencePolicy = audiencePolicySchema.parse(input.audiencePolicy);
      // Stages the exact bytes that will be uploaded next to the original
      // capture. A retry of this same confirmed request re-sends that staged
      // file rather than re-capturing and re-redacting the session.
      const capture = await captures.approveForPublish(input.captureId, idempotencyKey, {
        resolutions: input.resolutions,
        metadata: { title: input.title, summary: input.summary },
        ...(input.ownerRedactions === undefined ? {} : { ownerRedactions: input.ownerRedactions }),
      });
      const result = await publishAndShareSession(
        {
          // Ownership is derived by the API from SESSION_REGISTRY_TOKEN.
          // This local field never crosses the backend boundary.
          ownerGithubLogin: "authenticated-owner",
          harnessSessionId: capture.archive.harnessSessionId,
          transcript: capture.content,
          artifacts: [],
          harness: capture.archive.harness,
          publicationKey: computePublicationKey({
            title: capture.title,
            summary: capture.summary,
            audiencePolicy,
            expiresAtChoice: publicationExpirationChoice(input.expiresAt),
            ownerRedactions: input.ownerRedactions ?? [],
            contentDecisions: derivePublicationContentDecisions(
              capture.archive,
              input.captureId,
              { title: capture.title, summary: capture.summary },
              input.ownerRedactions,
              input.resolutions,
            ),
          }),
          share: {
            audiencePolicy,
            ...(input.expiresAt === undefined
              ? {}
              : {
                  expiresAt:
                    input.expiresAt === null
                      ? null
                      : new Date(input.expiresAt),
                }),
          },
          idempotencyKey,
        },
        {
          backendClient,
          interactive: true,
          resolveInteractively: async (findings) => resolveReviewedFindings(capture, findings),
          generateSummary: async () => ({
            title: capture.title,
            summary: capture.summary,
          }),
          confirmSummary: async (candidate) =>
            input.confirmed ? candidate : null,
        },
      );
      const ownerRequestedRedactionCount = input.ownerRedactions?.length ?? 0;
      const appliedRedactionCount = capture.archive.redactions.length;
      // The upload is confirmed, so the local plaintext originals are no longer
      // needed. Deleting only here is what makes a failed upload retryable.
      let localCapturesRemoved = true;
      let localCaptureRemovalError: string | undefined;
      try {
        await captures.discard(input.captureId);
      } catch (error) {
        localCapturesRemoved = false;
        localCaptureRemovalError = error instanceof Error ? safeReviewText(error.message) : "unknown cleanup error";
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${result.idempotentReplay ? "Replayed confirmed publish" : "Published session"} ` +
              `${result.harnessSessionId} and ${result.idempotentReplay ? "returned" : "created"} ` +
              `share link ${result.linkId}. View it at ${result.shareUrl}`,
          },
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "published",
              title: capture.title,
              summary: capture.summary,
              harnessSessionId: result.harnessSessionId,
              shareUrl: result.shareUrl,
              localCapturesRemoved,
              ...(localCaptureRemovalError === undefined ? {} : {
                localCaptureRemovalError,
                localCaptureRemovalGuidance:
                  `The session was published. Its local capture files for ${input.captureId} could not be deleted ` +
                  `and still contain unredacted content; remove them manually.`,
              }),
              publicationSettings: {
                audience: audienceText(audiencePolicy),
                audiencePolicy,
                expiration: input.expiresAt === undefined ? "14 days (default)" : input.expiresAt,
                ownerRequestedRedactionCount,
                appliedRedactionCount,
              },
            }),
          },
        ],
      };
    } catch (error) {
      const detail =
        error instanceof Error ? safeReviewText(error.message) : "unknown publishing error";
      if (error instanceof CaptureReviewRequiredError) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              code: error.code,
              message: `SECURITY REVIEW REQUIRED: Nothing was uploaded. ${error.message}`,
              findings: error.findings,
            }),
          }],
        };
      }
      if (error instanceof NativeCaptureError &&
          (error.code === "CAPTURE_NOT_FOUND" || error.code === "CAPTURE_CHANGED" || error.code === "CAPTURE_UPGRADE_REQUIRED")) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text:
              `PUBLISH BLOCKED: No new upload was attempted. The local capture for request ${idempotencyKey} ` +
              `is gone or no longer matches. Local captures are deleted only after a successful upload, so this ` +
              `session may already be published: check for an existing share link before doing anything else. ` +
              `Do not capture the session again to retry. ${detail}`,
          }],
        };
      }
      if (error instanceof PublishStateUnknownError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `PUBLISH STATE UNKNOWN: Retry the same confirmed request; ` +
                `its deterministic idempotency key is ${idempotencyKey}. ${detail}`,
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `PUBLISH FAILED: Nothing was published. ${detail}`,
          },
        ],
      };
    }
  };
}

function publicationExpirationChoice(
  value: PublishToolInput["expiresAt"],
): PublicationExpirationChoice {
  if (value === undefined) {
    return "default";
  }
  if (value === null) {
    return "never";
  }
  return new Date(value);
}

function confirmedRequestKey(input: PublishToolInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        captureId: input.captureId,
        resolutions: [...input.resolutions].sort((a, b) => a.findingId.localeCompare(b.findingId)).map(({ findingId, action }) => ({
          findingId,
          action: action.kind === "custom-replacement"
            ? { kind: action.kind, replacementText: action.replacementText }
            : { kind: action.kind },
        })),
        ownerRedactions: input.ownerRedactions ?? [],
        title: input.title,
        summary: input.summary,
        audiencePolicy: input.audiencePolicy ?? { accessMode: "anonymous" },
        expiresAt: input.expiresAt === undefined ? "default" : input.expiresAt,
      }),
    )
    .digest("hex");
}

export function createServer(
  backendClient: ServerBackendClient = createDefaultBackendClient(
    process.env,
  ),
  captures: NativeCaptureService = createNativeCaptureService(),
): McpServer {
  const server = new McpServer({
    name: "session-registry-mcp-server",
    // The server implementation version is independent from the application-level
    // full-fidelity publication contract version advertised by its tool and prompt.
    version: "0.0.0",
  }, {
    instructions: FULL_FIDELITY_SAVE_WORKFLOW,
  });

  server.registerTool(
    "save_session",
    {
      title: "Save and share this session",
      description:
        "Preferred tool for 'save this session', 'publish this session' or 'share this session'. " +
        "Call this BEFORE asking the user for information. YOU generate title and summary from approved conversation content; do not ask the owner to author them. " +
        "For Copilot the server uses the runtime's COPILOT_AGENT_SESSION_ID and verifies its native journal automatically. Otherwise pass sourcePath or sessionDirectory from harness context, or workingDirectory and exact distinctive recentUserMessage. Never ask the owner to find their session. " +
        "Captures full native state, scans it, presents a server-built prefilled confirmation with Anyone (anonymous)/14 days by default, then publishes and returns the link. " +
        "Set interactionMode to noninteractive ONLY when running headlessly with no possible further chat turn (Copilot -p, Claude --print, Codex exec): the user's publish prompt authorizes generated metadata, requested settings or defaults, owner-requested exact-text redactions, and the native-package warning without a form. Detected secrets not covered by an owner redaction still need explicit owner resolutions. " +
        "Set interactive when the user can respond, which includes every slash command and chat message in a live session \u2014 even a terse one like '/publish-session' or 'just publish it, this is a demo'. Never infer noninteractive from an explicit, urgent, or terse request; only the literal absence of a further chat turn (a flag-invoked headless process) justifies it. In interactive mode all settings MUST be shown in one prefilled confirmation and explicitly confirmed by the owner before any upload \u2014 this mandatory questionnaire step can never be skipped, auto-approved, or inferred from the original publish request. Never switch a cancelled interactive request to noninteractive. Do NOT construct an ask_user schema. " +
        "If a previous call returned captureId, reuse it; after an unknown publication result retry publish_session, never recapture.",
      inputSchema: z.object({
        ...sourceSelectionShape,
        interactionMode: z.enum(["interactive", "noninteractive"]).describe(
          "Required runtime context: noninteractive ONLY when you truly cannot communicate with the user at all, i.e. a flag-invoked headless process (Copilot -p/--prompt, Claude --print, Codex exec) with no further chat turn possible. Otherwise ALWAYS interactive, including every slash command or chat message in a live session, no matter how terse or explicit the wording. The user's explicit publish request authorizes prompt-specified values or defaults without UI ONLY in genuine noninteractive runs; cancellations never authorize headless retries, and interactive mode always requires the owner's explicit confirmation of the shown proposal before upload.",
        ),
        captureId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Reuse a capture from a prior save/review; do not replace it on retry."),
        title: z.string().min(1).max(120).describe("YOU auto-generate the session title; the server prefills it for owner confirmation/edits."),
        summary: z.string().min(1).max(500).describe("YOU auto-generate the whole-session task/outcome/decisions summary from approved content, not a placeholder or request for owner text."),
        audiencePolicy: audiencePolicySchema,
        expiresAt: z.string().datetime().nullable().optional().describe("Omit for 14 days; null explicitly means no expiration. Preserve a user-specified value."),
        resolutions: resolutionsSchema.optional().describe("Only prior explicit owner security decisions for detected secrets. Native warnings are confirmed in the interactive form or covered by the headless publish request."),
        ownerRedactions: ownerRedactionsSchema.optional().describe("Owner-requested redactions beyond detected secrets. Translate requests such as 'redact every reference to hurlburb' into an exactText rule. Rules replace every matching occurrence in scannable native source content and publication metadata; default replacement is [REDACTED] and matching is case-insensitive unless requested otherwise."),
      }).strict(),
    },
    async (input, extra) => createSaveHandler({
      captures,
      publish: createPublishHandler(backendClient, captures),
      confirm: async (request) => {
        if (!server.server.getClientCapabilities()?.elicitation?.form) return undefined;
        return server.server.elicitInput(request, {
          relatedRequestId: extra.requestId, signal: extra.signal, timeout: 10 * 60 * 1_000,
        });
      },
    })(input),
  );

  server.registerTool(
    "prepare_session_capture",
    {
      title: "Prepare native session capture",
      description:
        "Read a selected supported CLI, VS Code native chat or Agent Host, Visual Studio 18.8+ SDK, " +
        "or GitHub Copilot Desktop/Standalone Chat session from " +
        "its configured local native store. Captures persisted records and supported " +
        "dependencies without filtering event types or fields. Saves the original " +
        "unchanged in an owner-only local archive and reports possible security findings. " +
        "Returns a captureId, findings, and reviewPath, not the transcript or secret values. " +
        "For local capture only, identify the producing profile; sourcePath/sessionDirectory establishes the native ID, " +
        "or workingDirectory plus recentUserMessage finds a unique recorded session. Do not ask the user for a UUID first. sourcePath selects an " +
        "explicit native file after resume, fork, import, or ambiguous project/version lookup. " +
        "dependencyPaths authorizes exact external files referenced by the native source. " +
        "Capture records per-file observed boundaries, decoding diagnostics, and unverified restoration separately. " +
        "Never invent an ID, reconstruct history, or " +
        "substitute a summary. Unsupported or incomplete sources fail without uploading. " +
        FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
      inputSchema: z.object(sourceSelectionShape).strict(),
    },
    async (input) => {
      try {
        const result = await captures.prepare(input);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              nextStep: {
                tool: "save_session",
                instructions: FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
              },
            }),
          }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `CAPTURE FAILED: Nothing was uploaded. ${error instanceof Error ? safeReviewText(error.message) : "unknown capture error"}`,
          }],
        };
      }
    },
  );

  server.registerTool(
    "publish_session",
    {
      title: "Publish agent session",
      description:
        "Resolves the owner's per-finding security decisions against the original native " +
        "capture, then uploads that exact approved variant and atomically publishes a session with its first share link. " +
        "The calling agent must generate and confirm the title, summary, audience, " +
        "expiration, capture, and finding resolutions before invoking " +
        `this tool. ${FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION} ` +
        "Treat an isError result as a failed publish; never claim success " +
        "unless the complete public share URL is returned.",
      inputSchema: z.object({
        captureId: z.string().regex(/^[a-f0-9]{64}$/).describe(
          "The immutable captureId returned by prepare_session_capture. Reuse exactly on retries.",
        ),
        resolutions: resolutionsSchema.describe(
          "One explicit owner decision per finding: accept-redaction, custom-replacement, or false-positive for detected secrets; acknowledge-unscanned only after the owner accepts the separate unscannable-content warning. Use [] when there are none. Unresolved findings block upload.",
        ),
        ownerRedactions: ownerRedactionsSchema.optional().describe(
          "Exact owner-requested replacements confirmed for this capture. These are independent of scanner findings and are applied everywhere in scannable native source content and publication metadata.",
        ),
        title: z.string().min(1).max(120).describe(
          "Auto-generate a specific session title, then obtain owner confirmation or edits. Do not ask the owner to author a title unless they choose to replace the draft.",
        ),
        summary: z.string().min(1).max(500).describe(
          "Auto-generate a concise account of the whole session's task, outcome, and notable decisions from approved content, then obtain owner confirmation or edits. This metadata is not the full-fidelity transcript.",
        ),
        confirmed: z.literal(true).describe(
          "True only after the owner has confirmed the captured source, finding resolutions, title, summary, audience, and expiration, and acknowledged that automated detection is incomplete.",
        ),
        audiencePolicy: audiencePolicySchema.describe(
          "Access defaults to Anyone (anonymous) when omitted. Show this default in the filled-in publish confirmation; do not ask a separate audience question. Preserve an explicitly chosen authenticated policy and require its rules.",
        ),
        expiresAt: z.string().datetime().nullable().optional().describe(
          "Reuse the owner's requested expiration, otherwise propose the 14-day default and omit this field. null explicitly requests no expiration; do not require a separate date-entry step for the default.",
        ),
      }).strict(),
    },
    createPublishHandler(backendClient, captures),
  );

  server.registerTool(
    "delete_session",
    {
      title: "Delete published session",
      description:
        "Tombstone one previously published session by immutable sessionId. " +
        "Owner identity comes only from the configured bearer token; only the current publication row can be deleted. " +
        "Deleting an already tombstoned session succeeds as an idempotent no-op.",
      inputSchema: z.object({
        sessionId: z.string().min(1).describe(
          "Immutable published session id returned by publish_session or save_session.",
        ),
      }).strict(),
    },
    async (input) => {
      const result = await deleteSession(input, {
        backendClient: requireDeleteSessionBackendClient(backendClient),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              result.outcome === "deleted"
                ? `Deleted session ${result.sessionId}.`
                : `Session ${result.sessionId} was already tombstoned.`,
          },
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "restore_session",
    {
      title: "Restore published session",
      description:
        "Restore one previously tombstoned published session by immutable sessionId. " +
        "Owner identity comes only from the configured bearer token; only the current publication row can be restored. " +
        "A content-blocked session can be restored but remains inaccessible and reports a distinct outcome.",
      inputSchema: z.object({
        sessionId: z.string().min(1).describe(
          "Immutable published session id returned by publish_session or save_session.",
        ),
      }).strict(),
    },
    async (input) => {
      const result = await restoreSession(input, {
        backendClient: requireRestoreSessionBackendClient(backendClient),
      });
      const message =
        result.outcome === "restored"
          ? `Restored session ${result.sessionId}.`
          : result.outcome === "already_active"
            ? `Session ${result.sessionId} was already active.`
            : `Restored session ${result.sessionId}, but it remains inaccessible because its content is blocked.`;
      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "purge_session",
    {
      title: "Permanently purge one published session",
      description:
        "Irreversibly hard-delete one previously tombstoned published session by immutable sessionId. " +
        "Only the owner can purge it, and only after delete_session has already tombstoned it. " +
        "Blob cleanup is best-effort: shared blobs are preserved, and any failed blob deletes are reported without resurrecting the row.",
      inputSchema: z.object({
        sessionId: z.string().min(1).describe(
          "Immutable published session id returned by publish_session or save_session.",
        ),
      }).strict(),
    },
    async (input) => {
      const result = await purgeSession(input, {
        backendClient: requirePurgeSessionBackendClient(backendClient),
      });
      const message =
        result.outcome === "purged"
          ? `Purged session ${result.sessionId}.`
          : `Purged session ${result.sessionId}, but some blobs could not be deleted immediately.`;
      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "purge_sessions",
    {
      title: "Permanently purge all tombstoned published sessions",
      description:
        "Preview and then, within this same tool call, permanently purge all of the caller's currently tombstoned published sessions. " +
        "This tool never accepts an explicit id list; the server computes the current tombstoned set, asks for confirmation once, and then purges only that fixed previewed set.",
      inputSchema: z.object({}).strict(),
    },
    async (input, extra) => {
      const result = await purgeSessions(input, {
        backendClient: requirePurgeSessionsBackendClient(backendClient),
        confirm: async (request) => {
          if (!server.server.getClientCapabilities()?.elicitation?.form) {
            return undefined;
          }
          const response = await server.server.elicitInput(
            {
              message: request.message,
              requestedSchema: request.requestedSchema,
            },
            {
              relatedRequestId: extra.requestId,
              signal: extra.signal,
              timeout: 10 * 60 * 1_000,
            },
          );
          return response as {
            action: "accept" | "decline" | "cancel";
            content?: { confirm?: boolean };
          };
        },
      });

      const succeeded = result.outcomes.filter(
        (outcome) =>
          outcome.outcome === "purged" ||
          outcome.outcome === "purged_with_blob_cleanup_failures",
      ).length;
      const partial = result.outcomes.filter(
        (outcome) => outcome.outcome === "purged_with_blob_cleanup_failures",
      ).length;
      const skipped = result.outcomes.filter(
        (outcome) => outcome.outcome === "skipped",
      ).length;
      const failed = result.outcomes.filter(
        (outcome) => outcome.outcome === "failed",
      ).length;
      const message =
        result.confirmation === "not_needed"
          ? "No tombstoned sessions were available to purge."
          : result.confirmation === "accepted"
            ? `Processed ${result.previewCount} previewed tombstoned sessions: ${succeeded} purged, ${partial} with blob cleanup warnings, ${skipped} skipped, ${failed} failed.`
            : result.confirmation === "unavailable"
              ? "This client does not support in-call confirmation forms, so nothing was purged."
              : "Purge cancelled; nothing was deleted.";

      return {
        content: [
          {
            type: "text" as const,
            text: message,
          },
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "prepare_full_fidelity_publish_session",
    {
      title: "Prepare a full-fidelity publish session",
      description:
        "Prepare and confirm a full-fidelity publish_session request using " +
        `${FULL_FIDELITY_PUBLICATION_CONTRACT_ID}.`,
    },
    () => ({
      description:
        "Checklist for preparing a confirmed publish_session request under " +
        `${FULL_FIDELITY_PUBLICATION_CONTRACT_ID}.`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST,
          },
        },
      ],
    }),
  );

  return server;
}

function requireDeleteSessionBackendClient(
  backendClient: ServerBackendClient,
): BackendDeleteSessionClient {
  if (typeof backendClient.deleteSession !== "function") {
    throw new Error("delete_session backend client is not configured");
  }
  return backendClient as BackendDeleteSessionClient;
}

function requireRestoreSessionBackendClient(
  backendClient: ServerBackendClient,
): BackendRestoreSessionClient {
  if (typeof backendClient.restoreSession !== "function") {
    throw new Error("restore_session backend client is not configured");
  }
  return backendClient as BackendRestoreSessionClient;
}

function requirePurgeSessionBackendClient(
  backendClient: ServerBackendClient,
): BackendPurgeSessionClient {
  if (typeof backendClient.purgeSession !== "function") {
    throw new Error("purge_session backend client is not configured");
  }
  return backendClient as BackendPurgeSessionClient;
}

function requirePurgeSessionsBackendClient(
  backendClient: ServerBackendClient,
): BackendPurgeSessionClient & BackendListTombstonedSessionsClient {
  if (typeof backendClient.purgeSession !== "function") {
    throw new Error("purge_sessions backend purge client is not configured");
  }
  if (typeof backendClient.listTombstonedSessions !== "function") {
    throw new Error("purge_sessions backend preview client is not configured");
  }
  return backendClient as BackendPurgeSessionClient & BackendListTombstonedSessionsClient;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// `process.argv[1]` is a Windows filesystem path, while `import.meta.url` is
// a file URL. Comparing the raw strings works on POSIX by accident but fails
// on Windows, causing the process to exit successfully before the MCP
// initialize handshake.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error: unknown) => {
    console.error("session-registry-mcp-server failed to start:", error);
    process.exit(1);
  });
}
