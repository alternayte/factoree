import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { RepositorySpec } from "~/domain/runs/checkout.js";
import type { RunSkillStore } from "~/domain/runs/run-skill.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import {
  MAX_PROPOSAL_FILE_BYTES,
  MAX_PROPOSAL_FILES,
  SKILL_PROPOSAL_RATIONALE_FILE,
  SKILL_PROPOSALS_DIRECTORY,
  SKILL_REGISTRY_KEY_SECRET,
  SkillRegistryError,
  type SkillProposal,
  type SkillProposalFile,
  type SkillRegistry,
  type SkillRegistrySettings,
  type SkillRunOutcome,
} from "~/domain/runs/skill-registry.js";

/** Builds the adapter of one registry kind. The key stays on the worker. */
export type SkillRegistryFactory = (settings: SkillRegistrySettings, key: string) => SkillRegistry;

/** Builds the organization skills repository source of one Product. */
export type OrganizationSkillsFactory = (input: {
  slug: string;
  repository: RepositorySpec;
  githubInstallationId: string;
}) => SkillRegistry;

export interface SkillSourceDependencies {
  secrets: SecretStore;
  redactor: Redactor;
  logger: Logger;
  skills?: RunSkillStore | undefined;
  registries?: SkillRegistryFactory | undefined;
  organizationSkills?: OrganizationSkillsFactory | undefined;
}

/** The skill sources of one run, from the values the workflow carries. */
export interface SkillSourcesInput {
  tenantId: string;
  productId: string;
  skillRegistry?: SkillRegistrySettings | null;
  organizationSkills?: { slug: string; repository: RepositorySpec } | null;
  githubInstallationId: string;
}

/**
 * docs/specs/skill-registry.md. The registry of the Product with its key from the secret store.
 * A registry with no key is a configuration fault, so the run ends `CONFIGURATION_INVALID`.
 */
export const registryOf = async (
  dependencies: SkillSourceDependencies,
  input: SkillSourcesInput,
): Promise<SkillRegistry | null> => {
  const settings = input.skillRegistry ?? null;
  if (settings === null || dependencies.registries === undefined) return null;
  const key = await dependencies.secrets.get(input.tenantId, input.productId, SKILL_REGISTRY_KEY_SECRET);
  if (key === null || key.trim() === "") {
    throw new RunConfigurationError(
      `the Product names a ${settings.kind} skill registry and holds no ${SKILL_REGISTRY_KEY_SECRET} secret`,
    );
  }
  dependencies.redactor.addSecret(key);
  return dependencies.registries(settings, key);
};

/** Every skill source of the run, in precedence order: registry, then organization. */
export const sourcesOf = async (
  dependencies: SkillSourceDependencies,
  input: SkillSourcesInput,
): Promise<SkillRegistry[]> => {
  const sources: SkillRegistry[] = [];
  const registry = await registryOf(dependencies, input);
  if (registry !== null) sources.push(registry);
  const organization = input.organizationSkills ?? null;
  if (organization !== null && dependencies.organizationSkills !== undefined && input.githubInstallationId !== "") {
    sources.push(
      dependencies.organizationSkills({
        slug: organization.slug,
        repository: organization.repository,
        githubInstallationId: input.githubInstallationId,
      }),
    );
  }
  return sources;
};

/** A registry fault that repeats on a retry ends the run as a configuration fault. */
export const asRunFault = (error: unknown): unknown =>
  error instanceof SkillRegistryError && error.deterministic ? new RunConfigurationError(error.message) : error;

/** Retries a signal call a few times. A signal is a statistic, so the last fault is only logged. */
const attempts = async (work: () => Promise<void>): Promise<string | null> => {
  let last: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await work();
      return null;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (error instanceof SkillRegistryError && error.deterministic) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  return last;
};

/**
 * docs/specs/skill-registry.md. A skill is activated when a tool call input of the session names
 * the absolute path of its `SKILL.md`, or a native skill tool names the skill.
 */
