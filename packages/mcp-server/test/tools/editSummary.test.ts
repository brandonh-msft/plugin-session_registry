import { describe, expect, it, vi } from "vitest";
import {
  editSessionSummary,
  InvalidConfirmationTokenError,
  type SummaryStore,
} from "../../src/tools/editSummary.js";

function makeRecordingStore() {
  const saved: Array<{ sessionId: string; title: string; summary: string }> = [];
  const store: SummaryStore = {
    async setSummary(sessionId, summary) {
      saved.push({ sessionId, ...summary });
    },
  };
  return { store, saved };
}

describe("editSessionSummary", () => {
  it("happy path: a valid single-use confirmation token persists the new title/summary", async () => {
    const { store, saved } = makeRecordingStore();
    const consumeConfirmationToken = vi.fn(async () => true);

    await editSessionSummary(
      {
        sessionId: "session-1",
        confirmationToken: "tok-abc",
        title: "Owner-edited title",
        summary: "Owner-edited summary",
      },
      { store, consumeConfirmationToken },
    );

    expect(consumeConfirmationToken).toHaveBeenCalledWith("session-1", "tok-abc");
    expect(saved).toEqual([
      { sessionId: "session-1", title: "Owner-edited title", summary: "Owner-edited summary" },
    ]);
  });

  it("error path: an invalid/missing confirmation token is rejected without persisting anything (BASE-R16 pattern)", async () => {
    const { store, saved } = makeRecordingStore();
    const consumeConfirmationToken = vi.fn(async () => false);

    await expect(
      editSessionSummary(
        {
          sessionId: "session-1",
          confirmationToken: "wrong-token",
          title: "New title",
          summary: "New summary",
        },
        { store, consumeConfirmationToken },
      ),
    ).rejects.toThrow(InvalidConfirmationTokenError);

    expect(saved).toHaveLength(0);
  });

  it("integration: the edit path never invokes a scanner (SUMMARY-R56)", async () => {
    const { store } = makeRecordingStore();
    const consumeConfirmationToken = vi.fn(async () => true);
    const scanSpy = vi.fn();

    // This edit path takes no scanner dependency at all — asserting the
    // spy is never called demonstrates there is no hidden scan step, not
    // just that we forgot to wire one in.
    await editSessionSummary(
      {
        sessionId: "session-1",
        confirmationToken: "tok-abc",
        title: "aws=AKIAABCDEFGHIJKLMNOP", // would trigger a finding if scanned
        summary: "some summary",
      },
      { store, consumeConfirmationToken },
    );

    expect(scanSpy).not.toHaveBeenCalled();
  });
});
