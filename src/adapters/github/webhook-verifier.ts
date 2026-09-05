import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubSignatureFailure = "missing_signature" | "bad_signature";
export type GitHubSignatureResult = { ok: true } | { ok: false; reason: GitHubSignatureFailure };

const PREFIX = "sha256=";

export const verifyGitHubSignature = (input: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): GitHubSignatureResult => {
  if (input.signature === undefined) return { ok: false, reason: "missing_signature" };
  if (!input.signature.startsWith(PREFIX)) return { ok: false, reason: "bad_signature" };

  const expected = createHmac("sha256", input.secret)
    .update(typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody)
    .digest();
  // Buffer.from with hex encoding stops at the first invalid pair instead of throwing. The
  // length check is therefore what rejects a malformed signature. timingSafeEqual throws on a
  // length mismatch, so the check must come first.
  const provided = Buffer.from(input.signature.slice(PREFIX.length), "hex");
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
};
