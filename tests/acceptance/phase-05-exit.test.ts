import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { backstageFixtureSettings, buildBackstageFixtureCatalog } from "./support/backstage-fixture-catalog.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import {
  CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY,
  buildContextFixture,
} from "./support/context-fixture-repository.js";
import { resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture({ primaryConfig: CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY });

  const sources = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
    new BackstageContextSource({
      sourceId: "backstage",
      catalog: buildBackstageFixtureCatalog(),
      settings: backstageFixtureSettings(),
    }),
  ]);

  resolved = await resolveFixtureContext({
    fixture,
    reader,
    runId: "run-p5-exit",
    sources,
    contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
  });
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * SDD section 69, Phase 5 exit: a fixture dependency can be discovered from Backstage with
 * provenance. One assertion block, over one resolution of the fixture Project.
 */
describe("Phase 5 exit condition — a fixture dependency can be discovered from Backstage with provenance", () => {
  it("discovers a fixture dependency from Backstage with provenance", () => {
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "backstage:api:default/notification-api",
    );
    expect(item).toBeDefined();
    expect(item?.reference.sourceId).toBe("backstage");
    expect(item?.sourceVersion).toBe("etag-notification-api");
    expect(item?.authority).toBe("declarative_catalog");
    expect(item?.reason).toContain("the Backstage catalog records");
    expect(item?.classification).not.toBe("");
  });

  it("pins the reference repository the catalog named, at an explicit SHA", () => {
    // SDD section 20. Automatic discovery is on in this fixture.
    const reference = resolved.contract.referenceRepositories.find(
      (repository) => repository.repo === "acme/notification-service",
    );
    expect(reference?.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
