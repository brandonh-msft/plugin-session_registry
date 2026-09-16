import { describe, expect, it } from "vitest";
import {
  generateTitleAndSummary,
  SummaryGenerationOutOfBoundsError,
  TITLE_MAX_LENGTH,
  SUMMARY_MAX_LENGTH,
} from "../../src/summary/generate.js";

describe("generateTitleAndSummary", () => {
  it("happy path: returns the generated title and summary when within limits", async () => {
    const result = await generateTitleAndSummary(async () => ({
      title: "Fix flaky auth test",
      summary: "Investigated and fixed a race condition in the auth test suite.",
    }));

    expect(result).toEqual({
      title: "Fix flaky auth test",
      summary: "Investigated and fixed a race condition in the auth test suite.",
    });
  });

  it("edge case: an empty title is rejected rather than silently published", async () => {
    await expect(
      generateTitleAndSummary(async () => ({ title: "   ", summary: "some summary" })),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);
  });

  it("edge case: an empty summary is rejected rather than silently published", async () => {
    await expect(
      generateTitleAndSummary(async () => ({ title: "a title", summary: "" })),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);
  });

  it("edge case: a title over the length limit is rejected rather than silently truncated", async () => {
    await expect(
      generateTitleAndSummary(async () => ({
        title: "x".repeat(TITLE_MAX_LENGTH + 1),
        summary: "some summary",
      })),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);
  });

  it("edge case: a summary over the length limit is rejected rather than silently truncated", async () => {
    await expect(
      generateTitleAndSummary(async () => ({
        title: "a title",
        summary: "x".repeat(SUMMARY_MAX_LENGTH + 1),
      })),
    ).rejects.toThrow(SummaryGenerationOutOfBoundsError);
  });

  it("edge case: a title exactly at the length limit is accepted", async () => {
    const title = "x".repeat(TITLE_MAX_LENGTH);
    const result = await generateTitleAndSummary(async () => ({
      title,
      summary: "some summary",
    }));
    expect(result.title).toBe(title);
  });

  it("edge case: a summary exactly at the length limit is accepted", async () => {
    const summary = "x".repeat(SUMMARY_MAX_LENGTH);
    const result = await generateTitleAndSummary(async () => ({
      title: "a title",
      summary,
    }));
    expect(result.summary).toBe(summary);
  });
});
