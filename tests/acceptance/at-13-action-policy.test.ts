import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS, DEFAULT_PROJECT_RUNTIME_CONFIG } from "~/domain/runs/project-runtime-config.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import {
  ForbiddenImplementerMaterialError,
  buildImplementerInput,
} from "~/domain/runs/implementer-input.js";
import { FlySpriteSandbox } from "~/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import type {
  SpritesExecResult,
  SpritesGateway,
  SpritesSpriteHandle,
} from "~/adapters/sandbox/fly-sprites/sprites-client.js";
import { createFixtureRepository } from "./support/fixture-repository.js";

/**
 * Builds a gateway that records every network policy document the adapter sends. Every other
 * member answers with a harmless success, because this test reads the policy only.
 */
const recordingGateway = (sent: unknown[]): SpritesGateway => {
  const ok: SpritesExecResult = { exitCode: 0, stdout: "", stderr: "" };
  const handle: SpritesSpriteHandle = {
    writeFile: () => Promise.resolve(),
    execFile: () => Promise.resolve(ok),
    execFileCaptured: () => Promise.resolve(ok),
    startDetached: () => Promise.resolve(),
    createCheckpoint: () => Promise.resolve({ id: "checkpoint-1" }),
    publishPort: () => Promise.resolve("https://sprite.test"),
    updateNetworkPolicy: (policy) => {
      sent.push(policy);
      return Promise.resolve();
    },
    delete: () => Promise.resolve(),
  };
  return {
    createSprite: (name) => Promise.resolve({ name, handle }),
    sprite: () => handle,
  };
};

describe("AT-13 — Action Policy", () => {
  let root: string;
  let sandboxRoot: string;
  let primary: string;
  let reference: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-at13-repos-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at13-sandboxes-"));
    primary = await createFixtureRepository(root, "app");
    reference = await createFixtureRepository(root, "design");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("lets the Implementer write the primary worktree", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-write",
      tenantId: "t",
      productId: "p",
      primary: { url: primary, ref: "main" },
      references: [{ url: reference, ref: "main" }],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });
    const target = join(prepared.checkout.primary.path, "target.txt");
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `printf changed > '${target}' && printf OK`],
    });
    expect(result.stdout).toBe("OK");
    expect(await readFile(target, "utf8")).toBe("changed");
    expect(buildActionPolicy().decide("writePrimaryWorktree")).toBe("allow");
    await manager.release(prepared);
  });

  it("stops the Implementer from writing a reference repository", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-reference",
      tenantId: "t",
      productId: "p",
      primary: { url: primary, ref: "main" },
      references: [{ url: reference, ref: "main" }],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });
    const entry = prepared.checkout.references[0];
    expect(entry).toBeDefined();
    expect(entry?.readOnly).toBe(true);
    const path = entry?.path ?? "";
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `printf changed > '${path}/target.txt' 2>/dev/null; printf %s $?`],
    });
    expect(result.stdout).not.toBe("0");
    // The file itself is unchanged, so the failure above is a denied write, not a shell fault.
    expect(await readFile(join(path, "target.txt"), "utf8")).toBe("original\n");
    expect(buildActionPolicy().decide("writeReferenceRepository")).toBe("deny");
    await manager.release(prepared);
  });

  it("stops the Implementer from pushing to a git remote", async () => {
    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId: "run-push",
      tenantId: "t",
      productId: "p",
      primary: { url: primary, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });
    const result = await sandbox.exec(prepared.ref, {
      file: "sh",
      args: ["-c", `git -C '${prepared.checkout.primary.path}' push origin HEAD 2>&1; printf "|%s" $?`],
    });
    expect(result.stdout).not.toContain("|0");
    expect(result.stdout).toContain("DISABLED_BY_FACTOREE");
    expect(buildActionPolicy().decide("gitRemoteWriteFromAgent")).toBe("deny");
    await manager.release(prepared);
  });

  it("denies every domain outside the Project allow list", async () => {
    // The local adapter cannot enforce egress, so the proof is on the required adapter: the
    // policy document FlySpriteSandbox sends. The live proof belongs to Phase 12, SDD section 66.
    const sent: unknown[] = [];
    const sprites = new FlySpriteSandbox({ gateway: recordingGateway(sent) });
    const ref = await sprites.create({ runId: "run-1", tenantId: "t", productId: "p" });

    await sprites.applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] });
    expect(sent[0]).toEqual({
      rules: [
        { domain: "registry.npmjs.org", action: "allow" },
        { domain: "*", action: "deny" },
      ],
    });

    // The default Project configuration allows no domain, so the document denies everything.
    await sprites.applyNetworkPolicy(ref, {
      allowedDomains: DEFAULT_PROJECT_RUNTIME_CONFIG.allowedDomains,
    });
    expect(sent[1]).toEqual({ rules: [{ domain: "*", action: "deny" }] });
    expect(buildActionPolicy().decide("arbitraryOutboundNetwork")).toBe("deny");
  });

  it("AT-26: the Implementer cannot read a GitHub write credential", () => {
    expect(() =>
      buildImplementerInput({
        goal: "g",
        humanDecisions: [],
        validationContract: null,
        contextContract: null,
        requiredContext: [],
        primaryRepositoryPath: "/workspace/primary",
        referenceRepositoryPaths: [],
        repositoryInstructions: "",
        skills: [],
        actionPolicy: buildActionPolicy(),
        repairFindings: [],
        projectTestSecrets: { GITHUB_TOKEN: "ghp_forbidden" },
      }),
    ).toThrow(ForbiddenImplementerMaterialError);
  });
});
