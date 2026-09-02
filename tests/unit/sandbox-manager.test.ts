import { describe, expect, it } from "vitest";
import { NetworkPolicyNotEnforcedError } from "~/domain/runs/sandbox.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import type { Logger, LogFields } from "~/telemetry/logger.js";

const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333";

const DEFAULT_CONFIG_YAML =
  "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
  "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";

const BOOTSTRAP_CONFIG_YAML =
  "version: 1\nbootstrap:\n  command: npm ci\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
  "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";

interface Scripted {
  matcher: RegExp;
  result: Partial<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Builds a `FakeSandbox` that serves `yaml` for `.factoree/config.yaml`, a fixed commit SHA for
 * `git rev-parse HEAD`, and every other command as a success, unless `overrides` matches first.
 */
const sandboxWithConfig = (
  yaml: string,
  overrides: Scripted[] = [],
  capabilities?: ConstructorParameters<typeof FakeSandbox>[0],
): FakeSandbox => {
  const sandbox = capabilities === undefined ? new FakeSandbox() : new FakeSandbox(capabilities);
  sandbox.onExec = (command) => {
    const last = command.args[command.args.length - 1] ?? "";
    if (command.file === "cat" && last.endsWith(".factoree/config.yaml")) {
      return { exitCode: 0, stdout: yaml, stderr: "" };
    }
    if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "no such file" };
    const line = [command.file, ...command.args].join(" ");
    const scripted = overrides.find((entry) => entry.matcher.test(line));
    if (scripted !== undefined) {
      return { exitCode: 0, stdout: "", stderr: "", ...scripted.result };
    }
    if (command.file === "git" && command.args.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return sandbox;
};

/**
 * Wraps the `onExec` of a fake sandbox, so `ls` answers a directory listing and `cat` answers a
 * `SKILL.md`. Every other command falls through to the wrapped hook.
 */
const withSkillFiles = (
  sandbox: FakeSandbox,
  listings: Record<string, string[]>,
  files: Record<string, string>,
): FakeSandbox => {
  const base = sandbox.onExec;
  sandbox.onExec = (command) => {
    const last = command.args[command.args.length - 1] ?? "";
    if (command.file === "ls") {
      const entries = listings[last];
      if (entries === undefined) return { exitCode: 1, stdout: "", stderr: "no such directory" };
      return { exitCode: 0, stdout: `${entries.join("\n")}\n`, stderr: "" };
    }
    const body = files[last];
    if (command.file === "head" && body !== undefined) return { exitCode: 0, stdout: body, stderr: "" };
    return base === null ? { exitCode: 0, stdout: "", stderr: "" } : base(command);
  };
  return sandbox;
};

const input = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [],
  defaults: DEFAULT_PROJECT_DEFAULTS,
};

describe("SandboxManager.prepare", () => {
  it("follows the SDD section 32 order: create, network policy, checkout, bootstrap, checkpoint", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const order = sandbox.calls.filter(
      (call) => call === "create" || call === "applyNetworkPolicy" || call.startsWith("checkpoint"),
    );
    expect(order).toEqual([
      "create",
      "applyNetworkPolicy",
      "applyNetworkPolicy",
      "applyNetworkPolicy",
      "checkpoint:baseline",
    ]);
  });

  it("applies the network policy before it runs any command", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const policyIndex = sandbox.calls.indexOf("applyNetworkPolicy");
    const firstExec = sandbox.calls.findIndex((call) => call.startsWith("exec:"));
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(policyIndex).toBeLessThan(firstExec);
  });

