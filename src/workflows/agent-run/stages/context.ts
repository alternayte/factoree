import type { ResolveContextActivityOutput } from "~/activities/context.activities.js";
import type { ConflictReport } from "~/domain/context/conflicts.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { buildRepositoryUrl } from "../../../domain/products/repository-url.js";
import { activities, buildContextActivities } from "../activities.js";
import { rethrowControl, type Run } from "../run.js";
import { isConfigurationFault, withCause } from "../failures.js";
import type { WorkItemFacts } from "./work-item.js";
import type { Refined } from "./refinement.js";
import type { RunTarget } from "./targets.js";

export type ResolvedContext = ResolveContextActivityOutput;
type RepositoryRef = { slug: string; url: string; ref: string };

/** One target at its pinned base SHA. The first is the primary repository. */
export interface TargetBase extends RunTarget {
  slug: string;
  sha: string;
}

interface ContextScope {
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  targetRepositories: Array<RepositoryRef & { githubInstallationId: string }>;
  supersedes?: string;
  conflictReports?: ConflictReport[];
}

export const defaultBranchOf = (run: Run, slug: string): string =>
  run.input.product.repositories.find((repository) => repository.fullName === slug)?.defaultBranch ?? "main";

/** SDD section 20. Discovery pins one SHA for each repository, from this ref. */
const repositoryRef = (run: Run, slug: string, ref = defaultBranchOf(run, slug)): RepositoryRef => ({
  slug,
  url: buildRepositoryUrl(run.input.product.repositoryBaseUrl, slug),
  ref,
});

/** The inputs every context resolution of the Run shares. */
export interface ContextSource {
  refined: Refined;
  workItem: WorkItemFacts;
  installationId: string;
}

/**
 * SDD sections 21 and 23. Resolves the context, and asks a human while a conflict has no authority
 * winner. The bounded rounds and the Run budget end the loop.
 */
const resolveContext = async (run: Run, source: ContextSource, scope: ContextScope): Promise<ResolvedContext> => {
  const { input } = run;
  const content = source.workItem.content;
  for (;;) {
    await run.ensureTime();
    await run.enter("RESOLVING_CONTEXT");
    let resolution: ResolvedContext;
    try {
      resolution = await buildContextActivities(run.remainingMs()).resolveContext({
        runId: run.id,
        tenantId: input.tenantId,
        productId: input.productId,
        goal: source.refined.goal,
        acceptanceCriteria: source.refined.acceptanceCriteria,
        primaryRepository: scope.primaryRepository,
        referenceRepositories: scope.referenceRepositories,
        ...(scope.targetRepositories.length > 0 ? { targetRepositories: scope.targetRepositories } : {}),
        ...(scope.supersedes === undefined ? {} : { supersedes: scope.supersedes }),
        ...(scope.conflictReports === undefined ? {} : { conflictReports: scope.conflictReports }),
        workItemReferences: source.refined.workItemReferences,
        decisions: run.decisions,
        githubInstallationId: source.installationId,
        ...(content === null
          ? {}
          : {
              workItemContent: {
                comments: content.comments,
                images: content.images,
                links: content.links,
                skippedImages: content.skippedImages,
                linksNotRead: content.linksNotRead,
              },
            }),
      });
    } catch (error) {
      // SDD section 49. A repository reference that resolves to nothing is a semantic failure. A
      // transport fault is not this type, so it stays an error.
      rethrowControl(error);
      if (!isConfigurationFault(error)) throw error;
      return await run.fail(
        "CONFIGURATION_INVALID",
        withCause(
          "Factoree could not resolve the context, because the Run configuration is invalid. " +
            "Repair the repository reference, the reference repositories, or the default branch.",
          error,
        ),
      );
    }
    // SDD section 21. A resolution that still holds an unresolved conflict stored nothing.
    run.control.contextContractVersion = resolution.unresolvedConflict === null ? resolution.sha256 : null;
    await run.progress(resolution.summary);
    const conflict = resolution.unresolvedConflict;
    if (conflict === null) return resolution;
    await run.ask(
      { id: conflict.id, question: conflict.question, subject: conflict.subject, domain: conflict.domain },
      {
        reason: "CONTEXT_UNRESOLVED",
        message: `Factoree could not start, because two equally authoritative sources disagree: ${conflict.question} Factoree published nothing.`,
      },
    );
  }
};

