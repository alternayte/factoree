import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createFixtureRepository, git, listRefs } from "./support/fixture-repository.js";

const stub = resolve("tests/fixtures/bin/opencode-stub.sh");

describe("Phase 2 exit condition — an isolated fixture change without publishing", () => {
  let root: string;
  let sandboxRoot: string;
  let repository: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-exit-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-exit-sandboxes-"));
    repository = await createFixtureRepository(root, "app");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("prepares a sandbox, implements a change, and publishes nothing", async () => {
    // The origin state before the Run. Every later comparison uses these values.
    const originHeadBefore = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const originRefsBefore = await listRefs(repository);
    expect(originRefsBefore).toEqual([`refs/heads/main ${originHeadBefore}`]);

    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const runners = new AgentRunnerRegistry([
      new OpenCodeRunner({ executable: stub, redactor: new Redactor(), pollIntervalMs: 20 }),
    ]);

    const prepared = await manager.prepare({
      runId: "run-exit",
      tenantId: "tenant-1",
      projectId: "project-1",
      primary: { url: repository, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });

    // A real sandbox exists, with a captured base SHA and a baseline checkpoint.
    expect(prepared.checkout.primary.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(prepared.checkout.primary.baseSha).toBe(originHeadBefore);
    expect(prepared.baselineCheckpoint?.name).toBe("baseline");
    expect(existsSync(prepared.checkout.primary.path)).toBe(true);

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
      runId: "run-exit",
      tenantId: "tenant-1",
      role: "implementer",
      sandbox,
      ref: prepared.ref,
      workingDirectory: prepared.checkout.primary.path,
      prompt: implementerInput.prompt,
      promptVersion: implementerInput.promptVersion,
      environment: { ...implementerInput.environment, FACTOREE_STUB_TARGET: "target.txt" },
      actionPolicy: buildActionPolicy(),
      timeoutMs: 30_000,
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);

    // The change exists in the isolated worktree, and it is a real content change.
    const status = await sandbox.exec(prepared.ref, {
      file: "git",
      args: ["-C", prepared.checkout.primary.path, "status", "--porcelain"],
    });
    expect(status.stdout).toContain("target.txt");
    const changed = await readFile(join(prepared.checkout.primary.path, "target.txt"), "utf8");
    expect(changed).not.toBe("original\n");
    expect(changed).toContain("Replace the contents of target.txt.");

    // The baseline checkpoint is a real copy taken before the Implementer ran, and not a name
    // alone. It still holds the original content after the worktree changed.
    const checkpointId = prepared.baselineCheckpoint?.id ?? "";
    expect(checkpointId).not.toBe("");
    const baselineCopy = await readFile(
      join(sandboxRoot, prepared.ref.id, "checkpoints", checkpointId, "primary", "target.txt"),
      "utf8",
    );
    expect(baselineCopy).toBe("original\n");

    // Nothing was published. The origin still holds its original content, one commit, the same
    // HEAD, and no new ref of any kind. A new branch, a new tag, or a moved branch appears in
    // the ref list, because each line carries the ref name and the object name together.
    const origin = await readFile(join(repository, "target.txt"), "utf8");
    expect(origin.trim()).toBe("original");
    expect((await git(repository, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
    expect((await git(repository, ["rev-parse", "HEAD"])).trim()).toBe(originHeadBefore);
    expect(await listRefs(repository)).toEqual(originRefsBefore);
    expect((await git(repository, ["status", "--porcelain"])).trim()).toBe("");

    await manager.release(prepared);

    // The sandbox is gone after release. No directory remains, and no command runs.
    expect(existsSync(prepared.checkout.primary.path)).toBe(false);
    expect(existsSync(dirname(prepared.ref.workspacePath))).toBe(false);
    await expect(
      sandbox.exec(prepared.ref, { file: "sh", args: ["-c", "true"] }),
    ).rejects.toThrow(/destroyed/);
  });
});
