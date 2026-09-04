import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeCodeRunner } from "~/adapters/runners/claude-code/claude-code-runner.js";
import { OpenCodeRunner } from "~/adapters/runners/opencode/opencode-runner.js";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { AgentRunnerRegistry, assertKnownRunners } from "~/domain/runs/agent-runner.js";
import { buildImplementerInput } from "~/domain/runs/implementer-input.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { runVerification } from "~/domain/runs/verification.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FIXTURE_CONFIG, createFixtureRepository } from "./fixture-repository.js";

/**
 * One fixture drive, parameterised by runner name. SDD section 69 asks for one workflow that
 * reaches verification with either required runner. This module holds that single drive, so
 * AT-14, AT-15, and the Phase 11 exit test share exactly one code path.
 *
 * The runner comes from `.factoree/config.yaml` alone. The drive resolves it from
 * `prepared.runtime.implementerRunner`, so runner selection stays configuration driven, as SDD
 * section 14 requires.
 */

export interface FixtureDriveOptions {
  /** The runner name written into `agents.implementer` of the fixture configuration. */
  runnerName: string;
  /** True selects the honest stub of each runner. False selects the liar stub of each runner. */
  honest: boolean;
}

export interface FixtureOutcome {
  /** The agent claim. SDD section 35 states that the claim does not decide the result. */
  claimedCompleted: boolean;
  verificationPassed: boolean;
  /** The name of the runner the registry resolved from the prepared runtime configuration. */
  runnerName: string;
  skills: string[];
}

/** The stub executable of each runner, for each honesty. Nothing else separates the two paths. */
const STUBS: Record<string, { honest: string; liar: string }> = {
  opencode: {
    honest: resolve("tests/fixtures/bin/opencode-stub.sh"),
    liar: resolve("tests/fixtures/bin/opencode-liar-stub.sh"),
  },
  claude: {
    honest: resolve("tests/fixtures/bin/claude-stub.sh"),
    liar: resolve("tests/fixtures/bin/claude-liar-stub.sh"),
  },
};

const stubFor = (runner: string, honest: boolean): string => {
  const pair = STUBS[runner];
  if (pair === undefined) throw new Error(`No stub exists for the runner "${runner}".`);
  return honest ? pair.honest : pair.liar;
};

/** The fixture configuration, plus the one line that selects the runner under test. */
const configFor = (runnerName: string): string => `${FIXTURE_CONFIG}
agents:
  implementer: ${runnerName}
`;

let counter = 0;

/**
 * Drives one fixture repository from checkout to deterministic verification. The caller names
 * the runner and the honesty. Every other input stays identical, so a difference in the outcome
 * can come from the runner or from the stub alone.
 */
export const driveFixtureToVerification = async (
  options: FixtureDriveOptions,
): Promise<FixtureOutcome> => {
  counter += 1;
  const runId = `run-p11-${options.runnerName}-${options.honest ? "honest" : "liar"}-${counter}`;
  const root = await mkdtemp(join(tmpdir(), "factoree-p11-repos-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-p11-sandboxes-"));

  try {
    // The fixture check passes only when the Implementer really replaced target.txt.
    const repository = await createFixtureRepository(root, "app", configFor(options.runnerName));

    const sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const manager = new SandboxManager({ sandbox, allowUnenforcedNetwork: true });
    const prepared = await manager.prepare({
      runId,
      tenantId: "tenant-1",
      productId: "project-1",
      primary: { url: repository, ref: "main" },
      references: [],
      defaults: DEFAULT_PROJECT_DEFAULTS,
    });

    try {
      // Both required adapters are registered. The configuration alone decides which one runs.
      const registry = new AgentRunnerRegistry([
        new OpenCodeRunner({
          executable: stubFor("opencode", options.honest),
          redactor: new Redactor(),
          pollIntervalMs: 20,
        }),
        new ClaudeCodeRunner({
          executable: stubFor("claude", options.honest),
          redactor: new Redactor(),
          pollIntervalMs: 20,
        }),
      ]);
      assertKnownRunners(registry, prepared.runtime);
      const runner = registry.get(prepared.runtime.implementerRunner);

      const implementerInput = buildImplementerInput({
        goal: "Replace the contents of target.txt.",
        humanDecisions: [],
        validationContract: null,
        contextContract: null,
        requiredContext: [],
        primaryRepositoryPath: prepared.checkout.primary.path,
        referenceRepositoryPaths: [],
        repositoryInstructions: prepared.repositoryInstructions,
        skills: prepared.skills,
        actionPolicy: buildActionPolicy(),
        repairFindings: [],
        projectTestSecrets: {},
      });

      const result = await runner.run({
        runId,
        tenantId: "tenant-1",
        role: "implementer",
        sandbox,
        ref: prepared.ref,
        workingDirectory: prepared.checkout.primary.path,
        prompt: implementerInput.prompt,
        promptVersion: implementerInput.promptVersion,
        // The honest stub writes the prompt into this file. The liar stub ignores the value.
        environment: { ...implementerInput.environment, FACTOREE_STUB_TARGET: "target.txt" },
        actionPolicy: buildActionPolicy(),
        timeoutMs: 30_000,
      });

      const verification = await runVerification({
        sandbox,
        ref: prepared.ref,
        workingDirectory: prepared.checkout.primary.path,
        commands: prepared.verifyCommands,
        environment: {},
        timeoutMs: 30_000,
        redactor: new Redactor(),
      });

      return {
        claimedCompleted: result.completed,
        verificationPassed: verification.passed,
        runnerName: runner.name,
        skills: prepared.skills,
      };
    } finally {
      await manager.release(prepared);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sandboxRoot, { recursive: true, force: true });
  }
};