  it("creates the workspace directory after the policy and before the first clone", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const policyIndex = sandbox.calls.indexOf("applyNetworkPolicy");
    const mkdirIndex = sandbox.commands.findIndex(
      (command) => command.file === "mkdir" && command.args.includes("/workspace"),
    );
    const cloneIndex = sandbox.commands.findIndex(
      (command) => command.file === "git" && command.args[0] === "clone",
    );
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(cloneIndex).toBeGreaterThan(mkdirIndex);
    // The applyNetworkPolicy call is not in `commands`, so compare against the raw call order.
    const mkdirCallIndex = sandbox.calls.indexOf("exec:mkdir");
    expect(mkdirCallIndex).toBeGreaterThan(policyIndex);
  });

  it("passes the configured allow list to the last network policy", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.policies.at(-1)).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  });

  it("runs the bootstrap command in the primary worktree after the checkout", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    const bootstrap = sandbox.commands.find((command) =>
      command.args.some((argument) => argument.includes("npm ci")),
    );
    expect(bootstrap?.cwd).toBe("/workspace/primary");
    // A failing stage of a pipeline must fail the bootstrap, so `curl ... | bash` cannot report
    // success after a download that never happened.
    expect(bootstrap?.args.at(-1)).toContain("set -o pipefail");
  });

  it("skips bootstrap when the repository configures no bootstrap command", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    await manager.prepare(input);
    expect(sandbox.commands.some((command) => command.args.includes("npm ci"))).toBe(false);
  });

  it("fails the preparation when the bootstrap command fails", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML, [
      { matcher: /npm ci/, result: { exitCode: 1, stderr: "install failed" } },
    ]);
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(/install failed/);
  });

  it("reports a failed bootstrap command as a configuration fault", async () => {
    // SDD section 49. The command comes from the repository configuration, so a retry repeats it.
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML, [
      { matcher: /npm ci/, result: { exitCode: 1, stderr: "install failed" } },
    ]);
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toBeInstanceOf(RunConfigurationError);
  });

  it("destroys the sandbox when preparation fails, so no sandbox leaks", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML, [
      { matcher: /clone/, result: { exitCode: 128, stderr: "clone failed" } },
    ]);
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(/clone failed/);
    expect(sandbox.destroyed).toHaveLength(1);
  });

  it("returns the sandbox reference, the base SHA, and the baseline checkpoint", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.ref.id).toContain("run-1");
    expect(prepared.checkout.primary.baseSha).toBe(HEAD);
    expect(prepared.baselineCheckpoint?.name).toBe("baseline");
  });

  it("refuses a sandbox that cannot enforce the network policy", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    const manager = new SandboxManager({ sandbox });
    await expect(manager.prepare(input)).rejects.toThrow(NetworkPolicyNotEnforcedError);
  });

  it("accepts an unenforced sandbox only when the caller opts in", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML, [], {
      enforcesNetworkPolicy: false,
      supportsCheckpoints: true,
      supportsExposedServices: false,
    });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    await expect(manager.prepare(input)).resolves.toBeDefined();
  });

  it("skips the checkpoint when the adapter does not support checkpoints", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML, [], {
      enforcesNetworkPolicy: true,
      supportsCheckpoints: false,
      supportsExposedServices: false,
    });
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    expect(prepared.baselineCheckpoint).toBeNull();
    expect(sandbox.checkpoints).toHaveLength(0);
  });

  it("gives two Runs two different sandbox identifiers", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    const first = await manager.prepare(input);
    const second = await manager.prepare({ ...input, runId: "run-2" });
    expect(first.ref.id).not.toBe(second.ref.id);
  });

  it("destroys the sandbox on release", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox });
    const prepared = await manager.prepare(input);
    await manager.release(prepared);
    expect(sandbox.destroyed).toContain(prepared.ref.id);
  });
});

