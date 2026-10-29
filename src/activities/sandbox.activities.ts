import { repositoryNamesOf } from "~/activities/repository-credential.js";
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type {
  PreviewConfig,
  ProjectDefaults,
  ProjectRuntimeConfig,
  VerificationCommand,
} from "~/domain/runs/project-runtime-config.js";
import type { RepositorySpec } from "~/domain/runs/checkout.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { loadRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import { asRunConfigurationErrorIfDeterministic } from "~/domain/runs/github-app-auth-fault.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { metrics } from "~/telemetry/metrics.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { assertKnownRunners } from "~/domain/runs/agent-runner.js";

export interface SandboxActivityDependencies {
  sandboxManager: SandboxManager;
  sandbox: Sandbox;
  runs: RunRepository;
  reaper: SpriteReaper;
  secrets: SecretStore;
  redactor: Redactor;
  runners: AgentRunnerRegistry;
  logger: Logger;
  /** Mints the read-only clone credential of the target repository, scoped to `contents: read`. */
  tokens: GitHubTokenProvider;
}

export interface PrepareSandboxActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  primary: RepositorySpec;
  references: RepositorySpec[];
  defaults: ProjectDefaults;
  environment: Record<string, string>;
  /** SDD section 16. The organization skills repository of the Project, or null. */
  organizationSkills: RepositorySpec | null;
  /** The GitHub App installation that grants the primary repository. Empty when it holds none. */
  githubInstallationId: string;
}

export interface PrepareSandboxActivityOutput {
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
  referencePaths: string[];
  /** SDD section 55 requires the recorded commit SHA of every repository. */
  referenceBaseShas: string[];
  baselineCheckpointId: string | null;
  runtime: ProjectRuntimeConfig;
  verifyCommands: VerificationCommand[];
  /** SDD sections 15 and 37. The preview the User Validator starts. */
  preview: PreviewConfig | null;
  repositoryInstructions: string;
  /** SDD sections 16 and 34. The applicable skills, as prompt lines. */
  skills: string[];
  /**
   * SDD section 55. The commit the organization skills checkout resolved to. It is absent when
   * the Project configures no organization skills repository.
   */
  organizationSkillsSha?: string;
}

const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * Deletes one sandbox and reports a failure at error level. A silent failure hides a leak, and
 * an operator must be able to see the sandbox that stayed behind.
 */
const release = async (
  dependencies: SandboxActivityDependencies,
  spriteId: string,
  adapter: string,
  destroy: () => Promise<void>,
): Promise<boolean> => {
  try {
    await destroy();
    return true;
  } catch (error) {
    dependencies.logger.error("the sandbox was not deleted and is now unreferenced", {
      sprite_id: spriteId,
      adapter,
      error: String(error),
      step: "prepare",
    });
    return false;
  }
};

/**
 * The body of `prepareSandbox`. It sits outside the activity, so the activity itself holds only
 * the redaction boundary of SDD section 60 and one path for every error the preparation raises.
 */
