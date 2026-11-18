import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import { PRIMARY_SLUG, buildContextFixture } from "./support/context-fixture-repository.js";
import { resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
const reader = new GitRepositoryReader();

const ADR_REF = `repository:${PRIMARY_SLUG}:docs/ADR-031.md`;
const README_REF = `repository:${PRIMARY_SLUG}:README.md`;

beforeAll(async () => {
  fixture = await buildContextFixture();
  // docs/specs/context-authority-and-cited-conflicts.md. The refiner quotes both files, and the
  // resolver checks both quotes in the pinned content before the ladder decides.
  resolved = await resolveFixtureContext({
    fixture,
    reader,
    runId: "run-at-07",
    conflictReports: [
      {
        subject: "notification",
        left: { item: `${PRIMARY_SLUG} README.md`, quote: "This service owns notification retry." },
        right: { item: `${PRIMARY_SLUG} docs/ADR-031.md`, quote: "The sibling service owns notification retry." },
      },
    ],
  });
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-07. The primary README and an accepted ADR disagree about the same subject. The ADR holds
 * the higher architecture authority, so Factoree resolves the conflict itself and records the
 * decision.
 */
describe("AT-07 — a resolvable context conflict", () => {
  it("marks the README the lower authority and records the decision", () => {
    // The two items really disagree, and both really entered the initial role context. A
    // conflict between two items nobody preloaded proves nothing.
    const readme = resolved.contract.items.find((item) => item.reference.ref === README_REF);
    const adr = resolved.contract.items.find((item) => item.reference.ref === ADR_REF);
    expect(readme?.classification).toBe("required");
    expect(adr?.classification).toBe("required");
    expect(readme?.authority).toBe("repository_readme");
    expect(adr?.authority).toBe("accepted_adr");
    expect(readme?.topics).toContain("notification");
    expect(adr?.topics).toContain("notification");

    const conflict = resolved.contract.conflicts.find(
      (candidate) => candidate.subject === "notification",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.resolution).toBe("resolved");
    expect(conflict?.winnerRef).toBe(ADR_REF);
    expect(conflict?.loserRef).toBe(README_REF);
    expect(conflict?.reason).toContain(
      "accepted ADR has higher architecture authority than repository README",
    );

    // SDD section 23. No unresolved conflict remains, so the Run can continue.
    expect(resolved.unresolvedConflict).toBeNull();

    // The recorded decision reaches a human through the rendered contract.
    expect(resolved.document).toContain(`- ${conflict?.id ?? ""} on "notification"`);
    expect(resolved.document).toContain(`${ADR_REF} wins over ${README_REF}`);
    expect(resolved.document).toContain(
      "accepted ADR has higher architecture authority than repository README",
    );
  });
});
