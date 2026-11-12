import { describe, expect, it } from "vitest";
import {
  BlockerWait,
  blockersOf,
  isOpenBlocker,
  UNREAD_LINE,
  UNRETURNED_LINE,
  type Blocker,
  type CreateWaitingRunInput,
  type ReadBlocker,
  type WaitingRun,
  type WaitingRunStore,
} from "~/domain/runs/blocker-wait.js";
import type { StopRequest } from "~/domain/runs/run-stop.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import { createLinearBlockerReader } from "~/adapters/linear/linear-blockers.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const logger = createLogger({ level: "error", redactor: new Redactor(), sink: () => undefined });

const startInput = { tenantId: "tenant-1", agentSessionId: "session-2" } as AgentRunWorkflowInput;

const read = (issueId: string, identifier: string, state: string): ReadBlocker => ({
  issueId,
  identifier,
  url: `https://linear.app/acme/issue/${identifier}`,
  state,
});

/** An in-memory store with the same conditional writes as the Prisma store. */
const memoryStore = () => {
  const runs = new Map<string, WaitingRun & { status: string; stop?: StopRequest }>();
  const pullRequests = new Map<string, string>();
  /** When set, the next list answers this snapshot, as a sweep that read before another wrote. */
  const snapshot: { runs: WaitingRun[] | null } = { runs: null };
  const store: WaitingRunStore = {
    createWaiting(input: CreateWaitingRunInput) {
      const existing = [...runs.values()].find((run) => run.temporalWorkflowId === input.temporalWorkflowId);
      if (existing !== undefined) return Promise.resolve({ runId: existing.id, created: false });
      const id = `run-${String(runs.size + 1)}`;
      runs.set(id, {
        id,
        tenantId: input.tenantId,
        productId: input.productId,
        linearIssueId: input.linearIssueId,
        linearAgentSessionId: input.linearAgentSessionId,
        temporalWorkflowId: input.temporalWorkflowId,
        blockers: input.blockers,
        startInput: input.startInput,
        status: "WAITING_FOR_BLOCKERS",
      });
      return Promise.resolve({ runId: id, created: true });
    },
    listWaiting: (tenantId) => {
      const stale = snapshot.runs;
      snapshot.runs = null;
      return Promise.resolve(
        stale ??
          [...runs.values()]
            .filter((run) => run.status === "WAITING_FOR_BLOCKERS" && (tenantId === undefined || run.tenantId === tenantId))
            .map((run) => structuredClone(run)),
      );
    },
    findWaiting: (tenantId, runId) => {
      const run = runs.get(runId);
      return Promise.resolve(run !== undefined && run.tenantId === tenantId && run.status === "WAITING_FOR_BLOCKERS" ? run : null);
    },
    replaceBlockers(runId, previous, next) {
      const run = runs.get(runId);
      if (run === undefined || run.status !== "WAITING_FOR_BLOCKERS" || JSON.stringify(run.blockers) !== JSON.stringify(previous)) {
        return Promise.resolve(false);
      }
      run.blockers = next;
      return Promise.resolve(true);
    },
    clearBlockers(runId, previous) {
      const run = runs.get(runId);
      if (run === undefined || run.status !== "WAITING_FOR_BLOCKERS" || JSON.stringify(run.blockers) !== JSON.stringify(previous)) {
        return Promise.resolve(false);
      }
      run.blockers = null;
      return Promise.resolve(true);
    },
    cancel(tenantId, runId, request) {
      const run = runs.get(runId);
      if (run === undefined || run.tenantId !== tenantId || run.status !== "WAITING_FOR_BLOCKERS") return Promise.resolve(null);
      run.status = "CANCELLED";
      run.stop = request;
      return Promise.resolve(run);
    },
    pullRequestsOf: (_tenantId, issueIds) =>
      Promise.resolve(new Map([...pullRequests].filter(([issueId]) => issueIds.includes(issueId)))),
  };
  return { store, runs, pullRequests, snapshot };
};

