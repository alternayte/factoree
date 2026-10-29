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
    );
    expect(gated.accepted).toEqual([]);
    expect(gated.inferred[0]?.source).toBe("refiner:inferred");
  });

  it("makes a method manual when its target is not runnable", () => {
    const gated = gateRefinerProposal(
      parseRefinerProposal(
        proposal([
          { statement: "The API answers.", quote: "Users lose messages.", method: "http", target: "the api" },
          { statement: "The page shows it.", quote: "Users lose messages.", method: "browser", target: null },
          { statement: "GET works.", quote: "Users lose messages.", method: "http", target: "GET /health" },
        ]),
      ),
      TICKET,
    );
    expect(gated.accepted.map((criterion) => criterion.method)).toEqual(["manual", "manual", "http"]);
    expect(gated.accepted[2]?.target).toBe("GET /health");
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
    );
    const question = confirmationQuestion(gated) ?? "";
    expect(question).toContain("- Retries stop after five attempts.");
    expect(question).toContain('Reply "yes" to accept');
    expect(question).toContain("Proposal: email, because the code sends email only.");
  });

  it("asks nothing when every criterion is stated and the refiner has no question", () => {
    const gated = gateRefinerProposal(parseRefinerProposal(proposal([])), TICKET);
    expect(confirmationQuestion(gated)).toBeNull();
  });

  it("reads a reply of yes as acceptance", () => {
    expect(acceptsProposal("Yes, go ahead")).toBe(true);
    expect(acceptsProposal("no, use sms")).toBe(false);
  });
});
