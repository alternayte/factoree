/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { WorkflowNotFoundError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { HELD_LINE } from "~/domain/runs/drain-mode.js";
import { Worker } from "@temporalio/worker";
import { pullRequestEventSignal, pullRequestStateQuery, pullRequestWorkflow } from "~/workflows/pr.workflow.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";
import { waitFor } from "./support/harness.js";

/**
 * The result of a child run that already completed, read from its history. `result()` would release
 * the time-skipping clock, and the PR workflow, which waits on a condition with no timer, would then
 * jump to its default timeout before the test signals it again.
 */
const completedResult = async (workflowId: string): Promise<unknown> => {
  const child = environment.client.workflow.getHandle(workflowId);
  // The PR workflow starts the child, so the first poll can come before the child exists.
  const completedOrAbsent = async (): Promise<boolean> => {
    try {
      return (await child.describe()).status.name === "COMPLETED";
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return false;
      throw error;
    }
  };
  await waitFor(completedOrAbsent, `the run ${workflowId}`);
  const completed = (await child.fetchHistory()).events?.find((event) => event.workflowExecutionCompletedEventAttributes);
  const payload = completed?.workflowExecutionCompletedEventAttributes?.result?.payloads?.[0];
  return payload === undefined ? undefined : defaultPayloadConverter.fromPayload(payload);
};

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const review: PullRequestEvent = {
  kind: "review",
  deliveryId: "github:review-1",
  action: "submitted",
  reviewId: 1,
  state: "commented",
  commitSha: "head-1",
  reviewerLogin: "dana",
  reviewerType: "User",
  authorAssociation: "MEMBER",
  body: "Looks fine.",
};
const synchronize: PullRequestEvent = { kind: "synchronized", deliveryId: "github:sync-1", headSha: "head-2", beforeSha: "head-1", senderLogin: "dana" };
const merge: PullRequestEvent = { kind: "closed", deliveryId: "github:close-1", merged: true, mergeCommitSha: "merge-1", headSha: "head-2" };

/**
 * docs/specs/pr-review-merge-and-deploy.md, DI-21.100, DI-21.101. The workflow records each delivery
 * once, acts only on a close, and ends after it.
 */
describe("pullRequestWorkflow", () => {
  it("records each event once, closes through the origin run on a merge, and ends", async () => {
    const taskQueue = `pr-${randomUUID()}`;
    const taken: string[] = [];
    const closes: { merged: boolean; mergeCommitSha: string | null }[] = [];
    const steers: string[] = [];
    let state: PullRequestState = "open";
    let headSha = "head-1";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("../../src/workflows/pr.workflow.ts", import.meta.url).pathname,
      activities: {
        takePullRequestEvent: async (input: { event: PullRequestEvent }) => {
          const isNew = !taken.includes(input.event.deliveryId);
          if (isNew) taken.push(input.event.deliveryId);
          if (isNew && input.event.kind === "synchronized") headSha = input.event.headSha;
          return { isNew, state, headSha };
        },
        closePullRequestOfRecord: async (input: { merged: boolean; mergeCommitSha: string | null }) => {
          closes.push(input);
          state = input.merged ? "merged" : "closed";
          return state;
        },
        steerAutoMerge: async (input: { trigger: string }) => {
          steers.push(input.trigger);
          return { state: "off" };
        },
        // A COMMENTED review starts no PR follow-up run.
        planPullRequestFollowUp: async () => ({ kind: "none", reason: "no change request" }),
        // DI-21.123. The comment lists itself in the proof pack only when the planner says so.
        planProofPackAmendment: async () => ({ amend: null }),
        // Slice 4. The new head does not conflict with its base.
        readPullRequestMergeability: async () => ({ mergeability: "clean" }),
      },
    });

    const send = (event: PullRequestEvent) =>
      environment.client.workflow.signalWithStart(pullRequestWorkflow, {
        taskQueue,
        workflowId: `pr:tenant-1:acme/api#${randomUUID()}`,
        args: [{ tenantId: "tenant-1", pullRequestId: "pr-1" }],
        signal: pullRequestEventSignal,
        signalArgs: [event],
      });

    const result = await worker.runUntil(async () => {
      const handle = await send(review);
      await handle.signal(pullRequestEventSignal, review);
      await handle.signal(pullRequestEventSignal, synchronize);
      await waitFor(() => taken.length === 2, "the review and the synchronize");
      // A comment review and a new head change nothing but the record.
      expect(closes).toEqual([]);
      await handle.signal(pullRequestEventSignal, merge);
      return handle.result();
    });

    // DI-21.121. The workflow stays open for the deploy window after the merge, and the time-skipping
    // test environment skips that window while the test waits for the result.
    expect(result).toBe("merged");
    expect(taken).toEqual(["github:review-1", "github:sync-1", "github:close-1"]);
    expect(closes).toEqual([expect.objectContaining({ merged: true, mergeCommitSha: "merge-1" })]);
    // DI-21.104. The L4 merge steers at the start and after each event but the close.
    expect(steers).toEqual(["start", "event", "new_head"]);
  });

  // docs/specs/pr-review-merge-and-deploy.md, slice 5, DI-21.121. A merged pull request keeps its
  // workflow open for the deploys of the merge commit.
  it("takes a deploy after the merge, amends the proof pack and posts the notice last", async () => {
    const taskQueue = `pr-${randomUUID()}`;
    const taken: string[] = [];
    const calls: string[] = [];
    let state: PullRequestState = "open";
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("../../src/workflows/pr.workflow.ts", import.meta.url).pathname,
      activities: {
        takePullRequestEvent: async (input: { event: PullRequestEvent }) => {
          const isNew = !taken.includes(input.event.deliveryId);
          if (isNew) taken.push(input.event.deliveryId);
          return { isNew, state, headSha: "head-2", mergedAt: state === "merged" ? new Date().toISOString() : null };
        },
        closePullRequestOfRecord: async () => {
          state = "merged";
          return state;
        },
        steerAutoMerge: async () => ({ state: "off" }),
        planPullRequestFollowUp: async () => ({ kind: "none", reason: "no change request" }),
        readPullRequestMergeability: async () => ({ mergeability: "clean" }),
        takeDeployment: async () => {
          calls.push("take");
          return {
            kind: "recorded",
            notice: "deployed",
            sessionId: "session-1",
            amend: { tenantId: "tenant-1", productId: "product-1", runId: "run-1", afterPublication: { amendedFor: "deploy" } },
          };
        },
        amendProofPack: async () => {
          calls.push("amend");
          return { amended: true };
        },
        postPullRequestNotice: async (input: { body: string }) => {
          calls.push(`notice ${input.body}`);
        },
      },
    });
    const deployed: PullRequestEvent = {
      kind: "deployment_status",
      deliveryId: "github:deploy-1",
      deploymentId: 7,
      environment: "production",
      state: "success",
      sha: "main-later",
      ref: "main",
      environmentUrl: null,
      logUrl: null,
    };
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.signalWithStart(pullRequestWorkflow, {
        taskQueue,
        workflowId: `pr:tenant-1:acme/api#${randomUUID()}`,
        args: [{ tenantId: "tenant-1", pullRequestId: "pr-4" }],
        signal: pullRequestEventSignal,
        signalArgs: [{ ...merge, deliveryId: "github:close-4" }],
      });
      await waitFor(async () => (await handle.query(pullRequestStateQuery)).state === "merged", "the merge");
      await handle.signal(pullRequestEventSignal, deployed);
      await waitFor(() => calls.length === 3, "the deploy");
      expect((await handle.describe()).status.name).toBe("RUNNING");
      // The workflow stays open for the deploy window, so the test ends it.
      await handle.terminate("test done");
    });
    expect(calls).toEqual(["take", "amend", "notice deployed"]);
  });

  it("takes a redelivered close once", async () => {
    const taskQueue = `pr-${randomUUID()}`;
    const taken = new Set<string>();
    let closes = 0;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("../../src/workflows/pr.workflow.ts", import.meta.url).pathname,
      activities: {
        takePullRequestEvent: async (input: { event: PullRequestEvent }) => {
          const isNew = !taken.has(input.event.deliveryId);
          taken.add(input.event.deliveryId);
          return { isNew, state: "open", headSha: "head-1" };
        },
        closePullRequestOfRecord: async () => {
          closes += 1;
          return "closed";
        },
        steerAutoMerge: async () => ({ state: "off" }),
        planPullRequestFollowUp: async () => ({ kind: "none", reason: "no change request" }),
        readPullRequestMergeability: async () => ({ mergeability: "clean" }),
      },
    });
    // The record already holds the close, so the workflow skips the copy and waits.
    taken.add("github:close-2");
    const closed: PullRequestEvent = { kind: "closed", deliveryId: "github:close-2", merged: false, mergeCommitSha: null, headSha: "head-1" };
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.signalWithStart(pullRequestWorkflow, {
        taskQueue,
        workflowId: `pr:tenant-1:acme/api#${randomUUID()}`,
        args: [{ tenantId: "tenant-1", pullRequestId: "pr-2" }],
        signal: pullRequestEventSignal,
        signalArgs: [closed],
      });
      await waitFor(async () => (await handle.query(pullRequestStateQuery)).taken === 1, "the duplicate close");
      expect(closes).toBe(0);
      await handle.terminate("test done");
    });
  });

  // docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.117 to DI-21.119.
  it("brings a conflicting pull request current, and starts a PR follow-up run with the conflict", async () => {
    const taskQueue = `pr-${randomUUID()}`;
    const taken: string[] = [];
    const plannedUpdates: { reason: string; triggerKey: string }[] = [];
    const marked: string[] = [];
    const followUps: Record<string, unknown>[] = [];
    let state: PullRequestState = "open";
    let headSha = "head-1";
    const bringCurrentId = `bring-current-${randomUUID()}`;
    let drainChecks = 0;
    const heldLines: string[] = [];
    const followUpId = `pr-follow-up-${randomUUID()}`;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL("./support/pr-with-fake-runs.workflows.ts", import.meta.url).pathname,
      activities: {
        takePullRequestEvent: async (input: { event: PullRequestEvent }) => {
          const isNew = !taken.includes(input.event.deliveryId);
          if (isNew) taken.push(input.event.deliveryId);
          if (isNew && input.event.kind === "synchronized") headSha = input.event.headSha;
          return { isNew, state, headSha };
        },
        closePullRequestOfRecord: async () => {
          state = "closed";
          return state;
        },
        steerAutoMerge: async () => ({ state: "off" }),
        planPullRequestFollowUp: async () => ({ kind: "none", reason: "no change request" }),
        readPullRequestMergeability: async () => ({ mergeability: "conflict" }),
        planBringCurrent: async (input: { reason: string; triggerKey: string }) => {
          plannedUpdates.push({ reason: input.reason, triggerKey: input.triggerKey });
          return { kind: "start", workflowId: bringCurrentId, input: { bringCurrent: { headSha } } };
        },
        markBringCurrentTried: async (input: { headSha: string }) => {
          marked.push(input.headSha);
        },
        planBaseUpdateFollowUp: async (input: Record<string, unknown>) => {
          followUps.push(input);
          return { kind: "start", workflowId: followUpId, input: { prFollowUp: {} } };
        },
        // docs/specs/drain-mode.md. Drain mode is on at the first check, so the first run waits once.
        isDrainModeOn: async () => {
          drainChecks += 1;
          return drainChecks === 1;
        },
        postElicitation: async (input: { question: string }) => {
          heldLines.push(input.question);
        },
      },
    });

    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.signalWithStart(pullRequestWorkflow, {
        taskQueue,
        workflowId: `pr:tenant-1:acme/api#${randomUUID()}`,
        args: [{ tenantId: "tenant-1", pullRequestId: "pr-3" }],
        signal: pullRequestEventSignal,
        signalArgs: [synchronize],
      });
      // docs/specs/drain-mode.md. The run waits while drain mode is on, and starts at the next check.
      await waitFor(() => heldLines.length === 1, "the held line");
      await environment.sleep("61 seconds");
      await waitFor(async () => followUps.length === 1 && (await handle.query(pullRequestStateQuery)).followUp === null, "the base follow-up run");
      expect(await completedResult(followUpId)).toMatchObject({ status: "READY_FOR_HUMAN" });
      await handle.signal(pullRequestEventSignal, { ...merge, merged: false, mergeCommitSha: null, deliveryId: "github:close-3" });
      return handle.result();
    });

    expect(result).toBe("closed");
    expect(plannedUpdates).toEqual([{ reason: "conflict", triggerKey: "github:sync-1" }]);
    expect(heldLines).toEqual([HELD_LINE]);
    // DI-21.118. The update pushed nothing, so its head takes no second update until the base moves.
    expect(marked).toEqual(["head-2"]);
    expect(followUps).toEqual([
      expect.objectContaining({ headSha: "head-2", baseSha: "base-2", conflicts: ["a.ts"], failure: null, bringCurrentWorkflowId: bringCurrentId }),
    ]);
  });
});
