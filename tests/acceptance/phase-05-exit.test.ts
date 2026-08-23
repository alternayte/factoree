import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import type { RepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { readRepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import { backstageFixtureSettings, buildBackstageFixtureCatalog } from "./support/backstage-fixture-catalog.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import {
  CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY,
  DISCOVERED_SLUG,
  buildContextFixture,
} from "./support/context-fixture-repository.js";
import { resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
let configuration: RepositoryContextConfiguration;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture({
    primaryConfig: CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY,
    withDiscoveredRepository: true,
    urlStyle: "file",
  });

  const sources = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
    new BackstageContextSource({
      sourceId: "backstage",
      catalog: buildBackstageFixtureCatalog({
        discoveredRepositoryUrl: fixture.discoveredUrl ?? "",
      }),
      settings: backstageFixtureSettings(),
    }),
  ]);

  // SDD section 15. The configuration comes from the `.factoree/config.yaml` of the fixture
  // repository, read at the SHA the Run uses, never from a literal this test writes. This is the
  // real path a Run takes, so the exit condition proves the switch and not a hand-written flag.
  configuration = await readRepositoryContextConfiguration(reader, fixture.primaryUrl, "main");

  resolved = await resolveFixtureContext({
    fixture,
    reader,
    runId: "run-p5-exit",
    sources,
    contextConfiguration: configuration,
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
    // The same value AT-04 asserts: the small catalog item fits the required budget.
    expect(item?.classification).toBe("required");
  });

  it("reads the switch from the repository configuration, not from the test", () => {
    // SDD section 15 and SDD section 19. The fixture writes `backstage.enabled: true`.
    expect(configuration).toEqual({ backstageEnabled: true, automaticReferenceDiscovery: true });
  });

  it("pins the reference repository the catalog named, at an explicit SHA", () => {
    // SDD section 20. The catalog names this repository, and the Project configures only
    // `acme/notification-service`, so only automatic discovery can put this row in the contract.
    const reference = resolved.contract.referenceRepositories.find(
      (repository) => repository.repo === DISCOVERED_SLUG,
    );
    expect(reference).toBeDefined();
    expect(reference?.reason).toBe(
      "the Backstage catalog names this repository as a location of a related component",
    );
    expect(reference?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(reference?.sha).toBe(fixture.discoveredSha);
  });
});
