import { describe, expect, it } from "vitest";
import {
  acceptsProposal,
  confirmationQuestion,
  gateRefinerProposal,
  parseRefinerProposal,
  RefinerProposalError,
} from "~/domain/refinement/refiner-proposal.js";

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
});

const NO_PREVIEW = { previewConfigured: false };
const WITH_PREVIEW = { previewConfigured: true };

describe("gateRefinerProposal (docs/specs/refiner-agent.md)", () => {
  it("accepts a criterion that quotes the ticket, with its runnable check", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          {
            statement: "A failed delivery is retried until it succeeds.",
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
    expect(gated.inferred).toEqual([]);
  });

  it("marks a criterion with a quote the ticket does not hold as inferred", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([{ statement: "Retries stop after five attempts.", quote: "five attempts", method: "test", target: "t.test.ts" }]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted).toEqual([]);
    expect(gated.inferred[0]?.source).toBe("refiner:inferred");
  });

  it("keeps a criterion with no automated check out of the contract, and proposes to drop it (FAC-42 live run)", () => {
    // FAC-42 froze a code_review criterion, and the workflow ends every Run that holds one.
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "The API answers.", quote: "Users lose messages.", method: "http", target: "the api" },
          { statement: "The page shows it.", quote: "Users lose messages.", method: "browser", target: null },
          { statement: "The code reads the version.", quote: null, method: "code_review", target: "src/a.ts" },
          { statement: "GET works.", quote: "Users lose messages.", method: "http", target: "GET /health" },
        ]),
      ),
      TICKET,
      NO_PREVIEW,
    );
    expect(gated.accepted.map((criterion) => criterion.statement)).toEqual(["GET works."]);
    expect(gated.inferred).toEqual([]);
    expect(gated.unverifiable).toEqual(["The API answers.", "The page shows it.", "The code reads the version."]);
    const question = confirmationQuestion(gated) ?? "";
    expect(question).toContain("- The code reads the version.");
    expect(question).toContain("Proposal: drop them");
  });

  it("asks one question in the grill format for inferred criteria and refiner questions", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal(
          [{ statement: "Retries stop after five attempts.", quote: null, method: "test", target: "t.test.ts" }],
          [{ question: "Which channel?", proposal: "email", reason: "the code sends email only" }],
        ),
      ),
      TICKET,
      NO_PREVIEW,
    );
    const question = confirmationQuestion(gated) ?? "";
    expect(question).toContain("- Retries stop after five attempts.");
    expect(question).toContain('Reply "yes" to accept');
    expect(question).toContain("Proposal: email, because the code sends email only.");
  });

  it("ends a proposal sentence with one period when the refiner wrote its own", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(proposal([], [{ question: "Which version?", proposal: "Add 0.1.0.", reason: "None is declared." }])),
      TICKET,
      NO_PREVIEW,
    );
    expect(confirmationQuestion(gated)).toContain("Proposal: Add 0.1.0, because None is declared.");
  });

  it("asks nothing when every criterion is stated and the refiner has no question", () => {
    const gated = gateRefinerProposal(parseRefinerProposal(proposal([])), TICKET, NO_PREVIEW);
    expect(confirmationQuestion(gated)).toBeNull();
  });

  it("needs no visual evidence answer when a visible criterion has a browser route", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "The footer shows the version.", quote: "Users lose messages.", method: "browser", target: "/", visible: true },
        ]),
      ),
      TICKET,
      WITH_PREVIEW,
    );
    expect(gated.visualEvidenceGap).toBeNull();
    expect(confirmationQuestion(gated)).toBeNull();
  });

  it("asks to proceed with no screenshot when a visible criterion has no browser check (proof-pack-and-visual-evidence.md)", () => {
    const visible = { statement: "The footer shows the version.", quote: "Users lose messages.", method: "test", target: "t.test.ts", visible: true };
    const withPreview = gateRefinerProposal(parseRefinerProposal(proposal([visible])), TICKET, WITH_PREVIEW);
    expect(withPreview.visualEvidenceGap).toBe('No visual evidence for "The footer shows the version.": no browser check proves it.');

    const withoutPreview = gateRefinerProposal(parseRefinerProposal(proposal([visible])), TICKET, NO_PREVIEW);
    expect(withoutPreview.visualEvidenceGap).toBe(
      'No visual evidence for "The footer shows the version.": the repository has no preview.',
    );
    expect(confirmationQuestion(withoutPreview)).toContain("Proposal: proceed with no screenshot");
  });

  it("reads a reply of yes as acceptance", () => {
    expect(acceptsProposal("Yes, go ahead")).toBe(true);
    expect(acceptsProposal("no, use sms")).toBe(false);
  });
});
