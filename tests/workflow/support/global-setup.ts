/**
 * Bundles workflow code once for the whole workflow suite.
 *
 * Every `Worker.create` call in the suite that points `workflowsPath` at the same
 * source file pays the webpack bundle cost again. The suite calls `runWorker`
 * (in `./harness.js`) 92 times, so 92 separate bundles once starved the Temporal
 * worker's activity dispatch and stalled a test until it hit the raw timeout.
 *
 * This module runs once, in a process separate from the test workers, before any
 * test file loads. It bundles each workflow module exactly once, writes the
 * generated code to a temporary file, and provides the file path to the test
 * workers through vitest's `provide`/`inject` channel. A test worker process
 * cannot share memory with this setup process, so the bundle travels as a file
 * on disk, not as an object.
 *
 * `tests/integration/support/global-setup.ts` provides the same
 * `agentRunWorkflowBundlePath` key, from the same `bundleAgentRunWorkflow` helper,
 * because the acceptance suite also imports `./harness.js` and needs the same bundle.
 *
 * The workflow barrel (`src/workflows/index.ts`) keeps its own direct
 * `workflowsPath` in `tests/workflow/sync-installation.test.ts`, because one test
 * there exists specifically to prove a worker built from the barrel resolves and
 * runs. That test must keep loading through the barrel, so it is not part of
 * this shared bundle.
 */
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleWorkflowCode } from "@temporalio/worker";
import type { TestProject } from "vitest/node";
import { bundleAgentRunWorkflow, deleteAgentRunWorkflowBundle } from "./bundle-agent-run-workflow.js";

const SYNC_INSTALLATION_WORKFLOWS_PATH = new URL(
  "../../../src/workflows/sync-installation.workflow.ts",
  import.meta.url,
).pathname;

const bundleSyncInstallationWorkflow = async (): Promise<string> => {
  const { code } = await bundleWorkflowCode({ workflowsPath: SYNC_INSTALLATION_WORKFLOWS_PATH });
  const bundlePath = join(tmpdir(), `factoree-sync-installation-workflow-bundle-${randomUUID()}.js`);
  await writeFile(bundlePath, code, "utf8");
  return bundlePath;
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const agentRunBundlePath = await bundleAgentRunWorkflow();
  const syncInstallationBundlePath = await bundleSyncInstallationWorkflow();

  project.provide("agentRunWorkflowBundlePath", agentRunBundlePath);
  project.provide("syncInstallationWorkflowBundlePath", syncInstallationBundlePath);

  return async () => {
    await Promise.all([deleteAgentRunWorkflowBundle(agentRunBundlePath), unlink(syncInstallationBundlePath)]);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    agentRunWorkflowBundlePath: string;
    syncInstallationWorkflowBundlePath: string;
  }
}
