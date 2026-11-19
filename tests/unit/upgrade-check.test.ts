import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { compareReleases, describeBlockingRuns, unreplayableRuns } from "~/domain/runs/upgrade-check.js";
import { FACTOREE_RELEASE } from "~/workflows/release.js";

/** docs/specs/run-workflow-structure.md. */
describe("upgrade check", () => {
  it("keeps the release of the workflow memo equal to package.json", () => {
    const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
    expect(FACTOREE_RELEASE).toBe(version);
  });

  it("refuses an open run with no memo or an older release, and keeps the rest", () => {
    const open = [
      { workflowId: "a", release: null },
      { workflowId: "b", release: "0.15.9" },
      { workflowId: "c", release: "0.16.0" },
      { workflowId: "d", release: "0.17.2" },
      { workflowId: "e", release: "1.0.0-rc.1" },
    ];
    expect(unreplayableRuns(open, "0.16.0").map((workflow) => workflow.workflowId)).toEqual(["a", "b"]);
  });

  it("compares versions by number, not by text", () => {
    expect(compareReleases("0.9.0", "0.16.0")).toBeLessThan(0);
    expect(compareReleases("0.16.0", "0.16.0")).toBe(0);
  });

  it("names each blocking run with its work item and Run page", () => {
    const report = describeBlockingRuns(
      [
        { workflowId: "linear:ws:s-1", release: null, run: { runId: "run-1", workItemTitle: "FAC-12 Fix login", workItemUrl: "https://linear.app/x/FAC-12" } },
        { workflowId: "linear:ws:s-2", release: "0.15.0", run: null },
      ],
      "0.16.0",
      "https://factoree.example/",
    );
    expect(report).toContain("- FAC-12 Fix login (https://linear.app/x/FAC-12), started by a release before 0.16.0. Run page: https://factoree.example/runs/run-1");
    expect(report).toContain("- linear:ws:s-2, started by release 0.15.0. Factoree has no run row for it.");
  });
});
