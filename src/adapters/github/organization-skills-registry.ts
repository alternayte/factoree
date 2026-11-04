import type { RepositorySpec } from "~/domain/runs/checkout.js";
import {
  SKILL_DIRECTORIES,
} from "~/domain/runs/skill-discovery.js";
import type {
  SkillDelivery,
  SkillProposal,
  SkillProposalReceipt,
  SkillRegistry,
} from "~/domain/runs/skill-registry.js";
import type { GitHubSkillProposals } from "./github-skill-proposals.js";

export interface OrganizationSkillsRegistryOptions {
  /** The organization skills repository, as `owner/repository`. */
  slug: string;
  /** The checkout the sandbox makes of it. */
  repository: RepositorySpec;
  githubInstallationId: string;
  proposals: GitHubSkillProposals;
}

/**
 * docs/specs/skill-registry.md. The organization skills repository of SDD section 16 as a skill
 * source. The sandbox checks it out, a Git repository stores no run signals, and a skill proposal
 * becomes a pull request that a person reviews.
 */
export class OrganizationSkillsRegistry implements SkillRegistry {
  readonly scope = "organization" as const;

  constructor(private readonly options: OrganizationSkillsRegistryOptions) {}

  resolve(): Promise<SkillDelivery> {
    return Promise.resolve({ kind: "checkout", repository: this.options.repository });
  }

  reportActivations(): Promise<void> {
    return Promise.resolve();
  }

  reportOutcome(): Promise<void> {
    return Promise.resolve();
  }

  async submit(proposal: SkillProposal): Promise<SkillProposalReceipt> {
    const directory = `${SKILL_DIRECTORIES[0]}/${proposal.name}`;
    const pull = await this.options.proposals.open({
      slug: this.options.slug,
      githubInstallationId: this.options.githubInstallationId,
      headBranch: `factoree/skill-proposal/${proposal.runId}/${proposal.name}`,
      title: `Skill proposal: ${proposal.name}`,
      body: [
        `Factoree run ${proposal.runId} proposes this skill. Review it before you merge.`,
        ...(proposal.runLink === null ? [] : ["", `Run: ${proposal.runLink}`]),
        "",
        "## Rationale",
        "",
        proposal.rationale,
      ].join("\n"),
      files: proposal.files.map((file) => ({ path: `${directory}/${file.path}`, content: file.content })),
    });
    return { state: "submitted", reference: String(pull.number), url: pull.url };
  }
}
