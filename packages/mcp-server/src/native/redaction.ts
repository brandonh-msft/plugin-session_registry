import { applyResolutions, scan, type NativeRedaction } from "@session-registry/core";
import { NativeCaptureError, isNativeObject, type NativeValue } from "./files.js";

const REDACTED = "[REDACTED]";
const PRIVATE_FIELDS = /^(?:authorization|proxy-authorization|password|passwd|secrets?|credentials?|token|(?:auth|api|session|access|refresh)[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|encrypted[_-]?(?:content|function[_-]?args)|reasoning[_-]?(?:opaque|text|blocks)|signature|system[_-]?prompt|developer[_-]?prompt|base[_-]?instructions|developer[_-]?instructions|system[_-]?message|developer[_-]?message|transformedContent|dynamic_tools|guardian_history|internal_chat_message_metadata_passthrough|_?raw|rawRequest|rawResponse|providerRequest|requestBody|env|environment)$/i;
const PRIVATE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "reasoning_text", "analysis"]);
const PRIVATE_EVENT_TYPES = new Set([
  "system.message", "assistant.reasoning", "assistant.reasoning_delta",
  "agent_reasoning_raw_content", "agent_reasoning_raw_content_delta",
  "turn_context", "world_state", "retained_context", "security_risk_score",
  "mcp.headers_refresh_required", "mcp.headers_refresh_completed",
  "mcp.oauth_required", "mcp.oauth_completed",
]);

function needsStructuredRedaction(value: NativeValue, depth = 0): boolean {
  if (depth > 100) throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Embedded native content is too deeply nested.");
  if (Array.isArray(value)) return value.some((item) => needsStructuredRedaction(item, depth + 1));
  if (!isNativeObject(value)) return false;
  if ((value.type === "user.message" && isNativeObject(value.data) &&
       typeof value.data.source === "string" && value.data.source.startsWith("skill-")) ||
      value.omittedReason !== undefined || (typeof value.mimeType === "string" && /^(image|audio|video)\//.test(value.mimeType))) {
    return true;
  }
  if (value.role === "system" || value.role === "developer" || value.channel === "analysis" ||
      value.isMeta === true || (typeof value.type === "string" &&
        (PRIVATE_EVENT_TYPES.has(value.type) || PRIVATE_BLOCK_TYPES.has(value.type) ||
         ["reasoning", "image", "image_url", "input_image", "audio", "input_audio", "document", "session.binary_asset"].includes(value.type)))) {
    return true;
  }
  return Object.entries(value).some(([key, item]) => PRIVATE_FIELDS.test(key) || needsStructuredRedaction(item, depth + 1));
}

export class NativeRedactor {
  readonly redactions: NativeRedaction[] = [];

  private record(source: string, category: string): string {
    if (this.redactions.length >= 10_000) {
      throw new NativeCaptureError("REDACTION_LIMIT", "Too many redactions for one review; publication was not prepared.");
    }
    this.redactions.push({ id: `r${this.redactions.length + 1}`, source, category });
    return REDACTED;
  }

  value(value: NativeValue, source: string, depth = 0): NativeValue {
    if (depth > 100) {
      throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A native record exceeds the supported nesting depth.");
    }
    if (typeof value === "string") return this.text(value, source, depth);
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new NativeCaptureError("UNSUPPORTED_SOURCE", "A native numeric value cannot be preserved without precision loss.");
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item, source, depth + 1));
    if (!isNativeObject(value)) return value;
    const hiddenInjection = value.type === "user.message" && isNativeObject(value.data) &&
      typeof value.data.source === "string" && value.data.source.startsWith("skill-");
    if (hiddenInjection || (typeof value.type === "string" && PRIVATE_EVENT_TYPES.has(value.type))) {
      this.record(source, "private-runtime-content");
      return {
        type: value.type ?? "redacted",
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
        ...(value.parentId === null || typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
        redacted: "private-runtime-content",
      };
    }
    if (value.isMeta === true && (value.type === "user" || value.type === "assistant" || value.type === "attachment")) {
      this.record(source, "hidden-context");
      return {
        type: value.type,
        ...(typeof value.uuid === "string" ? { uuid: value.uuid } : {}),
        ...(value.parentUuid === null || typeof value.parentUuid === "string" ? { parentUuid: value.parentUuid } : {}),
        redacted: "hidden-context",
      };
    }
    if (value.role === "system" || value.role === "developer" || value.channel === "analysis" ||
        (typeof value.type === "string" && PRIVATE_BLOCK_TYPES.has(value.type))) {
      this.record(source, "hidden-content");
      return { type: "redacted", reason: "hidden-content" };
    }
    if (value.type === "session.binary_asset" || value.omittedReason !== undefined ||
        (typeof value.mimeType === "string" && /^(image|audio|video)\//.test(value.mimeType))) {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A persisted binary asset is unavailable or cannot be safely scanned.");
    }
    if ((value.type === "image" || value.type === "image_url" || value.type === "input_image" ||
         value.type === "audio" || value.type === "input_audio" || value.type === "document") &&
        (value.source !== undefined || value.image_url !== undefined || value.audio_url !== undefined || value.data !== undefined)) {
      throw new NativeCaptureError("UNSCANNABLE_SOURCE", "A native record contains media that cannot be safely scanned; no partial archive was prepared.");
    }
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      (PRIVATE_FIELDS.test(key) || (value.type === "reasoning" && key === "content")) && item !== null
        ? this.record(source, "private-field")
        : this.value(item, source, depth + 1),
    ] as const);
    return Object.fromEntries(entries);
  }

  text(input: string, source: string, depth = 0): string {
    if (depth > 100) {
      throw new NativeCaptureError("UNSUPPORTED_SOURCE", "Embedded native content exceeds the supported nesting depth.");
    }
    let content = input;
    if (/^\s*[\[{]/.test(content)) {
      let embedded: unknown;
      try {
        embedded = JSON.parse(content);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if ((isNativeObject(embedded) || Array.isArray(embedded)) && needsStructuredRedaction(embedded)) {
        const before = this.redactions.length;
        const sanitized = this.value(embedded, source, depth + 1);
        if (this.redactions.length !== before) content = JSON.stringify(sanitized);
      } else if (embedded === undefined && content.includes("\n")) {
        content = content.split(/(\r?\n)/).map((part, index) =>
          index % 2 === 0 ? this.text(part, source, depth + 1) : part).join("");
      }
    }
    content = content.replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
      () => this.record(source, "private-key"),
    );
    content = content.replace(
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
      () => this.record(source, "authorization"),
    );
    content = content.replace(
      /\b[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|CLIENT_SECRET|SECRET_KEY)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      () => this.record(source, "credential-assignment"),
    );
    content = content.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return candidate;
      }
      return url.username || url.password ||
        [...url.searchParams.keys()].some((key) => /^(sig|signature|token|access_token|api_key|key|x-amz-signature)$/i.test(key))
        ? this.record(source, "credential-url")
        : candidate;
    });
    const result = scan(content);
    if (result.status !== "ok") {
      throw new NativeCaptureError("SCAN_FAILED", "Native content could not be scanned.");
    }
    const resolutions = result.findings.map((finding, findingIndex) => {
      this.record(source, finding.category);
      return { findingIndex, action: { kind: "accept-redaction" as const } };
    });
    return applyResolutions(content, result.findings, resolutions);
  }
}
