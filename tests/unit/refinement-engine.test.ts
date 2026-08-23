import { describe, expect, it } from "vitest";
import { RefinementEngine } from "~/domain/refinement/refinement-engine.js";
import type { RefinementInput } from "~/domain/refinement/refinement-engine.js";

const engine = new RefinementEngine();

const WHY_OPEN_QUESTION =
  "The Work Item leaves this decision open. Factoree must not invent product behavior, " +
  "so implementation cannot start safely without an answer.";

const input = (over: Partial<RefinementInput> = {}): RefinementInput => ({
  source: {
    issueId: "issue-1",
    title: "Add a webhook retry",
    description: "## Goal\n\nDeliveries must survive a transient outage.\n",
    url: "https://linear.app/acme/issue/ACME-1",
    labels: [],
  },
  project: {
    primaryRepository: "acme/webhook-service",
    referenceRepositories: ["acme/notification-service"],
    defaultAutonomy: "L3",
  },
  decisions: [],
  ...over,
});

describe("RefinementEngine", () => {
  it("takes the primary repository from the Project record", () => {
    const output = engine.refine(input());
    expect(output.primaryRepository).toBe("acme/webhook-service");
  });

  it("does not let the Work Item override the configured primary repository", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## References\n\n- other/repo\n",
        },
      }),
    );
    expect(output.primaryRepository).toBe("acme/webhook-service");
  });

  it("keeps the configured reference repositories when the Work Item names one of them", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## References\n\n- acme/notification-service\n",
        },
      }),
    );
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("keeps every configured reference repository even when the Work Item names none", () => {
    expect(engine.refine(input()).referenceRepositories).toEqual(["acme/notification-service"]);
  });

  it("records an unconfigured slug as a risk and does not select it", () => {
    const output = engine.refine(
      input({
        source: { ...input().source, description: "## References\n\n- other/repo\n" },
      }),
    );
    expect(output.referenceRepositories).toEqual(["acme/notification-service"]);
    expect(output.risks).toContain("unconfigured-repository:other/repo");
  });

  it("proposes the stated acceptance criteria unchanged", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Acceptance criteria\n\n- AC-1: A failed delivery is retried.\n",
        },
      }),
    );
    expect(output.proposedAcceptanceCriteria).toEqual([
      { id: "AC-1", statement: "A failed delivery is retried.", source: "linear:issue-1" },
    ]);
    expect(output.risks).not.toContain("no-acceptance-criteria");
  });

  it("derives one candidate criterion per goal sentence when the Work Item states none", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          title: "Retry deliveries",
          description: "## Goal\n\nA delivery is retried. A failed delivery is recorded.\n",
        },
      }),
    );
    expect(output.proposedAcceptanceCriteria).toEqual([
      { id: "AC-1", statement: "Retry deliveries", source: "derived:goal" },
      { id: "AC-2", statement: "A delivery is retried.", source: "derived:goal" },
      { id: "AC-3", statement: "A failed delivery is recorded.", source: "derived:goal" },
    ]);
    expect(output.risks).toContain("no-acceptance-criteria");
  });

  it("is ready when nothing is unresolved", () => {
    const output = engine.refine(input());
    expect(output.status).toBe("ready");
    expect(output.unresolvedQuestions).toEqual([]);
  });

  it("needs input when the Work Item states an open question", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Do we retry a 4xx response?\n",
        },
      }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions).toEqual([
      {
        id: "Q-1",
        question: "Do we retry a 4xx response?",
        whyMaterial:
          "The Work Item leaves this decision open. Factoree must not invent product behavior, " +
          "so implementation cannot start safely without an answer.",
      },
    ]);
  });

  it("needs input when the Work Item states no goal at all", () => {
    const output = engine.refine(
      input({ source: { ...input().source, title: "", description: "" } }),
    );
    expect(output.status).toBe("needs_input");
    expect(output.unresolvedQuestions[0]?.id).toBe("Q-1");
    expect(output.unresolvedQuestions[0]?.question).toMatch(/required outcome/i);
  });

  it("treats an answered question as resolved and keeps the decision", () => {
    const withQuestion = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- Do we retry a 4xx response?\n",
      },
    });
    const output = engine.refine({
      ...withQuestion,
      decisions: [
        { questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No. Retry 5xx only." },
      ],
    });
    expect(output.status).toBe("ready");
    expect(output.unresolvedQuestions).toEqual([]);
    expect(output.decisions).toEqual([
      { questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No. Retry 5xx only." },
    ]);
  });

  it("keeps the Work Item's own open questions when the goal is empty", () => {
    const output = engine.refine(
      input({
        source: {
          ...input().source,
          title: "",
          description: "## Open questions\n\n- First?\n- Second?\n",
        },
      }),
    );
    expect(output.unresolvedQuestions).toHaveLength(3);
    expect(output.unresolvedQuestions[0]?.id).toBe("Q-1");
    expect(output.unresolvedQuestions[0]?.question).toMatch(/required outcome/i);
    expect(output.unresolvedQuestions[1]).toEqual({
      id: "Q-2",
      question: "First?",
      whyMaterial: WHY_OPEN_QUESTION,
    });
    expect(output.unresolvedQuestions[2]).toEqual({
      id: "Q-3",
      question: "Second?",
      whyMaterial: WHY_OPEN_QUESTION,
    });
  });

  it("becomes the answer to the required-outcome question once it is answered, leaving the other questions open", () => {
    const withNoGoal = input({
      source: {
        ...input().source,
        title: "",
        description: "## Open questions\n\n- First?\n- Second?\n",
      },
    });
    const output = engine.refine({
      ...withNoGoal,
      decisions: [{ questionId: "Q-1", question: "What is the required outcome of this work?", answer: "Retry a failed delivery." }],
    });
    expect(output.status).toBe("needs_input");
    expect(output.goal).toBe("Retry a failed delivery.");
    expect(output.unresolvedQuestions.map((question) => question.id)).toEqual(["Q-2", "Q-3"]);
  });

  it("is ready once every question is answered, and the goal is the answer to the required-outcome question", () => {
    const withNoGoal = input({
      source: {
        ...input().source,
        title: "",
        description: "## Open questions\n\n- First?\n- Second?\n",
      },
    });
    const output = engine.refine({
      ...withNoGoal,
      decisions: [
        { questionId: "Q-1", question: "What is the required outcome of this work?", answer: "Retry a failed delivery." },
        { questionId: "Q-2", question: "First?", answer: "Yes." },
        { questionId: "Q-3", question: "Second?", answer: "No." },
      ],
    });
    expect(output.status).toBe("ready");
    expect(output.goal).toBe("Retry a failed delivery.");
  });

  it("gives each question a stable identifier across two refinements", () => {
    const twoQuestions = input({
      source: {
        ...input().source,
        description: "## Goal\n\nRetry.\n\n## Open questions\n\n- First?\n- Second?\n",
      },
    });
    const first = engine.refine(twoQuestions);
    expect(first.unresolvedQuestions.map((question) => question.id)).toEqual(["Q-1", "Q-2"]);
    const second = engine.refine({
      ...twoQuestions,
      decisions: [{ questionId: "Q-1", question: "First?", answer: "Yes." }],
    });
    expect(second.unresolvedQuestions.map((question) => question.id)).toEqual(["Q-2"]);
  });

  it("caps autonomy at L2 for a high risk label and records the label as a risk", () => {
    const output = engine.refine({
      ...input(),
      source: { ...input().source, labels: ["security"] },
    });
    expect(output.autonomyLevel).toBe("L2");
    expect(output.risks).toContain("security");
  });

  it("keeps the Project autonomy level when no high risk label is present", () => {
    expect(engine.refine(input()).autonomyLevel).toBe("L3");
  });

  it("returns the goal of the parsed Work Item", () => {
    expect(engine.refine(input()).goal).toBe(
      "Add a webhook retry\n\nDeliveries must survive a transient outage.",
    );
  });

  it("changes no source code, because it holds no file system port", () => {
    // The engine constructor takes no argument, so it cannot reach a file, a repository, or a
    // network. SDD section 8 forbids Refinement to modify source code. This test states the
    // structural reason that prohibition holds.
    expect(RefinementEngine.length).toBe(0);
  });
});