const prepare = async (
  dependencies: SandboxActivityDependencies,
  input: PrepareSandboxActivityInput,
): Promise<PrepareSandboxActivityOutput> => {
  // SDD section 30. A model provider credential of the coding agent reaches the sandbox from the
  // Project secret store, never from a workflow argument, so no Temporal history holds its value.
  // The workflow passes an empty environment, and this activity fills it.
  const runnerEnvironment = await loadRunnerEnvironment(
    dependencies.secrets,
    input.tenantId,
    input.productId,
  );

  // SDD section 30. A private repository needs a read-only credential for the checkout. It never
  // reaches an agent session: `checkout` gives it to the git clone command alone. The provider
  // mints it fresh for this one preparation, scoped to `contents: read`, so the credential this
  // sandbox receives can never push. An empty installation id means the repository carries no
  // GitHub App installation. Factoree then mints no credential.
  let repositoryCredential: string | null;
  if (input.githubInstallationId === "") {
    repositoryCredential = null;
  } else {
    try {
      // The clone credential reads the repositories this sandbox checks out, and no other
      // repository of the installation.
      repositoryCredential = await dependencies.tokens.tokenForInstallation(
        input.githubInstallationId,
        { contents: "read" },
        repositoryNamesOf([
          input.primary.url,
          ...input.references.map((reference) => reference.url),
          ...(input.organizationSkills === null ? [] : [input.organizationSkills.url]),
        ]),
      );
    } catch (error) {
      // A rejected mint of the clone credential is a configuration fault, not an
      // infrastructure fault, so it must map to the same `RunConfigurationError` the publish
      // activity produces. `~/domain/runs/github-app-auth-fault.js` holds the single conversion
      // every mint site applies.
      throw asRunConfigurationErrorIfDeterministic(dependencies.redactor, error);
    }
  }
  if (repositoryCredential !== null) dependencies.redactor.addSecret(repositoryCredential);

  const prepared = await dependencies.sandboxManager.prepare({
    runId: input.runId,
    tenantId: input.tenantId,
    productId: input.productId,
    primary: input.primary,
    references: input.references,
    defaults: input.defaults,
    environment: { ...input.environment, ...runnerEnvironment },
    ...(repositoryCredential === null ? {} : { repositoryCredential }),
    ...(input.organizationSkills === null ? {} : { organizationSkills: input.organizationSkills }),
  });

  // SDD section 14. A runner name the repository configured must resolve to a registered
  // adapter. This fault is a configuration fault, so the Run ends `CONFIGURATION_INVALID`.
  try {
    assertKnownRunners(dependencies.runners, prepared.runtime);
  } catch (error) {
    // The Run holds no reference to this sandbox, and a Temporal retry creates a new one. The
    // unreferenced sandbox must go now.
    await release(dependencies, prepared.ref.id, prepared.ref.adapter, () =>
      dependencies.sandboxManager.release(prepared),
    );
    throw error;
  }

  // SDD section 51. The Run keeps the sandbox reference and the retention deadline, so
  // `SpriteReaper` can delete the sandbox after the window ends. The workflow never deletes
  // it, because SDD section 32 orders RETAIN before DELETE.
  // A retry of this activity prepares a second sandbox, because `prepare` creates a new one
  // for each call. The sandbox the Run already holds must go, otherwise it becomes
  // unreferenced and the reaper can never find it. `setSandbox` reports what it replaced in
  // one atomic step, so two concurrent attempts never delete the same sandbox. An idempotent
  // `prepare` was the alternative. It was rejected, because a partly prepared sandbox from a
  // crashed attempt has an unknown checkout state, and reuse of it would carry that state into
  // the new attempt.
  const retainUntil = new Date(Date.now() + prepared.runtime.spriteRetentionHours * MILLISECONDS_PER_HOUR);
  let superseded;
  try {
    superseded = await dependencies.runs.setSandbox(input.tenantId, input.runId, {
      spriteId: prepared.ref.id,
      adapter: prepared.ref.adapter,
      retainUntil,
      baseSha: prepared.checkout.primary.baseSha,
      implementerRunner: prepared.runtime.implementerRunner,
      ...(prepared.organizationSkillsSha === undefined
        ? {}
        : { organizationSkillsSha: prepared.organizationSkillsSha }),
    });
  } catch (error) {
    // The Run holds no reference to this sandbox, and a Temporal retry creates a new one. The
    // unreferenced sandbox must go now.
    await release(dependencies, prepared.ref.id, prepared.ref.adapter, () =>
      dependencies.sandboxManager.release(prepared),
    );
    throw error;
  }

  if (superseded.spriteId !== null && superseded.spriteId !== prepared.ref.id) {
    const staleId = superseded.spriteId;
    const staleAdapter = superseded.adapter ?? dependencies.sandbox.name;
    // The workspace path of the new sandbox serves the old one as well. Every adapter uses one
    // fixed workspace path. `SpriteReaper` documents the same assumption.
    const destroyed = await release(dependencies, staleId, staleAdapter, () =>
      dependencies.sandbox.destroy({
        id: staleId,
        adapter: staleAdapter,
        workspacePath: prepared.ref.workspacePath,
      }),
    );
    // Only a real deletion is counted. A failed deletion is a leak, and the log names it.
    if (destroyed) metrics.sandboxesDestroyed.inc({ adapter: staleAdapter, reason: "SUPERSEDED" });
  }

  metrics.sandboxesCreated.inc({
    tenant_id: input.tenantId,
    product_id: input.productId,
    adapter: prepared.ref.adapter,
  });
  dependencies.logger.info("sandbox prepared", {
    tenant_id: input.tenantId,
    product_id: input.productId,
    run_id: input.runId,
    sprite_id: prepared.ref.id,
    base_sha: prepared.checkout.primary.baseSha,
    step: "prepare",
  });

  return {
    spriteId: prepared.ref.id,
    adapter: prepared.ref.adapter,
    workspacePath: prepared.ref.workspacePath,
    primaryPath: prepared.checkout.primary.path,
    baseSha: prepared.checkout.primary.baseSha,
    referencePaths: prepared.checkout.references.map((entry) => entry.path),
    // SDD section 55 requires the recorded SHA of every reference repository, not only the
    // primary one. This closes the Phase 2 carried finding.
    referenceBaseShas: prepared.checkout.references.map((entry) => entry.baseSha),
    baselineCheckpointId: prepared.baselineCheckpoint?.id ?? null,
    runtime: prepared.runtime,
    verifyCommands: prepared.verifyCommands,
    preview: prepared.preview,
    repositoryInstructions: prepared.repositoryInstructions,
    skills: prepared.skills,
    ...(prepared.organizationSkillsSha === undefined
      ? {}
      : { organizationSkillsSha: prepared.organizationSkillsSha }),
  };
};

