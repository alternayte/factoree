import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLEMENTER_PROMPT_VERSION, renderImplementerPrompt } from "~/prompts/implementer.js";
import type { ImplementerPromptFields } from "~/prompts/implementer.js";

const SAMPLE: ImplementerPromptFields = {
  goal: "Add a health endpoint that returns 200.",
  humanDecisions: ["Use the existing Fastify server."],
  validationContract: "The response body must equal { status: \"ok\" }.",
  contextContract: "Read src/server.ts before you write a route.",
  requiredContext: ["The Fastify plugin registration order."],
  primaryRepositoryPath: "/workspace/primary",
  referenceRepositoryPaths: ["/workspace/reference/design"],
  repositoryInstructions: "Follow the house style in CONTRIBUTING.md.",
  skills: ["fastify-routes"],
  actionPolicyLines: ["allow: read the primary repository", "deny: write a reference repository"],
  repairFindings: ["The lint check failed on src/a.ts."],
};

/**
 * SDD section 56 requires that a prompt version means something. This hash pins the rendered
 * output of the template for the fixed sample above. A change to the template changes the
 * rendered text, which changes this hash, which fails this test. The failure message tells a
 * developer to bump IMPLEMENTER_PROMPT_VERSION and to record the new hash here.
 */
const EXPECTED_TEMPLATE_HASH = "d3249ca95ab8a18468a56f333ee751ebc2f7552ccf5eb7eefdc4e3b190d80c82";

describe("renderImplementerPrompt version guard", () => {
  it("keeps IMPLEMENTER_PROMPT_VERSION synchronized with the template text", () => {
    const rendered = renderImplementerPrompt(SAMPLE);
    const hash = createHash("sha256").update(rendered).digest("hex");

    expect(
      hash,
      "The Implementer prompt template changed but IMPLEMENTER_PROMPT_VERSION did not. " +
        "Bump IMPLEMENTER_PROMPT_VERSION in src/prompts/implementer.ts, then replace " +
        "EXPECTED_TEMPLATE_HASH in this test with the hash printed by the failing assertion.",
    ).toBe(EXPECTED_TEMPLATE_HASH);
  });

  it("stamps the prompt version as a value that changes only with the template", () => {
    expect(IMPLEMENTER_PROMPT_VERSION).toBe("implementer/10");
  });
});

describe("renderImplementerPrompt skills", () => {
  it("states the SDD section 57 precedence of a skill", () => {
    const prompt = renderImplementerPrompt({
      ...SAMPLE,
      skills: ["routes — Add a route. (repository skill, /workspace/primary/.agents/skills/routes/SKILL.md)"],
    });
    expect(prompt).toContain("routes — Add a route.");
    expect(prompt).toContain("SDD section 57 ranks a skill ninth");
  });

  it("reports the prompt version 4", () => {
    expect(IMPLEMENTER_PROMPT_VERSION).toBe("implementer/10");
  });
});

describe("renderImplementerPrompt checks and self-check (implementer-self-check.md)", () => {
  const verifyCommands = [
    { name: "type-check", run: "npm run type-check" },
    { name: "test", run: "npm test" },
  ];

  it("states the checks Factoree runs and scripts no preview start", () => {
    const rendered = renderImplementerPrompt({ ...SAMPLE, verifyCommands, selfCheck: true });
    expect(rendered).toContain("type-check: `npm run type-check`");
    expect(rendered).toContain("test: `npm test`");
    expect(rendered).toContain("repair findings");
    expect(rendered).toContain("agent-browser is installed");
    expect(rendered).not.toContain("npm run build");
    expect(rendered).not.toContain("localhost");
  });

  it("names no browser when the work sprite has no browser tools", () => {
    expect(renderImplementerPrompt({ ...SAMPLE, verifyCommands, selfCheck: false })).not.toContain("agent-browser");
  });
});
