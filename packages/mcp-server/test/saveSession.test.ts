import { appendFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestFormParamsSchema, ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  buildNativeSessionBundle,
  NATIVE_CLI_HARNESSES,
  NATIVE_HARNESSES,
  parseNativeSessionArchive,
  type AudiencePolicy,
} from "@session-registry/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { createNativeCaptureService } from "../src/native/captures.js";
import { PublishStateUnknownError } from "../src/httpBackendClient.js";
import { nativeFixture, SESSION_ID, writeRecords } from "./native/fixtures.js";
import type { PublishSubmission } from "../src/tools/publish.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

function accepted(request: ElicitRequest): ElicitResult {
  const params = ElicitRequestFormParamsSchema.parse(request.params);
  const properties = params.requestedSchema.properties;
  if ("decision" in properties) return { action: "accept", content: { decision: "redact-all" } };
  if ("redact" in properties) return { action: "accept", content: { redact: true } };
  if ("confirmPublish" in properties && !("title" in properties)) {
    return { action: "accept", content: { confirmPublish: true } };
  }
  return { action: "accept", content: {
    title: "default" in properties.title! ? properties.title.default : "",
    summary: "default" in properties.summary! ? properties.summary.default : "",
    audience: "default" in properties.audience! ? properties.audience.default : "",
    expiration: "default" in properties.expiration! ? properties.expiration.default : "",
    additionalRedactions: "default" in properties.additionalRedactions! ? properties.additionalRedactions.default : "",
  } };
}

