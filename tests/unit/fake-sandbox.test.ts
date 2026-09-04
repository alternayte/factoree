import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { runSandboxContract } from "../support/sandbox-contract.js";

// A conformance suite with one conformer proves nothing about conformance. `FakeSandbox`
// underpins many activity tests, so it must meet the same lifecycle contract as a real adapter.
// It records a command instead of running one, so it claims the lifecycle part only.
runSandboxContract(
  "FakeSandbox",
  () => Promise.resolve({ sandbox: new FakeSandbox(), dispose: () => Promise.resolve() }),
  { executesCommands: false },
);

describe("FakeSandbox", () => {
  it("records the order of the port calls", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: [] });
    await sandbox.checkpoint(ref, "baseline");
    await sandbox.destroy(ref);
    expect(sandbox.calls).toEqual(["create", "applyNetworkPolicy", "checkpoint:baseline", "destroy"]);
  });

  it("returns a scripted result for a matching command", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/git rev-parse/, { stdout: "abc123\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", productId: "p" });
    const result = await sandbox.exec(ref, { file: "git", args: ["rev-parse", "HEAD"] });
    expect(result.stdout).toBe("abc123\n");
  });

  it("gives every sandbox a distinct identifier", async () => {
    const sandbox = new FakeSandbox();
    const first = await sandbox.create({ runId: "a", tenantId: "t", productId: "p" });
    const second = await sandbox.create({ runId: "b", tenantId: "t", productId: "p" });
    expect(first.id).not.toBe(second.id);
  });
});
