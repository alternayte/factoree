import { describe, expect, it } from "vitest";
import { NetworkPolicyNotEnforcedError, normalizeNetworkPolicy } from "~/domain/runs/sandbox.js";

describe("normalizeNetworkPolicy", () => {
  it("lowercases and deduplicates allowed domains", () => {
    const policy = normalizeNetworkPolicy({ allowedDomains: ["Registry.NPMJS.org", "registry.npmjs.org"] });
    expect(policy.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  it("keeps an empty allow list, which denies all egress", () => {
    expect(normalizeNetworkPolicy({ allowedDomains: [] }).allowedDomains).toEqual([]);
  });

  it("rejects a domain that carries a scheme or a path", () => {
    expect(() => normalizeNetworkPolicy({ allowedDomains: ["https://registry.npmjs.org/x"] })).toThrow(
      /domain must be a host name/,
    );
  });

  it("sorts domains so the policy document is stable", () => {
    const policy = normalizeNetworkPolicy({ allowedDomains: ["b.example.com", "a.example.com"] });
    expect(policy.allowedDomains).toEqual(["a.example.com", "b.example.com"]);
  });

  it("accepts the conventional wildcard form", () => {
    const policy = normalizeNetworkPolicy({ allowedDomains: ["*.example.com"] });
    expect(policy.allowedDomains).toEqual(["*.example.com"]);
  });

  it("rejects a wildcard label with no dot, which no adapter gives a meaning to", () => {
    expect(() => normalizeNetworkPolicy({ allowedDomains: ["*example.com"] })).toThrow(
      /domain must be a host name/,
    );
  });

  it("rejects a bare wildcard, which would allow every domain", () => {
    expect(() => normalizeNetworkPolicy({ allowedDomains: ["*"] })).toThrow(/domain must be a host name/);
  });
});

describe("NetworkPolicyNotEnforcedError", () => {
  it("names the adapter that cannot enforce egress", () => {
    const error = new NetworkPolicyNotEnforcedError("LocalProcessSandbox");
    expect(error.message).toContain("LocalProcessSandbox");
    expect(error.name).toBe("NetworkPolicyNotEnforcedError");
  });
});
