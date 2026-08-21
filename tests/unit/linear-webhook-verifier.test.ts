import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLinearSignature } from "~/adapters/linear/webhook-verifier.js";

const secret = "webhook-secret";
const body = JSON.stringify({ hello: "world", webhookTimestamp: 1_000_000 });
const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");

describe("verifyLinearSignature", () => {
  it("accepts a correct signature", () => {
    const result = verifyLinearSignature({
      rawBody: body,
      signature: sign(body),
      secret,
      timestampMs: 1_000_000,
      now: 1_000_000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: undefined, secret });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a wrong signature", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: sign("other body"), secret });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const result = verifyLinearSignature({ rawBody: body, signature: "abc", secret });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp", () => {
    const result = verifyLinearSignature({
      rawBody: body,
      signature: sign(body),
      secret,
      timestampMs: 1_000_000,
      now: 1_000_000 + 61_000,
      toleranceMs: 60_000,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});
