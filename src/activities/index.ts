import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { AgentSessionPort } from "~/domain/runs/ports.js";
import { createRunActivities } from "./run.activities.js";
import { createLinearActivities } from "./linear.activities.js";

export interface ActivityDependencies {
  runs: RunRepository;
  agentSession: AgentSessionPort;
  logger: Logger;
}

export const createActivities = (dependencies: ActivityDependencies) => ({
  ...createRunActivities({ runs: dependencies.runs, logger: dependencies.logger }),
  ...createLinearActivities({ agentSession: dependencies.agentSession }),
});

export type Activities = ReturnType<typeof createActivities>;
