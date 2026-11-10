import { describe, expect, it } from "vitest";
import { gateMissingHosts, renderMissingHostsFailure } from "~/domain/runs/egress.js";
import { parseImplementerResult } from "~/domain/runs/implementer-result.js";
import { parseRefinerProposal } from "~/domain/refinement/refiner-proposal.js";
import { egressBody } from "~/prompts/egress.js";

// docs/specs/egress-honesty-and-issue-status.md. In FAC-101 nuget was on the bootstrap list only.
describe("the missing hosts gate (DI-21.48)", () => {
  it("drops a host the effective allow list holds, a wildcard included, and keeps every other host once", () => {
    const gate = gateMissingHosts(
      [
        { host: "https://api.nuget.org/v3/index.json", reason: "dotnet tool restore needs it" },
        { host: "API.NUGET.ORG:443", reason: "again" },
        { host: "registry.npmjs.org", reason: "the agent saw a TLS reset" },
        { host: "cdn.example.com", reason: "a wildcard covers it" },
        { host: "  ", reason: "no host" },
      ],
      ["registry.npmjs.org", "*.example.com", "api.anthropic.com"],
    );
    expect(gate.missing).toEqual([{ host: "api.nuget.org", reason: "dotnet tool restore needs it" }]);
    expect(gate.dropped.map((entry) => entry.host)).toEqual(["registry.npmjs.org", "cdn.example.com"]);
  });

  it("names the repository list only when the repository declares one", () => {
    const base = {
      role: "refiner" as const,
      hosts: [{ host: "api.nuget.org", reason: "restore" }],
      productSlug: "factoree-test",
      productPageUrl: "https://factoree.example/products/p1",
      repositorySlug: "alternayte/anthology",
    };
    const productOnly = renderMissingHostsFailure({ ...base, repositoryListDeclared: false });
    expect(productOnly).toContain("- `api.nuget.org`: restore");
    expect(productOnly).toContain("https://factoree.example/products/p1");
    expect(productOnly).not.toContain("sandbox.allowedDomains");
    expect(renderMissingHostsFailure({ ...base, repositoryListDeclared: true })).toContain(
      "The repository alternayte/anthology declares `sandbox.allowedDomains`",
    );
  });
});

describe("the agent result fields (DI-21.47)", () => {
  it("reads missingHosts from a refiner proposal, and none from an older one", () => {
    const older = { criteria: [], questions: [], patterns: [] };
    expect(parseRefinerProposal(JSON.stringify(older)).missingHosts).toEqual([]);
    const named = { ...older, missingHosts: [{ host: "api.nuget.org", reason: "restore" }] };
    expect(parseRefinerProposal(JSON.stringify(named)).missingHosts).toEqual([{ host: "api.nuget.org", reason: "restore" }]);
  });

  it("reads the implementer result, and answers null for a file that is not one", () => {
    expect(parseImplementerResult('{"missingHosts":[{"host":"api.nuget.org"}],"note":"x"}')).toEqual([
      { host: "api.nuget.org", reason: "" },
    ]);
    expect(parseImplementerResult("not json")).toBeNull();
  });
});

describe("the network access prompt text (DI-21.46)", () => {
  it("states the effective allow list and the bootstrap-only hosts as denied", () => {
    const text = egressBody({ allowed: ["api.anthropic.com", "registry.npmjs.org"], bootstrapOnly: ["api.nuget.org"] }, "Name it.");
    expect(text).toContain("- api.anthropic.com\n- registry.npmjs.org");
    expect(text).toContain("applies to the bootstrap only");
    expect(text).toContain("these hosts are denied now: api.nuget.org.");
    expect(text).toContain("a connection reset, a TLS error or a timeout");
    expect(text).not.toMatch(/- api\.nuget\.org/);
  });
});
