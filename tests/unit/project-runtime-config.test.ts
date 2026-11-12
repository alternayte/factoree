import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import { DEFAULT_PROJECT_DEFAULTS, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";

const IDENTITY = "identity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\n";

const minimum = `version: 1\n${IDENTITY}verify:\n  commands:\n    - name: test\n      run: npm test\n`;

describe("toProjectRuntimeConfig", () => {
  // docs/specs/claude-code-runner.md. The Product selects the runners, and an agents block is ignored.
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
    const resolved = toProjectRuntimeConfig(config, {
      stagingRead: true,
      spriteRetentionHours: 48,
      allowedDomains: ["registry.npmjs.org"],
      runners: { refiner: "opencode", implementer: "opencode", validator: "opencode", reviewer: "claude" },
    });
    expect(resolved.runtime).toEqual({
      bootstrapCommand: "npm ci",
      warmCommand: null,
      allowedDomains: ["registry.npmjs.org"],
      sandboxAllowListDeclared: true,
      keyFiles: [],
      bootstrapAllowedDomains: [],
      services: null,
      docker: false,
      accounts: [],
      implementerRunner: "opencode",
      validatorRunner: "opencode",
      reviewerRunner: "claude",
      refinerRunner: "opencode",
      agentsBlockIgnored: true,
      repairMaxAttempts: 1,
      repairBudgetSource: "repository",
      browserLimits: { stepTimeoutMs: 30_000, scenarioTimeoutMs: 180_000 },
      stagingRead: true,
      spriteRetentionHours: 48,
    });
    expect(resolved.verifyCommands).toEqual([{ name: "lint", run: "npm run lint" }]);
  });

  // Issue #44, DI-21.68, DI-21.69.
  it("carries the browser limits in milliseconds and the ready selector of the preview", () => {
    const resolved = toProjectRuntimeConfig(
      parseFactoreeConfig(
        `${minimum}validation:\n  browser:\n    stepTimeoutSeconds: 60\n    scenarioTimeoutSeconds: 600\n` +
          "preview:\n  enabled: true\n  command: npm start\n  readyUrl: http://localhost:3000/\n  timeoutSeconds: 60\n  readySelector: '#app[data-ready]'\n",
      ),
      DEFAULT_PROJECT_DEFAULTS,
    );
    expect(resolved.runtime.browserLimits).toEqual({ stepTimeoutMs: 60_000, scenarioTimeoutMs: 600_000 });
    expect(resolved.preview?.readySelector).toBe("#app[data-ready]");
  });

  // Issue #43, DI-21.67.
  it("takes the repository repair budget when the file sets one, and the Product budget otherwise", () => {
    const product = { ...DEFAULT_PROJECT_DEFAULTS, repairMaxAttempts: 4 };
    expect(toProjectRuntimeConfig(parseFactoreeConfig(minimum), product).runtime).toMatchObject({
      repairMaxAttempts: 4,
      repairBudgetSource: "product",
    });
    expect(toProjectRuntimeConfig(parseFactoreeConfig(`${minimum}repair:\n  maxAttempts: 0\n`), product).runtime).toMatchObject({
      repairMaxAttempts: 0,
      repairBudgetSource: "repository",
    });
    expect(toProjectRuntimeConfig(parseFactoreeConfig(`${minimum}repair: {}\n`), DEFAULT_PROJECT_DEFAULTS).runtime).toMatchObject({
      repairMaxAttempts: 2,
      repairBudgetSource: "product",
    });
  });

  it("maps the services block and turns Docker on for it (repository-setup-and-services.md)", () => {
    const config = parseFactoreeConfig(
      minimum + "services:\n  compose: docker-compose.yml\n  profiles: [dev]\n  seed: just seed-catalog\n",
    );
    const { runtime } = toProjectRuntimeConfig(config, DEFAULT_PROJECT_DEFAULTS);
    expect(runtime.services).toEqual({ compose: "docker-compose.yml", profiles: ["dev"], seed: "just seed-catalog", waitTimeoutSeconds: 180 });
    expect(runtime.docker).toBe(true);
  });

  it("refuses a key file or a compose path that leaves the repository", () => {
    expect(() => parseFactoreeConfig(minimum.replace("version: 1", "version: 1\nbootstrap:\n  command: x\n  keyFiles: [../secrets]"))).toThrow(
      /keyFiles/,
    );
    expect(() => parseFactoreeConfig(minimum + "services:\n  compose: /etc/compose.yml\n")).toThrow(/services.compose/);
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