/**
 * The first resolution of the Run, each target at its default branch, or at the base the story
 * pins: a run on an open pull request reads its context at the verified base (D2, DI-21.159).
 */
export const resolveFirstContext = (
  run: Run,
  source: ContextSource,
  targets: RunTarget[],
  pinnedBaseOf: ((slug: string, primary: boolean) => string | null) | null,
): Promise<ResolvedContext> => {
  const refOf = (slug: string, primary: boolean) => repositoryRef(run, slug, pinnedBaseOf?.(slug, primary) ?? defaultBranchOf(run, slug));
  const [primary, ...others] = targets;
  return resolveContext(run, source, {
    primaryRepository: refOf(primary?.fullName ?? "", true),
    referenceRepositories: source.refined.referenceRepositories.map((slug) => repositoryRef(run, slug)),
    targetRepositories: others.map((target) => ({ ...refOf(target.fullName, false), githubInstallationId: target.githubInstallationId })),
  });
};

/**
 * A new resolution of the same repositories at the SHAs the Run pinned, which supersedes the last
 * one: for a target the refiner added (DI-21.143), or for the conflicts the refiner cited.
 */
export const resolveContextAgain = (
  run: Run,
  source: ContextSource,
  context: ResolvedContext,
  bases: TargetBase[],
  conflictReports?: ConflictReport[],
): Promise<ResolvedContext> =>
  resolveContext(run, source, {
    primaryRepository: repositoryRef(run, context.primary.slug, context.primary.sha),
    referenceRepositories: context.references.map((reference) => repositoryRef(run, reference.slug, reference.sha)),
    targetRepositories: bases.slice(1).map((target) => ({ ...repositoryRef(run, target.slug, target.sha), githubInstallationId: target.githubInstallationId })),
    supersedes: context.sha256,
    ...(conflictReports === undefined ? {} : { conflictReports }),
  });

/** Specification section 8. The base commit is the ground truth: it must name the Product routing used. */
export const verifyIdentity = async (run: Run, target: { slug: string; sha: string; githubInstallationId: string }): Promise<void> => {
  const identity = await activities.verifyTargetIdentity({
    runId: run.id,
    tenantId: run.input.tenantId,
    productId: run.input.productId,
    productSlug: run.input.product.productSlug,
    repositoryUrl: buildRepositoryUrl(run.input.product.repositoryBaseUrl, target.slug),
    baseSha: target.sha,
    githubInstallationId: target.githubInstallationId,
  });
  if (run.stopped) await run.cancel();
  if (!identity.matched) await run.routingMismatch(identity.declaredProduct ?? "an unknown Product");
};

/**
 * Pins each target at the SHA the context resolved, checks its identity in set order, and records
 * its base SHA (specification section 14).
 */
export const pinTargetBases = async (run: Run, context: ResolvedContext, targets: RunTarget[]): Promise<TargetBase[]> => {
  const bases = targets.map((target, index) => ({
    ...target,
    slug: index === 0 ? context.primary.slug : target.fullName,
    sha: index === 0 ? context.primary.sha : (context.targets?.find((pinned) => pinned.slug === target.fullName)?.sha ?? ""),
  }));
  for (const base of bases) await verifyIdentity(run, base);
  for (const base of bases) {
    await activities.recordRunTargetFacts({ tenantId: run.input.tenantId, runId: run.id, repositoryId: base.id, baseSha: base.sha });
  }
  return bases;
};
