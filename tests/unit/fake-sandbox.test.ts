import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";

describe("FakeSandbox", () => {
  it("records the order of the port calls", async () => {
    const sandbox = new FakeSandbox();
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: [] });
    await sandbox.checkpoint(ref, "baseline");
    await sandbox.destroy(ref);
    expect(sandbox.calls).toEqual(["create", "applyNetworkPolicy", "checkpoint:baseline", "destroy"]);
  });

  it("returns a scripted result for a matching command", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(/git rev-parse/, { stdout: "abc123\n" });
    const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
    const result = await sandbox.exec(ref, { file: "git", args: ["rev-parse", "HEAD"] });
    expect(result.stdout).toBe("abc123\n");
  });

  it("gives every sandbox a distinct identifier", async () => {
    const sandbox = new FakeSandbox();
    const first = await sandbox.create({ runId: "a", tenantId: "t", projectId: "p" });
    const second = await sandbox.create({ runId: "b", tenantId: "t", projectId: "p" });
    expect(first.id).not.toBe(second.id);
  });
});
