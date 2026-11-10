import { repositoryNamesOf } from "~/activities/repository-credential.js";
import type { Logger } from "~/telemetry/logger.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import type { SpriteReaper } from "~/domain/runs/sprite-reaper.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { PreparedSandbox } from "~/domain/runs/sandbox-manager.js";
import type { VerifiedPatch } from "~/domain/publishing/patch.js";
import { applyPatch, capturePatch, PatchError } from "~/domain/publishing/patch.js";
import { checkDefiningFilesOf } from "~/domain/runs/check-defining-files.js";
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
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { metrics } from "~/telemetry/metrics.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { assertKnownRunners } from "~/domain/runs/agent-runner.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import { CLAUDE_CREDENTIAL_NAMES, claudeApiHostOf, hasClaudeCredential, resolveRole } from "~/domain/products/agent-settings.js";
import type { RunRunners } from "~/domain/runs/project-runtime-config.js";
import { timeStage, type RunStageStore } from "~/domain/runs/run-stage.js";
import type { RunSkillStore } from "~/domain/runs/run-skill.js";
import type { SkillRegistrySettings, SkillResolution } from "~/domain/runs/skill-registry.js";
import { asRunFault, registryOf, type SkillRegistryFactory } from "./skill-registry.activities.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { ContextDeliverySourceProvider } from "~/domain/context/context-source-provider.js";
import {
  CONTEXT_DELIVERY_DIRECTORY,
  deliverableItems,
  deliverContext,
  deliverImages,
  inContractOrder,
  type ContextDelivery,
  type DeliveredContextEntry,
} from "~/domain/context/context-delivery.js";
import type { SelectedContextItem } from "~/domain/context/conflicts.js";
import type { ContextSource } from "~/domain/context/context-source.js";
import {
  readLinkTarget,
  WORK_ITEM_COMMENTS_REF,
  WORK_ITEM_MAX_IMAGE_BYTES,
  type WorkItemContentPort,
  type WorkItemImage,
  type WorkItemLink,
} from "~/domain/context/work-item-content.js";
import { linkReadersFor } from "./work-item.activities.js";
import { createHash } from "node:crypto";

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
  /** docs/specs/run-speed.md. The stage rows of each run. */
  stages?: RunStageStore | undefined;
  /** docs/specs/skill-registry.md. The skills of each run, and the adapter of each registry kind. */
  skills?: RunSkillStore | undefined;
  registries?: SkillRegistryFactory | undefined;
  /**
   * docs/specs/claude-code-runner.md. The Product selects the runner of each role. Without it
   * every role runs on opencode, which is what a test of another concern does.
   */
  products?: Pick<ProductRegistry, "findById"> | undefined;
  /**
   * docs/specs/external-context-delivery.md. The frozen contract and the configured sources the
   * work sprite delivery reads. Without them the work sprite gets no context files.
   */
  contextContracts?: Pick<ContextContractStore, "findByRun"> | undefined;
  contextDelivery?: ContextDeliverySourceProvider | undefined;
  /**
   * docs/specs/work-item-images-and-links.md. Reads an image and a followed link again for the
   * delivery. Without it an image or a Linear or GitHub link is skipped with the reason.
   */
  workItemContent?: WorkItemContentPort | undefined;
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
  /**
   * docs/specs/skill-registry.md. The skill registry of the Product, or null. Absent in a history
   * recorded before the registry existed.
   */
  skillRegistry?: SkillRegistrySettings | null;
  /**
   * docs/specs/external-context-delivery.md. The refs the delivery fetches, in contract order.
   * Absent in an older history, and then the stored order applies.
   */
  contextRefs?: string[];
  /**
   * docs/specs/work-item-images-and-links.md. The frozen images of the work item. The work sprite
   * and every check sprite receive them. Absent in an older history and for a run with none.
   */
  workItemImages?: WorkItemImage[];
  /** The text of the frozen comments item, which the work sprite receives as a context file. */
  workItemComments?: string | null;
  /** The followed links of the work item, which the work sprite delivery reads again. */
  workItemLinks?: WorkItemLink[];
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
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. True when the work sprite holds agent-browser.
   * Absent in a history recorded before the self-check existed.
   */
  selfCheckReady?: boolean;
  /**
   * docs/specs/external-context-delivery.md. One prompt line per context file of the work sprite.
   * A check sprite gets none. Absent in a history recorded before the delivery existed.
   */
  contextFiles?: string[];
  /**
   * docs/specs/work-item-images-and-links.md. One prompt line per image file of this sandbox, the
   * work sprite or a check sprite. Absent in a history recorded before the images existed.
   */
  imageFiles?: string[];
}

