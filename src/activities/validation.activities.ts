import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ValidationContractStore } from "~/domain/validation/validation-contract-store.js";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import { buildValidationContract } from "~/domain/validation/validation-contract-builder.js";
import { validateValidationContract } from "~/domain/validation/validation-contract.js";

export interface BuildValidationContractActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  workItem: string;
  goal: string;
  acceptanceCriteria: ValidationCriterion[];
  humanAssertions: string[];
}

export interface BuildValidationContractActivityOutput {
  /** `needs_input` means SDD section 9 item 5 is not met, and implementation must not start. */
  status: "ready" | "needs_input";
  /** The frozen contract hash, or null when nothing froze. */
  sha256: string | null;
  document: string;
  assertionCount: number;
  /** AT-10. The moment the contract froze, so a test can compare it with the Implementer start. */
  frozenAt: string | null;
  question: { id: string; question: string } | null;
  /** The line Factoree posts to Linear. */
  summary: string;
}

export interface ValidationActivityDependencies {
  contracts: ValidationContractStore;
  runs: RunRepository;
  logger: Logger;
}

const QUESTION_ID = "VAL-Q-1";

const QUESTION =
  "What observable behavior proves this work is done? Factoree needs at least one assertion a " +
  "person or a machine can check, for example a page state, an HTTP response, or a command exit " +
  "code. Factoree must not invent product behavior, so it cannot state this itself.";

const summaryOf = (assertions: number, sha256: string): string =>
  `Factoree froze the Validation Contract with ${assertions} ` +
  `${assertions === 1 ? "assertion" : "assertions"}. Version ${sha256.slice(0, 12)}. ` +
  "It cannot change while this Run implements the work.";

/** SDD section 63 names this file. */
export const createValidationActivities = (dependencies: ValidationActivityDependencies) => ({
  async buildValidationContract(
    input: BuildValidationContractActivityInput,
  ): Promise<BuildValidationContractActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    try {
      // SDD section 25. A frozen contract is the contract of this Run. A retry, and any later
      // call, must return that contract and must never rebuild it. See controller decision 7.
      const existing = await dependencies.contracts.findByRun(input.tenantId, input.runId);
      if (existing !== null) {
        // A repeat write here repairs a Run row that an interrupted earlier attempt left without
        // the hash: the contract froze, but the process stopped, or a retry ran, before the
        // hash reached the Run. The write is idempotent, so a repeat call is safe.
        await dependencies.runs.setValidationContractVersion(
          input.tenantId,
          input.runId,
          existing.sha256,
        );
        dependencies.logger.info("validation contract already frozen", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          run_id: input.runId,
          step: "build_validation_contract",
          status: "ready",
        });
        return {
          status: "ready",
          sha256: existing.sha256,
          document: existing.document,
          assertionCount: existing.assertions.length,
          frozenAt: existing.createdAt.toISOString(),
          question: null,
          summary: summaryOf(existing.assertions.length, existing.sha256),
        };
      }

      const built = buildValidationContract({
        runId: input.runId,
        workItem: input.workItem,
        goal: input.goal,
        acceptanceCriteria: input.acceptanceCriteria,
        humanAssertions: input.humanAssertions,
      });

      // SDD section 9 item 5. No observable success assertion exists, so the readiness gate
      // fails and nothing freezes. See controller decision 3.
      if (built.contract.assertions.length === 0) {
        dependencies.logger.info("validation contract needs input", {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          run_id: input.runId,
          step: "build_validation_contract",
          status: "needs_input",
        });
        return {
          status: "needs_input",
          sha256: null,
          document: built.document,
          assertionCount: 0,
          frozenAt: null,
          question: { id: QUESTION_ID, question: QUESTION },
          summary:
            "Factoree cannot define success for this Work Item. It needs one observable " +
            "assertion before it can start implementation.",
        };
      }

      // SDD section 9 item 9. Only a valid contract freezes. A defect in the builder must fail
      // the activity here, not reach the store.
      validateValidationContract(built.contract);

      const stored = await dependencies.contracts.save({
        tenantId: input.tenantId,
        runId: input.runId,
        contract: built.contract,
        sha256: built.sha256,
        document: built.document,
      });

      await dependencies.runs.setValidationContractVersion(
        input.tenantId,
        input.runId,
        stored.sha256,
      );

      dependencies.logger.info("validation contract frozen", {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        run_id: input.runId,
        step: "build_validation_contract",
        status: "ready",
        assertion_count: stored.assertions.length,
        validation_contract_version: stored.sha256,
      });

      return {
        status: "ready",
        sha256: stored.sha256,
        document: stored.document,
        assertionCount: stored.assertions.length,
        frozenAt: stored.createdAt.toISOString(),
        question: null,
        summary: summaryOf(stored.assertions.length, stored.sha256),
      };
    } finally {
      metrics.validationContractDuration.observe(labels, (Date.now() - started) / 1000);
    }
  },
});