export const activatedPathsOf = (
  toolInputs: ReadonlyArray<string>,
  skills: ReadonlyArray<{ name: string; path: string }>,
): string[] =>
  skills
    .filter((skill) => {
      const directory = skill.path.replace(/\/SKILL\.md$/, "");
      const named = new RegExp(`"(?:name|skill)"\\s*:\\s*"${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
      return toolInputs.some((input) => input.includes(skill.path) || input.includes(`${directory}/`) || named.test(input));
    })
    .map((skill) => skill.path);

export interface SessionActivationInput extends SkillSourcesInput {
  runId: string;
  attempt: number;
  runner: string;
  toolInputs: ReadonlyArray<string>;
}

/**
 * docs/specs/skill-registry.md. Records which skills one implementer session loaded, and reports
 * the registry ones. A fault never fails the session.
 */
export const recordSessionActivations = async (
  dependencies: SkillSourceDependencies,
  input: SessionActivationInput,
): Promise<void> => {
  const fields = { tenant_id: input.tenantId, run_id: input.runId, attempt: input.attempt, step: "skill_activation" };
  try {
    if (dependencies.skills === undefined) return;
    const skills = await dependencies.skills.list(input.tenantId, input.runId);
    if (skills.length === 0) return;
    const activated = new Set(activatedPathsOf(input.toolInputs, skills));
    if (activated.size === 0) return;
    await dependencies.skills.markActivated(input.tenantId, input.runId, [...activated]);
    const reported = skills.filter((skill) => activated.has(skill.path) && skill.scope === "registry" && skill.version !== null);
    if (reported.length === 0) return;
    const registry = await registryOf(dependencies, input);
    if (registry === null) return;
    const resolution = await dependencies.skills.resolutionOf(input.tenantId, input.runId);
    const failure = await attempts(() =>
      registry.reportActivations({
        runId: input.runId,
        idempotencyKey: `run:${input.runId}:implementer:${input.attempt}`,
        runner: input.runner,
        role: "implementer",
        set: resolution?.set ?? null,
        resolutionId: resolution?.id ?? null,
        time: new Date(),
        skills: reported.map((skill) => ({ name: skill.name, version: skill.version ?? 0 })),
      }),
    );
    if (failure !== null) {
      dependencies.logger.warn("the skill registry did not take the activation report", { ...fields, error: failure });
    }
  } catch (error) {
    dependencies.logger.warn("the skill activations were not recorded", { ...fields, error: String(error) });
  }
};

/** A path segment of a proposal file. A name that could escape the directory is refused. */
const PROPOSAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROPOSAL_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Reads the proposals the implementer wrote under `.factoree/skill-proposals` in the work sprite.
 * Each file is text, and the redactor runs over it before it leaves the worker (SDD section 60).
 */
export const readSkillProposals = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  redactor: Redactor,
): Promise<Array<{ name: string; rationale: string; files: SkillProposalFile[] }>> => {
  const root = `${primaryPath}/${SKILL_PROPOSALS_DIRECTORY}`;
  const listing = await sandbox.exec(ref, {
    file: "sh",
    args: ["-c", 'cd -- "$0" 2>/dev/null || exit 0; find . -type f -size -' + `${MAX_PROPOSAL_FILE_BYTES + 1}c` + " | sort", root],
    cwd: "/",
  });
  if (listing.exitCode !== 0) return [];
  const byName = new Map<string, string[]>();
  for (const line of listing.stdout.split("\n")) {
    const path = line.trim().replace(/^\.\//, "");
    if (path === "" || !PROPOSAL_PATH.test(path) || path.split("/").includes("..")) continue;
    const [name, ...rest] = path.split("/");
    if (name === undefined || rest.length === 0 || !PROPOSAL_NAME.test(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), rest.join("/")]);
  }
  const proposals: Array<{ name: string; rationale: string; files: SkillProposalFile[] }> = [];
  for (const [name, paths] of byName) {
    if (!paths.includes("SKILL.md")) continue;
    let rationale = "";
    const files: SkillProposalFile[] = [];
    for (const path of paths.slice(0, MAX_PROPOSAL_FILES + 1)) {
      const read = await sandbox.exec(ref, { file: "cat", args: ["--", `${root}/${name}/${path}`], cwd: "/" });
      if (read.exitCode !== 0) continue;
      const content = redactor.redactText(read.stdout);
      if (path === SKILL_PROPOSAL_RATIONALE_FILE) rationale = content.trim();
      else if (files.length < MAX_PROPOSAL_FILES) files.push({ path, content });
    }
    proposals.push({ name, rationale: rationale === "" ? "The implementer gave no rationale." : rationale, files });
  }
  // docs/specs/skill-registry.md. One proposal per run.
  return proposals.slice(0, 1);
};

export interface SubmitSkillProposalsInput extends SkillSourcesInput {
  runId: string;
  runLink: string | null;
  work: { spriteId: string; adapter: string; workspacePath: string; primaryPath: string };
}

export interface SkillOutcomeInput extends SkillSourcesInput {
  runId: string;
  outcome: SkillRunOutcome;
  repairs: number;
  reviewVerdict: string | null;
  evidenceUrl: string | null;
}

export interface SkillRegistryActivityDependencies extends SkillSourceDependencies {
  sandbox: Sandbox;
}

export const createSkillRegistryActivities = (dependencies: SkillRegistryActivityDependencies) => ({
  /**
   * docs/specs/skill-registry.md. Sends the proposal the implementer wrote to the first skill
   * source of the Product. A refusal or a fault is recorded, and it never fails the run.
   */
  async submitSkillProposals(input: SubmitSkillProposalsInput): Promise<void> {
    const fields = { tenant_id: input.tenantId, run_id: input.runId, step: "skill_proposal" };
    if (dependencies.skills === undefined) return;
    try {
      const existing = await dependencies.skills.listProposals(input.tenantId, input.runId);
      if (existing.some((proposal) => proposal.state !== "failed")) return;
      const sources = await sourcesOf(dependencies, input);
      const source = sources[0];
      if (source === undefined) return;
      const ref = { id: input.work.spriteId, adapter: input.work.adapter, workspacePath: input.work.workspacePath };
      const drafts = await readSkillProposals(dependencies.sandbox, ref, input.work.primaryPath, dependencies.redactor);
      for (const draft of drafts) {
        const proposal: SkillProposal = { ...draft, runId: input.runId, runLink: input.runLink };
        let receipt;
        try {
          receipt = await source.submit(proposal);
        } catch (error) {
          dependencies.logger.warn("the skill proposal was not sent", { ...fields, error: String(error) });
          await dependencies.skills.recordProposal(input.tenantId, input.runId, {
            name: draft.name,
            source: source.scope,
            state: "failed",
            reference: null,
            url: null,
            reason: dependencies.redactor.redactText(error instanceof Error ? error.message : String(error)),
          });
          continue;
        }
        await dependencies.skills.recordProposal(input.tenantId, input.runId, {
          name: draft.name,
          source: source.scope,
          state: receipt.state,
          reference: receipt.state === "submitted" ? receipt.reference : null,
          url: receipt.state === "submitted" ? receipt.url : null,
          reason: receipt.state === "refused" ? receipt.reason : null,
        });
        dependencies.logger.info("the skill proposal was sent", { ...fields, proposal: draft.name, state: receipt.state });
      }
    } catch (error) {
      // The sprite can be gone, or the store can fail. A proposal is never evidence.
      dependencies.logger.warn("the skill proposals were not collected", { ...fields, error: String(error) });
    }
  },

  /** docs/specs/skill-registry.md. Reports how the run ended. A fault is logged, never raised. */
  async reportSkillOutcome(input: SkillOutcomeInput): Promise<void> {
    const fields = { tenant_id: input.tenantId, run_id: input.runId, step: "skill_outcome" };
    try {
      const registry = await registryOf(dependencies, input);
      if (registry === null || dependencies.skills === undefined) return;
      const resolution = await dependencies.skills.resolutionOf(input.tenantId, input.runId);
      // A run that ended before its sandbox loaded no registry skill, so it says nothing of one.
      if (resolution === null) return;
      const failure = await attempts(() =>
        registry.reportOutcome({
          runId: input.runId,
          outcome: input.outcome,
          repairs: input.repairs,
          reviewVerdict: input.reviewVerdict,
          evidenceUrl: input.evidenceUrl,
          set: resolution.set,
          resolutionId: resolution.id,
        }),
      );
      if (failure !== null) {
        dependencies.logger.warn("the skill registry did not take the run outcome", { ...fields, error: failure });
      }
    } catch (error) {
      dependencies.logger.warn("the run outcome was not reported", { ...fields, error: String(error) });
    }
  },
});
