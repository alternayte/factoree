import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";
import type { RepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextFixture } from "./context-fixture-repository.js";
import { PRIMARY_SLUG, REFERENCE_SLUG } from "./context-fixture-repository.js";

/** The goal every Phase 4 acceptance test resolves against. It states the same intent as AT-02. */
export const FIXTURE_GOAL = "Retry a failed notification delivery.";

/** The acceptance criterion of that goal. */
export const FIXTURE_CRITERIA = ["A failed notification is retried."];

export interface ResolveFixtureContextInput {
  fixture: ContextFixture;
  reader: RepositoryReader;
  runId: string;
  decisions?: RecordedDecision[];
  /** Defaults to Linear plus the two repository sources of Phase 4. Task 10 adds Backstage. */
  sources?: ContextSourceRegistry;
  contextConfiguration?: RepositoryContextConfiguration;
}

/**
 * Resolves the context of the fixture Project through the real resolver and the real repository
 * sources. AT-06, AT-07, and AT-09 all assert on one resolution of one fixture, so they share
 * this call and cannot drift apart.
 */
export const resolveFixtureContext = (
  input: ResolveFixtureContextInput,
): Promise<ResolvedContext> =>
  new ContextResolver().resolve({
    runId: input.runId,
    goal: FIXTURE_GOAL,
    acceptanceCriteria: FIXTURE_CRITERIA,
    primaryRepository: { slug: PRIMARY_SLUG, url: input.fixture.primaryUrl, ref: "main" },
    referenceRepositories: [
      { slug: REFERENCE_SLUG, url: input.fixture.referenceUrl, ref: "main" },
    ],
    workItemReferences: [],
    decisions: input.decisions ?? [],
    sources:
      input.sources ??
      new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader: input.reader }),
      ]),
    contextConfiguration: input.contextConfiguration ?? DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  });