const build = () => {
  const { store, runs, pullRequests, snapshot } = memoryStore();
  /** The blockers Linear answers for each work item. */
  const linear = new Map<string, ReadBlocker[]>();
  let readFails = false;
  const reads: string[][] = [];
  const started = new Set<string>();
  const starts: string[] = [];
  const posts: Array<{ sessionId: string; kind: string; body: string }> = [];
  const wait = new BlockerWait({
    store,
    reader: () =>
      Promise.resolve({
        read: (issueIds: readonly string[]) => {
          reads.push([...issueIds]);
          if (readFails) return Promise.reject(new Error("the Linear API answered 500"));
          return Promise.resolve(new Map(issueIds.flatMap((id) => (linear.has(id) ? [[id, linear.get(id) ?? []] as const] : []))));
        },
      }),
    start: (workflowId) => {
      starts.push(workflowId);
      if (started.has(workflowId)) return Promise.resolve("already_started" as const);
      started.add(workflowId);
      return Promise.resolve("started" as const);
    },
    post: (_tenantId, sessionId, kind, body) => {
      posts.push({ sessionId, kind, body });
      return Promise.resolve();
    },
    logger,
  });
  const hold = (issueId = "issue-2", workflowId = "workflow-2") =>
    wait.hold({
      tenantId: "tenant-1",
      productId: "product-1",
      linearIssueId: issueId,
      linearAgentSessionId: `session-${issueId}`,
      temporalWorkflowId: workflowId,
      autonomyLevel: "L2",
      workItemTitle: "Second",
      workItemUrl: null,
      startInput,
    });
  return {
    wait,
    hold,
    runs,
    pullRequests,
    snapshot,
    linear,
    reads,
    starts,
    posts,
    failReads: (fails: boolean) => {
      readFails = fails;
    },
  };
};

describe("blocker classification", () => {
  it("takes only `blocks` relations and their issue, once each", () => {
    const blockers = blockersOf([
      { type: "blocks", issue: { id: "a", identifier: "FAC-1", url: "u", state: { type: "started" } } },
      { type: "related", issue: { id: "b", identifier: "FAC-2", state: { type: "started" } } },
      { type: "duplicate", issue: { id: "c", identifier: "FAC-3", state: { type: "started" } } },
      { type: "similar", issue: { id: "d", identifier: "FAC-4", state: { type: "started" } } },
      { type: "blocks", issue: null },
      { type: "blocks", issue: { id: "a", identifier: "FAC-1", url: "u", state: { type: "started" } } },
    ]);
    expect(blockers).toEqual([{ issueId: "a", identifier: "FAC-1", url: "u", state: "started" }]);
  });

  it("holds while the state is not completed and not canceled", () => {
    for (const state of ["triage", "backlog", "unstarted", "started", "unknown"]) expect(isOpenBlocker({ state })).toBe(true);
    for (const state of ["completed", "canceled"]) expect(isOpenBlocker({ state })).toBe(false);
  });
});

describe("the hold at delegation", () => {
  it("holds a work item with an open blocker and names its Factoree pull request", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started"), read("issue-9", "FAC-9", "completed")]);
    harness.pullRequests.set("issue-1", "https://github.com/org/repo/pull/2");
    expect(await harness.hold()).toBe(true);
    const run = [...harness.runs.values()][0];
    expect(run?.status).toBe("WAITING_FOR_BLOCKERS");
    expect(run?.blockers?.map((blocker) => [blocker.identifier, blocker.state, blocker.pullRequestUrl])).toEqual([
      ["FAC-1", "started", "https://github.com/org/repo/pull/2"],
      ["FAC-9", "completed", null],
    ]);
    expect(harness.posts).toEqual([
      {
        sessionId: "session-issue-2",
        kind: "elicitation",
        body: "Waiting for FAC-1 (https://github.com/org/repo/pull/2) to complete. Factoree starts this issue when it does.",
      },
    ]);
  });

  it("does not hold a work item whose blockers all completed or were canceled", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "completed"), read("issue-3", "FAC-3", "canceled")]);
    expect(await harness.hold()).toBe(false);
    expect(harness.runs.size).toBe(0);
    expect(harness.posts).toEqual([]);
  });

  it("waits when the read fails, and the next sweep reads again", async () => {
    const harness = build();
    harness.failReads(true);
    expect(await harness.hold()).toBe(true);
    expect([...harness.runs.values()][0]?.blockers).toBeNull();
    expect(harness.posts.map((post) => post.body)).toEqual([UNREAD_LINE]);

    harness.failReads(false);
    harness.linear.set("issue-2", []);
    await harness.wait.sweep();
    expect(harness.starts).toEqual(["workflow-2"]);
  });
});

