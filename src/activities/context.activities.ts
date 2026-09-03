import { createHash } from "node:crypto";
import type { Logger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextResolver } from "~/domain/context/context-resolver.js";
import type { ContextContractStore } from "~/domain/context/context-contract-store.js";
import type { RepositoryRef } from "~/domain/context/context-source.js";
import type { ContextSourceProvider } from "~/domain/context/context-source-provider.js";
import { readRepositoryContextConfiguration } from "~/domain/context/repository-context-configuration.js";
import type { AuthorityDomain } from "~/domain/context/authority.js";
import { conflictQuestion } from "~/domain/context/conflicts.js";
import { requiredContextLines } from "~/domain/context/context-contract.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { loadRepositoryReadToken } from "~/domain/projects/runner-credentials.js";
import { FACTOREE_CONFIG_PATH, parseFactoreeConfig } from "~/domain/products/factoree-config.js";

export interface ResolveContextActivityInput {
  runId: string;
  tenantId: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  workItemReferences: string[];
  decisions: RecordedDecision[];
}

export interface ResolveContextActivityOutput {
  sha256: string;
  document: string;
  /** SDD section 21. Only a required item enters the initial role context. */
  requiredContext: string[];
  primary: { slug: string; sha: string };
  references: Array<{ slug: string; sha: string }>;
  /** SDD section 23. A non-null value means implementation must not start. */
  unresolvedConflict: {
    id: string;
    subject: string;
    /** SDD section 22. The authority domain of the pair. The answer settles this domain only. */
    domain: AuthorityDomain;
    question: string;
  } | null;
  conflictCount: number;
  /** The line Factoree posts to Linear. It is the Phase 4 exit condition in one sentence. */
  summary: string;
}

export interface ContextActivityDependencies {
  resolver: ContextResolver;
  contracts: ContextContractStore;
  runs: RunRepository;
  logger: Logger;
  sources: ContextSourceProvider;
  repositoryReader: RepositoryReader;
  secrets: SecretStore;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * Specification section 8. The cached routing table can drift from the file at the commit a Run
 * actually builds from. This input names the repository, the base commit, and the routed
 * Product.
 */
export interface VerifyTargetIdentityActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  /** The Product slug delegation routed this Run to. */
  productSlug: string;
  repositoryUrl: string;
  baseSha: string;
}

export interface VerifyTargetIdentityActivityOutput {
  /** The SHA-256 of the file content, or null when the target carries no config file. */
  configSha: string | null;
  /** True when the file agrees with routing, or carries no claim to check. */
  matched: boolean;
  /** The Product slug the file declares, or null when it carries no file. */
  declaredProduct: string | null;
}

/** A human reads the summary in Linear, so the noun agrees with the count. */
const count = (total: number, singular: string, plural: string): string =>
  `${total} ${total === 1 ? singular : plural}`;

