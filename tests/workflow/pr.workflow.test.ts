/* eslint-disable @typescript-eslint/require-await -- test activity doubles intentionally return immediately */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { pullRequestEventSignal, pullRequestStateQuery, pullRequestWorkflow } from "~/workflows/pr.workflow.js";
import type { PullRequestEvent } from "~/domain/pull-requests/pull-request-event.js";
import type { PullRequestState } from "~/domain/runs/issue-status.js";
import { waitFor } from "./support/harness.js";

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

    expect(result).toBe("merged");
    expect(taken).toEqual(["github:review-1", "github:sync-1", "github:close-1"]);
    expect(closes).toEqual([{ merged: true, mergeCommitSha: "merge-1" }]);
    // DI-21.104. The L4 merge steers at the start and after each event but the close.
    expect(steers).toEqual(["start", "event", "new_head"]);
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
});
