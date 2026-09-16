import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("source plugin layout", () => {
  it("uses the Agent Plugins 1.0 manifest and self-locating MCP launcher", async () => {
    const pluginManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const mcpManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "mcp.json"), "utf8"),
    ) as {
      readonly $schema?: string;
      readonly mcpServers?: Record<
        string,
        {
          readonly args?: readonly string[];
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
        }
      >;
    };
    const launcher = await readFile(
      resolve(repositoryRoot, "scripts/mcp-server.mjs"),
      "utf8",
    );

    expect(pluginManifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    expect(pluginManifest).not.toHaveProperty("skills");
    expect(pluginManifest).not.toHaveProperty("mcpServers");
    expect(mcpManifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    );
    expect(mcpManifest.mcpServers?.["session-registry"]).toMatchObject({
      args: ["${PLUGIN_ROOT}/scripts/mcp-server.mjs"],
      cwd: "${PLUGIN_ROOT}",
      env: {
        SESSION_REGISTRY_API_URL: "https://sessionregistry.io",
      },
    });
    // The launcher must resolve its own paths rather than the client's cwd.
    expect(launcher).toContain("fileURLToPath(import.meta.url)");
  });

  it("provides the publish-session skill in the portable location", async () => {
    const portableSkill = await readFile(
      resolve(repositoryRoot, "skills/publish-session/SKILL.md"),
      "utf8",
    );

    expect(portableSkill).toMatch(/^---\r?\nname: publish-session\r?\n/);
  });
});
