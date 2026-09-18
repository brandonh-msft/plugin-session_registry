import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeSessionBundle, buildNativeSessionPublication, LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT,
  NATIVE_SESSION_BUNDLE_MANIFEST_PATH, parseNativeSessionArchiveView,
} from "@session-registry/core";
import { archiveFile, nativeArchiveFixture, nativeV3ArchiveFixture } from "../../core/test/archive/nativeSessionArchive.fixture.js";

import {
  createHttpBackendClient,
  PublishRequestFailedError,
  PublishStateUnknownError,
  type ContentUploader,
} from "../src/httpBackendClient.js";
import type { PublishSubmission } from "../src/tools/publish.js";
import type { ShareLinkRequest } from "../src/tools/publishAndShare.js";

const SUBMISSION: PublishSubmission = {
  ownerGithubLogin: "octocat",
  harnessSessionId: "hs1",
  transcript: "redacted transcript",
  artifacts: [{ filename: "notes.md", content: "redacted notes" }],
  harness: { name: "test-harness", version: "1.0.0" },
  title: "A session",
  summary: "A summary.",
};

const ANONYMOUS_SHARE: ShareLinkRequest = {
  audiencePolicy: { accessMode: "anonymous" },
};
const PUBLICATION_KEY = "publication-key-1";

function uploaderStub(): ContentUploader & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    async upload(content) {
      const text = typeof content === "string" ? content : Buffer.from(content).toString();
      uploads.push(text);
      return { containerName: "sessions", blobKey: `blob_${uploads.length}` };
    },
  };
}

function okResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createHttpBackendClient", () => {
  it.each(["not-verified", "invalidated-by-security-edits"] as const)(
    "uploads V3 raw evidence and binary native files using the protected legacy-named slot with restoration %s", async (status) => {
      const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 0]);
      const archive = {
        ...nativeV3ArchiveFixture([
          archiveFile("events.jsonl", "events", '{"type":"unknown","key":1,"key":2}\r\nnot-json\n{"partial":', 1),
          { path: "image.png", kind: "attachment", contentEncoding: "base64", content: bytes.toString("base64"),
            recordCount: 0, sha256: createHash("sha256").update(bytes).digest("hex") },
        ]),
        restoration: { status, reason: "No native restoration procedure was tested." },
      };
      const transcript = JSON.stringify(archive);
      const upload = vi.fn<ContentUploader["upload"]>(async (_content, _type, kind) => ({ containerName: "sessions", blobKey: kind }));
      const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
      await createHttpBackendClient({
        baseUrl: "https://api.registry.example.com",
        getAccessToken: async () => "t", uploader: { upload }, fetch: fetchMock,
      }).submitAndCreateLink({ ...SUBMISSION, transcript }, ANONYMOUS_SHARE, "v3-native-key");
      expect(archive.resumable).toBe(false);
      const publication = buildNativeSessionPublication(archive);
      expect(upload.mock.calls[0]).toEqual([publication.content, "application/json; charset=utf-8", "transcript"]);
      const readable = parseNativeSessionArchiveView(upload.mock.calls[0]![0] as string)!;
      expect(readable.nativeBundle.unscannable).toBe(true);
      expect(readable.nativeBundle.includedInPortableBulkArchive).toBe(false);
      expect(readable.files[1]!.preview.kind).toBe("download-only");
      expect(publication.content).not.toContain(bytes.toString("base64"));
      expect(upload.mock.calls[2]).toEqual([buildNativeSessionBundle(archive), "application/zip", "resumable-bundle"]);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string).resumableBundlePointer).toEqual({ containerName: "sessions", blobKey: "resumable-bundle" });
    },
  );

  it("uploads a native ZIP derived only from the exact approved resumable V2 transcript", async () => {
    const archive = { ...nativeArchiveFixture(), resumable: true,
      files: [archiveFile("events.jsonl", "events", '\uFEFF {"type":"unknown","id":900719925474099312345}\r\n', 1)] };
    const transcript = ` \n${JSON.stringify(archive, null, 2)}\r\n`;
    const upload = vi.fn<ContentUploader["upload"]>(async (_content, _type, kind) => ({ containerName: "sessions", blobKey: kind }));
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t", uploader: { upload }, fetch: fetchMock,
    });
    await client.submitAndCreateLink({ ...SUBMISSION, transcript }, ANONYMOUS_SHARE, "native-key");
    expect(upload.mock.calls[0]).toEqual([buildNativeSessionPublication(archive).content, "application/json; charset=utf-8", "transcript"]);
    expect(upload.mock.calls[2]).toEqual([buildNativeSessionBundle(archive), "application/zip", "resumable-bundle"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).resumableBundlePointer).toEqual({ containerName: "sessions", blobKey: "resumable-bundle" });
  });

  it.each(["legacy text", JSON.stringify({ ...nativeArchiveFixture(), format: LEGACY_NATIVE_SESSION_ARCHIVE_FORMAT }),
    JSON.stringify(nativeArchiveFixture())])("keeps nonresumable uploads bundle-less", async (transcript) => {
    const upload = vi.fn<ContentUploader["upload"]>(async () => ({ containerName: "sessions", blobKey: "blob" }));
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    await createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t", uploader: { upload }, fetch: fetchMock,
    }).submitAndCreateLink({ ...SUBMISSION, transcript }, ANONYMOUS_SHARE, "legacy-key");
    expect(upload.mock.calls.some((call) => call[2] === "resumable-bundle")).toBe(false);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).resumableBundlePointer).toBeNull();
  });

  it("validates native sources and bundle safety before uploading any approved content", async () => {
    const upload = vi.fn<ContentUploader["upload"]>();
    const fetchMock = vi.fn();
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t", uploader: { upload }, fetch: fetchMock,
    });
    for (const transcript of [
      '{"format":"session-registry/native-session/2",',
      JSON.stringify({ ...nativeArchiveFixture(), resumable: true,
        files: [archiveFile("../outside", "attachment", "must not upload", 0)] }),
      JSON.stringify({ ...nativeV3ArchiveFixture(), capture: undefined }),
      JSON.stringify(nativeV3ArchiveFixture([
        archiveFile(NATIVE_SESSION_BUNDLE_MANIFEST_PATH, "attachment", "reserved filename collision", 0),
      ])),
      buildNativeSessionPublication(nativeV3ArchiveFixture([
        archiveFile("events.jsonl", "events", "{}\n", 1),
      ])).content,
    ]) {
      await expect(client.submitAndCreateLink({ ...SUBMISSION, transcript }, ANONYMOUS_SHARE, "invalid")).rejects.toThrow();
    }
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish if the native bundle upload fails", async () => {
    const transcript = JSON.stringify({ ...nativeArchiveFixture(), resumable: true,
      files: [archiveFile("events.jsonl", "events", "{}\r\n", 1)] });
    const upload = vi.fn<ContentUploader["upload"]>(async (_content, _type, kind) => {
      if (kind === "resumable-bundle") throw new Error("native upload unavailable");
      return { containerName: "sessions", blobKey: kind };
    });
    const fetchMock = vi.fn();
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t", uploader: { upload }, fetch: fetchMock,
    });
    await expect(client.submitAndCreateLink({ ...SUBMISSION, transcript }, ANONYMOUS_SHARE, "native-key"))
      .rejects.toThrow("native upload unavailable");
    expect(upload).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads content and publishes pointers in a single atomic call", async () => {
    const uploader = uploaderStub();
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));

    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "token-abc",
      uploader,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitAndCreateLink(
      SUBMISSION,
      ANONYMOUS_SHARE,
      "key-1",
      PUBLICATION_KEY,
    );

    expect(result).toEqual({
      sessionId: "s1",
      harnessSessionId: "hs1",
      linkId: "l1",
      shareUrl: "https://registry.example.com/session/hs1/l1",
      idempotentReplay: false,
    });
    expect(uploader.uploads).toEqual(["redacted transcript", "redacted notes"]);
    // Exactly one server call: publish and link creation are not separable.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.registry.example.com/api/sessions:publishAndShare");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      harnessSessionId: "hs1",
      title: "A session",
      idempotencyKey: "key-1",
      publicationKey: PUBLICATION_KEY,
      transcriptPointer: { containerName: "sessions", blobKey: "blob_1" },
      artifactPointers: [{ containerName: "sessions", blobKey: "blob_2" }],
      audiencePolicy: { accessMode: "anonymous" },
    });
  });

  it("never transmits raw content to the API, only pointers", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "token-abc",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");

    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(body).not.toContain("redacted transcript");
    expect(body).not.toContain("redacted notes");
  });

  it("sends the bearer token", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "token-abc",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-abc");
  });

  it("omits expiresAt when unspecified so the server applies its own default", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");

    const sent = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect("expiresAt" in sent).toBe(false);
  });

  it("distinguishes an explicit null expiry from an absent one", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.submitAndCreateLink(
      SUBMISSION,
      { audiencePolicy: { accessMode: "anonymous" }, expiresAt: null },
      "key-1",
    );

    const sent = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(sent.expiresAt).toBeNull();
  });

  it("treats a 200 idempotent replay as success (PUBLISH-R54)", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: true }, 200),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");
    expect(result).toEqual({
      sessionId: "s1",
      harnessSessionId: "hs1",
      linkId: "l1",
      shareUrl: "https://registry.example.com/session/hs1/l1",
      idempotentReplay: true,
    });
  });

  it("surfaces a server rejection with its status and detail", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ error: "content matched the known-bad-content list" }, 422),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishRequestFailedError);
  });

  it("rejects a malformed success response rather than returning a partial result", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1" }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("rejects a response without a harness session id so the URL is never guessed", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", linkId: "l1" }));
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("rejects a response with IDs but no share URL", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", idempotentReplay: false }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("rejects a response with a missing or invalid replay flag", async () => {
    for (const idempotentReplay of [undefined, "false"]) {
      const fetchMock = vi.fn(async () =>
        okResponse({
          sessionId: "s1",
          harnessSessionId: "hs1",
          linkId: "l1",
          shareUrl: "https://registry.example.com/session/hs1/l1",
          ...(idempotentReplay === undefined ? {} : { idempotentReplay }),
        }),
      );
      const client = createHttpBackendClient({
        baseUrl: "https://api.registry.example.com",
        getAccessToken: async () => "t",
        uploader: uploaderStub(),
        fetch: fetchMock as unknown as typeof fetch,
      });

      await expect(
        client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
      ).rejects.toThrow(PublishStateUnknownError);
    }
  });

  it("uses the server's canonical harness session id and share URL", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "canonical-id",
        linkId: "l1",
        shareUrl: "https://registry.example.com/session/canonical-id/l1",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitAndCreateLink(
      { ...SUBMISSION, harnessSessionId: "client-id" },
      ANONYMOUS_SHARE,
      "key-1",
    );

    expect(result).toMatchObject({
      harnessSessionId: "canonical-id",
      shareUrl: "https://registry.example.com/session/canonical-id/l1",
    });
  });

  it("percent-encodes the harness session id so the URL stays a single path segment", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "a b/c",
        linkId: "l 1",
        shareUrl: "https://registry.example.com/session/a%20b%2Fc/l%201",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");

    expect(result).toMatchObject({
      shareUrl: "https://registry.example.com/session/a%20b%2Fc/l%201",
    });
  });

  it("rejects empty IDs rather than returning an unusable share URL", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "hs1",
        linkId: "",
        shareUrl: "https://registry.example.com/session/hs1/",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("reports unknown state when the publish request loses its response on every retry attempt", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const sleep = vi.fn(async () => {});
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
    // Initial attempt plus all cold-start retries, each preceded by a delay.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("retries a cold-start network failure and succeeds once the API responds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("connection reset");
      }
      return okResponse({
        sessionId: "s1",
        harnessSessionId: "hs1",
        linkId: "l1",
        shareUrl: "https://registry.example.com/session/hs1/l1",
        idempotentReplay: false,
      });
    });
    const sleep = vi.fn(async () => {});
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    const result = await client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1");

    expect(result.sessionId).toBe("s1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not call the API when an upload fails", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const failingUploader: ContentUploader = {
      async upload() {
        throw new Error("storage unavailable");
      },
    };
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com",
      getAccessToken: async () => "t",
      uploader: failingUploader,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow("storage unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes a base URL with a trailing slash", async () => {
    const fetchMock = vi.fn(async () => okResponse({ sessionId: "s1", harnessSessionId: "hs1", linkId: "l1", shareUrl: "https://registry.example.com/session/hs1/l1", idempotentReplay: false }));
    const client = createHttpBackendClient({
      baseUrl: "https://registry.example.com/",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.submitAndCreateLink(
      SUBMISSION,
      ANONYMOUS_SHARE,
      "key-1",
    );
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://registry.example.com/api/sessions:publishAndShare",
    );
    expect(result).toMatchObject({
      shareUrl: "https://registry.example.com/session/hs1/l1",
    });
  });

  it("rejects an invalid server-supplied share URL", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "hs1",
        linkId: "l1",
        shareUrl: "not-a-url",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("rejects a server-supplied share URL with credentials", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "hs1",
        linkId: "l1",
        shareUrl: "https://user:pass@registry.example.com/session/hs1/l1",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).rejects.toThrow(PublishStateUnknownError);
  });

  it("rejects a server-supplied share URL with a query, fragment, or noncanonical path", async () => {
    for (const shareUrl of [
      "https://registry.example.com/session/hs1/l1?download=true",
      "https://registry.example.com/session/hs1/l1#fragment",
      "https://registry.example.com/not-session/hs1/l1",
    ]) {
      const fetchMock = vi.fn(async () =>
        okResponse({
          sessionId: "s1",
          harnessSessionId: "hs1",
          linkId: "l1",
          shareUrl,
          idempotentReplay: false,
        }),
      );
      const client = createHttpBackendClient({
        baseUrl: "https://api.registry.example.com",
        getAccessToken: async () => "t",
        uploader: uploaderStub(),
        fetch: fetchMock as unknown as typeof fetch,
      });

      await expect(
        client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
      ).rejects.toThrow(PublishStateUnknownError);
    }
  });

  it("uses the server-supplied share URL rather than reconstructing it", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessionId: "s1",
        harnessSessionId: "hs1",
        linkId: "l1",
        shareUrl: "https://web.example.net/session/hs1/l1",
        idempotentReplay: false,
      }),
    );
    const client = createHttpBackendClient({
      baseUrl: "https://api.registry.example.com",
      getAccessToken: async () => "t",
      uploader: uploaderStub(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.submitAndCreateLink(SUBMISSION, ANONYMOUS_SHARE, "key-1"),
    ).resolves.toMatchObject({
      shareUrl: "https://web.example.net/session/hs1/l1",
    });
  });
});