describe("repository configuration and staged network policy", () => {
  const configYaml =
    "version: 1\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
    "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";

  const sandboxServing = (yaml: string | null): FakeSandbox => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file === "cat" && last.endsWith(".factoree/config.yaml")) {
        return yaml === null
          ? { exitCode: 1, stdout: "", stderr: "no such file" }
          : { exitCode: 0, stdout: yaml, stderr: "" };
      }
      if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "no such file" };
      if (command.file === "git" && command.args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return sandbox;
  };

  const prepare = (sandbox: FakeSandbox) =>
    new SandboxManager({ sandbox }).prepare({
      runId: "run-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: "https://git.test/owner/app.git", ref: "main" },
      references: [],
      defaults: { stagingRead: false, spriteRetentionHours: 24 },
    });

  it("applies three policies and never runs the agent under a wider one", async () => {
    const sandbox = sandboxServing(configYaml);
    const prepared = await prepare(sandbox);
    expect(sandbox.networkPolicies).toEqual([
      { allowedDomains: ["git.test"] },
      { allowedDomains: ["git.test", "registry.npmjs.org"] },
      { allowedDomains: ["registry.npmjs.org"] },
    ]);
    expect(prepared.runtime.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(prepared.verifyCommands).toEqual([{ name: "test", run: "npm test" }]);
  });

  it("applies the last policy immediately before the baseline checkpoint", async () => {
    const sandbox = sandboxServing(configYaml);
    await prepare(sandbox);
    const ordered = sandbox.calls.filter(
      (call) => call === "applyNetworkPolicy" || call.startsWith("checkpoint"),
    );
    expect(ordered.at(-1)).toBe("checkpoint:baseline");
    expect(ordered.at(-2)).toBe("applyNetworkPolicy");
  });

  it("fails with a configuration error when the repository has no config file", async () => {
    await expect(prepare(sandboxServing(null))).rejects.toThrow(RunConfigurationError);
  });

  it("destroys the sandbox when the configuration is missing", async () => {
    const sandbox = sandboxServing(null);
    await expect(prepare(sandbox)).rejects.toThrow(RunConfigurationError);
    expect(sandbox.calls).toContain("destroy");
  });

  it("returns the repository instructions it found", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) => {
      const last = command.args[command.args.length - 1] ?? "";
      if (command.file === "git" && command.args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      }
      if (command.file !== "cat") return { exitCode: 0, stdout: "", stderr: "" };
      if (last.endsWith(".factoree/config.yaml")) return { exitCode: 0, stdout: configYaml, stderr: "" };
      if (last.endsWith("AGENTS.md")) return { exitCode: 0, stdout: "house rules\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "no such file" };
    };
    expect((await prepare(sandbox)).repositoryInstructions).toBe("house rules\n");
  });

  it("runs the bootstrap command between policy two and policy three", async () => {
    // Every other test in this block configures no bootstrap command, so the SDD section 32
    // order test filters the bootstrap exec out of its comparison array. This test proves the
    // bootstrap command itself runs strictly between the second and the third policy: after the
    // reference checkouts can reach the configured allow list, and before the Implementer runs
    // under the narrowed final policy.
    const bootstrapConfigYaml =
      "version: 1\nbootstrap:\n  command: npm ci\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
      "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";
    const sandbox = sandboxServing(bootstrapConfigYaml);
    await prepare(sandbox);
    const policyIndexes = sandbox.calls
      .map((call, index) => ({ call, index }))
      .filter((entry) => entry.call === "applyNetworkPolicy")
      .map((entry) => entry.index);
    expect(policyIndexes).toHaveLength(3);
    const bootstrapIndex = sandbox.calls.indexOf("exec:sh");
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(policyIndexes[1] ?? -1);
    expect(bootstrapIndex).toBeLessThan(policyIndexes[2] ?? -1);
  });

  it("joins a reference repository host into policy one and policy two, and drops it from policy three", async () => {
    // Every other test in this block passes no reference repository, so the host union of
    // policy two is exercised with one host only. This test adds a reference repository on a
    // host distinct from the primary one, and proves both hosts reach policy one and policy
    // two, and neither reaches policy three, which carries the configured allow list alone.
    const sandbox = sandboxServing(configYaml);
    await new SandboxManager({ sandbox }).prepare({
      runId: "run-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: "https://git.test/owner/app.git", ref: "main" },
      references: [{ url: "https://other.test/owner/design.git", ref: "main" }],
      defaults: { stagingRead: false, spriteRetentionHours: 24 },
    });
    expect(sandbox.networkPolicies).toEqual([
      { allowedDomains: ["git.test", "other.test"] },
      { allowedDomains: ["git.test", "other.test", "registry.npmjs.org"] },
      { allowedDomains: ["registry.npmjs.org"] },
    ]);
  });
});

