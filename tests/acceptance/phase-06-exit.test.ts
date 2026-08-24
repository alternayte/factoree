import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createValidationActivities } from "~/activities/validation.activities.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;
let contracts: PrismaValidationContractStore;
let runs: PrismaRunRepository;

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
  contracts = new PrismaValidationContractStore(prisma);
  runs = new PrismaRunRepository(prisma);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

/**
 * SDD section 69, Phase 6 exit: every implementation starts after a frozen Validation Contract
 * exists. The first test drives a Work Item through Refinement to the real freeze activity, and
 * on to the Implementer prompt. The second test proves that a Work Item with no observable
 * assertion freezes nothing, and leaves the Run hash null.
 */
describe("Phase 6 exit — every implementation starts after a frozen Validation Contract", () => {
  it("runs the whole path from a Work Item to a frozen contract the Implementer receives", async () => {
    const { tenantId, projectId, runId } = await seedTenantProjectAndRun(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    const refined = new RefinementEngine().refine({
      source: {
        issueId: "ENG-300",
        title: "Publish a report",
        description:
          "## Goal\n\nA signed-in editor can publish a report.\n\n" +
          "## Acceptance Criteria\n\n" +
          "- AC-1: GET /reports/{id} returns 200 with the published report body.\n" +
          "- AC-2: The reports page shows a Published banner after publishing.\n",
        url: null,
        labels: [],
      },
      project: {
        primaryRepository: "acme/reports",
        referenceRepositories: [],
        defaultAutonomy: "L2",
      },
      decisions: [],
    });

    expect(refined.status).toBe("ready");
    expect(refined.proposedAcceptanceCriteria).toHaveLength(2);

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      projectId,
      workItem: "ENG-300",
      goal: refined.goal,
      acceptanceCriteria: refined.proposedAcceptanceCriteria,
      humanAssertions: [],
    });

    expect(built.status).toBe("ready");
    expect(built.assertionCount).toBe(2);
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/);

    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).not.toBeNull();
    expect(stored?.assertions).toHaveLength(2);

    const methods = stored?.assertions.map((assertion) => assertion.method).sort() ?? [];
    expect(methods).toEqual(["browser", "http"]);

    const httpAssertion = stored?.assertions.find((assertion) => assertion.method === "http");
    const browserAssertion = stored?.assertions.find((assertion) => assertion.method === "browser");
    // SDD section 38 fixes what an HTTP assertion records.
    expect(httpAssertion?.evidence).toEqual(["request-response"]);
    // SDD section 37 lists the browser evidence kinds this assertion requires.
    expect(browserAssertion?.evidence).toEqual(["screenshot", "network", "assertion-log"]);

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBe(stored?.sha256);
    expect(run?.validationContractVersion).toBe(built.sha256);

    const implementerInput = buildImplementerInput({
      goal: refined.goal,
      humanDecisions: [],
      validationContract: stored?.document ?? null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: "/workspace/primary",
      referenceRepositoryPaths: [],
      repositoryInstructions: "",
      skills: [],
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    });

    for (const assertion of stored?.assertions ?? []) {
      expect(implementerInput.prompt).toContain(assertion.id);
    }
    expect(implementerInput.prompt).toContain("You must not change the Validation Contract.");
  });

  it("starts no implementation when the Work Item states no observable assertion", async () => {
    const { tenantId, projectId, runId } = await seedTenantProjectAndRun(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    const refined = new RefinementEngine().refine({
      source: {
        issueId: "ENG-301",
        title: "Internal cleanup",
        description: "## Goal\n\nTidy up the internal notes for this quarter.\n",
        url: null,
        labels: [],
      },
      project: {
        primaryRepository: "acme/reports",
        referenceRepositories: [],
        defaultAutonomy: "L2",
      },
      decisions: [],
    });

    // Refinement proposes criteria only, it never confirms one. Every criterion here carries the
    // source `derived:goal`, because the Work Item stated no explicit acceptance criterion. A
    // proposal Factoree wrote from the goal text is not itself an observable assertion a human
    // confirmed, so none of these reach the Validation Contract.
    expect(refined.proposedAcceptanceCriteria.every((criterion) => criterion.source === "derived:goal")).toBe(
      true,
    );
    const confirmedCriteria = refined.proposedAcceptanceCriteria.filter(
      (criterion) => criterion.source !== "derived:goal",
    );
    expect(confirmedCriteria).toHaveLength(0);

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      projectId,
      workItem: "ENG-301",
      goal: refined.goal,
      acceptanceCriteria: confirmedCriteria,
      humanAssertions: [],
    });

    expect(built.status).toBe("needs_input");
    expect(built.sha256).toBeNull();
    expect(built.assertionCount).toBe(0);
    expect(built.question).not.toBeNull();

    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).toBeNull();

    const run = await runs.findById(tenantId, runId);
    expect(run?.validationContractVersion).toBeNull();
  });
});
