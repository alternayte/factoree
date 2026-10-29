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
      "REPORTED",
      "STALE_BASE",
      "FAILED_CONFIGURATION",
      "FAILED",
      "FAILED_REVIEW",
      "CANCELLED",
      "BLOCKED_ROUTING",
      "BLOCKED_TARGET",
      "BLOCKED_STALE_SET",
    ]);
  });

  it("declares every SDD section 48 terminal state", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      [
        "CANCELLED",
        "FAILED",
        "FAILED_CONFIGURATION",
        "FAILED_REVIEW",
        "READY_FOR_HUMAN",
        "REPORTED",
        "STALE_BASE",
        "BLOCKED_ROUTING",
        "BLOCKED_STALE_SET",
      ].sort(),
    );
  });

  it("declares the failure reason of a Run that verification denied", () => {
    // SDD section 35. A failing check with a spent repair budget ends the Run with this reason.
    expect([...RUN_FAILURE_REASONS]).toContain("VERIFICATION_FAILED");
  });

  it("declares the two failure reasons of the independent review", () => {
    // SDD section 40, section 41, and section 42. A blocking finding with a spent repair budget
    // and an unusable report are two different outcomes, so they carry two different reasons.
    expect([...RUN_FAILURE_REASONS]).toContain("REVIEW_BLOCKING_FINDINGS");
    expect([...RUN_FAILURE_REASONS]).toContain("REVIEW_UNAVAILABLE");
  });

  it("classifies terminal and non-terminal states", () => {
    expect(isTerminalRunStatus("READY_FOR_HUMAN")).toBe(true);
    expect(isTerminalRunStatus("IMPLEMENTING")).toBe(false);
  });

  it("names the three publication failure reasons of Phase 9", () => {
    expect(RUN_FAILURE_REASONS).toContain("PATCH_HASH_MISMATCH");
    expect(RUN_FAILURE_REASONS).toContain("EMPTY_PATCH");
    expect(RUN_FAILURE_REASONS).toContain("PUBLICATION_FAILED");
  });

  it("keeps STALE_BASE a terminal status and not a failure reason", () => {
    expect(isTerminalRunStatus("STALE_BASE")).toBe(true);
    expect(RUN_FAILURE_REASONS).not.toContain("STALE_BASE");
  });
});
