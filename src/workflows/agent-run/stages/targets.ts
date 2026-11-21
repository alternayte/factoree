import { ApplicationFailure, deprecatePatch } from "@temporalio/workflow";
import type { RepositoryRecord } from "~/domain/products/repository-registry.js";
// The workflow bundler resolves a relative path only, so value imports do not use the `~/` alias.
import { inSetOrder, matchReplyToCandidates, namedNonMembers, proposeTargets, selectTargets, type TargetSetOutcome } from "../../../domain/routing/select-targets.js";
import { awaitsAcceptance, isMember } from "../../../domain/products/membership.js";
import { activities } from "../activities.js";
import { PATCH } from "../patches.js";
import type { Run } from "../run.js";

/** docs/specs/change-sets.md. One repository the Run changes. The first target is the primary repository. */
export interface RunTarget {
  id: string;
  fullName: string;
  githubInstallationId: string;
}

/**
 * How a story picks its targets. A new run chooses from the product, or takes the set of the run
 * it follows (DI-21.131). A run on an open pull request changes the repository of that pull
 * request, or every member of its change set (DI-21.159).
 */
export type TargetRule =
  | { kind: "choose"; followUpTargets: string[]; linearProject: string | null }
  | {
      kind: "pullRequest";
      repositoryId: string;
      repositoryFullName: string;
      url: string;
      setMembers: Array<{ repositoryId: string; repositoryFullName: string; url: string }> | null;
    };

const EPOCH = new Date(0);

/** The product repositories as routing records. A constant epoch fills the fields selection does not read. */
const presentRepositoriesOf = (run: Run): RepositoryRecord[] =>
  run.input.product.repositories.map((repository) => ({
    id: repository.id,
    tenantId: run.input.tenantId,
    productId: run.input.product.productId,
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    configSha: "",
    requestedSecretNames: [],
    linearProjects: repository.linearProjects,
    discoveredAt: EPOCH,
    lastSeenAt: EPOCH,
    absentSince: repository.absentSince === null ? null : new Date(repository.absentSince),
    githubInstallationId: repository.githubInstallationId,
    membership: repository.membership ?? "accepted",
    membershipDecidedBy: null,
    membershipDecidedAt: null,
  }));

/** docs/specs/repository-membership.md. Where an admin accepts a claim, when the input names the page. */
const acceptanceHint = (run: Run): string =>
  run.input.product.productPageUrl === undefined ? "on the product page" : `on the product page: ${run.input.product.productPageUrl}`;

const notTargetable = (run: Run, name: string, owner: string, change = "it"): Promise<never> => {
  const repository = run.input.product.repositories.find((candidate) => candidate.fullName.toLowerCase() === name.toLowerCase());
  if (repository !== undefined && awaitsAcceptance(repository)) {
    return run.fail(
      "TARGET_UNRESOLVED",
      `The repository ${name} of ${owner} claims this product, but no admin accepted it as a member, so Factoree cannot change ${change}. A Linear workspace admin can accept it ${acceptanceHint(run)}.`,
    );
  }
  return run.fail("TARGET_UNRESOLVED", `The repository ${name} of ${owner} is no longer part of this product, so Factoree cannot change ${change}.`);
};

/** The rule's own set, or null when Factoree must select. A repository that left the product ends the Run. */
const fixedSet = async (run: Run, rule: TargetRule, present: RepositoryRecord[]): Promise<TargetSetOutcome | null> => {
  const find = (id: string) => present.find((repository) => repository.id === id) ?? null;
  const gone = (repository: RepositoryRecord | null) => repository === null || !isMember(repository);
  const ordered = (repositories: Array<RepositoryRecord | null>) => inSetOrder(repositories.filter((repository): repository is RepositoryRecord => repository !== null));
  if (rule.kind === "choose") {
    const set = rule.followUpTargets.map(find);
    const goneIndex = set.findIndex(gone);
    if (goneIndex >= 0) await notTargetable(run, set[goneIndex]?.fullName ?? rule.followUpTargets[goneIndex] ?? "", "the run this run follows");
    return set.length === 0 ? null : { kind: "selected", repositories: ordered(set), reason: "the targets of the run this run follows", notify: false };
  }
  const members = rule.setMembers;
  if (members !== null) {
    const set = members.map((member) => find(member.repositoryId));
    const member = members[set.findIndex(gone)];
    if (member !== undefined) await notTargetable(run, member.repositoryFullName, member.url, "the change set");
    return { kind: "selected", repositories: ordered(set), reason: `the pull requests of the change set of ${rule.url}`, notify: false };
  }
  const repository = find(rule.repositoryId);
  return repository === null ? null : { kind: "selected", repositories: [repository], reason: `the repository of ${rule.url}`, notify: false };
};

