/**
 * Bundles `src/workflows/agent-run.workflow.ts` once and writes the result to a temporary
 * file.
 *
 * `tests/workflow/support/harness.ts` builds a Temporal worker for this workflow inside
 * `createWorkflowHarness`, and both the workflow suite (`vitest.workflow.config.ts`) and the
 * acceptance suite (`vitest.integration.config.ts`) import that harness. Each suite runs its
 * own `globalSetup`, in its own process, so each suite calls this function once from its own
 * setup file and provides the resulting path under the same key, `agentRunWorkflowBundlePath`.
 * A worker that skips this and passes `workflowsPath` instead pays a webpack bundle on every
 * `Worker.create` call, and the suite calls that function dozens of times.
 */
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleWorkflowCode } from "@temporalio/worker";

const AGENT_RUN_WORKFLOWS_PATH = new URL("../../../src/workflows/agent-run.workflow.ts", import.meta.url).pathname;

/** Bundles the agent-run workflow and writes it to a temporary file. Returns the file's path. */
export const bundleAgentRunWorkflow = async (): Promise<string> => {
  const { code } = await bundleWorkflowCode({ workflowsPath: AGENT_RUN_WORKFLOWS_PATH });
  const bundlePath = join(tmpdir(), `factoree-agent-run-workflow-bundle-${randomUUID()}.js`);
  await writeFile(bundlePath, code, "utf8");
  return bundlePath;
};

/** Deletes the temporary bundle file `bundleAgentRunWorkflow` wrote. */
export const deleteAgentRunWorkflowBundle = async (bundlePath: string): Promise<void> => {
  await unlink(bundlePath);
};