/** The work sprite of the Run, where the Implementer wrote the change. */
export interface WorkSandbox {
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  baseSha: string;
}

/** docs/specs/check-isolation.md. The preparation input of the Run, and the work sprite to read. */
export interface PrepareCheckSandboxActivityInput extends PrepareSandboxActivityInput {
  work: WorkSandbox;
  /** The check sprite of the previous attempt, destroyed before the new one starts. */
  previous: { spriteId: string; adapter: string; workspacePath: string } | null;
  attempt: number;
  /**
   * docs/specs/run-speed.md. The patch the first check sprite of this attempt holds. The reviewer's
   * check sprite must capture the same patch. Absent for the first check sprite.
   */
  expectedPatchSha256?: string;
}

export interface PrepareCheckSandboxActivityOutput extends PrepareSandboxActivityOutput {
  /** The SHA-256 of the captured patch. Publication must reproduce it. */
  patchSha256: string;
  /** The tree of base SHA plus the patch, before any project code ran in the check sprite. */
  treeSha: string;
  changedFiles: string[];
  /** The changed files that define a check. docs/specs/check-isolation.md. */
  checkDefiningFiles: string[];
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
const build = async (
  dependencies: SandboxActivityDependencies,
  input: PrepareSandboxActivityInput,
  beforeBootstrap?: (ref: SandboxRef, primaryPath: string) => Promise<void>,
): Promise<PreparedSandbox> => {
  // SDD section 30. A model provider credential of the coding agent reaches the sandbox from the
  // Project secret store, never from a workflow argument, so no Temporal history holds its value.
  // The workflow passes an empty environment, and this activity fills it.
  const runnerEnvironment = await loadRunnerEnvironment(
    dependencies.secrets,
    input.tenantId,
    input.productId,
  );

  // docs/specs/claude-code-runner.md. The Product selects the runner of each role. A claude role
  // needs an Anthropic credential, and the run fails here, before any sandbox exists, without one.
  // Only the sandbox that hosts a claude session gets the model host: the work sprite hosts the
  // refiner and the implementer, and a check sprite the validator and the reviewer.
  const product = dependencies.products === undefined ? null : await dependencies.products.findById(input.tenantId, input.productId);
  const runners: RunRunners = {
    refiner: product === null ? "opencode" : resolveRole(product, "refiner").runner,
    implementer: product === null ? "opencode" : resolveRole(product, "implementer").runner,
    validator: product === null ? "opencode" : resolveRole(product, "validator").runner,
    reviewer: product === null ? "opencode" : resolveRole(product, "reviewer").runner,
  };
  const claudeRoles = (Object.keys(runners) as (keyof RunRunners)[]).filter((role) => runners[role] === "claude");
  if (claudeRoles.length > 0 && !hasClaudeCredential(runnerEnvironment)) {
    throw new RunConfigurationError(
      `The Product runs the ${claudeRoles.join(", ")} on Claude Code, and it holds no Anthropic credential. ` +
        `Add ${CLAUDE_CREDENTIAL_NAMES.join(" or ")} as a runner credential on the product page.`,
    );
  }
  const sandboxRoles: (keyof RunRunners)[] = beforeBootstrap === undefined ? ["refiner", "implementer"] : ["validator", "reviewer"];
  const claudeHost = claudeApiHostOf(runnerEnvironment);
  const agentHosts = sandboxRoles.some((role) => runners[role] === "claude") && claudeHost !== null ? [claudeHost] : [];

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

  // docs/specs/skill-registry.md. The worker resolves the registry and checks every archive before
  // the sandbox exists. Only the work sprite gets the skills, because only the implementer reads
  // them. A fault that repeats on a retry is a configuration fault.
  let registrySkills: SkillResolution | null = null;
  if (beforeBootstrap === undefined) {
    try {
      const registry = await registryOf(
        { secrets: dependencies.secrets, redactor: dependencies.redactor, logger: dependencies.logger, registries: dependencies.registries },
        {
          tenantId: input.tenantId,
          productId: input.productId,
          skillRegistry: input.skillRegistry ?? null,
          githubInstallationId: input.githubInstallationId,
        },
      );
      const delivery = registry === null ? null : await registry.resolve();
      if (delivery?.kind === "archives") registrySkills = delivery.resolution;
    } catch (error) {
      throw asRunFault(error);
    }
    if (registrySkills !== null && !registrySkills.complete) {
      dependencies.logger.warn("the skill registry left entries of the set out of the resolution", {
        run_id: input.runId,
        set: registrySkills.set,
        resolution_id: registrySkills.id,
        step: "prepare",
      });
    }
  }

  const prepared = await dependencies.sandboxManager.prepare(
    {
    runId: input.runId,
    tenantId: input.tenantId,
    productId: input.productId,
    primary: input.primary,
    references: input.references,
    defaults: { ...input.defaults, runners },
    environment: { ...input.environment, ...runnerEnvironment },
    agentHosts,
    ...(repositoryCredential === null ? {} : { repositoryCredential }),
    ...(input.organizationSkills === null ? {} : { organizationSkills: input.organizationSkills }),
    ...(registrySkills === null ? {} : { registrySkills }),
    // A check sprite applies a patch before its bootstrap. Only the work sprite hosts an agent
    // that checks its own work in a browser.
    browserTools: beforeBootstrap === undefined,
    },
    beforeBootstrap,
  );

  // SDD section 14. A runner name the Product selects must resolve to a registered adapter. This fault is a configuration fault, so the Run ends `CONFIGURATION_INVALID`.
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
  return prepared;
};

const toOutput = (prepared: PreparedSandbox): PrepareSandboxActivityOutput => ({
  spriteId: prepared.ref.id,
  adapter: prepared.ref.adapter,
  workspacePath: prepared.ref.workspacePath,
  primaryPath: prepared.checkout.primary.path,
  baseSha: prepared.checkout.primary.baseSha,
  referencePaths: prepared.checkout.references.map((entry) => entry.path),
  // SDD section 55 requires the recorded SHA of every reference repository, not only the
  // primary one.
  referenceBaseShas: prepared.checkout.references.map((entry) => entry.baseSha),
  baselineCheckpointId: prepared.baselineCheckpoint?.id ?? null,
  runtime: prepared.runtime,
  verifyCommands: prepared.verifyCommands,
  preview: prepared.preview,
  repositoryInstructions: prepared.repositoryInstructions,
  skills: prepared.skills,
  selfCheckReady: prepared.selfCheckReady,
  ...(prepared.organizationSkillsSha === undefined
    ? {}
    : { organizationSkillsSha: prepared.organizationSkillsSha }),
});

/**
 * The context directory of a sandbox. The agent's home is known only inside the sandbox, so the
 * shell makes the directory and prints its absolute path. A fault gives the reason every file is
 * then skipped with.
 */
const contextDirectory = async (
  dependencies: SandboxActivityDependencies,
  ref: SandboxRef,
): Promise<{ directory: string; unavailable: string | null }> => {
  try {
    const made = await dependencies.sandbox.exec(ref, {
      file: "sh",
      args: ["-c", 'mkdir -p -- "$HOME/$0" && cd -- "$HOME/$0" && pwd', CONTEXT_DELIVERY_DIRECTORY],
      cwd: "/",
    });
    const directory = made.stdout.trim();
    if (made.exitCode !== 0 || !directory.startsWith("/")) {
      return { directory, unavailable: `The context directory could not be made: exit code ${made.exitCode}, ${made.stderr.trim()}` };
    }
    return { directory, unavailable: null };
  } catch (error) {
    return { directory: "", unavailable: `The context directory could not be made: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/**
 * DI-21.44. `Sandbox.writeFile` writes text, so the bytes of an image travel as base64 to a file
 * beside the target, the sandbox decodes them, and `sha256sum` reports the hash of the file the
 * agent will open.
 */
const writeBinaryFile = async (
  dependencies: SandboxActivityDependencies,
  ref: SandboxRef,
  path: string,
  bytes: Uint8Array,
): Promise<string> => {
  await dependencies.sandbox.writeFile(ref, `${path}.base64`, Buffer.from(bytes).toString("base64"));
  const decoded = await dependencies.sandbox.exec(ref, {
    file: "sh",
    args: ["-c", 'base64 -d < "$0.base64" > "$0" && rm -f -- "$0.base64" && sha256sum -- "$0"', path],
    cwd: "/",
  });
  if (decoded.exitCode !== 0) throw new Error(`exit code ${decoded.exitCode}, ${decoded.stderr.trim()}`);
  return decoded.stdout.trim().split(/\s+/)[0] ?? "";
};

/** Delivers the frozen images of the run to one sandbox (DI-21.44). */
const deliverRunImages = (
  dependencies: SandboxActivityDependencies,
  input: PrepareSandboxActivityInput,
  ref: SandboxRef,
  place: { directory: string; unavailable: string | null },
): Promise<ContextDelivery> =>
  deliverImages({
    images: input.workItemImages ?? [],
    directory: place.directory,
    unavailable: place.unavailable,
    download: (image) => {
      if (dependencies.workItemContent === undefined) return Promise.reject(new Error("this worker holds no Linear image reader"));
      return dependencies.workItemContent.downloadImage(input.tenantId, image.url, WORK_ITEM_MAX_IMAGE_BYTES);
    },
    write: (path, bytes) => writeBinaryFile(dependencies, ref, path, bytes),
  });

/**
 * docs/specs/work-item-images-and-links.md. The Linear source of the delivery: the comments item
 * from the text the run froze, and a followed Linear or GitHub link read again through the same
 * reader. Delivery compares each with its frozen hash.
 */
const workItemDeliverySource = (dependencies: SandboxActivityDependencies, input: PrepareSandboxActivityInput): ContextSource => ({
  id: () => "linear",
  discover: () => Promise.resolve([]),
  fetch: async (reference) => {
    if (reference.ref === WORK_ITEM_COMMENTS_REF) {
      const comments = input.workItemComments ?? null;
      if (comments === null) throw new Error("the run froze no comment text");
      return { reference, sourceVersion: reference.ref, content: comments };
    }
    const link = (input.workItemLinks ?? []).find((candidate) => candidate.ref === reference.ref);
    if (link === undefined) throw new Error(`the run followed no link "${reference.ref}"`);
    if (dependencies.workItemContent === undefined || dependencies.contextDelivery === undefined) {
      throw new Error("this worker holds no link reader");
    }
    const read = await readLinkTarget(
      link.target,
      linkReadersFor({ content: dependencies.workItemContent, sources: dependencies.contextDelivery }, input.tenantId, input.productId),
    );
    return { reference, sourceVersion: createHash("sha256").update(read.content, "utf8").digest("hex"), content: read.content };
  },
});

/**
 * docs/specs/external-context-delivery.md. Fetches each required and reference item of an
 * llms.txt, MCP or Backstage source again, and the comments and followed links of the work item
 * (docs/specs/work-item-images-and-links.md), and writes each to `$HOME/.factoree/context` in the
 * work sprite, outside the checkout, so no captured patch holds it. The frozen images go to the
 * same directory. `Run.deliveredContext` records every item. A source fault, a hash mismatch or a
 * sandbox write fault skips the item (DI-5.13); a fault of the control plane store fails the
 * activity, and a retry prepares a new sandbox.
 */
const deliverWorkSpriteContext = async (
  dependencies: SandboxActivityDependencies,
  input: PrepareSandboxActivityInput,
  prepared: PreparedSandbox,
): Promise<{ contextFiles: string[]; imageFiles: string[] }> => {
  const images = input.workItemImages ?? [];
  let items: SelectedContextItem[] = [];
  let stored = false;
  if (dependencies.contextContracts !== undefined && dependencies.contextDelivery !== undefined) {
    const contract = await dependencies.contextContracts.findByRun(input.tenantId, input.runId);
    if (contract !== null) {
      stored = true;
      items = inContractOrder(contract.items, input.contextRefs);
    }
  }
  const deliverable = deliverableItems(items);
  if (deliverable.length === 0 && images.length === 0) {
    if (stored) await dependencies.runs.setDeliveredContext(input.tenantId, input.runId, []);
    return { contextFiles: [], imageFiles: [] };
  }

  const place = await contextDirectory(dependencies, prepared.ref);
  let delivery: ContextDelivery = { entries: [], lines: [] };
  if (deliverable.length > 0 && dependencies.contextDelivery !== undefined) {
    const { sources, kinds } = await dependencies.contextDelivery.configuredSourcesFor(input.tenantId, input.productId);
    sources.register(workItemDeliverySource(dependencies, input));
    delivery = await deliverContext({
      items,
      sources,
      kinds,
      directory: place.directory,
      unavailable: place.unavailable,
      write: (path, content) => dependencies.sandbox.writeFile(prepared.ref, path, content),
    });
  }
  const imageDelivery = await deliverRunImages(dependencies, input, prepared.ref, place);

  // SDD section 60. A reason can hold a server message, and the record is external persistence.
  const entries: DeliveredContextEntry[] = [...delivery.entries, ...imageDelivery.entries].map((entry) =>
    entry.skipReason === null ? entry : { ...entry, skipReason: dependencies.redactor.redactText(entry.skipReason) },
  );
  await dependencies.runs.setDeliveredContext(input.tenantId, input.runId, entries);
  dependencies.logger.info("context delivered to the work sprite", {
    tenant_id: input.tenantId,
    run_id: input.runId,
    sprite_id: prepared.ref.id,
    delivered: delivery.lines.length + imageDelivery.lines.length,
    skipped: entries.length - delivery.lines.length - imageDelivery.lines.length,
    step: "prepare",
  });
  return { contextFiles: delivery.lines, imageFiles: imageDelivery.lines };
};

/**
 * docs/specs/work-item-images-and-links.md. A check sprite receives the frozen images only: the
 * user validator and the reviewer must see the mockup to judge a match. Other context files stay
 * in the work sprite. A check sprite keeps no delivery record, so a skip is logged.
 */
const deliverCheckSpriteImages = async (
  dependencies: SandboxActivityDependencies,
  input: PrepareCheckSandboxActivityInput,
  ref: SandboxRef,
): Promise<string[]> => {
  if ((input.workItemImages ?? []).length === 0) return [];
  const delivery = await deliverRunImages(dependencies, input, ref, await contextDirectory(dependencies, ref));
  const skipped = delivery.entries.filter((entry) => entry.skipReason !== null);
  dependencies.logger.info("images delivered to the check sprite", {
    tenant_id: input.tenantId,
    run_id: input.runId,
    sprite_id: ref.id,
    attempt: input.attempt,
    delivered: delivery.lines.length,
    skipped: skipped.length,
    ...(skipped.length === 0
      ? {}
      : { skip_reasons: skipped.map((entry) => `${entry.ref}: ${dependencies.redactor.redactText(entry.skipReason ?? "")}`).join("; ") }),
    step: "prepare_check",
  });
  return delivery.lines;
};

const prepare = async (
  dependencies: SandboxActivityDependencies,
  input: PrepareSandboxActivityInput,
): Promise<PrepareSandboxActivityOutput> => {
  const prepared = await build(dependencies, input);

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

  // docs/specs/skill-registry.md and SDD section 55. The run records each skill it received and
  // the resolution that pins the registry versions. A retried preparation replaces the record.
  await dependencies.skills?.replace(input.tenantId, input.runId, prepared.skillRecords, prepared.skillResolution);

  // docs/specs/external-context-delivery.md. Only the work sprite gets context files: the user
  // validator and the reviewer start fresh in a check sprite and judge the artefacts. The images
  // of the work item go to every sandbox (docs/specs/work-item-images-and-links.md).
  const { contextFiles, imageFiles } = await deliverWorkSpriteContext(dependencies, input, prepared);

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

  return { ...toOutput(prepared), contextFiles, imageFiles };
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
      return await timeStage(
        dependencies.stages,
        dependencies.logger,
        { tenantId: input.tenantId, runId: input.runId, stage: "prepare_sandbox", attempt: 1, sandboxId: null },
        () => prepare(dependencies, input),
        (output) => output.spriteId,
      );
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
   * docs/specs/check-isolation.md. Captures the patch of the work sprite with Factoree's own git,
   * builds a new check sprite at the base SHA, applies the patch before the bootstrap, and proves
   * that the check sprite holds the same patch. Verification, user validation, review and
   * publication then run in the check sprite, which no agent has touched.
   */
  async prepareCheckSandbox(
    input: PrepareCheckSandboxActivityInput,
  ): Promise<PrepareCheckSandboxActivityOutput> {
    await registerProjectSecrets(
      dependencies.redactor,
      dependencies.secrets,
      input.tenantId,
      input.productId,
      dependencies.logger,
    );
    const patchDependencies = { sandbox: dependencies.sandbox, redactor: dependencies.redactor };

    try {
      return await timeStage(
        dependencies.stages,
        dependencies.logger,
        { tenantId: input.tenantId, runId: input.runId, stage: "prepare_check_sprite", attempt: input.attempt, sandboxId: null },
        async () => {
          const captured = await capturePatch(patchDependencies, {
            ref: { id: input.work.spriteId, adapter: input.work.adapter, workspacePath: input.work.workspacePath },
            primaryPath: input.work.primaryPath,
            baseSha: input.work.baseSha,
          });
          // docs/specs/run-recovery.md. A follow-up run reads what this run last tried. A failed
          // write costs the follow-up its reference and nothing else.
          await dependencies.runs.recordLastPatch(input.tenantId, input.runId, captured.patchBase64).catch((error: unknown) => {
            dependencies.logger.warn("the last patch of the run was not recorded", { run_id: input.runId, error: String(error) });
          });
          // docs/specs/run-speed.md. The reviewer's check sprite must hold the patch the first
          // check sprite of this attempt verified.
          const expected = input.expectedPatchSha256;
          if (expected !== undefined && captured.patchSha256 !== expected) {
            throw new PatchError(
              `the work sprite now holds patch ${captured.patchSha256}, and this attempt verified patch ${expected}.`,
            );
          }

          // The check sprite of the previous attempt checked a patch the repair replaced. It goes
          // before the new one starts, so one Run holds at most three live sandboxes (the work
          // sprite and the two check sprites of docs/specs/run-speed.md), and a Run at the
          // provider limit never waits on a slot its own old sprite holds (DI-15.14).
          if (input.previous !== null) {
            const previous = input.previous;
            const destroyed = await release(dependencies, previous.spriteId, previous.adapter, () =>
              dependencies.sandbox.destroy({
                id: previous.spriteId,
                adapter: previous.adapter,
                workspacePath: previous.workspacePath,
              }),
            );
            if (destroyed) metrics.sandboxesDestroyed.inc({ adapter: previous.adapter, reason: "SUPERSEDED" });
          }

          let applied: VerifiedPatch | null = null;
          const prepared = await build(dependencies, input, async (ref, primaryPath) => {
            await applyPatch(patchDependencies, {
              ref,
              primaryPath,
              baseSha: input.work.baseSha,
              patchBase64: captured.patchBase64,
            });
            applied = await capturePatch(patchDependencies, { ref, primaryPath, baseSha: input.work.baseSha });
            if (applied.patchSha256 !== captured.patchSha256) {
              throw new PatchError(
                `the check sprite holds patch ${applied.patchSha256}, and the work sprite holds patch ` +
                  `${captured.patchSha256}. Factoree checks only the patch it captured.`,
              );
            }
          });
          const recaptured = applied as VerifiedPatch | null;
          if (recaptured === null || prepared.checkout.primary.baseSha !== input.work.baseSha) {
            await release(dependencies, prepared.ref.id, prepared.ref.adapter, () =>
              dependencies.sandboxManager.release(prepared),
            );
            throw new PatchError("the check sprite did not check out the base SHA of the work sprite");
          }

          metrics.sandboxesCreated.inc({
            tenant_id: input.tenantId,
            product_id: input.productId,
            adapter: prepared.ref.adapter,
          });
          dependencies.logger.info("check sandbox prepared", {
            tenant_id: input.tenantId,
            product_id: input.productId,
            run_id: input.runId,
            sprite_id: prepared.ref.id,
            work_sprite_id: input.work.spriteId,
            attempt: input.attempt,
            patch_sha256: captured.patchSha256,
            step: "prepare_check",
          });

          // docs/specs/work-item-images-and-links.md. The images reach every check sprite.
          const imageFiles = await deliverCheckSpriteImages(dependencies, input, prepared.ref);

          return {
            ...toOutput(prepared),
            imageFiles,
            patchSha256: captured.patchSha256,
            treeSha: recaptured.treeSha,
            changedFiles: captured.changedFiles,
            checkDefiningFiles: checkDefiningFilesOf(captured.changedFiles),
          };
        },
        (output) => output.spriteId,
      );
    } catch (error) {
      if (error instanceof Error) {
        error.message = dependencies.redactor.redactText(error.message);
        if (error.stack !== undefined) error.stack = dependencies.redactor.redactText(error.stack);
      }
      throw error;
    }
  },

  /** docs/specs/check-isolation.md. Deletes the last check sprite when the Run ends. */
  async releaseCheckSandbox(input: {
    runId: string;
    spriteId: string;
    adapter: string;
    workspacePath: string;
  }): Promise<void> {
    const destroyed = await release(dependencies, input.spriteId, input.adapter, () =>
      dependencies.sandbox.destroy({
        id: input.spriteId,
        adapter: input.adapter,
        workspacePath: input.workspacePath,
      }),
    );
    if (destroyed) metrics.sandboxesDestroyed.inc({ adapter: input.adapter, reason: "RUN_COMPLETE" });
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
