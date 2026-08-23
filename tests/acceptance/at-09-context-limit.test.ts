import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { requiredContextLines } from "~/domain/context/context-contract.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import { renderImplementerPrompt } from "~/prompts/implementer.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import {
  LARGE_FILE_BYTES,
  LARGE_FILE_MARKER,
  LARGE_FILE_PATH,
  PRIMARY_SLUG,
  REFERENCE_SLUG,
  buildContextFixture,
} from "./support/context-fixture-repository.js";
import { FIXTURE_GOAL, resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
const reader = new GitRepositoryReader();

const REFERENCE_PATH = "/workspace/reference/notification-service";

beforeAll(async () => {
  fixture = await buildContextFixture();
  resolved = await resolveFixtureContext({ fixture, reader, runId: "run-at-09" });
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-09. A large repository is referenced and tool-accessible, and Factoree does not copy it in
 * full into the initial agent prompt.
 */
describe("AT-09 — the context limit", () => {
  it("references the large repository and its large file without preloading either", () => {
    // The reference repository is referenced at an explicit SHA. A repository is never
    // preloaded, so the resolver classifies it `discoverable`.
    const repository = resolved.contract.items.find(
      (item) => item.reference.ref === `repository:${REFERENCE_SLUG}`,
    );
    expect(repository).toBeDefined();
    expect(repository?.reference.sha).toBe(fixture.referenceSha);
    expect(repository?.classification).toBe("discoverable");

    // The large file is above the context budget, so it stays out of the initial role context
    // and stays visible to a human and to a tool.
    const large = resolved.contract.items.find(
      (item) => item.reference.path === LARGE_FILE_PATH,
    );
    expect(large).toBeDefined();
    expect(large?.classification).toBe("discoverable");
    expect(large?.reference.sha).toBe(fixture.primarySha);
    // The context budget excluded it before any read. The resolver never fetched the file, so
    // the large content never entered the control plane at all.
    expect(large?.reason).not.toContain("could not be read");
    expect(large?.contentSha256).toBeNull();
    expect(resolved.document).toContain(LARGE_FILE_PATH);
  });

  it("keeps every file body out of the initial Implementer prompt", () => {
    const prompt = renderImplementerPrompt({
      goal: FIXTURE_GOAL,
      humanDecisions: [],
      validationContract: null,
      contextContract: resolved.document,
      requiredContext: requiredContextLines(resolved.contract),
      primaryRepositoryPath: "/workspace/primary",
      referenceRepositoryPaths: [REFERENCE_PATH],
      repositoryInstructions: "",
      skills: [],
      actionPolicyLines: [],
      repairFindings: [],
    });

    // SDD section 55. The rendered contract names paths and hashes and holds no file body.
    // The marker sits in the large file, which the budget demoted. The README line sits in a
    // file the budget preloaded, so it proves the rule for a selected item as well.
    expect(prompt).not.toContain(LARGE_FILE_MARKER);
    expect(prompt).not.toContain("This service owns notification retry.");
    expect(prompt.length).toBeLessThan(LARGE_FILE_BYTES);

    // The prompt still names the large file and the repository that holds it, so the
    // Implementer can reach both with a tool.
    expect(prompt).toContain(LARGE_FILE_PATH);
    expect(prompt).toContain(`${PRIMARY_SLUG} at ${fixture.primarySha}`);
    expect(prompt).toContain(`${REFERENCE_SLUG} at ${fixture.referenceSha}`);
    expect(prompt).toContain(REFERENCE_PATH);
  });
});
