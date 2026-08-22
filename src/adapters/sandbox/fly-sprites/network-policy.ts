import type { NetworkPolicy } from "~/domain/runs/sandbox.js";
import { normalizeNetworkPolicy } from "~/domain/runs/sandbox.js";

export interface SpritesPolicyRule {
  domain: string;
  action: "allow" | "deny";
}

export interface SpritesNetworkPolicy {
  rules: SpritesPolicyRule[];
}

/**
 * SDD section 29 denies arbitrary outbound network access. The document therefore always ends
 * with a deny-all rule. Factoree never sends an empty policy.
 */
export const toSpritesNetworkPolicy = (policy: NetworkPolicy): SpritesNetworkPolicy => {
  const normalized = normalizeNetworkPolicy(policy);
  return {
    rules: [
      ...normalized.allowedDomains.map((domain): SpritesPolicyRule => ({ domain, action: "allow" })),
      { domain: "*", action: "deny" },
    ],
  };
};
