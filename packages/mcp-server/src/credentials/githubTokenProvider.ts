/**
 * Acquires a GitHub user token for a *restricted* publish.
 *
 * This runs only when the publisher asks to limit an audience to GitHub
 * users, teams, or organizations. That request implies the publisher has a
 * GitHub account, so asking for a token is reasonable; an unrestricted
 * publisher is never prompted and never needs one.
 *
 * The chain is ordered so the least intrusive source that can work is used
 * first:
 *
 * 1. **`gh auth token`** — the developer already authenticated the GitHub CLI
 *    for this machine, so nothing is asked of them at all.
 * 2. **Environment variables** — `SESSION_REGISTRY_GITHUB_TOKEN` first, then
 *    the conventional `GITHUB_TOKEN`/`GH_TOKEN`. The dedicated variable comes
 *    first so a publisher can scope a narrow token to this tool without
 *    disturbing whatever else on the machine relies on `GITHUB_TOKEN`.
 * 3. **OAuth device flow** — only when a client id is configured. It is last
 *    because it is the only source that interrupts the publisher.
 *
 * The token is used for one request and never written to disk. Unlike the
 * publisher token, it is not ours to persist: it is a GitHub credential that
 * typically carries far broader scopes than this feature needs, and caching
 * it would extend its exposure well beyond the moment it was required.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type GithubTokenSource = "gh-cli" | "environment" | "device-flow";

export interface GithubTokenAcquisition {
  readonly token: string;
  readonly source: GithubTokenSource;
}

export class GithubTokenUnavailableError extends Error {
  readonly code = "GITHUB_TOKEN_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "GithubTokenUnavailableError";
  }
}

export interface DeviceFlowPrompt {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly expiresInSeconds: number;
}

export interface GithubTokenProviderOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to invoking the real `gh` executable. */
  readonly readGhCliToken?: () => Promise<string | null>;
  /**
   * Presents the device-flow code to the publisher. Omitting it disables the
   * device flow, which is the right default for a non-interactive host that
   * has nowhere to display a code.
   */
  readonly promptDeviceFlow?: (prompt: DeviceFlowPrompt) => void | Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The scopes requested by the device flow.
 *
 * `read:org` is required to resolve team and organization audiences, and
 * nothing beyond it is requested: this feature never reads code, never reads
 * gists, and never writes. `gh auth token` will usually hand back something
 * much broader, which is a reason to prefer a purpose-scoped token in
 * `SESSION_REGISTRY_GITHUB_TOKEN` when one is available.
 */
export const DEVICE_FLOW_SCOPES = "read:org";

const ENVIRONMENT_VARIABLES = [
  "SESSION_REGISTRY_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

export async function acquireGithubToken(
  options: GithubTokenProviderOptions = {},
): Promise<GithubTokenAcquisition> {
  const env = options.env ?? process.env;

  const cli = await (options.readGhCliToken ?? readGhCliToken)();
  if (cli !== null && cli.trim() !== "") {
    return { token: cli.trim(), source: "gh-cli" };
  }

  for (const name of ENVIRONMENT_VARIABLES) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") {
      return { token: value, source: "environment" };
    }
  }

  const clientId = env.SESSION_REGISTRY_GITHUB_CLIENT_ID?.trim();
  if (clientId !== undefined && clientId !== "" && options.promptDeviceFlow !== undefined) {
    return {
      token: await runDeviceFlow(clientId, options),
      source: "device-flow",
    };
  }

  throw new GithubTokenUnavailableError(
    "Restricting an audience to GitHub users, teams, or organizations requires a GitHub token. " +
      "Authenticate the GitHub CLI (`gh auth login`) or set SESSION_REGISTRY_GITHUB_TOKEN, " +
      "or publish without audience restrictions.",
  );
}

/**
 * Reads the token the GitHub CLI already holds.
 *
 * Every failure mode here — `gh` absent, not authenticated, or failing for
 * any other reason — means the same thing to the caller: this source cannot
 * supply a token, try the next one. So they collapse to `null` rather than
 * propagating, and the CLI's own stderr is deliberately not surfaced, since
 * it can echo the configured host and account.
 */
async function readGhCliToken(): Promise<string | null> {
  try {
    const { stdout } = await run("gh", ["auth", "token"], {
      // A hung `gh` must not hang a publish.
      timeout: 5_000,
      windowsHide: true,
    });
    const token = stdout.trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

interface DeviceCodeResponse {
  readonly device_code?: unknown;
  readonly user_code?: unknown;
  readonly verification_uri?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
}

interface AccessTokenResponse {
  readonly access_token?: unknown;
  readonly error?: unknown;
}

async function runDeviceFlow(
  clientId: string,
  options: GithubTokenProviderOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const startResponse = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: DEVICE_FLOW_SCOPES }),
  });
  if (!startResponse.ok) {
    throw new GithubTokenUnavailableError(
      `GitHub refused to start the device flow (HTTP ${startResponse.status}).`,
    );
  }

  const start = (await startResponse.json()) as DeviceCodeResponse;
  const deviceCode = asNonEmptyString(start.device_code);
  const userCode = asNonEmptyString(start.user_code);
  const verificationUri = asNonEmptyString(start.verification_uri);
  if (deviceCode === null || userCode === null || verificationUri === null) {
    throw new GithubTokenUnavailableError("GitHub returned an unusable device-flow response.");
  }

  const expiresIn = asPositiveInteger(start.expires_in) ?? 900;
  // GitHub's documented floor is 5s; a missing or nonsensical interval must
  // not turn into a tight polling loop against their endpoint.
  let intervalSeconds = Math.max(asPositiveInteger(start.interval) ?? 5, 5);

  await options.promptDeviceFlow?.({
    verificationUri,
    userCode,
    expiresInSeconds: expiresIn,
  });

  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);

    const pollResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!pollResponse.ok) {
      throw new GithubTokenUnavailableError(
        `GitHub refused the device-flow poll (HTTP ${pollResponse.status}).`,
      );
    }

    const poll = (await pollResponse.json()) as AccessTokenResponse;
    const token = asNonEmptyString(poll.access_token);
    if (token !== null) {
      return token;
    }

    const error = typeof poll.error === "string" ? poll.error : "";
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      // GitHub asks for backoff by returning this instead of a token; ignoring
      // it risks the client being rate-limited out of the flow entirely.
      intervalSeconds += 5;
      continue;
    }
    throw new GithubTokenUnavailableError(
      error === "access_denied"
        ? "The GitHub authorization request was denied."
        : "The GitHub device-flow authorization did not complete.",
    );
  }

  throw new GithubTokenUnavailableError(
    "The GitHub device-flow authorization expired before it was approved.",
  );
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
