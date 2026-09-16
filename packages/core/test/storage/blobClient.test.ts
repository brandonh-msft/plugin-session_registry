import { describe, expect, it } from "vitest";
import {
  AzureBlobStorageClient,
  BlobNotFoundError,
  InMemoryBlobStorageClient,
} from "../../src/storage/blobClient.js";

describe("InMemoryBlobStorageClient", () => {
  it("round-trips a stored object (happy path)", async () => {
    const client = new InMemoryBlobStorageClient();
    const pointer = { containerName: "transcripts", blobKey: "sess-1/transcript.json" };

    await client.putObject(pointer, Buffer.from("hello world"));
    const result = await client.getObject(pointer);

    expect(result.toString("utf-8")).toBe("hello world");
  });

  describe("AzureBlobStorageClient local SAS", () => {
    it("issues a blob-scoped read-only SAS when shared-key credentials are configured", async () => {
      const client = new AzureBlobStorageClient("UseDevelopmentStorage=true", {
        accountName: "devstoreaccount1",
        accountKey:
          "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      });

      const url = await client.getAnonymousSasUrl(
        { containerName: "sessions", blobKey: "transcript-1" },
        { expiresInSeconds: 60 },
      );
      const params = new URL(url).searchParams;

      expect(params.get("sp")).toBe("r");
      expect(params.get("sr")).toBe("b");
      expect(params.get("spr")).toBe("https,http");
    });
  });

  it("surfaces a clear BlobNotFoundError when a referenced pointer does not exist (error path)", async () => {
    const client = new InMemoryBlobStorageClient();
    const pointer = { containerName: "transcripts", blobKey: "does-not-exist" };

    await expect(client.getObject(pointer)).rejects.toThrow(BlobNotFoundError);
  });

  it("deletes an object so a subsequent get fails (happy path)", async () => {
    const client = new InMemoryBlobStorageClient();
    const pointer = { containerName: "artifacts", blobKey: "sess-1/diff.patch" };
    await client.putObject(pointer, Buffer.from("diff content"));

    await client.deleteObject(pointer);

    await expect(client.getObject(pointer)).rejects.toThrow(BlobNotFoundError);
  });

  it("issues a SAS URL only for an object that exists (happy path + error path)", async () => {
    const client = new InMemoryBlobStorageClient();
    const pointer = { containerName: "artifacts", blobKey: "sess-1/diff.patch" };
    await client.putObject(pointer, Buffer.from("diff content"));

    const url = await client.getAnonymousSasUrl(pointer, { expiresInSeconds: 30 });
    expect(url).toContain("sess-1/diff.patch");

    const missingPointer = { containerName: "artifacts", blobKey: "missing" };
    await expect(
      client.getAnonymousSasUrl(missingPointer, { expiresInSeconds: 30 }),
    ).rejects.toThrow(BlobNotFoundError);
  });
});
