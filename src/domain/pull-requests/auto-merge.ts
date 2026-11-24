import type { AutoMergeState } from "./pull-request-store.js";
import type { ReviewAppHold } from "./review-apps.js";

/**
 * docs/specs/pr-review-merge-and-deploy.md. The L4 merge: Factoree turns on GitHub auto-merge when
 * every condition of the spec holds for the head, and the repository ruleset decides the merge.
 * This module holds the decisions. `AutoMergePort` is the GitHub boundary.
 */

export type MergeMethod = "squash" | "merge" | "rebase";

/** The merge settings of one repository. Null means GitHub did not answer the setting. */
export interface RepositoryMergeSettings {
  allowAutoMerge: boolean | null;
  allowSquash: boolean;
  allowMergeCommit: boolean;
  allowRebase: boolean;
}

/** What the L4 gate reads when the pull request opens (D5). */
export interface AutoMergeGate {
  settings: RepositoryMergeSettings;
  /**
   * The merge requirements of the base branch: the type of each active ruleset rule that gates a
   * merge, and `branch_protection` for a classic protection rule.
   */
  baseRequirements: string[];
  /**
   * DI-21.115. True when an active ruleset rule of the base branch requires the branch to be up to
   * date before the merge: `required_status_checks` with the strict policy. A classic protection
   * rule shows this only to Administration read, so GitHub's `behind` state stands for it.
   */
  requiresUpToDate: boolean;
}

/** The pull request as GitHub answers it now. */
export interface PullRequestOnGitHub {
  nodeId: string;
  headSha: string;
  open: boolean;
  draft: boolean;
  /** GitHub's mergeable state, such as clean, blocked, behind, dirty or unknown. */
  mergeableState: string | null;
  /** False when the branch conflicts with its base. Null while GitHub computes it. */
  mergeable: boolean | null;
  /** True while auto-merge is on, whoever turned it on. */
  autoMergeEnabled: boolean;
  baseBranch: string;
}

/** One pull request review, as GitHub lists it, oldest first. */
export interface ReviewOnGitHub {
  reviewerLogin: string;
  /** GitHub's upper-case review state: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
}

/**
 * docs/specs/pr-feedback-loop.md, DI-21.212. The "Needs your attention" post for an L4 head that review
 * apps hold back once Factoree has nothing left to act on.
 */
export const reviewAppHoldNotice = (url: string, holds: readonly ReviewAppHold[]): string =>
  [
    "### Needs your attention",
    "",
    `Factoree did not turn on auto-merge for ${url}, so it stays open as at L3:`,
    ...holds.map((hold) => `- ${reviewAppHoldLine(hold)}`),
    "",
    "Factoree has nothing left to act on for this head. A human decides now: mention Factoree with what to change, " +
      "override or re-run the review app, merge the pull request, or close it.",
  ].join("\n");

/** One sentence per hold, as the auto-merge reason and the "Needs your attention" post name it. */
export const reviewAppHoldLine = (hold: ReviewAppHold): string =>
  hold.reason === "pending"
    ? `The review app ${hold.appSlug} still reviews the head commit.`
    : hold.reason === "not_passed"
      ? `The check of the review app ${hold.appSlug} did not pass on the head commit.`
      : `The review app ${hold.appSlug} has an open review thread that Factoree did not answer.`;

/** The outcome of an auto-merge request. clean: GitHub can merge now, so it refuses auto-merge. */
export type EnableAutoMergeOutcome = { kind: "enabled" } | { kind: "clean" } | { kind: "refused"; message: string };

export type MergeOutcome = { kind: "merged" } | { kind: "refused"; message: string };

/**
 * The GitHub calls of the L4 merge. Every call mints its own installation token for the one
 * repository, on the control plane only.
 */
export interface AutoMergePort {
  pullRequest(slug: string, number: number, installationId: string): Promise<PullRequestOnGitHub>;
  gate(slug: string, baseBranch: string, installationId: string): Promise<AutoMergeGate>;
  reviews(slug: string, number: number, installationId: string): Promise<ReviewOnGitHub[]>;
  enable(slug: string, pullRequest: PullRequestOnGitHub, method: MergeMethod, installationId: string): Promise<EnableAutoMergeOutcome>;
  disable(slug: string, pullRequest: PullRequestOnGitHub, installationId: string): Promise<void>;
  /** DI-21.115. The number of commits of the base branch that the head commit does not hold. */
  behindBy(slug: string, baseBranch: string, headSha: string, installationId: string): Promise<number>;
  /** Merges the pull request only while its head is `sha`. */
  merge(slug: string, number: number, sha: string, method: MergeMethod, installationId: string): Promise<MergeOutcome>;
}

/**
 * DI-21.106. The ruleset rule types that hold a merge back until something passes or a human acts.
 * A rule such as `deletion` or `non_fast_forward` gates no merge, so it does not count.
 */
export const MERGE_GATING_RULES: readonly string[] = [
  "pull_request",
  "required_status_checks",
  "required_deployments",
  "required_signatures",
  "code_scanning",
  "workflows",
  "merge_queue",
];

/** A classic branch protection rule on the base branch. */
export const BRANCH_PROTECTION = "branch_protection";

/**
 * Squash when the repository allows it. Otherwise the first method that the repository settings
 * list: merge commit, then rebase. Null when the repository allows none.
 */
export const mergeMethodOf = (settings: RepositoryMergeSettings): MergeMethod | null => {
  if (settings.allowSquash) return "squash";
  if (settings.allowMergeCommit) return "merge";
  if (settings.allowRebase) return "rebase";
  return null;
};

/**
 * D5. Each setting the L4 gate misses, as one sentence that names it. An empty list means that L4
 * takes effect on this pull request.
 */
export const gateGaps = (gate: AutoMergeGate, repositoryFullName: string, baseBranch: string): string[] => {
  const gaps: string[] = [];
  if (gate.settings.allowAutoMerge === null) {
    gaps.push(`Factoree could not read the "Allow auto-merge" setting of ${repositoryFullName}.`);
  } else if (!gate.settings.allowAutoMerge) {
    gaps.push(`${repositoryFullName} does not allow auto-merge. Turn on "Allow auto-merge" in the repository settings.`);
  }
  if (mergeMethodOf(gate.settings) === null) {
    gaps.push(`${repositoryFullName} allows no merge method. Allow squash merging in the repository settings.`);
  }
  if (gate.baseRequirements.length === 0) {
    gaps.push(
      `The base branch ${baseBranch} has no rule that gates a merge. Add a ruleset or a branch protection rule ` +
        "that requires a review or a status check.",
    );
  }
  return gaps;
};

/**
 * The logins whose newest review requests changes. A COMMENTED or PENDING review changes no
 * verdict. An APPROVED or DISMISSED review replaces the earlier verdict of the same reviewer.
 */
export const openChangeRequests = (reviews: readonly ReviewOnGitHub[]): string[] => {
  const verdicts = new Map<string, string>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED") verdicts.set(review.reviewerLogin, state);
  }
  return [...verdicts].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login).sort();
};

