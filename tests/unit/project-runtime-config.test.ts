import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/projects/factoree-config.js";
import { DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";

const minimum = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

describe("toProjectRuntimeConfig", () => {
  it("maps the repository file onto the runtime configuration", () => {
    const config = parseFactoreeConfig(
      "version: 1\n" +
        "bootstrap:\n  command: npm ci\n" +
        "verify:\n  commands:\n    - name: lint\n      run: npm run lint\n" +
        "agents:\n  implementer: claude\n  validator: opencode\n  reviewer: opencode\n" +
        "repair:\n  maxAttempts: 1\n" +
        "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n",
    );
    const resolved = toProjectRuntimeConfig(config, { stagingRead: true, spriteRetentionHours: 48 });
    expect(resolved.runtime).toEqual({
      bootstrapCommand: "npm ci",
      allowedDomains: ["registry.npmjs.org"],
      implementerRunner: "claude",
      validatorRunner: "opencode",
      reviewerRunner: "opencode",
      repairMaxAttempts: 1,
      stagingRead: true,
      spriteRetentionHours: 48,
    });
    expect(resolved.verifyCommands).toEqual([{ name: "lint", run: "npm run lint" }]);
  });

  it("keeps the Project defaults out of the repository file", () => {
    const resolved = toProjectRuntimeConfig(parseFactoreeConfig(minimum), DEFAULT_PROJECT_DEFAULTS);
    expect(resolved.runtime.stagingRead).toBe(false);
    expect(resolved.runtime.spriteRetentionHours).toBe(24);
  });

  it("carries no bootstrap command when the file names none", () => {
    const resolved = toProjectRuntimeConfig(parseFactoreeConfig(minimum), DEFAULT_PROJECT_DEFAULTS);
    expect(resolved.runtime.bootstrapCommand).toBeNull();
  });

  it("normalises the allow list to lower case and removes a duplicate", () => {
    const config = parseFactoreeConfig(
      `${minimum}sandbox:\n  allowedDomains:\n    - Registry.NPMJS.org\n    - registry.npmjs.org\n`,
    );
    expect(toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS).runtime.allowedDomains).toEqual([
      "registry.npmjs.org",
    ]);
  });
});
