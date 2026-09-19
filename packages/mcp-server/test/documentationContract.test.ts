import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This package lives at plugin/packages/mcp-server; PLUGIN_ROOT is the
// portable plugin root containing plugin-local manifests. Tests in this
// submodule must stay self-contained for standalone plugin checkout/import,
// so this file asserts only on plugin-owned manifests. The root repository's
// local.mcp.json is an unused placeholder for local Compose experimentation
// and is deliberately not covered here.
const PLUGIN_ROOT = new URL("../../../", import.meta.url);
const MCP_MANIFEST_PATH = fileURLToPath(new URL("mcp.json", PLUGIN_ROOT));

async function readRepositoryText(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

describe("publication plugin manifests", () => {
  it("provides production defaults for the published plugin manifest", async () => {
    const example = JSON.parse(
      await readRepositoryText(MCP_MANIFEST_PATH),
    ) as {
      readonly mcpServers?: {
        readonly "session-registry"?: {
          readonly type?: string;
          readonly command?: string;
          readonly args?: readonly string[];
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
        };
      };
    };
    const server = example.mcpServers?.["session-registry"];

    expect(server).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/scripts/mcp-server.mjs"],
      cwd: "${PLUGIN_ROOT}",
      env: {
        SESSION_REGISTRY_API_URL: "https://sessionregistry.io",
      },
    });
  });

  // Publishers authenticate with a token the registry issues to them on
  // their first publish, stored under the user's own credential file. A
  // credential shipped in the manifest would be a single shared secret that
  // every installation authenticates as, which is exactly what the
  // per-publisher principal model replaces.
  it("security: ships no publish credential in the manifest", async () => {
    const manifest = await readRepositoryText(MCP_MANIFEST_PATH);

    expect(manifest).not.toContain("SESSION_REGISTRY_TOKEN");
    expect(manifest).not.toContain("session-registry-public-publish-v1");
  });
});
