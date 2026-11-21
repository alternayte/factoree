import { deprecatePatch } from "@temporalio/workflow";
import type { Activities } from "~/activities/index.js";
import type { PrepareSandboxActivityOutput } from "~/activities/sandbox.activities.js";
import type { AgentRunProductRepositoryInput } from "~/domain/runs/product-repository.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { buildRepositoryUrl } from "../../../domain/products/repository-url.js";
import { renderMissingHostsFailure, type MissingHost } from "../../../domain/runs/egress.js";
import { buildSandboxActivities } from "../activities.js";
import { isSandboxProviderDown } from "../failures.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";
import { defaultBranchOf, type ResolvedContext, type TargetBase } from "./context.js";
import type { WorkItemFacts } from "./work-item.js";
import { isMember } from "../../../domain/products/membership.js";

export type PrepareInput = Parameters<Activities["prepareSandbox"]>[0];

/**
 * D2. The start point of the work sprite: the base SHA of each target, or, for a run on an open
 * pull request, the verified base with the diff to the head the run read. The overlay applies to
 * whatever the prepare input holds, so a rebuilt sandbox keeps it.
 */
export type StartPoint = (base: PrepareInput) => PrepareInput;

/** The input of each target of a change set at its base, or nothing for one target. */
export const targetsInput = (run: Run, bases: TargetBase[]): Pick<PrepareInput, "targets"> =>
  bases.length > 1
    ? {
        targets: bases.map((target) => ({
          repository: target.slug,
          url: buildRepositoryUrl(run.input.product.repositoryBaseUrl, target.slug),
          ref: target.sha,
          githubInstallationId: target.githubInstallationId,
        })),
      }
    : {};

/**
 * The work sprite of the Run and the input every sprite of the Run is prepared from. A target the
 * refiner adds joins the input, and the work sprite prepares again (DI-21.140).
 */
export class Workspace {
  /** docs/specs/change-sets.md, DI-21.138. The other present repositories a refiner may add. */
  readonly siblings: AgentRunProductRepositoryInput[];

  constructor(
    private readonly run: Run,
    public prepareInput: PrepareInput,
    public prepared: PrepareSandboxActivityOutput | null,
    private readonly startPoint: StartPoint,
    readonly targetsOpen: boolean,
    readonly bases: TargetBase[],
    readonly goal: string,
  ) {
    this.siblings = targetsOpen
      ? run.input.product.repositories.filter(
          (repository) =>
            isMember(repository) && !bases.some((target) => target.slug.toLowerCase() === repository.fullName.toLowerCase()),
        )
      : [];
  }

  get work(): PrepareSandboxActivityOutput {
    if (this.prepared === null) throw new Error("the work sprite is not prepared");
    return this.prepared;
  }

  /** The work sprite input: the start point, and the siblings a refiner may read. */
  workInput(withSiblings: boolean): PrepareInput {
    const input = this.startPoint(this.prepareInput);
    return withSiblings && this.siblings.length > 0
      ? { ...input, siblings: { repositoryBaseUrl: this.run.input.product.repositoryBaseUrl, repositories: this.siblings } }
      : input;
  }

  /**
   * SDD section 32. Prepares the work sprite. docs/specs/sandbox-provider-spillover.md: the run
   * picks its provider and holds its slots there. A provider that fails the create is marked down,
   * and the run selects again. With no provider that has room, `withSandboxSlot` waits.
   */
  async prepare(input: PrepareInput): Promise<PrepareSandboxActivityOutput> {
    const run = this.run;
    try {
      const work = await run.withSandboxSlot(async (budgetMs) => {
        deprecatePatch(PATCH.sandboxProvider);
        for (;;) {
          await buildSandboxActivities(Math.max(1, Math.min(budgetMs, run.remainingMs()))).selectSandboxProvider({
            runId: run.id,
            tenantId: run.input.tenantId,
            productId: run.input.productId,
            repositoryUrl: this.prepareInput.primary.url,
            ...(this.bases.length > 1
              ? { targetRepositoryUrls: this.bases.slice(1).map((target) => buildRepositoryUrl(run.input.product.repositoryBaseUrl, target.slug)) }
              : {}),
          });
          try {
            return await buildSandboxActivities(Math.max(1, Math.min(budgetMs, run.remainingMs()))).prepareSandbox(input);
          } catch (error) {
            if (!isSandboxProviderDown(error)) throw error;
          }
        }
      });
      this.prepared = await run.required(work);
    } catch (error) {
      await run.failFrom(
        error,
        "Factoree could not prepare the sandbox, because the Run configuration is invalid. " +
          "Repair the repository reference, the reference repositories, or the bootstrap command.",
      );
    }
    run.control.workSprite = this.prepared;
    return this.work;
  }

