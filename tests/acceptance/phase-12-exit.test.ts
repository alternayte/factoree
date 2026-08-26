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
 * tests, and `docs/build/definition-of-done.md` names each one.
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

  it("records the Definition of Done audit with one row for every item", async () => {
    const sdd = await readFile("docs/sdd.md", "utf8");
    const audit = await readFile("docs/build/definition-of-done.md", "utf8");

    // Every checkbox line of SDD section 67 must appear in the audit, word for word, so no item
    // can be quietly dropped.
    const section = sdd.slice(
      sdd.indexOf("## 67. Definition of Done"),
      sdd.indexOf("## 68. Completion invariant"),
    );
    const items = [...section.matchAll(/^- \[ \] (.+)$/gm)].map((match) => match[1]!.trim());
    // SDD section 67 holds exactly 99 required items. The SDD is immutable, so the count is
    // fixed. A different count means the slice above broke, not that the SDD changed.
    expect(items.length).toBe(99);
    const missing = items.filter((item) => !audit.includes(item));
    expect(missing).toEqual([]);
  });

  it("names the live proof as BLOCKED_EXTERNAL or as passed, never as untested", async () => {
    // SDD section 66. The live section must state one of the two defined states.
    const audit = await readFile("docs/build/definition-of-done.md", "utf8");
    expect(audit).toMatch(/BLOCKED_EXTERNAL|PASSED/);
  });
});
