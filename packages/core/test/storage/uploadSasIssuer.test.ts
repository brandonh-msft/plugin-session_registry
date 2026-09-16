import { describe, expect, it } from "vitest";
import type { TokenCredential } from "@azure/identity";
import type { UserDelegationKey } from "@azure/storage-blob";

import {
  AzureUploadSasIssuer,
  SharedKeyUploadSasIssuer,
} from "../../src/storage/uploadSasIssuer.js";

const ENDPOINT = "https://testacct.blob.core.windows.net";
const NOW = new Date("2026-09-08T00:00:00.000Z");

const credential: TokenCredential = {
  getToken: async () => ({ token: "fake", expiresOnTimestamp: Date.now() + 3_600_000 }),
};

/**
 * A structurally valid user delegation key. The signature it produces is
 * meaningless, which is fine — these tests assert on the SAS *parameters*
 * (permissions, scope, expiry), which is where the security properties live.
 *
 * `signedStartsOn`/`signedExpiresOn` are `Date`s despite `UserDelegationKey`
 * declaring them as `string`: the SDK passes them straight to
 * `truncatedISO8061Date`, which calls `.toISOString()`. The cast below records
 * that mismatch rather than papering over it.
 */
const DELEGATION_KEY = {
  signedObjectId: "00000000-0000-0000-0000-000000000001",
  signedTenantId: "00000000-0000-0000-0000-000000000002",
  signedStartsOn: NOW,
  signedExpiresOn: new Date(NOW.getTime() + 3_600_000),
  signedService: "b",
  signedVersion: "2024-11-04",
  value: Buffer.from("delegation-key-material").toString("base64"),
} as unknown as UserDelegationKey;

function makeIssuer(): { issuer: AzureUploadSasIssuer; delegationCalls: number[] } {
  const issuer = new AzureUploadSasIssuer(ENDPOINT, credential, () => NOW);
  const delegationCalls: number[] = [];
  // Stubbed so the test needs no Entra round trip; everything downstream of
  // the key — which is what these assertions cover — is real SDK code.
  (issuer as unknown as { serviceClient: { getUserDelegationKey: unknown } }).serviceClient.getUserDelegationKey =
    async () => {
      delegationCalls.push(Date.now());
      return DELEGATION_KEY;
    };
  return { issuer, delegationCalls };
}

function sasParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("AzureUploadSasIssuer", () => {
  it("grants Create permission and never Write, so a published blob cannot be overwritten", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    const permissions = sasParams(grant.uploadUrl).get("sp") ?? "";
    expect(permissions).toContain("c");
    // `w` would silently turn this into an overwrite-capable credential,
    // breaking BASE-R6 immutability and BASE-R41.
    expect(permissions).not.toContain("w");
  });

  it("scopes the grant to a single blob, not the container", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    // `sr=b` is blob scope; `c` would be container-wide.
    expect(sasParams(grant.uploadUrl).get("sr")).toBe("b");
    expect(grant.uploadUrl.startsWith(`${ENDPOINT}/sessions/abc?`)).toBe(true);
  });

  it("restricts the grant to HTTPS", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    expect(sasParams(grant.uploadUrl).get("spr")).toBe("https");
  });

  it("expires at the requested horizon", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    expect(grant.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 900_000).toISOString());
    expect(sasParams(grant.uploadUrl).get("se")).toContain("2026-09-08T00:15:00");
  });

  it("backdates the start time to tolerate clock skew", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    const start = new Date(sasParams(grant.uploadUrl).get("st") ?? "");
    expect(start.getTime()).toBeLessThan(NOW.getTime());
  });

  it("is signed as a user delegation SAS, so no account key is involved", async () => {
    const { issuer } = makeIssuer();
    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    // `skoid` only appears on user-delegation SAS tokens.
    expect(sasParams(grant.uploadUrl).get("skoid")).toBe(DELEGATION_KEY.signedObjectId);
  });

  it("reuses the cached delegation key across grants", async () => {
    const { issuer, delegationCalls } = makeIssuer();
    await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "a" },
      expiresInSeconds: 900,
    });
    await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "artifacts", blobKey: "b" },
      expiresInSeconds: 900,
    });

    expect(delegationCalls).toHaveLength(1);
  });

  it("issues distinct URLs for distinct blobs", async () => {
    const { issuer } = makeIssuer();
    const first = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "a" },
      expiresInSeconds: 900,
    });
    const second = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "b" },
      expiresInSeconds: 900,
    });

    expect(first.uploadUrl).not.toBe(second.uploadUrl);
  });
});

describe("SharedKeyUploadSasIssuer", () => {
  it("rejects non-local endpoints so account-key SAS cannot be used in production", () => {
    expect(
      () =>
        new SharedKeyUploadSasIssuer(
          "https://production.blob.core.windows.net",
          "account",
          "key",
        ),
    ).toThrow("restricted to local emulator endpoints");
  });

  it("creates the local container and issues an HTTP-capable create-only blob SAS", async () => {
    const issuer = new SharedKeyUploadSasIssuer(
      "http://127.0.0.1:10000/devstoreaccount1",
      "devstoreaccount1",
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      () => NOW,
    );
    let createCalls = 0;
    (
      issuer as unknown as {
        serviceClient: {
          getContainerClient: () => {
            createIfNotExists: () => Promise<void>;
            getBlockBlobClient: () => { url: string };
          };
        };
      }
    ).serviceClient.getContainerClient = () => ({
      createIfNotExists: async () => {
        createCalls += 1;
      },
      getBlockBlobClient: () => ({
        url: "http://127.0.0.1:10000/devstoreaccount1/sessions/abc",
      }),
    });

    const grant = await issuer.issueCreateOnlyUploadUrl({
      pointer: { containerName: "sessions", blobKey: "abc" },
      expiresInSeconds: 900,
    });

    const permissions = sasParams(grant.uploadUrl).get("sp") ?? "";
    expect(createCalls).toBe(1);
    expect(permissions).toContain("c");
    expect(permissions).not.toContain("w");
    expect(sasParams(grant.uploadUrl).get("spr")).toBe("https,http");
    expect(sasParams(grant.uploadUrl).get("sr")).toBe("b");
  });
});
