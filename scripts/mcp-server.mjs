#!/usr/bin/env node
/**
 * Launcher for the local stdio MCP server.
 *
 * `.mcp.json` used to point `node` straight at
 * `./packages/mcp-server/dist/index.js`. That is both relative to the client's
 * working directory and dependent on a build having already happened, so a
 * fresh clone, a new git worktree, or a `dist/` clean makes Copilot CLI fail
 * the initialize handshake with `MODULE_NOT_FOUND`.
 *
 * This launcher resolves every path from its own location and compiles the
 * workspace on demand, so the same config works from any working directory.
 * Build output is forced onto stderr: stdout is the JSON-RPC channel and any
 * stray byte there breaks the protocol.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntrypoint = join(
  repositoryRoot,
  "packages",
  "mcp-server",
  "dist",
  "index.js",
);
const buildInputs = [
  join(repositoryRoot, "packages", "core", "src"),
  join(repositoryRoot, "packages", "mcp-server", "src"),
];

function log(message) {
  process.stderr.write(`[session-registry-mcp] ${message}\n`);
}

function newestModificationTime(path) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestModificationTime(join(path, entry.name)));
  }
  return newest;
}

function runToStderr(commandLine) {
  // `pnpm` is a `.cmd` shim on Windows, which Node can only spawn through a
  // shell; passing one command string avoids the array-args escaping warning.
  const result = spawnSync(commandLine, {
    cwd: repositoryRoot,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output !== "") {
    process.stderr.write(`${output}\n`);
  }
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`\`${commandLine}\` exited with code ${String(result.status)}`);
  }
}

function ensureBuilt() {
  const builtAt = statSync(distEntrypoint, { throwIfNoEntry: false })?.mtimeMs;
  const isStale =
    builtAt === undefined ||
    buildInputs.some((input) => newestModificationTime(input) > builtAt);

  if (!isStale) {
    return;
  }

  if (!existsSync(join(repositoryRoot, "node_modules"))) {
    log("installing workspace dependencies (node_modules missing)");
    runToStderr("pnpm install --frozen-lockfile");
  }

  log(
    builtAt === undefined
      ? "building packages/core and packages/mcp-server (no compiled entrypoint)"
      : "rebuilding packages/core and packages/mcp-server (sources changed)",
  );
  runToStderr("pnpm exec tsc -b packages/core packages/mcp-server");
}

try {
  const environmentFile = join(repositoryRoot, ".env");
  if (existsSync(environmentFile)) {
    loadEnvFile(environmentFile);
  }
  ensureBuilt();
} catch (error) {
  log(`failed to build the MCP server: ${String(error)}`);
  log(
    "build it manually with `pnpm install && pnpm exec tsc -b packages/core packages/mcp-server`",
  );
  process.exit(1);
}

// The entrypoint only starts when it is the process's main module (it compares
// `process.argv[1]` with its own path), so it has to be spawned rather than
// imported.
const child = spawn(process.execPath, [distEntrypoint, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

child.on("error", (error) => {
  log(`failed to start the MCP server: ${String(error)}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