describe("the sweep", () => {
  it("reads every waiting run of a tenant with one batched read", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    harness.linear.set("issue-3", [read("issue-1", "FAC-1", "started")]);
    await harness.hold("issue-2", "workflow-2");
    await harness.hold("issue-3", "workflow-3");
    harness.reads.length = 0;
    await harness.wait.sweep();
    expect(harness.reads).toEqual([["issue-2", "issue-3"]]);
  });

  it("starts the run once no blocker is open, and a second start of the id does nothing", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    expect(await harness.wait.sweep()).toEqual({ released: 0 });
    expect(harness.starts).toEqual([]);

    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "completed")]);
    expect(await harness.wait.sweep()).toEqual({ released: 1 });
    // The row still waits until the workflow adopts it, so a second sweep tries again and the
    // deterministic workflow id refuses it.
    expect(await harness.wait.sweep()).toEqual({ released: 0 });
    expect(harness.starts).toEqual(["workflow-2", "workflow-2"]);
    // The release posts nothing. The workflow acknowledges the session when it starts.
    expect(harness.posts).toHaveLength(1);
  });

  it("releases the run when the relation is removed", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    // Removing the relation in Linear is the human override.
    harness.linear.set("issue-2", []);
    await harness.wait.sweep();
    expect(harness.starts).toEqual(["workflow-2"]);
    expect([...harness.runs.values()][0]?.blockers).toEqual([]);
  });

  it("holds a run whose issue Linear does not return, and posts the line once", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    // DI-21.85. The issue was deleted, or the app lost access to its team.
    harness.linear.delete("issue-2");
    await harness.wait.sweep();
    await harness.wait.sweep();
    expect(harness.starts).toEqual([]);
    expect([...harness.runs.values()][0]?.blockers).toBeNull();
    expect(harness.posts.map((post) => post.body).filter((body) => body === UNRETURNED_LINE)).toHaveLength(1);
    // Access comes back and the blocker completed: the run starts.
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "completed")]);
    await harness.wait.sweep();
    expect(harness.starts).toEqual(["workflow-2"]);
  });

  it("holds the run when a relation is added, and posts a line only when the open set changes", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "completed"), read("issue-5", "FAC-5", "backlog")]);
    await harness.wait.sweep();
    // A state change inside the open set updates the row and posts nothing.
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "completed"), read("issue-5", "FAC-5", "started")]);
    await harness.wait.sweep();
    await harness.wait.sweep();
    expect(harness.starts).toEqual([]);
    expect(harness.posts.map((post) => post.body)).toEqual([
      "Waiting for FAC-1 to complete. Factoree starts this issue when it does.",
      "Waiting for FAC-5 to complete. Factoree starts this issue when it does.",
    ]);
    expect([...harness.runs.values()][0]?.blockers?.find((blocker) => blocker.identifier === "FAC-5")?.state).toBe("started");
  });

  it("posts nothing when another sweep changed the row since this read", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    const run = harness.runs.get("run-1");
    if (run === undefined) throw new Error("no run");
    // This sweep read the row before another sweep wrote FAC-5 to it.
    harness.snapshot.runs = [structuredClone(run)];
    const written: Blocker[] = [{ ...read("issue-5", "FAC-5", "started"), pullRequestUrl: null }];
    run.blockers = written;
    harness.linear.set("issue-2", [read("issue-5", "FAC-5", "started")]);
    harness.posts.length = 0;
    expect(await harness.wait.sweep()).toEqual({ released: 0 });
    expect(harness.posts).toEqual([]);
    expect(run.blockers).toBe(written);
  });

  it("starts nothing for a run a stop cancelled", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    expect(await harness.wait.stop("tenant-1", "run-1", { source: "factoree_ui", by: "Nate" })).toBe(true);
    harness.linear.set("issue-2", []);
    await harness.wait.sweep();
    expect(harness.starts).toEqual([]);
  });
});

