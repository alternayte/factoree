import { z } from "zod";
import type { ValidationContract, ValidationMethod } from "~/domain/validation/validation-contract.js";
import { isPreviewRelativePath } from "~/domain/validation/preview-url.js";

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
  | { action: "screenshot"; name: string }
  | { action: "holdRequest"; url: string }
  | { action: "releaseRequests" }
  | { action: "failRequest"; url: string; status: FailRequestStatus };

/**
 * docs/specs/browser-network-control.md. An HTTP error status, or `network` for a request that
 * fails as a network error. DI-20.01: a status below 400 is no failure, and a 2xx with an empty
 * body would be a made-up response.
 */
export type FailRequestStatus = number | "network";

/** docs/specs/browser-network-control.md. A held request releases itself after this time. */
export const HOLD_LIMIT_MS = 30_000;

/** The steps that check the page. A hold must be followed by one of them before its release. */
const CHECK_ACTIONS: ReadonlySet<BrowserStep["action"]> = new Set(["expectText", "expectVisible", "screenshot"]);

/**
 * docs/specs/browser-network-control.md. The reason a request URL pattern is refused, or null for
 * a URL glob. A glob begins with `*` or names an http or https URL. A character that only a
 * regular expression needs is refused, so a reviewer reads the pattern at a glance. DI-20.01.
 */
export const requestGlobProblem = (url: string): string | null => {
  if (!/^(\*|https?:\/\/)/.test(url)) {
    return "must be a URL glob that begins with *, http:// or https://, such as **/api/configs";
  }
  if (/[\^$\\()|[\]+\s]/.test(url)) {
    return "is a regular expression or holds a character a URL glob does not use. Use * and ** only";
  }
  return null;
};

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
  /**
   * Every reason Factoree rejected the plan for, in plan order. The message joins them. DI-15.23:
   * the correction prompt names each one, so one correction round can repair them all.
   */
  readonly reasons: string[];

  constructor(reasons: string | string[]) {
    const list = typeof reasons === "string" ? [reasons] : reasons;
    super(list.join(" "));
    this.name = "ValidationPlanInvalidError";
    this.reasons = list;
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
  z.object({ action: z.literal("holdRequest"), url: z.string().min(1) }).strict(),
  z.object({ action: z.literal("releaseRequests") }).strict(),
  z
    .object({
      action: z.literal("failRequest"),
      url: z.string().min(1),
      status: z.union([z.number().int().min(400).max(599), z.literal("network")]),
    })
    .strict(),
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
  // DI-15.23. Every entry is checked, and every reason is kept, so the validator learns all of
  // them at once. The rules are those of SDD section 25, unchanged.
  const reasons: string[] = [];

  for (const entry of plan.entries) {
    const assertion = assertionsById.get(entry.assertionId);
    if (assertion === undefined) {
      reasons.push(
        `The Validation Plan holds an entry for "${entry.assertionId}", which names no ` +
          "assertion of the frozen Validation Contract.",
      );
      continue;
    }

    if (seen.has(entry.assertionId)) {
      reasons.push(`The Validation Plan holds more than one entry for "${entry.assertionId}".`);
    }
    seen.add(entry.assertionId);

    const requiredKind = planKindForMethod(assertion.method);
    if (requiredKind === null) {
      reasons.push(
        `The Validation Plan holds an entry for "${entry.assertionId}", whose frozen method ` +
          `"${assertion.method}" cannot be automated. The plan cannot claim to automate a ` +
          "manual or a code_review assertion.",
      );
      continue;
    }
    if (entry.kind !== requiredKind) {
      reasons.push(
        `The Validation Plan entry for "${entry.assertionId}" is a "${entry.kind}" check, but ` +
          `the frozen method "${assertion.method}" requires a "${requiredKind}" check.`,
      );
    }

    if (entry.kind === "browser") {
      // docs/specs/browser-network-control.md. A holdRequest or a failRequest may come before the
      // first goto, because a request the page makes on load must be matched before it starts.
      const first = entry.steps.find((step) => step.action !== "holdRequest" && step.action !== "failRequest");
      if (entry.steps.length === 0) {
        reasons.push(`The Validation Plan browser entry for "${entry.assertionId}" holds no step.`);
      } else if (first?.action !== "goto") {
        reasons.push(
          `The Validation Plan browser entry for "${entry.assertionId}" must begin with a ` +
            "goto step. Only holdRequest and failRequest steps may come before it.",
        );
      }
      const hasExpectation = entry.steps.some((step) => step.action.startsWith("expect"));
      if (entry.steps.length > 0 && !hasExpectation) {
        reasons.push(
          `The Validation Plan browser entry for "${entry.assertionId}" asserts nothing. It ` +
            "must hold at least one step whose action begins with expect.",
        );
      }
      // docs/specs/browser-network-control.md. A request pattern is a URL glob, and a hold must be
      // checked before its release, because a hold that checks nothing proves nothing.
      entry.steps.forEach((step, index) => {
        if (step.action !== "holdRequest" && step.action !== "failRequest") return;
        const problem = requestGlobProblem(step.url);
        if (problem !== null) {
          reasons.push(
            `The Validation Plan browser entry for "${entry.assertionId}" holds the ${step.action} url ` +
              `"${step.url}", which ${problem}.`,
          );
        }
        if (step.action !== "holdRequest") return;
        let checked = false;
        for (const later of entry.steps.slice(index + 1)) {
          if (later.action === "releaseRequests") break;
          if (CHECK_ACTIONS.has(later.action)) {
            checked = true;
            break;
          }
        }
        if (!checked) {
          reasons.push(
            `The Validation Plan browser entry for "${entry.assertionId}" holds "${step.url}" at step ` +
              `${index + 1}, but no expectText, expectVisible or screenshot step follows before the ` +
              "release. A hold that checks nothing proves nothing.",
          );
        }
      });
      // A goto path resolves against the exposed preview base URL. A protocol-relative path
      // replaces the origin, so an assertion can drive a foreign host and still report PASS.
      for (const step of entry.steps) {
        if (step.action === "goto" && !isPreviewRelativePath(step.path)) {
          reasons.push(
            `The Validation Plan browser entry for "${entry.assertionId}" holds the goto path ` +
              `"${step.path}", which is not a relative preview path. A path must begin with a ` +
              "single slash, and the character after that slash must be neither a slash nor a " +
              "backslash.",
          );
        }
      }
    }

    if (entry.kind === "http" && !isPreviewRelativePath(entry.request.path)) {
      reasons.push(
        `The Validation Plan http entry for "${entry.assertionId}" holds the path ` +
          `"${entry.request.path}", which is not a relative preview path. A path must begin ` +
          "with a single slash, and the character after that slash must be neither a slash nor " +
          "a backslash.",
      );
    }
  }

  if (reasons.length > 0) throw new ValidationPlanInvalidError(reasons);

  return plan;
};
