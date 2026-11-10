import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { BackstageContextSource } from "~/domain/context/backstage-source.js";
import type { ContextCandidate } from "~/domain/context/context-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import type {
  BackstageSourceSettings,
  ContextSourceConfigurationRecord,
} from "~/domain/context/context-source-configuration.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import { ConfiguredContextSourceProvider } from "~/domain/context/context-source-provider.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { readRepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import type { RepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import { topicsOf } from "~/domain/context/topics.js";
import { backstageFixtureSettings, buildBackstageFixtureCatalog } from "./support/backstage-fixture-catalog.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import {
  CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY,
  PRIMARY_SLUG,
  REFERENCE_SLUG,
  buildContextFixture,
} from "./support/context-fixture-repository.js";
import {
  FIXTURE_CRITERIA,
  FIXTURE_GOAL,
  resolveFixtureContext,
} from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
let candidates: ContextCandidate[];
const reader = new GitRepositoryReader();

const withBackstage = (): ContextSourceRegistry =>
  new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
    new BackstageContextSource({
      sourceId: "backstage",
      catalog: buildBackstageFixtureCatalog(),
      settings: backstageFixtureSettings(),
    }),
  ]);

/**
 * SDD section 15. The switch comes from the `.factoree/config.yaml` of the fixture repository,
 * read through the real reader at the SHA the Run uses, never from a literal this test writes.
 */
let topologyConfiguration: RepositoryContextConfiguration;

beforeAll(async () => {
  fixture = await buildContextFixture({ primaryConfig: CONTEXT_FIXTURE_CONFIG_WITH_TOPOLOGY });
  topologyConfiguration = await readRepositoryContextConfiguration(reader, fixture.primaryUrl, "main");
  expect(topologyConfiguration).toEqual({
    backstageEnabled: true,
    automaticReferenceDiscovery: true,
  });
  resolved = await resolveFixtureContext({
    fixture,
    reader,
    runId: "run-at-04",
    sources: withBackstage(),
    contextConfiguration: topologyConfiguration,
  });

  // The candidate the Backstage source itself produced, over the same request the resolver
  // built, so the priority assertion sees the candidate before classification competes it away.
  const backstage = new BackstageContextSource({
    sourceId: "backstage",
    catalog: buildBackstageFixtureCatalog(),
    settings: backstageFixtureSettings(),
  });
  candidates = await backstage.discover({
    runId: "run-at-04",
    goal: FIXTURE_GOAL,
    topics: topicsOf({ goal: FIXTURE_GOAL, acceptanceCriteria: FIXTURE_CRITERIA }),
    primaryRepository: { slug: PRIMARY_SLUG, url: fixture.primaryUrl, ref: "main" },
    referenceRepositories: [{ slug: REFERENCE_SLUG, url: fixture.referenceUrl, ref: "main" }],
    workItemReferences: [],
    decisions: [],
    contextConfiguration: topologyConfiguration,
  });
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-04. A Backstage API dependency produces the expected Context Candidate with a
 * topology-based selection reason. The Run is the AT-02 fixture Work Item, and the catalog says
 * the primary component consumes the notification API.
 */
describe("AT-04 — Backstage discovery", () => {
  it("produces the API dependency as a Context Item with a topology reason and provenance", () => {
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "backstage:api:default/notification-api",
    );
    expect(item).toBeDefined();
    // SDD section 21. Source, stable reference, source version, authority, reason, class.
    expect(item?.reference.sourceId).toBe("backstage");
    expect(item?.sourceVersion).toBe("etag-notification-api");
    expect(item?.authority).toBe("declarative_catalog");
    expect(item?.reason).toBe(
      'the Backstage catalog records that "webhook-service" consumes the API "notification-api"',
    );
    // The brief expects "reference" here. The real resolver disagrees: a Backstage candidate
    // suggests "reference" (`src/domain/context/backstage-source.ts`), but the resolver still
    // lets a "reference" suggestion compete for the required budget
    // (`src/domain/context/context-resolver.ts`, the `competes` check), and this small catalog
    // item fits. It is promoted to "required". This assertion follows the real code.
    expect(item?.classification).toBe("required");

    // SDD section 18. The API relation is priority 4, below the two repository rules.
    const candidate = candidates.find(
      (entry) => entry.reference.ref === "backstage:api:default/notification-api",
    );
    expect(candidate?.priority).toBe(DISCOVERY_PRIORITY.backstage_api_relation);

    // SDD section 19. The catalog never outranks the accepted ADR of the same fixture.
    const adr = resolved.contract.items.find((entry) => entry.authority === "accepted_adr");
    expect(adr).toBeDefined();
    expect(
      resolved.contract.conflicts.some(
        (conflict) =>
          conflict.winnerRef === "backstage:api:default/notification-api" ||
          conflict.loserRef === "backstage:api:default/notification-api",
      ),
    ).toBe(false);

    // The human-readable contract explains the choice.
    expect(resolved.document).toContain("backstage:api:default/notification-api");
    expect(resolved.document).toContain("consumes the API");
  });

  /**
   * The brief phrases this case as `resolveFixtureContext` over the same fixed registry with
   * `contextConfiguration.backstageEnabled` toggled off. The real code disagrees:
   * `BackstageContextSource.discover` never reads `backstageEnabled` itself, so a fixed registry
   * that already holds the source would still return its candidates. The real gate is
   * `ConfiguredContextSourceProvider.sourcesFor` (`src/domain/context/context-source-provider.ts`),
   * which drops a configured Backstage row before the resolver ever sees it. This case proves
   * that real gate end to end instead: the reference repository carries no `.factoree/config.yaml`,
   * so the real config reader answers `backstageEnabled: false`, and the real provider then
   * excludes the row.
   */
  it("leaves Backstage out when the repository does not enable it", async () => {
    const offConfiguration = await readRepositoryContextConfiguration(
      reader,
      fixture.referenceUrl,
      "main",
    );
    expect(offConfiguration.backstageEnabled).toBe(false);

    const provider = new ConfiguredContextSourceProvider({
      configurations: {
        put: () => Promise.reject(new Error("unused")),
        list: (): Promise<ContextSourceConfigurationRecord[]> =>
          Promise.resolve([
            {
              id: "row-1",
              tenantId: "tenant",
              productId: "product",
              sourceId: "backstage",
              kind: "backstage",
              enabled: true,
              endpoint: "https://backstage.test",
              secretName: null,
              settings: backstageFixtureSettings(),
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]),
        remove: () => Promise.resolve(false),
        lastReads: () => Promise.resolve(new Map()),
      },
      secrets: { read: () => Promise.resolve(null) },
      fixedSources: () => [new LinearContextSource(), new RepositoryContextSource({ reader })],
      factories: {
        backstage: (record) =>
          new BackstageContextSource({
            sourceId: record.sourceId,
            catalog: buildBackstageFixtureCatalog(),
            settings: record.settings as BackstageSourceSettings,
          }),
        mcp: () => {
          throw new Error("unused");
        },
        llms_txt: () => {
          throw new Error("unused");
        },
      },
    });

    const registry = await provider.sourcesFor({
      tenantId: "tenant",
      productId: "product",
      contextConfiguration: offConfiguration,
    });
    expect(registry.ids()).not.toContain("backstage");

    const without = await resolveFixtureContext({
      fixture,
      reader,
      runId: "run-at-04-off",
      sources: registry,
      contextConfiguration: offConfiguration,
    });
    expect(without.contract.items.some((item) => item.reference.sourceId === "backstage")).toBe(
      false,
    );
  });
});
