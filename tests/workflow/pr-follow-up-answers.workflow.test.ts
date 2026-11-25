import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { PrFollowUpInput } from "~/domain/pull-requests/pr-follow-up.js";
import { createWorkflowHarness } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * docs/specs/pr-feedback-loop.md, DI-21.215 and DI-21.216. The refiner of a PR follow-up run reads
 * each human decision as a change request or a question. A run of questions only answers them and
 * ends ANSWERED with no implementer and no push. A mixed run answers the questions and builds the
 * changes, and each handled thread gets its reply after publication.
 */
describe("the human decisions of a PR follow-up run", () => {
  const harness = createWorkflowHarness(() => environment);
  const question = {
    key: "comment-11",
    source: "github" as const,
    author: "ana",
    body: "@factoreetemp why does this skip the cache?",
    path: null,
    line: null,
    commentId: null,
    url: "https://github.com/acme/primary/pull/7#issuecomment-11",
  };
  const change = {
    key: "review-comment-12",
    source: "github" as const,
    author: "ana",
    body: "@factoreetemp rename the prop to label",
    path: "src/a.ts",
    line: 4,
    commentId: 12,
    url: null,
  };
  const followUp = (decisions: NonNullable<PrFollowUpInput["decisions"]>): PrFollowUpInput => ({
    pullRequestId: "pull-request-1",
    repositoryId: "repository-1",
    repositoryFullName: "acme/primary",
    number: 7,
    url: "https://github.com/acme/primary/pull/7",
    headBranch: "factoree/run-1",
    headSha: "f".repeat(40),
    baseSha: "a".repeat(40),
    baseBranch: "main",
    contractRevision: 2,
    trigger: "human",
    omittedFindings: 0,
    reviewAppFindings: [],
    ciFindings: [],
    decisions,
  });
  const proposed = (answers: Array<{ key: string; changeRequested: boolean; answer: string }>) => ({
    status: "proposed" as const,
    accepted: [],
    decisions: [],
    visualEvidenceGap: null,
    reason: "",
    hang: null,
    decisionAnswers: answers,
  });

  it("answers a question, pushes nothing, and ends ANSWERED", async () => {
    const runId = "run-answer-only";
    harness.refinerOutcomes.set(runId, proposed([{ key: question.key, changeRequested: false, answer: "The cache is skipped for a signed-in user, see src/cache.ts:12." }]));

    const result = await harness.runWorker(async () => (await harness.start("answer-only", { prFollowUp: followUp([question]) })).result());

    expect(result.status).toBe("ANSWERED");
    expect(harness.refinerCalls.find((call) => call.runId === runId)?.humanDecisions?.map((line) => line.key)).toEqual([question.key]);
    expect(harness.decisionAnswerCalls.at(-1)?.answers.map((entry) => entry.decision.key)).toEqual([question.key]);
    expect(harness.implementCalls.filter((call) => call.runId === runId)).toHaveLength(0);
    expect(harness.publishCalls.filter((call) => call.runId === runId)).toHaveLength(0);
    expect(harness.postedFinalResponses.at(-1)).toContain("src/cache.ts:12");
  });

  it("answers the question, builds the change, and replies Done only to the change", async () => {
    const runId = "run-answer-mixed";
    harness.refinerOutcomes.set(
      runId,
      proposed([
        { key: question.key, changeRequested: false, answer: "The cache is skipped for a signed-in user, see src/cache.ts:12." },
        { key: change.key, changeRequested: true, answer: "" },
      ]),
    );

    const result = await harness.runWorker(async () => (await harness.start("answer-mixed", { prFollowUp: followUp([question, change]) })).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.decisionAnswerCalls.at(-1)?.answers.map((entry) => entry.decision.key)).toEqual([question.key]);
    expect(harness.implementCalls.filter((call) => call.runId === runId).length).toBeGreaterThan(0);
    expect(harness.handledThreadCalls.at(-1)?.decisions.map((decision) => decision.key)).toEqual([change.key]);
  });

  it("builds a decision the refiner did not answer", async () => {
    const runId = "run-answer-missing";
    harness.refinerOutcomes.set(runId, proposed([]));

    const result = await harness.runWorker(async () => (await harness.start("answer-missing", { prFollowUp: followUp([question]) })).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    expect(harness.implementCalls.filter((call) => call.runId === runId).length).toBeGreaterThan(0);
  });
});
