import type { ActionPolicy } from "~/domain/policy/action-policy.js";
import type { EgressFacts } from "~/domain/runs/egress.js";
import { guardAgainstForbiddenMaterial } from "~/domain/runs/implementer-input.js";
import {
  USER_VALIDATOR_PLAN_CORRECTION_VERSION,
  USER_VALIDATOR_PROMPT_VERSION,
  renderPlanCorrectionPrompt,
  renderUserValidatorPrompt,
} from "~/prompts/user-validator.js";
import type { ValidationAssertion } from "~/domain/validation/validation-contract.js";
import { planKindForMethod } from "~/domain/validation/validation-plan.js";

export interface BuildUserValidatorInput {
  goal: string;
  validationContract: string;
  primaryRepositoryPath: string;
  planPath: string;
  previewBaseUrl: string | null;
  actionPolicy: ActionPolicy;
  /** Non-production Project test secrets only. See SDD section 30. */
  projectTestSecrets: Record<string, string>;
  /** docs/specs/repository-setup-and-services.md. The account names of the config. */
  accounts?: string[];
  /** docs/specs/repository-setup-and-services.md. The fakes of the running stack. */
  fakes?: ReadonlyArray<{ service: string; name: string }>;
  /** docs/specs/work-item-images-and-links.md. One line per image file of the check sprite. */
  imageFiles?: string[];
  /** docs/specs/egress-honesty-and-issue-status.md. The allow list facts of the check sprite. */
  egress?: EgressFacts | null;
}

export interface UserValidatorInput {
  prompt: string;
  promptVersion: string;
  environment: Record<string, string>;
}

/**
 * Describes the JSON shape `renderUserValidatorPrompt` asks the validator to write. It names every
 * field, because a step kind alone leaves the model to guess them. The FAC-40 live run wrote
 * `{ "type": "goto", "url": "/" }`, and the parser refused every step. The example parses with
 * `parseValidationPlan`, and a unit test holds that.
 */
const PLAN_SCHEMA = [
  'The document is one JSON object: { "version": 1, "entries": [...] }.',
  "Each entry names the assertionId of one Validation Contract assertion, and one kind.",
  'An "http" entry: { "assertionId": string, "kind": "http", "request": { "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD", "path": string, "headers": { string: string }, "body": string | null, "expectStatus": number, "expectBodyContains": string | null } }.',
  'A "browser" entry: { "assertionId": string, "kind": "browser", "steps": [...] }. The first step is a goto. Only holdRequest and failRequest steps may come before it, so they match the requests the page makes on load. An optional "as": string names the account the entry starts signed in as. Each step is exactly one of:',
  '- { "action": "goto", "path": "/" } with a path relative to the preview',
  '- { "action": "click", "selector": string }',
  '- { "action": "fill", "selector": string, "value": string }',
  '- { "action": "reload" }',
  '- { "action": "expectText", "selector": string, "text": string } passes when the element contains the text',
  '- { "action": "expectVisible", "selector": string }',
  '- { "action": "screenshot", "name": string }',
  '- { "action": "holdRequest", "url": "**/api/configs" } holds each request of the page whose URL matches the glob until a releaseRequests step, or for at most 30 seconds. A glob may name any host, such as "https://api.example.com/v1/**" or "**/graphql". It matches the URL only, never the body. An expectText, expectVisible or screenshot step must follow before the release',
  '- { "action": "releaseRequests" } lets every held request go on to the backend',
  '- { "action": "failRequest", "url": "**/api/configs", "status": 500 } answers each matching request with that status (400 to 599) and an empty body, or with a network error when "status" is "network"',
  'To check a loading state, use holdRequest. To check an error state, use failRequest. A url is a glob with * and **, never a regular expression. No step can invent a response body.',
  'A "command" entry: { "assertionId": string, "kind": "command", "command": { "run": string, "expectExitCode": number } }. Use it for a test or a command assertion.',
  "Cover every automated assertion of the Validation Contract with exactly one entry. Write no other key.",
  "",
  `Example: ${JSON.stringify({
    version: 1,
    entries: [
      {
        assertionId: "VAL-UI-001",
        kind: "browser",
        steps: [
          { action: "goto", path: "/" },
          { action: "expectText", selector: "footer", text: "v0.1.0" },
          { action: "screenshot", name: "footer" },
        ],
      },
      { assertionId: "VAL-TEST-001", kind: "command", command: { run: "npm test", expectExitCode: 0 } },
    ],
  })}`,
].join("\n");

/**
 * SDD section 34 mirrors this builder for the User Validator. It assembles the fresh-context
 * prompt and rejects forbidden material through the one shared guard.
 */
export const buildUserValidatorInput = (input: BuildUserValidatorInput): UserValidatorInput => {
  guardAgainstForbiddenMaterial(input.projectTestSecrets);

  return {
    prompt: renderUserValidatorPrompt({
      goal: input.goal,
      validationContract: input.validationContract,
      primaryRepositoryPath: input.primaryRepositoryPath,
      planPath: input.planPath,
      previewBaseUrl: input.previewBaseUrl,
      actionPolicy: input.actionPolicy.describe(),
      planSchema: PLAN_SCHEMA,
      accounts: input.accounts ?? [],
      fakes: (input.fakes ?? []).map((fake) => `${fake.name}, answered by the compose service "${fake.service}"`),
      imageFiles: input.imageFiles ?? [],
      egress: input.egress ?? null,
    }),
    promptVersion: USER_VALIDATOR_PROMPT_VERSION,
    environment: { ...input.projectTestSecrets },
  };
};

export interface BuildPlanCorrectionInput {
  /** Every reason Factoree rejected the first plan for, already redacted. */
  reasons: string[];
  /** The assertions of the frozen contract. The validator already holds them. */
  assertions: ReadonlyArray<Pick<ValidationAssertion, "id" | "method">>;
  planPath: string;
}

export interface PlanCorrection {
  prompt: string;
  promptVersion: string;
}

/**
 * DI-15.23. The correction message of the one correction round. A resumed session receives it
 * alone. A fresh session receives it after the normal prompt, so its prompt version names both.
 */
export const buildPlanCorrection = (input: BuildPlanCorrectionInput): PlanCorrection => ({
  prompt: renderPlanCorrectionPrompt({
    reasons: input.reasons,
    assertions: input.assertions.map((assertion) => {
      const kind = planKindForMethod(assertion.method);
      return kind === null
        ? `${assertion.id}: frozen method "${assertion.method}". No automated check can answer it, so the plan holds no entry for it.`
        : `${assertion.id}: frozen method "${assertion.method}". Its entry must be a "${kind}" check.`;
    }),
    planPath: input.planPath,
  }),
  promptVersion: USER_VALIDATOR_PLAN_CORRECTION_VERSION,
});
