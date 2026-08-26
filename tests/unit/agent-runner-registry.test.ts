import { describe, expect, it } from "vitest";
import { AgentRunnerRegistry, UnknownAgentRunnerError, assertKnownRunners } from "~/domain/runs/agent-runner.js";
import type { AgentRunner } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const stub = (name: string): AgentRunner => ({
  name,
  run: () => Promise.reject(new Error("not used")),
  resume: () => Promise.reject(new Error("not used")),
  cancel: () => Promise.resolve("no-live-session" as const),
});

describe("AgentRunnerRegistry", () => {
  it("returns the runner registered under a name", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(registry.get("opencode").name).toBe("opencode");
  });

  it("throws UnknownAgentRunnerError and names the registered runners", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(() => registry.get("claude")).toThrow(UnknownAgentRunnerError);
    expect(() => registry.get("claude")).toThrow(/opencode/);
  });

  it("refuses to register two runners under one name", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    expect(() => registry.register(stub("opencode"))).toThrow(/already registered/);
  });

  it("lists the registered names in a stable order", () => {
    const registry = new AgentRunnerRegistry([stub("opencode"), stub("claude")]);
    expect(registry.names()).toEqual(["claude", "opencode"]);
  });
});

describe("assertKnownRunners", () => {
  const runtime = { implementerRunner: "opencode", validatorRunner: "claude", reviewerRunner: "claude" };

  it("accepts a configuration whose runners are all registered", () => {
    const registry = new AgentRunnerRegistry([stub("opencode"), stub("claude")]);
    expect(() => assertKnownRunners(registry, runtime)).not.toThrow();
  });

  it("reports every unknown runner as a configuration fault, not an internal fault", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    let caught: unknown;
    try {
      assertKnownRunners(registry, runtime);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunConfigurationError);
    expect(String(caught)).toContain("claude");
    expect(String(caught)).toContain("opencode");
  });

  it("names each unknown runner once, even when two roles name the same one", () => {
    const registry = new AgentRunnerRegistry([stub("opencode")]);
    const message = (() => {
      try {
        assertKnownRunners(registry, runtime);
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(message.match(/"claude"/g)?.length).toBe(1);
  });
});
