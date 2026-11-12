import { z } from "zod";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import { VALIDATION_METHODS, type ValidationMethod } from "~/domain/validation/validation-contract.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import type { MissingHost } from "~/domain/runs/egress.js";

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.47. One host the work needs and the sandbox
 * does not reach. The implementer result file holds the same shape.
 */
export const missingHostSchema = z.object({ host: z.string().min(1), reason: z.string() }).strict();

/** Issue #39, DI-21.66. The criteria cap of a Product that sets none. */
export const DEFAULT_REFINER_CRITERIA_LIMIT = 20;
/** Issue #39. The bounds of the Product setting `refinerCriteriaLimit`. */
export const REFINER_CRITERIA_LIMIT_MIN = 1;
export const REFINER_CRITERIA_LIMIT_MAX = 50;
/** The questions cap. No setting changes it. */
export const REFINER_QUESTIONS_LIMIT = 5;

/**
 * docs/specs/refiner-agent.md. The refiner writes one proposal file. It is data, never code, and
 * the gate below decides what of it reaches the Validation Contract. P-01: the refiner proposes,
 * Factoree decides. Issue #39, DI-21.66: the Product sets the criteria cap.
 */
const proposalSchemaOf = (criteriaLimit: number) =>
  z
    .object({
      criteria: z
        .array(
          z
            .object({
              statement: z.string().min(1),
              // docs/specs/own-proposals-and-parallel-runs.md. "stated": the ticket says it. "implied":
              // one ticket sentence directly implies it. "new": it adds behaviour no sentence implies.
              origin: z.enum(["stated", "implied", "new"]),
              // The exact ticket sentence the criterion restates or follows from, or null for a new one.
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
        .max(criteriaLimit),
      // A decision the refiner needs that the ticket leaves open, with the answer it proposes and why.
      // Factoree takes the proposal and records it. A human corrects it in the review.
      questions: z
        .array(z.object({ question: z.string().min(1), proposal: z.string().min(1), reason: z.string().min(1) }).strict())
        .max(REFINER_QUESTIONS_LIMIT),
      patterns: z.array(z.string().min(1)).max(20),
      // docs/specs/egress-honesty-and-issue-status.md. The hosts the work needs and the sandbox does
      // not reach. An older proposal without the field names none.
      missingHosts: z.array(missingHostSchema).max(20).default([]),
    })
    .strict();

export type RefinerProposal = z.infer<ReturnType<typeof proposalSchemaOf>>;

/** One capped list of a proposal over its cap: how many items it holds, and the cap. */
export interface ProposalCount {
  count: number;
  limit: number;
}

/**
 * Issue #39, DI-21.66. A proposal whose only schema faults are too many criteria, too many
 * questions, or both. Each field is null when that list is within its cap.
 */
export interface ProposalOverLimit {
  criteria: ProposalCount | null;
  questions: ProposalCount | null;
}

export class RefinerProposalError extends Error {
  /** Set when the only schema faults are the criteria or questions caps. */
  readonly overLimit: ProposalOverLimit | null;

  constructor(message: string, overLimit: ProposalOverLimit | null = null) {
    super(message);
    this.name = "RefinerProposalError";
    this.overLimit = overLimit;
  }
}

const CAPPED_LISTS = ["criteria", "questions"] as const;

/** The over-limit lists, or null when any schema fault is something other than a capped list. */
const overLimitOf = (json: unknown, issues: readonly z.core.$ZodIssue[]): ProposalOverLimit | null => {
  const over: ProposalOverLimit = { criteria: null, questions: null };
  for (const issue of issues) {
    const list = issue.path.length === 1 ? CAPPED_LISTS.find((name) => name === issue.path[0]) : undefined;
    if (issue.code !== "too_big" || issue.origin !== "array" || list === undefined) return null;
    const value = (json as Record<string, unknown>)[list];
    over[list] = { count: Array.isArray(value) ? value.length : 0, limit: Number(issue.maximum) };
  }
  return over.criteria === null && over.questions === null ? null : over;
};

export const parseRefinerProposal = (text: string, criteriaLimit = DEFAULT_REFINER_CRITERIA_LIMIT): RefinerProposal => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RefinerProposalError("the refiner proposal is not JSON");
  }
  const parsed = proposalSchemaOf(criteriaLimit).safeParse(json);
  if (!parsed.success) {
    throw new RefinerProposalError(
      `the refiner proposal does not match the schema: ${parsed.error.message}`,
      overLimitOf(json, parsed.error.issues),
    );
  }
  return parsed.data;
};

/** Issue #39. The over-limit lists of a proposal text, or null when it parses or fails otherwise. */
export const proposalOverLimitOf = (text: string, criteriaLimit: number): ProposalOverLimit | null => {
  try {
    parseRefinerProposal(text, criteriaLimit);
    return null;
  } catch (error) {
    return error instanceof RefinerProposalError ? error.overLimit : null;
  }
};

/**
 * Issue #39, DI-21.66. The failure message of a Run whose proposal stays over a cap after the one
 * correction round. The human acts on it, so it names the cap and the way out, not the schema.
 */
export const overLimitMessage = (over: ProposalOverLimit): string =>
  over.criteria !== null
    ? `The Work Item needs more than ${String(over.criteria.limit)} acceptance criteria, the limit of this product. ` +
      "Split it into smaller issues, or raise the refiner criteria limit on the product page. Factoree published nothing."
    : `The Work Item leaves more than ${String(over.questions?.limit ?? REFINER_QUESTIONS_LIMIT)} decisions open, the limit of the Refiner. ` +
      "Split it into smaller issues, or answer the open decisions in the issue. Factoree published nothing.";

/** The schema text the refiner prompt shows, so the prompt and the parser cannot drift. */
export const REFINER_PROPOSAL_SCHEMA = [
  "{",
  '  "criteria": [{ "statement": string, "origin": "stated" | "implied" | "new", "quote": string | null, "method": "command" | "test" | "http" | "browser" | "code_review" | "manual", "target": string | null, "visible": boolean }],',
  '  "questions": [{ "question": string, "proposal": string, "reason": string }],',
  '  "patterns": [string],',
  '  "missingHosts": [{ "host": string, "reason": string }]',
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
  /**
   * Criteria that freeze: each stated one whose quote the ticket holds, and each implied one whose
   * cited sentence the ticket holds. An implied criterion carries the source "implied by: <quote>".
   */
  accepted: ValidationCriterion[];
  /** The implied criteria among `accepted`. The proof pack lists each one for the reviewer. */
  implied: ValidationCriterion[];
  /**
   * Criteria that add behaviour no ticket sentence implies, or whose quote the ticket does not
   * hold. §7 forbids invented product behaviour, so they never freeze, and nobody is asked.
   */
  notBuilt: string[];
  /** The refiner's open decisions, each with the answer Factoree takes. */
  questions: RefinerProposal["questions"];
  /**
   * Criteria no automated check can prove: `manual`, `code_review`, or a target that does not
   * run. They never freeze, because the workflow ends a Run that holds one, and the independent
   * Reviewer still reads the code.
   */
  unverifiable: string[];
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. Why a visible criterion has no visual evidence,
   * or null when every visible criterion has a browser check. The Proof Pack lists it under
   * "Needs your attention".
   */
  visualEvidenceGap: string | null;
  /** DI-21.47. The hosts the refiner named. The activity drops the ones the allow list holds. */
  missingHosts: MissingHost[];
}

/** What the gate knows about the repository. */
export interface GateRepository {
  /** True when `.factoree/config.yaml` holds an enabled `preview` block. */
  previewConfigured: boolean;
}

/**
 * docs/specs/refiner-agent.md and docs/specs/own-proposals-and-parallel-runs.md. The deterministic
 * gate. A stated or implied criterion freezes only when its quote appears in the ticket text, and
 * only with a runnable target. A new criterion, or one whose quote the ticket does not hold, is
 * not built. One without a runnable target, or with the method `manual` or `code_review`, is
 * unverifiable and does not freeze.
 */
export const gateRefinerProposal = (
  proposal: RefinerProposal,
  ticketText: string,
  repository: GateRepository,
): GatedRefinement => {
  const ticket = normalize(ticketText);
  const accepted: ValidationCriterion[] = [];
  const implied: ValidationCriterion[] = [];
  const notBuilt: string[] = [];
  const unproven: string[] = [];
  const unverifiable: string[] = [];
  proposal.criteria.forEach((criterion, index) => {
    const statement = criterion.statement.trim();
    const quote = criterion.quote === null ? "" : criterion.quote.trim();
    const cited = quote !== "" && ticket.includes(normalize(quote));
    if (criterion.origin === "new" || !cited) {
      notBuilt.push(statement);
      return;
    }
    if (!runnable(criterion.method, criterion.target)) {
      unverifiable.push(statement);
      if (criterion.visible) unproven.push(statement);
      return;
    }
    const method: ValidationMethod = criterion.method;
    const target = criterion.target === null ? null : criterion.target.trim();
    const gated: ValidationCriterion = {
      id: `AC-R${String(index + 1)}`,
      statement,
      source: criterion.origin === "implied" ? `implied by: ${quote}` : "ticket:quote",
      method,
      ...(target === null ? {} : { target }),
    };
    accepted.push(gated);
    if (criterion.origin === "implied") implied.push(gated);
    if (criterion.visible && method !== "browser") unproven.push(gated.statement);
  });
  return {
    accepted,
    implied,
    notBuilt,
    questions: proposal.questions,
    unverifiable,
    visualEvidenceGap: visualEvidenceGapOf(unproven, repository),
    missingHosts: proposal.missingHosts,
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

/**
 * docs/specs/own-proposals-and-parallel-runs.md. Every proposal of the gate is determined, so
 * Factoree takes each one, and none reaches a human as a question. Each becomes one decision with
 * its reason, in the order a reviewer reads them.
 */
export const refinementDecisions = (gated: GatedRefinement): FactoreeDecision[] => [
  ...gated.implied.map((criterion): FactoreeDecision => ({
    kind: "criterion",
    statement: `added the implied criterion "${bare(criterion.statement)}"`,
    reason: `the ticket says "${bare(criterion.source.replace(/^implied by: /, ""))}"`,
  })),
  ...gated.notBuilt.map((statement): FactoreeDecision => ({
    kind: "not_built",
    statement: `did not build "${bare(statement)}"`,
    reason: "no ticket sentence states or implies it, and Factoree must not invent product behaviour",
  })),
  ...gated.unverifiable.map((statement): FactoreeDecision => ({
    kind: "dropped",
    statement: `dropped the criterion "${bare(statement)}"`,
    reason: "no automated check can prove it, and the independent Reviewer reads the code anyway",
  })),
  ...gated.questions.map((question): FactoreeDecision => ({
    kind: "refiner",
    statement: `answered "${bare(question.question)}" with "${bare(question.proposal)}"`,
    reason: bare(question.reason),
  })),
  ...(gated.visualEvidenceGap === null
    ? []
    : [
        {
          kind: "visual_evidence",
          statement: "proceeded with no screenshot",
          reason: `${bare(gated.visualEvidenceGap)}, and the other checks still prove the change`,
        } satisfies FactoreeDecision,
      ]),
];

