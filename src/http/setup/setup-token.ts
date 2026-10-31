import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { InstallSettingsStore } from "~/domain/settings/install-settings.js";

const hash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * docs/specs/release-0-1-0.md and DI-14.51. On a start with no completed setup the API issues a
 * new setup token, stores only its SHA-256, and returns the token for the one log line. A
 * restart before setup ends issues a new token, and the old one stops working. A completed setup
 * clears the hash, so no token works again.
 */
export const issueSetupToken = async (settings: InstallSettingsStore): Promise<string | null> => {
  const current = await settings.read();
  if (current.setupCompletedAt !== null) return null;
  const token = randomBytes(24).toString("base64url");
  await settings.storeSetupTokenHash(hash(token));
  return token;
};

export type SetupTokenCheck = "valid" | "invalid" | "setup_complete";

export const checkSetupToken = async (settings: InstallSettingsStore, presented: string | null): Promise<SetupTokenCheck> => {
  const current = await settings.read();
  if (current.setupCompletedAt !== null) return "setup_complete";
  const stored = await settings.setupTokenHash();
  if (stored === null || presented === null || presented.length === 0) return "invalid";
  return equal(stored, hash(presented)) ? "valid" : "invalid";
};

/**
 * The `state` of a redirect to GitHub or Linear. The callback carries no setup token and no
 * session, so the state proves that a setup token holder, or a signed-in admin, started the
 * flow. It is an HMAC under a key derived from the master key, with a purpose and an expiry.
 */
export type FlowPurpose = "setup" | "workspace";

const STATE_LIFETIME_MS = 30 * 60_000;

const stateKey = (masterKey: string): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "hex"), Buffer.alloc(0), "factoree-flow-state", 32));

export const signFlowState = (masterKey: string, purpose: FlowPurpose, now = Date.now()): string => {
  const payload = Buffer.from(
    JSON.stringify({ purpose, exp: now + STATE_LIFETIME_MS, nonce: randomBytes(12).toString("base64url") }),
  ).toString("base64url");
  const mac = createHmac("sha256", stateKey(masterKey)).update(payload).digest("base64url");
  return `${payload}.${mac}`;
};

export const readFlowState = (masterKey: string, state: string, now = Date.now()): FlowPurpose | null => {
  const [payload, mac] = state.split(".");
  if (payload === undefined || mac === undefined) return null;
  const expected = createHmac("sha256", stateKey(masterKey)).update(payload).digest("base64url");
  if (!equal(expected, mac)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { purpose?: unknown; exp?: unknown };
    if (typeof parsed.exp !== "number" || parsed.exp < now) return null;
    return parsed.purpose === "setup" || parsed.purpose === "workspace" ? parsed.purpose : null;
  } catch {
    return null;
  }
};
