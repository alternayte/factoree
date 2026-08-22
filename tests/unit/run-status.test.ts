import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_REASONS,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
} from "~/domain/runs/run-status.js";

describe("run status", () => {
  it("declares every SDD section 48 state", () => {
    expect([...RUN_STATUSES]).toEqual([
      "RECEIVED",
      "REFINING",
      "WAITING_FOR_INPUT",
      "RESOLVING_CONTEXT",
      "BUILDING_VALIDATION_CONTRACT",
      "PREPARING",
      "IMPLEMENTING",
      "VERIFYING",
      "USER_VALIDATING",
      "REVIEWING",
      "REPAIRING",
      "PUBLISHING",
      "READY_FOR_HUMAN",
      "STALE_BASE",
      "FAILED_CONFIGURATION",
      "FAILED",
      "FAILED_REVIEW",
      "CANCELLED",
    ]);
  });

  it("declares every SDD section 48 terminal state", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      ["CANCELLED", "FAILED", "FAILED_CONFIGURATION", "FAILED_REVIEW", "READY_FOR_HUMAN", "STALE_BASE"].sort(),
    );
  });

  it("declares the failure reason of a Run that verification denied", () => {
    // SDD section 35. A failing check with a spent repair budget ends the Run with this reason.
    expect([...RUN_FAILURE_REASONS]).toContain("VERIFICATION_FAILED");
  });

  it("classifies terminal and non-terminal states", () => {
    expect(isTerminalRunStatus("READY_FOR_HUMAN")).toBe(true);
    expect(isTerminalRunStatus("IMPLEMENTING")).toBe(false);
  });
});
