import { describe, expect, it } from "vitest";

import {
  getShareCard,
  GetShareCardNotFoundError,
  type BackendGetShareCardClient,
} from "../../src/tools/getShareCard.js";

describe("getShareCard", () => {
  it("passes the linkId to the backend and returns an available card", async () => {
    const calls: string[] = [];
    const backendClient: BackendGetShareCardClient = {
      async getShareCard(linkId: string) {
        calls.push(linkId);
        return { kind: "available" as const, markdown: "### Fix flaky retry test" };
      },
    };

    const result = await getShareCard({ linkId: "link_1" }, { backendClient });

    expect(calls).toEqual(["link_1"]);
    expect(result).toEqual({ kind: "available", markdown: "### Fix flaky retry test" });
  });

  it("returns unavailable as a normal result, not an error, for a revoked/expired link", async () => {
    const backendClient: BackendGetShareCardClient = {
      async getShareCard() {
        return { kind: "unavailable" as const };
      },
    };

    await expect(
      getShareCard({ linkId: "link_1" }, { backendClient }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("propagates a not-found error for a nonexistent or non-owned link", async () => {
    const backendClient: BackendGetShareCardClient = {
      async getShareCard(linkId: string) {
        throw new GetShareCardNotFoundError(linkId);
      },
    };

    await expect(
      getShareCard({ linkId: "missing-link" }, { backendClient }),
    ).rejects.toThrow(GetShareCardNotFoundError);
  });
});
