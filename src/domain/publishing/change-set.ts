import { mergeOrderOf } from "../runs/merge-order.js";

/**
 * docs/specs/change-sets.md, slice 7. All-or-nothing publication of a change set: the text each
 * pull request carries about its siblings, and the comment that undoes a set that did not open.
 */

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** One pull request of a set that opened. */
export interface SetPullRequest {
  repository: string;
  url: string;
}

/**
 * DI-21.152. The change set section of one pull request body: every sibling pull request, and the
 * merge order of the cited edges. A cycle states that no safe order exists. No edge states that the
 * pull requests merge in any order.
 */
export const changeSetSection = (
  self: string,
  pullRequests: readonly SetPullRequest[],
  edges: ReadonlyArray<{ provider: string; consumer: string }>,
): string[] => {
  const order = mergeOrderOf(
    pullRequests.map((entry) => entry.repository),
    edges.map((edge) => ({ ...edge, file: "", line: 0 })),
  );
  const urlOf = (repository: string): string => pullRequests.find((entry) => same(entry.repository, repository))?.url ?? repository;
  const orderLines =
    order.kind === "ordered"
      ? [
          "Merge order (each provider before its consumers):",
          "",
          ...order.places.map((entry) => `${String(entry.place)}. ${entry.repository}: ${urlOf(entry.repository)}`),
          ...(order.places.length < pullRequests.length ? ["", "A pull request that is not in this list calls no other and is called by none, so it merges in any order."] : []),
        ]
      : order.kind === "cycle"
        ? [`No safe merge order exists: the calls between ${order.repositories.join(", ")} form a cycle. Merge them together by hand.`]
        : ["No repository of the set calls another, so the pull requests merge in any order."];
  return [
    "### Change set",
    "",
    `This pull request is one of ${String(pullRequests.length)} linked pull requests of one Factoree run. Read them together.`,
    "",
    ...pullRequests.filter((entry) => !same(entry.repository, self)).map((entry) => `- ${entry.repository}: ${entry.url}`),
    "",
    ...orderLines,
  ];
};

/** DI-21.152. The section a pull request of a set carries until every sibling has opened. */
export const changeSetPendingSection = (repositories: readonly string[]): string[] => [
  "### Change set",
  "",
  `This pull request is one of ${String(repositories.length)} linked pull requests of one Factoree run: ${repositories.join(", ")}. ` +
    "Factoree adds the link to each sibling pull request when all of them are open.",
];

/** DI-21.153. The comment that closes an opened pull request of a set whose publication failed. */
export const rollbackComment = (failedRepository: string, cause: string): string =>
  [
    `Factoree closed this pull request because the publication of ${failedRepository}, another repository of the same change set, failed: ${cause.replace(/[.\s]+$/, "")}.`,
    "",
    "A change set publishes all of its pull requests or none of them, so no half change stays open. Factoree deleted the branch. The run keeps the last patch of each repository for a follow-up run.",
  ].join("\n");

/**
 * docs/specs/change-sets.md, DI-21.154. The result of each target of a change set whose checks
 * failed after the repair budget: the verify commands (named `<owner/repo>: <name>`, DI-21.132),
 * the assertions it served, and the in-between check that failed for it. Empty for one target.
 */
export const targetResultsSentence = (
  targets: readonly string[],
  input: {
    verification?: ReadonlyArray<{ name: string; passed: boolean }>;
    validation?: ReadonlyArray<{ assertionId: string; result: string; target?: string }>;
    inBetweenFailed?: readonly string[];
  },
): string => {
  if (targets.length < 2) return "";
  const parts = targets.map((target) => {
    const failed = [
      ...(input.verification ?? []).filter((check) => !check.passed && check.name.toLowerCase().startsWith(`${target.toLowerCase()}: `)).map((check) => `\`${check.name}\` failed`),
      ...(input.validation ?? [])
        .filter((result) => result.result !== "PASS" && result.target !== undefined && same(result.target, target))
        .map((result) => `${result.assertionId} is ${result.result}`),
      ...((input.inBetweenFailed ?? []).some((consumer) => same(consumer, target)) ? ["the in-between check failed"] : []),
    ];
    return failed.length === 0 ? `${target} passed` : `${target}: ${failed.join(", ")}`;
  });
  return `Each target: ${parts.join("; ")}.`;
};
