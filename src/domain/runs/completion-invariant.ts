/**
 * SDD section 68. `READY_FOR_HUMAN` is reachable only when every clause below holds. No prompt
 * and no agent response can override it, so the check is a pure function of recorded facts and
 * it takes no agent claim. It reports every broken clause, because an operator must repair all
 * of them, not only the first one.
 */
/** The clauses that hold before publication. A Run that breaks one of them must publish nothing. */
export interface PrePublicationInput {
  workItemReady: boolean;
  contextContractVersion: string | null;
  unresolvedConflict: boolean;
  validationContractVersion: string | null;
  /** SDD section 24. The contract must freeze before implementation starts. */
  validationContractFrozenAt: string | null;
  /**
   * SDD section 24 and section 68. The moment the first Implementer attempt started, or null
   * when none started. The clause names an ORDER, so the check compares the two moments. A
   * check that only proves a contract exists would pass a contract frozen afterwards.
   */
  implementationStartedAt: string | null;
  validationPassed: boolean;
  verificationPassed: boolean;
  blockingFindingCount: number;
  repairCount: number;
  repairLimit: number;
}

export interface CompletionInvariantInput extends PrePublicationInput {
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

/**
 * The clauses of SDD section 68 that hold before publication. The workflow checks them before it
 * pushes, so a broken clause stops the Run before a pull request exists.
 */
export const prePublicationFailures = (input: PrePublicationInput): string[] => {
  const failures: string[] = [];
  if (!input.workItemReady) failures.push("The Work Item is not ready.");
  if (input.contextContractVersion === null) failures.push("No Context Contract exists.");
  if (input.unresolvedConflict) failures.push("A material Context conflict is unresolved.");
  if (input.validationContractVersion === null) failures.push("No Validation Contract exists.");
  if (input.validationContractFrozenAt === null) {
    failures.push("The Validation Contract never froze before implementation.");
  } else if (input.implementationStartedAt === null) {
    failures.push("No implementation start was recorded, so the freeze order is unproved.");
  } else if (
    Date.parse(input.validationContractFrozenAt) > Date.parse(input.implementationStartedAt)
  ) {
    failures.push("The Validation Contract froze after implementation started.");
  }
  if (!input.validationPassed) failures.push("At least one Validation assertion did not pass.");
  if (!input.verificationPassed) failures.push("Deterministic verification did not pass.");
  if (input.blockingFindingCount > 0) failures.push("A blocking review finding remains.");
  if (input.repairCount > input.repairLimit) {
    failures.push(`The repair count ${input.repairCount} exceeds the limit ${input.repairLimit}.`);
  }
  return failures;
};

export const completionInvariantFailures = (input: CompletionInvariantInput): string[] => {
  const failures = prePublicationFailures(input);
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
