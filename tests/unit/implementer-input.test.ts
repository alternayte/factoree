import { describe, expect, it } from "vitest";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import {
  ForbiddenImplementerMaterialError,
  buildImplementerInput,
} from "~/domain/runs/implementer-input.js";
import { IMPLEMENTER_PROMPT_VERSION } from "~/prompts/implementer.js";

const base = {
  goal: "Add a health endpoint that returns 200.",
  humanDecisions: ["Use the existing Fastify server."],
  validationContract: null,
  contextContract: null,
  requiredContext: [],
  primaryRepositoryPath: "/workspace/primary",
  referenceRepositoryPaths: ["/workspace/reference/design"],
  repositoryInstructions: "Follow the house style in CONTRIBUTING.md.",
  skills: [],
  actionPolicy: buildActionPolicy(),
  repairFindings: [],
  projectTestSecrets: { TEST_API_KEY: "value-from-the-project-secret-store" },
};

describe("buildImplementerInput", () => {
  it("includes the goal, the human decisions, and the repository instructions", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("Add a health endpoint that returns 200.");
    expect(input.prompt).toContain("Use the existing Fastify server.");
    expect(input.prompt).toContain("Follow the house style in CONTRIBUTING.md.");
  });

  it("includes the primary repository path and the reference repository paths", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("/workspace/primary");
    expect(input.prompt).toContain("/workspace/reference/design");
  });

  it("states the Action Policy in the prompt as information, not as the boundary", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("deny: write a reference repository");
    expect(input.prompt).toContain("Factoree enforces these rules outside this prompt.");
  });

  it("stamps the prompt version, because SDD section 56 requires prompt versioning", () => {
    expect(buildImplementerInput(base).promptVersion).toBe(IMPLEMENTER_PROMPT_VERSION);
  });

  it("includes the repair findings when they are present", () => {
    const input = buildImplementerInput({ ...base, repairFindings: ["The lint check failed on src/a.ts."] });
    expect(input.prompt).toContain("The lint check failed on src/a.ts.");
  });

  it("places the Project test secrets in the environment and never in the prompt", () => {
    const input = buildImplementerInput(base);
    expect(input.environment.TEST_API_KEY).toBe("value-from-the-project-secret-store");
    expect(input.prompt).not.toContain("value-from-the-project-secret-store");
  });

  it("rejects a Linear token in the environment (SDD section 30, AT-26)", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { LINEAR_API_KEY: "lin_api_x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  it("rejects a GitHub write credential in the environment (SDD section 30, AT-26)", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { GITHUB_TOKEN: "ghp_x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  it("rejects the Factoree admin token and the encryption key in the environment", () => {
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { ADMIN_API_TOKEN: "x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
    expect(() =>
      buildImplementerInput({ ...base, projectTestSecrets: { FACTOREE_SECRET_KEY: "x" } }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });

  describe("forbidden-name policy over a table of names", () => {
    const cases: Array<[name: string, expected: "reject" | "accept"]> = [
      ["GITHUB_TOKEN", "reject"],
      ["githubToken", "reject"],
      ["GH-TOKEN", "reject"],
      ["LINEAR_API_KEY", "reject"],
      ["ADMIN_API_TOKEN", "reject"],
      ["ADMIN_TOKEN", "reject"],
      ["FACTOREE_ADMIN_KEY", "reject"],
      ["FACTOREE_SECRET_KEY", "reject"],
      ["STRIPE_TEST_KEY", "accept"],
      ["TEST_DATABASE_URL", "accept"],
      ["MY_GITHUB_MIRROR_URL", "accept"],
      ["LOG_IN_TOKEN", "accept"],
      ["PRODUCT_API_KEY", "accept"],
      ["PRODUCTION_DB", "reject"],
      ["REPRODUCTION_FIXTURE", "accept"],
      ["GHE_TOKEN", "reject"],
      ["GITHUB_OAUTH", "reject"],
      ["GITHUB_MIRROR_CREDENTIALS", "reject"],
      ["GITHUB", "reject"],
      ["GH", "reject"],
      ["GITHUB_PAT", "reject"],
      ["GH_PAT", "reject"],
      ["GITHUB_APP_PRIVATE_KEY", "reject"],
      ["GITHUB_INSTALLATION", "accept"],
    ];

    it.each(cases)("%s is %s", (name, expected) => {
      const attempt = () => buildImplementerInput({ ...base, projectTestSecrets: { [name]: "x" } });
      if (expected === "reject") {
        expect(attempt).toThrow(ForbiddenImplementerMaterialError);
      } else {
        expect(attempt).not.toThrow();
      }
    });
  });

  it("never includes a Reviewer conversation, because SDD section 34 forbids it", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).not.toContain("Reviewer");
  });

  it("tells the Implementer that it may not change the Validation Contract", () => {
    const input = buildImplementerInput(base);
    expect(input.prompt).toContain("You must not change the Validation Contract.");
  });
});
