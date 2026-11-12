/**
 * SDD section 42, issue #43, DI-21.67. The repair budget of a run: the repository's
 * `repair.maxAttempts` in .factoree/config.yaml when the file sets it, the Product setting
 * `repairMaxAttempts` otherwise. The workflow imports this file, so it stays pure.
 */

/** The most repairs a repository file or a Product may allow. */
export const REPAIR_MAX_ATTEMPTS_MAX = 10;
/** SDD section 42. The budget when neither the repository nor the Product names one. */
export const DEFAULT_REPAIR_MAX_ATTEMPTS = 2;

/** Where the effective budget comes from. */
export type RepairBudgetSource = "repository" | "product";

export interface RepairBudget {
  maxAttempts: number;
  source: RepairBudgetSource;
}

/** The repository value wins when the file sets one. A Product that names none takes the default. */
export const effectiveRepairBudget = (repository: number | undefined, product: number | undefined): RepairBudget =>
  repository === undefined
    ? { maxAttempts: product ?? DEFAULT_REPAIR_MAX_ATTEMPTS, source: "product" }
    : { maxAttempts: repository, source: "repository" };

/**
 * The clause and the hint of a failure message whose repair budget is spent. A history recorded
 * before the source existed names only the number.
 */
export const describeSpentRepairBudget = (
  maxAttempts: number,
  source: RepairBudgetSource | undefined,
): { clause: string; hint: string } => {
  const count = String(maxAttempts);
  if (source === "repository") {
    return {
      clause: `the repair budget (${count}, from repair.maxAttempts in .factoree/config.yaml) is spent`,
      hint: "Raise it with `repair.maxAttempts` in .factoree/config.yaml.",
    };
  }
  return {
    clause:
      source === "product"
        ? `the repair budget (${count}, from the product setting) is spent`
        : `the repair budget (${count}) is spent`,
    hint: "Raise it on the product page or with `repair.maxAttempts` in .factoree/config.yaml.",
  };
};
