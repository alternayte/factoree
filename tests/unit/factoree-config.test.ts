import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/projects/factoree-config.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const complete = `
version: 1

bootstrap:
  command: npm ci

verify:
  commands:
    - name: typecheck
      run: npm run typecheck
    - name: test
      run: npm test

preview:
  enabled: true
  command: npm run dev -- --host 0.0.0.0 --port 8080
  readyUrl: http://127.0.0.1:8080/health
  timeoutSeconds: 60

agents:
  implementer: opencode
  validator: claude
  reviewer: claude

repair:
  maxAttempts: 2

sandbox:
  allowedDomains:
    - registry.npmjs.org

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true

policy:
  defaultAutonomy: L3
`;

const minimum = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

describe("parseFactoreeConfig", () => {
  it("reads every documented key of SDD section 15", () => {
    const config = parseFactoreeConfig(complete);
    expect(config.version).toBe(1);
    expect(config.bootstrap).toEqual({ command: "npm ci" });
    expect(config.verify.commands).toEqual([
      { name: "typecheck", run: "npm run typecheck" },
      { name: "test", run: "npm test" },
    ]);
    expect(config.preview).toEqual({
      enabled: true,
      command: "npm run dev -- --host 0.0.0.0 --port 8080",
      readyUrl: "http://127.0.0.1:8080/health",
      timeoutSeconds: 60,
    });
    expect(config.agents).toEqual({ implementer: "opencode", validator: "claude", reviewer: "claude" });
    expect(config.repair).toEqual({ maxAttempts: 2 });
    expect(config.sandbox).toEqual({ allowedDomains: ["registry.npmjs.org"] });
    expect(config.context.backstage.enabled).toBe(true);
    expect(config.context.referenceRepositories.automaticDiscovery).toBe(true);
    expect(config.policy.defaultAutonomy).toBe("L3");
  });

  it("accepts the minimum file", () => {
    const config = parseFactoreeConfig(minimum);
    expect(config.bootstrap).toBeNull();
    expect(config.preview).toBeNull();
    expect(config.agents.implementer).toBe("opencode");
    expect(config.repair.maxAttempts).toBe(2);
    expect(config.sandbox.allowedDomains).toEqual([]);
    expect(config.policy.defaultAutonomy).toBe("L3");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseFactoreeConfig(`${minimum}plugins: []\n`)).toThrow(RunConfigurationError);
  });

  it("names the offending key in the message", () => {
    expect(() => parseFactoreeConfig(`${minimum}plugins: []\n`)).toThrow(/plugins/);
  });

  it("rejects an unknown nested key", () => {
    const text = "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n      shell: bash\n";
    expect(() => parseFactoreeConfig(text)).toThrow(RunConfigurationError);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseFactoreeConfig("version: 2\nverify:\n  commands:\n    - name: t\n      run: a\n")).toThrow(
      RunConfigurationError,
    );
  });

  it("rejects a duplicate command name", () => {
    const text =
      "version: 1\nverify:\n  commands:\n    - name: test\n      run: a\n    - name: test\n      run: b\n";
    expect(() => parseFactoreeConfig(text)).toThrow(/duplicate/i);
  });

  it("rejects an empty verification command list", () => {
    expect(() => parseFactoreeConfig("version: 1\nverify:\n  commands: []\n")).toThrow(/at least one/i);
  });

  it("rejects text that is not YAML", () => {
    expect(() => parseFactoreeConfig("version: 1\n  bad: [\n")).toThrow(RunConfigurationError);
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parseFactoreeConfig("- 1\n- 2\n")).toThrow(RunConfigurationError);
  });

  it("rejects a domain that is not a host name", () => {
    const text = `${minimum}sandbox:\n  allowedDomains:\n    - https://x.test/\n`;
    expect(() => parseFactoreeConfig(text)).toThrow(RunConfigurationError);
  });
});
