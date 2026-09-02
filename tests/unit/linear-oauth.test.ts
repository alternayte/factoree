import { describe, expect, it, vi } from "vitest";
import { createLinearOAuthClient } from "~/adapters/linear/linear-oauth.js";

const respond = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe("createLinearOAuthClient", () => {
  it("posts the refresh grant and reads the new token", async () => {
    const call = respond(200, { access_token: "new-access", refresh_token: "refresh-2", expires_in: 86_400 });
    const client = createLinearOAuthClient({
      clientId: "client-1", clientSecret: "secret-1", tokenUrl: "https://linear.test/oauth/token",
      fetch: call
    });

    const before = Date.now();
    const result = await client.refresh("refresh-1");

    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("refresh-2");
    expect(result.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 5_000);
    const [url, init] = call.mock.calls[0] as [string, { body: URLSearchParams }];
    expect(url).toBe("https://linear.test/oauth/token");
    const body = init.body.toString();
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-1");
    expect(body).toContain("client_id=client-1");
  });

  it("omits the refresh token when Linear returns none, so the caller keeps the old one", async () => {
    const call = respond(200, { access_token: "new-access" });
    const client = createLinearOAuthClient({
      clientId: "c", clientSecret: "s", fetch: call
    });

    const result = await client.refresh("refresh-1");

    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it("reports the status and never the body, because a token endpoint answers with tokens", async () => {
    const call = respond(400, { error: "invalid_grant", access_token: "leaked-value" });
    const client = createLinearOAuthClient({
      clientId: "c", clientSecret: "s", fetch: call
    });

    await expect(client.refresh("refresh-1")).rejects.toThrow("the Linear token endpoint answered 400");
    await expect(client.refresh("refresh-1")).rejects.not.toThrow(/leaked-value/);
  });

  it("rejects a response without an access token", async () => {
    const call = respond(200, { refresh_token: "refresh-2" });
    const client = createLinearOAuthClient({
      clientId: "c", clientSecret: "s", fetch: call
    });

    await expect(client.refresh("refresh-1")).rejects.toThrow(/without an access token/);
  });
});
