import { describe, expect, it } from "vitest";
import type { ProductRecord } from "~/domain/products/product-registry.js";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
import { resolveProduct } from "~/domain/routing/resolve-product.js";
import { selectTarget } from "~/domain/routing/select-targets.js";

const product = (id: string, linearTeamId: string): ProductRecord => ({
  id,
  tenantId: "tenant-1",
  slug: id,
  name: id,
  status: "active" as const,
  linearTeamKey: "PAY",
  linearTeamId,
  defaultAutonomy: "L3",
  riskCaps: null,
  allowedDomains: [],
  maxRunMinutes: 90,
  organizationSkillsRepository: null,
  skillRegistry: null,
  model: null,
  effort: { implementer: null, refiner: null, validator: null, reviewer: null, setup: null },
  silenceMinutes: 10,
  sandboxRetentionHours: 24,
  maxConcurrentRuns: 2, appChangeIssues: "one_per_change",
  createdAt: new Date(),
  updatedAt: new Date(),
});

const repository = (fullName: string): RepositoryRecord => ({
  id: fullName,
  tenantId: "tenant-1",
  productId: "checkout",
  fullName,
  defaultBranch: "main",
  configSha: "aaa",
  requestedSecretNames: [],
  linearProjects: [],
  discoveredAt: new Date(),
  lastSeenAt: new Date(),
  absentSince: null,
  githubInstallationId: "install-1",
});

describe("resolveProduct", () => {
  it("routes to the one Product that claims the team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], "team-pay");
    expect(outcome.kind).toBe("routed");
    if (outcome.kind !== "routed") throw new Error("unreachable: asserted above");
    expect(outcome.product.id).toBe("checkout");
  });

  it("refuses when no Product claims the team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], "team-other");
    expect(outcome.kind).toBe("refused");
  });

  it("refuses when two Products claim the team", () => {
    const outcome = resolveProduct([product("a", "team-pay"), product("b", "team-pay")], "team-pay");
    expect(outcome.kind).toBe("refused");
  });

  it("refuses when the issue carries no team", () => {
    const outcome = resolveProduct([product("checkout", "team-pay")], null);
    expect(outcome.kind).toBe("refused");
  });
});

describe("selectTarget", () => {
  it("selects the sole member with no proposal and no notice", () => {
    const outcome = selectTarget([repository("acme/api")], null);
    expect(outcome).toMatchObject({ kind: "selected", reason: "sole member", notify: false });
    if (outcome.kind !== "selected") throw new Error("unreachable: asserted above");
    expect(outcome.repository.fullName).toBe("acme/api");
  });

  it("selects a confident proposal, and asks for a notice", () => {
    const outcome = selectTarget([repository("acme/api"), repository("acme/web")], {
      fullName: "acme/web",
      reason: "the change is in the checkout form",
      confident: true,
    });
    expect(outcome).toMatchObject({ kind: "selected", notify: true });
  });

  it("reports ambiguity when the proposal is not confident", () => {
    const outcome = selectTarget([repository("acme/api"), repository("acme/web")], {
      fullName: "acme/web",
      reason: "unsure",
      confident: false,
    });
    expect(outcome.kind).toBe("ambiguous");
  });

  it("reports ambiguity when the proposal names a repository outside the Product", () => {
    const outcome = selectTarget([repository("acme/api"), repository("acme/web")], {
      fullName: "acme/unknown",
      reason: "guess",
      confident: true,
    });
    expect(outcome.kind).toBe("ambiguous");
  });
});
