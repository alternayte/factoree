import { describe, expect, it } from "vitest";
import { createRefinementActivities } from "~/activities/refinement.activities.js";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { RefineActivityInput } from "~/activities/refinement.activities.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";

const activities = createRefinementActivities({
  refinement: new RefinementEngine(),
  logger: createLogger({ level: "error", redactor: new Redactor() }),
});

const input = (over: Partial<RefineActivityInput> = {}): RefineActivityInput => ({
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "project-1",
  source: {
    issueId: "issue-1",
    title: "Add a webhook retry",
    description: "## Goal\n\nRetry a failed delivery.\n\n## References\n\n- https://example.com/adr/031\n",
    url: "https://linear.app/acme/issue/ACME-1",
    labels: [],
  },
  project: {
    primaryRepository: "acme/webhook-service",
    referenceRepositories: ["acme/notification-service"],
    defaultAutonomy: "L3",
    riskCaps: null,
  },
  decisions: [],
  ...over,
});

describe("refine activity", () => {
  it("reports a ready Work Item with its goal and repositories", async () => {
    const output = await activities.refine(input());
    expect(output.status).toBe("ready");
    expect(output.goal).toBe("Add a webhook retry\n\nRetry a failed delivery.");
    expect(output.primaryRepository).toBe("acme/webhook-service");
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("returns the acceptance criteria as plain statements", async () => {
    const output = await activities.refine(
      input({
        source: {
          ...input().source,
          description: "## Acceptance criteria\n\n- AC-1: A failed delivery is retried.\n",
        },
      }),
    );
    expect(output.acceptanceCriteria).toEqual(["A failed delivery is retried."]);
  });

  it("returns every Work Item reference as written", async () => {
    expect((await activities.refine(input())).workItemReferences).toEqual([
      "https://example.com/adr/031",
    ]);
  });

  it("carries every Work Item constraint into the output", async () => {
    // SDD section 40. The Reviewer receives the constraints, so Refinement must carry them.
    const output = await activities.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## Constraints\n\n- Do not change the schema.\n",
        },
      }),
    );
    expect(output.constraints).toEqual(["Do not change the schema."]);
  });

  it("reports a material question and needs input", async () => {
    const output = await activities.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Which queue?\n",
        },
      }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions).toHaveLength(1);
    expect(output.unresolvedQuestions[0]?.question).toBe("Which queue?");
  });

  it("becomes ready once the question is answered", async () => {
    const withQuestion = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Which queue?\n",
      },
    });
    const output = await activities.refine({
      ...withQuestion,
      decisions: [{ questionId: "Q-1", question: "Which queue?", answer: "The existing one." }],
    });
    expect(output.status).toBe("ready");
  });

  it("caps autonomy for a high risk label", async () => {
    const output = await activities.refine(
      input({ source: { ...input().source, labels: ["payments"] } }),
    );
    expect(output.autonomyLevel).toBe("L2");
    expect(output.risks).toContain("payments");
  });

  it("returns the same output for the same input, so a retry is safe", async () => {
    const first = await activities.refine(input());
    const second = await activities.refine(input());
    expect(second).toEqual(first);
  });
});
