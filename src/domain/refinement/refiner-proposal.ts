import { z } from "zod";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import { VALIDATION_METHODS, type ValidationMethod } from "~/domain/validation/validation-contract.js";

/**
 * docs/specs/refiner-agent.md. The refiner writes one proposal file. It is data, never code, and
 * the gate below decides what of it reaches the Validation Contract. P-01: the refiner proposes,
 * Factoree decides.
 */
const proposalSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            // The exact ticket sentence the criterion restates, or null when the refiner inferred it.
            quote: z.string().nullable(),
            method: z.enum(VALIDATION_METHODS),
            // What runs the check: a command, a test path, "METHOD /path", or a browser route.
            target: z.string().nullable(),
          })
          .strict(),
      )
      .max(20),
    questions: z
      .array(z.object({ question: z.string().min(1), proposal: z.string().min(1), reason: z.string().min(1) }).strict())
      .max(5),
    patterns: z.array(z.string().min(1)).max(20),
  })
  .strict();

export type RefinerProposal = z.infer<typeof proposalSchema>;

export class RefinerProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinerProposalError";
  }
}

export const parseRefinerProposal = (text: string): RefinerProposal => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RefinerProposalError("the refiner proposal is not JSON");
  }
  const parsed = proposalSchema.safeParse(json);
  if (!parsed.success) {
    throw new RefinerProposalError(`the refiner proposal does not match the schema: ${parsed.error.message}`);
  }
  return parsed.data;
};

/** The schema text the refiner prompt shows, so the prompt and the parser cannot drift. */
export const REFINER_PROPOSAL_SCHEMA = [
  "{",
  '  "criteria": [{ "statement": string, "quote": string | null, "method": "command" | "test" | "http" | "browser" | "code_review" | "manual", "target": string | null }],',
  '  "questions": [{ "question": string, "proposal": string, "reason": string }],',
  '  "patterns": [string]',
  "}",
].join("\n");

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

const HTTP_TARGET = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/;

/** A target that names something runnable for its method. Otherwise the method is not executable. */
const runnable = (method: ValidationMethod, target: string | null): boolean => {
  if (target === null || target.trim() === "") return false;
  const value = target.trim();
  if (method === "http") return HTTP_TARGET.test(value);
  if (method === "browser") return value.startsWith("/");
  return method === "command" || method === "test";
};

export interface GatedRefinement {
  /** Criteria the ticket states, with a runnable check or `manual`. They freeze without a question. */
  accepted: ValidationCriterion[];
  /** Criteria the refiner inferred. A human confirms them before they freeze. */
  inferred: ValidationCriterion[];
  /** The refiner's own questions, each with a proposed answer. */
  questions: RefinerProposal["questions"];
}

/**
 * docs/specs/refiner-agent.md. The deterministic gate. A criterion counts as stated only when
 * its quote appears in the ticket text. A method other than `manual` and `code_review` keeps
 * its method only with a runnable target; otherwise it becomes `manual`.
 */
export const gateRefinerProposal = (proposal: RefinerProposal, ticketText: string): GatedRefinement => {
  const ticket = normalize(ticketText);
  const accepted: ValidationCriterion[] = [];
  const inferred: ValidationCriterion[] = [];
  proposal.criteria.forEach((criterion, index) => {
    const executable =
      criterion.method === "manual" || criterion.method === "code_review" || runnable(criterion.method, criterion.target);
    const method: ValidationMethod = executable ? criterion.method : "manual";
    const target = executable && criterion.target !== null ? criterion.target.trim() : null;
    const quote = criterion.quote === null ? "" : normalize(criterion.quote);
    const stated = quote !== "" && ticket.includes(quote);
    const gated: ValidationCriterion = {
      id: `AC-R${String(index + 1)}`,
      statement: criterion.statement.trim(),
      source: stated ? "ticket:quote" : "refiner:inferred",
      method,
      ...(target === null ? {} : { target }),
    };
    (stated ? accepted : inferred).push(gated);
  });
  return { accepted, inferred, questions: proposal.questions };
};

/** One question in the grill format: the item, a proposal, and the reason. */
export const confirmationQuestion = (gated: GatedRefinement): string | null => {
  const lines: string[] = [];
  if (gated.inferred.length > 0) {
    lines.push(
      "Factoree inferred these acceptance criteria from the code. The ticket does not state them:",
      ...gated.inferred.map((criterion) => `- ${criterion.statement}`),
      "Proposal: accept them, because the existing code implies them. Reply \"yes\" to accept, or " +
        "reply with the correct criterion.",
    );
  }
  for (const question of gated.questions) {
    lines.push(`${question.question}`, `Proposal: ${question.proposal}, because ${question.reason}.`);
  }
  return lines.length === 0 ? null : lines.join("\n");
};

export { acceptsProposal } from "./accepts-proposal.js";
