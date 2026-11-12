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

/** The selector a browser step acts on, or null for a step with none. */
export const stepSelectorOf = (step: BrowserStep): string | null =>
  step.action === "click" || step.action === "fill" || step.action === "expectText" || step.action === "expectVisible"
    ? step.selector
    : null;

/** Skips a quoted string that starts at `start`, and returns the index after its closing quote. */
const skipQuoted = (text: string, start: number): number => {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
  return index + 1;
};

/** Splits a Playwright selector chain on `>>`, outside quotes and brackets. */
const chainParts = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < selector.length) {
    const char = selector[index]!;
    if (char === '"' || char === "'") {
      index = skipQuoted(selector, index);
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && selector.startsWith(">>", index)) {
      parts.push(selector.slice(start, index));
      index += 2;
      start = index;
      continue;
    }
    index += 1;
  }
  parts.push(selector.slice(start));
  return parts;
};

const CLASS_NAME_START = /[A-Za-z_\-\\\u00a0-\uffff]/;

/** True when a CSS selector holds a class selector (`.name`) or a `class` attribute selector. */
const cssHoldsClass = (css: string): boolean => {
  let index = 0;
  while (index < css.length) {
    const char = css[index]!;
    if (char === '"' || char === "'") {
      index = skipQuoted(css, index);
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      const name = /^\s*(?:[\w-]*\|)?([\w-]+)/.exec(css.slice(index + 1));
      if (name?.[1]?.toLowerCase() === "class") return true;
      // The value of an attribute selector is no selector, so a dot in it is no class.
      index += 1;
      while (index < css.length && css[index] !== "]") {
        index = css[index] === '"' || css[index] === "'" ? skipQuoted(css, index) : index + 1;
      }
      index += 1;
      continue;
    }
    if (char === "." && CLASS_NAME_START.test(css[index + 1] ?? "")) return true;
    index += 1;
  }
  return false;
};

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. True when a Playwright selector selects by a
 * styling class: a CSS class selector (`.name`), a `class` attribute selector, or an XPath
 * `@class`. A text, role, label or test id engine part holds no CSS, so its text is never read as
 * a class.
 */
export const selectsByClass = (selector: string): boolean =>
  chainParts(selector).some((raw) => {
    const part = raw.trim();
    const engine = /^([A-Za-z][\w-]*(?::[\w-]+)?)\s*=/.exec(part);
    if (engine !== null) {
      const name = engine[1]!.toLowerCase();
      const body = part.slice(engine[0].length);
      if (name === "css") return cssHoldsClass(body);
      if (name === "xpath") return /@class\b/.test(body);
      return false;
    }
    if (part.startsWith("//") || part.startsWith("..")) return /@class\b/.test(part);
    if (part.startsWith('"') || part.startsWith("'")) return false;
    return cssHoldsClass(part);
  });

/** The reason the plan rules give for a step that selects by a styling class. */
export const classSelectorReason = (assertionId: string, stepNumber: number, selector: string): string =>
  `The Validation Plan browser entry for "${assertionId}" selects \`${selector}\` at step ${String(stepNumber)} by a ` +
  "styling class. Select by role, label, text or data-testid instead, such as " +
  '`role=button[name="Save"]`, `[aria-label="Email"]`, `text=Order saved` or `[data-testid="timeline"]`: ' +
  "markup classes change on every repair.";

export interface CommandPlanEntry {
  run: string;
  expectExitCode: number;
}

export type ValidationPlanEntry =
  | { assertionId: string; kind: "http"; request: HttpPlanRequest }
  | {
      assertionId: string;
      kind: "browser";
      steps: BrowserStep[];
      /** docs/specs/repository-setup-and-services.md. The account the entry starts signed in as. */
      as?: string | undefined;
    }
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

/**
 * docs/specs/repository-setup-and-services.md. The steps an account signs in with: the page steps
 * of a plan, without network control and without a screenshot.
 */
export const signInStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string().min(1) }).strict(),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }).strict(),
  z.object({ action: z.literal("fill"), selector: z.string().min(1), value: z.string() }).strict(),
  z.object({ action: z.literal("reload") }).strict(),
  z.object({ action: z.literal("expectText"), selector: z.string().min(1), text: z.string() }).strict(),
  z.object({ action: z.literal("expectVisible"), selector: z.string().min(1) }).strict(),
]);

/** The step that proves an account is signed in. */
export const signedInCheckSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("expectText"), selector: z.string().min(1), text: z.string() }).strict(),
  z.object({ action: z.literal("expectVisible"), selector: z.string().min(1) }).strict(),
]);

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
      as: z.string().min(1).optional(),
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
export const parseValidationPlan = (
  text: string,
  contract: ValidationContract,
  /** docs/specs/repository-setup-and-services.md. The account names the config defines. */
  accounts: readonly string[] = [],
): ValidationPlan => {
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

    if (entry.kind === "browser" && entry.as !== undefined && !accounts.includes(entry.as)) {
      reasons.push(
        `The Validation Plan browser entry for "${entry.assertionId}" signs in as "${entry.as}", which ` +
          (accounts.length === 0
            ? "is not an account. The repository defines no account, so leave out as."
            : `is not an account. The accounts are: ${accounts.join(", ")}.`),
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
      // docs/specs/by-eye-criteria-and-selector-recheck.md. A styling class changes on every
      // repair, so a check that selects by one fails on markup, not on behaviour.
      entry.steps.forEach((step, index) => {
        const selector = stepSelectorOf(step);
        if (selector !== null && selectsByClass(selector)) {
          reasons.push(classSelectorReason(entry.assertionId, index + 1, selector));
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

/** A browser entry of a parsed plan. */
export type BrowserPlanEntry = Extract<ValidationPlanEntry, { kind: "browser" }>;

/** The entry with every selector blanked, so two entries compare on everything else. */
const withoutSelectors = (entry: BrowserPlanEntry): string =>
  JSON.stringify({
    ...entry,
    steps: entry.steps.map((step) => (stepSelectorOf(step) === null ? step : { ...step, selector: "" })),
  });

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. Checks the corrected entry of a selector
 * re-check against the entry that failed. It may change only `selector` fields, and it must change
 * at least one: a re-check must not weaken what the check asserts. A new selector follows the plan
 * rule on styling classes.
 */
export const checkSelectorCorrection = (
  original: BrowserPlanEntry,
  candidate: unknown,
): { entry: BrowserPlanEntry } | { problem: string } => {
  const parsed = planEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    return { problem: `the corrected entry does not match the plan schema: ${parsed.error.issues.map(describeIssue).join("; ")}` };
  }
  const entry = parsed.data;
  if (entry.kind !== "browser") return { problem: `the corrected entry is a "${entry.kind}" check, not a "browser" check` };
  // The original passed the same schema, so both serialise their keys in one order.
  const baseline = planEntrySchema.parse(original) as BrowserPlanEntry;
  if (withoutSelectors(entry) !== withoutSelectors(baseline)) {
    return { problem: "the corrected entry changes more than its selector fields" };
  }
  if (JSON.stringify(entry) === JSON.stringify(baseline)) {
    return { problem: "the corrected entry changes no selector" };
  }
  const classStep = entry.steps.findIndex((step) => {
    const selector = stepSelectorOf(step);
    return selector !== null && selectsByClass(selector);
  });
  if (classStep !== -1) {
    return { problem: classSelectorReason(entry.assertionId, classStep + 1, stepSelectorOf(entry.steps[classStep]!)!) };
  }
  return { entry };
};
