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
    // Sorted case-insensitively by name, so the policy reads as one table, not an accretion of
    // fix rounds. Every name from every fix round appears here exactly once.
    const cases: Array<[name: string, expected: "reject" | "accept"]> = [
      ["ADMIN_API_TOKEN", "reject"],
      ["ADMIN_TOKEN", "reject"],
      ["FACTOREE_ADMIN_KEY", "reject"],
      ["FACTOREE_SECRET_KEY", "reject"],
      ["GH", "reject"],
      ["GH_PAT", "reject"],
      ["GH-TOKEN", "reject"],
      ["GHE_TOKEN", "reject"],
      ["GHERKIN_FIXTURE_KEY", "accept"],
      ["GHES_TOKEN", "reject"],
      ["GHOST_CONFIG", "accept"],
      ["GHOSTWRITER_API_KEY", "accept"],
      ["GITHUB", "reject"],
      ["GITHUB_APP_PRIVATE_KEY", "reject"],
      ["GITHUB_AUTHOR", "accept"],
      ["GITHUB_AUTHOR_NAME", "accept"],
      ["GITHUB_COMPATIBILITY_MODE", "accept"],
      ["GITHUB_INSTALLATION", "accept"],
      ["GITHUB_MIRROR_CREDENTIALS", "reject"],
      ["GITHUB_OAUTH", "reject"],
      ["GITHUB_PAT", "reject"],
      ["GITHUB_TOKEN", "reject"],
      ["GITHUBAPP_KEY", "reject"],
      ["GITHUBENTERPRISE_TOKEN", "reject"],
      ["GITHUBTOKEN", "reject"],
      ["githubToken", "reject"],
      ["LINEAR_API_KEY", "reject"],
      ["LOG_IN_TOKEN", "accept"],
      ["MY_GITHUB_MIRROR_URL", "accept"],
      ["PRODUCT_API_KEY", "accept"],
      ["PRODUCTION_DB", "reject"],
      ["REPRODUCTION_FIXTURE", "accept"],
      ["STRIPE_TEST_KEY", "accept"],
      ["TEST_DATABASE_URL", "accept"],
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

  describe("value-shape policy, the primary control", () => {
    // A value in a known provider credential format is a credential whatever the key is called.
    // No value below is a live credential. Each one is a synthetic string in the shape only.
    const bodyOf = (length: number): string => "a1b2c3d4e5".repeat(10).slice(0, length);

    const cases: Array<[label: string, value: string, expected: "reject" | "accept"]> = [
      ["a GitHub classic token shape", `ghp_${bodyOf(36)}`, "reject"],
      ["a GitHub fine-grained token shape", `github_pat_${bodyOf(40)}`, "reject"],
      ["a Linear API key shape", `lin_api_${bodyOf(40)}`, "reject"],
      ["an ordinary sentence that contains the word token", "This value is not a token at all.", "accept"],
      ["a UUID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "accept"],
      ["a short password", "hunter2", "accept"],
      ["a URL", "https://example.test/api/v1/resource?page=2", "accept"],
    ];

    it.each(cases)("%s is %s", (_label, value, expected) => {
      const attempt = () =>
        buildImplementerInput({ ...base, projectTestSecrets: { HARMLESS_SETTING: value } });
      if (expected === "reject") {
        expect(attempt).toThrow(ForbiddenImplementerMaterialError);
      } else {
        expect(attempt).not.toThrow();
      }
    });

    it("names the offending key and never the value", () => {
      const value = `ghp_${bodyOf(36)}`;
      try {
        buildImplementerInput({ ...base, projectTestSecrets: { NOTES: value } });
        expect.unreachable("The build must reject a credential-shaped value.");
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenImplementerMaterialError);
        expect((error as Error).message).toContain("NOTES");
        expect((error as Error).message).not.toContain(value);
      }
    });

    it("rejects a credential-shaped value under a key named WORKSPACE", () => {
      expect(() =>
        buildImplementerInput({
          ...base,
          projectTestSecrets: { WORKSPACE: `lin_api_${bodyOf(40)}` },
        }),
      ).toThrow(ForbiddenImplementerMaterialError);
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

  it("carries the frozen Validation Contract into the prompt", () => {
    const input = buildImplementerInput({
      ...base,
      validationContract: "# Validation Contract\n\nVAL-API-001 returns 403.",
    });
    expect(input.prompt).toContain("VAL-API-001");
  });

  it("states that the Implementer must not change the Validation Contract", () => {
    const input = buildImplementerInput({ ...base, validationContract: "VAL-API-001" });
    expect(input.prompt).toContain("must not change the Validation Contract");
  });
});
