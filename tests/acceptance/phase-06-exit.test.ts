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
 * on to the Implementer prompt. The second test drives the activity's own last-line enforcement
 * of SDD section 9 item 5 directly. The third test proves the ordering itself: the Run row
 * carries the frozen hash before the Implementer input is built.
 */
describe("Phase 6 exit — every implementation starts after a frozen Validation Contract", () => {
  it("runs the whole path from a Work Item to a frozen contract the Implementer receives", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
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
      projectId: productId,
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

  it("freezes nothing when the activity receives no acceptance criterion and no human assertion", async () => {
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    // Refinement normally satisfies SDD section 9 item 5 upstream of this activity: it derives
    // at least one criterion from any non-empty goal (`deriveAcceptanceCriteria` in
    // `refinement-engine.ts`), so a real Run practically never reaches the activity with an
    // empty criteria list. This test calls the activity directly, with the criteria and human
    // assertions both empty, to drive its own last-line enforcement of that same rule — the
    // gate `buildValidationContract` applies whatever called it. It does not claim this is the
    // path a real Run takes; `refined.goal` is used only to keep the goal field realistic.
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

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      projectId: productId,
      workItem: "ENG-301",
      goal: refined.goal,
      acceptanceCriteria: [],
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

  it("carries the frozen hash on the Run row before the Implementer input is built", async () => {
    // `tests/workflow/validation-contract.workflow.test.ts` proves this same ordering end to
    // end at the workflow level, driving the real Temporal workflow. This test proves it with
    // the pieces available to this suite: the real freeze activity, then a real read of the Run
    // row, then a real Implementer input built from what that row and the frozen document hold.
    const { tenantId, productId, runId } = await seedTenantProjectAndRun(prisma);
    const activities = createValidationActivities({ contracts, runs, logger });

    const built = await activities.buildValidationContract({
      runId,
      tenantId,
      projectId: productId,
      workItem: "ENG-302",
      goal: "A signed-in editor can archive a report.",
      acceptanceCriteria: [
        { id: "AC-1", statement: "POST /reports/{id}/archive returns 200.", source: "stated" },
      ],
      humanAssertions: [],
    });
    expect(built.status).toBe("ready");

    // The hash is already on the Run row before the Implementer input is built below.
    const runBeforeBuild = await runs.findById(tenantId, runId);
    expect(runBeforeBuild?.validationContractVersion).toBe(built.sha256);

    const stored = await contracts.findByRun(tenantId, runId);
    expect(stored).not.toBeNull();

    const implementerInput = buildImplementerInput({
      goal: "A signed-in editor can archive a report.",
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
    expect(implementerInput.prompt).toContain("POST /reports/{id}/archive returns 200.");
  });
});
