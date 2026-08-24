import { describe, expect, it } from "vitest";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import {
  ForbiddenImplementerMaterialError,
} from "~/domain/runs/implementer-input.js";
import { buildUserValidatorInput } from "~/domain/validation/user-validator-input.js";
import { USER_VALIDATOR_PROMPT_VERSION } from "~/prompts/user-validator.js";

const base = {
  goal: "Add the health endpoint.",
  validationContract: "# Validation Contract\n\nVAL-API-001 returns 200.",
  primaryRepositoryPath: "/workspace/primary",
  planPath: "/workspace/validation/plan.json",
  previewBaseUrl: null as string | null,
  actionPolicy: buildActionPolicy({ role: "validator" }),
  projectTestSecrets: {},
};

describe("buildUserValidatorInput", () => {
  it("gives the validator the goal, the frozen contract, and the plan path", () => {
    const built = buildUserValidatorInput({ ...base });
    expect(built.prompt).toContain("Add the health endpoint.");
    expect(built.prompt).toContain("# Validation Contract");
    expect(built.prompt).toContain("/workspace/validation/plan.json");
    expect(built.promptVersion).toBe("user-validator@1");
    expect(built.promptVersion).toBe(USER_VALIDATOR_PROMPT_VERSION);
  });

  it("tells the validator it must not change a production source file", () => {
    expect(buildUserValidatorInput(base).prompt).toMatch(/must not (change|edit|write)[^.]*source file/i);
  });

  it("tells the validator it must not weaken the contract", () => {
    expect(buildUserValidatorInput(base).prompt).toContain("weaken");
  });

  it("states the exposed preview URL when one exists", () => {
    const built = buildUserValidatorInput({
      ...base,
      previewBaseUrl: "http://127.0.0.1:8080",
    });
    expect(built.prompt).toContain("http://127.0.0.1:8080");
  });

  it("states that no preview exists when the repository configures none", () => {
    const built = buildUserValidatorInput({ ...base, previewBaseUrl: null });
    expect(built.prompt).toContain("configures no preview");
  });

  it("rejects a forbidden credential in the test secrets", () => {
    expect(() => buildUserValidatorInput({ ...base, projectTestSecrets: { GITHUB_TOKEN: "x" } })).toThrow(
      ForbiddenImplementerMaterialError,
    );
  });

  it("places the Project test secrets in the environment and never in the prompt", () => {
    const built = buildUserValidatorInput({
      ...base,
      projectTestSecrets: { TEST_API_KEY: "value-from-the-project-secret-store" },
    });
    expect(built.environment.TEST_API_KEY).toBe("value-from-the-project-secret-store");
    expect(built.prompt).not.toContain("value-from-the-project-secret-store");
  });

  it("never states an Implementer claim or a Reviewer finding", () => {
    // The prompt names neither role as a source of information, only as absent context.
    const built = buildUserValidatorInput(base);
    expect(built.prompt).not.toContain("The change is applied.");
    expect(built.prompt).not.toContain("Reviewer finding:");
  });
});
