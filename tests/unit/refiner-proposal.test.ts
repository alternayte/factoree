import { describe, expect, it } from "vitest";
import {
  gateRefinerProposal,
  overLimitMessage,
  parseRefinerProposal,
  proposalOverLimitOf,
  RefinerProposalError,
  refinementDecisions,
} from "~/domain/refinement/refiner-proposal.js";
import { describeDecision } from "~/domain/runs/factoree-decision.js";

const TICKET =
  "Retry failed notifications\n\n## Goal\n\nA failed notification delivery is never retried. Users lose messages.\n";

const proposal = (criteria: unknown[], questions: unknown[] = []) =>
  JSON.stringify({ criteria, questions, patterns: ["src/notify/retry.ts"] });

describe("parseRefinerProposal", () => {
  it("refuses text that is not JSON, and a document with an unknown field", () => {
    expect(() => parseRefinerProposal("not json")).toThrow(RefinerProposalError);
    expect(() => parseRefinerProposal(JSON.stringify({ criteria: [], questions: [], patterns: [], extra: 1 }))).toThrow(
      RefinerProposalError,
    );
  });

  // Issue #39, DI-21.66. The Product sets the criteria cap, and only a cap fault is over-limit.
  const criterion = (index: number) => ({
    statement: `Criterion ${String(index)}.`,
    origin: "stated",
    quote: "A failed notification delivery is never retried.",
    method: "test",
    target: "tests/retry.test.ts",
  });
  const criteria = (count: number) => Array.from({ length: count }, (_, index) => criterion(index));
  const question = { question: "Which?", proposal: "This.", reason: "Because." };

  it("caps the criteria at the limit it is given, 20 by default", () => {
    expect(parseRefinerProposal(proposal(criteria(20))).criteria).toHaveLength(20);
    expect(() => parseRefinerProposal(proposal(criteria(21)))).toThrow(RefinerProposalError);
    expect(parseRefinerProposal(proposal(criteria(30)), 30).criteria).toHaveLength(30);
    expect(proposalOverLimitOf(proposal(criteria(31)), 30)).toEqual({ criteria: { count: 31, limit: 30 }, questions: null });
  });

  it("reports too many questions, and both lists together", () => {
    const six = Array.from({ length: 6 }, () => question);
    expect(proposalOverLimitOf(proposal(criteria(1), six), 20)).toEqual({ criteria: null, questions: { count: 6, limit: 5 } });
    expect(proposalOverLimitOf(proposal(criteria(3), six), 2)).toEqual({
      criteria: { count: 3, limit: 2 },
      questions: { count: 6, limit: 5 },
    });
  });

  it("is not over-limit when another schema fault comes with the cap, or when the proposal parses", () => {
    // Zod checks an array's length before its items, so the sibling fault is the one that shows.
    const extra = JSON.stringify({ criteria: criteria(3), questions: [], patterns: [], extra: 1 });
    expect(proposalOverLimitOf(extra, 2)).toBeNull();
    expect(proposalOverLimitOf(JSON.stringify({ criteria: criteria(1), questions: [], patterns: Array(21).fill("p") }), 20)).toBeNull();
    expect(proposalOverLimitOf(proposal(criteria(2)), 20)).toBeNull();
    expect(proposalOverLimitOf("not json", 20)).toBeNull();
  });

  it("names the limit and the way out, not the schema", () => {
    const message = overLimitMessage({ criteria: { count: 24, limit: 20 }, questions: null });
    expect(message).toBe(
      "The Work Item needs more than 20 acceptance criteria, the limit of this product. Split it into smaller issues, " +
        "or raise the refiner criteria limit on the product page. Factoree published nothing.",
    );
  });
});

const NO_PREVIEW = { previewConfigured: false };
const WITH_PREVIEW = { previewConfigured: true };

