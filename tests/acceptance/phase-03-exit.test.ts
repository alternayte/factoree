import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import type { NetworkPolicy, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { runVerification } from "~/domain/runs/verification.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository, git, listRefs } from "./support/fixture-repository.js";

const liar = resolve("tests/fixtures/bin/opencode-liar-stub.sh");
const honest = resolve("tests/fixtures/bin/opencode-stub.sh");

/**
 * Wraps one Sandbox and records every network policy the caller applied. The proxy changes no
 * behaviour, so the adapter under test stays exactly as production uses it.
 */
const recordNetworkPolicies = (inner: Sandbox, recorded: NetworkPolicy[]): Sandbox =>
  new Proxy(inner, {
    get(target, property) {
      if (property === "applyNetworkPolicy") {
        return async (ref: SandboxRef, policy: NetworkPolicy): Promise<void> => {
          recorded.push(policy);
          await target.applyNetworkPolicy(ref, policy);
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });

describe("Phase 3 exit condition — a false agent success claim cannot bypass a failing check", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-p3-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-p3-sandboxes-"));
    // The fixture config declares a check that passes only when target.txt really changed.
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  const prepare = async (runId: string, wrap: (inner: Sandbox) => Sandbox = (inner) => inner) => {
    const sandbox = wrap(new LocalProcessSandbox({ rootDirectory: sandboxRoot }));
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId,
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: repository, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });
    return { sandbox, manager, prepared };
  };

  it("fails verification when the Implementer claims success and changes nothing", async () => {
    const originHeadBefore = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const originRefsBefore = await listRefs(repository);
    const { sandbox, manager, prepared } = await prepare("run-p3-liar");

    // The configuration really came from the repository.
    expect(prepared.verifyCommands).toHaveLength(1);
    expect(prepared.verifyCommands[0]?.name).toBe("check");

    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: liar, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);
    const implementerInput = buildImplementerInput({
      goal: "Replace the contents of target.txt.",
      humanDecisions: [],
      validationContract: null,
      contextContract: null,
      requiredContext: [],
      primaryRepositoryPath: prepared.checkout.primary.path,
      referenceRepositoryPaths: [],
      repositoryInstructions: prepared.repositoryInstructions,
      skills: [],
      actionPolicy: buildActionPolicy(),
      repairFindings: [],
      projectTestSecrets: {},
    });

    const result = await runners.get(prepared.runtime.implementerRunner).run({
      runId: "run-p3-liar",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: implementerInput.environment,
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    // The agent claims success. SDD section 35 says the claim does not decide.
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("The change is implemented. Every test passes.");

    const outcome = await runVerification({
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      commands: prepared.verifyCommands,
      environment: {},
      timeoutMs: 30_000,
      redactor: new Redactor(),
    });

    expect(outcome.passed).toBe(false);
    const check = outcome.checks[0];
    expect(check?.name).toBe("check");
    expect(check?.exitCode).not.toBe(0);
    expect(check?.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(check?.stderrSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(check?.log).not.toBeNull();

    // Nothing was published. The origin is untouched.
    expect((await readFile(join(repository, "target.txt"), "utf8")).trim()).toBe("original");
    expect((await git(repository, ["rev-parse", "HEAD"])).trim()).toBe(originHeadBefore);
    expect(await listRefs(repository)).toEqual(originRefsBefore);

    await manager.release(prepared);
  });

  it("passes verification when the Implementer really made the change (AT-14)", async () => {
    const { sandbox, manager, prepared } = await prepare("run-p3-ok");
    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: honest, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);

    await runners.get(prepared.runtime.implementerRunner).run({
      runId: "run-p3-ok",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: "Replace the contents of target.txt.",
      promptVersion: "test",
      environment: { FACTOREE_STUB_TARGET: "target.txt" },
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    const outcome = await runVerification({
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      commands: prepared.verifyCommands,
      environment: {},
      timeoutMs: 30_000,
      redactor: new Redactor(),
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.checks[0]?.exitCode).toBe(0);
    expect(outcome.checks[0]?.log).toBeNull();

    await manager.release(prepared);
  });

  it("runs the agent under the configured allow list alone", async () => {
    // LocalProcessSandbox cannot enforce a policy, so this asserts what the manager applied, not
    // what a kernel denied. The live proof stays in Phase 12.
    const recorded: NetworkPolicy[] = [];
    const { manager, prepared } = await prepare("run-p3-policy", (inner) =>
      recordNetworkPolicies(inner, recorded),
    );

    // SDD section 32 applies three policies, and the last one is the configured allow list alone.
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    expect(recorded.at(-1)?.allowedDomains).toEqual(prepared.runtime.allowedDomains);

    await manager.release(prepared);
  });
});
