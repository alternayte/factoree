import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "~/adapters/github/webhook-verifier.js";

const SECRET = "a-test-secret";
const sign = (body: string | Buffer) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  it("accepts a signature computed over the same bytes", () => {
    const body = JSON.stringify({ action: "created" });
    expect(verifyGitHubSignature({ rawBody: body, signature: sign(body), secret: SECRET })).toEqual({ ok: true });
  });

  it("rejects a signature computed over different bytes", () => {
    const signed = JSON.stringify({ action: "created" });
    const sent = JSON.stringify({ action: "deleted" });
    expect(verifyGitHubSignature({ rawBody: sent, signature: sign(signed), secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a missing signature", () => {
    expect(verifyGitHubSignature({ rawBody: "{}", signature: undefined, secret: SECRET })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifyGitHubSignature({ rawBody: "{}", signature: "sha256=abcd", secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature that carries no sha256 prefix", () => {
    const body = "{}";
    const raw = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyGitHubSignature({ rawBody: body, signature: raw, secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("accepts a Buffer body with a signature computed over the same bytes", () => {
    const body = Buffer.from(JSON.stringify({ action: "created" }), "utf8");
    expect(verifyGitHubSignature({ rawBody: body, signature: sign(body), secret: SECRET })).toEqual({ ok: true });
  });

  it("rejects a Buffer body whose bytes differ from the signed ones", () => {
    const signed = Buffer.from(JSON.stringify({ action: "created" }), "utf8");
    const sent = Buffer.from(JSON.stringify({ action: "deleted" }), "utf8");
    expect(verifyGitHubSignature({ rawBody: sent, signature: sign(signed), secret: SECRET })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
