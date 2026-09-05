import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { createContextActivities } from "~/activities/context.activities.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { stopSignal } from "~/workflows/agent-run.workflow.js";
import { FakeContextContractStore } from "../support/fake-context-contract-store.js";
import { createWorkflowHarness, hold, waitFor } from "../workflow/support/harness.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { PRIMARY_SLUG, buildContextFixture } from "./support/context-fixture-repository.js";

let environment: TestWorkflowEnvironment;
let fixture: ContextFixture;

const reader = new GitRepositoryReader();
const contracts = new FakeContextContractStore();
const harness = createWorkflowHarness(() => environment);
const {
  cancelledLiveSessions,
  heldImplementations,
  implementCalls,
  postedProgress,
  prepared,
  runStatusQuery,
  runWorker,
  start,
  statusesOf,
} = harness;

/** Every Context Contract version the activity wrote to the Run row. */
const contextVersions: string[] = [];

const SESSION = "ses-p4-exit";
const RUN_ID = `run-${SESSION}`;

beforeAll(async () => {
  fixture = await buildContextFixture();

  // The real context activity, over the real resolver and the two real fixture repositories.
  // Only the Context Contract store and the Run repository are doubles, because PostgreSQL is
  // not the subject of this test.
  const runs = {
    setContextContractVersion: (_tenantId: string, _runId: string, version: string) => {
      contextVersions.push(version);
      return Promise.resolve();
    },
  } as unknown as RunRepository;
  const contextActivities = createContextActivities({
    resolver: new ContextResolver(),
    contracts,
    runs,
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    sources: {
      sourcesFor: () =>
        Promise.resolve(
          new ContextSourceRegistry([
            new LinearContextSource(),
            new RepositoryContextSource({ reader }),
          ]),
        ),
    },
    repositoryReader: reader,
    secrets: new MemorySecretStore(),
    tokens: {
      tokenForInstallation: () => Promise.reject(new Error("this fixture reads a local path, so no mint runs")),
    },
    redactor: new Redactor(),
  });
  harness.activities.resolveContext = (input) => contextActivities.resolveContext(input);

  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
  reader.close();
  fixture.cleanup();
});

/**
 * The Phase 4 exit condition of SDD section 69: Factoree can explain what context it will use
 * before code changes begin.
 *
 * The proof is one Run that reaches IMPLEMENTING with a frozen, persisted Context Contract. Every
 * item of that contract carries complete provenance. Every repository carries an explicit commit
 * SHA. The text of the contract reached the human through Linear and reached the Implementer,
 * and it reached both before the Implementer received any instruction.
 */
describe("Phase 4 exit condition — Factoree explains its context before code changes begin", () => {
  it("freezes, persists, and publishes the Context Contract before the Implementer starts", async () => {
    // The Implementer double stays open, so the Run holds still in IMPLEMENTING while the test
    // reads what Factoree explained. Without the hold the Run passes through the state faster
    // than a query can observe it.
    const release = hold(heldImplementations, RUN_ID);

    await runWorker(async () => {
      const handle = await start(SESSION, {
        workItem: {
          issueId: "issue-1",
          title: "Notification retry is broken",
          description: "A failed notification delivery is never retried. Users lose messages.",
          url: null,
          labels: [],
        },
        product: {
          ...harness.productInput,
          // F1 (specification section 12). A repository of the Product that is not the target
          // stays absent at Run start; the workflow no longer seeds a reference repository from
          // Product membership. This exit condition proves the Context Contract explains a
          // single-repository Product; Phase 5 proves a reference repository reaches the
          // contract through the legitimate mechanism, Backstage automatic discovery.
          repositories: [
            { id: "repository-primary", fullName: PRIMARY_SLUG, defaultBranch: "main", absentSince: null, githubInstallationId: "install-1" },
          ],
          repositoryBaseUrl: fixture.root,
        },
      });
      // This Run clones a real repository through git, so it needs more than the default ten
      // seconds on a cold machine.
      await waitFor(
        () => implementCalls.some((entry) => entry.runId === RUN_ID),
        "the Implementer of the exit Run",
        120_000,
      );

      try {
        // The Implementer started and changed nothing yet.
        const snapshot = await handle.query(runStatusQuery);
        expect(snapshot.status).toBe("IMPLEMENTING");

        // The contract is frozen and recorded on the Run.
        expect(snapshot.contextContractVersion).toMatch(/^[0-9a-f]{64}$/);
        const stored = contracts.all()[0];
        expect(stored?.runId).toBe(RUN_ID);
        expect(stored?.sha256).toBe(snapshot.contextContractVersion);
        // SDD section 53. The frozen version reached the Run row as well.
        expect(contextVersions).toContain(stored?.sha256);

        // The repository carries an explicit commit SHA, and it is the SHA the fixture really
        // holds.
        expect(stored?.document).toContain(`${PRIMARY_SLUG} at ${fixture.primarySha}`);
        expect(stored?.document).toContain("Reference repositories\n\n- None.");

        // Every item carries complete provenance.
        expect(stored?.items.length).toBeGreaterThan(0);
        for (const item of stored?.items ?? []) {
          expect(item.reference.sourceId).not.toBe("");
          expect(item.reference.ref).not.toBe("");
          expect(item.sourceVersion).not.toBe("");
          expect(item.authority).not.toBe("");
          expect(item.reason).not.toBe("");
        }

        // The conflict Factoree found is recorded with its decision.
        expect(stored?.conflicts.some((conflict) => conflict.resolution === "resolved")).toBe(true);

        // The explanation reached the human through Linear.
        const progress = postedProgress.join("\n");
        expect(progress).toContain("Context Contract");
        expect(progress).toContain(`${PRIMARY_SLUG}@${fixture.primarySha.slice(0, 7)}`);

        // The explanation reached the Implementer, and it is the frozen text.
        const call = implementCalls.find((entry) => entry.runId === RUN_ID);
        expect(call?.contextContract).toBe(stored?.document);
        expect(call?.requiredContext.length).toBeGreaterThan(0);

        // Explanation came first. The Run resolved its context, then prepared, then implemented.
        const order = statusesOf(RUN_ID);
        expect(order.indexOf("RESOLVING_CONTEXT")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("RESOLVING_CONTEXT")).toBeLessThan(order.indexOf("PREPARING"));
        expect(order.indexOf("PREPARING")).toBeLessThan(order.indexOf("IMPLEMENTING"));

        // The checkout landed on the SHA the contract names, so the Implementer reads exactly the
        // state Factoree explained.
        const prepare = prepared.find((entry) => entry.runId === RUN_ID);
        expect(prepare?.primary.ref).toBe(fixture.primarySha);
        // F1. No sibling was seeded as a reference repository, so the sandbox checks out none.
        expect(prepare?.references).toEqual([]);
      } finally {
        // The held Implementer must always be released, or the worker cannot shut down. The
        // stop must reach the activity before the release, exactly as
        // `tests/workflow/agent-run.workflow.test.ts` drives the same double.
        await handle.signal(stopSignal);
        await waitFor(
          () => cancelledLiveSessions.includes(RUN_ID),
          "the live cancellation of the exit Run",
          60_000,
        );
        release();
        await handle.result();
        heldImplementations.delete(RUN_ID);
      }
    });
  });
});