describe("gateRefinerProposal (docs/specs/refiner-agent.md, own-proposals-and-parallel-runs.md)", () => {
  it("accepts a stated criterion that quotes the ticket, with its runnable check", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          {
            statement: "A failed delivery is retried until it succeeds.",
            origin: "stated",
            quote: "A failed notification delivery is never retried.",
            method: "test",
            target: "tests/notify/retry.test.ts",
          },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted).toEqual([
      {
        id: "AC-R1",
        statement: "A failed delivery is retried until it succeeds.",
        source: "ticket:quote",
        method: "test",
        target: "tests/notify/retry.test.ts",
      },
    ]);
    expect(gated.implied).toEqual([]);
    expect(refinementDecisions(gated)).toEqual([]);
  });

  it("freezes an implied criterion with its cited sentence, and Factoree decides it without a question", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          {
            statement: "A retried delivery keeps its original message.",
            origin: "implied",
            quote: "Users lose messages.",
            method: "test",
            target: "t.test.ts",
          },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted[0]?.source).toBe("implied by: Users lose messages.");
    expect(gated.implied).toHaveLength(1);
    expect(refinementDecisions(gated).map(describeDecision)).toEqual([
      'Factoree added the implied criterion "A retried delivery keeps its original message", because the ticket says "Users lose messages".',
    ]);
  });

  it("does not build a new criterion, or one whose quote the ticket does not hold, and asks nobody (§7)", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "Also email the admin.", origin: "new", quote: null, method: "test", target: "t.test.ts" },
          { statement: "Retries stop after five attempts.", origin: "implied", quote: "five attempts", method: "test", target: "t.test.ts" },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted).toEqual([]);
    expect(gated.notBuilt).toEqual(["Also email the admin.", "Retries stop after five attempts."]);
    expect(refinementDecisions(gated).every((decision) => decision.kind === "not_built")).toBe(true);
  });

  it("drops a criterion with no automated check (FAC-42 live run)", () => {
    // FAC-42 froze a code_review criterion, and the workflow ends every Run that holds one.
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "The API answers.", origin: "stated", quote: "Users lose messages.", method: "http", target: "the api" },
          { statement: "The page shows it.", origin: "stated", quote: "Users lose messages.", method: "browser", target: null },
          { statement: "The code reads the version.", origin: "stated", quote: "Users lose messages.", method: "code_review", target: "src/a.ts" },
          { statement: "GET works.", origin: "stated", quote: "Users lose messages.", method: "http", target: "GET /health" },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted.map((criterion) => criterion.statement)).toEqual(["GET works."]);
    expect(gated.unverifiable).toEqual(["The API answers.", "The page shows it.", "The code reads the version."]);
    expect(refinementDecisions(gated).filter((decision) => decision.kind === "dropped")).toHaveLength(3);
  });

  it("takes the refiner's proposed answer, with one period at the end of each sentence", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(proposal([], [{ question: "Which version?", proposal: "Add 0.1.0.", reason: "None is declared." }])),
      TICKET,
      NO_PREVIEW,
    );
    expect(refinementDecisions(gated).map(describeDecision)).toEqual([
      'Factoree answered "Which version?" with "Add 0.1.0", because None is declared.',
    ]);
  });

  it("needs no visual evidence decision when a visible criterion has a browser route", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "The footer shows the version.", origin: "stated", quote: "Users lose messages.", method: "browser", target: "/", visible: true },
        ]),
      ),
      TICKET,
      WITH_PREVIEW,
    );
    expect(gated.visualEvidenceGap).toBeNull();
    expect(refinementDecisions(gated)).toEqual([]);
  });

  it("proceeds with no screenshot when a visible criterion has no browser check (proof-pack-and-visual-evidence.md)", () => {
    const visible = { statement: "The footer shows the version.", origin: "stated", quote: "Users lose messages.", method: "test", target: "t.test.ts", visible: true };
    const withPreview = gateRefinerProposal(parseRefinerProposal(proposal([visible])), TICKET, WITH_PREVIEW);
    expect(withPreview.visualEvidenceGap).toBe('No visual evidence for "The footer shows the version.": no browser check proves it.');

    const withoutPreview = gateRefinerProposal(parseRefinerProposal(proposal([visible])), TICKET, NO_PREVIEW);
    expect(withoutPreview.visualEvidenceGap).toBe(
      'No visual evidence for "The footer shows the version.": the repository has no preview.',
    );
    expect(refinementDecisions(withoutPreview).map((decision) => decision.statement)).toEqual(["proceeded with no screenshot"]);
  });
});

describe("by-eye criteria (docs/specs/by-eye-criteria-and-selector-recheck.md)", () => {
  const byEye = {
    statement: "The page follows the screenshot's colours.",
    origin: "stated",
    quote: "Users lose messages.",
    method: "manual",
    target: "/events",
    visible: true,
  };

  it("records a manual visible criterion with a route as for your eye: not frozen, not dropped, no gap", () => {
    const gated = gateRefinerProposal(parseRefinerProposal(proposal([byEye])), TICKET, NO_PREVIEW);
    expect(gated.forYourEye).toEqual([{ id: "AC-R1", statement: "The page follows the screenshot's colours.", route: "/events" }]);
    expect(gated.accepted).toEqual([]);
    expect(gated.unverifiable).toEqual([]);
    expect(gated.visualEvidenceGap).toBeNull();
    expect(refinementDecisions(gated)).toEqual([]);
  });

  it("drops a manual criterion that is not visible, or has no page route, and does not build an uncited one", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { ...byEye, statement: "Not visible.", visible: false },
          { ...byEye, statement: "No route.", target: null },
          { ...byEye, statement: "Foreign route.", target: "//evil.example/" },
          { ...byEye, statement: "Uncited.", quote: "The ticket never says this." },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.forYourEye).toEqual([]);
    expect(gated.unverifiable).toEqual(["Not visible.", "No route.", "Foreign route."]);
    expect(gated.notBuilt).toEqual(["Uncited."]);
  });
});