export const createSandboxActivities = (dependencies: SandboxActivityDependencies) => ({
  async prepareSandbox(input: PrepareSandboxActivityInput): Promise<PrepareSandboxActivityOutput> {
    // SDD section 60: every Project secret must reach the redactor before any output is
    // captured. Preparation clones repositories and runs the bootstrap command, so it captures
    // output long before the Implementer starts.
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.productId,
      dependencies.logger,
    );

    try {
      return await prepare(dependencies, input);
    } catch (error) {
      // SDD section 60: an activity error becomes Temporal history, which is external
      // persistence. The redaction happens here, at the one boundary the whole preparation path
      // passes through, rather than at each throw site. A new error would lose the class, and
      // the workflow reads the class to recognise a configuration fault, so the message of the
      // original error is replaced in place.
      if (error instanceof Error) {
        error.message = dependencies.redactor.redactText(error.message);
        if (error.stack !== undefined) error.stack = dependencies.redactor.redactText(error.stack);
      }
      throw error;
    }
  },

  /**
   * An explicit early teardown. This activity is reserved for a later phase that needs one, for
   * example an operator command. The normal terminal path never calls it. SDD section 51 keeps
   * the sandbox for the retention window, and `SpriteReaper` deletes it later.
   */
  async destroySandbox(input: {
    tenantId: string;
    runId: string;
    spriteId: string;
    adapter: string;
    workspacePath: string;
    reason: string;
  }): Promise<void> {
    await dependencies.sandbox.destroy({
      id: input.spriteId,
      adapter: input.adapter,
      workspacePath: input.workspacePath,
    });
    await dependencies.runs.clearSandbox(input.tenantId, input.runId);
    metrics.sandboxesDestroyed.inc({ adapter: input.adapter, reason: input.reason });
  },

  async reapExpiredSandboxes(): Promise<number> {
    return await dependencies.reaper.reap(new Date());
  },
});
