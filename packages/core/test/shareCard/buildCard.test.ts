import { describe, expect, it } from "vitest";
import { buildShareCard, type ShareCardInput } from "../../src/shareCard/buildCard.js";

const BASE_INPUT: ShareCardInput = {
  linkAvailable: true,
  linkUrl: "https://registry.example.com/session/link_1",
  title: "Fix flaky retry test",
  summary: "Diagnosed and fixed a flaky integration test in the retry queue.",
  harness: { name: "copilot-cli" },
  resumableBundleAvailable: false,
};

describe("buildShareCard", () => {
  it("Happy path: an active link with a resumable bundle includes the resume CTA", () => {
    const result = buildShareCard({ ...BASE_INPUT, resumableBundleAvailable: true });

    expect(result.kind).toBe("available");
    if (result.kind === "available") {
      expect(result.markdown).toContain("Fix flaky retry test");
      expect(result.markdown).toContain("Diagnosed and fixed a flaky integration test in the retry queue.");
      expect(result.markdown).toContain("[View this session](https://registry.example.com/session/link_1)");
      expect(result.markdown).toContain("[Download & resume in copilot-cli](https://registry.example.com/session/link_1)");
    }
  });

  it("Happy path: an active link without a resumable bundle omits the CTA entirely", () => {
    const result = buildShareCard({ ...BASE_INPUT, resumableBundleAvailable: false });

    expect(result.kind).toBe("available");
    if (result.kind === "available") {
      expect(result.markdown).not.toContain("Download & resume");
    }
  });

  it("Edge case: rebuilding the card with an edited title/summary reflects the new values on the next call, independent of any prior result", () => {
    const original = buildShareCard(BASE_INPUT);
    const edited = buildShareCard({ ...BASE_INPUT, title: "Updated title", summary: "Updated summary." });

    expect(original.kind).toBe("available");
    expect(edited.kind).toBe("available");
    if (original.kind === "available" && edited.kind === "available") {
      expect(original.markdown).toContain("Fix flaky retry test");
      expect(edited.markdown).toContain("Updated title");
      expect(edited.markdown).toContain("Updated summary.");
      // The earlier result object is never mutated by a later call.
      expect(original.markdown).toContain("Fix flaky retry test");
    }
  });

  it("Error path: an unavailable (revoked/expired/content-blocked) link returns unavailable with no Markdown to copy", () => {
    const result = buildShareCard({ ...BASE_INPUT, linkAvailable: false });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("Integration: the rendered card never includes anything beyond the link's own destination URL — no bearer tokens, protected archive URLs, or audience-policy details", () => {
    const result = buildShareCard({ ...BASE_INPUT, resumableBundleAvailable: true });

    expect(result.kind).toBe("available");
    if (result.kind === "available") {
      const occurrences = result.markdown.split(BASE_INPUT.linkUrl).length - 1;
      // Both the "view" link and the "resume" CTA point at the same public
      // share-link destination -- never a separate protected archive URL.
      expect(occurrences).toBe(2);
      expect(result.markdown).not.toMatch(/bearer|token|sas|audiencePolicy/i);
    }
  });
});
