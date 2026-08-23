import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import {
  PRIMARY_SLUG,
  REFERENCE_SLUG,
  buildContextFixture,
} from "./support/context-fixture-repository.js";

let fixture: ContextFixture;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture();
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-02. A technically vague Work Item with a clear intent is enriched with the correct primary
 * repository, at least one relevant implementation pattern, and candidate acceptance assertions.
 * Refinement changes no source code.
 */
describe("AT-02 — refinement of a vague Work Item", () => {
  it("enriches a vague Work Item and changes no source code", async () => {
    const head = () =>
      execFileSync("git", ["-C", fixture.primaryPath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    const before = head();

    // The Work Item names no file, no module, and no repository. It states the intent only.
    const refined = new RefinementEngine().refine({
      source: {
        issueId: "issue-1",
        title: "Notification retry is broken",
        description: "A failed notification delivery is never retried. Users lose messages.",
        url: "https://linear.app/acme/issue/ACME-1",
        labels: [],
      },
      project: {
        primaryRepository: PRIMARY_SLUG,
        referenceRepositories: [REFERENCE_SLUG],
        defaultAutonomy: "L3",
      },
      decisions: [],
    });

    // The correct primary repository, taken from the Project record and not invented.
    expect(refined.primaryRepository).toBe(PRIMARY_SLUG);
    expect(refined.referenceRepositories).toEqual([REFERENCE_SLUG]);
    expect(refined.status).toBe("ready");

    // Candidate acceptance assertions. SDD section 7 forbids Factoree to invent product
    // behavior, so each candidate restates a sentence the author wrote, and each one is marked
    // as derived so a human can see it is a proposal.
    expect(refined.proposedAcceptanceCriteria.length).toBeGreaterThan(0);
    for (const criterion of refined.proposedAcceptanceCriteria) {
      expect(criterion.source).toBe("derived:goal");
      expect(refined.goal).toContain(criterion.statement);
    }
    expect(refined.proposedAcceptanceCriteria.map((criterion) => criterion.statement)).toContain(
      "A failed notification delivery is never retried.",
    );

    const resolved = await new ContextResolver({
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
      ]),
    }).resolve({
      runId: "run-at-02",
      goal: refined.goal,
      acceptanceCriteria: refined.proposedAcceptanceCriteria.map((criterion) => criterion.statement),
      primaryRepository: { slug: PRIMARY_SLUG, url: fixture.primaryUrl, ref: "main" },
      referenceRepositories: [
        { slug: REFERENCE_SLUG, url: fixture.referenceUrl, ref: "main" },
      ],
      workItemReferences: [],
      decisions: [],
    });

    const preloaded = resolved.contract.items.filter((item) => item.classification === "required");
    const paths = preloaded.map((item) => item.reference.path);

    // At least one relevant implementation pattern reaches the initial role context.
    expect(paths).toContain("src/retry.ts");
    // The relevant existing test reaches it as well.
    expect(paths).toContain("tests/retry.test.ts");
    // Both were selected from the primary repository the Project names.
    const pattern = preloaded.find((item) => item.reference.path === "src/retry.ts");
    expect(pattern?.reference.repository).toBe(PRIMARY_SLUG);
    expect(pattern?.authority).toBe("source_code");

    // No source code changed. The Refinement engine holds no port, and the repository reader
    // only reads.
    expect(head()).toBe(before);
    expect(
      execFileSync("git", ["-C", fixture.primaryPath, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
  });
});
