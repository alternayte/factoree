import type { Client } from "@temporalio/client";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { describeBlockingRuns, unreplayableRuns, type BlockingRun, type OpenRunWorkflow } from "~/domain/runs/upgrade-check.js";
import { MIN_REPLAYABLE_RELEASE, RELEASE_MEMO_KEY } from "~/workflows/release.js";
import type { OpenRunView } from "~/http/admin/drain.routes.js";

/** docs/specs/run-workflow-structure.md. Every open agentRun workflow, with its release memo. */
export const listOpenRunWorkflows = async (client: Client): Promise<OpenRunWorkflow[]> => {
  const open: OpenRunWorkflow[] = [];
  for await (const info of client.workflow.list({ query: "WorkflowType = 'agentRunWorkflow' AND ExecutionStatus = 'Running'" })) {
    const release = info.memo?.[RELEASE_MEMO_KEY];
    open.push({ workflowId: info.workflowId, release: typeof release === "string" ? release : null });
  }
  return open;
};

export type UpgradeCheckResult = { ok: true; open: number } | { ok: false; report: string; blocking: BlockingRun[] };

/**
 * docs/specs/run-workflow-structure.md. Fails when an open agentRun workflow came from a release
 * this code cannot replay, and names its work item and Run page.
 */
export const checkOpenRunsReplay = async (dependencies: {
  client: Client;
  prisma: FactoreePrismaClient;
  publicUrl: string;
}): Promise<UpgradeCheckResult> => {
  const open = await listOpenRunWorkflows(dependencies.client);
  const unreplayable = unreplayableRuns(open, MIN_REPLAYABLE_RELEASE);
  if (unreplayable.length === 0) return { ok: true, open: open.length };
  const rows = await dependencies.prisma.run.findMany({
    where: { temporalWorkflowId: { in: unreplayable.map((workflow) => workflow.workflowId) } },
    select: { id: true, temporalWorkflowId: true, workItemTitle: true, workItemUrl: true },
  });
  const byWorkflow = new Map(rows.map((row) => [row.temporalWorkflowId, row]));
  const blocking = unreplayable.map((workflow): BlockingRun => {
    const row = byWorkflow.get(workflow.workflowId);
    return {
      workflowId: workflow.workflowId,
      release: workflow.release,
      run: row === undefined ? null : { runId: row.id, workItemTitle: row.workItemTitle, workItemUrl: row.workItemUrl },
    };
  });
  return { ok: false, blocking, report: describeBlockingRuns(blocking, MIN_REPLAYABLE_RELEASE, dependencies.publicUrl) };
};

/** docs/specs/drain-mode.md. Every open agentRun workflow with its run, oldest first, for the drain page. */
export const openRunViews = async (client: Client, prisma: FactoreePrismaClient): Promise<OpenRunView[]> => {
  const open = await listOpenRunWorkflows(client);
  if (open.length === 0) return [];
  const rows = await prisma.run.findMany({
    where: { temporalWorkflowId: { in: open.map((workflow) => workflow.workflowId) } },
    select: { id: true, temporalWorkflowId: true, workItemTitle: true, workItemUrl: true, status: true, createdAt: true },
  });
  const byWorkflow = new Map(rows.map((row) => [row.temporalWorkflowId, row]));
  return open
    .map((workflow): OpenRunView => {
      const row = byWorkflow.get(workflow.workflowId);
      return {
        workflowId: workflow.workflowId,
        runId: row?.id ?? null,
        workItemTitle: row?.workItemTitle ?? null,
        workItemUrl: row?.workItemUrl ?? null,
        status: row?.status ?? null,
        release: workflow.release,
        createdAt: row?.createdAt.toISOString() ?? null,
      };
    })
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
};
