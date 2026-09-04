import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { humanInputSignal, stopSignal } from "~/workflows/agent-run.workflow.js";
import { createWorkflowHarness, waitFor, waitForStatus } from "./support/harness.js";

let environment: TestWorkflowEnvironment;

const harness = createWorkflowHarness(() => environment);
const {
  implementCalls,
  recordRunTargetCalls,
  postTargetNoticeCalls,
  productInput,
  runStatusQuery,
  start,
  runWorker,
  targetIdentityOutcomes,
  targetIdentityCalls,
  postedErrors,
  completions,
  elicitations,
} = harness;

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await environment.teardown();
});

const implementsOf = (runId: string) => implementCalls.filter((entry) => entry.runId === runId);
const targetsOf = (runId: string) => recordRunTargetCalls.filter((entry) => entry.runId === runId);
const noticesOf = (runId: string) => postTargetNoticeCalls.filter((entry) => entry.runId === runId);
const identityCallsOf = (runId: string) => targetIdentityCalls.filter((entry) => entry.runId === runId);
const completionsOf = (runId: string) => completions.filter((entry) => entry.runId === runId);

/** Specification section 10. Two present repositories of one Product, for the ambiguous cases. */
const twoRepositories = [
  { id: "repository-api", fullName: "acme/api", defaultBranch: "main", absentSince: null },
  { id: "repository-web", fullName: "acme/web", defaultBranch: "main", absentSince: null },
];

/**
 * Specification section 10. Two candidates whose full names prefix one another, for the reply
 * parsing cases. A substring match would let the shorter name win a reply that names the
 * longer one.
 */
const prefixRepositories = [
  { id: "repository-checkout-api", fullName: "acme/checkout-api", defaultBranch: "main", absentSince: null },
  {
    id: "repository-checkout-api-gateway",
    fullName: "acme/checkout-api-gateway",
    defaultBranch: "main",
    absentSince: null,
  },
];

describe("target selection and the RunTarget row", () => {
  it("selects the sole member and posts no notice", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-sole");
      await waitFor(
        () => implementsOf("run-ses-target-sole").length === 1,
        "the Implementer of target-sole",
      );

      expect(targetsOf("run-ses-target-sole")).toEqual([
        expect.objectContaining({
          repositoryId: "repository-1",
          selectionReason: "sole member",
          mergeOrder: 1,
        }),
      ]);
      expect(noticesOf("run-ses-target-sole")).toEqual([]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
    });
  });

  it("posts a notice for a confident target among several members", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-confident", {
        product: { ...productInput, repositories: twoRepositories },
        repositoryProposal: {
          fullName: "acme/web",
          reason: "the change is in the checkout form",
          confident: true,
        },
      });
      await waitFor(
        () => implementsOf("run-ses-target-confident").length === 1,
        "the Implementer of target-confident",
      );

      expect(targetsOf("run-ses-target-confident")).toEqual([
        expect.objectContaining({
          repositoryId: "repository-web",
          selectionReason: "the change is in the checkout form",
          mergeOrder: 1,
        }),
      ]);
      expect(noticesOf("run-ses-target-confident")).toEqual([
        expect.objectContaining({
          fullName: "acme/web",
          reason: "the change is in the checkout form",
        }),
      ]);

      await handle.signal(stopSignal);
      await handle.result();
    });
  });

  it("blocks on an ambiguous target and resumes on a human reply", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-ambiguous", {
        product: { ...productInput, repositories: twoRepositories },
        repositoryProposal: null,
      });
      await waitForStatus(handle, "BLOCKED_TARGET");

      const blocked = await handle.query(runStatusQuery);
      expect(blocked.status).toBe("BLOCKED_TARGET");
      expect(implementsOf("run-ses-target-ambiguous")).toEqual([]);

      await handle.signal(humanInputSignal, "use acme/web");

      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
      expect(targetsOf("run-ses-target-ambiguous")).toEqual([
        expect.objectContaining({ repositoryId: "repository-web", mergeOrder: 1 }),
      ]);
    });
  });

  it("matches a reply naming the longer of two prefix-sharing candidates", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-prefix", {
        product: { ...productInput, repositories: prefixRepositories },
        repositoryProposal: null,
      });
      await waitForStatus(handle, "BLOCKED_TARGET");

      await handle.signal(humanInputSignal, "use acme/checkout-api-gateway");

      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
      expect(targetsOf("run-ses-target-prefix")).toEqual([
        expect.objectContaining({ repositoryId: "repository-checkout-api-gateway", mergeOrder: 1 }),
      ]);
    });
  });

  it("keeps the Run blocked when a reply matches no candidate by whole token", async () => {
    await runWorker(async () => {
      const handle = await start("ses-target-unmatched", {
        product: { ...productInput, repositories: prefixRepositories },
        repositoryProposal: null,
      });
      await waitForStatus(handle, "BLOCKED_TARGET");

      // This reply names no candidate by whole token. `acme/checkout-api` is a substring of
      // the longer name, not a token of this sentence. `acme/checkout-api-gatewayyy` is a typo
      // that matches nothing exactly.
      const questionsBefore = elicitations.length;
      await handle.signal(humanInputSignal, "I want the acme/checkout-api-gatewayyy one");

      // The workflow asks again, so the Run stayed blocked and made no selection from the
      // unmatched reply.
      await waitFor(
        () => elicitations.length === questionsBefore + 1,
        "the repeated target question of target-unmatched",
      );
      const blocked = await handle.query(runStatusQuery);
      expect(blocked.status).toBe("BLOCKED_TARGET");
      expect(targetsOf("run-ses-target-unmatched")).toEqual([]);

      await handle.signal(humanInputSignal, "acme/checkout-api");

      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_TARGET");
      expect(targetsOf("run-ses-target-unmatched")).toEqual([
        expect.objectContaining({ repositoryId: "repository-checkout-api", mergeOrder: 1 }),
      ]);
    });
  });
});

describe("routing identity at the base commit", () => {
  it("checks the identity block of the target repository and continues on a match", async () => {
    await runWorker(async () => {
      const handle = await start("ses-identity-match");
      await waitFor(
        () => implementsOf("run-ses-identity-match").length === 1,
        "the Implementer of identity-match",
      );

      expect(identityCallsOf("run-ses-identity-match")).toEqual([
        expect.objectContaining({ productSlug: "acme" }),
      ]);

      await handle.signal(stopSignal);
      const result = await handle.result();
      expect(result.status).not.toBe("BLOCKED_ROUTING");
    });
  });

  it("stops with BLOCKED_ROUTING when the identity block names another Product", async () => {
    targetIdentityOutcomes.set("run-ses-identity-mismatch", () => ({
      configSha: "1".repeat(64),
      matched: false,
      declaredProduct: "other-product",
    }));

    const result = await runWorker(async () => {
      const handle = await start("ses-identity-mismatch");
      return handle.result();
    });

    expect(result.status).toBe("BLOCKED_ROUTING");
    expect(implementsOf("run-ses-identity-mismatch")).toEqual([]);
    expect(completionsOf("run-ses-identity-mismatch").at(-1)?.status).toBe("BLOCKED_ROUTING");
    const message = postedErrors.at(-1) ?? "";
    expect(message).toContain("acme");
    expect(message).toContain("other-product");

    targetIdentityOutcomes.delete("run-ses-identity-mismatch");
  });
});

