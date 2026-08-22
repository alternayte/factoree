import { describe, expect, it } from "vitest";
import { toSpritesNetworkPolicy } from "~/adapters/sandbox/fly-sprites/network-policy.js";

describe("toSpritesNetworkPolicy", () => {
  it("denies every domain when nothing is allowed", () => {
    expect(toSpritesNetworkPolicy({ allowedDomains: [] })).toEqual({
      rules: [{ domain: "*", action: "deny" }],
    });
  });

  it("places the deny-all rule last so it cannot shadow an allow rule", () => {
    const document = toSpritesNetworkPolicy({ allowedDomains: ["registry.npmjs.org", "api.github.com"] });
    expect(document.rules).toEqual([
      { domain: "api.github.com", action: "allow" },
      { domain: "registry.npmjs.org", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
  });

  it("normalizes the domains before it builds the document", () => {
    const document = toSpritesNetworkPolicy({ allowedDomains: ["Registry.NPMJS.org", "registry.npmjs.org"] });
    expect(document.rules).toEqual([
      { domain: "registry.npmjs.org", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
  });
});
