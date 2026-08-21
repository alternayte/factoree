import { createHmac, timingSafeEqual } from "node:crypto";

export type LinearSignatureFailure = "missing_signature" | "bad_signature" | "stale_timestamp";

export type LinearSignatureResult = { ok: true } | { ok: false; reason: LinearSignatureFailure };

export interface VerifyLinearSignatureInput {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
  timestampMs?: number;
  now?: number;
  toleranceMs?: number;
}

const DEFAULT_TOLERANCE_MS = 60_000;

export const verifyLinearSignature = (input: VerifyLinearSignatureInput): LinearSignatureResult => {
  if (!input.signature) return { ok: false, reason: "missing_signature" };

  const expected = createHmac("sha256", input.secret)
    .update(typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody)
    .digest();
  // Buffer.from with hex encoding stops at the first invalid pair instead of throwing.
  // The length check below is therefore what rejects a malformed signature.
  const provided = Buffer.from(input.signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (input.timestampMs !== undefined) {
    const now = input.now ?? Date.now();
    const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    if (Math.abs(now - input.timestampMs) > tolerance) return { ok: false, reason: "stale_timestamp" };
  }

  return { ok: true };
};
