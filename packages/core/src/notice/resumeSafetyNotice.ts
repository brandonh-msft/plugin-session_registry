/**
 * Static content and the acknowledgment-token mechanism for the resume
 * trust-and-safety notice (`NOTICE-R48`-`R54`).
 *
 * Two independent concerns live here, matching the origin document's
 * split between "what the notice must say" (R51) and "how the gate is
 * technically enforced against a client that skips the UI" (R50):
 *
 * - `RESUME_SAFETY_NOTICE_TEXT` is the one static, specific notice body
 *   every qualifying download must show — content that names the actual
 *   risk (untrusted agent state, prompt-injection-style exposure) rather
 *   than generic caution language, and that never varies by audience
 *   type, session attributes, or any risk flag (R51).
 * - The acknowledgment-token issuer binds one acknowledgment to one
 *   in-flight download attempt via a short-lived, signed, single-use
 *   token. Only random pending nonces and expirations are held in memory;
 *   no durable collaborator/session acknowledgment record is kept (R50, R53). This is a UX gate ensuring the
 *   collaborator affirmatively saw the warning before this specific
 *   download, not a technical control over the bundle's content itself.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RESUME_SAFETY_NOTICE_TEXT =
  "This archive includes a resumable session bundle containing another " +
  "person's prior agent session: their tool-call history, outputs, and " +
  "possibly instructions or tool-triggering content (untrusted agent " +
  "state). Importing or resuming it means your own agent instance will " +
  "process that content, which carries a prompt-injection-style risk. " +
  "Treat it with the same caution you would use running someone else's " +
  "code.";

/** Identifies exactly which download attempt an acknowledgment covers —
 * the link and the specific blob (the resumable bundle) being requested. */
export interface AcknowledgmentTokenSubject {
  readonly linkId: string;
  readonly blobKey: string;
  readonly containerName?: string;
}

export interface AcknowledgmentTokenIssuer {
  /** Issues a token scoped to `subject`, valid until `now + ttlMs`. */
  issue(subject: AcknowledgmentTokenSubject, now: Date, ttlMs: number): string;
  /** Verifies and consumes a currently-valid, unexpired acknowledgment
   * for exactly `subject` — a token issued for a different link or blob,
   * or one whose expiry has passed, is not valid (R50: "must not be
   * reused to skip the notice on a later download"). */
  verify(token: string, subject: AcknowledgmentTokenSubject, now: Date): boolean;
}

interface TokenPayload extends AcknowledgmentTokenSubject {
  readonly expiresAt: string;
  readonly nonce: string;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Pending nonce state is process-local and contains no session or viewer
 * identifiers. Restart/failover invalidates outstanding attempts; a fresh
 * notice is then required. A deployment with multiple API instances needs a
 * shared atomic nonce store or sticky routing before enabling this issuer there.
 */
export function createHmacAcknowledgmentTokenIssuer(secret: string): AcknowledgmentTokenIssuer {
  const pending = new Map<string, number>();
  function expire(now: Date): void {
    for (const [nonce, expiry] of pending) {
      if (expiry <= now.getTime()) pending.delete(nonce);
    }
  }
  function sign(payloadJson: string): string {
    return createHmac("sha256", secret).update(payloadJson).digest("base64url");
  }

  return {
    issue(subject, now, ttlMs) {
      expire(now);
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now.getTime())) {
        throw new Error("Acknowledgment lifetime and current time must be valid.");
      }
      if (pending.size >= 10_000) throw new Error("Too many pending download acknowledgments.");
      const nonce = randomBytes(32).toString("hex");
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const payload: TokenPayload = {
        ...subject,
        expiresAt,
        nonce,
      };
      const payloadJson = JSON.stringify(payload);
      const encodedPayload = base64UrlEncode(payloadJson);
      const signature = sign(payloadJson);
      pending.set(nonce, new Date(expiresAt).getTime());
      return `${encodedPayload}.${signature}`;
    },

    verify(token, subject, now) {
      expire(now);
      if (token.length > 16_384 || !Number.isFinite(now.getTime())) return false;
      const parts = token.split(".");
      if (parts.length !== 2) {
        return false;
      }
      const encodedPayload = parts[0]!;
      const signature = parts[1]!;
      const payloadJson = base64UrlDecode(encodedPayload);
      if (payloadJson === null) {
        return false;
      }

      const expectedSignature = sign(payloadJson);
      const signatureBuffer = Buffer.from(signature, "base64url");
      const expectedBuffer = Buffer.from(expectedSignature, "base64url");
      if (
        signatureBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(signatureBuffer, expectedBuffer)
      ) {
        return false;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        return false;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
          !("linkId" in payload) || !("blobKey" in payload) || !("nonce" in payload) || !("expiresAt" in payload) ||
          typeof payload.nonce !== "string" || typeof payload.expiresAt !== "string") return false;
      if (payload.linkId !== subject.linkId || payload.blobKey !== subject.blobKey ||
          ("containerName" in payload ? payload.containerName : undefined) !== subject.containerName) {
        return false;
      }
      const expiry = new Date(payload.expiresAt).getTime();
      if (!(expiry > now.getTime()) || pending.get(payload.nonce) !== expiry) return false;
      pending.delete(payload.nonce);
      return true;
    },
  };
}
