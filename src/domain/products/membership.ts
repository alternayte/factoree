/**
 * docs/specs/repository-membership.md. The membership of a repository in the product its
 * `.factoree/config.yaml` claims. A claim on an active product is pending until a Linear workspace
 * admin accepts it. A claim on a pending product is accepted at once: a pending product holds no
 * secrets and runs at L0, and its activation is the human decision.
 */
export type RepositoryMembership = "pending" | "accepted" | "rejected";

export const REPOSITORY_MEMBERSHIPS: readonly RepositoryMembership[] = ["pending", "accepted", "rejected"];

export const toMembership = (value: string): RepositoryMembership =>
  value === "accepted" || value === "rejected" ? value : "pending";

/**
 * A member of its product: discovery still sees its configuration file, and the claim is accepted.
 * Only a member is a run target, a sibling, a change set member or a build-ahead input. A workflow
 * input from before this field carries no membership, and those repositories were members.
 */
export const isMember = (repository: { absentSince: unknown; membership?: RepositoryMembership | undefined }): boolean =>
  repository.absentSince === null && (repository.membership ?? "accepted") === "accepted";

/** Discovery still sees the configuration file, but no admin accepted the claim. */
export const awaitsAcceptance = (repository: { absentSince: unknown; membership?: RepositoryMembership | undefined }): boolean =>
  repository.absentSince === null && repository.membership !== undefined && repository.membership !== "accepted";

/**
 * The membership a claim gets when discovery reads it. A claim that keeps its product keeps its
 * decision, so a later push never reopens a rejection. A claim that is new to the product is
 * pending on an active product, unless an admin started a setup of the repository from that
 * product's page.
 */
export const membershipOfClaim = (input: {
  previous: { productId: string; membership: RepositoryMembership } | null;
  productId: string;
  productActive: boolean;
  setupStartedFromProduct: boolean;
}): { membership: RepositoryMembership; changed: boolean } => {
  if (input.previous !== null && input.previous.productId === input.productId) {
    return { membership: input.previous.membership, changed: false };
  }
  const membership = !input.productActive || input.setupStartedFromProduct ? "accepted" : "pending";
  return { membership, changed: true };
};
