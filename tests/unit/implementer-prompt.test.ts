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
const EXPECTED_TEMPLATE_HASH = "1502cb7b39eb8163360c7f16ba1528c4f933b35f6db70e2034c5f8cd82074758";

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
    expect(IMPLEMENTER_PROMPT_VERSION).toBe("implementer/1");
  });
});
