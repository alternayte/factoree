import { describe, expect, it } from "vitest";
import { AgentRunnerRegistry, UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import type { AgentRunner } from "~/domain/runs/agent-runner.js";

const stub = (name: string): AgentRunner => ({
  name,
  run: () => Promise.reject(new Error("not used")),
  resume: () => Promise.reject(new Error("not used")),
  cancel: () => Promise.resolve(),
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
