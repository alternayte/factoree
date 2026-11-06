import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { ParentClosePolicy, defineSignal, proxyActivities, setHandler, startChild } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import { repositorySetupWorkflow } from "./repository-setup.workflow.js";

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

/** Each push to the default branch of the repository while the workflow runs. */
export const setupPushedSignal = defineSignal("setupPushed");

/** One workflow per repository, so two quick pushes never create two follow-up setups. */
export const setupAfterPushWorkflowId = (tenantId: string, repositoryFullName: string): string =>
  `setup-after-push:${tenantId}:${repositoryFullName}`;

/**
 * docs/specs/setup-app-change-issues.md. The push webhook starts this workflow with a signal. It
 * checks the repository once per push and starts each follow-up setup as its own workflow, which
 * outlives this one.
 */
export const setupAfterPushWorkflow = async (input: { tenantId: string; repositoryFullName: string }): Promise<void> => {
  let pending = true;
  setHandler(setupPushedSignal, () => {
    pending = true;
  });
  while (pending) {
    pending = false;
    const { followUps } = await activities.afterSetupPush(input);
    for (const followUp of followUps) {
      try {
        await startChild(repositorySetupWorkflow, {
          workflowId: followUp.workflowId,
          args: [{ setupId: followUp.setupId }],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        await activities.refuseFollowUpSetup({ setupId: followUp.setupId });
      }
    }
  }
};
