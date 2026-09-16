import { describe, expect, it } from "vitest";
import {
  RESUME_SAFETY_NOTICE_TEXT,
  createHmacAcknowledgmentTokenIssuer,
  type AcknowledgmentTokenSubject,
} from "../../src/notice/resumeSafetyNotice.js";

const SUBJECT: AcknowledgmentTokenSubject = { linkId: "link_1", blobKey: "bundle-key" };
const NOW = new Date("2026-09-08T00:00:00.000Z");
const ONE_MINUTE_MS = 60 * 1000;

describe("RESUME_SAFETY_NOTICE_TEXT", () => {
  it("Happy path: names the specific risk rather than generic caution language (R51)", () => {
    expect(RESUME_SAFETY_NOTICE_TEXT).toMatch(/tool-call history/i);
    expect(RESUME_SAFETY_NOTICE_TEXT).toMatch(/prompt-injection/i);
    expect(RESUME_SAFETY_NOTICE_TEXT).toMatch(/running someone else's code/i);
  });
});

describe("createHmacAcknowledgmentTokenIssuer", () => {
  it("Happy path: a freshly issued token verifies for the exact subject it was issued for", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);

    expect(issuer.verify(token, SUBJECT, NOW)).toBe(true);
    expect(issuer.verify(token, SUBJECT, NOW)).toBe(false);
  });

  it("issues distinct one-use attempts even for the same subject and instant", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const first = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    const second = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    expect(first).not.toBe(second);
    expect(issuer.verify(first, SUBJECT, NOW)).toBe(true);
    expect(issuer.verify(second, SUBJECT, NOW)).toBe(true);
  });

  it("binds the container and does not consume a token presented for the wrong subject", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const subject = { ...SUBJECT, containerName: "native-bundles" };
    const token = issuer.issue(subject, NOW, ONE_MINUTE_MS);
    expect(issuer.verify(token, { ...subject, containerName: "other" }, NOW)).toBe(false);
    expect(issuer.verify(token, subject, NOW)).toBe(true);
  });

  it("invalidates outstanding attempts after an issuer restart rather than allowing replay", () => {
    const before = createHmacAcknowledgmentTokenIssuer("test-secret");
    const token = before.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    const after = createHmacAcknowledgmentTokenIssuer("test-secret");
    expect(after.verify(token, SUBJECT, NOW)).toBe(false);
  });

  it("Happy path: a token remains valid up until (but not including) its expiry instant", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    const justBeforeExpiry = new Date(NOW.getTime() + ONE_MINUTE_MS - 1);

    expect(issuer.verify(token, SUBJECT, justBeforeExpiry)).toBe(true);
  });

  it("Edge case: a token is invalid once its expiry has passed, so it cannot be reused on a later download attempt (R50)", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    const afterExpiry = new Date(NOW.getTime() + ONE_MINUTE_MS + 1);

    expect(issuer.verify(token, SUBJECT, afterExpiry)).toBe(false);
  });

  it("Error path: a token issued for one link/blob is rejected for a different link or blob", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);

    expect(issuer.verify(token, { linkId: "link_2", blobKey: SUBJECT.blobKey }, NOW)).toBe(false);
    expect(issuer.verify(token, { linkId: SUBJECT.linkId, blobKey: "other-key" }, NOW)).toBe(false);
  });

  it("Error path: a token signed with a different secret is rejected", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");
    const otherIssuer = createHmacAcknowledgmentTokenIssuer("different-secret");
    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);

    expect(otherIssuer.verify(token, SUBJECT, NOW)).toBe(false);
  });

  it("Error path: a malformed or tampered token string is rejected without throwing", () => {
    const issuer = createHmacAcknowledgmentTokenIssuer("test-secret");

    expect(issuer.verify("not-a-real-token", SUBJECT, NOW)).toBe(false);
    expect(issuer.verify("", SUBJECT, NOW)).toBe(false);

    const token = issuer.issue(SUBJECT, NOW, ONE_MINUTE_MS);
    const tampered = `${token}x`;
    expect(issuer.verify(tampered, SUBJECT, NOW)).toBe(false);
  });
});
