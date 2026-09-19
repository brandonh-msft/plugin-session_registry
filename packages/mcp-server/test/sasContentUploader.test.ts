import { describe, expect, it } from "vitest";

import {
  createSasContentUploader,
  UploadFailedError,
} from "../src/sasContentUploader.js";

const BASE_URL = "https://registry.example.com";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * Answers the slot request with `slot`, then the PUT with `putStatus`.
 * Records both so tests can assert on what actually went over the wire.
 */
function stubFetch(options: {
  slotStatus?: number;
  slotBody?: unknown;
  putStatus?: number;
}): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });

    if (url.endsWith("/api/uploads")) {
      const status = options.slotStatus ?? 201;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "slot",
        json: async () =>
          options.slotBody ?? {
            slots: [
              {
                kind: "transcript",
                pointer: { containerName: "sessions", blobKey: "assigned-key" },
                uploadUrl: "https://acct.blob.core.windows.net/sessions/assigned-key?sp=c",
                expiresAt: "2026-09-08T00:15:00.000Z",
              },
            ],
          },
      };
    }

    const status = options.putStatus ?? 201;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "put",
      json: async () => ({}),
    };
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

function makeUploader(fetch: typeof globalThis.fetch) {
  return createSasContentUploader({
    baseUrl: BASE_URL,
    getAccessToken: async () => "dev-token",
    fetch,
  });
}

describe("createSasContentUploader", () => {
  it("returns the server-assigned pointer, not one of its own choosing", async () => {
    const { fetch } = stubFetch({});
    const pointer = await makeUploader(fetch).upload("transcript text", "text/plain", "transcript");

    expect(pointer).toEqual({ containerName: "sessions", blobKey: "assigned-key" });
  });

  it("asks for a slot before writing, and writes to the granted URL", async () => {
    const { fetch, calls } = stubFetch({});
    await makeUploader(fetch).upload("transcript text", "text/plain", "transcript");

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${BASE_URL}/api/uploads`);
    expect(calls[0].method).toBe("POST");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toBe(
      "https://acct.blob.core.windows.net/sessions/assigned-key?sp=c",
    );
  });

  it("sends the kind so the server can pick the container", async () => {
    const { fetch, calls } = stubFetch({});
    await makeUploader(fetch).upload("bytes", "application/octet-stream", "artifact");

    expect(JSON.parse(String(calls[0].body))).toEqual({
      uploads: [{ kind: "artifact", contentType: "application/octet-stream" }],
    });
  });

  it("never sends the developer's token to storage", async () => {
    const { fetch, calls } = stubFetch({});
    await makeUploader(fetch).upload("transcript text", "text/plain", "transcript");

    expect(calls[0].headers.authorization).toBe("Bearer dev-token");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("marks the PUT as a block blob, which the Blob REST API requires", async () => {
    const { fetch, calls } = stubFetch({});
    await makeUploader(fetch).upload("transcript text", "text/plain", "transcript");

    expect(calls[1].headers["x-ms-blob-type"]).toBe("BlockBlob");
    expect(calls[1].headers["content-type"]).toBe("text/plain");
  });

  it("tags the uploaded blob as a pending publish, so an abandoned upload can be found later", async () => {
    const { fetch, calls } = stubFetch({});
    await makeUploader(fetch).upload("transcript text", "text/plain", "transcript");

    expect(calls[1].headers["x-ms-tags"]).toBe("publishStatus=pending");
  });

  it("passes multiline Unicode content to fetch without changing the JavaScript string", async () => {
    const { fetch, calls } = stubFetch({});
    const exactContent = [
      "<<<BEGIN EXACT TRANSCRIPT>>>",
      "=== Session Registry Fidelity Disclosures ===",
      "publisher-reported: true",
      "- type: truncated",
      "  target: category:command-output",
      "  reason: Unicode output retained: café, 東京, 🚀  ",
      "=== End Session Registry Fidelity Disclosures ===",
      "",
      "[2026-09-09T21:00:00Z] command.output: first line  ",
      "[2026-09-09T21:00:01Z] assistant.message: Δ complete",
      "<<<END EXACT TRANSCRIPT>>>",
      "",
      "",
    ].join("\n");

    await makeUploader(fetch).upload(exactContent, "text/plain", "transcript");

    expect(calls[1].body).toBe(exactContent);
  });

  it("does not attempt a write when the slot request is refused", async () => {
    const { fetch, calls } = stubFetch({ slotStatus: 401, slotBody: { error: "nope" } });

    await expect(
      makeUploader(fetch).upload("transcript text", "text/plain", "transcript"),
    ).rejects.toBeInstanceOf(UploadFailedError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a 409 as the create-only guarantee refusing to overwrite", async () => {
    const { fetch } = stubFetch({ putStatus: 409 });

    await expect(
      makeUploader(fetch).upload("transcript text", "text/plain", "transcript"),
    ).rejects.toThrow(/create-only upload slots cannot overwrite/);
  });

  it("rejects a slot response missing a usable pointer rather than inventing one", async () => {
    const { fetch } = stubFetch({
      slotBody: { slots: [{ uploadUrl: "https://acct.blob.core.windows.net/x?sp=c" }] },
    });

    await expect(
      makeUploader(fetch).upload("transcript text", "text/plain", "transcript"),
    ).rejects.toThrow(/usable slot/);
  });

  it("propagates a failed write instead of returning a pointer to absent content", async () => {
    const { fetch } = stubFetch({ putStatus: 403 });

    await expect(
      makeUploader(fetch).upload("transcript text", "text/plain", "transcript"),
    ).rejects.toBeInstanceOf(UploadFailedError);
  });
});
