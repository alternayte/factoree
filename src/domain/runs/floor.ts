import type { RunStageName } from "./run-stage.js";
import type { ToolKind } from "./session-pulse.js";

/**
 * docs/specs/factory-floor.md. The read model of the factory floor. Live and replay return the
 * same shape: each run, setup run and pull request with its timed changes, so the page computes
 * the floor at any moment of the window.
 */
export interface FloorData {
  generatedAt: Date;
  from: Date;
  to: Date;
  lines: FloorLine[];
  runs: FloorRun[];
  setups: FloorSetup[];
  pulses: FloorPulse[];
  throughput: FloorThroughputDay[];
}

export interface FloorLine {
  productId: string;
  name: string;
  slug: string;
  teamKey: string;
  repositories: string[];
}

export interface FloorStatusChange {
  status: string;
  at: Date;
}

export interface FloorPullRequest {
  url: string;
  repository: string;
  state: "open" | "merged" | "closed";
  openedAt: Date;
  /** The merge or close time, null while the pull request is open. */
  closedAt: Date | null;
}

export interface FloorDeploy {
  environment: string;
  state: "success" | "failure";
  at: Date;
}

export interface FloorRun {
  id: string;
  productId: string;
  title: string | null;
  url: string | null;
  createdAt: Date;
  repairLimit: number;
  costUsd: number | null;
  /** True when the run works on the pull request of an earlier run: a PR follow-up run. */
  followsPullRequest: boolean;
  /**
   * True for a run from before the status history. Its changes come from the stage rows and the
   * row times, so the page marks them.
   */
  approximate: boolean;
  statuses: FloorStatusChange[];
  pullRequests: FloorPullRequest[];
  deploys: FloorDeploy[];
}

export interface FloorSetup {
  id: string;
  productId: string;
  repository: string;
  approximate: boolean;
  statuses: FloorStatusChange[];
}

export interface FloorPulse {
  runId: string | null;
  setupId: string | null;
  role: string;
  toolKind: ToolKind;
  lastOutputAt: Date;
  at: Date;
}

export interface FloorThroughputDay {
  /** The UTC day, as YYYY-MM-DD. */
  day: string;
  /** Work items that arrived: runs created that day. */
  arrived: number;
  /** Pull requests merged that day. */
  merged: number;
}

export interface FloorReader {
  live(tenantId: string, now: Date): Promise<FloorData>;
  replay(tenantId: string, from: Date, to: Date): Promise<FloorData>;
}

/** The longest replay window. */
export const MAX_REPLAY_MS = 7 * 24 * 60 * 60 * 1000;

/** How long an ended run stays on the live floor: in the reject bin, at the dock or at the gate. */
export const ENDED_RUN_VISIBLE_MS = 24 * 60 * 60 * 1000;

/** A live pulse older than this belongs to a session that no longer runs. */
export const LIVE_PULSE_MS = 60_000;

/** The status a stage row stands for, in the approximate history of an older run. */
const STAGE_STATUS: Partial<Record<RunStageName, string>> = {
  refiner: "REFINING",
  prepare_sandbox: "PREPARING",
  implementer: "IMPLEMENTING",
  prepare_check_sprite: "VERIFYING",
  verify: "VERIFYING",
  preview_build: "VERIFYING",
  browser_assertions: "USER_VALIDATING",
  validator: "USER_VALIDATING",
  reviewer: "REVIEWING",
  publish: "PUBLISHING",
};

/**
 * The approximate status history of a run from before the status history: received at its
 * creation, a status per stage row in time order, an implementer stage after the first as a
 * repair, and its final status at its end. The page marks such a run as approximate.
 */
export const approximateStatuses = (
  run: { createdAt: Date; completedAt: Date | null; status: string },
  stages: Array<{ stage: string; attempt: number; startedAt: Date }>,
): FloorStatusChange[] => {
  const changes: FloorStatusChange[] = [{ status: "RECEIVED", at: run.createdAt }];
  const ordered = [...stages].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (const stage of ordered) {
    const mapped = STAGE_STATUS[stage.stage as RunStageName];
    if (mapped === undefined) continue;
    const status = mapped === "IMPLEMENTING" && stage.attempt > 1 ? "REPAIRING" : mapped;
    if (changes.at(-1)?.status !== status) changes.push({ status, at: stage.startedAt });
  }
  if (run.completedAt !== null) changes.push({ status: run.status, at: run.completedAt });
  else if (changes.at(-1)?.status !== run.status) changes.push({ status: run.status, at: changes.at(-1)!.at });
  return changes;
};
