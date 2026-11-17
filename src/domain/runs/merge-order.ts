import type { FactoreeDecision } from "./factoree-decision.js";

/**
 * docs/specs/change-sets.md. One provider-to-consumer edge of a change set: the consumer calls an
 * interface of the provider, and the file and line in the consumer show the call.
 */
export interface TargetEdge {
  provider: string;
  consumer: string;
  file: string;
  line: number;
}

/**
 * docs/specs/change-sets.md, DI-21.141. The merge order of a change set. A target that no edge names
 * has no place. A cycle gives no target a place.
 */
export type MergeOrder =
  | { kind: "none" }
  /** The place of each target an edge names, from 1, providers before consumers. */
  | { kind: "ordered"; places: Array<{ repository: string; place: number }> }
  /** The targets that no order can place, in set order. */
  | { kind: "cycle"; repositories: string[] };

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * docs/specs/change-sets.md, DI-21.141. Orders the targets an edge names so each provider comes
 * before each of its consumers. Among targets free at the same time, set order decides, so one set
 * of edges always gives one order.
 */
export const mergeOrderOf = (targets: readonly string[], edges: readonly TargetEdge[]): MergeOrder => {
  const named = targets.filter((target) => edges.some((edge) => same(edge.provider, target) || same(edge.consumer, target)));
  if (named.length === 0) return { kind: "none" };
  const remaining = [...named];
  const places: Array<{ repository: string; place: number }> = [];
  for (;;) {
    const free = remaining.find(
      (target) => !edges.some((edge) => same(edge.consumer, target) && remaining.some((other) => same(other, edge.provider) && !same(other, target))),
    );
    if (free === undefined) break;
    places.push({ repository: free, place: places.length + 1 });
    remaining.splice(remaining.indexOf(free), 1);
  }
  return remaining.length === 0 ? { kind: "ordered", places } : { kind: "cycle", repositories: remaining };
};

const edgeLine = (edge: TargetEdge): string => `${edge.consumer} calls ${edge.provider} at ${edge.file} line ${String(edge.line)}`;

/**
 * docs/specs/change-sets.md. The decision a merge order gives the proof pack. A cycle lands under
 * "Needs your attention" with the statement that no safe order exists. No edge gives no decision.
 */
export const mergeOrderDecision = (order: MergeOrder, edges: readonly TargetEdge[]): FactoreeDecision | null => {
  if (order.kind === "none") return null;
  if (order.kind === "cycle") {
    const inCycle = edges.filter((edge) => order.repositories.some((target) => same(target, edge.provider)) && order.repositories.some((target) => same(target, edge.consumer)));
    return {
      kind: "merge_order",
      statement: `set no merge order for ${order.repositories.join(", ")}`,
      reason: `the edges form a cycle (${inCycle.map(edgeLine).join("; ")}), so no safe merge order exists and the pull requests carry no merge-order status`,
    };
  }
  return {
    kind: "merge_order",
    statement: `set the merge order ${order.places.map((entry) => entry.repository).join(", then ")}`,
    reason: `each provider merges before its consumers: ${edges.map(edgeLine).join("; ")}`,
  };
};