describe("SandboxManager.prepare skills", () => {
  it("returns the discovered skill lines of the primary checkout", async () => {
    const sandbox = withSkillFiles(
      sandboxWithConfig(DEFAULT_CONFIG_YAML),
      { "/workspace/primary/.agents/skills": ["routes"] },
      {
        "/workspace/primary/.agents/skills/routes/SKILL.md":
          "---\nname: routes\ndescription: Add a route.\n---\n",
      },
    );
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare(input);
    expect(prepared.skills.some((line) => line.startsWith("routes — Add a route."))).toBe(true);
  });

  it("returns no skill line for a repository that defines none", async () => {
    const sandbox = withSkillFiles(sandboxWithConfig(DEFAULT_CONFIG_YAML), {}, {});
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare(input);
    expect(prepared.skills).toEqual([]);
  });

  it("checks out the organization skills repository when the Project names one", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    await manager.prepare({
      ...input,
      organizationSkills: { url: "https://git.acme.example/acme/skills.git", ref: "main" },
    });
    expect(sandbox.commands.some((command) => command.args.includes("/workspace/organization-skills"))).toBe(
      true,
    );
    // The first policy must already allow the skills host, because the checkout runs under it.
    expect(sandbox.networkPolicies[0]?.allowedDomains).toContain("git.acme.example");
  });

  it("returns the SHA of the organization skills checkout (SDD section 55)", async () => {
    // Two Runs a day apart can read two different skill sets. Without the SHA, no record shows
    // which set a Run read.
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      ...input,
      organizationSkills: { url: "https://git.acme.example/acme/skills.git", ref: "main" },
    });
    expect(prepared.organizationSkillsSha).toBe(HEAD);
  });

  it("returns no SHA when the Project configures no organization skills repository", async () => {
    const sandbox = sandboxWithConfig(DEFAULT_CONFIG_YAML);
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare(input);
    expect(prepared.organizationSkillsSha).toBeUndefined();
  });

  it("reports a failed skill directory read at debug level, through the logger given to SandboxManager", async () => {
    const events: { level: string; message: string; fields: LogFields | undefined }[] = [];
    const recordingLogger: Logger = {
      debug: (message, fields) => events.push({ level: "debug", message, fields }),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => recordingLogger,
    };
    // No listing is scripted for the skill directory, so `ls` answers a non-zero exit code and
    // the read counts as an unexpected failure worth one debug line.
    const sandbox = withSkillFiles(sandboxWithConfig(DEFAULT_CONFIG_YAML), {}, {});
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true, logger: recordingLogger });
    await manager.prepare(input);
    expect(events.some((entry) => entry.message === "skill directory listing failed")).toBe(true);
  });
});

describe("SandboxManager.prepare, a bootstrap that fails inside a pipeline", () => {
  it("fails the Run and reports the output of both streams", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML);
    const onExec = sandbox.onExec;
    sandbox.onExec = (command) =>
      command.args.some((argument) => argument.includes("npm ci"))
        ? { exitCode: 6, stdout: "Installing opencode", stderr: "curl: (6) Could not resolve host" }
        : (onExec?.(command) ?? { exitCode: 0, stdout: "", stderr: "" });
    const manager = new SandboxManager({ sandbox });

    await expect(manager.prepare(input)).rejects.toThrow(
      /the bootstrap command failed with exit code 6: curl: \(6\) Could not resolve host \| Installing opencode/,
    );
  });

  it("says so plainly when the command wrote nothing", async () => {
    const sandbox = sandboxWithConfig(BOOTSTRAP_CONFIG_YAML);
    const onExec = sandbox.onExec;
    sandbox.onExec = (command) =>
      command.args.some((argument) => argument.includes("npm ci"))
        ? { exitCode: 1, stdout: "", stderr: "" }
        : (onExec?.(command) ?? { exitCode: 0, stdout: "", stderr: "" });
    const manager = new SandboxManager({ sandbox });

    await expect(manager.prepare(input)).rejects.toThrow(/the command wrote no output/);
  });
});
