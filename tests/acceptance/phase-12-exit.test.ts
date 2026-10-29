import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { registry } from "~/telemetry/metrics.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import { RUN_FAILURE_REASONS } from "~/domain/runs/run-status.js";

/**
 * SDD section 69, Phase 12: "every Definition of Done item passes."
 *
 * A checkbox in a Markdown file is a claim, not evidence. This test proves the machine-checkable
 * parts of SDD section 67 against the real code. The remaining parts have their own acceptance
 * tests, named after the SDD section 64 test they cover.
 */
describe("Phase 12 exit condition", () => {
  it("registers every metric SDD section 62 requires", async () => {
    const required = [
      "factoree_runs_started_total",
      "factoree_runs_ready_total",
      "factoree_runs_failed_total",
      "factoree_runs_cancelled_total",
      "factoree_run_duration_seconds",
      "factoree_refinement_duration_seconds",
      "factoree_context_resolution_duration_seconds",
      "factoree_implementation_duration_seconds",
      "factoree_verification_duration_seconds",
      "factoree_validation_duration_seconds",
      "factoree_review_duration_seconds",
      "factoree_repairs_total",
      "factoree_context_conflicts_total",
      "factoree_human_interventions_total",
      "factoree_active_runs",
    ];
    const registered = new Set((await registry.getMetricsAsJSON()).map((entry) => entry.name));
    for (const name of required) {
      expect(registered.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("gives every failure reason a normalized category", () => {
    for (const reason of RUN_FAILURE_REASONS) {
      expect(failureCategoryOf(reason)).toBeTruthy();
    }
  });

  it("skips no required test", async () => {
    // SDD section 67: "No required test is skipped." A `.skip` or a `.todo` in an acceptance
    // test removes a required proof. SDD section 72 forbids that.
    const { glob } = await import("node:fs/promises");
    const offenders: string[] = [];
    for await (const path of glob("tests/acceptance/**/*.test.ts")) {
      const text = await readFile(path, "utf8");
      if (/\b(it|describe|test)\.(skip|todo)\b/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
