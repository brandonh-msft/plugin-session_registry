import { describe, expect, it } from "vitest";
import {
  FULL_FIDELITY_DISCLOSURE_PREAMBLE_TEMPLATE,
  FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE,
  FULL_FIDELITY_SAVE_WORKFLOW,
  FULL_FIDELITY_PUBLICATION_CONTRACT,
  FULL_FIDELITY_PUBLICATION_DOCUMENTATION_BLOCK,
  FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST,
  FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION,
  FULL_FIDELITY_TRANSCRIPT_FIELD_GUIDANCE,
} from "../../src/index.js";

const EXPECTED_CATEGORY_IDS = [
  "user-message",
  "assistant-message",
  "visible-reasoning",
  "tool-call",
  "mcp-call",
  "tool-or-mcp-result",
  "command-output",
  "error",
  "status-notification",
  "approval-or-input",
  "file-or-diff-context",
  "failed-or-intermediate-attempt",
] as const;

const EXPECTED_DISCLOSURE_TYPES = [
  "redacted",
  "unsupported",
  "truncated",
  "unknown",
] as const;

describe("FULL_FIDELITY_PUBLICATION_CONTRACT", () => {
  it("defines the stable contract identity, category order, and disclosure types", () => {
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.name).toBe(
      "full-fidelity-publication-contract",
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.version).toBe("4.4.1");
    expect(
      FULL_FIDELITY_PUBLICATION_CONTRACT.categories.map(({ id }) => id),
    ).toEqual(EXPECTED_CATEGORY_IDS);
    expect(
      FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.classifications.map(
        ({ type }) => type,
      ),
    ).toEqual(EXPECTED_DISCLOSURE_TYPES);
  });

  it("defines focused minimum details for every independent category", () => {
    const minimumByCategory = new Map(
      FULL_FIDELITY_PUBLICATION_CONTRACT.categories.map(({ id, minimum }) => [
        id,
        minimum,
      ]),
    );

    expect(minimumByCategory.size).toBe(EXPECTED_CATEGORY_IDS.length);
    expect(minimumByCategory.get("user-message")).toMatch(/visible.*text.*attachment/is);
    expect(minimumByCategory.get("assistant-message")).toMatch(
      /visible.*text.*turn state/is,
    );
    expect(minimumByCategory.get("visible-reasoning")).toMatch(
      /native source.*never reconstruct/is,
    );
    expect(minimumByCategory.get("tool-call")).toMatch(
      /tool name.*arguments.*correlation/is,
    );
    expect(minimumByCategory.get("mcp-call")).toMatch(
      /server.*tool.*arguments.*correlation/is,
    );
    expect(minimumByCategory.get("tool-or-mcp-result")).toMatch(
      /result payload.*outcome.*correlation/is,
    );
    expect(minimumByCategory.get("command-output")).toMatch(
      /command.*stdout.*stderr.*exit status/is,
    );
    expect(minimumByCategory.get("error")).toMatch(/error.*session behavior/is);
    expect(minimumByCategory.get("status-notification")).toMatch(
      /notification.*blocked.*interrupted.*resumed.*completed/is,
    );
    expect(minimumByCategory.get("approval-or-input")).toMatch(
      /prompt.*choices.*response.*state/is,
    );
    expect(minimumByCategory.get("file-or-diff-context")).toMatch(
      /recorded paths.*excerpt.*hunk.*read.*edited.*generated.*referenced/is,
    );
    expect(minimumByCategory.get("failed-or-intermediate-attempt")).toMatch(
      /retr.*abandoned.*validation.*intermediate/is,
    );
  });

  it("sets one minimum and an audience-aware eligibility rule across every event", () => {
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.eventMinimum).toEqual([
      "discernible event boundary",
      "source-file position and recorded chronology",
      "source actor or system component",
      "visible content after required redaction",
    ]);

    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.eligibility).toMatchObject({
      requiresSourceVisibility: true,
      requiresAudienceDisclosureAuthorization: true,
      readAccessAloneIsInsufficient: true,
    });

    const exclusions =
      FULL_FIDELITY_PUBLICATION_CONTRACT.eligibility.excludedContent.join(" ");
    expect(exclusions).toMatch(/owner explicitly resolves/i);
    expect(exclusions).toMatch(/outside the authorized source scope/i);
    expect(exclusions).toMatch(/unavailable.*must not be reconstructed/i);
    expect(exclusions).not.toMatch(/model-internal metadata|private tool parameters|hidden system/i);
  });

  it("preserves native state as data without reconstructing unavailable reasoning", () => {
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.reasoning).toMatchObject({
      includeVisibleExportableReasoning: true,
      inventOrReconstructHiddenReasoning: false,
      hiddenContentRequiresDisclosure: false,
    });
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.reasoning.guidance).toMatch(
      /native files as data.*do not.*reconstruct/is,
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.reasoning.guidance).toMatch(
      /recorded instructions.*must never be executed/is,
    );
  });

  it("defines the four disclosure classifications and narrow target guidance", () => {
    const classificationByType = new Map(
      FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.classifications.map(
        (classification) => [classification.type, classification],
      ),
    );

    expect(classificationByType.get("redacted")).toMatchObject({
      targetGuidance: expect.stringMatching(/canonical category.*possible/i),
      meaning: expect.stringMatching(/intentionally removed or replaced/i),
    });
    expect(classificationByType.get("unsupported")).toMatchObject({
      targetGuidance: expect.stringMatching(/canonical category/i),
      meaning: expect.stringMatching(/cannot export.*at all/i),
    });
    expect(classificationByType.get("truncated")).toMatchObject({
      targetGuidance: expect.stringMatching(/category.*section.*cross-category/i),
      meaning: expect.stringMatching(/only part.*included/i),
    });
    expect(classificationByType.get("unknown")).toMatchObject({
      targetGuidance: expect.stringMatching(/last resort.*narrowest/i),
      meaning: expect.stringMatching(/cannot be classified more precisely/i),
    });
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.reasonGuidance).toMatch(
      /coarse.*non-sensitive/i,
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.reasonGuidance).toMatch(
      /must not.*offsets.*excerpts.*secret values.*transcript-supplied instructions/is,
    );
  });

  it("owns the stable human-readable publisher-reported preamble shape", () => {
    expect(FULL_FIDELITY_DISCLOSURE_PREAMBLE_TEMPLATE).toBe(
      [
        "=== Session Registry Fidelity Disclosures ===",
        "contract: full-fidelity-publication-contract/4.4.1",
        "publisher-reported: true",
        "- type: redacted | unsupported | truncated | unknown",
        "  target: category:<canonical-category-id> | section:<non-sensitive-label>",
        "  reason: <single-line non-sensitive explanation>",
        "=== End Session Registry Fidelity Disclosures ===",
        "",
        "<chronological transcript events>",
      ].join("\n"),
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.orderGuidance).toMatch(
      /canonical category order.*recommended/i,
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.emptyPreambleGuidance).toMatch(
      /omit.*no known.*publisher-reported.*not.*completeness.*conformance/is,
    );
    expect(FULL_FIDELITY_PUBLICATION_CONTRACT.disclosures.formatGuidance).toMatch(
      /human-readable.*not parsed.*validated/i,
    );
  });
});