/** SDD section 63 names this file. */
export const createContextActivities = (dependencies: ContextActivityDependencies) => ({
  async resolveContext(input: ResolveContextActivityInput): Promise<ResolveContextActivityOutput> {
    const started = Date.now();
    const labels = { tenant_id: input.tenantId, project_id: input.projectId };

    // SDD section 30. Discovery reads the repository on the worker, before a sandbox exists, so a
    // private repository needs the read-only credential here as well as in the checkout. The
    // credential is set per Run, because a Project can rotate its token between two Runs.
    const repositoryCredential = await loadRepositoryReadToken(
      dependencies.secrets,
      input.tenantId,
      input.projectId,
    );
    if (repositoryCredential !== null) {
      try {
        dependencies.repositoryReader.useCredential(
          new URL(input.primaryRepository.url).origin,
          repositoryCredential,
        );
      } catch {
        // A local path carries no origin, and it needs no credential either.
      }
    }

    // SDD section 15 and controller decision 2. The `context` block governs discovery, and
    // discovery runs before the sandbox exists, so the file is read at the pinned primary SHA.
    const contextConfiguration = await readRepositoryContextConfiguration(
      dependencies.repositoryReader,
      input.primaryRepository.url,
      input.primaryRepository.ref,
    );
    const sources = await dependencies.sources.sourcesFor({
      tenantId: input.tenantId,
      projectId: input.projectId,
      contextConfiguration,
    });

    const resolved = await dependencies.resolver.resolve({
      runId: input.runId,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      primaryRepository: input.primaryRepository,
      referenceRepositories: input.referenceRepositories,
      workItemReferences: input.workItemReferences,
      decisions: input.decisions,
      sources,
      contextConfiguration,
    });

    // SDD section 21 freezes the Context Contract. SDD section 23 forbids a start of
    // implementation while a conflict is unresolved. A contract that still holds an unresolved
    // conflict is therefore not the contract of this Run, so Factoree does not freeze it. Only
    // the resolution a human settled reaches the store, and it reaches the store one time. The
    // store is idempotent, so an activity retry returns the frozen contract.
    // A retry finds the contract already frozen. The activity reads it first, so it can tell a
    // first freeze from a repeat and count each conflict one time only.
    const existing =
      resolved.unresolvedConflict === null
        ? await dependencies.contracts.findByRun(input.tenantId, input.runId)
        : null;

    const stored =
      resolved.unresolvedConflict === null
        ? (existing ??
          (await dependencies.contracts.save({
            tenantId: input.tenantId,
            runId: input.runId,
            contract: resolved.contract,
            sha256: resolved.sha256,
            document: resolved.document,
          })))
        : null;

    const froze = stored !== null && existing === null;

    if (stored !== null) {
      await dependencies.runs.setContextContractVersion(input.tenantId, input.runId, stored.sha256);
    }

    // A Temporal workflow must stay deterministic, so the metric belongs here.
    metrics.contextResolutionDuration.observe(labels, (Date.now() - started) / 1000);
    // A conflict counts once it reaches a frozen contract, so a retry cannot inflate the counter.
    // SDD section 62 names the metric for a conflict recorded on a Context Contract, and an
    // unfrozen resolution records none.
    if (froze) {
      for (const conflict of resolved.contract.conflicts) {
        metrics.contextConflicts.inc({ ...labels, resolution: conflict.resolution });
      }
    }

    dependencies.logger.info("context resolved", {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      run_id: input.runId,
      step: "resolve_context",
      context_contract_version: stored?.sha256 ?? null,
      frozen: stored !== null,
    });

    const repositories = [
      `${resolved.pinned.primary.slug}@${shortSha(resolved.pinned.primary.sha)}`,
      ...resolved.pinned.references.map(
        (repository) => `${repository.slug}@${shortSha(repository.sha)}`,
      ),
    ].join(", ");

    const required = resolved.contract.items.filter((item) => item.classification === "required");

    // The stored contract wins, so a retry after a successful write reports the frozen values.
    const sha256 = stored?.sha256 ?? resolved.sha256;
    const document = stored?.document ?? resolved.document;

    const outcome =
      stored === null
        ? `Factoree did not freeze this Context Contract, because one conflict is unresolved. ` +
          `Draft Context Contract ${shortSha(sha256)}.`
        : `Context Contract ${shortSha(sha256)}.`;

    // Nothing reached the store on the draft path, so the summary must not claim a record.
    const conflictVerb = stored === null ? "found" : "recorded";

    const summary =
      `Factoree resolved the context of this Run. Repositories: ${repositories}. ` +
      `${count(resolved.contract.items.length, "context item", "context items")}, ` +
      `${required.length} of them preloaded. ` +
      `${count(resolved.contract.conflicts.length, "conflict", "conflicts")} ${conflictVerb}. ${outcome}`;

    return {
      sha256,
      document,
      requiredContext: requiredContextLines(resolved.contract),
      primary: resolved.pinned.primary,
      references: resolved.pinned.references,
      unresolvedConflict:
        resolved.unresolvedConflict === null
          ? null
          : {
              id: resolved.unresolvedConflict.id,
              subject: resolved.unresolvedConflict.subject,
              domain: resolved.unresolvedConflict.authorityDomain,
              question: conflictQuestion(resolved.unresolvedConflict),
            },
      conflictCount: resolved.contract.conflicts.length,
      summary,
    };
  },

  /**
   * Specification section 8. Reads `.factoree/config.yaml` from the target repository, at the
   * Run's base commit. It records the file's SHA-256 on the Run. It reports whether the
   * identity block agrees with the Product routing used.
   */
  async verifyTargetIdentity(
    input: VerifyTargetIdentityActivityInput,
  ): Promise<VerifyTargetIdentityActivityOutput> {
    const repositoryCredential = await loadRepositoryReadToken(
      dependencies.secrets,
      input.tenantId,
      input.productId,
    );
    if (repositoryCredential !== null) {
      try {
        dependencies.repositoryReader.useCredential(new URL(input.repositoryUrl).origin, repositoryCredential);
      } catch {
        // A local path carries no origin, and it needs no credential either.
      }
    }

    const text = await dependencies.repositoryReader.readBlob(
      input.repositoryUrl,
      input.baseSha,
      FACTOREE_CONFIG_PATH,
    );

    // A repository that carries no file, or an unparsable file, makes no claim about its
    // Product. Section 15 already enforces the file's validity elsewhere, so this check only
    // compares a claim it can read.
    if (text === null) {
      return { configSha: null, matched: true, declaredProduct: null };
    }

    const configSha = createHash("sha256").update(text, "utf8").digest("hex");
    await dependencies.runs.setConfigSha(input.tenantId, input.runId, configSha);

    let declaredProduct: string | null;
    try {
      declaredProduct = parseFactoreeConfig(text).identity.product;
    } catch {
      return { configSha, matched: true, declaredProduct: null };
    }

    dependencies.logger.info("target identity checked", {
      tenant_id: input.tenantId,
      run_id: input.runId,
      step: "verify_target_identity",
      matched: declaredProduct === input.productSlug,
    });

    return { configSha, matched: declaredProduct === input.productSlug, declaredProduct };
  },
});
