import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import { DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";

const IDENTITY = "identity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\n";

const minimum = `version: 1\n${IDENTITY}verify:\n  commands:\n    - name: test\n      run: npm test\n`;

describe("toProjectRuntimeConfig", () => {
  it("maps the repository file onto the runtime configuration", () => {
    const config = parseFactoreeConfig(
      "version: 1\n" +
        IDENTITY +
        "bootstrap:\n  command: npm ci\n" +
        "verify:\n  commands:\n    - name: lint\n      run: npm run lint\n" +
        "agents:\n  implementer: claude\n  validator: opencode\n  reviewer: opencode\n" +
        "repair:\n  maxAttempts: 1\n" +
        "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n",
    );
    const resolved = toProjectRuntimeConfig(config, { stagingRead: true, spriteRetentionHours: 48, allowedDomains: ["registry.npmjs.org"] });
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
    expect(
      toProjectRuntimeConfig(config, { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["registry.npmjs.org"] })
        .runtime.allowedDomains,
    ).toEqual(["registry.npmjs.org"]);
  });

  it("lets the repository narrow the Product allow list, never widen it (R-4)", () => {
    const config = parseFactoreeConfig(
      `${minimum}sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n    - evil.example\n    - api.acme.test\n`,
    );
    const defaults = { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["registry.npmjs.org", "*.acme.test"] };
    expect(toProjectRuntimeConfig(config, defaults).runtime.allowedDomains).toEqual([
      "api.acme.test",
      "registry.npmjs.org",
    ]);
  });

  it("gives a repository that declares no allow list the Product ceiling", () => {
    const defaults = { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["registry.npmjs.org"] };
    expect(toProjectRuntimeConfig(parseFactoreeConfig(minimum), defaults).runtime.allowedDomains).toEqual([
      "registry.npmjs.org",
    ]);
  });

  it("refuses a wildcard that names one label, such as *.com", () => {
    const config = parseFactoreeConfig(`${minimum}sandbox:\n  allowedDomains:\n    - "*.com"\n`);
    expect(() =>
      toProjectRuntimeConfig(config, { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["*.com"] }),
    ).toThrow(/at least two labels/);
  });

  it("carries the preview block of the repository configuration", () => {
    const config = parseFactoreeConfig(
      [
        "version: 1",
        "identity:",
        "  product: checkout-platform",
        "  linear:",
        "    teamKey: PAY",
        "verify:",
        "  commands:",
        "    - name: unit",
        "      run: npm test",
        "preview:",
        "  enabled: true",
        "  command: npm run dev -- --port 8080",
        "  readyUrl: http://127.0.0.1:8080/health",
        "  timeoutSeconds: 60",
      ].join("\n"),
    );

    const resolved = toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS);

    expect(resolved.preview).toEqual({
      enabled: true,
      command: "npm run dev -- --port 8080",
      readyUrl: "http://127.0.0.1:8080/health",
      timeoutSeconds: 60,
    });
  });

  it("reports no preview when the repository configures none", () => {
    const config = parseFactoreeConfig(
      [
        "version: 1",
        "identity:",
        "  product: checkout-platform",
        "  linear:",
        "    teamKey: PAY",
        "verify:",
        "  commands:",
        "    - name: unit",
        "      run: npm test",
      ].join("\n"),
    );

    expect(toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS).preview).toBeNull();
  });
});