/**
 * Specification section 10 and docs/specs/change-sets.md. Decides the repositories this Run changes,
 * records one RunTarget row per target in set order, and names a determined choice. The issue text
 * or the Linear project decides when exactly one set matches. A pick among equals is a guess, so
 * only then does a human choose.
 */
export const selectRunTargets = async (run: Run, rule: TargetRule): Promise<RunTarget[]> => {
  const { input } = run;
  const present = presentRepositoriesOf(run);
  if (rule.kind === "pullRequest" && !present.some((repository) => repository.id === rule.repositoryId && isMember(repository))) {
    await notTargetable(run, rule.repositoryFullName, rule.url);
  }
  // docs/specs/repository-membership.md. An issue that names a repository no admin accepted as a
  // member says why, instead of a change to another repository.
  if (rule.kind === "choose" && rule.followUpTargets.length === 0) {
    const named = namedNonMembers(present, `${input.workItem.title}\n\n${input.workItem.description}`);
    if (named.length > 0) {
      const names = named.map((repository) => repository.fullName).join(", ");
      await run.fail(
        "TARGET_UNRESOLVED",
        `This issue names ${names}, which ${named.length === 1 ? "claims" : "claim"} this product, but no admin accepted ${named.length === 1 ? "it" : "them"} as a member, so Factoree changes nothing. A Linear workspace admin can accept ${named.length === 1 ? "it" : "them"} ${acceptanceHint(run)}.`,
      );
    }
  }
  deprecatePatch(PATCH.changeSet);
  let outcome =
    (await fixedSet(run, rule, present)) ??
    selectTargets(
      present,
      proposeTargets(present, `${input.workItem.title}\n\n${input.workItem.description}`, rule.kind === "choose" ? rule.linearProject : null),
    );
  while (outcome.kind === "ambiguous") {
    const candidates = outcome.candidates;
    const reply = await run.ask(
      {
        id: "target-selection",
        question:
          "Factoree found several repositories in this Product, and no rule decides which ones this issue changes. " +
          `Candidates: ${candidates.map((candidate) => candidate.fullName).join(", ")}. Reply with the exact name of each repository to change.`,
        waitingStatus: "BLOCKED_TARGET",
      },
      { reason: "TARGET_UNRESOLVED", message: "Factoree could not confirm the target repositories of this Product, so it published nothing." },
    );
    const chosen = matchReplyToCandidates(reply, candidates);
    outcome = chosen.length === 0 ? { kind: "ambiguous", candidates } : { kind: "selected", repositories: chosen, reason: "human reply", notify: false };
  }
  const targets = outcome.repositories.map((repository) => ({ id: repository.id, fullName: repository.fullName, githubInstallationId: repository.githubInstallationId }));
  if (targets.length === 0) throw ApplicationFailure.nonRetryable("target selection selected no repository");
  for (const target of targets) {
    await activities.recordRunTarget({ tenantId: input.tenantId, runId: run.id, repositoryId: target.id, selectionReason: outcome.reason });
  }
  if (outcome.notify) {
    const names = targets.map((target) => target.fullName);
    const statement = names.length === 1 ? `chose ${names[0] ?? ""}` : `chose ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
    await run.takeDecision({ kind: "target", statement, reason: outcome.reason });
  }
  return targets;
};
