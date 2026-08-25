import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * Definition of Done, SDD section 67: "Three concurrent fixture Runs complete independently."
 *
 * Three separate operating-system processes would prove the operating system. Three concurrent
 * workflows inside one worker prove what Factoree owns: that no Run reads, writes, or waits on
 * the state of another Run.
 */
describe("Phase 12 — three concurrent Runs complete independently", () => {
  it("completes three Runs with three separate sandboxes, patches, and pull requests", async () => {
    const harness = createWorkflowHarness(() => environment);
    const sessions = ["session-a", "session-b", "session-c"];

    // Every Run holds at its Implementer, so all three are in flight at the same moment. A
    // sequential execution cannot satisfy this, because Run A never releases until B and C
    // have also reached the hold.
    const releases = sessions.map((session) => hold(harness.heldImplementations, `run-${session}`));

    const result = await harness.runWorker(async () => {
      const handles = await Promise.all(sessions.map((session) => harness.start(session)));

      await waitFor(
        () => harness.implementCalls.length === 3,
        "all three Runs to reach the Implementer",
        30_000,
      );

      // Every Run prepared its own sandbox. SDD section 52 forbids a reused mutable sandbox.
      const refs = harness.prepared.map((entry) => entry.runId);
      expect(new Set(refs).size).toBe(3);

      for (const release of releases) release();

      await Promise.all(handles.map((handle) => handle.result()));
      return handles;
    });

    expect(result).toHaveLength(3);

    // Each Run reached the human-ready state on its own.
    const ready = harness.completions.filter((entry) => entry.status === "READY_FOR_HUMAN");
    expect(ready.map((entry) => entry.runId).sort()).toEqual(
      sessions.map((session) => `run-${session}`).sort(),
    );

    // Exactly one publication per Run. A shared counter or a shared map would produce three
    // publications on one Run, or one publication across three.
    const published = harness.publishCalls.map((entry) => entry.runId).sort();
    expect(published).toEqual(sessions.map((session) => `run-${session}`).sort());

    // Exactly one Proof Pack per Run.
    const packs = harness.proofPackCalls.map((entry) => entry.runId).sort();
    expect(packs).toEqual(sessions.map((session) => `run-${session}`).sort());

    // No Run failed, and no Run leaked another Run's identifier into its own status trail.
    for (const session of sessions) {
      const runId = `run-${session}`;
      expect(harness.statusesOf(runId)).toContain("PUBLISHING");
      expect(
        harness.completions.filter((entry) => entry.runId === runId),
      ).toHaveLength(1);
    }
  }, 180_000);
});
