import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppTokenProvider, GitHubAppAuthError } from "~/adapters/github/app-token-provider.js";

const privateKeyBase64 = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
})();

const build = (overrides: { status?: number; expiresInMs?: number; now?: () => number } = {}) => {
  const calls: string[] = [];
  let minted = 0;
  const provider = new GitHubAppTokenProvider({
    appId: "123456",
    privateKeyBase64,
    fetch: ((url: string) => {
      calls.push(String(url));
      if (overrides.status !== undefined && overrides.status !== 201) {
        return Promise.resolve(new Response("", { status: overrides.status }));
      }
      minted += 1;
      const expiresAt = new Date((overrides.now?.() ?? 0) + (overrides.expiresInMs ?? 3_600_000));
      return Promise.resolve(
        new Response(JSON.stringify({ token: `ghs_token_${String(minted)}`, expires_at: expiresAt.toISOString() }), {
          status: 201,
        }),
      );
    }) as unknown as typeof fetch,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  return { provider, calls, minted: () => minted };
};

describe("GitHubAppTokenProvider", () => {
  it("mints a token for one installation", async () => {
    const { provider, calls } = build({ now: () => 0 });

    expect(await provider.tokenForInstallation("42")).toBe("ghs_token_1");
    expect(calls[0]).toContain("/app/installations/42/access_tokens");
  });

  it("reuses a cached token while it has more than five minutes left", async () => {
    const { provider, minted } = build({ now: () => 0 });

    await provider.tokenForInstallation("42");
    await provider.tokenForInstallation("42");

    expect(minted()).toBe(1);
  });

  it("mints again when under five minutes remain", async () => {
    let clock = 0;
    const { provider, minted } = build({ now: () => clock, expiresInMs: 600_000 });

    await provider.tokenForInstallation("42");
    clock = 350_000;
    await provider.tokenForInstallation("42");

    expect(minted()).toBe(2);
  });

  it("keeps one installation's token away from another", async () => {
    const { provider } = build({ now: () => 0 });

    const first = await provider.tokenForInstallation("42");
    const second = await provider.tokenForInstallation("43");

    expect(first).not.toBe(second);
  });

  it("names the installation and the status on a failure, never the key", async () => {
    const { provider } = build({ status: 401 });

    const error = await provider.tokenForInstallation("42").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubAppAuthError);
    const message = (error as Error).message;
    expect(message).toContain("42");
    expect(message).toContain("401");
    expect(message).not.toContain(privateKeyBase64);
    expect(message).not.toContain("PRIVATE KEY");
  });

  it("de-duplicates concurrent calls for one installation into a single mint", async () => {
    let minted = 0;
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const provider = new GitHubAppTokenProvider({
      appId: "123456",
      privateKeyBase64,
      now: () => 0,
      fetch: (async () => {
        await gate;
        minted += 1;
        const expiresAt = new Date(3_600_000);
        return new Response(
          JSON.stringify({ token: `ghs_token_${String(minted)}`, expires_at: expiresAt.toISOString() }),
          { status: 201 },
        );
      }),
    });

    const first = provider.tokenForInstallation("42");
    const second = provider.tokenForInstallation("42");
    releaseFetch?.();

    const [firstToken, secondToken] = await Promise.all([first, second]);
    expect(firstToken).toBe(secondToken);
    expect(minted).toBe(1);
  });

  it("retries after a failed in-flight mint instead of replaying the failure", async () => {
    let attempt = 0;
    const provider = new GitHubAppTokenProvider({
      appId: "123456",
      privateKeyBase64,
      now: () => 0,
      fetch: (() => {
        attempt += 1;
        if (attempt === 1) return Promise.resolve(new Response("", { status: 500 }));
        const expiresAt = new Date(3_600_000);
        return Promise.resolve(
          new Response(JSON.stringify({ token: "ghs_token_recovered", expires_at: expiresAt.toISOString() }), {
            status: 201,
          }),
        );
      }),
    });

    await expect(provider.tokenForInstallation("42")).rejects.toBeInstanceOf(GitHubAppAuthError);
    expect(await provider.tokenForInstallation("42")).toBe("ghs_token_recovered");
    expect(attempt).toBe(2);
  });

  it("de-duplicates per installation, minting once for each", async () => {
    const { provider } = build({ now: () => 0 });

    const [first, second] = await Promise.all([
      provider.tokenForInstallation("42"),
      provider.tokenForInstallation("43"),
    ]);

    expect(first).not.toBe(second);
  });
});
