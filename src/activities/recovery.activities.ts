import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { RunViewReader } from "~/domain/runs/run-view.js";
import { renderFailurePost } from "~/domain/runs/run-recovery.js";

export interface RecoveryActivityDependencies {
  runViews?: RunViewReader | undefined;
  redactor: Redactor;
  logger: Logger;
}

export const createRecoveryActivities = (dependencies: RecoveryActivityDependencies) => ({
  /**
   * docs/specs/run-recovery.md. The failure post of a run that can take a follow-up: the message,
   * what blocked the run from its recorded facts, and example replies. A read fault leaves the
   * message alone, because the post must still reach the human.
   */
  async describeRunFailure(input: {
    tenantId: string;
    runId: string;
    message: string;
    kind?: "run" | "configuration";
  }): Promise<string> {
    try {
      const run = (await dependencies.runViews?.detail(input.tenantId, input.runId)) ?? null;
      if (run === null) return input.message;
      return dependencies.redactor.redactText(renderFailurePost(input.message, run, input.kind ?? "run"));
    } catch (error) {
      dependencies.logger.warn("the failure post was built without the run facts", {
        run_id: input.runId,
        error: String(error),
      });
      return input.message;
    }
  },
});
