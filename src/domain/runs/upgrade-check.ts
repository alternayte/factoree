/**
 * docs/specs/run-workflow-structure.md. Before a worker polls, and in the Helm pre-upgrade hook,
 * Factoree lists the open agentRun workflows. A workflow with no release memo, or with a release
 * older than the oldest one this code replays, would fail its next workflow task, so the check
 * names it and fails. The operator stops those runs, or waits for them to end.
 */

/** One open agentRun workflow, as the Temporal visibility list returns it. */
export interface OpenRunWorkflow {
  workflowId: string;
  /** The `factoreeRelease` memo, or null when the workflow has none. */
  release: string | null;
}

/** What the check knows about the run of one blocking workflow. */
export interface BlockingRunFacts {
  runId: string;
  workItemTitle: string | null;
  workItemUrl: string | null;
}

export interface BlockingRun {
  workflowId: string;
  release: string | null;
  run: BlockingRunFacts | null;
}

/** Compares two `major.minor.patch` versions. A pre-release suffix is ignored. */
export const compareReleases = (a: string, b: string): number => {
  const parts = (version: string) => version.split("-")[0]?.split(".").map((part) => Number.parseInt(part, 10) || 0) ?? [];
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** The open workflows this code cannot replay. */
export const unreplayableRuns = (open: readonly OpenRunWorkflow[], minimum: string): OpenRunWorkflow[] =>
  open.filter((workflow) => workflow.release === null || compareReleases(workflow.release, minimum) < 0);

/** The report of a failed check: one line per blocking run, with its work item and its Run page. */
export const describeBlockingRuns = (blocking: readonly BlockingRun[], minimum: string, publicUrl: string): string => {
  const lines = blocking.map((entry) => {
    const started = entry.release === null ? "a release before 0.16.0" : `release ${entry.release}`;
    if (entry.run === null) return `- ${entry.workflowId}, started by ${started}. Factoree has no run row for it.`;
    const item = entry.run.workItemTitle ?? "an untitled work item";
    const link = entry.run.workItemUrl === null ? "" : ` (${entry.run.workItemUrl})`;
    return `- ${item}${link}, started by ${started}. Run page: ${publicUrl.replace(/\/$/, "")}/runs/${entry.run.runId}`;
  });
  return [
    `This release replays open runs from release ${minimum} or later only. ${String(blocking.length)} open run(s) started earlier:`,
    ...lines,
    "Stop each run, or wait for it to end, then start this release again. Until then, keep the previous release running.",
  ].join("\n");
};