  /**
   * docs/specs/egress-honesty-and-issue-status.md, DI-21.48. A host the work needs and the allow
   * list lacks ends the Run FAILED_CONFIGURATION, and the post names each host and where to add it.
   */
  failMissingHosts(role: "refiner" | "implementer", hosts: MissingHost[], repositorySlug: string): Promise<never> {
    return this.run.fail(
      "CONFIGURATION_INVALID",
      renderMissingHostsFailure({
        role,
        hosts,
        productSlug: this.run.input.product.productSlug,
        productPageUrl: this.run.input.product.productPageUrl ?? null,
        repositorySlug,
        repositoryListDeclared: this.work.runtime.sandboxAllowListDeclared === true,
      }),
    );
  }
}

/**
 * DI-15.13 and SDD section 15. Waits for a run slot, then prepares the work sprite from the
 * context the Run froze: each target at its pinned SHA, the reference repositories, the delivered
 * context and the work item images. The repository config owns everything else.
 */
export const prepareWorkspace = async (
  run: Run,
  plan: { context: ResolvedContext; bases: TargetBase[]; workItem: WorkItemFacts; goal: string; startPoint: StartPoint; targetsOpen: boolean },
): Promise<Workspace> => {
  const { input } = run;
  const { context, workItem } = plan;
  const primary = plan.bases[0];
  if (primary === undefined) throw new Error("the Run has no target");
  const organizationSkills =
    input.product.organizationSkillsRepository === null
      ? null
      : {
          url: buildRepositoryUrl(input.product.repositoryBaseUrl, input.product.organizationSkillsRepository),
          // No discovery step resolves a skills repository, so the default branch of the primary
          // repository is the only defined ref. See DI-11.3.
          ref: defaultBranchOf(run, primary.fullName),
        };
  await run.waitForRunSlot();
  await run.enter("PREPARING");
  const prepareInput: PrepareInput = {
    runId: run.id,
    tenantId: input.tenantId,
    productId: input.productId,
    // SDD section 20. The checkout lands on the SHA discovery pinned, never on a branch name.
    primary: { url: buildRepositoryUrl(input.product.repositoryBaseUrl, context.primary.slug), ref: context.primary.sha },
    ...targetsInput(run, plan.bases),
    references: context.references.map((repository) => ({ url: buildRepositoryUrl(input.product.repositoryBaseUrl, repository.slug), ref: repository.sha })),
    defaults: { stagingRead: input.product.stagingRead, spriteRetentionHours: input.product.spriteRetentionHours, allowedDomains: input.product.allowedDomains },
    environment: {},
    organizationSkills,
    githubInstallationId: primary.githubInstallationId,
    skillRegistry: input.product.skillRegistry ?? null,
    // docs/specs/external-context-delivery.md. The work sprite fetches the external context items.
    ...(context.deliveryRefs === undefined ? {} : { contextRefs: context.deliveryRefs }),
    // docs/specs/work-item-images-and-links.md. Every sprite receives the frozen images.
    ...(workItem.content === null
      ? {}
      : { workItemImages: workItem.content.images, workItemComments: workItem.content.comments, workItemLinks: workItem.content.links }),
  };
  const workspace = new Workspace(run, prepareInput, null, plan.startPoint, plan.targetsOpen, plan.bases, plan.goal);
  await workspace.prepare(workspace.workInput(true));
  // docs/specs/skill-registry.md. A Product with no skill source sends no signal and no proposal.
  if ((input.product.skillRegistry ?? null) !== null || organizationSkills !== null) {
    run.skillSources = {
      skillRegistry: input.product.skillRegistry ?? null,
      organizationSkills:
        input.product.organizationSkillsRepository === null || organizationSkills === null
          ? null
          : { slug: input.product.organizationSkillsRepository, repository: organizationSkills },
      githubInstallationId: primary.githubInstallationId,
    };
  }
  await run.checkpoint();
  return workspace;
};
