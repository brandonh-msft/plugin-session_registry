import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStorageError,
  credentialFilePath,
  credentialScopeFor,
  readPublisherToken,
  writePublisherToken,
} from "../../src/credentials/publisherCredentialStore.js";

const API = "https://registry.example.com";

let directory: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sr-credentials-"));
  env = { SESSION_REGISTRY_CREDENTIAL_FILE: join(directory, "credentials.json") };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function path(): string {
  return env.SESSION_REGISTRY_CREDENTIAL_FILE as string;
}

describe("credentialFilePath", () => {
  it("prefers an explicit override", () => {
    expect(credentialFilePath({ SESSION_REGISTRY_CREDENTIAL_FILE: "/tmp/x.json" })).toBe(
      "/tmp/x.json",
    );
  });

  it.each([
    ["an empty override", ""],
    ["a whitespace override", "   "],
  ])("falls back to the home directory for %s", (_label, value) => {
    const resolved = credentialFilePath({ SESSION_REGISTRY_CREDENTIAL_FILE: value });

    expect(resolved).toContain(".session-registry");
    expect(resolved).toContain("credentials.json");
  });

  it("does not depend on the harness, so one machine is one publisher", () => {
    // A per-harness path would silently split a single person into several
    // unrelated publisher principals.
    const resolved = credentialFilePath({});

    for (const harness of [".copilot", ".claude", ".codex"]) {
      expect(resolved).not.toContain(harness);
    }
  });
});

describe("credentialScopeFor", () => {
  it.each([
    ["a trailing slash", "https://registry.example.com/"],
    ["a path", "https://registry.example.com/api"],
    ["a query string", "https://registry.example.com/?x=1"],
    ["mixed case", "https://Registry.Example.COM"],
  ])("treats %s as the same deployment", (_label, url) => {
    expect(credentialScopeFor(url)).toBe(credentialScopeFor(API));
  });

  it.each([
    ["a different host", "https://staging.example.com"],
    ["a different scheme", "http://registry.example.com"],
    ["a different port", "https://registry.example.com:8443"],
  ])("treats %s as a different registry (security)", (_label, url) => {
    // Sending a production credential to another origin would leak it.
    expect(credentialScopeFor(url)).not.toBe(credentialScopeFor(API));
  });

  it("keeps two different unparseable values apart", () => {
    expect(credentialScopeFor("not a url")).not.toBe(credentialScopeFor("also not a url"));
  });
});

describe("readPublisherToken", () => {
  it("returns null before anything has ever been published", async () => {
    await expect(readPublisherToken(API, env)).resolves.toBeNull();
  });

  it("returns a stored token", async () => {
    await writePublisherToken(API, "sr_pub_abc", env);

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_abc");
  });

  it("does not return a token minted for a different registry (security)", async () => {
    await writePublisherToken("https://staging.example.com", "sr_pub_staging", env);

    await expect(readPublisherToken(API, env)).resolves.toBeNull();
  });

  it.each([
    ["invalid JSON", "{{{"],
    ["an array", "[]"],
    ["a missing map", '{"version":1}'],
    ["a non-object map", '{"version":1,"publisherTokens":"nope"}'],
    ["an array map", '{"version":1,"publisherTokens":[]}'],
  ])("treats %s as no credential rather than failing", async (_label, contents) => {
    // Raising here would let an unrelated stray file block publishing outright.
    await writeFile(path(), contents, "utf8");

    await expect(readPublisherToken(API, env)).resolves.toBeNull();
  });

  it("still honours the older flat credential file the plugin documented", async () => {
    // Breaking someone who followed the published guidance to tidy the shape
    // would be a gratuitous regression.
    await writeFile(path(), '{"token":"sr_pub_legacy"}', "utf8");

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_legacy");
  });

  it("prefers a registry-scoped token over a legacy one", async () => {
    await writeFile(
      path(),
      JSON.stringify({
        token: "sr_pub_legacy",
        publisherTokens: { "https://registry.example.com": "sr_pub_scoped" },
      }),
      "utf8",
    );

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_scoped");
  });

  it.each([
    ["an empty legacy token", '{"token":""}'],
    ["a non-string legacy token", '{"token":42}'],
  ])("ignores %s", async (_label, contents) => {
    await writeFile(path(), contents, "utf8");

    await expect(readPublisherToken(API, env)).resolves.toBeNull();
  });

  it.each([
    ["an empty token", '{"version":1,"publisherTokens":{"https://registry.example.com":""}}'],
    [
      "a whitespace token",
      '{"version":1,"publisherTokens":{"https://registry.example.com":"   "}}',
    ],
    [
      "a non-string token",
      '{"version":1,"publisherTokens":{"https://registry.example.com":42}}',
    ],
  ])("ignores %s", async (_label, contents) => {
    await writeFile(path(), contents, "utf8");

    await expect(readPublisherToken(API, env)).resolves.toBeNull();
  });
});

describe("writePublisherToken", () => {
  it("preserves tokens held for other registries", async () => {
    await writePublisherToken("https://staging.example.com", "sr_pub_staging", env);
    await writePublisherToken(API, "sr_pub_prod", env);

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_prod");
    await expect(readPublisherToken("https://staging.example.com", env)).resolves.toBe(
      "sr_pub_staging",
    );
  });

  it("replaces a rotated token for the same registry", async () => {
    await writePublisherToken(API, "sr_pub_old", env);
    await writePublisherToken(API, "sr_pub_new", env);

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_new");
  });

  it("trims surrounding whitespace so it is not sent in the header", async () => {
    await writePublisherToken(API, "  sr_pub_abc\n", env);

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_abc");
  });

  it.each([
    ["an empty token", ""],
    ["a whitespace token", "   "],
  ])("refuses to persist %s", async (_label, token) => {
    await expect(writePublisherToken(API, token, env)).rejects.toBeInstanceOf(
      CredentialStorageError,
    );
  });

  it("creates the containing directory when it does not exist", async () => {
    env = {
      SESSION_REGISTRY_CREDENTIAL_FILE: join(directory, "nested", "deep", "credentials.json"),
    };

    await writePublisherToken(API, "sr_pub_abc", env);

    await expect(readPublisherToken(API, env)).resolves.toBe("sr_pub_abc");
  });

  it("leaves no temporary file behind", async () => {
    await writePublisherToken(API, "sr_pub_abc", env);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(directory);

    expect(entries.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("writes JSON a human can inspect", async () => {
    await writePublisherToken(API, "sr_pub_abc", env);
    const parsed = JSON.parse(await readFile(path(), "utf8")) as {
      version: number;
      publisherTokens: Record<string, string>;
    };

    expect(parsed.version).toBe(1);
    expect(parsed.publisherTokens["https://registry.example.com"]).toBe("sr_pub_abc");
  });

  it.runIf(process.platform !== "win32")(
    "stores the credential with owner-only permissions (security)",
    async () => {
      await writePublisherToken(API, "sr_pub_abc", env);
      const { stat } = await import("node:fs/promises");

      expect((await stat(path())).mode & 0o777).toBe(0o600);
    },
  );
});
