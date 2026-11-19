import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/common";
import { stopSignal, type AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import type { PrFollowUpInput } from "~/domain/pull-requests/pr-follow-up.js";
import { agentSessionKey } from "~/domain/runs/agent-session.js";
import { failureCategoryOf } from "~/domain/runs/failure-category.js";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { createWorkflowHarness, hold, waitFor } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
});

/**
 * docs/specs/provider-unreachable.md. A session that cannot reach the model provider is retried
 * twice, the second time in a fresh sandbox, and a third failure ends the Run with
 * PROVIDER_UNREACHABLE. The retries never touch the repair budget.
 */
describe("an unreachable model provider in the Run workflow", () => {
  const harness = createWorkflowHarness(() => environment);
  const unreachable = { summary: "API Error: Unable to connect to API (EAI_AGAIN)" };
  const failureOf = (runId: string) => harness.completions.filter((entry) => entry.runId === runId).at(-1);
  const preparesOf = (runId: string) => harness.prepared.filter((entry) => entry.runId === runId);
  /** The first two sessions cannot reach the provider, so the third one runs in a fresh sandbox. */
  const freshSandboxAfterTwoOutages = (runId: string): void => {
    harness.implementProviderUnreachable.set(runId, (call) => ((call.unreachableRetry ?? 0) < 2 ? unreachable : null));
  };
  /** An error Temporal wraps in an `ActivityFailure`, the shape the workflow sees after the activity retries. */
  const providerApiDown = (): Error => ApplicationFailure.nonRetryable("the sandbox provider API is down", "SandboxProviderApiError");
  /** A PR follow-up run of a human review, the one the fresh-sandbox input tests start. */
  const followUp: PrFollowUpInput = {
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
    reviewer: null,
    reviewerLogin: "ana",
    findings: [],
    omittedFindings: 0,
    plainComments: [],
  };

  it("starts a fresh session in the same sandbox after one failure, and continues the Run", async () => {
    // docs/specs/provider-unreachable.md. The retry keeps the attempt ordinal and carries an
    // unreachableRetry number instead, so the first session (retry 0) fails and the retry succeeds.
    harness.implementProviderUnreachable.set("run-unreachable-once", (call) => ((call.unreachableRetry ?? 0) === 0 ? unreachable : null));

    const result = await harness.runWorker(async () => (await harness.start("unreachable-once")).result());

    expect(result.status).toBe("READY_FOR_HUMAN");
    const calls = harness.implementCalls.filter((entry) => entry.runId === "run-unreachable-once");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.continueSession).toBeUndefined();
    expect(preparesOf("run-unreachable-once")).toHaveLength(1);
    // The repair budget stays whole.
    expect(harness.statusCalls.some((entry) => entry.runId === "run-unreachable-once" && entry.status === "REPAIRING")).toBe(false);
  });

  it("ends with PROVIDER_UNREACHABLE after three failures, names the error, and prepares a fresh sandbox on the second retry", async () => {
    harness.implementProviderUnreachable.set("run-unreachable-thrice", () => unreachable);

    const result = await harness.runWorker(async () => (await harness.start("unreachable-thrice")).result());

    expect(result.status).toBe("FAILED");
    expect(failureOf("run-unreachable-thrice")?.failureReason).toBe("PROVIDER_UNREACHABLE");
    expect(harness.implementCalls.filter((entry) => entry.runId === "run-unreachable-thrice")).toHaveLength(3);
    // One preparation for the Run, and one more for the fresh sandbox of the second retry.
    expect(preparesOf("run-unreachable-thrice")).toHaveLength(2);
    expect(harness.postedErrors.at(-1)).toContain("EAI_AGAIN");
    expect(harness.postedErrors.at(-1)).toContain("could not reach the model provider");
  });

  describe("the provider detail of the failure message (docs/specs/provider-unreachable.md, section 5)", () => {
    const detailOf = (message: string | undefined): string => {
      const text = message ?? "";
      const start = text.indexOf("Provider error: ");
      return text.slice(start + "Provider error: ".length, text.lastIndexOf(" Factoree published nothing."));
    };

    it("trims and caps a long provider summary at 1000 characters", async () => {
      const long = `   API Error: ${"x".repeat(5_000)}   `;
      harness.implementProviderUnreachable.set("run-detail-long", () => ({ summary: long }));

      await harness.runWorker(async () => (await harness.start("detail-long")).result());

      const message = failureOf("run-detail-long")?.failureMessage;
      expect(failureOf("run-detail-long")?.failureReason).toBe("PROVIDER_UNREACHABLE");
      expect(detailOf(message)).toBe(long.trim().slice(0, 1_000));
      expect(detailOf(message)).toHaveLength(1_000);
    });

    it("keeps a short summary readable", async () => {
      harness.implementProviderUnreachable.set("run-detail-short", () => unreachable);

      await harness.runWorker(async () => (await harness.start("detail-short")).result());

      expect(detailOf(failureOf("run-detail-short")?.failureMessage)).toBe(unreachable.summary);
    });

    it("says none reported for a blank summary", async () => {
      harness.implementProviderUnreachable.set("run-detail-blank", () => ({ summary: "  \n " }));

      await harness.runWorker(async () => (await harness.start("detail-blank")).result());

      expect(detailOf(failureOf("run-detail-blank")?.failureMessage)).toBe("none reported");
    });
  });

  describe("the release of the old work sandbox (docs/specs/provider-unreachable.md, section 4)", () => {
    it("releases the old sandbox, then prepares the replacement, on the normal path", async () => {
      freshSandboxAfterTwoOutages("run-fresh-destroy-ok");

      const result = await harness.runWorker(async () => (await harness.start("fresh-destroy-ok")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(harness.destroyCalls.filter((entry) => entry.runId === "run-fresh-destroy-ok")).toEqual([
        { runId: "run-fresh-destroy-ok", spriteId: "sprite-run-fresh-destroy-ok", reason: "SUPERSEDED" },
      ]);
      expect(preparesOf("run-fresh-destroy-ok")).toHaveLength(2);
      expect(harness.postedProgress.some((message) => message.includes("sprite-run-fresh-destroy-ok") && message.includes("releases the superseded sandbox"))).toBe(false);
    });

    it("still prepares the replacement when the explicit release fails, and does not end as INTERNAL_ERROR", async () => {
      freshSandboxAfterTwoOutages("run-fresh-destroy-fails");
      harness.destroyFailures.set("run-fresh-destroy-fails", providerApiDown);

      const result = await harness.runWorker(async () => (await harness.start("fresh-destroy-fails")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(failureOf("run-fresh-destroy-fails")?.failureReason).toBeUndefined();
      expect(harness.destroyCalls.filter((entry) => entry.runId === "run-fresh-destroy-fails")).toHaveLength(1);
      expect(preparesOf("run-fresh-destroy-fails")).toHaveLength(2);
      expect(harness.implementCalls.filter((entry) => entry.runId === "run-fresh-destroy-fails")).toHaveLength(3);
      // The failure is recorded once, names the old sprite, and carries the cause.
      const notes = harness.postedProgress.filter((message) => message.includes("sprite-run-fresh-destroy-fails"));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("sprite-run-fresh-destroy-fails");
      expect(notes[0]).toContain("the sandbox provider API is down");
    });

    it("lets a cancellation during the release cancel the Run, and prepares no replacement", async () => {
      freshSandboxAfterTwoOutages("run-fresh-destroy-cancel");
      const release = hold(harness.heldDestroys, "run-fresh-destroy-cancel");

      await harness.runWorker(async () => {
        const handle = await harness.start("fresh-destroy-cancel");
        await waitFor(
          () => harness.destroyCalls.some((entry) => entry.runId === "run-fresh-destroy-cancel"),
          "the release of the old work sandbox",
        );
        await handle.cancel();
        release();
        await handle.result().catch(() => undefined);
      });

      expect(preparesOf("run-fresh-destroy-cancel")).toHaveLength(1);
      expect(harness.implementCalls.filter((entry) => entry.runId === "run-fresh-destroy-cancel")).toHaveLength(2);
      expect(harness.postedProgress.some((message) => message.includes("sprite-run-fresh-destroy-cancel"))).toBe(false);
    });

    it("keeps the failure of a replacement preparation after a swallowed release failure", async () => {
      freshSandboxAfterTwoOutages("run-fresh-prepare-fails");
      harness.destroyFailures.set("run-fresh-prepare-fails", providerApiDown);
      harness.prepareFailures.set("run-fresh-prepare-fails", (call) =>
        call >= 2 ? ApplicationFailure.nonRetryable("the replacement sandbox could not be built", "SandboxBuildError") : null,
      );

      // An unexpected activity failure ends the workflow itself, after the row says FAILED.
      await harness.runWorker(async () => (await harness.start("fresh-prepare-fails")).result().catch(() => undefined));

      expect(failureOf("run-fresh-prepare-fails")?.failureReason).toBe("INTERNAL_ERROR");
      expect(failureOf("run-fresh-prepare-fails")?.failureMessage).toContain("the replacement sandbox could not be built");
      expect(preparesOf("run-fresh-prepare-fails")).toHaveLength(2);
      expect(harness.implementCalls.filter((entry) => entry.runId === "run-fresh-prepare-fails")).toHaveLength(2);
    });

    it("does not swallow a failing setRunStatus before the release", async () => {
      freshSandboxAfterTwoOutages("run-fresh-status-fails");
      // The first PREPARING call belongs to the first preparation. The second one opens the fresh-sandbox block.
      harness.statusFailures.set("run-fresh-status-fails:PREPARING", (occurrence) =>
        occurrence === 2 ? ApplicationFailure.nonRetryable("the database is down", "DatabaseError") : null,
      );

      // An unexpected activity failure ends the workflow itself, after the row says FAILED.
      await harness.runWorker(async () => (await harness.start("fresh-status-fails")).result().catch(() => undefined));

      expect(failureOf("run-fresh-status-fails")?.failureReason).toBe("INTERNAL_ERROR");
      expect(harness.destroyCalls.filter((entry) => entry.runId === "run-fresh-status-fails")).toHaveLength(0);
      expect(preparesOf("run-fresh-status-fails")).toHaveLength(1);
    });

    it("never releases a sandbox when the retry runs in the same sandbox", async () => {
      // The release exists only on the second retry. A single outage retries in place, so a broken
      // release can never matter there.
      harness.implementProviderUnreachable.set("run-same-sandbox", (call) => ((call.unreachableRetry ?? 0) === 0 ? unreachable : null));
      harness.destroyFailures.set("run-same-sandbox", providerApiDown);

      const result = await harness.runWorker(async () => (await harness.start("same-sandbox")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(harness.destroyCalls.filter((entry) => entry.runId === "run-same-sandbox")).toHaveLength(0);
      expect(preparesOf("run-same-sandbox")).toHaveLength(1);
    });
  });

  describe("the input of the fresh work sandbox equals the first one (docs/specs/provider-unreachable.md, section 4)", () => {
    const twoRepositories = [
      { id: "repository-api", fullName: "acme/api", defaultBranch: "main", absentSince: null, githubInstallationId: "install-1", linearProjects: [] },
      { id: "repository-web", fullName: "acme/web", defaultBranch: "main", absentSince: null, githubInstallationId: "install-2", linearProjects: [] },
    ];

    /**
     * Runs until the third Implementer session starts in the fresh sandbox, stops the Run, and returns
     * the first and the fresh preparation input. A PR follow-up run and a change set publish through
     * activities this harness does not model, so the Run ends here.
     */
    const preparedTwice = async (name: string, overrides: Partial<AgentRunWorkflowInput> = {}) => {
      const runId = `run-${name}`;
      freshSandboxAfterTwoOutages(runId);
      await harness.runWorker(async () => {
        const handle = await harness.start(name, overrides);
        await waitFor(
          () => harness.implementCalls.filter((entry) => entry.runId === runId).length === 3,
          `the third Implementer session of ${name}`,
        );
        await handle.signal(stopSignal);
        await handle.result();
      });
      const inputs = preparesOf(runId);
      expect(inputs).toHaveLength(2);
      const [first, fresh] = inputs;
      if (first === undefined || fresh === undefined) throw new Error("the run prepared fewer than two work sandboxes");
      return { first, fresh };
    };

    it("keeps the siblings of a run that can add a target", async () => {
      const { first, fresh } = await preparedTwice("replace-siblings", {
        product: { ...harness.productInput, repositories: twoRepositories },
        workItem: { ...harness.workItemInput, description: "## Goal\n\nRename the endpoint of api.\n" },
      });

      expect(first.siblings?.repositories.map((repository) => repository.fullName)).toEqual(["acme/web"]);
      expect(fresh.siblings?.repositoryBaseUrl).toBe(first.siblings?.repositoryBaseUrl);
      expect(fresh.siblings?.repositories).toEqual(first.siblings?.repositories);
      expect(fresh).toEqual(first);
    });

    it("adds no siblings key to a run that has none", async () => {
      const { first, fresh } = await preparedTwice("replace-no-siblings");

      expect("siblings" in first).toBe(false);
      expect("siblings" in fresh).toBe(false);
      expect(fresh).toEqual(first);
    });

    it("keeps the pull request head of a PR follow-up run", async () => {
      const { first, fresh } = await preparedTwice("replace-pr-head", { prFollowUp: followUp });

      expect(first.pullRequestHead).toBe(followUp.headSha);
      expect(fresh.pullRequestHead).toBe(first.pullRequestHead);
      expect("pullRequestMerge" in fresh).toBe(false);
      expect(fresh).toEqual(first);
    });

    it("keeps the merge flag of a bring-current follow-up run", async () => {
      const { first, fresh } = await preparedTwice("replace-pr-merge", {
        prFollowUp: {
          ...followUp,
          trigger: "base",
          reviewerLogin: null,
          baseUpdate: { previousBaseSha: "9".repeat(40), conflicts: ["src/a.ts"], failure: null },
        },
      });

      expect(first.pullRequestMerge).toBe(true);
      expect(fresh.pullRequestMerge).toBe(true);
      expect(fresh.pullRequestHead).toBe(first.pullRequestHead);
      expect(fresh).toEqual(first);
    });

    it("keeps the targets of a change set, in order, with their base SHAs and installations", async () => {
      const { first, fresh } = await preparedTwice("replace-change-set", {
        product: { ...harness.productInput, repositories: twoRepositories },
        workItem: { ...harness.workItemInput, description: "## Goal\n\nAdd the endpoint to api and call it from web.\n" },
      });

      expect(first.targets?.map((target) => [target.repository, target.githubInstallationId])).toEqual([
        ["acme/api", "install-1"],
        ["acme/web", "install-2"],
      ]);
      expect(fresh.targets).toEqual(first.targets);
      expect(fresh).toEqual(first);
    });

    it("keeps the frozen context refs, the images, the comments and the links", async () => {
      harness.contextDeliveryRefs.set("run-replace-content", ["docs/adr-1.md", "docs/adr-2.md"]);
      harness.workItemContents.set("run-replace-content", {
        comments: "A human asked for the endpoint to answer in JSON.",
        commentCount: 1,
        images: [
          {
            n: 1,
            url: "https://uploads.linear.example/mock.png",
            sha256: "1".repeat(64),
            contentType: "image/png",
            extension: "png",
            byteLength: 1_024,
            caption: "The mock of the endpoint output.",
            origin: "description",
          },
        ],
        links: [
          {
            url: "https://linear.app/acme/issue/PAY-1",
            host: "linear.app",
            sourceId: "linear",
            ref: "PAY-1",
            authority: "work_item_decision",
            sha256: "2".repeat(64),
            sizeBytes: 64,
            title: "The linked issue",
            target: { kind: "linear_issue", identifier: "PAY-1" },
          },
        ],
        skippedImages: [],
        linksNotRead: [],
        visionFailure: null,
      });

      const { first, fresh } = await preparedTwice("replace-content");

      expect(first.contextRefs).toEqual(["docs/adr-1.md", "docs/adr-2.md"]);
      expect(first.workItemImages).toHaveLength(1);
      expect(first.workItemComments).toBe("A human asked for the endpoint to answer in JSON.");
      expect(first.workItemLinks).toHaveLength(1);
      expect(fresh.contextRefs).toEqual(first.contextRefs);
      expect(fresh.workItemImages).toEqual(first.workItemImages);
      expect(fresh.workItemComments).toEqual(first.workItemComments);
      expect(fresh.workItemLinks).toEqual(first.workItemLinks);
      expect(fresh).toEqual(first);
    });
  });
  /**
   * docs/specs/provider-unreachable.md, sections 7 and 8 of the plan. Every role that retries through
   * `retryWhileUnreachable` (the Refiner, the User Validator, the Reviewer and the PR finding triage)
   * has the same ladder: the first series passes retry 1 and 2, a hung session starts a fresh one with
   * `afterHang` and no retry, and its own series passes retry 3 and 4. The rig below drives one role
   * through the harness hooks and reads back what the workflow sent to the activity.
   */
  interface RecordedCall {
    afterHang?: boolean | undefined;
    unreachableRetry?: number | undefined;
    attempt?: number | undefined;
  }
  interface RoleRig {
    label: string;
    /** The role name the failure message carries. */
    roleText: string;
    overrides: Partial<AgentRunWorkflowInput>;
    /** The status of a Run whose role answered. */
    success: "READY_FOR_HUMAN" | "REPORTED";
    outage: (runId: string, decide: (call: RecordedCall) => boolean, summary?: string) => void;
    hang: (runId: string, decide: (call: RecordedCall) => boolean) => void;
    calls: (runId: string) => RecordedCall[];
    /** The session key the activity builds from the recorded call, with the real key function. */
    key: (runId: string, call: RecordedCall) => string;
  }
  const stuck = { silenceLimitMs: 60_000 };
  const afterHangOf = (call: RecordedCall): boolean => call.afterHang === true || (call.unreachableRetry ?? 0) > 0;
  const stepOf = (call: RecordedCall): string => `${String(call.afterHang === true)}:${String(call.unreachableRetry ?? 0)}`;
  const pairsOf = (calls: RecordedCall[]): Array<[boolean, number]> =>
    calls.map((call): [boolean, number] => [call.afterHang === true, call.unreachableRetry ?? 0]);
  const reviewerFollowUp: PrFollowUpInput = {
    ...followUp,
    trigger: "reviewer",
    reviewer: { appSlug: "review-bot", checkName: "review" },
    reviewerLogin: null,
  };
  const rigs: RoleRig[] = [
    {
      label: "refiner",
      roleText: "refiner",
      overrides: {},
      success: "READY_FOR_HUMAN",
      outage: (runId, decide, summary = unreachable.summary) =>
        harness.refinerProviderUnreachable.set(runId, (call) => (decide(call) ? { summary } : null)),
      hang: (runId, decide) => harness.refinerHangs.set(runId, (call) => (decide(call) ? stuck : null)),
      calls: (runId) => harness.refinerCalls.filter((entry) => entry.runId === runId),
      key: (runId, call) => agentSessionKey(runId, "refiner", null, afterHangOf(call), call.unreachableRetry ?? 0),
    },
    {
      label: "user validator",
      roleText: "User Validator",
      overrides: {},
      success: "READY_FOR_HUMAN",
      outage: (runId, decide, summary = unreachable.summary) =>
        harness.userValidateProviderUnreachable.set(runId, (call) => (decide(call) ? { summary } : null)),
      hang: (runId, decide) => harness.userValidateHangs.set(runId, (call) => (decide(call) ? stuck : null)),
      calls: (runId) => harness.userValidateCalls.filter((entry) => entry.runId === runId),
      key: (runId, call) => agentSessionKey(runId, "validator", call.attempt ?? null, afterHangOf(call), call.unreachableRetry ?? 0),
    },
    {
      label: "reviewer",
      roleText: "Reviewer",
      overrides: {},
      success: "READY_FOR_HUMAN",
      outage: (runId, decide, summary = unreachable.summary) =>
        harness.reviewProviderUnreachable.set(runId, (call) => (decide(call) ? { summary } : null)),
      hang: (runId, decide) => harness.reviewHangs.set(runId, (call) => (decide(call) ? stuck : null)),
      calls: (runId) => harness.reviewCalls.filter((entry) => entry.runId === runId),
      key: (runId, call) => agentSessionKey(runId, "reviewer", call.attempt ?? null, afterHangOf(call), call.unreachableRetry ?? 0),
    },
    {
      label: "PR finding triage",
      roleText: "Reviewer",
      overrides: { prFollowUp: reviewerFollowUp },
      success: "REPORTED",
      outage: (runId, decide, summary = unreachable.summary) =>
        harness.triageProviderUnreachable.set(runId, (call) => (decide(call) ? { summary } : null)),
      hang: (runId, decide) => harness.triageHangs.set(runId, (call) => (decide(call) ? stuck : null)),
      calls: (runId) => harness.triageCalls.filter((entry) => entry.runId === runId),
      key: (runId, call) => `${agentSessionKey(runId, "reviewer", null, afterHangOf(call), call.unreachableRetry ?? 0)}:triage`,
    },
  ];
  const detailOf = (message: string | undefined): string => {
    const text = message ?? "";
    const start = text.indexOf("Provider error: ");
    return text.slice(start + "Provider error: ".length, text.lastIndexOf(" Factoree published nothing."));
  };
  const runIdOf = (name: string): string => `run-${name}`;
  const repairsOf = (runId: string) => harness.statusCalls.filter((entry) => entry.runId === runId && entry.status === "REPAIRING");
  const publishesOf = (runId: string) => harness.publishCalls.filter((entry) => entry.runId === runId);

  for (const rig of rigs) {
    describe(`the ${rig.label} under an unreachable provider (plan sections 7 and 8)`, () => {
      const drive = async (name: string) =>
        await harness.runWorker(async () => (await harness.start(name, rig.overrides)).result());
      const keysOf = (runId: string): string[] => rig.calls(runId).map((call) => rig.key(runId, call));

      it("recovers on the second retry, numbers its retries 0, 1, 2 and keeps one logical attempt", async () => {
        const name = `${rig.label.replaceAll(" ", "-")}-second`;
        const runId = runIdOf(name);
        rig.outage(runId, (call) => (call.unreachableRetry ?? 0) < 2);
        const progressFrom = harness.postedProgress.length;

        const result = await drive(name);

        expect(result.status).toBe(rig.success);
        const calls = rig.calls(runId);
        expect(calls.map((call) => call.unreachableRetry ?? 0)).toEqual([0, 1, 2]);
        expect(calls.every((call) => call.afterHang !== true)).toBe(true);
        expect(new Set(calls.map((call) => call.attempt)).size).toBe(1);
        expect(new Set(keysOf(runId)).size).toBe(3);
        expect(repairsOf(runId)).toHaveLength(0);
        const told = harness.postedProgress.slice(progressFrom).filter((message) => message.includes("could not reach the model provider"));
        expect(told.map((message) => message.slice(message.indexOf("(retry")))).toEqual(["(retry 1 of 2).", "(retry 2 of 2)."]);
        expect(failureOf(runId)?.failureReason).toBeUndefined();
      });

      it("ends with PROVIDER_UNREACHABLE in INFRASTRUCTURE after three outages, with the detail capped, nothing published and no repair", async () => {
        const name = `${rig.label.replaceAll(" ", "-")}-exhausted`;
        const runId = runIdOf(name);
        const long = `   API Error: ${"x".repeat(5_000)}   `;
        rig.outage(runId, () => true, long);

        const result = await drive(name);

        expect(result.status).toBe("FAILED");
        const failure = failureOf(runId);
        expect(failure?.failureReason).toBe("PROVIDER_UNREACHABLE");
        expect(failureCategoryOf("PROVIDER_UNREACHABLE")).toBe("INFRASTRUCTURE");
        expect(failure?.failureMessage).toContain(`The ${rig.roleText} session could not reach the model provider 3 times in the same step`);
        // The detail is trimmed and capped at 1000 characters, for every role (plan section 5).
        expect(detailOf(failure?.failureMessage)).toBe(long.trim().slice(0, 1_000));
        expect(detailOf(failure?.failureMessage)).toHaveLength(1_000);
        expect(failure?.failureMessage?.length ?? 0).toBeLessThan(1_400);
        expect(failure?.failureMessage).toContain("Factoree published nothing.");
        const calls = rig.calls(runId);
        expect(calls.map((call) => call.unreachableRetry ?? 0)).toEqual([0, 1, 2]);
        expect(new Set(calls.map((call) => call.attempt)).size).toBe(1);
        expect(new Set(keysOf(runId)).size).toBe(3);
        expect(repairsOf(runId)).toHaveLength(0);
        expect(publishesOf(runId)).toHaveLength(0);
        expect(harness.proofPackCalls.filter((entry) => entry.runId === runId)).toHaveLength(0);
        // A role that fails ends the Run at its own step: no second implementer attempt exists.
        expect(new Set(harness.implementCalls.filter((entry) => entry.runId === runId).map((entry) => entry.attempt)).size).toBeLessThanOrEqual(1);
      });

      it("keeps every (afterHang, unreachableRetry) pair of the step unique through an outage, a hang and two more outages", async () => {
        const name = `${rig.label.replaceAll(" ", "-")}-outage-hang-outage`;
        const runId = runIdOf(name);
        // Series one: outage (retry 0), hang (retry 1). The fresh session after the hang carries
        // afterHang and no retry, fails, and its own series passes 3, 4: the last one answers.
        rig.outage(runId, (call) => ["false:0", "true:0", "true:3"].includes(stepOf(call)));
        rig.hang(runId, (call) => stepOf(call) === "false:1");
        const progressFrom = harness.postedProgress.length;

        const result = await drive(name);

        expect(result.status).toBe(rig.success);
        const calls = rig.calls(runId);
        expect(pairsOf(calls)).toEqual([
          [false, 0],
          [false, 1],
          [true, 0],
          [true, 3],
          [true, 4],
        ]);
        expect(new Set(calls.map((call) => stepOf(call))).size).toBe(calls.length);
        expect(new Set(calls.map((call) => call.attempt)).size).toBe(1);
        // The six keys of a step are distinct, and so are the five of this sequence.
        expect(new Set(keysOf(runId)).size).toBe(calls.length);
        expect(repairsOf(runId)).toHaveLength(0);
        expect(harness.postedProgress.slice(progressFrom).some((message) => message.includes("wrote no output for"))).toBe(true);
        expect(failureOf(runId)?.failureReason).toBeUndefined();
      });

      it("ends with PROVIDER_UNREACHABLE when the fresh session after a hang cannot reach the provider either", async () => {
        const name = `${rig.label.replaceAll(" ", "-")}-hang-outage`;
        const runId = runIdOf(name);
        rig.hang(runId, (call) => stepOf(call) === "false:0");
        rig.outage(runId, (call) => call.afterHang === true);

        const result = await drive(name);

        expect(result.status).toBe("FAILED");
        expect(failureOf(runId)?.failureReason).toBe("PROVIDER_UNREACHABLE");
        const calls = rig.calls(runId);
        expect(pairsOf(calls)).toEqual([
          [false, 0],
          [true, 0],
          [true, 3],
          [true, 4],
        ]);
        expect(new Set(keysOf(runId)).size).toBe(calls.length);
        expect(repairsOf(runId)).toHaveLength(0);
        expect(publishesOf(runId)).toHaveLength(0);
      });
    });
  }

  describe("the parallel Reviewer during a failed user validation (plan section 7, item 4)", () => {
    const failing: UserValidateActivityOutput = {
      passed: false,
      results: [{ assertionId: "VAL-API-002", result: "FAIL", reason: "The reload does not show the saved name." }],
      hasFailure: true,
      hasManual: false,
      hasBlocked: false,
      summary: "One user validation assertion failed.",
      failures: ["VAL-API-002: the reload does not show the saved name."],
      sessionId: "ses_fake_validator",
      previewUrl: null,
      hang: null,
    };

    it("ends with PROVIDER_UNREACHABLE, publishes nothing and consumes no repair when the Reviewer exhausts its retries", async () => {
      const runId = "run-parallel-review-outage";
      harness.userValidationOutcomes.set(runId, () => failing);
      harness.reviewProviderUnreachable.set(runId, () => unreachable);

      const result = await harness.runWorker(async () => (await harness.start("parallel-review-outage")).result());

      expect(result.status).toBe("FAILED");
      expect(failureOf(runId)?.failureReason).toBe("PROVIDER_UNREACHABLE");
      expect(failureOf(runId)?.failureMessage).toContain("The Reviewer session could not reach the model provider 3 times in the same step");
      const reviews = harness.reviewCalls.filter((entry) => entry.runId === runId);
      expect(reviews.map((entry) => [entry.attempt, entry.unreachableRetry ?? 0])).toEqual([
        [1, 0],
        [1, 1],
        [1, 2],
      ]);
      // The outage is not "no findings": no repair starts, and the failed validation spent nothing.
      expect(repairsOf(runId)).toHaveLength(0);
      expect(harness.implementCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
      expect(harness.userValidateCalls.filter((entry) => entry.runId === runId)).toHaveLength(1);
      expect(publishesOf(runId)).toHaveLength(0);
    });

    it("keeps a real repair when the Reviewer recovers on a retry", async () => {
      const runId = "run-parallel-review-recovers";
      harness.userValidationOutcomes.set(runId, (attempt) => (attempt === 1 ? failing : { ...failing, passed: true, hasFailure: false, results: [], failures: [], summary: "Every user validation assertion passed." }));
      harness.reviewProviderUnreachable.set(runId, (call) => (call.attempt === 1 && (call.unreachableRetry ?? 0) === 0 ? unreachable : null));

      const result = await harness.runWorker(async () => (await harness.start("parallel-review-recovers")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(repairsOf(runId)).toHaveLength(1);
      expect(repairsOf(runId)[0]?.repairCount).toBe(1);
      expect(harness.implementCalls.filter((entry) => entry.runId === runId).map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(
        harness.reviewCalls.filter((entry) => entry.runId === runId).map((entry) => [entry.attempt, entry.unreachableRetry ?? 0]),
      ).toEqual([
        [1, 0],
        [1, 1],
        [2, 0],
      ]);
    });
  });

  describe("the Implementer numbering (plan section 8)", () => {
    const implementedBy = (runId: string) => harness.implementCalls.filter((entry) => entry.runId === runId);
    const implementerKey = (runId: string, call: { attempt: number; unreachableRetry?: number | undefined }): string =>
      agentSessionKey(runId, "implementer", call.attempt, false, call.unreachableRetry ?? 0);

    it("keeps the logical attempt for three sessions and numbers the retries 0, 1, 2", async () => {
      const runId = "run-implementer-numbers";
      freshSandboxAfterTwoOutages(runId);

      const result = await harness.runWorker(async () => (await harness.start("implementer-numbers")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      const calls = implementedBy(runId);
      expect(calls.map((call) => call.attempt)).toEqual([1, 1, 1]);
      expect(calls.map((call) => call.unreachableRetry ?? 0)).toEqual([0, 1, 2]);
      expect(new Set(calls.map((call) => implementerKey(runId, call))).size).toBe(3);
      expect(repairsOf(runId)).toHaveLength(0);
    });

    it("keeps every (attempt, unreachableRetry) pair unique through an outage, a hang resume and a later outage", async () => {
      const runId = "run-implementer-outage-hang";
      // Attempt 1: the first session cannot reach the provider, its retry hangs. The hang resumes
      // the session once as attempt 2, which uses the repair budget. That session cannot reach the
      // provider either, and its own retry answers.
      harness.implementProviderUnreachable.set(runId, (call) =>
        (call.attempt === 1 && (call.unreachableRetry ?? 0) === 0) || (call.attempt === 2 && (call.unreachableRetry ?? 0) === 0) ? unreachable : null,
      );
      harness.implementHangs.set(runId, (call) => (call.attempt === 1 && call.unreachableRetry === 1 ? stuck : null));

      const result = await harness.runWorker(async () => (await harness.start("implementer-outage-hang")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      const calls = implementedBy(runId);
      expect(calls.map((call) => [call.attempt, call.unreachableRetry ?? 0])).toEqual([
        [1, 0],
        [1, 1],
        [2, 0],
        [2, 1],
      ]);
      // Only the hang resume reaches the repair budget. The two outages of the sequence do not.
      expect(repairsOf(runId).map((entry) => [entry.repairCount, entry.repairReason])).toEqual([[1, "AGENT_HUNG"]]);
      expect(calls[2]?.continueSession).toBeDefined();
      expect(calls[3]?.continueSession).toBeUndefined();
      expect(new Set(calls.map((call) => implementerKey(runId, call))).size).toBe(4);
    });

    it("counts the repair only when a run needs one real repair and hits one outage", async () => {
      const runId = "run-implementer-repair-outage";
      harness.verifyOutcomes.set(runId, (attempt) => attempt >= 2);
      harness.implementProviderUnreachable.set(runId, (call) => (call.attempt === 2 && (call.unreachableRetry ?? 0) === 0 ? unreachable : null));
      const progressFrom = harness.postedProgress.length;

      const result = await harness.runWorker(async () => (await harness.start("implementer-repair-outage")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(implementedBy(runId).map((call) => [call.attempt, call.unreachableRetry ?? 0])).toEqual([
        [1, 0],
        [2, 0],
        [2, 1],
      ]);
      expect(harness.verifyCalls.filter((entry) => entry.runId === runId).map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(repairsOf(runId).map((entry) => [entry.repairCount, entry.repairReason])).toEqual([[1, "VERIFICATION"]]);
      const progress = harness.postedProgress.slice(progressFrom);
      expect(progress.filter((message) => message.includes("starts repair"))).toHaveLength(1);
      expect(progress.filter((message) => message.includes("starts repair 1 of"))).toHaveLength(1);
      expect(progress.filter((message) => message.includes("(retry 1 of 2)"))).toHaveLength(1);
    });

    it("counts the repair only when a validator outage follows one real validation repair", async () => {
      const runId = "run-validator-repair-outage";
      harness.userValidationOutcomes.set(runId, (attempt): UserValidateActivityOutput =>
        attempt === 1
          ? {
              passed: false,
              results: [{ assertionId: "VAL-API-002", result: "FAIL", reason: "The reload does not show the saved name." }],
              hasFailure: true,
              hasManual: false,
              hasBlocked: false,
              summary: "One user validation assertion failed.",
              failures: ["VAL-API-002: the reload does not show the saved name."],
              sessionId: "ses_fake_validator",
              previewUrl: null,
              hang: null,
            }
          : {
              passed: true,
              results: [],
              hasFailure: false,
              hasManual: false,
              hasBlocked: false,
              summary: "Every user validation assertion passed.",
              failures: [],
              sessionId: "ses_fake_validator",
              previewUrl: null,
              hang: null,
            },
      );
      harness.userValidateProviderUnreachable.set(runId, (call) => (call.attempt === 2 && (call.unreachableRetry ?? 0) === 0 ? unreachable : null));

      const result = await harness.runWorker(async () => (await harness.start("validator-repair-outage")).result());

      expect(result.status).toBe("READY_FOR_HUMAN");
      expect(harness.userValidateCalls.filter((entry) => entry.runId === runId).map((entry) => [entry.attempt, entry.unreachableRetry ?? 0])).toEqual([
        [1, 0],
        [2, 0],
        [2, 1],
      ]);
      expect(harness.implementCalls.filter((entry) => entry.runId === runId).map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(repairsOf(runId).map((entry) => [entry.repairCount, entry.repairReason])).toEqual([[1, "VALIDATION"]]);
    });
  });
});