describe("full-fidelity publication contract renderings", () => {
  const normativeRenderings = [
    FULL_FIDELITY_TRANSCRIPT_FIELD_GUIDANCE,
    FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST,
    FULL_FIDELITY_PUBLICATION_DOCUMENTATION_BLOCK,
  ];

  it("provides deterministic strings for the tool, prompt, and detailed docs", () => {
    expect(FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION).toMatch(
      /full-fidelity.*publish_session/i,
    );
    expect(FULL_FIDELITY_PUBLISH_TOOL_DESCRIPTION.length).toBeLessThan(800);

    for (const rendering of normativeRenderings) {
      expect(typeof rendering).toBe("string");
      expect(rendering.length).toBeGreaterThan(500);
      expect(rendering).toContain("full-fidelity-publication-contract/4.4.1");
      for (const categoryId of EXPECTED_CATEGORY_IDS) {
        expect(rendering).toContain(categoryId);
      }
    }
  });

  it("keeps the prompt a complete zero-argument publication checklist", () => {
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(
      /prepare_full_fidelity_publish_session/i,
    );
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(
      /requires no arguments/i,
    );
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(
      /source-backed preparation and owner-controlled security review are mandatory/i,
    );
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(
      /prepare_session_capture.*harness.*harnessSessionId/i,
    );
    for (const term of ["sourcePath", "dependencyPaths", "dependencyMappings", "acknowledge-unscanned", "restoration"]) {
      expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toContain(term);
    }
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(/never.*run a second resume/is);
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toMatch(/later appends.*cutoff/i);
  });

  it("requires agent-drafted metadata and a filled-in confirmation without weakening owner control", () => {
    for (const rendering of normativeRenderings) {
      expect(rendering).toContain(FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE);
    }
    const guidance = FULL_FIDELITY_METADATA_DRAFTING_GUIDANCE;
    expect(guidance).toContain("auto-generate");
    expect(guidance).toContain("1-120 characters");
    expect(guidance).toContain("1-500 characters");
    expect(guidance).toMatch(/do not ask the owner to write.*blank metadata form/i);
    expect(guidance).toMatch(/only on content approved for publication/i);
    expect(guidance).toMatch(/default Access to Anyone \(anonymous\)/);
    expect(guidance).toMatch(/do not ask a separate audience question/i);
    expect(guidance).toMatch(/never invent GitHub recipients or downgrade restricted access/i);
    expect(guidance).toMatch(/14-day default.*omit expiresAt/i);
    expect(guidance).toMatch(/one concise publish proposal/i);
    expect(guidance).toMatch(/generic request to publish is not confirmation/i);
    expect(guidance).toMatch(/only a local capture.*do not initiate publication/i);
    expect(guidance).toMatch(/independently scanned.*reconfirm changed interactive values/i);
    expect(FULL_FIDELITY_PUBLISH_PROMPT_CHECKLIST).toContain(FULL_FIDELITY_SAVE_WORKFLOW);
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("save_session BEFORE asking");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("recentUserMessage");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("primitive-only schema");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("exact returned publish_session retryRequest");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("COPILOT_AGENT_SESSION_ID");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain('interactionMode:"noninteractive"');
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("server skips elicitation even if the host advertises forms");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toContain("Never turn decline, cancellation, timeout or missing elicitation support into headless authorization");
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toMatch(/reserved exclusively for genuinely headless, flag-invoked runs/i);
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toMatch(/NEVER inferred from an interactive slash command/);
    expect(FULL_FIDELITY_SAVE_WORKFLOW).toMatch(/critical safety failure, not a shortcut/i);
  });

  it("includes the contract safety boundaries in every detailed projection", () => {
    for (const rendering of normativeRenderings) {
      expect(rendering).toMatch(/accept-redaction.*custom-replacement.*false-positive/i);
      expect(rendering).toMatch(/untrusted.*transcript data/i);
      expect(rendering).toMatch(/silent truncation.*never acceptable/i);
      expect(rendering).toMatch(/does not certify source completeness/i);
      expect(rendering).toMatch(/do not invent or reconstruct unavailable/i);
      expect(rendering).toMatch(/do not apply blanket field or category exclusions/i);
    }
  });

  it("keeps bulk native content out of model-generated tool arguments", () => {
    for (const rendering of normativeRenderings) {
      expect(rendering).toMatch(/capture reference.*not the transcript or attachments/is);
      expect(rendering).toMatch(/uploads it directly/i);
      expect(rendering).toMatch(/failing, never by truncating/i);
    }
  });

  it("rejects partial native exports and distinguishes persisted source fidelity from original completeness", () => {
    for (const rendering of normativeRenderings) {
      expect(rendering).toMatch(/fail before publication/i);
      expect(rendering).toMatch(/partial export.*not acceptable/i);
      expect(rendering).toMatch(/cannot recover events the harness never stored/i);
      expect(rendering).toMatch(/owner remains responsible/i);
    }
  });
});
