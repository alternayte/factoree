import { z } from "zod";
import type { ValidationContract, ValidationMethod } from "~/domain/validation/validation-contract.js";

export type PlanEntryKind = "http" | "browser" | "command";

export interface HttpPlanRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  /** Begins with `/`. It is joined to the exposed preview base URL. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
  expectStatus: number;
  expectBodyContains: string | null;
}

export type BrowserStep =
  | { action: "goto"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "reload" }
  | { action: "expectText"; selector: string; text: string }
  | { action: "expectVisible"; selector: string }
  | { action: "screenshot"; name: string };

export interface CommandPlanEntry {
  run: string;
  expectExitCode: number;
}

export type ValidationPlanEntry =
  | { assertionId: string; kind: "http"; request: HttpPlanRequest }
  | { assertionId: string; kind: "browser"; steps: BrowserStep[] }
  | { assertionId: string; kind: "command"; command: CommandPlanEntry };

export interface ValidationPlan {
  version: 1;
  entries: ValidationPlanEntry[];
}

export class ValidationPlanInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationPlanInvalidError";
  }
}

/** The plan entry kind one frozen method needs, or null when the method needs none. */
export const planKindForMethod = (method: ValidationMethod): PlanEntryKind | null => {
  switch (method) {
    case "http":
      return "http";
    case "browser":
      return "browser";
    case "command":
    case "test":
      return "command";
    case "code_review":
    case "manual":
      return null;
  }
};

const httpRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()),
    body: z.string().nullable(),
    expectStatus: z.number().int(),
    expectBodyContains: z.string().nullable(),
  })
  .strict();

const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string().min(1) }).strict(),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }).strict(),
  z
    .object({ action: z.literal("fill"), selector: z.string().min(1), value: z.string() })
    .strict(),
  z.object({ action: z.literal("reload") }).strict(),
  z
    .object({ action: z.literal("expectText"), selector: z.string().min(1), text: z.string() })
    .strict(),
  z.object({ action: z.literal("expectVisible"), selector: z.string().min(1) }).strict(),
  z.object({ action: z.literal("screenshot"), name: z.string().min(1) }).strict(),
]);

const commandPlanEntrySchema = z
  .object({ run: z.string().min(1), expectExitCode: z.number().int() })
  .strict();

const planEntrySchema = z.discriminatedUnion("kind", [
  z.object({ assertionId: z.string().min(1), kind: z.literal("http"), request: httpRequestSchema }).strict(),
  z
    .object({
      assertionId: z.string().min(1),
      kind: z.literal("browser"),
      steps: z.array(browserStepSchema),
    })
    .strict(),
  z
    .object({
      assertionId: z.string().min(1),
      kind: z.literal("command"),
      command: commandPlanEntrySchema,
    })
    .strict(),
]);

const planSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(planEntrySchema),
  })
  .strict();

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "the document" : issue.path.join(".");
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

const fail = (message: string): never => {
  throw new ValidationPlanInvalidError(message);
};

/**
 * Parses the plan text the fresh validator session wrote and checks it against the frozen
 * contract. SDD section 25: the plan may add steps and may never change the contract.
 */
export const parseValidationPlan = (text: string, contract: ValidationContract): ValidationPlan => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`The Validation Plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = planSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    return fail(`The Validation Plan does not match the plan schema: ${detail}`);
  }

  const plan = parsed.data;
  const assertionsById = new Map(contract.assertions.map((assertion) => [assertion.id, assertion]));
  const seen = new Set<string>();

  for (const entry of plan.entries) {
    const assertion = assertionsById.get(entry.assertionId);
    if (assertion === undefined) {
      return fail(
        `The Validation Plan holds an entry for "${entry.assertionId}", which names no ` +
          "assertion of the frozen Validation Contract.",
      );
    }

    if (seen.has(entry.assertionId)) {
      fail(`The Validation Plan holds more than one entry for "${entry.assertionId}".`);
    }
    seen.add(entry.assertionId);

    const requiredKind = planKindForMethod(assertion.method);
    if (requiredKind === null) {
      return fail(
        `The Validation Plan holds an entry for "${entry.assertionId}", whose frozen method ` +
          `"${assertion.method}" cannot be automated. The plan cannot claim to automate a ` +
          "manual or a code_review assertion.",
      );
    }
    if (entry.kind !== requiredKind) {
      fail(
        `The Validation Plan entry for "${entry.assertionId}" is a "${entry.kind}" check, but ` +
          `the frozen method "${assertion.method}" requires a "${requiredKind}" check.`,
      );
    }

    if (entry.kind === "browser") {
      if (entry.steps.length === 0) {
        fail(`The Validation Plan browser entry for "${entry.assertionId}" holds no step.`);
      }
      const first = entry.steps[0];
      if (first === undefined || first.action !== "goto") {
        fail(
          `The Validation Plan browser entry for "${entry.assertionId}" must begin with a ` +
            "goto step.",
        );
      }
      const hasExpectation = entry.steps.some((step) => step.action.startsWith("expect"));
      if (!hasExpectation) {
        fail(
          `The Validation Plan browser entry for "${entry.assertionId}" asserts nothing. It ` +
            "must hold at least one step whose action begins with expect.",
        );
      }
    }

    if (entry.kind === "http" && !entry.request.path.startsWith("/")) {
      fail(
        `The Validation Plan http entry for "${entry.assertionId}" holds the path ` +
          `"${entry.request.path}", which does not begin with a slash.`,
      );
    }
  }

  return plan;
};