export interface AutoMergeConditionInput {
  /** The level of the run that published the verified head. */
  level: string | null;
  verifiedHeadSha: string | null;
  pullRequest: PullRequestOnGitHub;
  /** docs/specs/pr-feedback-loop.md, DI-21.212. The review apps that hold back the merge of the verified head. */
  reviewAppHolds: readonly ReviewAppHold[];
  changeRequests: readonly string[];
}

/**
 * docs/specs/pr-review-merge-and-deploy.md. Each auto-merge condition that does not hold for the
 * current head, as one sentence. An empty list means every condition holds.
 */
export const unmetConditions = (input: AutoMergeConditionInput): string[] => {
  const unmet: string[] = [];
  if (input.level !== "L4") unmet.push(`The run of this head ran at ${input.level ?? "an unknown level"}, not L4.`);
  if (!input.pullRequest.open) unmet.push("The pull request is not open.");
  if (input.pullRequest.draft) unmet.push("The pull request is a draft.");
  if (input.verifiedHeadSha === null || input.pullRequest.headSha !== input.verifiedHeadSha) {
    unmet.push(`Factoree did not verify the head commit ${input.pullRequest.headSha.slice(0, 12)}.`);
  }
  unmet.push(...input.reviewAppHolds.map(reviewAppHoldLine));
  if (input.changeRequests.length > 0) {
    unmet.push(`A "request changes" review is open from ${input.changeRequests.join(", ")}.`);
  }
  return unmet;
};

/** GitHub can merge a pull request in these states at once, so it refuses to turn on auto-merge. */
const MERGEABLE_NOW = new Set(["clean", "unstable", "has_hooks"]);

export type AutoMergeAction =
  | { kind: "enable" }
  | { kind: "merge" }
  | { kind: "disable"; reason: string }
  | { kind: "none"; reason: string | null };

/**
 * DI-21.105. What Factoree does with auto-merge now. Factoree turns off only an auto-merge that it
 * turned on, and it never turns auto-merge on again after a human turned it off. A pull request that
 * GitHub can merge at once merges, pinned to the head, because GitHub refuses auto-merge on it.
 */
export const decideAutoMerge = (input: {
  state: AutoMergeState;
  unmet: readonly string[];
  pullRequest: PullRequestOnGitHub;
}): AutoMergeAction => {
  if (input.unmet.length > 0) {
    const reason = input.unmet.join(" ");
    if (input.state === "enabled" && input.pullRequest.autoMergeEnabled) return { kind: "disable", reason };
    return { kind: "none", reason };
  }
  if (input.state === "stopped") return { kind: "none", reason: "A human turned off auto-merge on this pull request." };
  if (input.state === "unavailable") return { kind: "none", reason: null };
  // On already: Factoree turned it on, or a human did, and every condition holds.
  if (input.pullRequest.autoMergeEnabled) return { kind: "none", reason: null };
  if (input.pullRequest.mergeableState !== null && MERGEABLE_NOW.has(input.pullRequest.mergeableState)) return { kind: "merge" };
  return { kind: "enable" };
};

/**
 * docs/specs/pr-review-merge-and-deploy.md, slice 4. Why Factoree brings a pull request current:
 * GitHub reports a conflict, or the base branch requires the branch up to date before an L4 merge.
 */
export type BringCurrentReason = "conflict" | "up_to_date";

/** DI-21.115. What GitHub's merge state says about a conflict with the base. */
export type Mergeability = "conflict" | "clean" | "unknown";

/**
 * DI-21.115. GitHub reports a conflict as `mergeable: false` or the state `dirty`. A null mergeable
 * with an `unknown` state means that GitHub still computes it.
 */
export const mergeabilityOf = (pullRequest: { mergeable: boolean | null; mergeableState: string | null }): Mergeability => {
  if (pullRequest.mergeable === false || pullRequest.mergeableState === "dirty") return "conflict";
  if (pullRequest.mergeable === null && (pullRequest.mergeableState === null || pullRequest.mergeableState === "unknown")) return "unknown";
  return "clean";
};
