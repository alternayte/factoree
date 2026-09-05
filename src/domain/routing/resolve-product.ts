import type { ProductRecord } from "~/domain/products/product-registry.js";

export type RoutingOutcome = { kind: "routed"; product: ProductRecord } | { kind: "refused"; reason: string };

/**
 * Specification section 9. One step, and every other case refuses. The team key is on every
 * Linear issue, so no fallback chain is needed. A refusal names what an operator must fix.
 */
export const resolveProduct = (products: ProductRecord[], linearTeamId: string | null): RoutingOutcome => {
  if (linearTeamId === null) {
    return { kind: "refused", reason: "the work item carries no Linear team" };
  }
  const matches = products.filter((candidate) => candidate.linearTeamId === linearTeamId);
  const first = matches[0];
  if (first === undefined) {
    return { kind: "refused", reason: `no Product claims Linear team ${linearTeamId}` };
  }
  if (matches.length > 1) {
    return {
      kind: "refused",
      reason: `${matches.length} Products claim Linear team ${linearTeamId}: ${matches
        .map((candidate) => candidate.slug)
        .join(", ")}`,
    };
  }
  return { kind: "routed", product: first };
};
