import type { SandboxFaultSink } from "~/domain/runs/sandbox-fault.js";
import type { Logger } from "~/telemetry/logger.js";
import { setupWorkflowId, type RepositorySetupStore } from "./repository-setup.js";

/**
 * docs/specs/sandbox-memory-and-size.md, DI-21.195. After a sandbox fault of a run, Factoree starts
 * a setup run of the repository with the fault as input, unless a setup of it is open. The setup
 * is the one place that writes `.factoree/config.yaml`, as a pull request a human merges.
 */
export interface SetupAfterFaultDependencies {
  setups: Pick<RepositorySetupStore, "listForRepository" | "create" | "update">;
  /** The installation and the product of a repository, or null when no repository row has the name. */
  repository: (tenantId: string, fullName: string) => Promise<{ productId: string; githubInstallationId: string } | null>;
  /** The `owner/repo` of the first target of a run, or null. */
  primaryRepositoryOf: (runId: string) => Promise<string | null>;
  /** Starts the setup workflow. False when another setup of the repository runs. */
  startSetup: (input: { setupId: string; workflowId: string }) => Promise<boolean>;
  logger: Logger;
}

const OPEN = new Set(["queued", "running"]);

export const createSetupAfterFault =
  (dependencies: SetupAfterFaultDependencies): SandboxFaultSink =>
  async (report) => {
    try {
      const fullName = report.repositoryFullName ?? (await dependencies.primaryRepositoryOf(report.runId));
      if (fullName === null) return;
      const repository = await dependencies.repository(report.tenantId, fullName);
      if (repository === null) return;
      const open = (await dependencies.setups.listForRepository(repository.productId, fullName)).find((setup) => OPEN.has(setup.status));
      if (open !== undefined) {
        dependencies.logger.info("a setup of the repository is open, so the sandbox fault starts none", { run_id: report.runId, setup_id: open.id });
        return;
      }
      const workflowId = setupWorkflowId(report.tenantId, fullName);
      const setup = await dependencies.setups.create({
        tenantId: report.tenantId,
        productId: repository.productId,
        repositoryFullName: fullName,
        githubInstallationId: repository.githubInstallationId,
        workflowId,
        sandboxFault: report.summary,
      });
      if (!(await dependencies.startSetup({ setupId: setup.id, workflowId }))) {
        await dependencies.setups.update(setup.id, {
          status: "failed",
          failureMessage: "Another setup of this repository was running, so Factoree did not start this setup after the sandbox fault.",
          endedAt: new Date(),
        });
        return;
      }
      dependencies.logger.info("the sandbox fault started a setup", { run_id: report.runId, setup_id: setup.id, kind: report.kind });
    } catch (error) {
      // The run still ends with its fault. A missed setup is logged, not a second failure.
      dependencies.logger.error("the setup after the sandbox fault did not start", { run_id: report.runId, detail: String(error).slice(0, 500) });
    }
  };