async function setup(
  harness: typeof NATIVE_HARNESSES[number],
  confirm?: (request: ElicitRequest) => ElicitResult,
  failPublish = false,
) {
  const fixture = await nativeFixture(harness);
  directories.push(fixture.root);
  const submissions: PublishSubmission[] = [];
  const audiences: AudiencePolicy[] = [];
  const expirations: (Date | null | undefined)[] = [];
  const server = createServer({
    async submitAndCreateLink(submission, share) {
      submissions.push(submission);
      audiences.push(share.audiencePolicy);
      expirations.push(share.expiresAt);
      if (failPublish) throw new PublishStateUnknownError("Synthetic lost publish response");
      return { sessionId: "published", harnessSessionId: submission.harnessSessionId, linkId: "link",
        shareUrl: `https://example.invalid/session/${submission.harnessSessionId}/link`, idempotentReplay: false };
    },
  }, createNativeCaptureService(fixture.options));
  const client = new Client({ name: "save-session-conformance", version: "1" }, {
    capabilities: confirm === undefined ? {} : { elicitation: { form: {} } },
  });
  const confirmations: ElicitRequest[] = [];
  if (confirm) client.setRequestHandler(ElicitRequestSchema, (request) => {
    expect(submissions).toHaveLength(0);
    ElicitRequestFormParamsSchema.parse(request.params);
    confirmations.push(request);
    return confirm(request);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { fixture, client, submissions, audiences, expirations, confirmations,
    draft: { harness, interactionMode: "interactive", sourcePath: fixture.primary, title: "Repair missing fixture", summary: "Investigated a failing tool run and prepared the corrected fixture." },
    async close() { await client.close(); if (server.isConnected()) await server.close(); },
  };
}

describe("save-session MCP workflow", () => {
  it("reproduces the black-holes save with no known UUID or path and distinct confirmations", async () => {
    const run = await setup("github-copilot-cli", accepted);
    try {
      const records = [
        { type: "session.start", data: { sessionId: SESSION_ID, version: 1, copilotVersion: "1.0.84-4", context: { cwd: run.fixture.root } } },
        { type: "user.message", data: { content: "tell me about black holes" } },
        { type: "assistant.message", data: { content: "Black holes have event horizons. Accretion disks emit X-rays and visible light." } },
        { type: "user.message", data: { content: "save this sessionj" } },
      ];
      await writeRecords(run.fixture.primary, records);
      const result = await run.client.callTool({
        name: "save_session", arguments: {
          harness: "github-copilot-cli", interactionMode: "interactive", workingDirectory: run.fixture.root,
          recentUserMessage: "tell me about black holes",
          title: "Black holes explained",
          summary: "Explained event horizons and radiation from accretion disks.",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.submissions[0]?.harnessSessionId).toBe(SESSION_ID);
      const native = parseNativeSessionArchive(run.submissions[0]!.transcript);
      expect(native?.files[0]?.content).toBe(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    } finally { await run.close(); }
  });

  it.each(NATIVE_CLI_HARNESSES)("saves %s in one call without asking for an ID, blank metadata, access or date", async (harness) => {
    const run = await setup(harness, accepted);
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`https://example.invalid/session/${SESSION_ID}/link`) });
      // The metadata form (once) and the recap-and-confirm form (once); no
      // scanner findings exist in this fixture, so the secret-decision gate
      // never runs.
      expect(run.confirmations).toHaveLength(2);
      const form = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      expect(form.message).toContain("Anyone (anonymous)");
      expect(form.message).toContain("14 days (default)");
      expect(form.requestedSchema.properties.title).toMatchObject({ type: "string", default: run.draft.title });
      expect(form.requestedSchema.properties.summary).toMatchObject({ type: "string", default: run.draft.summary });
      expect(form.requestedSchema.properties.audience).toMatchObject({ type: "string", default: "anyone" });
      expect(form.requestedSchema.properties.expiration).toMatchObject({ type: "string", default: "14 days" });
      expect(Object.keys(form.requestedSchema.properties)).toEqual([
        "title", "summary", "audience", "expiration", "additionalRedactions",
      ]);
      // additionalRedactions is intentionally optional: the owner must be
      // able to submit blank text to mean "nothing else to redact" without
      // the host blocking submission.
      expect(form.requestedSchema.required).toEqual([
        "title", "summary", "audience", "expiration",
      ]);
      const recap = ElicitRequestFormParamsSchema.parse(run.confirmations[1]!.params);
      expect(Object.keys(recap.requestedSchema.properties)).toEqual(["confirmPublish"]);
      expect(recap.requestedSchema.required).toEqual(["confirmPublish"]);
      expect(run.audiences).toEqual([{ accessMode: "anonymous" }]);
      expect(run.submissions[0]).toMatchObject({ title: run.draft.title, summary: run.draft.summary, harnessSessionId: SESSION_ID });
      expect(parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.recordCount).toBe(run.fixture.records.length);
    } finally { await run.close(); }
  });

  it("truncates an over-length auto-generated summary instead of hard-rejecting the save", async () => {
    const run = await setup("github-copilot-cli", accepted);
    try {
      const overlongSummary = "S".repeat(650);
      const result = await run.client.callTool({
        name: "save_session",
        arguments: { ...run.draft, summary: overlongSummary },
      });
      expect(result.isError).not.toBe(true);
      const form = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      const formSummaryDefault = form.requestedSchema.properties.summary?.default;
      expect(typeof formSummaryDefault).toBe("string");
      expect((formSummaryDefault as string).length).toBeLessThanOrEqual(500);
      expect(formSummaryDefault).toMatch(/\.\.\.$/);
      expect(form.message).toContain("shortened to fit the character limit");
      expect(run.submissions[0]?.summary.length).toBeLessThanOrEqual(500);
      expect(run.submissions[0]?.summary).toMatch(/\.\.\.$/);
    } finally { await run.close(); }
  });

  it("truncates an over-length noninteractive summary and reports it instead of failing", async () => {
    const run = await setup("github-copilot-cli");
    try {
      const overlongSummary = "T".repeat(650);
      const result = await run.client.callTool({
        name: "save_session",
        arguments: { ...run.draft, interactionMode: "noninteractive", summary: overlongSummary },
      });
      expect(result.isError).not.toBe(true);
      expect(run.submissions[0]?.summary.length).toBeLessThanOrEqual(500);
      expect(run.submissions[0]?.summary).toMatch(/\.\.\.$/);
      expect(JSON.stringify(result)).toContain("metadataTruncated");
    } finally { await run.close(); }
  });

  it("rejects a save_session call whose summary exceeds the wider MCP schema ceiling", async () => {
    const run = await setup("github-copilot-cli", accepted);
    try {
      const result = await run.client.callTool({
        name: "save_session",
        arguments: { ...run.draft, summary: "U".repeat(2_000) },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Too big");
    } finally { await run.close(); }
  });

  it("preserves explicit restricted access without putting nested audience schemas in elicitation", async () => {
    const run = await setup("github-copilot-cli", accepted);
    const audiencePolicy = { accessMode: "authenticated" as const, rules: [{ type: "specific-users" as const, githubLogins: ["reviewer"] }] };
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: { ...run.draft, audiencePolicy, expiresAt: null } });
      expect(result.isError).not.toBe(true);
      expect(run.audiences).toEqual([audiencePolicy]);
      const form = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      expect(form.message).toContain("Restricted:");
      expect(form.message).toContain("No expiration");
      expect(form.requestedSchema.properties.audience).toMatchObject({ type: "string", default: "users:reviewer" });
      expect(form.requestedSchema.properties.expiration).toMatchObject({ type: "string", default: "never" });
      const receipt = result.content[1];
      if (receipt?.type !== "text") throw new Error("Expected publication receipt");
      expect(JSON.parse(receipt.text)).toMatchObject({
        publicationSettings: {
          audience: "users:reviewer",
          audiencePolicy,
          expiration: null,
          ownerRequestedRedactionCount: 0,
        },
      });
    } finally { await run.close(); }
  });

  it.each(["cancel", "decline", "no-confirm"] as const)("does not upload after %s", async (action) => {
    const run = await setup("github-copilot-cli", (request) => action === "cancel" || action === "decline"
      ? { action } : { action: "accept", content: { ...accepted(request).content,
        ...("confirmPublish" in ElicitRequestFormParamsSchema.parse(request.params).requestedSchema.properties
          ? { confirmPublish: false } : {}) } });
    try {
      await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it.each(NATIVE_CLI_HARNESSES)("publishes %s headlessly without invoking advertised but unavailable elicitation", async (harness) => {
    const run = await setup(harness, () => { throw new Error("A headless host has no elicitation consumer"); });
    try {
      const before = Date.now();
      const result = await run.client.callTool({ name: "save_session", arguments: { ...run.draft, interactionMode: "noninteractive" } });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(0);
      expect(run.submissions).toHaveLength(1);
      expect(run.audiences).toEqual([{ accessMode: "anonymous" }]);
      expect(run.expirations[0]?.getTime()).toBeGreaterThanOrEqual(before + 14 * 86_400_000);
      expect(run.expirations[0]?.getTime()).toBeLessThanOrEqual(Date.now() + 14 * 86_400_000);
      expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining('"interactionMode":"noninteractive"') });
      expect(JSON.stringify(result)).toContain("Automated security detection is incomplete");
    } finally { await run.close(); }
  });

  it("honors prompt-specified metadata, restricted access and no expiry in a headless host without forms", async () => {
    const run = await setup("github-copilot-cli");
    const audiencePolicy = { accessMode: "authenticated" as const, rules: [{ type: "organization" as const, githubOrg: "example" }] };
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...run.draft, interactionMode: "noninteractive", title: "Prompt title", summary: "Prompt summary", audiencePolicy, expiresAt: null,
      } });
      expect(result.isError).not.toBe(true);
      expect(run.submissions[0]).toMatchObject({ title: "Prompt title", summary: "Prompt summary" });
      expect(run.audiences).toEqual([audiencePolicy]);
      expect(run.expirations).toEqual([null]);
    } finally { await run.close(); }
  });

  it("applies owner-requested redactions that were not detected as secrets", async () => {
    const run = await setup("github-copilot-cli");
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message",
      data: { content: "Private handle Hurlburb and lowercase hurlburb must not be shared." },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...run.draft,
        interactionMode: "noninteractive",
        title: "Hurlburb publication",
        summary: "Publish a session while redacting every hurlburb reference.",
        ownerRedactions: [{ exactText: "hurlburb" }],
      } });
      expect(result.isError).not.toBe(true);
      expect(run.submissions[0]).toMatchObject({
        title: "[REDACTED] publication",
        summary: "Publish a session while redacting every [REDACTED] reference.",
      });
      const published = parseNativeSessionArchive(run.submissions[0]!.transcript);
      expect(published?.files[0]?.content).not.toMatch(/hurlburb/i);
      expect(published?.files[0]?.content).toContain("[REDACTED]");
      expect(published?.redactions.some((redaction) => redaction.category === "owner-requested")).toBe(true);
      expect(Buffer.from(buildNativeSessionBundle(published!)).toString("utf8")).not.toMatch(/hurlburb/i);
    } finally { await run.close(); }
  });

  it("asks for and applies owner redactions after scanner findings are accepted", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      const answer = accepted(request);
      if (calls === 2) {
        return { ...answer, content: {
          ...answer.content,
          additionalRedactions: "private-handle -> [PRIVATE]",
        } };
      }
      return answer;
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message", data: { content: `Do not publish private-handle or ${token}.` },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      // Secret-decision gate (redact-all), the one-shot metadata form (with
      // the additional redaction typed in), and the final recap-confirm.
      expect(run.confirmations).toHaveLength(3);
      const decisionForm = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      expect(decisionForm.message).toContain("The scanner found 1 likely secret");
      expect(parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content).toContain("[PRIVATE]");
      expect(parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content).toContain("[REDACTED]");
      expect(parseNativeSessionArchive(run.submissions[0]!.transcript)?.redactions
        .some((redaction) => redaction.category === "owner-requested")).toBe(true);
      const receipt = result.content[1];
      if (receipt?.type !== "text") throw new Error("Expected publication receipt");
      expect(JSON.parse(receipt.text)).toMatchObject({
        publicationSettings: {
          audience: "anyone",
          ownerRequestedRedactionCount: 1,
          appliedRedactionCount: 2,
        },
      });
      expect(receipt.text).not.toContain("private-handle");
    } finally { await run.close(); }
  });

  it("redacts a single finding with the default placeholder via review-each, showing a masked preview", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2) return { action: "accept", content: { decision: "redact-default" } };
      return accepted(request);
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({ type: "assistant.message", data: { content: `Token ${token}.` } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      // Secret-decision gate (review-each), the per-finding form, the
      // metadata form, and the final recap-confirm.
      expect(run.confirmations).toHaveLength(4);
      const perFinding = ElicitRequestFormParamsSchema.parse(run.confirmations[1]!.params);
      expect(perFinding.message).toContain("Detected value preview:");
      expect(perFinding.message).not.toContain(token);
      expect(perFinding.message).not.toContain("Proposed replacement");
      expect(Object.keys(perFinding.requestedSchema.properties)).toEqual(["decision"]);
      const content = parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content;
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(token);
    } finally { await run.close(); }
  });

  it("keeps a finding unredacted when the owner chooses No via review-each", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2) return { action: "accept", content: { decision: "keep" } };
      return accepted(request);
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({ type: "assistant.message", data: { content: `Token ${token}.` } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(4);
      const content = parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content;
      expect(content).toContain(token);
    } finally { await run.close(); }
  });

  it("redacts a finding with owner-supplied custom text via the redact-custom follow-up form", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2) return { action: "accept", content: { decision: "redact-custom" } };
      if (calls === 3) return { action: "accept", content: { replacementText: "[MY-CUSTOM-TEXT]" } };
      return accepted(request);
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({ type: "assistant.message", data: { content: `Token ${token}.` } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      // Secret-decision gate, the per-finding form, the custom-replacement
      // follow-up form, the metadata form, and the recap-confirm.
      expect(run.confirmations).toHaveLength(5);
      const followUp = ElicitRequestFormParamsSchema.parse(run.confirmations[2]!.params);
      expect(followUp.message).toContain("Custom replacement for finding 1 of 1");
      expect(Object.keys(followUp.requestedSchema.properties)).toEqual(["replacementText"]);
      const content = parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content;
      expect(content).toContain("[MY-CUSTOM-TEXT]");
      expect(content).not.toContain(token);
    } finally { await run.close(); }
  });

  it("rejects a blank redact-custom replacement instead of silently defaulting", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2) return { action: "accept", content: { decision: "redact-custom" } };
      if (calls === 3) return { action: "accept", content: { replacementText: "   " } };
      return accepted(request);
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({ type: "assistant.message", data: { content: `Token ${token}.` } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).toBe(true);
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it("caps the itemized preview list in the bulk secret-decision form for large finding sets", async () => {
    const tokens = Array.from({ length: 12 }, (_, index) => `ghp_${index.toString().padStart(2, "0")}${"x".repeat(34)}`);
    const run = await setup("github-copilot-cli", accepted);
    await appendFile(run.fixture.primary, JSON.stringify({ type: "assistant.message", data: { content: tokens.join(" ") } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      const decisionForm = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      expect(decisionForm.message).toContain("The scanner found 12 likely secrets");
      expect(decisionForm.message).toContain("10. [");
      expect(decisionForm.message).not.toContain("11. [");
      expect(decisionForm.message).toContain("...and 2 more.");
    } finally { await run.close(); }
  });

  it("reports a repeated secret value once in the bulk decision form, noting how many places it appears", async () => {
    const token = `ghp_${"x".repeat(36)}`;
    const run = await setup("github-copilot-cli", accepted);
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message", data: { content: `First: ${token}. Second: ${token}. Third: ${token}.` },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      const decisionForm = ElicitRequestFormParamsSchema.parse(run.confirmations[0]!.params);
      expect(decisionForm.message).toContain("3 likely secrets (1 unique value)");
      expect(decisionForm.message).toContain("(appears in 3 places)");
      // Only one itemized line, not three.
      expect(decisionForm.message).not.toContain("2. [");
    } finally { await run.close(); }
  });

  it("asks once per unique value via review-each and applies the same decision to every occurrence", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2) return { action: "accept", content: { decision: "redact-default" } };
      return accepted(request);
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message", data: { content: `First: ${token}. Second: ${token}.` },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      // Secret-decision gate (review-each), exactly one per-finding form
      // (not two), the metadata form, and the recap-confirm.
      expect(run.confirmations).toHaveLength(4);
      const perFinding = ElicitRequestFormParamsSchema.parse(run.confirmations[1]!.params);
      expect(perFinding.message).toContain("Finding 1 of 1 unique value");
      expect(perFinding.message).toContain("This exact value appears in 2 places; your decision applies to all of them.");
      const content = parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content;
      expect(content).not.toContain(token);
      expect(content?.match(/\[REDACTED\]/g)).toHaveLength(2);
    } finally { await run.close(); }
  });

  it("treats case-different values as distinct secrets to review separately", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      if (calls === 1) return { action: "accept", content: { decision: "review-each" } };
      if (calls === 2 || calls === 3) return { action: "accept", content: { decision: "redact-default" } };
      return accepted(request);
    });
    const lower = `ghp_${"x".repeat(36)}`;
    const upper = `ghp_${"X".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message", data: { content: `First: ${lower}. Second: ${upper}.` },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      // Two distinct per-finding forms (case-sensitive), plus the gate,
      // metadata, and recap forms.
      expect(run.confirmations).toHaveLength(5);
    } finally { await run.close(); }
  });

  it("submits successfully with a blank additional-redactions answer, applying zero owner redactions", async () => {
    const run = await setup("github-copilot-cli", (request) => {
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      const properties = params.requestedSchema.properties;
      if ("title" in properties) {
        return { action: "accept", content: {
          title: "default" in properties.title! ? properties.title.default : "",
          summary: "default" in properties.summary! ? properties.summary.default : "",
          audience: "default" in properties.audience! ? properties.audience.default : "",
          expiration: "default" in properties.expiration! ? properties.expiration.default : "",
          additionalRedactions: "",
        } };
      }
      return accepted(request);
    });
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations[0]!.params.requestedSchema.required).not.toContain("additionalRedactions");
      const receipt = result.content[1];
      if (receipt?.type !== "text") throw new Error("Expected publication receipt");
      expect(JSON.parse(receipt.text)).toMatchObject({ publicationSettings: { ownerRequestedRedactionCount: 0 } });
    } finally { await run.close(); }
  });

  it("parses multiple plain-text redaction lines without requiring JSON", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      calls++;
      const answer = accepted(request);
      if (calls === 2) {
        return { ...answer, content: {
          ...answer.content,
          additionalRedactions: "\nalpha-secret\nbeta-name -> [BETA]\n\n  gamma-token  \n",
        } };
      }
      return answer;
    });
    const token = `ghp_${"x".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({
      type: "assistant.message", data: { content: `alpha-secret, beta-name, gamma-token, and ${token} must all disappear.` },
    }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(3);
      const content = parseNativeSessionArchive(run.submissions[0]!.transcript)?.files[0]?.content;
      expect(content).toContain("[REDACTED]");
      expect(content).toContain("[BETA]");
      expect(content).not.toMatch(/alpha-secret|beta-name|gamma-token/i);
    } finally { await run.close(); }
  });

  it.each(["source", "metadata"])("blocks unresolved %s secrets in headless mode instead of silently redacting or approving them", async (location) => {
    const run = await setup("github-copilot-cli");
    const token = `ghp_${"q".repeat(36)}`;
    if (location === "source") await appendFile(run.fixture.primary, JSON.stringify({ type: "tool.execution_complete", data: { output: token } }) + "\n");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...run.draft, interactionMode: "noninteractive", ...(location === "metadata" ? { title: token } : {}),
      } });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"status":"review-required"') });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it("applies and reconfirms interactive audience and expiry edits with no nested schema", async () => {
    let calls = 0;
    const run = await setup("github-copilot-cli", (request) => {
      const answer = accepted(request);
      return ++calls === 1 ? { ...answer, content: {
        ...answer.content, audience: "users:reviewer; org:example; team:example/reviewers; repo:example/project:write", expiration: "7 days",
      } } : answer;
    });
    try {
      const before = Date.now();
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.audiences).toEqual([{ accessMode: "authenticated", rules: [
        { type: "specific-users", githubLogins: ["reviewer"] },
        { type: "organization", githubOrg: "example" },
        { type: "team", githubOrg: "example", teamSlug: "reviewers" },
        { type: "repo-collaborators", repoOwner: "example", repoName: "project", minPermission: "write" },
      ] }]);
      expect(run.expirations[0]?.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
      expect(run.expirations[0]?.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    } finally { await run.close(); }
  });

  it.each([
    { audience: "users:" }, { audience: "users:alice,,bob" }, { audience: "anyone; org:example" },
    { audience: "repo:example/project:superuser" }, { expiration: "not a date" }, { expiration: "2020-01-01T00:00:00Z" },
  ])("rejects invalid interactive settings %j without publishing or defaulting", async (edit) => {
    const run = await setup("github-copilot-cli", (request) => ({ action: "accept", content: { ...accepted(request).content, ...edit } }));
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).toBe(true);
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it("publishes an accepted edited restricted proposal without a second questionnaire", async () => {
    const run = await setup("github-copilot-cli", (request) => ({ action: "accept", content: {
      ...accepted(request).content, audience: "org:example", expiration: "never",
    } }));
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.audiences).toEqual([{ accessMode: "authenticated", rules: [
        { type: "organization", githubOrg: "example" },
      ] }]);
      expect(run.expirations).toEqual([null]);
    } finally { await run.close(); }
  });

  it("cancels cleanly when the owner declines the recap after editing metadata", async () => {
    const run = await setup("github-copilot-cli", (request) => {
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      if ("confirmPublish" in params.requestedSchema.properties) {
        return { action: "accept", content: { confirmPublish: false } };
      }
      return { action: "accept", content: { ...accepted(request).content, title: "Edited title", audience: "users:reviewer", expiration: "never" } };
    });
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected a cancellation notice");
      // A working confirm handler that actively declines the recap is a clean
      // cancel, not a confirmation-required round trip: only a client that
      // cannot answer at all (no elicitation capability) gets that.
      expect(JSON.parse(block.text)).toMatchObject({ status: "cancelled" });
      expect(run.confirmations).toHaveLength(2);
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it("rescans edited metadata against the same immutable capture without a second questionnaire", async () => {
    let first = true;
    const run = await setup("github-copilot-cli", (request) => {
      const answer = accepted(request);
      if (!first) return answer;
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      if (!("title" in params.requestedSchema.properties)) return answer;
      first = false;
      return { action: "accept", content: { ...answer.content, title: "Owner-edited title" } };
    });
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.submissions[0]?.title).toBe("Owner-edited title");
    } finally { await run.close(); }
  });

  it("blocks newly introduced metadata secrets instead of publishing the accepted form", async () => {
    const secret = `ghp_${"x".repeat(36)}`;
    const run = await setup("github-copilot-cli", (request) => ({ action: "accept", content: {
      ...accepted(request).content, summary: `token ${secret}`,
    } }));
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"status":"review-required"') });
      expect(run.submissions).toEqual([]);
      expect(run.confirmations).toHaveLength(1);
      // The full secret must never appear verbatim; only a masked partial
      // preview (a handful of chars at each end) is allowed to surface.
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain("maskedPreview");
    } finally { await run.close(); }
  });

  it("publishes approved metadata redactions without replaying stale finding IDs", async () => {
    const run = await setup("github-copilot-cli", accepted);
    const firstToken = `ghp_${"x".repeat(36)}`;
    const secondToken = `ghp_${"y".repeat(36)}`;
    const request = { ...run.draft, summary: `Remove ${firstToken}; retain fixture value ${secondToken}.` };
    try {
      const first = await run.client.callTool({ name: "save_session", arguments: request });
      const block = first.content[0];
      if (block?.type !== "text") throw new Error("Expected metadata findings");
      const pending = JSON.parse(block.text);
      expect(pending.status).toBe("review-required");
      expect(pending.findings).toHaveLength(2);
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...request, captureId: pending.captureId,
        resolutions: pending.findings.map((finding: { id: string }, index: number) => ({
          findingId: finding.id, action: { kind: index === 0 ? "accept-redaction" : "false-positive" },
        })),
      } });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.submissions).toHaveLength(1);
      expect(run.submissions[0]?.summary).toBe(`Remove [REDACTED]; retain fixture value ${secondToken}.`);
      expect(JSON.stringify(run.submissions)).not.toContain(firstToken);
    } finally { await run.close(); }
  });

  it("preserves source resolutions when metadata redaction produces a new draft revision", async () => {
    const run = await setup("github-copilot-cli", accepted);
    const token = `ghp_${"z".repeat(36)}`;
    await appendFile(run.fixture.primary, JSON.stringify({ type: "tool.execution_complete", data: { output: token } }) + "\n");
    try {
      const request = { ...run.draft, title: `Token ${token}` };
      // The source-embedded token is auto-resolved by the secret-decision
      // gate on this first call (accepted() answers "redact-all"); only the
      // title-embedded metadata finding survives to require a fresh captureId.
      const first = await run.client.callTool({ name: "save_session", arguments: request });
      const block = first.content[0];
      if (block?.type !== "text") throw new Error("Expected the surviving metadata finding");
      const pending = JSON.parse(block.text);
      expect(pending.status).toBe("review-required");
      expect(pending.findings).toHaveLength(1);
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...request, captureId: pending.captureId,
        resolutions: pending.findings.map((finding: { id: string }) => ({ findingId: finding.id, action: { kind: "accept-redaction" } })),
      } });
      expect(result.isError).not.toBe(true);
      expect(run.submissions).toHaveLength(1);
      expect(run.submissions[0]?.title).toBe("Token [REDACTED]");
      expect(run.submissions[0]?.transcript).toContain("[REDACTED]");
      expect(JSON.stringify(run.submissions)).not.toContain(token);
    } finally { await run.close(); }
  });

  it("drops metadata-only resolutions when the owner edits away the resolved finding", async () => {
    const run = await setup("github-copilot-cli", (request) => {
      const params = ElicitRequestFormParamsSchema.parse(request.params);
      if ("title" in params.requestedSchema.properties) {
        return { action: "accept", content: { ...accepted(request).content, title: "Clean owner-edited title" } };
      }
      return accepted(request);
    });
    try {
      const request = { ...run.draft, title: `Fixture ghp_${"w".repeat(36)}` };
      const first = await run.client.callTool({ name: "save_session", arguments: request });
      const block = first.content[0];
      if (block?.type !== "text") throw new Error("Expected metadata finding");
      const pending = JSON.parse(block.text);
      const result = await run.client.callTool({ name: "save_session", arguments: {
        ...request, captureId: pending.captureId,
        resolutions: [{ findingId: pending.findings[0].id, action: { kind: "false-positive" } }],
      } });
      expect(result.isError).not.toBe(true);
      expect(run.confirmations).toHaveLength(2);
      expect(run.submissions[0]?.title).toBe("Clean owner-edited title");
    } finally { await run.close(); }
  });

  it("rejects a stale captureId once the underlying source has changed instead of reusing it", async () => {
    const run = await setup("github-copilot-cli");
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Expected pending proposal");
      const pending = JSON.parse(block.text);
      expect(pending.status).toBe("confirmation-required");
      expect(pending.captureId).toMatch(/^[a-f0-9]{64}$/);
      expect(pending.proposal.title).toBe(run.draft.title);
      ElicitRequestFormParamsSchema.parse(pending.confirmation);
      await appendFile(run.fixture.primary, '{"type":"session.info","data":{"message":"later"}}\n');
      const retry = await run.client.callTool({ name: "save_session", arguments: { ...run.draft, captureId: pending.captureId } });
      expect(retry.isError).toBe(true);
      expect(JSON.stringify(retry)).toContain("CAPTURE_CHANGED");
      expect(run.submissions).toEqual([]);
    } finally { await run.close(); }
  });

  it("returns capture-bound retry guidance after an unknown publication outcome", async () => {
    const run = await setup("github-copilot-cli", accepted, true);
    try {
      const result = await run.client.callTool({ name: "save_session", arguments: run.draft });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("PUBLISH STATE UNKNOWN");
      expect(JSON.stringify(result)).toContain("Retry publish_session");
      const retryBlock = result.content.at(-1);
      if (retryBlock?.type !== "text") throw new Error("Expected exact retry request");
      const retry = JSON.parse(retryBlock.text).retryRequest;
      expect(retry.captureId).toMatch(/^[a-f0-9]{64}$/);
      expect(retry.title).toBe(run.draft.title);
      expect(retry.resolutions[0].action.kind).toBe("acknowledge-unscanned");
      expect(retry.confirmed).toBe(true);
      expect(run.submissions).toHaveLength(1);
    } finally { await run.close(); }
  });
});
