/**
 * SDD section 68. `READY_FOR_HUMAN` is reachable only when every clause below holds. No prompt
 * and no agent response can override it, so the check is a pure function of recorded facts and
 * it takes no agent claim. It reports every broken clause, because an operator must repair all
 * of them, not only the first one.
 */
export interface CompletionInvariantInput {
  workItemReady: boolean;
  contextContractVersion: string | null;
  unresolvedConflict: boolean;
  validationContractVersion: string | null;
  /** SDD section 24. The contract must freeze before implementation starts. */
  validationContractFrozenAt: string | null;
  validationPassed: boolean;
  verificationPassed: boolean;
  blockingFindingCount: number;
  repairCount: number;
  repairLimit: number;
  /**
   * SDD section 44 and section 46. The publication reproduced this hash inside the trusted
   * checkout before it created a branch, so one recorded value proves both sides of the clause
   * "verified patch hash == published patch hash".
   */
  patchSha256: string;
  baseUnchanged: boolean;
  pullRequestUrl: string | null;
  proofPackSha256: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

export const completionInvariantFailures = (input: CompletionInvariantInput): string[] => {
  const failures: string[] = [];
  if (!input.workItemReady) failures.push("The Work Item is not ready.");
  if (input.contextContractVersion === null) failures.push("No Context Contract exists.");
  if (input.unresolvedConflict) failures.push("A material Context conflict is unresolved.");
  if (input.validationContractVersion === null) failures.push("No Validation Contract exists.");
  if (input.validationContractFrozenAt === null) {
    failures.push("The Validation Contract never froze before implementation.");
  }
  if (!input.validationPassed) failures.push("At least one Validation assertion did not pass.");
  if (!input.verificationPassed) failures.push("Deterministic verification did not pass.");
  if (input.blockingFindingCount > 0) failures.push("A blocking review finding remains.");
  if (input.repairCount > input.repairLimit) {
    failures.push(`The repair count ${input.repairCount} exceeds the limit ${input.repairLimit}.`);
  }
  if (!SHA256.test(input.patchSha256)) failures.push("No verified patch hash exists.");
  if (!input.baseUnchanged) failures.push("The target base SHA changed.");
  if (input.pullRequestUrl === null || input.pullRequestUrl.trim() === "") {
    failures.push("No pull request exists.");
  }
  if (input.proofPackSha256 === null || !SHA256.test(input.proofPackSha256)) {
    failures.push("No Proof Pack exists.");
  }
  return failures;
};
