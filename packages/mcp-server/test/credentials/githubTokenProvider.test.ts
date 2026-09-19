import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_FLOW_SCOPES,
  GithubTokenUnavailableError,
  acquireGithubToken,
} from "../../src/credentials/githubTokenProvider.js";

const NO_CLI = async () => null;

describe("acquireGithubToken", () => {
  it("prefers the GitHub CLI, so an already-authenticated developer is never prompted", async () => {
    const result = await acquireGithubToken({
      env: { GITHUB_TOKEN: "env-token" },
      readGhCliToken: async () => "cli-token",
    });

    expect(result).toEqual({ token: "cli-token", source: "gh-cli" });
  });

  it("trims the CLI's trailing newline", async () => {
    const result = await acquireGithubToken({
      env: {},
      readGhCliToken: async () => "cli-token\n",
    });

    expect(result.token).toBe("cli-token");
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("falls through when the CLI yields %s", async (_label, value) => {
    const result = await acquireGithubToken({
      env: { GITHUB_TOKEN: "env-token" },
      readGhCliToken: async () => value,
    });

    expect(result).toEqual({ token: "env-token", source: "environment" });
  });

  it("prefers the dedicated variable over the conventional ones", async () => {
    // So a publisher can scope a narrow token to this tool without disturbing
    // whatever else on the machine relies on GITHUB_TOKEN.
    const result = await acquireGithubToken({
      env: {
        SESSION_REGISTRY_GITHUB_TOKEN: "dedicated",
        GITHUB_TOKEN: "conventional",
        GH_TOKEN: "gh",
      },
      readGhCliToken: NO_CLI,
    });

    expect(result.token).toBe("dedicated");
  });

  it("falls back to GH_TOKEN last", async () => {
    const result = await acquireGithubToken({
      env: { GH_TOKEN: "gh" },
      readGhCliToken: NO_CLI,
    });

    expect(result).toEqual({ token: "gh", source: "environment" });
  });

  it("ignores a variable that is set but blank", async () => {
    const result = await acquireGithubToken({
      env: { GITHUB_TOKEN: "   ", GH_TOKEN: "gh" },
      readGhCliToken: NO_CLI,
    });

    expect(result.token).toBe("gh");
  });

  it("explains how to proceed when no source can supply a token", async () => {
    const promise = acquireGithubToken({ env: {}, readGhCliToken: NO_CLI });

    await expect(promise).rejects.toBeInstanceOf(GithubTokenUnavailableError);
    await expect(promise).rejects.toThrow(/gh auth login|SESSION_REGISTRY_GITHUB_TOKEN/);
  });

  it("does not start a device flow when no client id is configured", async () => {
    const promptDeviceFlow = vi.fn();

    await expect(
      acquireGithubToken({ env: {}, readGhCliToken: NO_CLI, promptDeviceFlow }),
    ).rejects.toBeInstanceOf(GithubTokenUnavailableError);
    expect(promptDeviceFlow).not.toHaveBeenCalled();
  });

  it("does not start a device flow on a host that cannot display a code", async () => {
    // Omitting the prompt is how a non-interactive host opts out; starting the
    // flow anyway would hang until the code expired.
    const fetchImpl = vi.fn();

    await expect(
      acquireGithubToken({
        env: { SESSION_REGISTRY_GITHUB_CLIENT_ID: "cid" },
        readGhCliToken: NO_CLI,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GithubTokenUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

interface StubCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function stubFetch(responses: readonly unknown[], calls: StubCall[] = []) {
  let index = 0;
  const impl = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    const record = next as { status?: number; json?: unknown };
    return {
      ok: (record.status ?? 200) < 400,
      status: record.status ?? 200,
      json: async () => record.json ?? {},
    };
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const DEVICE_START = {
  json: {
    device_code: "dev-code",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  },
};

const DEVICE_ENV = { SESSION_REGISTRY_GITHUB_CLIENT_ID: "cid" };

describe("acquireGithubToken device flow", () => {
  const sleep = async () => {};

  it("returns the token once the publisher approves", async () => {
    const { impl } = stubFetch([DEVICE_START, { json: { access_token: "device-token" } }]);

    const result = await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow: () => {},
      fetchImpl: impl,
      sleep,
    });

    expect(result).toEqual({ token: "device-token", source: "device-flow" });
  });

  it("shows the publisher where to go and what to type", async () => {
    const { impl } = stubFetch([DEVICE_START, { json: { access_token: "t" } }]);
    const promptDeviceFlow = vi.fn();

    await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow,
      fetchImpl: impl,
      sleep,
    });

    expect(promptDeviceFlow).toHaveBeenCalledWith({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 900,
    });
  });

  it("requests only the scope needed to resolve audiences (security)", async () => {
    // This feature never reads code and never writes, so it must not ask to.
    const calls: StubCall[] = [];
    const { impl } = stubFetch([DEVICE_START, { json: { access_token: "t" } }], calls);

    await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow: () => {},
      fetchImpl: impl,
      sleep,
    });

    expect(calls[0]?.body.scope).toBe(DEVICE_FLOW_SCOPES);
    expect(DEVICE_FLOW_SCOPES).not.toContain("repo");
  });

  it("keeps polling while authorization is pending", async () => {
    const calls: StubCall[] = [];
    const { impl } = stubFetch(
      [
        DEVICE_START,
        { json: { error: "authorization_pending" } },
        { json: { access_token: "device-token" } },
      ],
      calls,
    );

    const result = await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow: () => {},
      fetchImpl: impl,
      sleep,
    });

    expect(result.token).toBe("device-token");
    expect(calls).toHaveLength(3);
  });

  it("backs off when GitHub asks it to, rather than being rate-limited out", async () => {
    const delays: number[] = [];
    const { impl } = stubFetch([
      DEVICE_START,
      { json: { error: "slow_down" } },
      { json: { access_token: "t" } },
    ]);

    await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow: () => {},
      fetchImpl: impl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays[0]).toBe(5000);
    expect(delays[1]).toBe(10_000);
  });

  it("never polls faster than GitHub's documented floor", async () => {
    const delays: number[] = [];
    const { impl } = stubFetch([
      { json: { ...DEVICE_START.json, interval: 0 } },
      { json: { access_token: "t" } },
    ]);

    await acquireGithubToken({
      env: DEVICE_ENV,
      readGhCliToken: NO_CLI,
      promptDeviceFlow: () => {},
      fetchImpl: impl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays[0]).toBeGreaterThanOrEqual(5000);
  });

  it("reports a denied authorization distinctly", async () => {
    const { impl } = stubFetch([DEVICE_START, { json: { error: "access_denied" } }]);

    await expect(
      acquireGithubToken({
        env: DEVICE_ENV,
        readGhCliToken: NO_CLI,
        promptDeviceFlow: () => {},
        fetchImpl: impl,
        sleep,
      }),
    ).rejects.toThrow(/denied/i);
  });

  it.each([
    ["a missing device code", { user_code: "A", verification_uri: "u" }],
    ["a missing user code", { device_code: "d", verification_uri: "u" }],
    ["a missing verification uri", { device_code: "d", user_code: "A" }],
    ["a blank device code", { device_code: "  ", user_code: "A", verification_uri: "u" }],
  ])("refuses to start with %s", async (_label, json) => {
    const { impl } = stubFetch([{ json }]);

    await expect(
      acquireGithubToken({
        env: DEVICE_ENV,
        readGhCliToken: NO_CLI,
        promptDeviceFlow: () => {},
        fetchImpl: impl,
        sleep,
      }),
    ).rejects.toBeInstanceOf(GithubTokenUnavailableError);
  });

  it("surfaces a refusal to start the flow", async () => {
    const { impl } = stubFetch([{ status: 503, json: {} }]);

    await expect(
      acquireGithubToken({
        env: DEVICE_ENV,
        readGhCliToken: NO_CLI,
        promptDeviceFlow: () => {},
        fetchImpl: impl,
        sleep,
      }),
    ).rejects.toThrow(/503/);
  });

  it("gives up once the code has expired instead of polling forever", async () => {
    const { impl } = stubFetch([
      { json: { ...DEVICE_START.json, expires_in: 1 } },
      { json: { error: "authorization_pending" } },
    ]);

    await expect(
      acquireGithubToken({
        env: DEVICE_ENV,
        readGhCliToken: NO_CLI,
        promptDeviceFlow: () => {},
        fetchImpl: impl,
        // Real elapsed time, so the deadline is genuinely reached.
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 1100));
        },
      }),
    ).rejects.toThrow(/expired/i);
  });
});
