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
            // docs/specs/proof-pack-and-visual-evidence.md. True when the ticket names a page, a
            // screen or a UI element. An older proposal without the field is not visible.
            visible: z.boolean().default(false),
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
  '  "criteria": [{ "statement": string, "quote": string | null, "method": "command" | "test" | "http" | "browser" | "code_review" | "manual", "target": string | null, "visible": boolean }],',
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
  /**
   * Criteria no automated check can prove: `manual`, `code_review`, or a target that does not
   * run. They never freeze, because the workflow ends a Run that holds one. The question proposes
   * to drop them, and the independent Reviewer still reads the code.
   */
  unverifiable: string[];
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. Why a visible criterion has no visual evidence,
   * or null when every visible criterion has a browser check. A human accepts the gap through
   * the confirmation question, and the Proof Pack lists it under "Needs your attention".
   */
  visualEvidenceGap: string | null;
}

/** What the gate knows about the repository. */
export interface GateRepository {
  /** True when `.factoree/config.yaml` holds an enabled `preview` block. */
  previewConfigured: boolean;
}

/**
 * docs/specs/refiner-agent.md. The deterministic gate. A criterion counts as stated only when
 * its quote appears in the ticket text. A criterion freezes only with a runnable target. One
 * without, or with the method `manual` or `code_review`, is unverifiable and does not freeze.
 */
export const gateRefinerProposal = (
  proposal: RefinerProposal,
  ticketText: string,
  repository: GateRepository,
): GatedRefinement => {
  const ticket = normalize(ticketText);
  const accepted: ValidationCriterion[] = [];
  const inferred: ValidationCriterion[] = [];
  const unproven: string[] = [];
  const unverifiable: string[] = [];
  proposal.criteria.forEach((criterion, index) => {
    if (!runnable(criterion.method, criterion.target)) {
      unverifiable.push(criterion.statement.trim());
      if (criterion.visible) unproven.push(criterion.statement.trim());
      return;
    }
    const method: ValidationMethod = criterion.method;
    const target = criterion.target === null ? null : criterion.target.trim();
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
    if (criterion.visible && method !== "browser") unproven.push(gated.statement);
  });
  return {
    accepted,
    inferred,
    questions: proposal.questions,
    unverifiable,
    visualEvidenceGap: visualEvidenceGapOf(unproven, repository),
  };
};

/**
 * docs/specs/proof-pack-and-visual-evidence.md. A visible criterion needs a browser assertion,
 * because a browser assertion captures a screenshot. A visible change must not pass on unit tests
 * alone unless a human accepts the gap.
 */
const visualEvidenceGapOf = (unproven: string[], repository: GateRepository): string | null => {
  if (unproven.length === 0) return null;
  const reason = repository.previewConfigured
    ? "no browser check proves it"
    : "the repository has no preview";
  return `No visual evidence for ${unproven.map((statement) => `"${statement}"`).join(", ")}: ${reason}.`;
};


/** An agent sentence without its closing period, so the joined sentence ends with exactly one. */
const bare = (text: string): string => text.trim().replace(/[.\s]+$/, "");

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
  if (gated.unverifiable.length > 0) {
    lines.push(
      "No automated check can prove these criteria, and a Run cannot finish with them:",
      ...gated.unverifiable.map((statement) => `- ${statement}`),
      "Proposal: drop them, because the independent Reviewer reads the code anyway. Reply " +
        "\"yes\" to drop them, or reply with a criterion Factoree can check.",
    );
  }
  for (const question of gated.questions) {
    lines.push(`${question.question}`, `Proposal: ${bare(question.proposal)}, because ${bare(question.reason)}.`);
  }
  if (gated.visualEvidenceGap !== null) {
    lines.push(
      `This change is visible, and Factoree cannot capture a screenshot of it. ${gated.visualEvidenceGap}`,
      "Proposal: proceed with no screenshot, because the other checks still prove the change. " +
        "The Proof Pack lists the gap under \"Needs your attention\".",
    );
  }
  return lines.length === 0 ? null : lines.join("\n");
};

export { acceptsProposal } from "./accepts-proposal.js";