describe("a stop and a reply during the wait", () => {
  it("cancels the waiting run and posts the stop message", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    await harness.hold();
    expect(await harness.wait.stop("tenant-1", "run-1", { source: "linear" })).toBe(true);
    expect(harness.runs.get("run-1")?.status).toBe("CANCELLED");
    expect(harness.posts.at(-1)).toEqual({
      sessionId: "session-issue-2",
      kind: "response",
      body: "Factoree stopped this Run at your request. No change was published.",
    });
    // A run that no longer waits takes no second cancel.
    expect(await harness.wait.stop("tenant-1", "run-1", { source: "linear" })).toBe(false);
  });

  it("answers a reply with the open blockers and the override", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started"), read("issue-3", "FAC-3", "unstarted")]);
    await harness.hold();
    expect(await harness.wait.answerReply("tenant-1", "run-1")).toBe(true);
    expect(harness.posts.at(-1)).toEqual({
      sessionId: "session-issue-2",
      kind: "response",
      body: "This issue waits for FAC-1 and FAC-3 to complete. Remove the relation in Linear to start now.",
    });
  });

  it("posts one line on each waiting session when a blocker's pull request closes unmerged", async () => {
    const harness = build();
    harness.linear.set("issue-2", [read("issue-1", "FAC-1", "started")]);
    harness.linear.set("issue-3", [read("issue-1", "FAC-1", "started")]);
    harness.linear.set("issue-4", [read("issue-8", "FAC-8", "started")]);
    await harness.hold("issue-2", "workflow-2");
    await harness.hold("issue-3", "workflow-3");
    await harness.hold("issue-4", "workflow-4");
    harness.posts.length = 0;
    await harness.wait.pullRequestClosedUnmerged("tenant-1", "issue-1", "org/repo#2");
    expect(harness.posts).toEqual(
      ["session-issue-2", "session-issue-3"].map((sessionId) => ({
        sessionId,
        kind: "response",
        body: "The pull request org/repo#2 of FAC-1 closed without a merge. FAC-1 is still open, so this issue keeps waiting for it.",
      })),
    );
  });
});

describe("the Linear blocker reader", () => {
  it("reads every issue in one query per page and keeps only blocks relations", async () => {
    const bodies: Array<{ query: string; variables: { ids: string[]; after: string | null } }> = [];
    const pages = [
      {
        nodes: [
          {
            id: "issue-2",
            inverseRelations: {
              nodes: [
                { type: "blocks", issue: { id: "issue-1", identifier: "FAC-1", url: "u1", state: { type: "started" } } },
                { type: "related", issue: { id: "issue-5", identifier: "FAC-5", url: "u5", state: { type: "started" } } },
              ],
            },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      },
      { nodes: [{ id: "issue-3", inverseRelations: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    const call = ((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as (typeof bodies)[number]);
      return Promise.resolve(new Response(JSON.stringify({ data: { issues: pages[bodies.length - 1] } }), { status: 200 }));
    }) as unknown as typeof fetch;
    const blockers = await createLinearBlockerReader("token", call).read(["issue-2", "issue-3"]);
    expect(bodies.map((body) => body.variables)).toEqual([
      { ids: ["issue-2", "issue-3"], after: null },
      { ids: ["issue-2", "issue-3"], after: "c1" },
    ]);
    expect(bodies[0]?.query).toContain("issues(filter: { id: { in: $ids } }");
    expect(blockers).toEqual(
      new Map([
        ["issue-2", [{ issueId: "issue-1", identifier: "FAC-1", url: "u1", state: "started" }]],
        ["issue-3", []],
      ]),
    );
  });
});
